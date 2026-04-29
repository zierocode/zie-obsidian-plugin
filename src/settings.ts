import { PluginSettingTab, Setting, App, Notice } from 'obsidian';

export interface ZieObsidianSettings {
    serverUrl: string;
    apiKey: string;
}

export const DEFAULT_SETTINGS: ZieObsidianSettings = {
    serverUrl: 'https://obsidian.zie-agent.cloud',
    apiKey: '',
};

export class ZieObsidianSettingTab extends PluginSettingTab {
    plugin: any;

    constructor(app: App, plugin: any) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'zie-obsidian Settings' });

        new Setting(containerEl)
            .setName('Server URL')
            .setDesc('zie-obsidian server URL')
            .addText(text => text
                .setPlaceholder('https://obsidian.zie-agent.cloud')
                .setValue(this.plugin.settings.serverUrl)
                .onChange(async (value) => {
                    this.plugin.settings.serverUrl = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('API Key')
            .setDesc('zie-obsidian API key')
            .addText(text => {
                text.inputEl.type = 'password';
                text.setPlaceholder('Enter API key')
                    .setValue(this.plugin.settings.apiKey)
                    .onChange(async (value) => {
                        this.plugin.settings.apiKey = value;
                        await this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName('Test Connection')
            .setDesc('Check if the server is reachable')
            .addButton(btn => btn
                .setButtonText('Test')
                .onClick(async () => {
                    try {
                        const resp = await fetch(`${this.plugin.settings.serverUrl}/health`);
                        if (resp.ok) {
                            new Notice('zie-obsidian: Server is reachable');
                        } else {
                            new Notice(`zie-obsidian: Server returned ${resp.status}`);
                        }
                    } catch {
                        new Notice('zie-obsidian: Connection failed');
                    }
                }));

        new Setting(containerEl)
            .setName('Force Full Sync')
            .setDesc('Manually trigger a full vault sync')
            .addButton(btn => btn
                .setButtonText('Sync Now')
                .onClick(async () => {
                    new Notice('zie-obsidian: Full sync started...');
                    try {
                        const r = await this.plugin.syncEngine.fullSync();
                        new Notice(`zie-obsidian: Sync done — ↓${r.downloaded} ↑${r.uploaded}`);
                    } catch {
                        new Notice('zie-obsidian: Sync failed');
                    }
                }));

        const icloud = this._detectIcloud();
        new Setting(containerEl)
            .setName('Device ID')
            .setDesc(`Device: ${this.plugin.deviceId}${icloud ? ' | iCloud vault detected' : ''}`);
    }

    private _detectIcloud(): boolean {
        try {
            const bp = (this.plugin.app.vault.adapter as any).getBasePath?.() || '';
            return bp.includes('Mobile Documents');
        } catch { return false; }
    }
}
