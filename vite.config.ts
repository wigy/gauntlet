import type { Server } from 'node:http';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { attachGameServer } from './server/attach';

/** Runs the multiplayer game server inside `vite` / `vite preview`, on the same port. */
function gameServer(): Plugin {
  const attach = (httpServer: unknown) => {
    if (!httpServer) return;
    const game = attachGameServer(httpServer as Server);
    (httpServer as Server).on('close', () => game.close());
  };
  return {
    name: 'gauntlet-game-server',
    configureServer: (server) => attach(server.httpServer),
    configurePreviewServer: (server) => attach(server.httpServer),
  };
}

export default defineConfig({
  base: './',
  plugins: [gameServer()],
  test: {
    include: ['test/**/*.test.ts'],
  },
});
