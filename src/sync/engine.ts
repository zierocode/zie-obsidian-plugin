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
            this.onStatusChange?.({ state: connected ? 'connected' : 'disconnected' });
        };
    }

    start(clientId: string) {
        this.transport.connect(clientId);
    }

    stop() {
        this.transport.disconnect();
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
        if (this._pendingDownloads.has(path)) return;
        if (this._isOpenInEditor(path)) return;

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
        const resp = await fetch(
            `${serverUrl}/api/vault/read?path=${encodeURIComponent(path)}`,
            { headers: { 'Authorization': `Bearer ${apiKey}` } },
        );
        if (!resp.ok) throw new Error(`download failed: ${resp.status}`);

        const data = await resp.json();
        if (!data.content) return;

        if (this._lastKnownHashes.get(path) === data.hash) return;

        const existing = this.vault.getAbstractFileByPath(path);
        if (existing) {
            await this.vault.modify(existing, data.content);
        } else {
            await this.vault.create(path, data.content);
        }

        this._lastKnownHashes.set(path, data.hash);
    }

    // --- Message queue (never drops) ---

    async handleMessage(msg: any) {
        this._messageQueue.push(msg);
        if (!this._processingQueue) {
            this._processQueue();
        }
    }

    private async _processQueue() {
        this._processingQueue = true;
        while (this._messageQueue.length > 0) {
            const msg = this._messageQueue.shift()!;
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
                console.error('zie-obsidian: handleMessage error', e);
            }
        }
        this._processingQueue = false;
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
