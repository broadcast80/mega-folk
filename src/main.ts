import './styles.css';

import { bootstrap } from './app/bootstrap.js';
import { readConfig } from './config.js';

/**
 * Entry point. Its only jobs are to find the DOM, read the config and put a
 * readable error on screen when startup fails — every decision worth reading is
 * one level down, in `app/bootstrap.ts`.
 */

const canvas = document.querySelector<HTMLCanvasElement>('[data-canvas]');
const notice = document.querySelector<HTMLElement>('[data-notice]');
const performancePanel = document.querySelector<HTMLElement>('[data-performance]');
const inspector = document.querySelector<HTMLElement>('[data-inspector]');
const newWorld = document.querySelector<HTMLButtonElement>('[data-new-world]');

if (!canvas || !notice || !performancePanel || !inspector || !newWorld) {
  throw new Error('Разметка страницы не содержит canvas, панелей HUD или кнопки нового мира.');
}

const config = readConfig();

bootstrap({ canvas, notice, performance: performancePanel, inspector, newWorld }, config)
  .then((handle) => {
    // One handle in the console is worth a dozen debug panels: the world, the
    // game state and the camera are all reachable from it.
    (window as unknown as { __NEO_WAR__: unknown }).__NEO_WAR__ = handle;
  })
  .catch((error: unknown) => {
    notice.textContent = error instanceof Error ? error.message : String(error);
    notice.classList.add('is-error');
    notice.classList.remove('is-done');
    console.error(error);
  });
