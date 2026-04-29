import { ItemView, WorkspaceLeaf } from 'obsidian';
import { AIClient } from './client';

export const AI_SIDEBAR_VIEW_TYPE = 'zie-obsidian-ai-sidebar';

export class AISidebarView extends ItemView {
    private aiClient: AIClient;
    private messagesContainer!: HTMLElement;
    private inputEl!: HTMLTextAreaElement;
    private history: Array<{role: string; content: string}> = [];

    constructor(leaf: WorkspaceLeaf, aiClient: AIClient) {
        super(leaf);
        this.aiClient = aiClient;
    }

    getViewType(): string { return AI_SIDEBAR_VIEW_TYPE; }
    getDisplayText(): string { return 'zie-obsidian AI'; }
    getIcon(): string { return 'bot'; }

    async onOpen() {
        const container = this.containerEl.children[1];
        container.empty();
        container.addClass('zie-obsidian-sidebar');

        this.messagesContainer = container.createDiv('zie-chat-messages');

        const inputRow = container.createDiv('zie-chat-input');
        this.inputEl = inputRow.createEl('textarea');
        this.inputEl.placeholder = 'Ask AI about your notes...';
        this.inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.sendMessage();
            }
        });

        const sendBtn = inputRow.createEl('button', { text: 'Send' });
        sendBtn.addEventListener('click', () => this.sendMessage());

        const cmdRow = container.createDiv('zie-inline-commands');
        for (const name of ['summarize', 'expand', 'improve', 'translate', 'explain']) {
            const btn = cmdRow.createEl('button', { text: name });
            btn.addEventListener('click', () => {
                this.inputEl.value = `/${name} ${this.inputEl.value}`;
                this.inputEl.focus();
            });
        }
    }

    async sendMessage() {
        const text = this.inputEl.value.trim();
        if (!text) return;
        this.inputEl.value = '';

        this.addMessage('user', text);
        this.history.push({ role: 'user', content: text });

        const assistantDiv = this.addMessage('assistant', '');
        let fullText = '';

        try {
            await this.aiClient.chat(
                text, this.history,
                (token) => {
                    fullText += token;
                    assistantDiv.setText(fullText);
                },
                () => {
                    this.history.push({ role: 'assistant', content: fullText });
                }
            );
        } catch {
            assistantDiv.setText('[Error: AI request failed — check server connection]');
        }
    }

    addMessage(role: string, content: string): HTMLElement {
        const el = this.messagesContainer.createDiv(`zie-chat-message ${role}`);
        el.setText(content);
        this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;

        // Cap history to last 100 messages
        if (this.history.length > 100) {
            this.history = this.history.slice(-50);
        }

        return el;
    }
}
