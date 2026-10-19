# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Web remake of Atari's 1985 coin-op **Gauntlet**: up to 4 players co-op on one screen (local keyboard and gamepads), TypeScript + Vite + Canvas 2D, no runtime dependencies.

## Commands

```bash
npm run dev                 # Vite dev server
npm run build               # typecheck + production build to dist/
npm run typecheck           # tsc --noEmit (this is the lint step; there is no ESLint)
npm test                    # vitest run
npx vitest run test/game.test.ts -t "opens doors"   # single file / single test
npm run import:g1           # download + convert all 125 arcade Gauntlet maps (see below)
npm run import:g1 -- 9 78   # convert only these level numbers and print them as ASCII
npm run sprites             # re-slice art/sheets/* into public/sprites/*.png
```

URL parameters: `?levels=builtin|gauntlet1` (default `gauntlet1`, falls back to built-in if not imported), `?level=N` start level, `?seed=N` fixes the random seed.

## Architecture

- **`src/core/` is pure simulation, no DOM.** `Game` (`game.ts`) advances one fixed `TICK` (1/60 s) per `step(inputs)`, where `inputs` is `Map<controllerId, PlayerInput>`. Rendering, audio and input only read game state and drain `game.events` (`say` / `sfx` / `flash`). Keep it that way: the determinism (all randomness goes through the seeded `Rng`) is what the tests rely on, and it keeps a lockstep online multiplayer possible later.
- **Controllers vs. players**: `InputManager` (`src/input/`) reports every controller (`kb1` = arrows + Z fire + X potion, `pad0`..`pad3`) every tick, joined or not. `Game.handleJoins` binds a controller to a free player slot on a FIRE press, assigning the first unused hero. FIRE also revives a dead player, and starts a new game from the attract or game-over screen.
- **Coordinates are in tiles.** An entity's `x`/`y` is its centre, and collision uses axis-aligned boxes (`ENTITY_RADIUS`). Levels can wrap on x and/or y (torus mazes), so **always** use `game.dxw()`/`dyw()` for deltas between positions and `wrapX`/`wrapY` after moving. Never subtract coordinates directly. `tileAt()` handles wrapping and treats out-of-bounds as wall.
- Monsters are found through a tile-keyed spatial hash (`buckets`). Call `rebucket()` after moving one and `unbucket()` when killing one. Generators live in `generatorAt` (static, keyed by tile index).
- **Shared screen**: the renderer sets `game.viewW/viewH` (in tiles) on resize. The camera is the wrapped centroid of the living heroes, and `movePlayerAxis` stops heroes walking out of each other's view, as in the arcade.
- Tuning numbers (hero stats, monster stats, health and food values, limits) are all in `src/core/defs.ts`.

## Levels

- Text format documented at the top of `src/core/level.ts`: `key: value` header, `---`, then a character grid (`#` wall, `D` door, `E` exit, `S` start, items `FCPKT`, generators lowercase `grodlx`, monsters uppercase `GRMLOX`).
- `src/levels/builtin.ts`: original hand-made levels, always available. `test/level.test.ts` checks every built-in level is rectangular and its exit is reachable.
- Level sets are served from `public/levels/<set>/index.json` (an ordered array of file names) plus the `.txt` files, and loaded by `main.ts`.
- **Arcade maps**: `tools/import-vgmaps.ts` downloads the arcade Gauntlet I rips from VGMaps and classifies 16 px cells into wall/floor/exit by colour clustering. The rips are 33x33 cells; the 33rd row/column duplicates the first, which the importer uses to detect wrapping. The rips contain **only walls and exits**, so `populate()` places the start, generators, monsters and items deterministically from the seed and level number. Output (`public/levels/gauntlet1/`) and the download cache (`.import-cache/`) are gitignored on purpose: the layouts are Atari's, so don't commit them.
- Gauntlet II maps also exist on VGMaps (`GauntletII-Levels-*.png`), but as 3x3 composite sheets with varied textures and special tiles. The colour-clustering importer doesn't work on them, so they aren't imported yet.

## Graphics

- `art/sheets/` holds the AI-generated source sheets (made with the Gemini image tool: sprites on a flat magenta background, plus a 2x2 tile grid). The tool saves JPEG data even when asked for `.png`, so the slicer sniffs the format.
- `tools/slice-sprites.ts` finds each sprite as a blob of non-magenta pixels, names them in reading order from its `SHEETS`/`TILES` tables, and writes 128x128 soft-edged transparent PNGs to `public/sprites/` (committed), clipping each crop to the sprite's own blob and removing magenta fringe. If you regenerate a sheet, keep the same sprite count and order, or update those tables.
- `src/render/sprites.ts` loads them asynchronously. The renderer draws a sprite if it has loaded and otherwise falls back to its canvas-shape drawing, so a missing sprite never breaks the game. Wall colour per level is a cached hue-rotated copy of one of the two wall textures (`WALL_VARIANTS`). Sprites face down only; facing left is a horizontal mirror.
- Rendering is smooth-scaled (no pixelated mode). `main.ts` calls `renderer.snapshot(game)` before each tick and passes the tick fraction to `draw()`, which interpolates heroes, monsters, shots and the camera. Cosmetic effects (particles, hit flashes, score pop-ups, death bursts) come from diffing game state between frames in `Renderer.trackChanges`, so `src/core` stays free of render events. A low-res light map (`drawLighting`) is multiplied over the scene; `src/render/fx.ts` holds the particles and cached glow/shadow textures. Fonts (Cinzel, Inter) come from Google Fonts with system fallbacks.

## Not implemented yet

Online multiplayer, Gauntlet II mechanics (stun tiles, force fields, the dragon, "It"), invisibility and other special potions, friendly-fire stun, directional and animated sprites (heroes and monsters have a single front-facing frame).
