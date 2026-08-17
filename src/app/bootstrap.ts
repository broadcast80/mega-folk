import { MAP_SIZE_OPTIONS, type AppConfig } from '../config.js';
import { Game } from '../game/state.js';
import { createEngine } from '../render/engine.js';
import { createScene } from '../render/scene.js';
import { createTerrain } from '../render/terrain.js';
import { createRivers } from '../render/rivers.js';
import { createVegetation } from '../render/vegetation.js';
import { RtsCamera } from '../render/camera.js';
import { HexCursor } from '../render/hexCursor.js';
import { FrameStats } from '../render/frameStats.js';
import { planVegetation, World } from '../world/index.js';
import type { WorldCell } from '../world/index.js';
import { Hud } from './hud.js';
import type { SceneFacts } from './hud.js';

export type BootstrapElements = {
  canvas: HTMLCanvasElement;
  notice: HTMLElement;
  performance: HTMLElement;
  inspector: HTMLElement;
  newWorld: HTMLButtonElement;
  mapSize: HTMLSelectElement;
};

export type GameHandle = {
  /** Current state; both are replaced when the world is regenerated. */
  readonly game: Game;
  readonly world: World;
  camera: RtsCamera;
  /** Rebuilds the map from a seed, keeping the engine and the camera alive. */
  regenerate(seed?: string): Promise<void>;
  dispose(): void;
};

/** Everything that belongs to one generated map and dies with it. */
type WorldLayer = {
  world: World;
  cursor: HexCursor;
  facts: SceneFacts;
  sceneHtml: string;
  dispose(): void;
};

/**
 * Startup, in the order the player experiences it.
 *
 * The whole world is built before the first frame and nothing is streamed:
 * every hex, every tree and every river is in the scene from the start. That is
 * a deliberate choice for this stage — chunking, LOD and streaming are the
 * machinery that hides a problem, and none of it should be added before there
 * is a measurement saying which stage of the frame is actually expensive.
 */
export async function bootstrap(elements: BootstrapElements, config: AppConfig): Promise<GameHandle> {
  const { canvas, notice } = elements;
  const say = async (message: string): Promise<void> => {
    notice.textContent = message;
    // Yield twice: once to let the browser lay the text out, once to let it
    // paint. Without this the whole load is one frozen frame with a stale label.
    await nextFrame();
    await nextFrame();
  };

  await say('Инициализация движка…');
  const { engine, backend, gpuTiming } = await createEngine(canvas, {
    backend: config.backend,
    antialias: config.antialias,
    pixelRatio: config.pixelRatio,
  });

  const rig = createScene(engine, {
    backend,
    shadows: config.shadows,
    shadowMapSize: config.shadowMapSize,
    shadowSpan: config.shadowSpan,
    shadowGlsl: config.shadowGlsl,
    fill: config.fill,
    far: config.far,
  });
  const hud = new Hud(elements.performance, elements.inspector);
  let mapWidth = config.width;
  let mapHeight = config.height;
  const initialSize = MAP_SIZE_OPTIONS.find((size) => size.width === mapWidth && size.height === mapHeight);
  if (initialSize) {
    elements.mapSize.value = initialSize.value;
  } else {
    const custom = document.createElement('option');
    custom.value = 'custom';
    custom.textContent = `Своя · ${mapWidth}×${mapHeight}`;
    elements.mapSize.prepend(custom);
    elements.mapSize.value = custom.value;
  }

  /**
   * Builds one map: world data, then everything drawn from it.
   *
   * Deliberately synchronous. The caller yields to the browser *before* calling
   * this, never inside it, so the render loop can never catch the scene halfway
   * between two worlds.
   */
  function buildLayer(seed: string): WorldLayer {
    const worldStart = performance.now();
    const world = new World({
      seed,
      width: mapWidth,
      height: mapHeight,
      shape: config.shape,
      landPercent: config.landPercent,
      erosionPasses: config.erosionPasses,
      seaLevel: 0,
    });
    const worldMs = performance.now() - worldStart;

    const vegetationStart = performance.now();
    const plan = planVegetation(world.surface, {
      treesPerHex: config.treesPerHex,
      bushesPerHex: config.bushesPerHex,
    });
    const planMs = performance.now() - vegetationStart;

    const sceneStart = performance.now();
    const terrain = createTerrain(rig.scene, world, { shadows: config.shadows });
    const rivers = config.rivers
      ? createRivers(rig.scene, world)
      : { mesh: null, segments: 0, triangles: 0 };
    const vegetation = createVegetation(rig.scene, plan, { shadows: config.shadows });
    for (const mesh of vegetation.meshes) rig.addCaster(mesh);
    const cursor = new HexCursor(rig.scene, world.surface);
    const sceneMs = performance.now() - sceneStart;

    const facts: SceneFacts = {
      backend,
      requestedBackend: config.backend,
      seed,
      hexes: world.cells.length,
      terrainTriangles: terrain.triangles,
      vegetationTriangles: vegetation.triangles,
      trees: vegetation.trees,
      bushes: vegetation.bushes,
      riverSources: world.stats.rivers,
      riverSegments: rivers.segments,
      shadows: config.shadows ? config.shadowMapSize : 0,
      pixelRatio: 1 / engine.getHardwareScalingLevel(),
      buildMs: { world: worldMs, vegetation: planMs, terrain: terrain.buildMs, scene: sceneMs },
    };

    return {
      world,
      cursor,
      facts,
      sceneHtml: hud.describeScene(facts, world.stats),
      dispose(): void {
        // Casters first: a disposed mesh left in the shadow map's render list
        // is still drawn on the next shadow pass.
        rig.clearCasters();
        cursor.dispose();
        for (const mesh of vegetation.meshes) mesh.dispose(false, true);
        rivers.mesh?.dispose(false, true);
        terrain.mesh.dispose(false, true);
      },
    };
  }

  await say(`Генерация мира ${mapWidth}×${mapHeight}…`);
  let layer = buildLayer(config.seed);
  let game = new Game(layer.world);

  const start = layer.world.findStartCell();
  const [startX, startZ] = start
    ? layer.world.surface.centreOf(start)
    : [layer.world.bounds.centreX, layer.world.bounds.centreZ];
  const camera = new RtsCamera(rig.scene, canvas, layer.world.surface, {
    bounds: layer.world.bounds,
    startX,
    startZ,
    startRadius: config.startRadius,
    far: config.far,
  });

  hud.updateInspector(null, null, game.turn);
  const stats = new FrameStats(engine, rig.scene, gpuTiming);

  // Pointer state is sampled in the render loop rather than acted on per event:
  // a mouse can fire far more moves than there are frames, and the hex under
  // the cursor only means anything once per frame anyway.
  let pointerX = -1;
  let pointerY = -1;
  let hovered: WorldCell | null = null;

  const disposers: Array<() => void> = [];
  const listen = <K extends keyof WindowEventMap>(
    target: Window | HTMLCanvasElement,
    type: K,
    handler: (event: WindowEventMap[K]) => void,
  ): void => {
    target.addEventListener(type, handler as EventListener);
    disposers.push(() => target.removeEventListener(type, handler as EventListener));
  };

  listen(canvas, 'pointermove', (event) => {
    pointerX = event.clientX;
    pointerY = event.clientY;
  });
  listen(canvas, 'pointerleave', () => {
    pointerX = -1;
    pointerY = -1;
  });
  listen(canvas, 'pointerdown', (event) => {
    if (event.button !== 0) return;
    const cell = cellUnderPointer(event.clientX, event.clientY);
    game.dispatch(cell ? { type: 'select', col: cell.col, row: cell.row } : { type: 'clear-selection' });
  });
  listen(window, 'keydown', (event) => {
    if (event.code === 'Space') {
      event.preventDefault();
      game.dispatch({ type: 'end-turn' });
    }
    if (event.code === 'Escape') game.dispatch({ type: 'clear-selection' });
    if (event.code === 'KeyN') void regenerate();
  });
  listen(window, 'resize', () => {
    if (canvas.clientWidth && canvas.clientHeight) engine.resize();
  });
  const onNewWorld = (): void => void regenerate();
  elements.newWorld.addEventListener('click', onNewWorld);
  disposers.push(() => elements.newWorld.removeEventListener('click', onNewWorld));
  const onMapSize = (): void => {
    const selected = MAP_SIZE_OPTIONS.find((size) => size.value === elements.mapSize.value);
    if (!selected || (selected.width === mapWidth && selected.height === mapHeight)) return;
    mapWidth = selected.width;
    mapHeight = selected.height;
    void regenerate(layer.world.params.seed);
  };
  elements.mapSize.addEventListener('change', onMapSize);
  disposers.push(() => elements.mapSize.removeEventListener('change', onMapSize));

  let unsubscribe = subscribeHud();
  function subscribeHud(): () => void {
    return game.subscribe(() => hud.updateInspector(hovered, game.selected, game.turn));
  }

  let rebuilding = false;

  /**
   * Swaps in a freshly generated map without touching the engine, the scene or
   * the camera.
   *
   * The world layer is a pure function of its parameters, so a new map is a new
   * `World` and the meshes drawn from it — nothing else has to be torn down. A
   * page reload would be simpler and three times slower, and it would lose the
   * one thing worth keeping while browsing maps: the camera you set up.
   *
   * The game state does not survive, and should not: its selection points at
   * cells that no longer exist.
   */
  async function regenerate(seed = randomSeed()): Promise<void> {
    if (rebuilding) return;
    rebuilding = true;
    elements.newWorld.disabled = true;
    elements.mapSize.disabled = true;
    notice.classList.remove('is-done');
    await say(`Генерация мира ${mapWidth}×${mapHeight} · сид ${seed}…`);

    // From here to the end of the function nothing awaits, so the render loop
    // cannot observe a disposed world.
    layer.dispose();
    unsubscribe();
    layer = buildLayer(seed);
    game = new Game(layer.world);
    unsubscribe = subscribeHud();

    hovered = null;
    camera.retarget(layer.world.surface);
    const landing = layer.world.findStartCell();
    if (landing) {
      const [x, z] = layer.world.surface.centreOf(landing);
      camera.jumpTo(x, z);
    }
    hud.updateInspector(null, null, game.turn);
    // The URL is the share link and the reload: the map you are looking at has
    // to be the map that comes back.
    const url = new URL(location.href);
    url.searchParams.set('seed', seed);
    url.searchParams.set('size', `${mapWidth}x${mapHeight}`);
    history.replaceState(null, '', url);

    notice.textContent = '';
    notice.classList.add('is-done');
    elements.newWorld.disabled = false;
    elements.mapSize.disabled = false;
    rebuilding = false;
  }

  function cellUnderPointer(clientX: number, clientY: number): WorldCell | null {
    const ground = camera.groundAt(clientX, clientY);
    return ground ? layer.world.cellAtWorld(ground.x, ground.z) ?? null : null;
  }

  notice.textContent = '';
  notice.classList.add('is-done');

  engine.runRenderLoop(() => {
    stats.beginFrame();
    const seconds = engine.getDeltaTime() / 1000;

    camera.update(seconds);
    game.update(seconds);
    // The sun's shadow box follows what the camera looks at, so the shadow map
    // is spent where the player is rather than smeared over the whole map.
    rig.followTarget(camera.camera.target.x, camera.camera.target.y, camera.camera.target.z);

    if (pointerX >= 0) {
      const cell = cellUnderPointer(pointerX, pointerY);
      if (cell !== hovered) {
        hovered = cell;
        layer.cursor.show(cell);
        hud.updateInspector(hovered, game.selected, game.turn);
      }
    } else if (hovered) {
      hovered = null;
      layer.cursor.show(null);
    }

    rig.scene.render();
    stats.endFrame();

    const report = stats.report();
    if (report) hud.updatePerformance(report, layer.facts, layer.sceneHtml);
  });

  return {
    // Getters, not values: both are replaced on every regeneration, and a
    // console handle pointing at a disposed world is a debugging trap.
    get game(): Game { return game; },
    get world(): World { return layer.world; },
    camera,
    regenerate,
    dispose(): void {
      engine.stopRenderLoop();
      for (const off of disposers) off();
      camera.dispose();
      stats.dispose();
      rig.scene.dispose();
      engine.dispose();
    },
  };
}

/** Short, pronounceable, and legible in a URL. */
function randomSeed(): string {
  return Math.random().toString(36).slice(2, 8);
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}
