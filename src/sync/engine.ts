import { SyncTransport } from './transport';
import { getLocalFiles, computeDiff } from './differ';
import { retry } from '../utils/retry';

export class SyncEngine {
    private transport: SyncTransport;
    private vault: any;
    private settings: any;

    constructor(vault: any, settings: any) {
        this.vault = vault;
        this.settings = settings;
        this.transport = new SyncTransport(settings.serverUrl, settings.apiKey, (msg) => this.handleMessage(msg));
    }

    start(clientId: string) {
        this.transport.connect(clientId);
    }

    stop() {
        this.transport.disconnect();
    }

    async fullSync() {
        const localFiles = await getLocalFiles(this.vault);
        const serverUrl = this.settings.serverUrl;
        const apiKey = this.settings.apiKey;

        const resp = await retry(() =>
            fetch(`${serverUrl}/api/sync/diff?since=0`, {
                headers: { 'Authorization': `Bearer ${apiKey}` }
            }).then(r => r.json())
        );

        const { toDownload, toUpload } = computeDiff(localFiles, resp.changes);

        for (const path of toDownload) {
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

        for (const path of toUpload) {
            const file = this.vault.getAbstractFileByPath(path);
            if (file) {
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
        }

        console.log(`zie-obsidian: sync done — ↓${toDownload.length} ↑${toUpload.length}`);
    }

    async handleMessage(msg: any) {
        if (msg.type === 'file_changed') {
            await this.fullSync();
        } else if (msg.type === 'file_deleted') {
            const file = this.vault.getAbstractFileByPath(msg.path);
            if (file) {
                await this.vault.trash(file, true);
            }
        }
    }
}
