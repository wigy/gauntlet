import { WS_PATH } from './protocol';
import type { ClientMessage, ServerMessage } from './protocol';

export type ConnectionStatus = 'connecting' | 'open' | 'lost';

/** WebSocket to the game server on the page's own host, reconnecting with backoff when it drops. */
export class Connection {
  onMessage: (msg: ServerMessage) => void = () => {};
  onStatus: (status: ConnectionStatus) => void = () => {};
  private ws: WebSocket | null = null;
  private retry = 0;

  connect(): void {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}${WS_PATH}`);
    this.ws = ws;
    this.onStatus('connecting');
    ws.onopen = () => {
      this.retry = 0;
      this.onStatus('open');
    };
    ws.onmessage = (e) => {
      try {
        this.onMessage(JSON.parse(String(e.data)) as ServerMessage);
      } catch (err) {
        console.error('Bad message from server', err);
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.onStatus('lost');
      const delay = Math.min(5000, 500 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}
