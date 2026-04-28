export class SyncTransport {
    private ws: WebSocket | null = null;
    private serverUrl: string;
    private apiKey: string;
    private onMessage: (msg: any) => void;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private running = false;

    constructor(serverUrl: string, apiKey: string, onMessage: (msg: any) => void) {
        this.serverUrl = serverUrl.replace(/^http/, 'ws');
        this.apiKey = apiKey;
        this.onMessage = onMessage;
    }

    connect(clientId: string) {
        this.running = true;
        this._connect(clientId);
    }

    private _connect(clientId: string) {
        if (this.ws) {
            this.ws.close();
        }
        const url = `${this.serverUrl}/ws?client_id=${encodeURIComponent(clientId)}`;
        this.ws = new WebSocket(url);

        this.ws.onopen = () => {
            console.log('zie-obsidian: WS connected');
        };

        this.ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                if (msg.type !== 'pong') {
                    this.onMessage(msg);
                }
            } catch {}
        };

        this.ws.onclose = () => {
            console.log('zie-obsidian: WS disconnected, reconnecting in 3s');
            if (this.running) {
                this.reconnectTimer = setTimeout(() => this._connect(clientId), 3000);
            }
        };

        this.ws.onerror = () => {
            this.ws?.close();
        };
    }

    async send(message: any) {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message));
        }
    }

    disconnect() {
        this.running = false;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.ws?.close();
        this.ws = null;
    }
}
