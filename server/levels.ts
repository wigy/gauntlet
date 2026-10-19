import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_LEVELS } from '../src/levels/builtin';

/**
 * Level texts for new games: the `set` from public/levels/<set>/ (default gauntlet1, made by `npm run import:g1`),
 * falling back to the built-in levels when that set isn't there.
 */
export function loadLevels(set = process.env.LEVELS ?? 'gauntlet1', root = 'public/levels'): string[] {
  const dir = join(root, set);
  const index = join(dir, 'index.json');
  if (set !== 'builtin' && existsSync(index)) {
    try {
      const files = JSON.parse(readFileSync(index, 'utf8')) as string[];
      const texts = files.map((f) => readFileSync(join(dir, f), 'utf8'));
      if (texts.length) return texts;
    } catch (err) {
      console.error(`Could not load level set ${set}:`, err);
    }
  }
  return [...BUILTIN_LEVELS];
}
