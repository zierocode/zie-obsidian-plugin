import { MarkdownView, Editor } from 'obsidian';
import { AIClient } from './client';

export const COMMANDS = [
    { id: 'summarize', name: 'Summarize selection', command: 'summarize', mode: 'replace' },
    { id: 'expand', name: 'Expand selection', command: 'expand', mode: 'replace' },
    { id: 'improve', name: 'Improve writing', command: 'improve', mode: 'replace' },
    { id: 'translate', name: 'Translate to Thai', command: 'translate', mode: 'replace' },
    { id: 'translate-en', name: 'Translate to English', command: 'translate-en', mode: 'replace' },
    { id: 'find-actions', name: 'Find action items', command: 'find-actions', mode: 'append' },
    { id: 'explain', name: 'Explain this', command: 'explain', mode: 'append' },
    { id: 'outline', name: 'Create outline', command: 'outline', mode: 'append' },
    { id: 'brainstorm', name: 'Brainstorm ideas', command: 'brainstorm', mode: 'append' },
];

export function registerCommands(plugin: any, aiClient: AIClient) {
    for (const cmd of COMMANDS) {
        plugin.addCommand({
            id: `zie-ai-${cmd.id}`,
            name: cmd.name,
            editorCallback: async (editor: Editor, view: MarkdownView) => {
                const selection = editor.getSelection() || editor.getValue();
                if (!selection.trim()) return;

                const result = await aiClient.runCommand(cmd.command, selection);
                if (cmd.mode === 'replace') {
                    editor.replaceSelection(result);
                } else {
                    const cursor = editor.getCursor('to');
                    editor.replaceRange(`\n\n${result}`, cursor);
                }
            }
        });
    }
}
