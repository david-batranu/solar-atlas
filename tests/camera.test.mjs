import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEG,
  clamp,
  createCamera,
  projectPoint,
  planarCoords,
  panBy,
  zoomAt,
  rotateBy,
  fitCamera,
  fitCameraToRadius,
  getInsetArea,
  centerOnArea,
  interpolateCamera,
  easeInOutCubic,
  shortestAngle,
} from '../src/js/camera.js';

const close = (actual, expected, epsilon = 1e-8, message = '') => {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    message || `expected ${actual} to be within ${epsilon} of ${expected}`,
  );
};

const viewport = { width: 1000, height: 700 };

test('projectPoint: top-down view maps ecliptic x right and y up', () => {
  const camera = createCamera({ yaw: 0, elevation: 90 * DEG, scale: 10, panX: 0, panY: 0 });
  const point = [1, 2, 3];
  const projected = projectPoint(point, camera, viewport);
  close(projected.x, 500 + 10);
  close(projected.y, 350 - 20);
  close(projected.depth, -3);
});

test('projectPoint: edge-on view maps positive z upward and collapses the plane', () => {
  const camera = createCamera({ yaw: 0, elevation: 0, scale: 10 });
  const projected = projectPoint([2, 5, 1], camera, viewport);
  close(projected.x, 520);
  close(projected.y, 340);
  close(projected.depth, 5);
});

test('planarCoords matches projection offsets', () => {
  const camera = createCamera({ yaw: 18 * DEG, elevation: 66 * DEG, scale: 32, panX: 12, panY: -8 });
  const point = [0.4, -0.7, 0.13];
  const p = projectPoint(point, camera, viewport);
  const planar = planarCoords(point, camera);
  close(p.x, viewport.width / 2 + camera.panX + planar.x * camera.scale);
  close(p.y, viewport.height / 2 + camera.panY + planar.y * camera.scale);
});

test('zoomAt preserves the world point under the cursor', () => {
  const camera = createCamera({ yaw: -0.3, elevation: 1.1, scale: 44, panX: 31, panY: -17 });
  const anchorWorld = [0.6, -0.25, 0.08];
  const before = projectPoint(anchorWorld, camera, viewport);
  zoomAt(camera, 1.8, before.x, before.y, viewport, { minScale: 1, maxScale: 10000 });
  close(camera.scale, 44 * 1.8);
  const after = projectPoint(anchorWorld, camera, viewport);
  close(after.x, before.x, 1e-6);
  close(after.y, before.y, 1e-6);
});

test('zoomAt respects scale bounds', () => {
  const camera = createCamera({ scale: 10 });
  zoomAt(camera, 0.001, 0, 0, viewport, { minScale: 5, maxScale: 20 });
  close(camera.scale, 5);
  zoomAt(camera, 1000, 0, 0, viewport, { minScale: 5, maxScale: 20 });
  close(camera.scale, 20);
});

test('panBy translates the camera without changing orientation', () => {
  const camera = createCamera({ yaw: 0.2, elevation: 0.9, scale: 12, panX: 2, panY: 3 });
  panBy(camera, -10, 7);
  close(camera.panX, -8);
  close(camera.panY, 10);
  close(camera.scale, 12);
});

test('rotateBy clamps elevation and wraps yaw', () => {
  const camera = createCamera({ yaw: 0, elevation: 1 });
  rotateBy(camera, 0, 1000, { minElevation: 0.2, maxElevation: 1.4 });
  close(camera.elevation, 0.2);
  rotateBy(camera, 0, -1000, { minElevation: 0.2, maxElevation: 1.4 });
  close(camera.elevation, 1.4);
  rotateBy(camera, Math.PI / 0.0055, 0);
  assert.ok(camera.yaw >= -Math.PI && camera.yaw <= Math.PI);
});

test('fitCamera keeps the origin at the centre of the usable stage', () => {
  const camera = createCamera({ yaw: 0, elevation: 90 * DEG, scale: 10 });
  const insets = { left: 120, right: 80, top: 60, bottom: 100 };
  const points = [[-12, 0, 0], [35, 0, 0], [0, -8, 0], [4, 16, 0]];
  const fitted = fitCamera(camera, points, viewport, insets, { padding: 20 });
  const area = getInsetArea(viewport, insets);
  const origin = projectPoint([0, 0, 0], fitted, viewport);
  close(origin.x, area.centerX, 1e-6);
  close(origin.y, area.centerY, 1e-6);

  // The symmetric fit must contain every supplied point.
  for (const point of points) {
    const p = projectPoint(point, fitted, viewport);
    assert.ok(p.x >= area.left && p.x <= area.right + 1e-6);
    assert.ok(p.y >= area.top && p.y <= area.bottom + 1e-6);
  }
});

test('fitCameraToRadius frames a measured radius', () => {
  const camera = createCamera({ yaw: 0, elevation: 90 * DEG, scale: 1 });
  const fitted = fitCameraToRadius(camera, 5, viewport, {}, { padding: 30, maxScale: 10000 });
  const projected = projectPoint([5, 0, 0], fitted, viewport);
  assert.ok(projected.x < viewport.width);
  assert.ok(projected.x > viewport.width / 2);
  assert.ok(fitted.scale > 0);
});

test('getInsetArea and centerOnArea agree', () => {
  const insets = { left: 100, right: 50, top: 30, bottom: 120 };
  const camera = createCamera();
  centerOnArea(camera, viewport, insets);
  const area = getInsetArea(viewport, insets);
  const origin = projectPoint([0, 0, 0], camera, viewport);
  close(origin.x, area.centerX);
  close(origin.y, area.centerY);
});

test('interpolateCamera interpolates pose and camera scale logarithmically', () => {
  const from = createCamera({ yaw: 0.2, elevation: 0.4, scale: 10, panX: 5, panY: 7 });
  const to = createCamera({ yaw: -0.3, elevation: 1.2, scale: 40, panX: -5, panY: -3 });
  const mid = interpolateCamera(from, to, 0.5);
  close(mid.scale, Math.sqrt(10 * 40), 1e-6);
  close(mid.panX, 0);
  close(mid.panY, 2);
  assert.ok(mid.elevation > from.elevation && mid.elevation < to.elevation);
});

test('misc math helpers behave', () => {
  close(easeInOutCubic(0), 0);
  close(easeInOutCubic(0.5), 0.5);
  close(easeInOutCubic(1), 1);
  close(shortestAngle(-Math.PI + 0.1, Math.PI - 0.1), -0.2);
  close(clamp(-5, 0, 10), 0);
  close(clamp(42, 0, 10), 10);
});
