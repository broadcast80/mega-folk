/**
 * Scene construction check, without a GPU.
 *
 * Babylon's `NullEngine` builds every object, buffer and render list for real
 * and only stops at the driver call, which is exactly the half of the renderer
 * that fails silently or throws in a render loop where nobody reads the console.
 * It catches the whole family of "side-effect module was never imported" bugs —
 * `thinInstanceSetBuffer` doing nothing, `createPickingRay` throwing, a shadow
 * generator with no scene component — plus empty buffers, NaN geometry and
 * meshes that end up with no triangles.
 *
 * What it cannot catch: shader compilation, WebGPU pipelines and anything you
 * have to look at. Those need a browser on a real GPU.
 *
 *   npm run check:scene
 */

import { Buffer } from 'node:buffer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

// A DOM thin enough for the camera's input binding and Babylon's canvas checks.
const noop = () => {};
const fakeCanvas = {
  width: 1280,
  height: 720,
  clientWidth: 1280,
  clientHeight: 720,
  addEventListener: noop,
  removeEventListener: noop,
  setPointerCapture: noop,
  releasePointerCapture: noop,
  hasPointerCapture: () => false,
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
  getContext: () => null,
};
globalThis.window ??= {
  addEventListener: noop,
  removeEventListener: noop,
  devicePixelRatio: 1,
};
globalThis.document ??= {
  createElement: () => fakeCanvas,
  addEventListener: noop,
  removeEventListener: noop,
};
globalThis.navigator ??= { userAgent: 'node' };

const entry = `
  import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
  import { World, planVegetation } from '${posix(path.join(root, 'src/world/index.ts'))}';
  import { createScene } from '${posix(path.join(root, 'src/render/scene.ts'))}';
  import { createTerrain } from '${posix(path.join(root, 'src/render/terrain.ts'))}';
  import { createWater } from '${posix(path.join(root, 'src/render/water.ts'))}';
  import { createRivers } from '${posix(path.join(root, 'src/render/rivers.ts'))}';
  import { createVegetation } from '${posix(path.join(root, 'src/render/vegetation.ts'))}';
  import { RtsCamera } from '${posix(path.join(root, 'src/render/camera.ts'))}';
  import { HexCursor } from '${posix(path.join(root, 'src/render/hexCursor.ts'))}';
  import { Game } from '${posix(path.join(root, 'src/game/state.ts'))}';
  export { NullEngine, World, planVegetation, createScene, createTerrain, createWater,
    createRivers, createVegetation, RtsCamera, HexCursor, Game };
`;

const bundle = await build({
  stdin: { contents: entry, resolveDir: root, loader: 'ts' },
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  logLevel: 'warning',
});
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

const failures = [];
const check = (condition, message) => {
  if (condition) console.log(`  ok   ${message}`);
  else { console.log(`  FAIL ${message}`); failures.push(message); }
};

const WIDTH = 96;
const HEIGHT = 72;

console.log(`neo-war · проверка сборки сцены на NullEngine (мир ${WIDTH}×${HEIGHT})\n`);

const engine = new api.NullEngine({ renderWidth: 1280, renderHeight: 720, textureSize: 512 });
const world = new api.World({
  seed: 'check-scene',
  width: WIDTH,
  height: HEIGHT,
  shape: 'islands',
  landPercent: 0.36,
  erosionPasses: 6,
  seaLevel: 0,
});
const plan = planVegetationSafely();

function planVegetationSafely() {
  return api.planVegetation(world.surface, { treesPerHex: 5, bushesPerHex: 2 });
}

console.log('мир');
check(world.cells.length === WIDTH * HEIGHT, `${world.cells.length} клеток`);
check(world.cells.every((cell) => Number.isFinite(cell.elevation)), 'высоты конечны');
check(world.stats.landPercent > 10 && world.stats.landPercent < 90, `суша ${world.stats.landPercent}%`);

console.log('\nповерхность');
// Watertightness: two neighbours must agree on the corner they share, or the
// terrain mesh has cracks the sky shines through.
let worstSeam = 0;
for (const cell of world.cells) {
  for (let corner = 0; corner < 6; corner++) {
    const mine = world.surface.cornerHeight(cell, corner);
    for (const direction of [corner - 1, corner]) {
      const neighbour = world.surface.neighbourAt(cell, direction);
      if (!neighbour) continue;
      // The same physical corner, seen from the neighbour's own numbering.
      for (let other = 0; other < 6; other++) {
        const [cx, cz] = world.surface.centreOf(cell);
        const [nx, nz] = world.surface.centreOf(neighbour);
        const dx = (cx + Math.cos((Math.PI / 180) * (60 * corner - 30)))
          - (nx + Math.cos((Math.PI / 180) * (60 * other - 30)));
        const dz = (cz + Math.sin((Math.PI / 180) * (60 * corner - 30)))
          - (nz + Math.sin((Math.PI / 180) * (60 * other - 30)));
        if (Math.hypot(dx, dz) > 1e-6) continue;
        worstSeam = Math.max(worstSeam, Math.abs(mine - world.surface.cornerHeight(neighbour, other)));
      }
    }
  }
}
check(worstSeam < 1e-4, `общие углы совпадают, худшее расхождение ${worstSeam.toExponential(1)}`);

const probe = world.cells.find((cell) => !cell.water) ?? world.cells[0];
const [probeX, probeZ] = world.surface.centreOf(probe);
const probeY = world.surface.heightForCell(probe);
const hit = world.surface.raycast(probeX, probeY + 40, probeZ, 0, -1, 0);
check(hit !== null && Math.abs(hit.y - probeY) < 0.05, 'луч сверху попадает в свою клетку');
check(hit !== null && hit.cell.index === probe.index, 'луч возвращает ту же клетку');

console.log('\nсцена');
const rig = api.createScene(engine, {
  backend: 'webgl',
  shadows: true,
  shadowMapSize: 1024,
  shadowSpan: 90,
  shadowGlsl: false,
  fill: 0.35,
  far: 2000,
});
const terrain = api.createTerrain(rig.scene, world, { shadows: true });
const water = api.createWater(rig.scene, world);
const rivers = api.createRivers(rig.scene, world);
const vegetation = api.createVegetation(rig.scene, plan, { shadows: true });
for (const mesh of vegetation.meshes) rig.addCaster(mesh);

check(terrain.mesh.getTotalIndices() === WIDTH * HEIGHT * 18, `рельеф ${terrain.triangles} треугольников в одном меше`);
check(noNaN(terrain.mesh), 'в позициях рельефа нет NaN');
check(waterTerrainIsSubmerged(terrain.mesh, world), 'синие водные гексы не поднимаются над поверхностью воды');
check(water.meshes.length >= 1, `вода: ${water.meshes.length} меша`);
check(rivers.segments > 0, `реки: ${rivers.segments} сегментов`);
check(vegetation.meshes.length === 3, `растительность в ${vegetation.meshes.length} мешах`);
check(plan.trees.count > 0 && vegetation.triangles > 0, `${plan.trees.count} деревьев, ${vegetation.triangles} треугольников`);
// A thin-instance buffer that never reached the mesh leaves the count undefined
// and draws exactly one prototype at the origin, with no error anywhere.
check(
  vegetation.meshes.every((mesh) => (mesh.thinInstanceCount ?? 0) > 0),
  'у каждого меша растительности выставлен thin-instance буфер',
);
const shadowCasters = rig.shadowGenerator?.getShadowMap()?.renderList?.length ?? 0;
check(shadowCasters === 3, `в shadow pass ${shadowCasters} кастера`);

console.log('\nкамера и ввод');
const start = world.findStartCell();
const [startX, startZ] = start ? world.surface.centreOf(start) : [0, 0];
const camera = new api.RtsCamera(rig.scene, fakeCanvas, world.surface, {
  bounds: world.bounds, startX, startZ, startRadius: 70, far: 2000,
});
const cursor = new api.HexCursor(rig.scene, world.surface);
const game = new api.Game(world);

// The failure this exists for: `createPickingRay` throws unless the ray module
// was imported for its side effect, and it throws inside the render loop.
let picked = null;
let pickError = null;
try {
  picked = camera.groundAt(640, 360);
} catch (error) {
  pickError = error;
}
check(pickError === null, `луч под курсором строится${pickError ? `: ${pickError.message}` : ''}`);
check(picked !== null, 'курсор в центре экрана попадает в землю');
if (picked) {
  const cell = world.cellAtWorld(picked.x, picked.z);
  cursor.show(cell ?? null);
  game.dispatch(cell ? { type: 'select', col: cell.col, row: cell.row } : { type: 'clear-selection' });
  check(game.selected !== null, `клик выбирает клетку ${game.selected?.col}:${game.selected?.row}`);
}

console.log('\nкадры');
let renderError = null;
try {
  for (let frame = 0; frame < 3; frame++) {
    camera.update(1 / 60);
    game.update(1 / 60);
    rig.followTarget(camera.camera.target.x, camera.camera.target.y, camera.camera.target.z);
    rig.scene.render();
  }
} catch (error) {
  renderError = error;
}
check(renderError === null, `три кадра отрисованы${renderError ? `: ${renderError.message}` : ''}`);
check(Number.isFinite(camera.camera.radius) && camera.camera.radius > 0, `радиус камеры ${camera.camera.radius.toFixed(1)}`);

const largerWorld = new api.World({
  seed: 'check-camera-resize',
  width: WIDTH * 2,
  height: HEIGHT * 2,
  shape: 'islands',
  landPercent: 0.24,
  erosionPasses: 1,
  seaLevel: 0,
});
const oldMaxRadius = camera.maxRadius;
camera.retarget(largerWorld.surface);
check(camera.maxRadius > oldMaxRadius, 'границы и дальний зум камеры обновляются с размером карты');

let disposeError = null;
try {
  engine.dispose();
} catch (error) {
  disposeError = error;
}
check(disposeError === null, `сцена освобождается${disposeError ? `: ${disposeError.message}` : ''}`);

console.log('');
if (failures.length > 0) {
  console.error(`Провалено проверок: ${failures.length}`);
  process.exit(1);
}
console.log('Сцена собирается и рисуется без GPU.');

function noNaN(mesh) {
  const positions = mesh.getVerticesData('position');
  if (!positions) return false;
  for (let index = 0; index < positions.length; index++) {
    if (!Number.isFinite(positions[index])) return false;
  }
  return true;
}

function waterTerrainIsSubmerged(mesh, generated) {
  const positions = mesh.getVerticesData('position');
  if (!positions) return false;
  for (const cell of generated.cells) {
    if (!cell.water) continue;
    const ceiling = generated.surface.waterHeightForCell(cell) - 0.005;
    for (let vertex = 0; vertex < 7; vertex++) {
      const y = positions[(cell.index * 7 + vertex) * 3 + 1];
      if (y > ceiling) return false;
    }
  }
  return true;
}

function posix(value) {
  return value.split(path.sep).join('/');
}
