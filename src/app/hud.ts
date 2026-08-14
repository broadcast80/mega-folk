import type { FrameReport } from '../render/frameStats.js';
import type { WorldCell, WorldStats } from '../world/index.js';

/**
 * The two panels on screen: a live performance readout and the state of the
 * hex under the cursor. Text only, no framework — a HUD that needs a build step
 * of its own is a HUD that stops being updated.
 */

export type SceneFacts = {
  backend: string;
  requestedBackend: string;
  seed: string;
  hexes: number;
  terrainTriangles: number;
  vegetationTriangles: number;
  trees: number;
  bushes: number;
  riverSources: number;
  riverSegments: number;
  shadows: number;
  pixelRatio: number;
  buildMs: { world: number; vegetation: number; terrain: number; scene: number };
};

const BIOME_LABELS: Record<string, string> = {
  'deep-ocean': 'глубокий океан',
  'shallow-ocean': 'мелководье',
  lake: 'озеро',
  beach: 'пляж',
  grassland: 'равнина',
  forest: 'лес',
  highland: 'нагорье',
  mountain: 'горы',
  'snowy-mountain': 'снежные вершины',
};

export class Hud {
  constructor(
    private readonly performance: HTMLElement,
    private readonly inspector: HTMLElement,
  ) {}

  /** Static half of the readout: what was built, and how long it took. */
  describeScene(facts: SceneFacts, stats: WorldStats): string {
    const totalTriangles = (facts.terrainTriangles + facts.vegetationTriangles) / 1_000_000;
    return [
      `<p class="line dim">сид ${facts.seed} · ${facts.hexes.toLocaleString('ru')} гексов · ${totalTriangles.toFixed(2)}M треугольников</p>`,
      `<p class="line dim">${facts.trees.toLocaleString('ru')} деревьев · ${facts.bushes.toLocaleString('ru')} кустов</p>`,
      `<p class="line dim">${facts.riverSources} рек · ${facts.riverSegments} сегментов</p>`,
      `<p class="line dim">суша ${stats.landPercent}% · озёра ${stats.lakes} · массивы ${stats.landmasses}</p>`,
      `<p class="line dim">тени ${facts.shadows || 'off'} · dpr ${facts.pixelRatio.toFixed(2)}</p>`,
      `<p class="line dim">сборка: мир ${facts.buildMs.world.toFixed(0)} · зелень ${facts.buildMs.vegetation.toFixed(0)}`
      + ` · рельеф ${facts.buildMs.terrain.toFixed(0)} · сцена ${facts.buildMs.scene.toFixed(0)} ms</p>`,
    ].join('');
  }

  updatePerformance(report: FrameReport, facts: SceneFacts, sceneHtml: string): void {
    const backend = facts.backend === facts.requestedBackend
      ? facts.backend
      : `${facts.backend} (запрошен ${facts.requestedBackend})`;
    const gpu = report.gpuMs === null
      ? '<span class="warn">gpu — недоступно</span>'
      : `gpu ${report.gpuMs.toFixed(1)} ms`;
    this.performance.innerHTML = [
      `<p class="line strong">${backend} · ${report.fps} fps</p>`,
      `<p class="line">p50 ${report.p50.toFixed(1)} · p95 ${report.p95.toFixed(1)} · p99 ${report.p99.toFixed(1)} ms</p>`,
      `<p class="line">cpu ${report.cpuMs.toFixed(1)} ms · ${gpu} · ${report.drawCalls} draws</p>`,
      sceneHtml,
      report.backlog
        ? '<p class="warn">GPU не успевает за темпом сабмита — очередь копится, счётчик fps врёт.</p>'
        : '',
    ].join('');
  }

  updateInspector(cell: WorldCell | null, selected: WorldCell | null, turn: number): void {
    const rows: string[] = [`<p class="line strong">ход ${turn}</p>`];
    if (cell) {
      rows.push(`<p class="line">${BIOME_LABELS[cell.biome] ?? cell.biome} · ${cell.col}:${cell.row}</p>`);
      rows.push(`<p class="line dim">высота ${cell.elevation.toFixed(3)} · уклон ${cell.slope.toFixed(2)}</p>`);
      rows.push(`<p class="line dim">влажность ${cell.moisture.toFixed(2)} · температура ${cell.temperature.toFixed(2)}</p>`);
      if (cell.flow > 24) rows.push(`<p class="line dim">водосбор ${Math.round(cell.flow)} клеток</p>`);
    } else {
      rows.push('<p class="line dim">курсор вне карты</p>');
    }
    rows.push(selected
      ? `<p class="line">выбрано ${selected.col}:${selected.row}</p>`
      : '<p class="line dim">ЛКМ — выбрать гекс</p>');
    this.inspector.innerHTML = rows.join('');
  }
}
