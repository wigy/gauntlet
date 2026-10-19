/** Downloads from the VGMaps arcade atlas, cached in .import-cache/ (gitignored: the maps are Atari's). */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const BASE = 'https://www.vgmaps.com/Atlas/Arcade/';
const CACHE = '.import-cache';

export async function fetchCached(file: string): Promise<Buffer> {
  mkdirSync(CACHE, { recursive: true });
  const path = join(CACHE, file);
  if (existsSync(path)) return readFileSync(path);
  const res = await fetch(BASE + encodeURIComponent(file));
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(path, buf);
  return buf;
}
