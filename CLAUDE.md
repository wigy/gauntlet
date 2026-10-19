# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Web remake of Atari's 1985 coin-op **Gauntlet**: up to 4 players co-op online, one browser per player, through a lobby on a Node game server. TypeScript + Vite + Canvas 2D; the browser client has no runtime dependencies, the server uses `ws` (run with `tsx`).

## Commands

```bash
npm run dev                 # Vite dev server, with the game server attached on the same port (/ws)
npm run build               # typecheck + production build to dist/
npm start                   # production: serve dist/ + game server (PORT, default 8080)
npm run typecheck           # tsc --noEmit (this is the lint step; there is no ESLint)
npm test                    # vitest run
npx vitest run test/game.test.ts -t "opens doors"   # single file / single test
npm run import:g1           # download + convert all 125 arcade Gauntlet maps (see below)
npm run import:g1 -- 9 78   # convert only these level numbers and print them as ASCII
npm run sprites             # re-slice art/sheets/* into public/sprites/*.png
```

Server environment: `LEVELS=builtin|custom|arcade` (default set for new games; arcade = `public/levels/gauntlet1`, falls back to built-in if not imported), `PORT`, `DATA_DIR` (default `~/.gauntlet/`: saved players in `players.json`, each player's levels in `levels/<player id>/`). URL parameter `?level=N` makes games you create start at level N (for testing).

## Architecture

- **`src/core/` is pure simulation, no DOM.** `Game` (`game.ts`) advances one fixed `TICK` (1/60 s) per `step(inputs)`, where `inputs` is `Map<controllerId, PlayerInput>`. Rendering, audio and input only read game state and drain `game.events` (`say` / `sfx` / `flash`). Keep it that way: the determinism (all randomness goes through the seeded `Rng`) is what the tests rely on, and the server runs this same code.
- **Online play (server-authoritative)**: `server/lobby.ts` (transport-agnostic, unit-tested in `test/lobby.test.ts`) holds clients, rooms and saved players (`server/store.ts`). A room is `waiting` (anyone can join, any member can start), then `playing` (others can still jump in at the level start, up to 4), then `over` (back to the lobby after 5 s). It steps each running `Game` at 60 Hz with `{ online: true }` and sends every member a snapshot every 2 ticks, limited to entities near their hero (`AOI_X/AOI_Y`); full level tiles go out once per level, then only changed tiles (opened doors) and the item list when it changes. `server/attach.ts` adds the WebSocket on `/ws` to any HTTP server (the Vite plugin in `vite.config.ts` in dev, `server/main.ts` in production). Messages are typed in `src/net/protocol.ts`.
- **Client**: `src/main.ts` connects (`src/net/connection.ts`, auto-reconnect), shows the DOM screens in `src/ui/menu.ts` (name, lobby, waiting room, Esc pause menu), sends input only when it changes, and applies snapshots to `src/net/mirror.ts`, a `Game`-shaped copy whose entities keep their identity across snapshots so the renderer can interpolate and diff them. The player id lives in localStorage (`gauntlet.playerId`) and the server keeps the name for it. No client-side prediction yet, so movement has one round trip of input lag.
- **Level sets and the editor**: `server/levels.ts` (`LevelLibrary`) serves three sets: `builtin`, `arcade` (if imported) and `custom` = "My levels", which is per player: made in the editor, saved as `<DATA_DIR>/levels/<player id>/<id>.txt` plus `index.json` for play order, visible and editable only by that player id (owners are validated as UUIDs before touching the file system). Creating a game picks a set (lobby dropdown); a room snapshots the set's texts (custom: the creator's levels, shown as "<name>'s levels"), so others who join play the creator's levels and later edits don't affect running games. The editor (`src/editor/`, opened from the lobby) works on the level text format directly: paint with the legend characters (pen / rectangle / fill, undo, zoom and pan), check start/exit reachability with `bfsDistances`, save via `levelSave`, copy any built-in or arcade level (`LevelLibrary.get` populates wall-only arcade maps first and serializes with `levelToText`), and "Play test" creates a custom-set game that starts immediately at that level; leaving it returns to the editor. Ownership is only as strong as the player id in localStorage (no real accounts).
- **`online` mode in `Game`**: players come from `addPlayer()`/`removePlayer()` and `start()` instead of FIRE joins, there's no shared-screen limit, potions hit what's in the drinker's own view, and joins and revives happen at the level start. Without it (the default, used by `test/game.test.ts`), `handleJoins` binds a controller to a free slot on FIRE as in local co-op.
- **Controllers**: `InputManager` (`src/input/`) reports `kb1` (arrows, Z fire, X potion) and `pad0`..`pad3`; online, `combined()` merges them into one player's input. It ignores keys while a menu or text field is in use (`enabled`).
- **Coordinates are in tiles.** An entity's `x`/`y` is its centre, and collision uses axis-aligned boxes (`ENTITY_RADIUS`). Levels can wrap on x and/or y (torus mazes), so **always** use `game.dxw()`/`dyw()` for deltas between positions and `wrapX`/`wrapY` after moving. Never subtract coordinates directly. `tileAt()` handles wrapping and treats out-of-bounds as wall.
- Monsters are found through a tile-keyed spatial hash (`buckets`). Call `rebucket()` after moving one and `unbucket()` when killing one. Generators live in `generatorAt` (static, keyed by tile index).
- **Camera**: online, the mirror's camera follows your own hero. In local mode, the renderer sets `game.viewW/viewH` (in tiles) on resize, the camera is the wrapped centroid of the living heroes, and `movePlayerAxis` stops heroes walking out of each other's view, as in the arcade.
- Tuning numbers (hero stats, monster stats, health and food values, limits) are all in `src/core/defs.ts`.

## Levels

- Text format documented at the top of `src/core/level.ts`: `key: value` header, `---`, then a character grid (`#` wall, `D` door, `E` exit, `S` start, items `FCPKT`, generators lowercase `grodlx`, monsters uppercase `GRMLOX`).
- `src/levels/builtin.ts`: original hand-made levels, always available. Custom levels from the editor live outside the repo (see Level sets above). `test/level.test.ts` checks every built-in level is rectangular and its exit is reachable.
- Level sets are served from `public/levels/<set>/index.json` (an ordered array of file names) plus the `.txt` files, and loaded by `main.ts`.
- **Arcade maps**: `tools/import-vgmaps.ts` downloads the arcade Gauntlet I rips from VGMaps and classifies 16 px cells into wall/floor/exit by colour clustering. The rips are 33x33 cells; the 33rd row/column duplicates the first, which the importer uses to detect wrapping. The rips contain **only walls and exits**, so `populate()` places the start, generators, monsters and items deterministically from the seed and level number. Output (`public/levels/gauntlet1/`) and the download cache (`.import-cache/`) are gitignored on purpose: the layouts are Atari's, so don't commit them.
- Gauntlet II maps also exist on VGMaps (`GauntletII-Levels-*.png`), but as 3x3 composite sheets with varied textures and special tiles. The colour-clustering importer doesn't work on them, so they aren't imported yet.

## Graphics

- `art/sheets/` holds the AI-generated source sheets (made with the Gemini image tool: sprites on a flat magenta background, plus a 2x2 tile grid). The tool saves JPEG data even when asked for `.png`, so the slicer sniffs the format.
- `tools/slice-sprites.ts` finds each sprite as a blob of non-magenta pixels, names them in reading order from its `SHEETS`/`TILES` tables, and writes 128x128 soft-edged transparent PNGs to `public/sprites/` (committed), clipping each crop to the sprite's own blob and removing magenta fringe. If you regenerate a sheet, keep the same sprite count and order, or update those tables.
- `src/render/sprites.ts` loads them asynchronously. The renderer draws a sprite if it has loaded and otherwise falls back to its canvas-shape drawing, so a missing sprite never breaks the game. Wall colour per level is a cached hue-rotated copy of one of the two wall textures (`WALL_VARIANTS`). Sprites face down only; facing left is a horizontal mirror.
- Rendering is smooth-scaled (no pixelated mode). `main.ts` calls `renderer.snapshot(game)` before each tick and passes the tick fraction to `draw()`, which interpolates heroes, monsters, shots and the camera. Cosmetic effects (particles, hit flashes, score pop-ups, death bursts) come from diffing game state between frames in `Renderer.trackChanges`, so `src/core` stays free of render events. A low-res light map (`drawLighting`) is multiplied over the scene; `src/render/fx.ts` holds the particles and cached glow/shadow textures. Fonts (Cinzel, Inter) come from Google Fonts with system fallbacks.

## Not implemented yet

Client-side prediction, accounts/auth (a player id is just a bearer token in localStorage), Gauntlet II mechanics (stun tiles, force fields, the dragon, "It"), invisibility and other special potions, friendly-fire stun, directional and animated sprites (heroes and monsters have a single front-facing frame).
