export class SyncTransport {
    private ws: WebSocket | null = null;
    private serverUrl: string;
    private apiKey: string;
    private onMessage: (msg: any) => void;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private pingTimer: ReturnType<typeof setInterval> | null = null;
    private running = false;
    private _reconnectAttempts = 0;

    onConnectionChange?: (connected: boolean) => void;

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
        const url = `${this.serverUrl}/ws?client_id=${encodeURIComponent(clientId)}&token=${encodeURIComponent(this.apiKey)}`;
        this.ws = new WebSocket(url);

        this.ws.onopen = () => {
            this._reconnectAttempts = 0;
            this.onConnectionChange?.(true);
            this.pingTimer = setInterval(() => this.send({ type: 'ping' }), 30000);
        };

        this.ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                if (msg.type !== 'pong') {
                    this.onMessage(msg);
                }
            } catch { /* malformed message, ignore */ }
        };

        this.ws.onclose = () => {
            this.onConnectionChange?.(false);
            if (this.pingTimer) {
                clearInterval(this.pingTimer);
                this.pingTimer = null;
            }
            if (!this.running) return;
            const delay = Math.min(3000 * Math.pow(1.5, this._reconnectAttempts), 30000);
            this._reconnectAttempts++;
            this.reconnectTimer = setTimeout(() => this._connect(clientId), delay);
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
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.ws?.close();
        this.ws = null;
    }
}
