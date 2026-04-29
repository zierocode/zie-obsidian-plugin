import { SyncTransport } from './transport';
import { getLocalFiles, computeDiff } from './differ';
import { retry } from '../utils/retry';

export class SyncEngine {
    private transport: SyncTransport;
    private vault: any;
    private workspace: any;
    private settings: any;
    private _syncing = false;
    private _recentlyDownloaded = new Set<string>();

    constructor(vault: any, workspace: any, settings: any) {
        this.vault = vault;
        this.workspace = workspace;
        this.settings = settings;
        this.transport = new SyncTransport(settings.serverUrl, settings.apiKey, (msg) => this.handleMessage(msg));
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

    async fullSync() {
        if (this._syncing) return;
        this._syncing = true;
        try {
            const localFiles = await getLocalFiles(this.vault);
            const { serverUrl, apiKey } = this.settings;

            const resp = await retry(() =>
                fetch(`${serverUrl}/api/sync/diff?since=0`, {
                    headers: { 'Authorization': `Bearer ${apiKey}` }
                }).then(r => r.json())
            );

            const { toDownload, toUpload } = computeDiff(localFiles, resp.changes || []);

            // Download server-only files (skip files open in editor)
            for (const path of toDownload) {
                if (this._isOpenInEditor(path)) continue;
                const fileResp = await fetch(`${serverUrl}/api/vault/read?path=${encodeURIComponent(path)}`, {
                    headers: { 'Authorization': `Bearer ${apiKey}` }
                });
                const data = await fileResp.json();
                if (data.content) {
                    const existing = this.vault.getAbstractFileByPath(path);
                    if (existing) {
                        await this.vault.modify(existing, data.content);
                    } else {
                        await this.vault.create(path, data.content);
                    }
                }
            }

            // Upload local-only files
            for (const path of toUpload) {
                await this.uploadFile(path);
            }

            console.log(`zie-obsidian: sync done — ↓${toDownload.length} ↑${toUpload.length}`);
        } finally {
            this._syncing = false;
        }
    }

    async uploadFile(path: string) {
        if (this._recentlyDownloaded.has(path)) {
            this._recentlyDownloaded.delete(path);
            return;
        }
        const { serverUrl, apiKey } = this.settings;
        const file = this.vault.getAbstractFileByPath(path);
        if (!file) return;
        const content = await this.vault.read(file);
        await fetch(`${serverUrl}/api/vault/write`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({ path, content })
        });
    }

    async downloadFile(path: string) {
        if (this._isOpenInEditor(path)) return;
        this._recentlyDownloaded.add(path);
        const { serverUrl, apiKey } = this.settings;
        const fileResp = await fetch(`${serverUrl}/api/vault/read?path=${encodeURIComponent(path)}`, {
            headers: { 'Authorization': `Bearer ${apiKey}` }
        });
        const data = await fileResp.json();
        if (!data.content) return;
        const existing = this.vault.getAbstractFileByPath(path);
        if (existing) {
            await this.vault.modify(existing, data.content);
        } else {
            await this.vault.create(path, data.content);
        }
    }

    async handleMessage(msg: any) {
        if (this._syncing) return;
        if (msg.type === 'file_changed') {
            // Only download — don't full sync (avoids upload loop)
            await this.downloadFile(msg.path);
        } else if (msg.type === 'file_deleted') {
            if (this._isOpenInEditor(msg.path)) return;
            const file = this.vault.getAbstractFileByPath(msg.path);
            if (file) {
                await this.vault.trash(file, true);
            }
        }
    }
}
