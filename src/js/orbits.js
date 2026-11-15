/**
 * Solar Atlas — orbital geometry.
 *
 * Visual philosophy
 * =================
 * Orbits mode is geometrically literal. Every trace is a time-parameterised
 * sample of the real motion, not a decorative circle:
 *
 *   • Heliocentric traces are true (sampled) ellipses. Eccentricity and
 *     inclination survive because the only operation applied to a position is
 *     subtraction of the centre — nothing is circularised, rotated, or scaled.
 *   • Planet-centric traces are real centre-relative trajectories. The moving
 *     centre is subtracted at the *same instant* of every sample, so the
 *     familiar epicyclic picture emerges honestly: rosettes, retrograde loops
 *     and nested curves that accumulate over several synodic periods.
 *   • Atlas is the single deliberate distortion. It compresses radius only —
 *     log1p(r / ATLAS_SCALE_AU) — and preserves direction exactly, so angular
 *     geometry, conjunction order and the shape of every orbit remain true
 *     while the outer system is drawn in close enough to read.
 *
 * The module is pure, dependency-free and DOM-free. Positions are injected
 * through `getPositions(jd)`; it never imports the ephemeris.
 */

/**
 * Reference length of the Atlas radial compression, in AU.
 *
 * A body at 0.18 AU maps to ln 2 ≈ 0.693 display AU, one at 1 AU to ≈1.88,
 * and one at 30 AU to ≈5.12. The compression is monotonic and unbounded, so
 * relative ordering of distances is always preserved.
 * @type {number}
 */
export const ATLAS_SCALE_AU = 0.18;

/** Days in a Julian year, used only to express the 40-year window cap. */
const DAYS_PER_YEAR = 365.25;

/** Shortest generic planet-centric trace window: 2.5 synodic periods or this. */
const MIN_TRACE_WINDOW_DAYS = 120;

/** Longest generic planet-centric trace window: 2.5 synodic periods or this. */
const MAX_TRACE_WINDOW_DAYS = 40 * DAYS_PER_YEAR;

/** Hard ceiling for user-extended history, unless one base orbit is longer. */
const MAX_TRAIL_HISTORY_DAYS = 300 * DAYS_PER_YEAR;

/** A local lunar trail covers a little over two sidereal months. */
const LUNAR_TRAIL_ORBITS = 2.2;

/** Fallback sidereal month if Moon metadata is missing. */
const DEFAULT_LUNAR_ORBIT_DAYS = 27.321661;

/** Fallback window when a period is missing, null, or nonsensical. */
const DEFAULT_WINDOW_DAYS = 365.25;

/** Number of samples per trace when the caller does not supply one. */
const DEFAULT_SAMPLE_COUNT = 480;

/** Upper bound on samples to keep one rebuild bounded; callers need ~480. */
const MAX_SAMPLE_COUNT = 20_000;

/** Fade alpha at the head (newest point) of every trace. */
const TRACE_HEAD_ALPHA = 0.9;

/**
 * Exponent of the fade profile. Slightly above 1 keeps old samples delicate and
 * concentrates luminance near the head without a hard cutoff.
 */
const TRACE_FADE_EXPONENT = 1.5;

/** A generic planet-centric window spans 2.5 synodic periods. */
const SYNODIC_WINDOW_FACTOR = 2.5;

/**
 * Compress a radial distance for Atlas mode.
 *
 * The mapping is `Math.log1p(rAU / ATLAS_SCALE_AU)`: continuous, strictly
 * increasing for r > 0, zero at the origin, and direction-preserving when used
 * through {@link displayPosition}. Non-positive, NaN, and non-finite inputs
 * are sanitised to 0 so downstream geometry can never receive NaN.
 *
 * @param {number} rAU Raw radial distance in AU.
 * @returns {number} Compressed display-space radius (≥ 0).
 */
export function compressDistance(rAU) {
  if (typeof rAU !== 'number' || !Number.isFinite(rAU) || rAU <= 0) {
    return 0;
  }
  const ratio = rAU / ATLAS_SCALE_AU;
  // Only reachable for astronomically impossible magnitudes near
  // Number.MAX_VALUE, where the division overflows. The asymptotic form keeps
  // the result finite instead of returning Infinity.
  return Number.isFinite(ratio)
    ? Math.log1p(ratio)
    : Math.log(rAU) + Math.log(1 / ATLAS_SCALE_AU);
}

/**
 * Map a raw 3-D position into display space.
 *
 * - `blend === 0` returns an exact copy of `p` (true distances).
 * - `blend === 1` returns a direction-preserving Atlas position whose radius
 *   is `compressDistance(|p|)`.
 * - `0 < blend < 1` linearly interpolates the *radius* between the true and
 *   compressed values, keeping the direction exactly fixed.
 *
 * `p` is never mutated. Zero-length vectors, NaN components, and malformed
 * input yield `[0, 0, 0]`; blend is clamped to [0, 1] and NaN resolves to 0.
 *
 * @param {ArrayLike<number>} p Raw position `[x, y, z]` in AU.
 * @param {number} blend Atlas blend, 0 = true, 1 = compressed.
 * @returns {[number, number, number]} A new position array.
 */
export function displayPosition(p, blend) {
  const x = finiteComponent(p, 0);
  const y = finiteComponent(p, 1);
  const z = finiteComponent(p, 2);
  if (x === null || y === null || z === null) return [0, 0, 0];

  const blendClamped = clampNumber(blend, 0, 1);
  if (blendClamped === 0) return [x, y, z];

  const radius = Math.hypot(x, y, z);
  if (radius === 0) return [0, 0, 0];

  const compressedRadius = compressDistance(radius);
  const displayRadius =
    blendClamped === 1
      ? compressedRadius
      : radius + (compressedRadius - radius) * blendClamped;

  const scale = displayRadius / radius;
  return [x * scale, y * scale, z * scale];
}

/**
 * Trace window for one target as seen from one centre, in days.
 *
 * Rules, in priority order:
 * 1. Sun target: one revolution of the centre's year (`center.yearDays`), the
 *    apparent solar period. This intentionally precedes the "centre orbits
 *    target" rule so the Moon's 27.3-day orbit does not leak into a solar view.
 * 2. Target orbits the centre: one sidereal orbit of the target.
 * 3. Centre orbits the target: one sidereal orbit of the centre.
 * 4. Moon seen from anywhere except Earth: a ~2.2-month local lunar trail,
 *    never a heliocentric ring.
 * 5. Everything else: 2.5 × synodic period computed from **heliocentric years**
 *    (`yearDays`), clamped to [120 days, 40 years]. Using `yearDays` rather
 *    than a moon's `orbitDays` is essential for correct geocentric rosettes.
 *
 * The optional `span` multiplier stretches (or shortens) this base window for
 * the user-facing history control. The result is capped at 300 years unless a
 * single base orbit is already longer; an outer planet's full orbit is never
 * truncated to the generic cap. Missing/null/invalid period fields are handled
 * defensively: a usable value is chosen when possible and the fallback is
 * always finite and positive.
 *
 * @param {object} target BODIES-shaped target.
 * @param {object} center BODIES-shaped centre.
 * @param {number} [span=1] History multiplier, clamped to [0.5, 50].
 * @param {number|null} [fixedWindowDays=null] Absolute history window in
 *   days. When valid, this overrides `span` and is capped at 300 years.
 * @returns {number} Window length in days (> 0, finite).
 * @throws {TypeError} If target or center is not an object.
 */
export function getTraceWindowDays(target, center, span = 1, fixedWindowDays = null) {
  if (!isObject(target) || !isObject(center)) {
    throw new TypeError(
      'getTraceWindowDays: target and center must be BODIES-shaped objects'
    );
  }

  const fixedDays = positiveDays(fixedWindowDays);
  if (fixedDays !== null) {
    return Math.min(fixedDays, MAX_TRAIL_HISTORY_DAYS);
  }

  let baseWindow;

  // 1. Apparent solar revolution. Must win over "centre orbits target" for a
  //    Moon-centric view: the Sun still circles once per terrestrial year.
  if (target.id === 'sun') {
    baseWindow = positiveDays(center.yearDays) ?? DEFAULT_WINDOW_DAYS;
  } else if (target.parentId != null && target.parentId === center.id) {
    // 2. The target physically orbits the centre: exactly one sidereal orbit.
    const period = positiveDays(target.orbitDays);
    baseWindow = period ?? DEFAULT_WINDOW_DAYS;
  } else if (center.parentId != null && center.parentId === target.id) {
    // 3. The centre physically orbits the target (e.g. Earth as seen from the
    //    Moon): the centre's own sidereal period.
    const period = positiveDays(center.orbitDays);
    baseWindow = period ?? DEFAULT_WINDOW_DAYS;
  } else if (target.id === 'moon' && center.id !== 'earth') {
    // 4. A local lunar trail for any non-geocentric view of the Moon.
    const lunarPeriod = positiveDays(target.orbitDays) ?? DEFAULT_LUNAR_ORBIT_DAYS;
    baseWindow = LUNAR_TRAIL_ORBITS * lunarPeriod;
  } else {
    // 5. Synodic rosette window, always from heliocentric years.
    const synodicDays = synodicPeriodDays(target.yearDays, center.yearDays);
    baseWindow = clampNumber(
      SYNODIC_WINDOW_FACTOR * synodicDays,
      MIN_TRACE_WINDOW_DAYS,
      MAX_TRACE_WINDOW_DAYS
    );
  }

  const multiplier =
    typeof span === 'number' && Number.isFinite(span) && span > 0
      ? clampNumber(span, 0.5, 50)
      : 1;
  // A full outer-planet orbit is already enormous; never shorten it to the
  // generic history ceiling.
  const ceiling = Math.max(baseWindow, MAX_TRAIL_HISTORY_DAYS);
  return Math.min(baseWindow * multiplier, ceiling);
}

/**
 * Build centre-relative orbit traces for every body except the centre.
 *
 * Each trace is sampled independently over its own window. For every sample
 * the target and centre positions are evaluated at exactly the same instant
 * and subtracted, so a trace is the true trajectory of the target relative to
 * the moving centre. The default provider computes all bodies once per sample;
 * when the optional `getPosition(bodyId, jd)` is supplied, only the two bodies
 * a trace needs are evaluated, which is considerably cheaper. The last sample
 * is exactly `jd`, therefore its point is the body's current centre-relative
 * position.
 *
 * Points are ordinary `[x, y, z]` arrays in raw AU, oldest → newest. Alphas
 * rise from exactly 0 at the tail to 0.9 at the head with a power curve. A
 * body is omitted entirely if any sample lacks finite positions, keeping all
 * returned traces complete and NaN-free; a malformed centre or arguments throw
 * instead of failing silently.
 *
 * @param {object} options
 * @param {number} options.jd Current Julian Day; the final sample.
 * @param {string} options.centerId Id of the body placed at the origin.
 * @param {Array<object>|Iterable<object>} options.bodies BODIES-shaped metadata.
 * @param {(jd: number) => object} options.getPositions Position provider keyed
 *   by body id, returning `[x, y, z]` in AU.
 * @param {(bodyId: string, jd: number) => number[]} [options.getPosition]
 *   Optional direct provider for a single body. When supplied it is used
 *   instead of `getPositions`, so a trace only computes its own target and
 *   center rather than every body in the system.
 * @param {number} [options.span=1] History multiplier for the trace window,
 *   clamped to [0.5, 50]. Ignored when `fixedWindowDays` is supplied.
 * @param {number|null} [options.fixedWindowDays=null] Absolute history
 *   window in days, shared by every trace (capped at 300 years).
 * @param {number|null} [options.maxCycles=null] Optional cap on the number of
 *   natural apparent cycles retained per trace. Requires fixedWindowDays to be
 *   useful; works alongside samplesPerCycle.
 * @param {number|null} [options.samplesPerCycle=null] When set, each trace gets
 *   roughly this many samples per retained cycle instead of the global count.
 * @param {number|null} [options.minSamplesPerTrace=null] Lower bound for the
 *   per-cycle sample count.
 * @param {number|null} [options.maxSamplesPerTrace=null] Upper bound for the
 *   per-cycle sample count.
 * @param {number} [options.samples=480] Samples per trace (normalised to an
 *   integer in [2, 20 000]).
 * @returns {Array<{
 *   bodyId: string,
 *   centerId: string,
 *   points: Array<[number, number, number]>,
 *   alphas: number[],
 *   windowDays: number,
 *   startJd: number,
 *   endJd: number,
 *   isClosed: boolean
 * }>} One trace per non-centre body, in input order.
 * @throws {RangeError} If `centerId` does not name a supplied body.
 * @throws {TypeError} If arguments are malformed.
 */
export function buildTraces({
  jd,
  centerId,
  bodies,
  getPositions,
  getPosition = null,
  span = 1,
  fixedWindowDays = null,
  maxCycles = null,
  samplesPerCycle = null,
  minSamplesPerTrace = null,
  maxSamplesPerTrace = null,
  samples = DEFAULT_SAMPLE_COUNT,
} = {}) {
  if (typeof getPositions !== 'function') {
    throw new TypeError('buildTraces: getPositions must be a function');
  }
  if (typeof jd !== 'number' || !Number.isFinite(jd)) {
    throw new TypeError('buildTraces: jd must be a finite number');
  }

  const bodyList = toBodyList(bodies);
  const center = bodyList.find((body) => isObject(body) && body.id === centerId);
  if (!center) {
    const known = bodyList
      .filter((body) => isObject(body) && body.id != null)
      .map((body) => body.id)
      .join(', ');
    throw new RangeError(
      `buildTraces: unknown centerId "${String(centerId)}"` +
        (known ? `; known body ids: ${known}` : '; no bodies supplied')
    );
  }

  const sampleCount = normalizeSampleCount(samples);
  const traces = [];

  for (const target of bodyList) {
    if (!isObject(target) || target.id === centerId) continue;
    const trace = sampleTrace({
      jd,
      centerId,
      center,
      target,
      getPositions,
      getPosition: typeof getPosition === 'function' ? getPosition : null,
      span,
      fixedWindowDays,
      maxCycles,
      samplesPerCycle,
      minSamplesPerTrace,
      maxSamplesPerTrace,
      sampleCount,
    });
    if (trace !== null) traces.push(trace);
  }

  return traces;
}

/**
 * Build complete closed orbits for every body except the center.
 *
 * This is the geometry used by the "Always" trail style. Unlike buildTraces,
 * which follows the apparent center-relative trail over time, this function
 * samples each body's full orbit around its parent and translates it by the
 * parent's current position relative to the chosen center:
 *
 *   planet (parent Sun)  -> full heliocentric ellipse, offset by the Sun's
 *                           current position in the selected center's frame
 *   Moon   (parent Earth) -> full lunar ellipse, offset by Earth's current
 *                           position in the selected center's frame
 *   Sun    (no parent)    -> the center's apparent solar orbit over one
 *                           center year (a complete loop around the center)
 *
 * The body's current position is always the final point: for a target orbiting
 * a parent, `rel(target,parent) + rel(parent,center)` equals `rel(target,center)`.
 * These paths are closed loops and are drawn uniformly at full brightness by
 * the renderer; there is no fading.
 *
 * @param {object} options
 * @param {number} options.jd Current Julian Day; the final sample.
 * @param {string} options.centerId Id of the body placed at the origin.
 * @param {Array<object>|Iterable<object>} options.bodies BODIES-shaped metadata.
 * @param {(jd: number) => object} [options.getPositions] Optional bulk provider.
 * @param {(bodyId: string, jd: number) => number[]} [options.getPosition]
 *   Preferred direct provider; every sample only evaluates the target, parent
 *   and (for the apparent solar orbit) center bodies.
 * @param {number} [options.samples=560] Samples per complete orbit.
 * @returns {Array<{
 *   bodyId: string,
 *   centerId: string,
 *   points: Array<[number, number, number]>,
 *   alphas: number[],
 *   windowDays: number,
 *   isClosed: boolean,
 *   fullOrbit: boolean
 * }>} One complete-orbit trace per non-center body.
 * @throws {RangeError} If `centerId` does not name a supplied body.
 * @throws {TypeError} If arguments are malformed.
 */
export function buildCompleteOrbitTraces({
  jd,
  centerId,
  bodies,
  getPositions = null,
  getPosition = null,
  samples = 560,
} = {}) {
  if (typeof getPosition !== 'function' && typeof getPositions !== 'function') {
    throw new TypeError(
      'buildCompleteOrbitTraces: getPosition or getPositions must be a function'
    );
  }
  if (typeof jd !== 'number' || !Number.isFinite(jd)) {
    throw new TypeError('buildCompleteOrbitTraces: jd must be a finite number');
  }

  const bodyList = toBodyList(bodies);
  const center = bodyList.find((body) => isObject(body) && body.id === centerId);
  if (!center) {
    throw new RangeError(
      `buildCompleteOrbitTraces: unknown centerId "${String(centerId)}"`
    );
  }

  const sampleCount = normalizeSampleCount(samples);
  const direct = typeof getPosition === 'function';
  let cachedTime = Number.NaN;
  let cachedSnapshot = null;

  /** Read one body at one instant, with a bulk-provider cache per instant. */
  function read(bodyId, time) {
    if (direct) return getPosition(bodyId, time);
    if (time !== cachedTime || cachedSnapshot === null) {
      cachedSnapshot = getPositions(time);
      cachedTime = time;
    }
    return lookupPosition(cachedSnapshot, bodyId);
  }

  const centerNow = read(centerId, jd);
  if (!isFiniteVector3(centerNow)) return [];

  const traces = [];

  for (const target of bodyList) {
    if (!isObject(target) || target.id === centerId) continue;

    let parentId = null;
    let periodDays = null;
    let translation = [0, 0, 0];

    if (target.id === 'sun') {
      // The Sun's apparent loop around a planet is the center's own orbit,
      // mirrored through the origin. It is complete over one center year.
      periodDays = positiveDays(center.yearDays) ?? DEFAULT_WINDOW_DAYS;
    } else if (typeof target.parentId === 'string' && target.parentId.length > 0) {
      parentId = target.parentId;
      periodDays = positiveDays(target.orbitDays)
        ?? positiveDays(center.orbitDays)
        ?? DEFAULT_WINDOW_DAYS;

      const parentNow = read(parentId, jd);
      if (!isFiniteVector3(parentNow)) continue;
      translation = [
        parentNow[0] - centerNow[0],
        parentNow[1] - centerNow[1],
        parentNow[2] - centerNow[2],
      ];
    } else {
      continue;
    }

    if (!Number.isFinite(periodDays) || periodDays <= 0) continue;

    const points = new Array(sampleCount);
    const startJd = jd - periodDays;
    const stepDays = periodDays / Math.max(1, sampleCount - 1);
    let failed = false;

    for (let i = 0; i < sampleCount; i += 1) {
      const sampleJd = i === sampleCount - 1 ? jd : startJd + stepDays * i;

      let targetPosition;
      let point;

      if (parentId === null) {
        const centerPosition = read(centerId, sampleJd);
        if (!isFiniteVector3(centerPosition)) {
          failed = true;
          break;
        }
        point = [-centerPosition[0], -centerPosition[1], -centerPosition[2]];
      } else {
        targetPosition = read(target.id, sampleJd);
        const parentPosition = read(parentId, sampleJd);
        if (!isFiniteVector3(targetPosition) || !isFiniteVector3(parentPosition)) {
          failed = true;
          break;
        }
        point = [
          targetPosition[0] - parentPosition[0] + translation[0],
          targetPosition[1] - parentPosition[1] + translation[1],
          targetPosition[2] - parentPosition[2] + translation[2],
        ];
      }

      if (!point.every(Number.isFinite)) {
        failed = true;
        break;
      }
      points[i] = point;
    }

    if (failed) continue;

    traces.push({
      bodyId: target.id,
      centerId,
      points,
      // The Always style deliberately ignores per-point alpha, but keep the
      // array shape for renderer/tests consistency.
      alphas: new Array(sampleCount).fill(0.9),
      windowDays: periodDays,
      startJd: jd - periodDays,
      endJd: jd,
      isClosed: true,
      fullOrbit: true,
    });
  }

  return traces;
}

/**
 * Synodic period between two heliocentric (or otherwise co-planar) periods.
 *
 * `1 / |1/a - 1/b|` is the time between successive conjunctions. Returns
 * `Infinity` when either period is missing/invalid or the periods are equal,
 * because the configuration then never repeats (or its period is undefined);
 * callers should clamp that sentinel rather than emit NaN.
 *
 * @param {number} aDays First sidereal period in days.
 * @param {number} bDays Second sidereal period in days.
 * @returns {number} Synodic period in days, or `Infinity`.
 */
export function synodicPeriodDays(aDays, bDays) {
  const a = positiveDays(aDays);
  const b = positiveDays(bDays);
  if (a === null || b === null || a === b) return Infinity;

  const inverseDifference = Math.abs(1 / a - 1 / b);
  if (!(inverseDifference > 0) || !Number.isFinite(inverseDifference)) {
    return Infinity;
  }
  const period = 1 / inverseDifference;
  return period > 0 && Number.isFinite(period) ? period : Infinity;
}

/**
 * Compute `positions[bodyId] - positions[centerId]` at one instant.
 *
 * Supports a plain object (as returned by the ephemeris) or a `Map`. Returns a
 * fresh `[x, y, z]` array; never mutates the input. Missing or non-finite
 * positions return `null`, and the same body subtracted from itself returns
 * `[0, 0, 0]` when its position is available.
 *
 * @param {object|Map<string, ArrayLike<number>>} positions Snapshot keyed by id.
 * @param {string} bodyId Target id.
 * @param {string} centerId Centre id.
 * @returns {[number, number, number]|null} Relative position in AU, or null.
 */
export function relativePosition(positions, bodyId, centerId) {
  const target = lookupPosition(positions, bodyId);
  if (!isFiniteVector3(target)) return null;
  if (bodyId === centerId) return [0, 0, 0];

  const center = lookupPosition(positions, centerId);
  if (!isFiniteVector3(center)) return null;

  const x = target[0] - center[0];
  const y = target[1] - center[1];
  const z = target[2] - center[2];
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    return null;
  }
  return [x, y, z];
}

/**
 * Clamp a number to an inclusive range, defensively.
 *
 * NaN resolves to the low bound, +Infinity to the high bound, -Infinity to the
 * low bound. Reversed bounds are tolerated by swapping them; non-numeric
 * bounds fall back to 0. This helper never returns NaN.
 *
 * @param {number} value Value to clamp.
 * @param {number} min Lower bound.
 * @param {number} max Upper bound.
 * @returns {number} The clamped value.
 */
export function clampNumber(value, min, max) {
  let low = typeof min === 'number' && !Number.isNaN(min) ? min : 0;
  let high = typeof max === 'number' && !Number.isNaN(max) ? max : low;
  if (low > high) {
    const swap = low;
    low = high;
    high = swap;
  }

  if (typeof value !== 'number' || Number.isNaN(value)) return low;
  if (value <= low) return low;
  if (value >= high) return high;
  return value;
}

/* ------------------------------------------------------------------------- */
/* Internal helpers                                                          */
/* ------------------------------------------------------------------------- */

/**
 * One natural repetition period for the centre-relative path. Used only to
 * bound redundant overlapping history; not to choose the public base window.
 *
 * @private
 */
function naturalCycleDays(target, center) {
  if (target.id === 'sun') {
    return positiveDays(center.yearDays);
  }
  if (target.parentId != null && target.parentId === center.id) {
    return positiveDays(target.orbitDays);
  }
  if (center.parentId != null && center.parentId === target.id) {
    return positiveDays(center.orbitDays);
  }
  if (target.id === 'moon' && center.id !== 'earth') {
    return positiveDays(target.orbitDays) ?? DEFAULT_LUNAR_ORBIT_DAYS;
  }
  const synodicDays = synodicPeriodDays(target.yearDays, center.yearDays);
  return Number.isFinite(synodicDays) && synodicDays > 0 ? synodicDays : null;
}

/**
 * Sample one trace over its window, returning null if the body cannot be
 * rendered completely. The centre and target are always evaluated from the
 * same sample instant.
 *
 * @private
 */
function sampleTrace({
  jd,
  centerId,
  center,
  target,
  getPositions,
  getPosition,
  span,
  fixedWindowDays,
  maxCycles,
  samplesPerCycle,
  minSamplesPerTrace,
  maxSamplesPerTrace,
  sampleCount,
}) {
  const requestedWindowDays = safeWindowDays(
    getTraceWindowDays(target, center, span, fixedWindowDays)
  );
  const cycleDays = naturalCycleDays(target, center);
  const cycleLimit = positiveDays(maxCycles);
  const windowDays = cycleLimit !== null && cycleDays !== null
    ? Math.min(requestedWindowDays, cycleDays * cycleLimit)
    : requestedWindowDays;

  const perCycle = positiveDays(samplesPerCycle);
  if (perCycle !== null && cycleDays !== null) {
    const cycles = windowDays / cycleDays;
    const minCount = normalizeSampleCount(minSamplesPerTrace ?? 2);
    const maxCount = normalizeSampleCount(maxSamplesPerTrace ?? MAX_SAMPLE_COUNT);
    sampleCount = normalizeSampleCount(clampNumber(
      Math.round(cycles * perCycle),
      minCount,
      maxCount
    ));
  }

  const startJd = jd - windowDays;
  const stepDays = windowDays / (sampleCount - 1);
  const points = new Array(sampleCount);

  for (let i = 0; i < sampleCount; i += 1) {
    // Pin both endpoints exactly: the tail at jd - window, the head at jd.
    const sampleJd = i === sampleCount - 1 ? jd : startJd + stepDays * i;

    let targetPosition;
    let centerPosition;

    try {
      if (getPosition) {
        // Fast path: only evaluate the two bodies this trace needs.
        targetPosition = getPosition(target.id, sampleJd);
        centerPosition = getPosition(centerId, sampleJd);
      } else {
        const positions = getPositions(sampleJd);
        targetPosition = lookupPosition(positions, target.id);
        centerPosition = lookupPosition(positions, centerId);
      }
    } catch {
      return null;
    }
    if (
      !isFiniteVector3(targetPosition) ||
      !isFiniteVector3(centerPosition)
    ) {
      return null;
    }

    const x = targetPosition[0] - centerPosition[0];
    const y = targetPosition[1] - centerPosition[1];
    const z = targetPosition[2] - centerPosition[2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      return null;
    }

    points[i] = [x, y, z];
  }

  return {
    bodyId: target.id,
    centerId,
    points,
    alphas: buildAlphaProfile(sampleCount),
    windowDays,
    requestedWindowDays,
    cycleDays,
    cycles: cycleDays !== null ? windowDays / cycleDays : null,
    startJd,
    endJd: jd,
    isClosed: target.parentId != null && target.parentId === centerId,
  };
}

/**
 * Fade profile: alpha 0 at the oldest sample, 0.9 at the head, strictly
 * increasing between with a gentle power curve.
 *
 * @private
 */
function buildAlphaProfile(sampleCount) {
  const alphas = new Array(sampleCount);
  const denominator = sampleCount - 1;
  for (let i = 0; i < sampleCount; i += 1) {
    if (i === 0) {
      alphas[i] = 0;
    } else if (i === denominator) {
      alphas[i] = TRACE_HEAD_ALPHA;
    } else {
      alphas[i] =
        TRACE_HEAD_ALPHA * Math.pow(i / denominator, TRACE_FADE_EXPONENT);
    }
  }
  return alphas;
}

/** @private */
function safeWindowDays(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_WINDOW_DAYS;
}

/** @private */
function normalizeSampleCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_SAMPLE_COUNT;
  }
  return Math.min(MAX_SAMPLE_COUNT, Math.max(2, Math.floor(value)));
}

/** @private */
function positiveDays(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null;
}

/** @private */
function isObject(value) {
  return typeof value === 'object' && value !== null;
}

/** @private */
function toBodyList(bodies) {
  if (Array.isArray(bodies)) return bodies;
  if (
    bodies !== null &&
    bodies !== undefined &&
    typeof bodies !== 'string' &&
    typeof bodies[Symbol.iterator] === 'function'
  ) {
    return Array.from(bodies);
  }
  throw new TypeError(
    'buildTraces: bodies must be an array of BODIES-shaped objects'
  );
}

/** @private */
function lookupPosition(positions, id) {
  if (positions == null || id == null) return null;
  if (positions instanceof Map) return positions.get(id) ?? null;
  return positions[id] ?? null;
}

/** @private */
function isFiniteVector3(vector) {
  return (
    vector != null &&
    typeof vector[0] === 'number' &&
    typeof vector[1] === 'number' &&
    typeof vector[2] === 'number' &&
    Number.isFinite(vector[0]) &&
    Number.isFinite(vector[1]) &&
    Number.isFinite(vector[2])
  );
}

/** @private */
function finiteComponent(vector, index) {
  if (vector == null) return null;
  const value = vector[index];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
