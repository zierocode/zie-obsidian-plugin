import { Notice } from 'obsidian';
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

function fetchWithTimeout(url: string, opts: RequestInit, timeoutMs = 10000): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(timer));
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
    private _lastSyncTime = 0;
    private _suppressUpload = new Set<string>();
    private _pollTimer: ReturnType<typeof setInterval> | null = null;
    private _noticeCount = 0;

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
                this.catchupSync();
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

    private _notify(msg: string) {
        // Rate-limit notices to avoid spam (max 1 per 2 seconds)
        this._noticeCount++;
        if (this._noticeCount <= 3 || this._noticeCount % 10 === 0) {
            new Notice(`zie: ${msg}`, 3000);
        }
        console.log(`[zie] ${msg}`);
    }

    private _startPolling() {
        if (this._pollTimer) return;
        this._pollTimer = setInterval(async () => {
            try {
                const { serverUrl, apiKey } = this.settings;
                const since = this._lastSyncTime || 0;
                const resp = await fetch(`${serverUrl}/api/sync/diff?since=${since}`, {
                    headers: { 'Authorization': `Bearer ${apiKey}` },
                }).then(r => r.json());
                if (!resp.changes) return;
                for (const c of resp.changes) {
                    await this.downloadFile(c.path).catch(() => {});
                }
                if (resp.server_time) this._lastSyncTime = resp.server_time;
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

        if (this._suppressUpload.has(path)) {
            console.log(`[zie] upload SKIP suppress path=${path}`);
            this._lastKnownHashes.set(path, hash); // still track hash for future
            return;
        }

        if (this._lastKnownHashes.get(path) === hash) {
            console.log(`[zie] upload SKIP hash-match path=${path}`);
            return;
        }

        this._notify(`↑ ${path}`);
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
        if (this._pendingDownloads.has(path)) {
            console.log(`[zie] download SKIP pending path=${path}`);
            return;
        }

        console.log(`[zie] download START path=${path}`);
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
        console.log(`[zie] download GOT path=${path} content=${!!data.content} serverHash=${data.hash?.slice(0,8)} localHash=${this._lastKnownHashes.get(path)?.slice(0,8)}`);

        if (!data.content) {
            console.log(`[zie] download SKIP no-content path=${path}`);
            return;
        }

        if (this._lastKnownHashes.get(path) === data.hash) {
            console.log(`[zie] download SKIP hash-match path=${path}`);
            return;
        }

        // If file is open in editor, only skip if user has local edits (hash diverged)
        if (this._isOpenInEditor(path) && this._lastKnownHashes.has(path)) {
            const localFile = this.vault.getAbstractFileByPath(path);
            if (localFile) {
                const localContent = await this.vault.read(localFile);
                const localHash = await sha256(localContent);
                if (localHash !== this._lastKnownHashes.get(path)) {
                    console.log(`[zie] download SKIP local-edits path=${path}`);
                    return;
                }
            }
        }

        // Suppress re-upload triggered by our own vault.modify (belt-and-suspenders with hash check)
        this._suppressUpload.add(path);
        setTimeout(() => this._suppressUpload.delete(path), 5000);

        // Set hash BEFORE vault write — modify event fires synchronously
        this._lastKnownHashes.set(path, data.hash);

        const existing = this.vault.getAbstractFileByPath(path);
        console.log(`[zie] download WRITE path=${path} exists=${!!existing} len=${data.content.length}`);
        if (existing) {
            await this.vault.modify(existing, data.content);
        } else {
            // Ensure parent directories exist
            const dirPath = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';
            if (dirPath) {
                const dir = this.vault.getAbstractFileByPath(dirPath);
                if (!dir) {
                    await this.vault.createFolder(dirPath);
                }
            }
            await this.vault.create(path, data.content);
        }

        this._notify(`↓ ${path}`);
        console.log(`[zie] download DONE path=${path}`);
    }

    // --- Delete sync ---

    async deleteFile(path: string): Promise<void> {
        const { serverUrl, apiKey } = this.settings;
        try {
            const resp = await fetch(`${serverUrl}/api/vault/delete?path=${encodeURIComponent(path)}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${apiKey}` },
            });
            if (!resp.ok) throw new Error(`delete failed: ${resp.status}`);
            this._lastKnownHashes.delete(path);
            this._notify(`✕ ${path}`);
        } catch (e) {
            console.error('[zie] delete sync error', e);
        }
    }

    // --- Catch-up sync after reconnect ---

    async catchupSync(): Promise<void> {
        if (!this._lastSyncTime) return; // fullSync hasn't completed yet
        try {
            const { serverUrl, apiKey } = this.settings;
            const since = this._lastSyncTime;
            const resp = await fetch(`${serverUrl}/api/sync/diff?since=${since}`, {
                headers: { 'Authorization': `Bearer ${apiKey}` },
            }).then(r => r.json());
            if (!resp.changes?.length) return;
            console.log(`[zie] catchup since=${since} count=${resp.changes.length}`);
            for (const c of resp.changes) {
                await this.downloadFile(c.path).catch(() => {});
            }
            if (resp.server_time) this._lastSyncTime = resp.server_time;
        } catch { /* will catch up on next poll or fullSync */ }
    }

    // --- Direct message handling (no queue — downloadFile has internal guards) ---

    handleMessage(msg: any) {
        console.log(`[zie] WS-IN type=${msg.type} path=${msg.path}`);
        if (msg.type === 'file_changed') {
            this.downloadFile(msg.path).catch(e => {
                console.error('[zie] download error', e);
            });
        } else if (msg.type === 'file_deleted') {
            if (!this._isOpenInEditor(msg.path)) {
                const file = this.vault.getAbstractFileByPath(msg.path);
                if (file) {
                    this.vault.trash(file, false).catch(() => {});
                }
            }
        }
    }

    // --- Full sync with parallel operations ---

    async fullSync(): Promise<{ uploaded: number; downloaded: number }> {
        this.onStatusChange?.({ state: 'syncing' });

        const localFiles = await getLocalFiles(this.vault);
        const { serverUrl, apiKey } = this.settings;

        const resp = await retry(() =>
            fetchWithTimeout(`${serverUrl}/api/sync/diff?since=0`, {
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

        console.log(`zie-obsidian: sync done — ↓${dlCount} ↑${ulCount}`);

        if (resp.server_time) this._lastSyncTime = resp.server_time;

        this.onStatusChange?.({
            state: 'idle',
            lastSync: Date.now(),
            uploaded: ulCount,
            downloaded: dlCount,
        });

        return { uploaded: ulCount, downloaded: dlCount };
    }
}
