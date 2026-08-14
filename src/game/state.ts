import type { Rng, World, WorldCell } from '../world/index.js';
import { mulberry32, hashString } from '../world/index.js';

/**
 * Game state, headless.
 *
 * Nothing here knows that a renderer exists. State changes go through
 * `dispatch`, and everything interested finds out through `subscribe` — so a
 * later multiplayer or replay layer can feed the same commands in from a
 * network stream or a log, and an AI can issue them without a camera, a canvas
 * or a pointer event anywhere in the picture.
 *
 * That is the whole reason this file has no imports from `render/`, and
 * `scripts/check-boundaries.mjs` fails the build if one appears.
 */

export type GameCommand =
  | { type: 'select'; col: number; row: number }
  | { type: 'clear-selection' }
  | { type: 'end-turn' };

export type GameEvent =
  | { type: 'selection-changed'; cell: WorldCell | null }
  | { type: 'turn-changed'; turn: number };

export type GameListener = (event: GameEvent) => void;

export class Game {
  readonly world: World;
  /** Seeded from the world, so a replay of the same commands is identical. */
  readonly rng: Rng;
  turn = 1;
  selected: WorldCell | null = null;

  private readonly listeners = new Set<GameListener>();

  constructor(world: World) {
    this.world = world;
    this.rng = mulberry32(hashString(`${world.params.seed}:game`));
  }

  subscribe(listener: GameListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispatch(command: GameCommand): void {
    switch (command.type) {
      case 'select': {
        const cell = this.world.cellAt(command.col, command.row) ?? null;
        if (cell === this.selected) return;
        this.selected = cell;
        this.emit({ type: 'selection-changed', cell });
        return;
      }
      case 'clear-selection': {
        if (!this.selected) return;
        this.selected = null;
        this.emit({ type: 'selection-changed', cell: null });
        return;
      }
      case 'end-turn': {
        this.turn++;
        this.emit({ type: 'turn-changed', turn: this.turn });
        return;
      }
    }
  }

  /**
   * Simulation step. Empty on purpose: the loop that will drive it exists and
   * is wired, so adding rules never means rewiring the frame.
   */
  update(_seconds: number): void {}

  private emit(event: GameEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
