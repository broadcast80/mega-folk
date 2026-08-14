import type { WorldShape } from './world/index.js';
import type { Backend } from './render/engine.js';

/**
 * Everything tunable, in one place, overridable from the URL.
 *
 * URL parameters are not a debug feature here — they are how a claim about
 * performance gets tested. "Trees are expensive" is an opinion until
 * `?trees=0` and `?trees=12` are two loads of the same seed.
 */
export type AppConfig = {
  backend: Backend;

  seed: string;
  width: number;
  height: number;
  shape: WorldShape;
  landPercent: number;
  erosionPasses: number;

  treesPerHex: number;
  bushesPerHex: number;
  rivers: boolean;

  shadows: boolean;
  shadowMapSize: number;
  shadowSpan: number;
  shadowGlsl: boolean;
  fill: number;
  antialias: boolean;
  pixelRatio: number;
  far: number;
  startRadius: number;
};

export type MapSizeOption = {
  value: string;
  label: string;
  width: number;
  height: number;
};

/** Linear map scales exposed in the UI. The largest has nine times the cells. */
export const MAP_SIZE_OPTIONS: readonly MapSizeOption[] = [
  { value: '1', label: 'Маленькая · 1×', width: 288, height: 208 },
  { value: '1.5', label: 'Средняя · 1,5×', width: 432, height: 312 },
  { value: '2', label: 'Большая · 2×', width: 576, height: 416 },
  { value: '3', label: 'Огромная · 3×', width: 864, height: 624 },
] as const;

export const DEFAULT_CONFIG: AppConfig = {
  backend: 'webgpu',

  seed: 'neo-war',
  width: 288,
  height: 208,
  shape: 'islands',
  landPercent: 0.24,
  // City-folk spent two thirds of its generation time on 17–26 erosion passes.
  // The valley network is cut in the first few; the rest only rounds it off.
  erosionPasses: 10,

  treesPerHex: 7,
  bushesPerHex: 3,
  rivers: true,

  shadows: true,
  shadowMapSize: 2048,
  shadowSpan: 90,
  // Native WGSL on WebGPU. `?shadowglsl=1` switches the shadow pass to the GLSL
  // compatibility path — see the note in `render/scene.ts` before using it.
  shadowGlsl: false,
  // The sun is the only shadow caster, so fill is exactly what washes shadows
  // out. Raise this and they fade; `?fill=0` shows the sun alone.
  fill: 0.35,
  antialias: true,
  pixelRatio: 2,
  far: 2000,
  startRadius: 70,
};

export function readConfig(search: string = location.search): AppConfig {
  const params = new URLSearchParams(search);

  const int = (key: string, fallback: number): number => {
    const raw = Number.parseInt(params.get(key) ?? '', 10);
    return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
  };
  // `Number.parseFloat(x) || fallback` turns a deliberate 0 back into the
  // fallback, which silently ignores `?fill=0` — the one value most worth
  // being able to ask for.
  const float = (key: string, fallback: number): number => {
    const raw = Number.parseFloat(params.get(key) ?? '');
    return Number.isFinite(raw) ? raw : fallback;
  };
  const flag = (key: string, fallback: boolean): boolean => {
    const raw = params.get(key);
    return raw === null ? fallback : raw !== '0' && raw !== 'false';
  };

  const size = params.get('size');
  const [sizeWidth, sizeHeight] = size
    ? size.split('x').map((value) => Number.parseInt(value, 10))
    : [NaN, NaN];

  return {
    backend: params.get('backend') === 'webgl' ? 'webgl' : 'webgpu',

    seed: params.get('seed') ?? DEFAULT_CONFIG.seed,
    width: Number.isFinite(sizeWidth) && sizeWidth > 1 ? sizeWidth : int('width', DEFAULT_CONFIG.width),
    height: Number.isFinite(sizeHeight) && sizeHeight > 1 ? sizeHeight : int('height', DEFAULT_CONFIG.height),
    shape: params.get('shape') === 'archipelago' ? 'archipelago' : 'islands',
    landPercent: float('land', DEFAULT_CONFIG.landPercent),
    erosionPasses: int('erosion', DEFAULT_CONFIG.erosionPasses),

    treesPerHex: float('trees', DEFAULT_CONFIG.treesPerHex),
    bushesPerHex: float('bushes', DEFAULT_CONFIG.bushesPerHex),
    rivers: flag('rivers', DEFAULT_CONFIG.rivers),

    shadows: flag('shadows', DEFAULT_CONFIG.shadows),
    shadowMapSize: int('shadowmap', DEFAULT_CONFIG.shadowMapSize),
    shadowSpan: int('shadowspan', DEFAULT_CONFIG.shadowSpan),
    shadowGlsl: flag('shadowglsl', DEFAULT_CONFIG.shadowGlsl),
    fill: float('fill', DEFAULT_CONFIG.fill),
    antialias: flag('msaa', DEFAULT_CONFIG.antialias),
    pixelRatio: float('res', DEFAULT_CONFIG.pixelRatio),
    far: int('far', DEFAULT_CONFIG.far),
    startRadius: float('zoom', DEFAULT_CONFIG.startRadius),
  };
}
