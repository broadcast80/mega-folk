/**
 * Architecture boundary check.
 *
 * Two rules, both about keeping the game playable without a GPU:
 *
 *   world/ imports nothing from render/, game/ or app/, and never Babylon;
 *   game/  imports nothing from render/ or app/, and never Babylon.
 *
 * They are cheap to state and expensive to restore once broken — one
 * `import { Vector3 }` in a generator is all it takes for world generation to
 * stop being runnable in a worker, in a test, or on a server.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

const RULES = [
  { layer: 'world', forbidden: [/@babylonjs/, /\.\.\/render\//, /\.\.\/game\//, /\.\.\/app\//] },
  { layer: 'game', forbidden: [/@babylonjs/, /\.\.\/render\//, /\.\.\/app\//] },
];

const IMPORT = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g;

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else if (entry.name.endsWith('.ts')) files.push(full);
  }
  return files;
}

let failures = 0;
for (const rule of RULES) {
  const directory = path.join(root, rule.layer);
  for (const file of await walk(directory)) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(IMPORT)) {
      const specifier = match[1];
      if (!rule.forbidden.some((pattern) => pattern.test(specifier))) continue;
      console.error(`${path.relative(root, file)}: слой ${rule.layer} не должен импортировать "${specifier}"`);
      failures++;
    }
  }
}

if (failures > 0) {
  console.error(`\nГраницы слоёв нарушены: ${failures}`);
  process.exit(1);
}
console.log('Границы слоёв в порядке: world/ и game/ не знают ни о Babylon, ни о рендере.');
