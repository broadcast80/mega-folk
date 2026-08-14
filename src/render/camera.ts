import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { Scene } from '@babylonjs/core/scene.js';
// Side-effect registration. `scene.createPickingRay` is added to Scene by this
// module, not by the scene itself: without it every call throws "Ray needs to
// be imported before as it contains a side-effect required by your code" —
// once per frame, from inside the render loop.
import '@babylonjs/core/Culling/ray.js';

import type { TerrainSurface, WorldBounds } from '../world/index.js';

export type CameraOptions = {
  bounds: WorldBounds;
  /** Where to look when the game opens, in world space. */
  startX: number;
  startZ: number;
  startRadius: number;
  far: number;
};

export type PointerRay = { x: number; y: number; z: number } | null;

const MIN_RADIUS = 6;
const MIN_BETA = (22 * Math.PI) / 180;
const MAX_BETA = (78 * Math.PI) / 180;
/** Metres per second of panning at the closest zoom, and at the farthest. */
const PAN_NEAR = 6;
const PAN_FAR = 130;
const ROTATE_SPEED = 1.6;
const SMOOTHING = 14;

/**
 * Strategy-game camera: an orbit rig that behaves like a map, not like a model
 * viewer.
 *
 * Babylon's built-in `attachControl` binds the left button to rotation, which
 * an RTS needs for selection, so the whole input map is written here instead:
 *
 *   WASD / arrows  pan, at a speed that scales with zoom
 *   Q / E          rotate around the point being looked at
 *   R / F          pitch
 *   wheel          zoom toward the cursor, not toward the screen centre
 *   right drag     rotate and pitch
 *   middle drag    pan
 *   shift          triples every speed
 *
 * Two things make it feel like a map rather than a turntable. Every value is
 * smoothed toward a target instead of being set directly, so a keystroke reads
 * as acceleration rather than as a jump. And the focus point rides the terrain:
 * its height follows the ground under it, so zooming into a valley and zooming
 * into a summit both end up the same distance above the surface.
 */
export class RtsCamera {
  readonly camera: ArcRotateCamera;

  private readonly pressed = new Set<string>();
  private bounds: WorldBounds;
  private surface: TerrainSurface;
  private readonly canvas: HTMLCanvasElement;

  private desiredAlpha: number;
  private desiredBeta: number;
  private desiredRadius: number;
  private readonly desiredTarget = new Vector3();
  private dragButton = -1;
  private dragX = 0;
  private dragY = 0;
  private readonly disposers: Array<() => void> = [];

  constructor(scene: Scene, canvas: HTMLCanvasElement, surface: TerrainSurface, options: CameraOptions) {
    this.surface = surface;
    this.bounds = options.bounds;
    this.canvas = canvas;

    const groundY = surface.heightAtWorld(options.startX, options.startZ) ?? 0;
    this.desiredAlpha = -Math.PI / 2;
    this.desiredBeta = (58 * Math.PI) / 180;
    this.desiredRadius = options.startRadius;
    this.desiredTarget.set(options.startX, groundY, options.startZ);

    this.camera = new ArcRotateCamera(
      'camera',
      this.desiredAlpha,
      this.desiredBeta,
      this.desiredRadius,
      this.desiredTarget.clone(),
      scene,
    );
    this.camera.fov = (42 * Math.PI) / 180;
    this.camera.minZ = 0.5;
    // Maximum draw distance: no fog and no far-plane clipping inside the world,
    // so the whole map can be held in one frame when zoomed out.
    this.camera.maxZ = options.far;
    this.camera.lowerRadiusLimit = MIN_RADIUS;
    this.camera.upperRadiusLimit = Math.min(options.far * 0.75, Math.max(this.bounds.spanX, this.bounds.spanZ));
    // Nothing is attached: every input below is explicit.

    this.bind();
  }

  get maxRadius(): number { return this.camera.upperRadiusLimit ?? 600; }

  /** Advances the smoothing and applies input. `seconds` is the frame delta. */
  update(seconds: number): void {
    const dt = Math.min(seconds, 0.1);
    this.applyKeys(dt);

    // Exponential smoothing: frame-rate independent, and it never overshoots.
    const blend = 1 - Math.exp(-SMOOTHING * dt);
    const camera = this.camera;
    camera.alpha += shortestAngle(camera.alpha, this.desiredAlpha) * blend;
    camera.beta += (this.desiredBeta - camera.beta) * blend;
    camera.radius += (this.desiredRadius - camera.radius) * blend;

    // The focus point rides the ground: the desired y is whatever the terrain
    // is at the desired x/z, so the camera keeps its height above the surface
    // instead of burrowing into a hillside.
    const ground = this.surface.heightAtWorld(this.desiredTarget.x, this.desiredTarget.z);
    if (ground !== undefined) this.desiredTarget.y = ground;

    // `camera.target` is mutated in place on purpose: assigning a new vector
    // makes ArcRotateCamera hold that reference, and a shared scratch vector
    // then silently becomes the camera target.
    camera.target.x += (this.desiredTarget.x - camera.target.x) * blend;
    camera.target.y += (this.desiredTarget.y - camera.target.y) * blend;
    camera.target.z += (this.desiredTarget.z - camera.target.z) * blend;
  }

  /** Reads heights and movement limits from a newly generated world. */
  retarget(surface: TerrainSurface): void {
    this.surface = surface;
    this.bounds = surface.bounds;
    this.camera.upperRadiusLimit = Math.min(
      this.camera.maxZ * 0.75,
      Math.max(this.bounds.spanX, this.bounds.spanZ),
    );
    this.desiredRadius = clamp(this.desiredRadius, MIN_RADIUS, this.maxRadius);
    this.camera.radius = clamp(this.camera.radius, MIN_RADIUS, this.maxRadius);
    this.desiredTarget.x = clamp(this.desiredTarget.x, this.bounds.minX, this.bounds.maxX);
    this.desiredTarget.z = clamp(this.desiredTarget.z, this.bounds.minZ, this.bounds.maxZ);
  }

  /** Moves the focus to a point, without animating through the whole map. */
  jumpTo(x: number, z: number): void {
    this.desiredTarget.x = clamp(x, this.bounds.minX, this.bounds.maxX);
    this.desiredTarget.z = clamp(z, this.bounds.minZ, this.bounds.maxZ);
    const ground = this.surface.heightAtWorld(this.desiredTarget.x, this.desiredTarget.z) ?? 0;
    this.desiredTarget.y = ground;
    this.camera.target.copyFrom(this.desiredTarget);
  }

  /** Ground point under a pointer event, via the height field. */
  groundAt(clientX: number, clientY: number): PointerRay {
    const rect = this.canvas.getBoundingClientRect();
    const ray = this.camera.getScene().createPickingRay(
      clientX - rect.left,
      clientY - rect.top,
      null,
      this.camera,
    );
    const hit = this.surface.raycast(
      ray.origin.x, ray.origin.y, ray.origin.z,
      ray.direction.x, ray.direction.y, ray.direction.z,
      this.camera.maxZ,
    );
    return hit ? { x: hit.x, y: hit.y, z: hit.z } : null;
  }

  dispose(): void {
    for (const off of this.disposers) off();
    this.disposers.length = 0;
  }

  private bind(): void {
    const canvas = this.canvas;
    const listen = <K extends keyof WindowEventMap>(
      target: Window | HTMLCanvasElement,
      type: K,
      handler: (event: WindowEventMap[K]) => void,
      options?: AddEventListenerOptions,
    ): void => {
      target.addEventListener(type, handler as EventListener, options);
      this.disposers.push(() => target.removeEventListener(type, handler as EventListener, options));
    };

    listen(window, 'keydown', (event) => {
      if (!isCameraKey(event.code)) return;
      this.pressed.add(event.code);
      // Arrow keys scroll the page otherwise, which drags the canvas out of view.
      event.preventDefault();
    });
    listen(window, 'keyup', (event) => this.pressed.delete(event.code));
    // A held key would otherwise stay stuck the moment the tab loses focus.
    listen(window, 'blur', () => this.pressed.clear());

    listen(canvas, 'pointerdown', (event) => {
      if (event.button !== 1 && event.button !== 2) return;
      this.dragButton = event.button;
      this.dragX = event.clientX;
      this.dragY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    listen(canvas, 'pointermove', (event) => {
      if (this.dragButton < 0) return;
      const dx = event.clientX - this.dragX;
      const dy = event.clientY - this.dragY;
      this.dragX = event.clientX;
      this.dragY = event.clientY;
      if (this.dragButton === 2) {
        // Dragging right turns the view right, the way a head turns — not the
        // way a turntable spins under a fixed camera.
        this.desiredAlpha += dx * 0.005;
        this.desiredBeta = clamp(this.desiredBeta - dy * 0.005, MIN_BETA, MAX_BETA);
      } else {
        // Drag-panning moves the ground with the cursor, so the scale depends
        // on how much world one pixel currently covers — and the direction is
        // read in the camera's own frame, or the map slides off along a world
        // axis the moment the view is rotated.
        const perPixel = this.camera.radius * 0.0022;
        this.panLocal(-dx * perPixel, dy * perPixel);
      }
    });
    const endDrag = (event: PointerEvent): void => {
      if (this.dragButton < 0) return;
      this.dragButton = -1;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    };
    listen(canvas, 'pointerup', endDrag);
    listen(canvas, 'pointercancel', endDrag);
    listen(canvas, 'contextmenu', (event) => event.preventDefault());

    listen(canvas, 'wheel', (event) => {
      event.preventDefault();
      // Multiplicative, so one notch covers the same *fraction* of the distance
      // at every zoom level: linear steps crawl when far out and jump when close.
      const factor = Math.exp(Math.sign(event.deltaY) * 0.18);
      const previous = this.desiredRadius;
      this.desiredRadius = clamp(previous * factor, MIN_RADIUS, this.maxRadius);

      // Zoom toward the cursor: the ground point under the pointer keeps its
      // place on screen, which is what makes a map feel like it is being pulled
      // in rather than scaled.
      const ground = this.groundAt(event.clientX, event.clientY);
      if (!ground) return;
      const ratio = this.desiredRadius / previous;
      this.setTarget(
        ground.x + (this.desiredTarget.x - ground.x) * ratio,
        ground.z + (this.desiredTarget.z - ground.z) * ratio,
      );
    }, { passive: false });
  }

  private applyKeys(dt: number): void {
    if (this.pressed.size === 0) return;
    const boost = this.pressed.has('ShiftLeft') || this.pressed.has('ShiftRight') ? 3 : 1;
    // Pan speed is interpolated across the zoom range, not taken from the
    // radius directly: a linear tie makes the map crawl up close and bolt when
    // pulled back.
    const zoom = (this.camera.radius - MIN_RADIUS) / Math.max(1, this.maxRadius - MIN_RADIUS);
    const speed = (PAN_NEAR + (PAN_FAR - PAN_NEAR) * zoom) * boost * dt;

    let right = 0;
    let forward = 0;
    if (this.pressed.has('KeyW') || this.pressed.has('ArrowUp')) forward += 1;
    if (this.pressed.has('KeyS') || this.pressed.has('ArrowDown')) forward -= 1;
    if (this.pressed.has('KeyD') || this.pressed.has('ArrowRight')) right += 1;
    if (this.pressed.has('KeyA') || this.pressed.has('ArrowLeft')) right -= 1;
    if (right || forward) {
      // Diagonals must not be faster than the axes they are made of.
      const step = Math.hypot(right, forward);
      this.panLocal((right / step) * speed, (forward / step) * speed);
    }

    if (this.pressed.has('KeyQ')) this.desiredAlpha -= ROTATE_SPEED * dt * boost;
    if (this.pressed.has('KeyE')) this.desiredAlpha += ROTATE_SPEED * dt * boost;
    if (this.pressed.has('KeyR')) this.desiredBeta = clamp(this.desiredBeta - dt * boost, MIN_BETA, MAX_BETA);
    if (this.pressed.has('KeyF')) this.desiredBeta = clamp(this.desiredBeta + dt * boost, MIN_BETA, MAX_BETA);
  }

  /**
   * Moves the focus in the camera's own frame: `right` and `forward` are what
   * those words mean on screen, whatever direction the camera happens to face.
   *
   * Both the keys and the drag come through here, so "forward" cannot mean one
   * thing for W and another for the middle mouse button — which is exactly what
   * happens when one of them quietly moves along the world axes instead.
   */
  private panLocal(right: number, forward: number): void {
    const camera = this.camera;
    let forwardX = camera.target.x - camera.position.x;
    let forwardZ = camera.target.z - camera.position.z;
    const length = Math.hypot(forwardX, forwardZ);
    // Looking straight down leaves no heading on the ground plane; north is as
    // good an answer as any, and beta is clamped well before this matters.
    if (length < 1e-5) { forwardX = 0; forwardZ = 1; } else { forwardX /= length; forwardZ /= length; }
    const rightX = -forwardZ;
    const rightZ = forwardX;

    this.setTarget(
      this.desiredTarget.x + forwardX * forward + rightX * right,
      this.desiredTarget.z + forwardZ * forward + rightZ * right,
    );
  }

  /** The focus point never leaves the map, so the world cannot be lost. */
  private setTarget(x: number, z: number): void {
    this.desiredTarget.x = clamp(x, this.bounds.minX, this.bounds.maxX);
    this.desiredTarget.z = clamp(z, this.bounds.minZ, this.bounds.maxZ);
  }
}

function isCameraKey(code: string): boolean {
  return code === 'KeyW' || code === 'KeyA' || code === 'KeyS' || code === 'KeyD'
    || code === 'KeyQ' || code === 'KeyE' || code === 'KeyR' || code === 'KeyF'
    || code === 'ArrowUp' || code === 'ArrowDown' || code === 'ArrowLeft' || code === 'ArrowRight'
    || code === 'ShiftLeft' || code === 'ShiftRight';
}

/** Signed difference to an angle, taking the short way round. */
function shortestAngle(from: number, to: number): number {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}
