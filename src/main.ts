import { Plugin, Notice, Platform, debounce, Debouncer } from 'obsidian';
import { ZieObsidianSettings, DEFAULT_SETTINGS, ZieObsidianSettingTab } from './settings';
import { SyncEngine } from './sync/engine';
import { AISidebarView, AI_SIDEBAR_VIEW_TYPE } from './ai/sidebar';
import { registerCommands } from './ai/commands';
import { AIClient } from './ai/client';
import { SyncStatusBar } from './status';

export default class ZieObsidianPlugin extends Plugin {
    settings!: ZieObsidianSettings;
    syncEngine!: SyncEngine;
    deviceId!: string;
    statusBar?: SyncStatusBar;
    private _uploadDebouncers = new Map<string, Debouncer<[string], void>>();

    private get _isIcloudVault(): boolean {
        try {
            const bp = (this.app.vault.adapter as any).getBasePath?.() || '';
            return bp.includes('Mobile Documents');
        } catch { return false; }
    }

    private _scheduleUpload(path: string) {
        let db = this._uploadDebouncers.get(path);
        if (!db) {
            const delay = this._isIcloudVault ? 2000 : 500;
            db = debounce(async (p: string) => {
                this._uploadDebouncers.delete(p);
                try {
                    await this.syncEngine.uploadFile(p);
                } catch (e) {
                    console.error('zie-obsidian: upload failed', e);
                }
            }, delay, true);
            this._uploadDebouncers.set(path, db);
        }
        db(path);
    }

    async onload() {
        await this.loadSettings();

        // Unique device ID for multi-device sync
        this.deviceId = this.settings.deviceId;
        if (!this.deviceId) {
            this.deviceId = Math.random().toString(36).slice(2, 10);
            this.settings.deviceId = this.deviceId;
            await this.saveSettings();
        }

        this.addSettingTab(new ZieObsidianSettingTab(this.app, this));

        this.registerView(AI_SIDEBAR_VIEW_TYPE,
            (leaf) => new AISidebarView(leaf, this.settings.serverUrl, this.settings.apiKey));

        this.addRibbonIcon('bot', 'Open zie-obsidian AI', () => {
            this.activateView();
        });

        const aiClient = new AIClient(this.settings.serverUrl, this.settings.apiKey);
        registerCommands(this, aiClient);

        this.addCommand({
            id: 'zie-sync-status',
            name: 'Show sync status',
            callback: () => new Notice('zie-obsidian active'),
        });

        this.syncEngine = new SyncEngine(this.app.vault, this.app.workspace, this.settings);
        this.syncEngine.start(this.app.vault.getName() + '-' + this.deviceId);

        // Status bar (desktop only)
        if (Platform.isDesktop) {
            this.statusBar = new SyncStatusBar(this.addStatusBarItem());
            this.statusBar.el.addEventListener('click', () => {
                this.statusBar?.setSyncing(0, 0);
                this.syncEngine.fullSync().then(() => {
                    this.statusBar?.setIdle();
                }).catch(() => {
                    this.statusBar?.setConnected();
                });
            });
            this.syncEngine.onStatusChange = (s) => {
                if (!this.statusBar) return;
                switch (s.state) {
                    case 'connected': this.statusBar.setConnected(); break;
                    case 'disconnected': this.statusBar.setDisconnected(); break;
                    case 'syncing':
                        this.statusBar.setSyncing(s.uploaded ?? 0, s.downloaded ?? 0);
                        break;
                    case 'idle': this.statusBar.setIdle(); break;
                }
            };
        }

        try {
            await this.syncEngine.fullSync();
        } catch (e) {
            console.error('zie-obsidian: initial sync failed', e);
        }

        // Local edit → upload (per-file debounce, iCloud-aware)
        this.registerEvent(this.app.vault.on('modify', (f) => this._scheduleUpload(f.path)));
        this.registerEvent(this.app.vault.on('create', (f) => this._scheduleUpload(f.path)));
        this.registerEvent(this.app.vault.on('delete', (f) => {
            this._uploadDebouncers.delete(f.path);
        }));
    }

    async activateView() {
        const { workspace } = this.app;
        let leaf = workspace.getLeavesOfType(AI_SIDEBAR_VIEW_TYPE)[0];
        if (!leaf) {
            const rightLeaf = workspace.getRightLeaf(false);
            if (rightLeaf) {
                await rightLeaf.setViewState({ type: AI_SIDEBAR_VIEW_TYPE, active: true });
                leaf = rightLeaf;
            }
        }
        if (leaf) workspace.revealLeaf(leaf);
    }

    onunload() {
        this.syncEngine?.stop();
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(Object.assign({}, this.settings, { deviceId: this.deviceId }));
    }
}
