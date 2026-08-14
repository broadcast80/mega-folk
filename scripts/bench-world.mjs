/**
 * World generation benchmark, outside the browser.
 *
 * Generation is the one part of startup that is pure CPU work, so it is also
 * the one part that can be measured without a GPU, a canvas or a headless
 * browser. Run it after touching anything under `src/world/`.
 *
 *   npm run bench:world -- [--seed=neo-war] [--size=288x208] [--erosion=8] [--runs=3]
 */

import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, '..', 'src', 'world', 'index.ts');

const args = new Map(
  process.argv.slice(2)
    .filter((argument) => argument.startsWith('--'))
    .map((argument) => {
      const [key, value = 'true'] = argument.slice(2).split('=');
      return [key, value];
    }),
);

const [width, height] = (args.get('size') ?? '288x208').split('x').map(Number);
const runs = Number(args.get('runs') ?? 3);
const params = {
  seed: args.get('seed') ?? 'neo-war',
  width,
  height,
  shape: args.get('shape') ?? 'islands',
  landPercent: Number(args.get('land') ?? 0.36),
  erosionPasses: Number(args.get('erosion') ?? 8),
  seaLevel: 0,
};

const bundle = await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  logLevel: 'warning',
});
const source = bundle.outputFiles[0].text;
const world = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

console.log(`neo-war · генерация мира ${params.width}×${params.height} = ${params.width * params.height} гексов`);
console.log(`сид "${params.seed}", суша ${Math.round(params.landPercent * 100)}%, эрозия ${params.erosionPasses} проходов, прогонов ${runs}\n`);

const totals = [];
let last = null;
for (let run = 0; run < runs; run++) {
  const started = performance.now();
  const generated = new world.World(params);
  const worldMs = performance.now() - started;

  const vegetationStart = performance.now();
  const plan = world.planVegetation(generated.surface);
  const vegetationMs = performance.now() - vegetationStart;

  totals.push({ worldMs, vegetationMs, generated, plan });
  last = { generated, plan };
  const stages = generated.stats.stageMs;
  const stageLine = Object.entries(stages)
    .map(([name, ms]) => `${name} ${ms.toFixed(0)}`)
    .join(' · ');
  console.log(`прогон ${run + 1}: мир ${worldMs.toFixed(0)} ms + растительность ${vegetationMs.toFixed(0)} ms`);
  console.log(`  стадии: ${stageLine}`);
}

const best = Math.min(...totals.map((entry) => entry.worldMs + entry.vegetationMs));
const stats = last.generated.stats;
console.log(`\nлучший общий результат: ${best.toFixed(0)} ms`);
console.log(`суша ${stats.landPercent}% · море ${stats.seaPercent}% · озёра ${stats.lakePercent}% (${stats.lakes})`);
console.log(`массивы суши ${stats.landmasses} · крупнейший ${stats.largestLandmassPercent}% суши · ровной ${stats.flatLandPercent}%`);
console.log(`реки ${stats.rivers} истоков · береговая линия ${stats.coastline} сторон`);
console.log(`деревья ${last.plan.trees.count} · кусты ${last.plan.bushes.count} · лесных гексов ${last.plan.woodedHexes}`);
console.log('биомы: ' + [...stats.biomeCounts.entries()]
  .sort((a, b) => b[1] - a[1])
  .map(([biome, count]) => `${biome} ${Math.round(count / stats.cells * 100)}%`)
  .join(' · '));

if (args.has('ascii')) {
  const columns = Math.min(96, params.width);
  const rows = Math.min(48, params.height);
  console.log('\nобзор суши (# суша, ^ горы, ~ вода):');
  for (let sy = 0; sy < rows; sy++) {
    let line = sy % 2 ? ' ' : '';
    for (let sx = 0; sx < columns; sx++) {
      const col = Math.min(params.width - 1, Math.floor((sx + 0.5) * params.width / columns));
      const row = Math.min(params.height - 1, Math.floor((sy + 0.5) * params.height / rows));
      const cell = last.generated.cellAt(col, row);
      line += cell?.water ? '~' : cell?.biome.includes('mountain') ? '^' : '#';
    }
    console.log(line);
  }
}
