import { Notice } from 'obsidian';

export class SyncStatusBar {
    el: HTMLElement;
    private _dot: HTMLElement;
    private _text: HTMLElement;

    constructor(statusBarEl: HTMLElement) {
        this.el = statusBarEl.createSpan({ cls: 'zie-status-bar' });
        this._dot = this.el.createSpan({ cls: 'zie-dot zie-dot-red' });
        this._text = this.el.createSpan({ cls: 'zie-status-text', text: 'Offline' });
    }

    setConnected() {
        this._dot.className = 'zie-dot zie-dot-green';
        this._text.setText('Live');
    }

    setDisconnected() {
        this._dot.className = 'zie-dot zie-dot-red';
        this._text.setText('Offline');
    }

    setSyncing(uploaded: number, downloaded: number) {
        this._dot.className = 'zie-dot zie-dot-yellow';
        const parts: string[] = [];
        if (downloaded > 0) parts.push(`↓${downloaded}`);
        if (uploaded > 0) parts.push(`↑${uploaded}`);
        this._text.setText(parts.length > 0 ? parts.join(' ') : 'Syncing...');
    }

    setIdle() {
        this._dot.className = 'zie-dot zie-dot-green';
        this._text.setText('Synced');
    }
}
