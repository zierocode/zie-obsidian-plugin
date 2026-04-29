import { PluginSettingTab, Setting, App } from 'obsidian';

export interface ZieObsidianSettings {
    serverUrl: string;
    apiKey: string;
    vaultName: string;
    deviceId: string;
}

export const DEFAULT_SETTINGS: ZieObsidianSettings = {
    serverUrl: 'https://obsidian.zie-agent.cloud',
    apiKey: '',
    vaultName: 'zie',
    deviceId: '',
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
    }
}
