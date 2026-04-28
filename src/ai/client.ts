export class AIClient {
    private serverUrl: string;
    private apiKey: string;

    constructor(serverUrl: string, apiKey: string) {
        this.serverUrl = serverUrl;
        this.apiKey = apiKey;
    }

    async chat(message: string, history: Array<{role: string; content: string}>,
               onToken: (token: string) => void, onDone: () => void) {
        const resp = await fetch(`${this.serverUrl}/api/ai/chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`
            },
            body: JSON.stringify({ message, history })
        });

        const reader = resp.body?.getReader();
        if (!reader) return;

        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                    try {
                        const chunk = JSON.parse(line.slice(6));
                        const text = chunk.choices?.[0]?.delta?.content;
                        if (text) onToken(text);
                    } catch {}
                }
            }
        }
        onDone();
    }

    async runCommand(command: string, content: string): Promise<string> {
        const resp = await fetch(`${this.serverUrl}/api/ai/command`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`
            },
            body: JSON.stringify({ command, content })
        });
        const data = await resp.json();
        return data.result || '';
    }
}
