import type { Server } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { WS_PATH } from '../src/net/protocol';
import type { ClientMessage } from '../src/net/protocol';
import { loadLevels } from './levels';
import { Lobby } from './lobby';
import { PlayerStore } from './store';

/**
 * Runs the game server on an existing HTTP server: WebSocket upgrades on WS_PATH go to the lobby, everything else is
 * left alone (so it can share a port with Vite's dev server, whose HMR socket uses its own subprotocol).
 */
/** Where saved players live: DATA_DIR, or ~/.gauntlet so they survive reinstalls and stay out of the repo. */
const DEFAULT_DATA_DIR = join(homedir(), '.gauntlet');

export function attachGameServer(server: Server, dataDir = process.env.DATA_DIR || DEFAULT_DATA_DIR): { lobby: Lobby; close(): void } {
  const store = new PlayerStore(join(dataDir, 'players.json'));
  const lobby = new Lobby(loadLevels(), store);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== WS_PATH) return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws: WebSocket) => {
    const client = lobby.connect({
      send: (msg) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      },
    });
    ws.on('message', (data) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(data)) as ClientMessage;
      } catch {
        return;
      }
      lobby.message(client, msg);
    });
    ws.on('close', () => lobby.disconnect(client));
  });

  const timer = setInterval(() => lobby.update(), 1000 / 60);
  return {
    lobby,
    close() {
      clearInterval(timer);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      store.flush();
    },
  };
}
