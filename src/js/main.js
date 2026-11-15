/**
 * Solar Atlas — application entry point.
 *
 * Owns the simulation clock, camera, interaction model and the UI contract.
 * Orbital mathematics lives in ephemeris.js; center-relative trail geometry
 * lives in orbits.js; pixels live in renderer.js.
 */

import { BODIES, BY_ID, AU_KM } from './data.js';
import * as astronomy from './ephemeris.js';
import { buildCompleteOrbitTraces, buildTraces, displayPosition } from './orbits.js';
import { createRenderer } from './renderer.js';
import { createUI, DEFAULT_SPEED, SPEED_PRESETS } from './ui.js';
import {
  createCamera,
  cloneCamera,
  fitCamera,
  fitCameraToRadius,
  getInsetArea,
  zoomAt,
  panBy,
  rotateBy,
  interpolateCamera,
  easeInOutCubic,
  centerOnArea,
  clamp,
  DEG,
} from './camera.js';

/* ------------------------------------------------------------------ config */

const DEFAULT_CENTER = 'sun';
const DEFAULT_MODE = 'realistic';
const DEFAULT_TRAIL = 'fading';
const INITIAL_FIT_RADIUS_AU = 6.35;
const REALISTIC_YAW = -26 * DEG;
const REALISTIC_ELEVATION = 60 * DEG;
const ATLAS_YAW = 0;
const ATLAS_ELEVATION = 90 * DEG;
const TRACE_SAMPLES = 520;
const COMPLETE_TRACE_SAMPLES = 560;
const MAX_TRACE_SAMPLES = 3200;
const HISTORY_MODES = ['relative', 'fixed'];
const RELATIVE_HISTORY_MIN = 0.5;
const RELATIVE_HISTORY_MAX = 50;
const RELATIVE_HISTORY_STEP = 0.5;
const MAX_FIXED_YEARS = 300;
const MAX_HISTORY_CYCLES = 12;
const SAMPLES_PER_HISTORY_CYCLE = 72;
const MAX_FIXED_TRACE_SAMPLES = 1024;
const DAYS_PER_YEAR = 365.25;
const MODES = ['realistic', 'overview', 'atlas'];
// Keep shared links from the short-lived "Elliptic" label working.
const MODE_ALIASES = { elliptic: 'overview' };

function normalizeMode(mode) {
  return MODE_ALIASES[mode] ?? mode;
}
const TRACE_REBUILD_MS = 150;
const MAX_SCALE = 180000;
const MIN_SCALE_FLOOR = 0.04;
const REDUCED_MOTION = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
const TIME_BOUNDS = {
  minJd: astronomy.julianDateFromUnixMs(Date.UTC(1600, 0, 1)),
  maxJd: astronomy.julianDateFromUnixMs(Date.UTC(2400, 0, 1)),
};
const PRIMARY_RANGE = { startYear: 1800, endYear: 2050 };

/* ------------------------------------------------------------------ state */

const nowMs = Date.now();
const state = {
  centerId: DEFAULT_CENTER,
  mode: DEFAULT_MODE,
  trailStyle: DEFAULT_TRAIL,
  trailSpan: 1,
  historyMode: 'relative',
  historyYears: 10,
  labels: true,
  playing: true,
  direction: 1,
  speedDaysPerSec: DEFAULT_SPEED,
  jd: clamp(astronomy.julianDateFromUnixMs(nowMs), TIME_BOUNDS.minJd, TIME_BOUNDS.maxJd),
  hiddenBodies: new Set(),
  hoveredId: null,
};

readInitialUrlState();
if (!Object.hasOwn(BY_ID, state.centerId)) state.centerId = DEFAULT_CENTER;
// The center is always visible; ignore a hidden list that names it.
state.hiddenBodies.delete(state.centerId);

const canvas = document.getElementById('scene');
const renderer = createRenderer(canvas);
renderer.resize();

let viewport = renderer.getViewport();
let lastStageArea = null;
let chromeRects = [];
let camera = createCamera({
  yaw: REALISTIC_YAW,
  elevation: REALISTIC_ELEVATION,
  scale: 60,
});
centerOnArea(camera, viewport, getSafeInsets());

const atlas = {
  blend: state.mode === 'atlas' ? 1 : 0,
  tween: null,
};
let cameraTween = null;
let savedRealisticCamera = null;
let currentPositions = null;
let orbitHover = null;
let traces = null;
let tracesJd = Number.NaN;
let tracesBuiltAt = 0;
let fitAllScale = 20;
let scaleLimits = { minScale: 0.5, maxScale: MAX_SCALE };
let hasRendered = false;
let overlayDismissed = false;
let lastFrameMs = performance.now();
let lastDatePaint = 0;
let boundToastShown = false;
let errorToastShown = false;
let ui = null;
let pointers = new Map();
let gesture = null;
let suppressTap = false;

const actions = {
  setCenter: (id) => setCenter(id),
  setMode: (mode) => setMode(mode),
  setTrailStyle: (style) => setTrailStyle(style),
  setTrailSpan: (span) => setTrailSpan(span),
  setHistoryMode: (mode) => setHistoryMode(mode),
  setHistoryYears: (years) => setHistoryYears(years),
  setLabels: (labels) => setLabels(labels),
  setVisibility: (id, visible) => setVisibility(id, visible),
  setAllVisible: (visible) => setAllVisible(visible),
  togglePlay: () => togglePlay(),
  toggleReverse: () => toggleReverse(),
  setSpeed: (days) => setSpeed(days),
  setNow: () => setNow(),
  fitView: () => fitView(),
  resetView: () => resetView(),
  zoomIn: () => zoomBy(1.4),
  zoomOut: () => zoomBy(1 / 1.4),
};

ui = createUI({ actions });

/* ------------------------------------------------------------- URL helpers */

function normalizeTrailSpan(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < RELATIVE_HISTORY_MIN || value > RELATIVE_HISTORY_MAX) return null;
  return Math.round(value / RELATIVE_HISTORY_STEP) * RELATIVE_HISTORY_STEP;
}

function readInitialUrlState() {
  let params;
  try {
    params = new URLSearchParams(window.location.search);
  } catch {
    return;
  }

  const centerId = params.get('center');
  if (centerId && Object.hasOwn(BY_ID, centerId)) state.centerId = centerId;

  const mode = normalizeMode(params.get('mode'));
  if (MODES.includes(mode)) state.mode = mode;

  const trail = params.get('trail');
  if (trail === 'solid' || trail === 'fading' || trail === 'always') state.trailStyle = trail;

  const span = normalizeTrailSpan(Number(params.get('span')));
  if (span !== null) state.trailSpan = span;

  const history = params.get('history');
  if (history === 'fixed') state.historyMode = 'fixed';
  else if (history === 'relative') state.historyMode = 'relative';

  const years = Number(params.get('years'));
  if (Number.isInteger(years) && years >= 1 && years <= MAX_FIXED_YEARS) {
    state.historyYears = years;
  }

  const hide = params.get('hide');
  if (hide) {
    for (const id of hide.split(',')) {
      if (Object.hasOwn(BY_ID, id) && id !== state.centerId) state.hiddenBodies.add(id);
    }
  }

  if (params.has('labels')) state.labels = params.get('labels') !== '0';
  if (params.get('paused') === '1' || params.get('paused') === 'true') state.playing = false;

  const speed = Number(params.get('speed'));
  if (Number.isFinite(speed) && speed !== 0) {
    state.direction = speed < 0 ? -1 : 1;
    state.speedDaysPerSec = clamp(Math.abs(speed), 0.020833333, 365.25);
  }

  if (params.has('date')) {
    const parsed = Date.parse(params.get('date'));
    if (Number.isFinite(parsed)) {
      state.jd = clamp(
        astronomy.julianDateFromUnixMs(parsed),
        TIME_BOUNDS.minJd,
        TIME_BOUNDS.maxJd,
      );
    }
  } else if (params.has('jd')) {
    const jd = Number(params.get('jd'));
    if (Number.isFinite(jd)) state.jd = clamp(jd, TIME_BOUNDS.minJd, TIME_BOUNDS.maxJd);
  }
}

function writeUrlState() {
  if (window.location.protocol === 'file:') return;
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('center', state.centerId);
    url.searchParams.set('mode', state.mode);
    url.searchParams.set('trail', state.trailStyle);
    url.searchParams.set('labels', state.labels ? '1' : '0');
    if (state.historyMode === 'fixed') {
      url.searchParams.set('history', 'fixed');
      url.searchParams.set('years', String(state.historyYears));
      url.searchParams.delete('span');
    } else {
      url.searchParams.delete('history');
      url.searchParams.delete('years');
      if (state.trailSpan !== 1) url.searchParams.set('span', String(state.trailSpan));
      else url.searchParams.delete('span');
    }
    const hidden = BODIES
      .filter((body) => body.id !== state.centerId && state.hiddenBodies.has(body.id))
      .map((body) => body.id);
    if (hidden.length) url.searchParams.set('hide', hidden.join(','));
    else url.searchParams.delete('hide');
    window.history.replaceState(null, '', url);
  } catch {
    /* URLs are a convenience; never let them break the orrery. */
  }
}

/* --------------------------------------------------------------- formatting */

function formatHoverDistance(au) {
  if (!Number.isFinite(au)) return '—';
  if (au < 0.01) {
    return `${Math.round(au * AU_KM).toLocaleString('en-US')} km`;
  }
  if (au < 1) return `${au.toFixed(3)} AU`;
  return `${au.toFixed(2)} AU`;
}

function isPrimaryEra(jd) {
  if (typeof astronomy.isPrimaryEra === 'function') return astronomy.isPrimaryEra(jd);
  const year = astronomy.dateFromJulianDate(jd).getUTCFullYear();
  return year >= PRIMARY_RANGE.startYear && year <= PRIMARY_RANGE.endYear;
}

/* ---------------------------------------------------------------- viewport */

function getSafeInsets() {
  const w = viewport.width;
  const h = viewport.height;
  const mobile = w <= 760;

  const controls = document.getElementById('controls');
  const timebar = document.querySelector('.timebar');
  const viewControls = document.querySelector('.view-controls');
  const masthead = document.querySelector('.masthead');
  const ctrlRect = controls?.getBoundingClientRect();
  const timeRect = timebar?.getBoundingClientRect();
  const viewRect = viewControls?.getBoundingClientRect();
  const mastRect = masthead?.getBoundingClientRect();

  if (mobile) {
    // The mobile controls card is part of the stage: the map begins beneath it
    // rather than hiding behind it. The CSS keeps this card compact.
    const controlsBottom = ctrlRect && ctrlRect.height > 20 ? ctrlRect.bottom : h * 0.24;
    const timeTop = timeRect && timeRect.height > 20 ? timeRect.top : h - 170;
    let top = clamp(Math.round(controlsBottom + 14), 150, Math.round(h * 0.52));
    let bottom = clamp(Math.round(h - timeTop + 24), 145, Math.round(h * 0.34));
    // On very short screens the map gets small, but it never hides behind the
    // controls; partial content is preferable to mis-registered framing.
    return { left: 16, right: 18, top, bottom };
  }

  let left = Math.round(w * 0.28);
  let right = 88;
  let top = 100;
  let bottom = 170;

  if (ctrlRect && ctrlRect.width > 40 && ctrlRect.height > 40) {
    left = Math.round(Math.min(ctrlRect.right + 26, w * 0.5));
  }
  if (timeRect && timeRect.height > 20) {
    bottom = Math.round(Math.max(120, h - timeRect.top + 30));
  }
  if (viewRect && viewRect.height > 20) {
    right = Math.round(Math.max(70, w - viewRect.left + 26));
  }
  if (mastRect && mastRect.height > 20) {
    top = Math.round(mastRect.bottom + 30);
  }

  // Never squeeze the orrery out of its own stage.
  left = clamp(left, 30, w * 0.44);
  right = clamp(right, 44, w * 0.26);
  top = clamp(top, 70, h * 0.3);
  bottom = clamp(bottom, 110, h * 0.32);
  if (w - left - right < 300) right = 44;
  if (h - top - bottom < 260) {
    top = Math.max(70, top - 30);
    bottom = Math.max(110, bottom - 20);
  }

  return { left, right, top, bottom };
}

function collectChromeRects() {
  const selectors = ['.masthead__brand', '.masthead__actions', '.controls', '.timebar', '.view-controls', '.canvas-hint'];
  const rects = [];
  for (const selector of selectors) {
    const element = document.querySelector(selector);
    if (!element) continue;
    const r = element.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    rects.push({
      x: r.left - 5,
      y: r.top - 5,
      w: r.width + 10,
      h: r.height + 10,
    });
  }
  return rects;
}

/* ---------------------------------------------------------------- astronomy */

function positionsNow() {
  if (!currentPositions) currentPositions = astronomy.getPositions(state.jd);
  return currentPositions;
}

function relativeToCenter(positions, bodyId) {
  const center = positions[state.centerId] || [0, 0, 0];
  const body = positions[bodyId];
  if (!body) return null;
  return [
    body[0] - center[0],
    body[1] - center[1],
    body[2] - center[2],
  ];
}

function isBodyVisible(bodyId) {
  return bodyId === state.centerId || !state.hiddenBodies.has(bodyId);
}

function visibleBodyCount() {
  let count = 0;
  for (const body of BODIES) {
    if (isBodyVisible(body.id)) count += 1;
  }
  return count;
}

function collectFitPoints(blend) {
  const positions = positionsNow();
  const points = [[0, 0, 0]];

  for (const body of BODIES) {
    if (!isBodyVisible(body.id)) continue;
    const rel = relativeToCenter(positions, body.id);
    if (!rel) continue;
    points.push(displayPosition(rel, blend));
  }

  if (Array.isArray(traces)) {
    for (const trace of traces) {
      if (!trace || !Array.isArray(trace.points) || !isBodyVisible(trace.bodyId)) continue;
      for (const point of trace.points) {
        points.push(displayPosition(point, blend));
      }
    }
  }

  return points.filter((p) => p.every(Number.isFinite));
}

/* ------------------------------------------------------------------ camera */

function cancelCameraTween() {
  cameraTween = null;
}

function applyCamera(goal) {
  camera = {
    yaw: goal.yaw,
    elevation: goal.elevation,
    scale: clamp(goal.scale, scaleLimits.minScale, scaleLimits.maxScale),
    panX: goal.panX,
    panY: goal.panY,
  };
}

function animateCameraTo(goal, duration = 780) {
  cancelCameraTween();
  if (!goal || !Number.isFinite(goal.scale) || goal.scale <= 0) return;
  if (REDUCED_MOTION) {
    applyCamera(goal);
    return;
  }
  cameraTween = {
    from: cloneCamera(camera),
    to: {
      yaw: goal.yaw,
      elevation: goal.elevation,
      scale: goal.scale,
      panX: goal.panX,
      panY: goal.panY,
    },
    start: performance.now(),
    duration,
  };
}

function stepCameraTween(now) {
  if (!cameraTween) return;
  const t = clamp((now - cameraTween.start) / cameraTween.duration, 0, 1);
  const eased = easeInOutCubic(t);
  const pose = interpolateCamera(cameraTween.from, cameraTween.to, eased);
  camera = {
    yaw: pose.yaw,
    elevation: pose.elevation,
    scale: clamp(pose.scale, MIN_SCALE_FLOOR, MAX_SCALE),
    panX: pose.panX,
    panY: pose.panY,
  };
  if (t >= 1) cameraTween = null;
}

function startAtlasBlend(target, duration = 880) {
  if (REDUCED_MOTION || duration <= 0) {
    atlas.blend = target;
    atlas.tween = null;
    return;
  }
  if (Math.abs(atlas.blend - target) < 0.0001) {
    atlas.blend = target;
    atlas.tween = null;
    return;
  }
  atlas.tween = {
    from: atlas.blend,
    to: target,
    start: performance.now(),
    duration,
  };
}

function stepAtlasBlend(now) {
  if (!atlas.tween) return;
  const t = clamp((now - atlas.tween.start) / atlas.tween.duration, 0, 1);
  atlas.blend = atlas.tween.from + (atlas.tween.to - atlas.tween.from) * easeInOutCubic(t);
  if (t >= 1) {
    atlas.blend = atlas.tween.to;
    atlas.tween = null;
  }
}

function targetBlendForMode(mode = state.mode) {
  return mode === 'atlas' ? 1 : 0;
}

function recomputeScaleLimits() {
  if (visibleBodyCount() <= 1) return;
  const points = collectFitPoints(targetBlendForMode());
  const topDown = state.mode === 'atlas' || state.mode === 'overview';
  const base = {
    ...camera,
    elevation: topDown ? ATLAS_ELEVATION : camera.elevation,
    yaw: topDown ? ATLAS_YAW : camera.yaw,
  };
  const fit = fitCamera(base, points, viewport, getSafeInsets(), {
    padding: 42,
    minScale: MIN_SCALE_FLOOR,
    maxScale: MAX_SCALE,
  });
  fitAllScale = fit.scale;
  scaleLimits = {
    minScale: Math.max(MIN_SCALE_FLOOR, fit.scale * 0.28),
    maxScale: MAX_SCALE,
  };
}

function atlasFitGoal() {
  const base = createCamera({
    yaw: ATLAS_YAW,
    elevation: ATLAS_ELEVATION,
    scale: Math.max(camera.scale, 30),
    panX: camera.panX,
    panY: camera.panY,
  });
  return fitCamera(base, collectFitPoints(1), viewport, getSafeInsets(), {
    padding: 46,
    minScale: MIN_SCALE_FLOOR,
    maxScale: MAX_SCALE,
  });
}

function realisticFitAllGoal() {
  return fitCamera(camera, collectFitPoints(0), viewport, getSafeInsets(), {
    padding: 44,
    minScale: MIN_SCALE_FLOOR,
    maxScale: MAX_SCALE,
  });
}

function overviewFitAllGoal() {
  const base = createCamera({
    yaw: ATLAS_YAW,
    elevation: ATLAS_ELEVATION,
    scale: Math.max(camera.scale, 30),
    panX: camera.panX,
    panY: camera.panY,
  });
  return fitCamera(base, collectFitPoints(0), viewport, getSafeInsets(), {
    padding: 44,
    minScale: MIN_SCALE_FLOOR,
    maxScale: MAX_SCALE,
  });
}

function defaultRealisticGoal({ defaultTilt = false } = {}) {
  return focusedGoal({ defaultTilt });
}

/**
 * The opening view. Sun-centered: a true-scale neighborhood out to Jupiter.
 * World-centered: a local stage around the selected world that shows the
 * apparent solar revolution and the inner planets, rather than a sparse map
 * stretching to Neptune. "Fit all orbits" still reveals the whole system.
 */
function focusedGoal({ defaultTilt = false, yaw = null, elevation = null } = {}) {
  const radius = focusRadiusForCenter(state.centerId);
  const useDefaultTilt = defaultTilt || state.centerId === 'sun';
  const goalYaw = useDefaultTilt ? REALISTIC_YAW : (Number.isFinite(yaw) ? yaw : camera.yaw);
  const goalElevation = useDefaultTilt
    ? REALISTIC_ELEVATION
    : (Number.isFinite(elevation) ? elevation : camera.elevation);
  const base = createCamera({
    yaw: goalYaw,
    elevation: goalElevation,
    scale: Math.max(fitAllScale, 20),
  });
  return fitCameraToRadius(
    base,
    radius,
    viewport,
    getSafeInsets(),
    { padding: 26, minScale: MIN_SCALE_FLOOR, maxScale: MAX_SCALE },
  );
}

function focusRadiusForCenter(centerId = state.centerId) {
  if (centerId === 'sun') return INITIAL_FIT_RADIUS_AU;
  if (centerId === 'moon') return 0.0048;
  const body = BY_ID[centerId];
  const heliocentricDistance = body?.semiMajorAU;
  if (!Number.isFinite(heliocentricDistance) || heliocentricDistance <= 0) return 2.4;
  return clamp(heliocentricDistance + 1.6, 1.9, 44);
}

function plannedOrientation() {
  if (cameraTween?.to) {
    return { yaw: cameraTween.to.yaw, elevation: cameraTween.to.elevation };
  }
  return { yaw: camera.yaw, elevation: camera.elevation };
}

function goalForCenterChange() {
  if (state.mode === 'atlas') return atlasFitGoal();
  if (state.mode === 'overview') return overviewFitAllGoal();
  const orientation = plannedOrientation();
  return focusedGoal(orientation);
}

function zoomByAt(factor, anchorX, anchorY) {
  cancelCameraTween();
  zoomAt(camera, factor, anchorX, anchorY, viewport, scaleLimits);
  hideHover();
}

function zoomBy(factor) {
  const area = getInsetArea(viewport, getSafeInsets());
  zoomByAt(factor, area.centerX, area.centerY);
}

function fitView() {
  if (visibleBodyCount() <= 1) {
    ui.showToast('Show at least one more world to fit.');
    return;
  }
  hideHover();
  const goal = state.mode === 'atlas'
    ? atlasFitGoal()
    : state.mode === 'overview'
      ? overviewFitAllGoal()
      : realisticFitAllGoal();
  recomputeScaleLimits();
  animateCameraTo(goal, 680);
  writeUrlState();
}

/* ------------------------------------------------------------------- traces */

function rebuildTraces(now = performance.now(), force = false) {
  if (!force && traces && Math.abs(state.jd - tracesJd) < 1e-8) return;
  currentPositions = astronomy.getPositions(state.jd);
  try {
    const completeOrbits = state.trailStyle === 'always';
    const build = completeOrbits ? buildCompleteOrbitTraces : buildTraces;
    const fixedWindowDays = state.historyMode === 'fixed'
      ? state.historyYears * DAYS_PER_YEAR
      : null;
    const fixedHistory = state.historyMode === 'fixed';
    const samples = completeOrbits
      ? COMPLETE_TRACE_SAMPLES
      : fixedHistory
        ? TRACE_SAMPLES
        : Math.min(
          MAX_TRACE_SAMPLES,
          Math.max(TRACE_SAMPLES, Math.round(220 * Math.max(1, state.trailSpan))),
        );
    traces = build({
      jd: state.jd,
      centerId: state.centerId,
      bodies: BODIES,
      getPositions: astronomy.getPositions,
      getPosition: astronomy.getHeliocentricPosition,
      span: state.trailSpan,
      fixedWindowDays,
      maxCycles: fixedHistory ? MAX_HISTORY_CYCLES : null,
      samplesPerCycle: fixedHistory ? SAMPLES_PER_HISTORY_CYCLE : null,
      minSamplesPerTrace: fixedHistory ? TRACE_SAMPLES : null,
      maxSamplesPerTrace: fixedHistory ? MAX_FIXED_TRACE_SAMPLES : null,
      samples,
    });
    tracesJd = state.jd;
    tracesBuiltAt = now;
  } catch (error) {
    console.error('[Solar Atlas] Could not build orbit traces.', error);
    traces = traces || [];
    tracesJd = state.jd;
    tracesBuiltAt = now;
    if (!errorToastShown) {
      errorToastShown = true;
      ui.showToast('Orbit trails could not be computed.');
    }
  }
}

function maybeRebuildTraces(now) {
  if (!traces) {
    rebuildTraces(now, true);
    return;
  }
  if (!state.playing) return;
  const rebuildInterval = state.historyMode === 'fixed'
    ? state.historyYears >= 50
      ? 350
      : state.historyYears >= 10
        ? 250
        : TRACE_REBUILD_MS
    : state.trailSpan >= 20
      ? 350
      : state.trailSpan >= 5
        ? 250
        : TRACE_REBUILD_MS;
  if (now - tracesBuiltAt < rebuildInterval) return;
  if (Math.abs(state.jd - tracesJd) < 1e-7) return;
  rebuildTraces(now, true);
}

/* ------------------------------------------------------------- state actions */

function syncUI() {
  if (!ui) return;
  ui.sync(state);
  chromeRects = collectChromeRects();
}

function hideHover() {
  const hadHover = state.hoveredId !== null || orbitHover !== null;
  state.hoveredId = null;
  orbitHover = null;
  if (hadHover) ui.hideHover();
}

function setCenter(id, options = {}) {
  if (!Object.hasOwn(BY_ID, id)) return;
  if (id === state.centerId) return;

  hideHover();
  state.centerId = id;
  state.hiddenBodies.delete(id);
  savedRealisticCamera = null;
  traces = null;
  tracesJd = Number.NaN;

  const center = BY_ID[id];
  rebuildTraces(performance.now(), true);
  recomputeScaleLimits();

  // When a center change interrupts a mode/camera transition, derive the new
  // goal from the transition's intended orientation, not a mid-tween pose.
  const goal = goalForCenterChange();
  animateCameraTo(goal, options.duration ?? 840);
  syncUI();
  writeUrlState();

  if (!options.silent) {
    const message = `${center.name} is now the center of the view.`;
    ui.showToast(message);
    ui.announce(`${center.centric} view. ${center.name} at the center.`);
  }
}

function setMode(mode) {
  mode = normalizeMode(mode);
  if (!MODES.includes(mode) || mode === state.mode) return;

  hideHover();
  const previous = state.mode;
  const outgoing = cloneCamera(cameraTween ? cameraTween.to : camera);

  // Remember a curated Orbits pose whenever we leave it. Overview and Atlas
  // are both top-down; returning to Orbits should restore the tilted view.
  if (previous === 'realistic') savedRealisticCamera = outgoing;

  state.mode = mode;
  recomputeScaleLimits();

  let goal;
  let duration = 880;

  if (mode === 'atlas') {
    goal = atlasFitGoal();
    duration = 900;
    startAtlasBlend(1, 900);
    ui.announce('Atlas view. Distances are compressed for a top-down map of the whole system.');
  } else if (mode === 'overview') {
    // Frame the whole true-scale system. Unlike Atlas, nothing is radially
    // compressed; the selected line style and History window still apply, so Always
    // reveals the complete ellipses while Fading shows their recent trails.
    goal = overviewFitAllGoal();
    duration = 900;
    startAtlasBlend(0, 900);
    ui.announce('Overview view. True scale, top-down. The selected orbit line style and span still apply.');
  } else {
    goal = savedRealisticCamera || defaultRealisticGoal({ defaultTilt: true });
    savedRealisticCamera = null;
    duration = 860;
    startAtlasBlend(0, 820);
    ui.announce('Orbit view. True distances and inclinations restored.');
  }

  animateCameraTo(goal, duration);
  syncUI();
  writeUrlState();
}

function setTrailStyle(style) {
  if (style !== 'solid' && style !== 'fading' && style !== 'always') return;
  if (style === state.trailStyle) return;
  state.trailStyle = style;
  // Always uses complete closed parent orbits rather than center-relative
  // trails, so the trace geometry itself changes with the style.
  traces = null;
  tracesJd = Number.NaN;
  rebuildTraces(performance.now(), true);
  recomputeScaleLimits();
  syncUI();
  writeUrlState();
}

function setTrailSpan(span) {
  const next = normalizeTrailSpan(Number(span));
  if (next === null || next === state.trailSpan) return;
  state.trailSpan = next;
  if (state.historyMode === 'fixed') {
    // Keep the relative preference for when the user switches back, but do
    // not rebuild fixed-window traces for a value they cannot see.
    syncUI();
    writeUrlState();
    return;
  }
  traces = null;
  tracesJd = Number.NaN;
  rebuildTraces(performance.now(), true);
  recomputeScaleLimits();
  syncUI();
  writeUrlState();
  ui.announce(`Orbit history set to ${next}× the standard span.`);
}

function setHistoryMode(mode) {
  if (!HISTORY_MODES.includes(mode) || mode === state.historyMode) return;
  state.historyMode = mode;
  traces = null;
  tracesJd = Number.NaN;
  rebuildTraces(performance.now(), true);
  recomputeScaleLimits();
  syncUI();
  writeUrlState();
  ui.announce(mode === 'fixed'
    ? `Fixed history window. Every world shows the last ${state.historyYears} years.`
    : 'Relative history windows restored.');
}

function setHistoryYears(years) {
  const next = Number(years);
  if (!Number.isInteger(next) || next < 1 || next > MAX_FIXED_YEARS) return;
  if (state.historyMode === 'fixed' && state.historyYears === next) return;
  state.historyMode = 'fixed';
  state.historyYears = next;
  traces = null;
  tracesJd = Number.NaN;
  rebuildTraces(performance.now(), true);
  recomputeScaleLimits();
  syncUI();
  writeUrlState();
  ui.announce(`Fixed history window set to ${next} ${next === 1 ? 'year' : 'years'}.`);
}

function setLabels(labels) {
  state.labels = Boolean(labels);
  syncUI();
  writeUrlState();
}

function applyVisibilityChange() {
  if (
    (state.hoveredId !== null && !isBodyVisible(state.hoveredId))
    || (orbitHover !== null && !isBodyVisible(orbitHover.bodyId))
  ) {
    hideHover();
  }
  if (visibleBodyCount() > 1) recomputeScaleLimits();
  syncUI();
  writeUrlState();
}

function setVisibility(id, visible) {
  if (!Object.hasOwn(BY_ID, id) || id === state.centerId) return;
  const shouldHide = !visible;
  if (shouldHide === state.hiddenBodies.has(id)) return;
  if (shouldHide) state.hiddenBodies.add(id);
  else state.hiddenBodies.delete(id);
  applyVisibilityChange();
  const body = BY_ID[id];
  ui.announce(`${body.name} ${shouldHide ? 'hidden' : 'shown'}.`);
}

function setAllVisible(visible) {
  state.hiddenBodies.clear();
  if (!visible) {
    for (const body of BODIES) {
      if (body.id !== state.centerId) state.hiddenBodies.add(body.id);
    }
  }
  applyVisibilityChange();
  ui.announce(
    visible
      ? 'All worlds are visible.'
      : `Showing only ${BY_ID[state.centerId].name}, the center world.`,
  );
}

function togglePlay() {
  if (!state.playing) {
    // At a hard era boundary, starting playback into the wall would appear to
    // do nothing. Turn the ship around instead.
    if (state.direction > 0 && state.jd >= TIME_BOUNDS.maxJd - 1e-9) {
      state.direction = -1;
      boundToastShown = false;
    } else if (state.direction < 0 && state.jd <= TIME_BOUNDS.minJd + 1e-9) {
      state.direction = 1;
      boundToastShown = false;
    }
  }
  state.playing = !state.playing;
  syncUI();
  paintTime(true);
}

function toggleReverse() {
  state.direction *= -1;
  boundToastShown = false;
  syncUI();
  paintTime(true);
}

function setSpeed(daysPerSecond) {
  const value = Number(daysPerSecond);
  if (!Number.isFinite(value) || value === 0) return;
  // A positive UI tempo must not silently undo a reverse direction. Only a
  // negative value (URL/API) is explicitly a directional request.
  if (value < 0) state.direction = -1;
  state.speedDaysPerSec = clamp(Math.abs(value), 0.020833333, 365.25);
  syncUI();
}

function setNow() {
  const target = clamp(
    astronomy.julianDateFromUnixMs(Date.now()),
    TIME_BOUNDS.minJd,
    TIME_BOUNDS.maxJd,
  );
  state.jd = target;
  boundToastShown = false;
  rebuildTraces(performance.now(), true);
  recomputeScaleLimits();
  paintTime(true);
  ui.showToast('Returned to the present epoch.');
}

function resetView() {
  hideHover();
  const wasTopDown = state.mode === 'atlas' || state.mode === 'overview';
  state.centerId = 'sun';
  state.mode = 'realistic';
  state.trailStyle = 'fading';
  state.trailSpan = 1;
  state.historyMode = 'relative';
  state.historyYears = 10;
  state.labels = true;
  state.hiddenBodies.clear();
  savedRealisticCamera = null;
  traces = null;
  tracesJd = Number.NaN;
  rebuildTraces(performance.now(), true);
  recomputeScaleLimits();

  const goal = defaultRealisticGoal();
  animateCameraTo(goal, 820);
  startAtlasBlend(0, wasTopDown ? 820 : 0);
  syncUI();
  writeUrlState();
  ui.showToast('View reset: heliocentric, all worlds visible, comet tails.');
  ui.announce('View reset. Heliocentric orbit view centered on the Sun.');
}

function zoomIn() { zoomBy(1.4); }
function zoomOut() { zoomBy(1 / 1.4); }

/* -------------------------------------------------------------------- time */

function advanceTime(realSeconds) {
  if (!state.playing || !Number.isFinite(realSeconds) || realSeconds <= 0) return;
  const delta = realSeconds * state.speedDaysPerSec * state.direction;
  let next = state.jd + delta;
  let clamped = false;

  if (next <= TIME_BOUNDS.minJd) {
    next = TIME_BOUNDS.minJd;
    clamped = true;
  } else if (next >= TIME_BOUNDS.maxJd) {
    next = TIME_BOUNDS.maxJd;
    clamped = true;
  }

  state.jd = next;
  currentPositions = null;

  if (clamped) {
    state.playing = false;
    syncUI();
    if (!boundToastShown) {
      boundToastShown = true;
      const date = astronomy.dateFromJulianDate(state.jd);
      ui.showToast(`Simulation paused at ${date.getUTCFullYear()} — the edge of the computed era.`);
    }
  }
}

function paintTime(force = false) {
  const now = performance.now();
  if (!force && now - lastDatePaint < 110) return;
  lastDatePaint = now;
  try {
    const date = astronomy.dateFromJulianDate(state.jd);
    ui.updateTime({
      date,
      jd: state.jd,
      outsidePrimaryEra: !isPrimaryEra(state.jd),
      paused: !state.playing,
    });
  } catch (error) {
    console.error('[Solar Atlas] Time display error', error);
  }
}

/* ------------------------------------------------------------- interaction */

function hitTest(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const layout = renderer.getLastLayout();

  for (const label of layout.labels || []) {
    if (
      x >= label.x
      && x <= label.x + label.w
      && y >= label.y
      && y <= label.y + label.h
    ) {
      return label.bodyId;
    }
  }

  let bestId = null;
  let bestDistance = Infinity;
  for (const body of layout.bodies || []) {
    if (!body.visible) continue;
    const distance = Math.hypot(body.x - x, body.y - y);
    const reach = Math.max(13, body.radius + 9);
    if (distance <= reach && distance < bestDistance) {
      bestDistance = distance;
      bestId = body.id;
    }
  }
  return bestId;
}

function pointerPosition(event) {
  return { x: event.clientX, y: event.clientY };
}

function showOrbitPointAt(clientX, clientY, threshold = 8) {
  const rect = canvas.getBoundingClientRect();
  const picked = renderer.pickOrbitPoint(
    clientX - rect.left,
    clientY - rect.top,
    threshold,
  );
  if (!picked) return false;
  const body = BY_ID[picked.bodyId];
  if (!body) return false;
  state.hoveredId = null;
  orbitHover = picked;
  canvas.style.cursor = 'crosshair';
  const date = astronomy.dateFromJulianDate(picked.jd);
  ui.showOrbitHover({
    name: body.name,
    color: body.color,
    date,
    x: clientX,
    y: clientY,
  });
  return true;
}

function inspectOrSelectAt(clientX, clientY) {
  if (hitTest(clientX, clientY)) {
    selectWorldAt(clientX, clientY);
    return;
  }
  // Fingers are less precise than a mouse, so accept a wider hit band.
  if (!showOrbitPointAt(clientX, clientY, 18)) hideHover();
}

function updateHover(clientX, clientY) {
  const id = hitTest(clientX, clientY);
  if (!id) {
    if (showOrbitPointAt(clientX, clientY, 8)) return;

    if (state.hoveredId !== null || orbitHover !== null) {
      state.hoveredId = null;
      orbitHover = null;
      ui.hideHover();
    }
    canvas.style.cursor = gesture ? 'grabbing' : 'grab';
    return;
  }

  const body = BY_ID[id];
  if (!body) return;
  orbitHover = null;

  const changed = state.hoveredId !== id;
  state.hoveredId = id;
  canvas.style.cursor = 'pointer';

  if (changed || !ui.refs.hoverCard || ui.refs.hoverCard.hidden) {
    const positions = positionsNow();
    const center = BY_ID[state.centerId];
    let meta;
    if (id === state.centerId) {
      meta = 'center of the view';
    } else {
      const rel = relativeToCenter(positions, id);
      const distance = rel ? Math.hypot(rel[0], rel[1], rel[2]) : Number.NaN;
      meta = `${formatHoverDistance(distance)} from ${center.name}`;
    }
    ui.showHover({
      name: body.name,
      meta,
      color: body.color,
      x: clientX,
      y: clientY,
      isCenter: id === state.centerId,
    });
  } else {
    // Keep the card near the pointer while it moves.
    ui.showHover({
      name: body.name,
      meta: id === state.centerId ? 'center of the view' : ui.refs.hoverMeta.textContent,
      color: body.color,
      x: clientX,
      y: clientY,
      isCenter: id === state.centerId,
    });
  }
}

function selectWorldAt(clientX, clientY) {
  const id = hitTest(clientX, clientY);
  if (!id) return;
  if (id === state.centerId) {
    ui.showToast(`${BY_ID[id].name} is already at the center of the view.`);
    return;
  }
  setCenter(id);
}

function beginSingleGesture(event) {
  const wantsRotate = Boolean(event.shiftKey) && state.mode === 'realistic';
  gesture = {
    kind: wantsRotate ? 'rotate' : 'pan',
    startX: event.clientX,
    startY: event.clientY,
    lastX: event.clientX,
    lastY: event.clientY,
    travel: 0,
    pointerId: event.pointerId,
  };
  cancelCameraTween();
  canvas.classList.add('is-dragging');
  canvas.style.cursor = 'grabbing';
}

function beginPinch() {
  const points = Array.from(pointers.values());
  if (points.length < 2) return;
  const [a, b] = points;
  const distance = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
  cancelCameraTween();
  gesture = {
    kind: 'pinch',
    startDistance: distance,
    startScale: camera.scale,
    lastMidX: (a.x + b.x) * 0.5,
    lastMidY: (a.y + b.y) * 0.5,
    travel: 10,
    pointerId: null,
  };
  canvas.classList.add('is-dragging');
}

function endGesture() {
  gesture = null;
  canvas.classList.remove('is-dragging');
  canvas.style.cursor = state.hoveredId ? 'pointer' : 'grab';
}

canvas.style.touchAction = 'none';

canvas.addEventListener('pointerdown', (event) => {
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  if (state.mode === 'atlas' && event.pointerType !== 'touch') {
    // Atlas keeps its orientation; panning still works.
  }

  canvas.focus({ preventScroll: true });
  canvas.setPointerCapture?.(event.pointerId);
  pointers.set(event.pointerId, pointerPosition(event));

  if (pointers.size === 1) {
    suppressTap = false;
    beginSingleGesture(event);
  } else if (pointers.size === 2) {
    suppressTap = true;
    beginPinch();
  } else if (pointers.size > 2) {
    suppressTap = true;
  }
  hideHover();
});

canvas.addEventListener('pointermove', (event) => {
  if (!pointers.has(event.pointerId)) {
    if (event.pointerType !== 'touch') {
      updateHover(event.clientX, event.clientY);
    }
    return;
  }

  const previous = pointers.get(event.pointerId);
  pointers.set(event.pointerId, pointerPosition(event));

  if (gesture?.kind === 'pinch' && pointers.size >= 2) {
    const [a, b] = Array.from(pointers.values());
    const distance = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
    const midX = (a.x + b.x) * 0.5;
    const midY = (a.y + b.y) * 0.5;
    const targetScale = clamp(
      gesture.startScale * (distance / gesture.startDistance),
      scaleLimits.minScale,
      scaleLimits.maxScale,
    );
    const factor = targetScale / camera.scale;
    if (Number.isFinite(factor) && Math.abs(factor - 1) > 0.0005) {
      zoomAt(camera, factor, midX, midY, viewport, scaleLimits);
    }
    const dx = midX - gesture.lastMidX;
    const dy = midY - gesture.lastMidY;
    if (state.mode === 'realistic') {
      // Two-finger drag tilts and rotates in Orbits; the pinch distance still
      // controls zoom, so touch users can compose the view with one gesture.
      rotateBy(camera, dx, dy, { minElevation: 8 * DEG, maxElevation: 90 * DEG });
    } else {
      panBy(camera, dx, dy);
    }
    gesture.lastMidX = midX;
    gesture.lastMidY = midY;
    gesture.travel += Math.abs(distance / gesture.startDistance - 1) * 100;
    return;
  }

  if (!gesture) return;
  const dx = event.clientX - gesture.lastX;
  const dy = event.clientY - gesture.lastY;
  gesture.lastX = event.clientX;
  gesture.lastY = event.clientY;
  gesture.travel += Math.hypot(dx, dy);

  if (gesture.kind === 'pan') {
    panBy(camera, dx, dy);
  } else if (gesture.kind === 'rotate' && state.mode === 'realistic') {
    rotateBy(camera, dx, dy, { minElevation: 8 * DEG, maxElevation: 90 * DEG });
  }

  if (gesture.travel > 5) hideHover();
});

function finishPointer(event) {
  const point = pointers.get(event.pointerId);
  const wasClick = !suppressTap
    && gesture
    && gesture.kind !== 'pinch'
    && gesture.pointerId === event.pointerId
    && gesture.travel < 6
    && pointers.size === 1;

  pointers.delete(event.pointerId);

  if (wasClick && point) {
    if (event.pointerType === 'touch') inspectOrSelectAt(point.x, point.y);
    else selectWorldAt(point.x, point.y);
  }

  if (pointers.size === 0) {
    endGesture();
    suppressTap = false;
    if (event.pointerType !== 'touch') {
      updateHover(event.clientX, event.clientY);
    }
  } else if (pointers.size === 1) {
    const [remainingId, remaining] = Array.from(pointers.entries())[0];
    beginSingleGesture({
      clientX: remaining.x,
      clientY: remaining.y,
      shiftKey: false,
      pointerId: remainingId,
    });
  }
}

canvas.addEventListener('pointerup', finishPointer);
canvas.addEventListener('pointercancel', (event) => {
  pointers.delete(event.pointerId);
  if (pointers.size === 0) {
    endGesture();
    suppressTap = false;
  }
});
canvas.addEventListener('pointerleave', (event) => {
  // A touch pointer leaves as the finger lifts; that must not dismiss the
  // date card that was just opened by the tap.
  if (event.pointerType !== 'touch' && !gesture) hideHover();
});

// Tapping any chrome control should dismiss a touch date card instead of
// leaving a stale date floating over the new view.
document.addEventListener('pointerdown', (event) => {
  if (event.target !== canvas) hideHover();
}, true);

canvas.addEventListener('wheel', (event) => {
  event.preventDefault();
  const factor = Math.exp(-event.deltaY * 0.00125);
  zoomByAt(clamp(factor, 0.35, 2.8), event.clientX, event.clientY);
}, { passive: false });

canvas.addEventListener('contextmenu', (event) => {
  event.preventDefault();
});

/* ---------------------------------------------------------------- keyboard */

function isTextEntryTarget(target) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName?.toLowerCase();
  if (tag === 'textarea') return true;
  if (tag !== 'input') return false;
  const type = String(target.type || 'text').toLowerCase();
  return !['button', 'checkbox', 'radio', 'range', 'color', 'file', 'image', 'reset', 'submit'].includes(type);
}

function isNativelyActivatedTarget(target) {
  if (!target) return false;
  const tag = target.tagName?.toLowerCase();
  if (tag === 'button' || tag === 'a' || tag === 'select' || tag === 'textarea' || target.isContentEditable) {
    return true;
  }
  if (tag !== 'input') return false;
  const type = String(target.type || 'text').toLowerCase();
  return ['button', 'checkbox', 'radio', 'submit', 'reset', 'file', 'color'].includes(type);
}

document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (ui.isHelpOpen() || ui.isCenterMenuOpen() || ui.isWorldsOpen()) return;

  const target = event.target;
  if (isTextEntryTarget(target)) return;

  const key = event.key;
  if (isNativelyActivatedTarget(target) && (key === ' ' || key === 'Enter')) return;

  if (key.startsWith('Arrow')) {
    // Let a focused slider or select use its native arrow-key behaviour.
    const tag = target?.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    event.preventDefault();
    cancelCameraTween();
    hideHover();
    if (event.shiftKey) {
      if (state.mode === 'realistic') {
        const dx = key === 'ArrowLeft' ? -24 : key === 'ArrowRight' ? 24 : 0;
        const dy = key === 'ArrowUp' ? -16 : key === 'ArrowDown' ? 16 : 0;
        rotateBy(camera, dx, dy, { minElevation: 8 * DEG, maxElevation: 90 * DEG });
      }
    } else {
      const dx = key === 'ArrowLeft' ? -48 : key === 'ArrowRight' ? 48 : 0;
      const dy = key === 'ArrowUp' ? -48 : key === 'ArrowDown' ? 48 : 0;
      panBy(camera, dx, dy);
    }
    return;
  }

  switch (key) {
    case ' ':
    case 'Spacebar':
      event.preventDefault();
      togglePlay();
      break;
    case '?':
      event.preventDefault();
      ui.openHelp();
      break;
    case 'h':
    case 'H':
      event.preventDefault();
      ui.openHelp();
      break;
    case 'v':
    case 'V':
      event.preventDefault();
      ui.openWorldsDialog();
      break;
    case 'f':
    case 'F':
      event.preventDefault();
      fitView();
      break;
    case 'a':
    case 'A':
      event.preventDefault();
      setMode(state.mode === 'atlas' ? 'realistic' : 'atlas');
      break;
    case 'o':
    case 'O':
      event.preventDefault();
      setMode(state.mode === 'overview' ? 'realistic' : 'overview');
      break;
    case 'e':
    case 'E':
      // Legacy alias from the brief "Elliptic" label.
      event.preventDefault();
      setMode(state.mode === 'overview' ? 'realistic' : 'overview');
      break;
    case 'r':
    case 'R':
      event.preventDefault();
      resetView();
      break;
    case '+':
    case '=':
      event.preventDefault();
      zoomIn();
      break;
    case '-':
    case '_':
      event.preventDefault();
      zoomOut();
      break;
    case '1':
    case '2':
    case '3':
    case '4':
    case '5': {
      event.preventDefault();
      const preset = SPEED_PRESETS[Number(key) - 1];
      if (preset) setSpeed(preset);
      break;
    }
    case 'Escape':
      hideHover();
      break;
    default:
      break;
  }
});

window.addEventListener('keyup', (event) => {
  if (event.key === 'Shift' && gesture?.kind === 'rotate') {
    // Finishing the shift partway through a drag keeps the rotation gesture.
  }
});

/* -------------------------------------------------------------- resize loop */

let resizeTimer = null;

function handleResize() {
  if (resizeTimer) window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    resizeTimer = null;

    // Finish in-flight camera/blend transitions at their targets. Cancelling
    // them here used to be able to freeze a top-down Atlas pose while the app
    // was in Orbits mode.
    if (cameraTween) {
      camera = {
        yaw: cameraTween.to.yaw,
        elevation: cameraTween.to.elevation,
        scale: clamp(cameraTween.to.scale, MIN_SCALE_FLOOR, MAX_SCALE),
        panX: cameraTween.to.panX,
        panY: cameraTween.to.panY,
      };
      cameraTween = null;
    }
    if (atlas.tween) {
      atlas.blend = atlas.tween.to;
      atlas.tween = null;
    }

    const previousViewport = viewport;
    const previousArea = lastStageArea
      || getInsetArea(previousViewport, getSafeInsets());
    viewport = renderer.resize();
    const nextInsets = getSafeInsets();
    const nextArea = getInsetArea(viewport, nextInsets);
    lastStageArea = nextArea;
    chromeRects = collectChromeRects();

    if (previousViewport.width > 0 && previousViewport.height > 0) {
      // Preserve how far the visitor had panned from the stage's centre, then
      // re-anchor that composition into the new stage. Panning by the raw
      // difference between centres is wrong because the canvas centre itself
      // moves when the viewport changes.
      const stageOffsetX = (previousViewport.width * 0.5 + camera.panX)
        - previousArea.centerX;
      const stageOffsetY = (previousViewport.height * 0.5 + camera.panY)
        - previousArea.centerY;
      const scaleFactor = Math.min(
        nextArea.width / Math.max(1, previousArea.width),
        nextArea.height / Math.max(1, previousArea.height),
      );
      if (Number.isFinite(scaleFactor) && Math.abs(scaleFactor - 1) > 0.001) {
        camera.scale = clamp(camera.scale * scaleFactor, MIN_SCALE_FLOOR, MAX_SCALE);
      }
      camera.panX = nextArea.centerX - viewport.width * 0.5 + stageOffsetX;
      camera.panY = nextArea.centerY - viewport.height * 0.5 + stageOffsetY;
    }

    if (state.mode === 'atlas' || state.mode === 'overview') {
      camera.yaw = ATLAS_YAW;
      camera.elevation = ATLAS_ELEVATION;
    } else if (camera.elevation > 89.5 * DEG) {
      camera.elevation = REALISTIC_ELEVATION;
      camera.yaw = REALISTIC_YAW;
    }

    // A pose captured before a responsive layout change is no longer valid;
    // let the next Atlas exit refit to the current stage.
    savedRealisticCamera = null;
    recomputeScaleLimits();
    hideHover();
  }, 120);
}

window.addEventListener('resize', handleResize);
window.addEventListener('orientationchange', handleResize);
if ('ResizeObserver' in window) {
  const observer = new ResizeObserver(() => handleResize());
  observer.observe(canvas);
}

/* ------------------------------------------------------------------- render */

function drawFrame(now) {
  stepCameraTween(now);
  stepAtlasBlend(now);
  maybeRebuildTraces(now);

  const positions = positionsNow();
  const layout = renderer.draw({
    camera,
    atlasBlend: atlas.blend,
    bodies: BODIES,
    positions,
    traces: traces || [],
    centerId: state.centerId,
    hiddenBodies: state.hiddenBodies,
    avoidRects: chromeRects,
    trailStyle: state.trailStyle,
    showLabels: state.labels,
    hoveredId: state.hoveredId,
    reducedMotion: REDUCED_MOTION,
    timeMs: now,
  });

  if (!hasRendered) {
    hasRendered = true;
    window.requestAnimationFrame(() => {
      window.setTimeout(() => {
        if (!overlayDismissed) {
          overlayDismissed = true;
          ui.setVeilDone();
        }
      }, 180);
    });
  }

  return layout;
}

function frame(now) {
  const realSeconds = clamp((now - lastFrameMs) / 1000, 0, 0.12);
  lastFrameMs = now;

  if (state.playing && !document.hidden) {
    advanceTime(realSeconds);
  }

  paintTime(false);
  drawFrame(now);
  window.requestAnimationFrame(frame);
}

/* ------------------------------------------------------------------- boot */

function boot() {
  // Build the initial ephemeris and trail geometry before the first paint.
  rebuildTraces(performance.now(), true);
  recomputeScaleLimits();

  if (state.mode === 'atlas') {
    atlas.blend = 1;
    atlas.tween = null;
    camera = atlasFitGoal();
  } else if (state.mode === 'overview') {
    atlas.blend = 0;
    atlas.tween = null;
    camera = overviewFitAllGoal();
  } else {
    atlas.blend = 0;
    camera = focusedGoal({ defaultTilt: true });
  }
  applyCamera(camera);
  lastStageArea = getInsetArea(viewport, getSafeInsets());

  ui.sync(state);
  chromeRects = collectChromeRects();
  paintTime(true);
  writeUrlState();

  // Expose a small, stable automation API for QA and curious tinkerers.
  window.__solar = {
    version: 1,
    getState: () => ({
      centerId: state.centerId,
      mode: state.mode,
      trailStyle: state.trailStyle,
      trailSpan: state.trailSpan,
      historyMode: state.historyMode,
      historyYears: state.historyYears,
      traceWindowDays: Array.isArray(traces) && traces[0] ? traces[0].windowDays : null,
      requestedWindowDays: state.historyMode === 'fixed'
        ? state.historyYears * DAYS_PER_YEAR
        : null,
      traceSampleCount: Array.isArray(traces) && traces[0] ? traces[0].points.length : null,
      maxHistoryCycles: MAX_HISTORY_CYCLES,
      labels: state.labels,
      playing: state.playing,
      direction: state.direction,
      speedDaysPerSec: state.speedDaysPerSec,
      jd: state.jd,
      hiddenBodies: BODIES.filter((body) => state.hiddenBodies.has(body.id)).map((body) => body.id),
      visibleBodyIds: BODIES.filter((body) => isBodyVisible(body.id)).map((body) => body.id),
      date: astronomy.dateFromJulianDate(state.jd).toISOString(),
      atlasBlend: atlas.blend,
      camera: { ...camera },
      traceCount: Array.isArray(traces) ? traces.length : 0,
      fitAllScale,
      scaleLimits: { ...scaleLimits },
      viewport: { ...viewport },
      hasRendered,
    }),
    setCenter: (id) => setCenter(id),
    setMode: (mode) => setMode(mode),
    setTrailStyle: (style) => setTrailStyle(style),
    setTrailSpan: (span) => setTrailSpan(span),
    setHistoryMode: (mode) => setHistoryMode(mode),
    setHistoryYears: (years) => setHistoryYears(years),
    setLabels: (labels) => setLabels(labels),
    setSpeed: (days) => setSpeed(days),
    setJd: (value) => {
      let jd;
      if (typeof value === 'number') jd = value;
      else if (value instanceof Date) jd = astronomy.julianDateFromUnixMs(value.getTime());
      else if (typeof value === 'string') {
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) jd = astronomy.julianDateFromUnixMs(parsed);
      }
      if (!Number.isFinite(jd)) return false;
      state.jd = clamp(jd, TIME_BOUNDS.minJd, TIME_BOUNDS.maxJd);
      boundToastShown = false;
      rebuildTraces(performance.now(), true);
      paintTime(true);
      return true;
    },
    setVisibility: (id, visible = true) => {
      setVisibility(id, visible);
      return isBodyVisible(id);
    },
    setAllVisible: (visible = true) => {
      setAllVisible(visible);
      return visibleBodyCount();
    },
    togglePlay: () => togglePlay(),
    zoomBy: (factor) => zoomBy(Number(factor) || 1),
    fit: () => fitView(),
    reset: () => resetView(),
    getSceneSummary: () => ({
      centerId: state.centerId,
      mode: state.mode,
      trailStyle: state.trailStyle,
      trailSpan: state.trailSpan,
      historyMode: state.historyMode,
      historyYears: state.historyYears,
      atlasBlend: atlas.blend,
      camera: { ...camera },
      layout: renderer.getLastLayout(),
      viewport: { ...viewport },
      traceCount: Array.isArray(traces) ? traces.filter((trace) => isBodyVisible(trace.bodyId)).length : 0,
      totalTraceCount: Array.isArray(traces) ? traces.length : 0,
      bodyCount: BODIES.length,
      visibleBodyCount: visibleBodyCount(),
    }),
    pickOrbitAt: (clientX, clientY, threshold = 8) => {
      const rect = canvas.getBoundingClientRect();
      const hit = renderer.pickOrbitPoint(
        Number(clientX) - rect.left,
        Number(clientY) - rect.top,
        Number(threshold) || 8,
      );
      if (!hit) return null;
      return {
        bodyId: hit.bodyId,
        jd: hit.jd,
        date: astronomy.dateFromJulianDate(hit.jd).toISOString(),
      };
    },
    getPositionsAt: (jd) => astronomy.getPositions(jd),
  };
  window.dispatchEvent(new CustomEvent('solar-ready'));

  canvas.tabIndex = -1;
  if (!ui.refs.canvas) ui.refs.canvas = canvas;
  lastFrameMs = performance.now();
  window.requestAnimationFrame(frame);

  // Safety net: never leave the visitor staring at the loading veil.
  window.setTimeout(() => {
    if (!hasRendered && !overlayDismissed) {
      overlayDismissed = true;
      ui.setVeilDone();
    }
  }, 3500);
}

try {
  boot();
} catch (error) {
  console.error('[Solar Atlas] Failed to start.', error);
  document.body.classList.remove('is-loading');
  const veil = document.getElementById('veil');
  if (veil) veil.remove();
  const toast = document.getElementById('toast');
  if (toast) {
    toast.hidden = false;
    toast.textContent = 'The ephemeris could not be started. See the console for details.';
    toast.classList.add('is-visible');
  }
}

