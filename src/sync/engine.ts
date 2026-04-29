import { SyncTransport } from './transport';
import { getLocalFiles, computeDiff } from './differ';
import { retry } from '../utils/retry';

function chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
    }
    return chunks;
}

async function sha256(text: string): Promise<string> {
    const data = new TextEncoder().encode(text);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hash))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

export interface SyncStatus {
    state: 'idle' | 'syncing' | 'connected' | 'disconnected';
    lastSync?: number;
    uploaded?: number;
    downloaded?: number;
}

export class SyncEngine {
    private transport: SyncTransport;
    private vault: any;
    private workspace: any;
    private settings: any;
    private _pendingUploads = new Map<string, Promise<void>>();
    private _pendingDownloads = new Map<string, Promise<void>>();
    private _lastKnownHashes = new Map<string, string>();
    private _messageQueue: any[] = [];
    private _processingQueue = false;
    private _pollTimer: ReturnType<typeof setInterval> | null = null;

    onStatusChange?: (status: SyncStatus) => void;

    constructor(vault: any, workspace: any, settings: any) {
        this.vault = vault;
        this.workspace = workspace;
        this.settings = settings;
        this.transport = new SyncTransport(
            settings.serverUrl,
            settings.apiKey,
            (msg) => this.handleMessage(msg),
        );
        this.transport.onConnectionChange = (connected) => {
            if (connected) {
                this._stopPolling();
                this.onStatusChange?.({ state: 'connected' });
            } else {
                this._startPolling();
                this.onStatusChange?.({ state: 'disconnected' });
            }
        };
    }

    start(clientId: string) {
        this.transport.connect(clientId);
    }

    stop() {
        this._stopPolling();
        this.transport.disconnect();
    }

    private _startPolling() {
        if (this._pollTimer) return;
        this._pollTimer = setInterval(async () => {
            try {
                const { serverUrl, apiKey } = this.settings;
                const resp = await fetch(`${serverUrl}/api/sync/diff?since=0`, {
                    headers: { 'Authorization': `Bearer ${apiKey}` },
                }).then(r => r.json());
                if (!resp.changes) return;
                for (const c of resp.changes) {
                    await this.downloadFile(c.path).catch(() => {});
                }
            } catch { /* poll failed, will retry next interval */ }
        }, 30000);
    }

    private _stopPolling() {
        if (this._pollTimer) {
            clearInterval(this._pollTimer);
            this._pollTimer = null;
        }
    }

    private _isOpenInEditor(path: string): boolean {
        for (const leaf of this.workspace.getLeavesOfType('markdown')) {
            const view = leaf.view;
            if (view && view.file && view.file.path === path) return true;
        }
        return false;
    }

    // --- Upload with hash check ---

    async uploadFile(path: string): Promise<void> {
        if (this._pendingUploads.has(path)) {
            return this._pendingUploads.get(path)!;
        }
        const promise = this._doUpload(path);
        this._pendingUploads.set(path, promise);
        try {
            await promise;
        } finally {
            this._pendingUploads.delete(path);
        }
    }

    private async _doUpload(path: string): Promise<void> {
        const { serverUrl, apiKey } = this.settings;
        const file = this.vault.getAbstractFileByPath(path);
        if (!file) return;

        const content = await this.vault.read(file);
        const hash = await sha256(content);

        if (this._lastKnownHashes.get(path) === hash) return;

        const resp = await fetch(`${serverUrl}/api/vault/write`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({ path, content }),
        });

        if (!resp.ok) throw new Error(`upload failed: ${resp.status}`);
        this._lastKnownHashes.set(path, hash);
    }

    // --- Download with hash tracking ---

    async downloadFile(path: string): Promise<void> {
        if (this._pendingDownloads.has(path)) { console.log(`[zie] downloadFile: SKIP pending path=${path}`); return; }
        if (this._isOpenInEditor(path)) { console.log(`[zie] downloadFile: SKIP openInEditor path=${path}`); return; }

        console.log(`[zie] downloadFile: start path=${path}`);
        const promise = this._doDownload(path);
        this._pendingDownloads.set(path, promise);
        try {
            await promise;
        } finally {
            this._pendingDownloads.delete(path);
        }
    }

    private async _doDownload(path: string): Promise<void> {
        const { serverUrl, apiKey } = this.settings;
        console.log(`[zie] _doDownload: fetching path=${path}`);
        const resp = await fetch(
            `${serverUrl}/api/vault/read?path=${encodeURIComponent(path)}`,
            { headers: { 'Authorization': `Bearer ${apiKey}` } },
        );
        if (!resp.ok) throw new Error(`download failed: ${resp.status}`);

        const data = await resp.json();
        console.log(`[zie] _doDownload: got path=${path} hasContent=${!!data.content} serverHash=${data.hash?.slice(0,8)} localHash=${this._lastKnownHashes.get(path)?.slice(0,8)}`);

        if (!data.content) { console.log(`[zie] _doDownload: SKIP no content`); return; }

        if (this._lastKnownHashes.get(path) === data.hash) {
            console.log(`[zie] _doDownload: SKIP hash match`);
            return;
        }

        // Set hash BEFORE writing to vault — modify event fires synchronously
        // and we need the hash guard active before _scheduleUpload triggers
        this._lastKnownHashes.set(path, data.hash);

        const existing = this.vault.getAbstractFileByPath(path);
        console.log(`[zie] _doDownload: writing existing=${!!existing}`);
        if (existing) {
            await this.vault.modify(existing, data.content);
        } else {
            await this.vault.create(path, data.content);
        }

        console.log(`[zie] _doDownload: DONE path=${path}`);
    }

    // --- Message queue (never drops) ---

    async handleMessage(msg: any) {
        console.log(`[zie] WS msg: type=${msg.type} path=${msg.path} queue=${this._messageQueue.length + 1}`);
        this._messageQueue.push(msg);
        if (!this._processingQueue) {
            this._processQueue();
        }
    }

    private async _processQueue() {
        this._processingQueue = true;
        try {
            while (this._messageQueue.length > 0) {
                const msg = this._messageQueue.shift()!;
                console.log(`[zie] processQueue: type=${msg.type} path=${msg.path} remaining=${this._messageQueue.length}`);
                try {
                    if (msg.type === 'file_changed') {
                        await this.downloadFile(msg.path);
                    } else if (msg.type === 'file_deleted') {
                        if (!this._isOpenInEditor(msg.path)) {
                            const file = this.vault.getAbstractFileByPath(msg.path);
                            if (file) await this.vault.trash(file, true);
                        }
                    }
                } catch (e) {
                    console.error('[zie] handleMessage error', e);
                }
            }
        } finally {
            this._processingQueue = false;
        }
    }

    // --- Full sync with parallel operations ---

    async fullSync(): Promise<{ uploaded: number; downloaded: number }> {
        this.onStatusChange?.({ state: 'syncing' });

        const localFiles = await getLocalFiles(this.vault);
        const { serverUrl, apiKey } = this.settings;

        const resp = await retry(() =>
            fetch(`${serverUrl}/api/sync/diff?since=0`, {
                headers: { 'Authorization': `Bearer ${apiKey}` },
            }).then(r => r.json()),
        );

        const { toDownload, toUpload } = computeDiff(localFiles, resp.changes || []);

        let dlCount = 0;
        const dlChunks = chunkArray(toDownload, 3);
        for (const chunk of dlChunks) {
            const results = await Promise.allSettled(
                chunk.map(p => this.downloadFile(p)),
            );
            dlCount += results.filter(r => r.status === 'fulfilled').length;
            for (const r of results) {
                if (r.status === 'rejected') {
                    console.error('zie-obsidian: download chunk error', r.reason);
                }
            }
        }

        let ulCount = 0;
        const ulChunks = chunkArray(toUpload, 3);
        for (const chunk of ulChunks) {
            const results = await Promise.allSettled(
                chunk.map(p => this.uploadFile(p)),
            );
            ulCount += results.filter(r => r.status === 'fulfilled').length;
            for (const r of results) {
                if (r.status === 'rejected') {
                    console.error('zie-obsidian: upload chunk error', r.reason);
                }
            }
        }

        this._lastKnownHashes.clear();

        console.log(`zie-obsidian: sync done — ↓${dlCount} ↑${ulCount}`);

        this.onStatusChange?.({
            state: 'idle',
            lastSync: Date.now(),
            uploaded: ulCount,
            downloaded: dlCount,
        });

        return { uploaded: ulCount, downloaded: dlCount };
    }
}
