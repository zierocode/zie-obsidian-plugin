import { Plugin, Notice } from 'obsidian';
import { ZieObsidianSettings, DEFAULT_SETTINGS, ZieObsidianSettingTab } from './settings';
import { SyncEngine } from './sync/engine';
import { AISidebarView, AI_SIDEBAR_VIEW_TYPE } from './ai/sidebar';
import { registerCommands } from './ai/commands';
import { AIClient } from './ai/client';

export default class ZieObsidianPlugin extends Plugin {
    settings!: ZieObsidianSettings;
    syncEngine!: SyncEngine;

    async onload() {
        await this.loadSettings();
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

        this.syncEngine = new SyncEngine(this.app.vault, this.settings);
        this.syncEngine.start(this.app.vault.getName() + '-plugin');
        try {
            await this.syncEngine.fullSync();
        } catch (e) {
            console.error('zie-obsidian: sync failed', e);
        }
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
        await this.saveData(this.settings);
    }
}
