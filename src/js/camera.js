/**
 * Camera and projection for Solar Atlas.
 *
 * An orthographic, tilted view of the ecliptic plane. All coordinates entering
 * this module are "display coordinates" (AU in Orbits mode, logarithmically
 * compressed AU in Atlas mode). The camera never knows about bodies, only
 * vectors, which keeps the renderer easy to reason about.
 */

export const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

export function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function shortestAngle(from, to) {
  let delta = (to - from) % TAU;
  if (delta > Math.PI) delta -= TAU;
  if (delta < -Math.PI) delta += TAU;
  return delta;
}

export function createCamera(overrides = {}) {
  return {
    // A gentle three-quarter view: enough tilt to read inclined orbits,
    // enough obliquity to feel like a physical orrery.
    yaw: overrides.yaw ?? -26 * DEG,
    elevation: overrides.elevation ?? 58 * DEG,
    scale: overrides.scale ?? 60,
    panX: overrides.panX ?? 0,
    panY: overrides.panY ?? 0,
  };
}

export function cloneCamera(camera) {
  return {
    yaw: camera.yaw,
    elevation: camera.elevation,
    scale: camera.scale,
    panX: camera.panX,
    panY: camera.panY,
  };
}

/** Orthographic projection. Returns CSS-pixel coordinates plus a depth key. */
export function projectPoint(point, camera, viewport) {
  const x = point[0] || 0;
  const y = point[1] || 0;
  const z = point[2] || 0;

  const cosYaw = Math.cos(camera.yaw);
  const sinYaw = Math.sin(camera.yaw);
  const u = x * cosYaw - y * sinYaw;
  const w = x * sinYaw + y * cosYaw;

  const sinEl = Math.sin(camera.elevation);
  const cosEl = Math.cos(camera.elevation);
  const up = w * sinEl + z * cosEl;

  return {
    x: viewport.width * 0.5 + camera.panX + u * camera.scale,
    y: viewport.height * 0.5 + camera.panY - up * camera.scale,
    depth: w * cosEl - z * sinEl,
  };
}

/** Unscaled screen offsets relative to the canvas centre (for fitting/labels). */
export function planarCoords(point, camera) {
  const x = point[0] || 0;
  const y = point[1] || 0;
  const z = point[2] || 0;

  const cosYaw = Math.cos(camera.yaw);
  const sinYaw = Math.sin(camera.yaw);
  const u = x * cosYaw - y * sinYaw;
  const w = x * sinYaw + y * cosYaw;
  const sinEl = Math.sin(camera.elevation);
  const cosEl = Math.cos(camera.elevation);

  return {
    x: u,
    y: -(w * sinEl + z * cosEl),
    depth: w * cosEl - z * sinEl,
  };
}

export function panBy(camera, dx, dy) {
  camera.panX += dx;
  camera.panY += dy;
  return camera;
}

/**
 * Zoom keeping the world point under (anchorX, anchorY) pinned to the cursor.
 * Mutates and returns the camera so gesture handlers stay terse.
 */
export function zoomAt(camera, factor, anchorX, anchorY, viewport, limits = {}) {
  const minScale = limits.minScale ?? 0.05;
  const maxScale = limits.maxScale ?? 1e7;
  const nextScale = clamp(camera.scale * factor, minScale, maxScale);
  if (!Number.isFinite(nextScale) || nextScale <= 0) return camera;

  const applied = nextScale / camera.scale;
  const centerX = viewport.width * 0.5;
  const centerY = viewport.height * 0.5;
  camera.panX += (anchorX - (centerX + camera.panX)) * (1 - applied);
  camera.panY += (anchorY - (centerY + camera.panY)) * (1 - applied);
  camera.scale = nextScale;
  return camera;
}

/**
 * Tilt and rotate the view. A vertical drag moves the camera toward the
 * top-down pole; a horizontal drag spins the ecliptic. Mutates camera.
 */
export function rotateBy(camera, dx, dy, limits = {}) {
  const minEl = limits.minElevation ?? 7 * DEG;
  const maxEl = limits.maxElevation ?? 90 * DEG;
  camera.yaw = normalizeAngle(camera.yaw + dx * 0.0055);
  camera.elevation = clamp(camera.elevation - dy * 0.0045, minEl, maxEl);
  return camera;
}

export function normalizeAngle(radians) {
  let value = radians % TAU;
  if (value > Math.PI) value -= TAU;
  if (value < -Math.PI) value += TAU;
  return value;
}

export function getInsetArea(viewport, insets = {}) {
  const left = Math.max(0, insets.left ?? 0);
  const top = Math.max(0, insets.top ?? 0);
  const right = Math.max(left + 1, viewport.width - (insets.right ?? 0));
  const bottom = Math.max(top + 1, viewport.height - (insets.bottom ?? 0));
  return {
    left,
    top,
    right,
    bottom,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
    centerX: (left + right) * 0.5,
    centerY: (top + bottom) * 0.5,
  };
}

/**
 * Fit a set of display-space points into the usable area between the UI.
 * Keeps the camera's orientation and changes only scale + pan.
 */
export function fitCamera(camera, points, viewport, insets = {}, options = {}) {
  const area = getInsetArea(viewport, insets);
  const pad = options.padding ?? 34;
  const minScale = options.minScale ?? 0.02;
  const maxScale = options.maxScale ?? 1e7;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let count = 0;

  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    if (!point || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) continue;
    const p = planarCoords(point, camera);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
    count += 1;
  }

  if (!count) return cloneCamera(camera);

  const centered = options.centered !== false;
  let width;
  let height;
  let midX;
  let midY;

  if (centered) {
    // Keep the center of the orrery pinned to the middle of the usable stage.
    // Extents are mirrored about the origin so a sweeping one-sided trace can
    // never push the centre body into a corner.
    const halfX = Math.max(Math.abs(minX), Math.abs(maxX), 1e-9);
    const halfY = Math.max(Math.abs(minY), Math.abs(maxY), 1e-9);
    width = halfX * 2;
    height = halfY * 2;
    midX = 0;
    midY = 0;
  } else {
    width = Math.max(maxX - minX, 1e-9);
    height = Math.max(maxY - minY, 1e-9);
    midX = (minX + maxX) * 0.5;
    midY = (minY + maxY) * 0.5;
  }

  const availableW = Math.max(40, area.width - pad * 2);
  const availableH = Math.max(40, area.height - pad * 2);
  const scale = clamp(Math.min(availableW / width, availableH / height), minScale, maxScale);

  return {
    yaw: camera.yaw,
    elevation: camera.elevation,
    scale,
    panX: area.centerX - viewport.width * 0.5 - midX * scale,
    panY: area.centerY - viewport.height * 0.5 - midY * scale,
  };
}

/**
 * Convenience fit for a circle of the given radius in the ecliptic plane.
 * Used for the curated opening view (before every trace is visible).
 */
export function fitCameraToRadius(camera, radius, viewport, insets = {}, options = {}) {
  const points = [];
  const segments = 72;
  for (let i = 0; i < segments; i += 1) {
    const angle = (i / segments) * TAU;
    points.push([Math.cos(angle) * radius, Math.sin(angle) * radius, 0]);
  }
  return fitCamera(camera, points, viewport, insets, options);
}

/** Move the camera so world origin lands at the centre of the usable area. */
export function centerOnArea(camera, viewport, insets = {}) {
  const area = getInsetArea(viewport, insets);
  camera.panX = area.centerX - viewport.width * 0.5;
  camera.panY = area.centerY - viewport.height * 0.5;
  return camera;
}

/** Interpolate camera pose. Angles take the short way around. */
export function interpolateCamera(from, to, t) {
  return {
    yaw: from.yaw + shortestAngle(from.yaw, to.yaw) * t,
    elevation: lerp(from.elevation, to.elevation, t),
    scale: Math.exp(lerp(Math.log(from.scale), Math.log(to.scale), t)),
    panX: lerp(from.panX, to.panX, t),
    panY: lerp(from.panY, to.panY, t),
  };
}

export function setScale(camera, scale, viewport, anchorX, anchorY, limits = {}) {
  const minScale = limits.minScale ?? 0.05;
  const next = clamp(scale, minScale, limits.maxScale ?? 1e7);
  if (!Number.isFinite(next) || next <= 0) return camera;
  const ax = anchorX ?? viewport.width * 0.5;
  const ay = anchorY ?? viewport.height * 0.5;
  return zoomAt(camera, next / camera.scale, ax, ay, viewport, limits);
}
