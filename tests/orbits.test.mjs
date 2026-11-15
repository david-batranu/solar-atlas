import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ATLAS_SCALE_AU,
  compressDistance,
  displayPosition,
  getTraceWindowDays,
  buildTraces,
  buildCompleteOrbitTraces,
  synodicPeriodDays,
  relativePosition,
  clampNumber,
} from '../src/js/orbits.js';

const TAU = Math.PI * 2;
const J2000_JD = 2451545.0;
const MOON_RADIUS_AU = 384400 / 149597870.7;
const MOON_ORBIT_DAYS = 27.321661;

/* ------------------------------------------------------------------------- */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------- */

/** Build a BODIES-shaped object with all contract fields present. */
function makeBody(spec) {
  return {
    id: spec.id,
    name: spec.name ?? spec.id,
    kind: spec.kind ?? 'planet',
    parentId: spec.parentId ?? null,
    symbol: spec.symbol ?? '•',
    color: spec.color ?? '#ffffff',
    glow: spec.glow ?? '#ffffff',
    radiusKm: spec.radiusKm ?? 1000,
    massKg: spec.massKg ?? 1e20,
    orbitDays: spec.orbitDays ?? null,
    yearDays: spec.yearDays ?? null,
    semiMajorAU: spec.semiMajorAU ?? 1,
    eccentricity: spec.eccentricity ?? 0,
    inclinationDeg: spec.inclinationDeg ?? 0,
    centric: spec.centric ?? 'Heliocentric',
    tagline: spec.tagline ?? '',
    blurb: spec.blurb ?? '',
    ...spec,
  };
}

/**
 * Real-shaped 11-body metadata, frozen like data.js. Values mirror the
 * astro-model contract; tests stay self-contained and never import data.js.
 */
const BODIES = Object.freeze([
  makeBody({
    id: 'sun',
    name: 'Sun',
    kind: 'star',
    parentId: null,
    symbol: '☉',
    radiusKm: 695700,
    massKg: 1.9885e30,
    orbitDays: null,
    yearDays: null,
    semiMajorAU: 0,
  }),
  makeBody({
    id: 'mercury',
    name: 'Mercury',
    parentId: 'sun',
    orbitDays: 87.9691,
    yearDays: 87.9691,
    semiMajorAU: 0.38709927,
    eccentricity: 0.20563593,
    inclinationDeg: 7.00497902,
  }),
  makeBody({
    id: 'venus',
    name: 'Venus',
    parentId: 'sun',
    orbitDays: 224.701,
    yearDays: 224.701,
    semiMajorAU: 0.72333566,
    eccentricity: 0.00677672,
    inclinationDeg: 3.39467605,
  }),
  makeBody({
    id: 'earth',
    name: 'Earth',
    parentId: 'sun',
    orbitDays: 365.256,
    yearDays: 365.256,
    semiMajorAU: 1.00000261,
    eccentricity: 0.01671123,
    inclinationDeg: 0.00001531,
  }),
  makeBody({
    id: 'moon',
    name: 'Moon',
    kind: 'moon',
    parentId: 'earth',
    symbol: '☾',
    radiusKm: 1737.4,
    massKg: 7.342e22,
    orbitDays: MOON_ORBIT_DAYS,
    yearDays: 365.256,
    semiMajorAU: MOON_RADIUS_AU,
    eccentricity: 0.0549,
    inclinationDeg: 5.145,
  }),
  makeBody({
    id: 'mars',
    name: 'Mars',
    parentId: 'sun',
    orbitDays: 686.98,
    yearDays: 686.98,
    semiMajorAU: 1.52371034,
    eccentricity: 0.0933941,
    inclinationDeg: 1.84969142,
  }),
  makeBody({
    id: 'jupiter',
    name: 'Jupiter',
    parentId: 'sun',
    orbitDays: 4332.589,
    yearDays: 4332.589,
    semiMajorAU: 5.202887,
    eccentricity: 0.04838624,
    inclinationDeg: 1.30439695,
  }),
  makeBody({
    id: 'saturn',
    name: 'Saturn',
    parentId: 'sun',
    orbitDays: 10759.22,
    yearDays: 10759.22,
    semiMajorAU: 9.53667594,
    eccentricity: 0.05386179,
    inclinationDeg: 2.48599187,
  }),
  makeBody({
    id: 'uranus',
    name: 'Uranus',
    parentId: 'sun',
    orbitDays: 30685.4,
    yearDays: 30685.4,
    semiMajorAU: 19.18916464,
    eccentricity: 0.04725744,
    inclinationDeg: 0.77263783,
  }),
  makeBody({
    id: 'neptune',
    name: 'Neptune',
    parentId: 'sun',
    orbitDays: 60189,
    yearDays: 60189,
    semiMajorAU: 30.06992276,
    eccentricity: 0.00859048,
    inclinationDeg: 1.77004347,
  }),
  makeBody({
    id: 'pluto',
    name: 'Pluto',
    kind: 'dwarf',
    parentId: 'sun',
    orbitDays: 90560,
    yearDays: 90560,
    semiMajorAU: 39.48211675,
    eccentricity: 0.2488273,
    inclinationDeg: 17.14001206,
  }),
]);

const BY_ID = Object.freeze(
  Object.fromEntries(BODIES.map((body) => [body.id, body]))
);

/** Deterministic phase per planet so the fake system never has a degenerate pair. */
const PHASES = Object.freeze(
  Object.fromEntries(
    BODIES.filter((body) => body.id !== 'sun' && body.id !== 'moon').map(
      (body, index) => [body.id, 0.2 + index * 0.7]
    )
  )
);

/** Position on a prescribed circular orbit in the ecliptic plane. */
function circularPosition(radiusAU, periodDays, phase, jd) {
  const angle = phase + (TAU * (jd - J2000_JD)) / periodDays;
  return [radiusAU * Math.cos(angle), radiusAU * Math.sin(angle), 0];
}

/**
 * A complete fake solar system: planets on prescribed circular heliocentric
 * orbits and the Moon on a circular geocentric orbit around Earth.
 */
function fakeSolarSystemPositions(jd) {
  const positions = { sun: [0, 0, 0] };
  for (const body of BODIES) {
    if (body.id === 'sun' || body.id === 'moon') continue;
    positions[body.id] = circularPosition(
      body.semiMajorAU,
      body.yearDays,
      PHASES[body.id],
      jd
    );
  }
  const earth = positions.earth;
  const lunar = circularPosition(
    MOON_RADIUS_AU,
    MOON_ORBIT_DAYS,
    0.35,
    jd
  );
  positions.moon = [
    earth[0] + lunar[0],
    earth[1] + lunar[1],
    earth[2] + lunar[2],
  ];
  return positions;
}

function assertClose(actual, expected, tolerance = 1e-9, message = '') {
  const delta = Math.abs(actual - expected);
  assert.ok(
    Number.isFinite(delta) && delta <= tolerance,
    `${message || 'value'}: expected ${expected}, got ${actual} (Δ ${delta})`
  );
}

function assertPointClose(actual, expected, tolerance = 1e-9, message = '') {
  assert.equal(actual.length, 3, `${message}: point must be [x,y,z]`);
  for (let i = 0; i < 3; i += 1) {
    assertClose(actual[i], expected[i], tolerance, `${message} axis ${i}`);
  }
}

function assertFinitePoints(points, message = 'points') {
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    assert.equal(point.length, 3, `${message}[${i}] must have 3 components`);
    for (let axis = 0; axis < 3; axis += 1) {
      assert.ok(
        Number.isFinite(point[axis]),
        `${message}[${i}][${axis}] must be finite, got ${point[axis]}`
      );
    }
  }
}

/** Validate structure, sample count, finite points, and the fade profile. */
function assertValidTrace(trace, expectedSamples) {
  assert.equal(trace.points.length, expectedSamples);
  assert.equal(trace.alphas.length, expectedSamples);
  assert.ok(
    Number.isFinite(trace.windowDays) && trace.windowDays > 0,
    `windowDays must be positive and finite, got ${trace.windowDays}`
  );
  assert.equal(trace.alphas[0], 0);
  assertClose(trace.alphas[expectedSamples - 1], 0.9, 1e-12, 'head alpha');
  for (let i = 1; i < expectedSamples; i += 1) {
    assert.ok(
      trace.alphas[i] > trace.alphas[i - 1],
      `alpha[${i}] (${trace.alphas[i]}) must exceed alpha[${i - 1}] (${
        trace.alphas[i - 1]
      })`
    );
    assert.ok(trace.alphas[i] >= 0 && trace.alphas[i] <= 1);
  }
  assertFinitePoints(trace.points);
}

function expectedRelative(positions, bodyId, centerId) {
  const target = positions[bodyId];
  const center = positions[centerId];
  return [
    target[0] - center[0],
    target[1] - center[1],
    target[2] - center[2],
  ];
}

/* ------------------------------------------------------------------------- */
/* 1. Atlas compression                                                      */
/* ------------------------------------------------------------------------- */

test('compressDistance: known values, monotonicity, sanitised edge cases', () => {
  assert.equal(compressDistance(0), 0);
  assert.equal(compressDistance(-0.5), 0);
  assert.equal(compressDistance(-1e-12), 0);
  assert.equal(compressDistance(Number.NaN), 0);
  assert.equal(compressDistance(Number.POSITIVE_INFINITY), 0);
  assert.equal(compressDistance(Number.NEGATIVE_INFINITY), 0);
  assert.equal(compressDistance('1'), 0);

  // ln(1 + 0.18/0.18) = ln 2 exactly.
  assertClose(compressDistance(ATLAS_SCALE_AU), Math.LN2, 1e-15);
  // r = scale * (e - 1) -> ln(1 + (e - 1)) = 1 exactly.
  assertClose(
    compressDistance(ATLAS_SCALE_AU * (Math.E - 1)),
    1,
    1e-15
  );
  // 1 AU -> ln(1 + 1/0.18) ≈ 1.88 display AU.
  assertClose(compressDistance(1), Math.log1p(1 / ATLAS_SCALE_AU), 1e-15);

  let previous = -Infinity;
  const radii = [
    1e-9, 0.001, 0.05, 0.17, ATLAS_SCALE_AU, 0.2, 0.5, 1, 5.2, 9.5, 30,
    39.5, 1e4, 1e12,
  ];
  for (const radius of radii) {
    const compressed = compressDistance(radius);
    assert.ok(Number.isFinite(compressed), `compressDistance(${radius}) finite`);
    assert.ok(compressed > previous, `compressDistance monotonic at ${radius}`);
    previous = compressed;
  }
});

test('displayPosition: endpoints, radius interpolation, direction, immutability', () => {
  const p = Object.freeze([0.8, -0.6, 0.3]);
  const snapshot = [...p];

  const exact = displayPosition(p, 0);
  assert.deepEqual(exact, snapshot);
  assert.notEqual(exact, p, 'blend 0 must return a fresh array');
  assert.deepEqual([...p], snapshot, 'input must not be mutated');

  const trueRadius = Math.hypot(...p);
  const compressed = displayPosition(p, 1);
  const compressedRadius = Math.hypot(...compressed);
  assertClose(compressedRadius, compressDistance(trueRadius), 1e-12);
  assert.deepEqual(displayPosition(p, 2), compressed, 'blend clamps to 1');
  assert.deepEqual(displayPosition(p, -3), snapshot, 'blend clamps to 0');

  // Direction is preserved exactly: every component scales by the same factor.
  for (let i = 0; i < 3; i += 1) {
    assertClose(
      compressed[i] / p[i],
      compressed[0] / p[0],
      1e-12,
      `direction component ${i}`
    );
  }

  const midpoint = displayPosition(p, 0.5);
  const expectedMidRadius =
    (trueRadius + compressDistance(trueRadius)) / 2;
  assertClose(Math.hypot(...midpoint), expectedMidRadius, 1e-12);
  for (let i = 0; i < 3; i += 1) {
    assertClose(
      midpoint[i] / p[i],
      midpoint[0] / p[0],
      1e-12,
      `midpoint direction component ${i}`
    );
  }

  // Quarter blend interpolates linearly in radius.
  const quarter = displayPosition(p, 0.25);
  assertClose(
    Math.hypot(...quarter),
    trueRadius + (compressDistance(trueRadius) - trueRadius) * 0.25,
    1e-12
  );

  assert.deepEqual(displayPosition([0.36, 0, 0], 1), [
    Math.log(3),
    0,
    0,
  ]);
  assertClose(
    Math.hypot(...displayPosition([0.36, 0, 0], 1)),
    Math.log(3),
    1e-12
  );

  // Degenerate and malformed inputs stay finite and never produce NaN.
  assert.deepEqual(displayPosition([0, 0, 0], 0.5), [0, 0, 0]);
  assert.deepEqual(displayPosition([0, 0, 0], 1), [0, 0, 0]);
  assert.deepEqual(displayPosition([Number.NaN, 1, 0], 0.5), [0, 0, 0]);
  assert.deepEqual(displayPosition([0, Number.POSITIVE_INFINITY, 0], 0.5), [
    0, 0, 0,
  ]);
  assert.deepEqual(displayPosition(null, 0.5), [0, 0, 0]);
  assert.deepEqual(displayPosition(undefined, 0.5), [0, 0, 0]);
  assert.deepEqual(displayPosition([1, 2, 3], Number.NaN), [1, 2, 3]);
});

/* ------------------------------------------------------------------------- */
/* 2. Trace window rules                                                     */
/* ------------------------------------------------------------------------- */

test('getTraceWindowDays: heliocentric and geocentric orbital windows', () => {
  const sun = BY_ID.sun;
  const earth = BY_ID.earth;
  const moon = BY_ID.moon;

  // Heliocentric: one sidereal orbit of the target.
  assert.equal(getTraceWindowDays(BY_ID.mercury, sun), 87.9691);
  assert.equal(getTraceWindowDays(BY_ID.venus, sun), 224.701);
  assert.equal(getTraceWindowDays(earth, sun), 365.256);
  assert.equal(getTraceWindowDays(BY_ID.jupiter, sun), 4332.589);
  assert.equal(getTraceWindowDays(BY_ID.pluto, sun), 90560);

  // Geocentric: one sidereal lunar month.
  assert.equal(getTraceWindowDays(moon, earth), MOON_ORBIT_DAYS);
});

test('getTraceWindowDays: selenocentric and solar special cases', () => {
  const sun = BY_ID.sun;
  const earth = BY_ID.earth;
  const moon = BY_ID.moon;

  // The centre orbits the target: use the centre's own period.
  assert.equal(getTraceWindowDays(earth, moon), MOON_ORBIT_DAYS);
  // ...one lunar month, not Earth's year.
  assert.equal(getTraceWindowDays(sun, moon), 365.256);
  // ...and never the Moon's 27.3-day orbit for the Sun.
  assert.equal(getTraceWindowDays(sun, earth), 365.256);

  // The Moon from a non-Earth viewpoint is a local ~60-day trail.
  assertClose(
    getTraceWindowDays(moon, sun),
    2.2 * MOON_ORBIT_DAYS,
    1e-12,
    'Moon from Sun'
  );
  assertClose(
    getTraceWindowDays(moon, BY_ID.mars),
    2.2 * MOON_ORBIT_DAYS,
    1e-12,
    'Moon from Mars'
  );
});

test('getTraceWindowDays: planet-centric synodic rosettes and clamps', () => {
  const earth = BY_ID.earth;
  const mars = BY_ID.mars;
  const pluto = BY_ID.pluto;
  const neptune = BY_ID.neptune;

  const marsSynodic = 1 / Math.abs(1 / 365.256 - 1 / 686.98);
  assertClose(
    getTraceWindowDays(mars, earth),
    2.5 * marsSynodic,
    1e-9,
    'Mars from Earth'
  );

  // Pluto/Neptune synodic period is ~180,000 days; the window caps at 40 years.
  const tooLong = 2.5 * (1 / Math.abs(1 / 90560 - 1 / 60189));
  assert.ok(tooLong > 40 * 365.25);
  assert.equal(getTraceWindowDays(pluto, neptune), 40 * 365.25);

  // Very different years -> synodic approaches the faster period; floor is 120 d.
  const fast = makeBody({
    id: 'fast',
    parentId: 'anchor-a',
    orbitDays: null,
    yearDays: 10,
  });
  const slow = makeBody({
    id: 'slow',
    parentId: 'anchor-b',
    orbitDays: null,
    yearDays: 100,
  });
  assert.ok(2.5 * (1 / Math.abs(1 / 10 - 1 / 100)) < 120);
  assert.equal(getTraceWindowDays(fast, slow), 120);

  // Equal years => no synodic cycle (Infinity) => the 40-year ceiling.
  const twinA = makeBody({ id: 'twin-a', parentId: null, yearDays: 500 });
  const twinB = makeBody({ id: 'twin-b', parentId: null, yearDays: 500 });
  assert.equal(getTraceWindowDays(twinA, twinB), 40 * 365.25);
});

test('getTraceWindowDays: missing/null metadata degrades gracefully', () => {
  const sun = BY_ID.sun;
  const blankCenter = makeBody({ id: 'blank', parentId: null, yearDays: null });
  const blankTarget = makeBody({
    id: 'blank-target',
    parentId: 'somewhere',
    orbitDays: null,
    yearDays: null,
  });

  const fallback = getTraceWindowDays(blankTarget, blankCenter);
  assert.ok(Number.isFinite(fallback) && fallback > 0);
  assert.equal(fallback, 40 * 365.25);

  // Sun target with a centre that lacks yearDays still yields a finite period.
  assert.equal(getTraceWindowDays(sun, blankCenter), 365.25);

  // Moon without orbitDays still gets the local-lunar-trail default.
  const moonWithMissingPeriod = makeBody({
    id: 'moon',
    parentId: 'earth',
    orbitDays: null,
    yearDays: null,
  });
  assertClose(
    getTraceWindowDays(moonWithMissingPeriod, BY_ID.mars),
    2.2 * MOON_ORBIT_DAYS,
    1e-12
  );

  assert.throws(
    () => getTraceWindowDays(null, blankCenter),
    (error) => error instanceof TypeError
  );
  assert.throws(
    () => getTraceWindowDays(blankTarget, null),
    (error) => error instanceof TypeError
  );
});

/* ------------------------------------------------------------------------- */
/* 3. Synthetic two-body circle                                              */
/* ------------------------------------------------------------------------- */

test('buildTraces: circular two-body system, endpoints, fade, efficiency', () => {
  const periodDays = 300;
  const radiusAU = 2;
  const jd = 2460123.75;
  const samples = 200;

  const center = makeBody({
    id: 'barycenter',
    kind: 'star',
    parentId: null,
    orbitDays: null,
    yearDays: null,
  });
  const planet = makeBody({
    id: 'planet',
    parentId: 'barycenter',
    orbitDays: periodDays,
    yearDays: periodDays,
  });

  const calls = [];
  const getPositions = (time) => {
    calls.push(time);
    return {
      barycenter: [0, 0, 0],
      planet: circularPosition(radiusAU, periodDays, 0.3, time),
    };
  };

  const traces = buildTraces({
    jd,
    centerId: 'barycenter',
    bodies: [center, planet],
    getPositions,
    samples,
  });

  assert.equal(traces.length, 1, 'the centre itself must not get a trace');
  const trace = traces[0];
  assert.equal(trace.bodyId, 'planet');
  assert.equal(trace.centerId, 'barycenter');
  assert.equal(trace.windowDays, periodDays);
  assert.equal(trace.isClosed, true);
  assert.equal(trace.points.length, samples);
  assert.equal(trace.alphas.length, samples);

  // Exactly one provider call per sample; pinned endpoints.
  assert.equal(calls.length, samples);
  assert.equal(calls[0], jd - periodDays);
  assert.equal(calls[samples - 1], jd);

  assertValidTrace(trace, samples);
  assertFinitePoints(trace.points);

  // Raw (uncompressed) points lie on the circle of radius 2.
  for (const point of trace.points) {
    assertClose(Math.hypot(...point), radiusAU, 1e-12, 'orbit radius');
    assert.equal(point[2], 0);
  }

  // First sample is the position one full period ago; last is "now".
  assertPointClose(
    trace.points[0],
    circularPosition(radiusAU, periodDays, 0.3, jd - periodDays),
    1e-12,
    'tail'
  );
  assertPointClose(
    trace.points[samples - 1],
    circularPosition(radiusAU, periodDays, 0.3, jd),
    1e-12,
    'head'
  );

  // A sidereal period closes the loop geometrically.
  assertPointClose(trace.points[0], trace.points[samples - 1], 1e-9, 'seam');
});

/* ------------------------------------------------------------------------- */
/* 4. Synthetic geocentric system                                            */
/* ------------------------------------------------------------------------- */

test('buildTraces: geocentric system subtracts the moving Earth at each instant', () => {
  const jd = 2460676.5;
  const samples = 120;
  const sun = BY_ID.sun;
  const earth = BY_ID.earth;
  const mars = BY_ID.mars;

  const basePositions = (time) => ({
    sun: [0, 0, 0],
    earth: circularPosition(earth.semiMajorAU, earth.yearDays, 0.4, time),
    mars: circularPosition(mars.semiMajorAU, mars.yearDays, 1.1, time),
  });

  const traces = buildTraces({
    jd,
    centerId: 'earth',
    bodies: [sun, earth, mars],
    getPositions: basePositions,
    samples,
  });

  assert.equal(traces.length, 2, 'Earth itself is omitted');
  assert.deepEqual(
    traces.map((trace) => trace.bodyId),
    ['sun', 'mars'],
    'input order is preserved'
  );

  const sunTrace = traces.find((trace) => trace.bodyId === 'sun');
  const marsTrace = traces.find((trace) => trace.bodyId === 'mars');
  assert.ok(sunTrace && marsTrace);

  // Sun's apparent year, not the centre's orbit around the Sun.
  assert.equal(sunTrace.windowDays, earth.yearDays);
  assert.equal(sunTrace.isClosed, false);

  // Mars gets the clamped 2.5-synodic-period geocentric rosette window.
  const marsWindow =
    2.5 * (1 / Math.abs(1 / earth.yearDays - 1 / mars.yearDays));
  assertClose(marsTrace.windowDays, marsWindow, 1e-9);
  assert.equal(marsTrace.isClosed, false);

  const nowPositions = basePositions(jd);
  for (const trace of traces) {
    assertValidTrace(trace, samples);

    const startJd = jd - trace.windowDays;
    const stepDays = trace.windowDays / (samples - 1);

    for (let i = 0; i < samples; i += 1) {
      const sampleJd = i === samples - 1 ? jd : startJd + stepDays * i;
      const expected = expectedRelative(
        basePositions(sampleJd),
        trace.bodyId,
        'earth'
      );
      assertPointClose(
        trace.points[i],
        expected,
        1e-12,
        `${trace.bodyId} sample ${i}`
      );
    }

    // The head is exactly the body's current centre-relative position.
    assertPointClose(
      trace.points[samples - 1],
      expectedRelative(nowPositions, trace.bodyId, 'earth'),
      1e-12,
      `${trace.bodyId} current position`
    );
  }

  // Earth-relative Mars is demonstrably not Mars' heliocentric position:
  // centre subtraction must actually happen.
  assert.notDeepEqual(
    marsTrace.points[samples - 1],
    nowPositions.mars
  );
  assertPointClose(
    marsTrace.points[samples - 1],
    [
      nowPositions.mars[0] - nowPositions.earth[0],
      nowPositions.mars[1] - nowPositions.earth[1],
      nowPositions.mars[2] - nowPositions.earth[2],
    ],
    1e-12
  );

  // Seen from Earth, the Sun is always exactly opposite Earth's heliocentric
  // position.
  for (let i = 0; i < samples; i += 12) {
    const time = i === samples - 1 ? jd : jd - sunTrace.windowDays + (sunTrace.windowDays / (samples - 1)) * i;
    const earthPosition = basePositions(time).earth;
    assertPointClose(
      sunTrace.points[i],
      [-earthPosition[0], -earthPosition[1], -earthPosition[2]],
      1e-12,
      `Sun anti-position sample ${i}`
    );
  }
});

/* ------------------------------------------------------------------------- */
/* 5. Fake eleven-body solar system                                          */
/* ------------------------------------------------------------------------- */

test('buildTraces: 11-body fake solar system smoke test (heliocentric)', () => {
  const jd = J2000_JD + 10000.5;
  const samples = 240;

  const traces = buildTraces({
    jd,
    centerId: 'sun',
    bodies: BODIES,
    getPositions: fakeSolarSystemPositions,
    samples,
  });

  assert.equal(traces.length, BODIES.length - 1);
  const traceById = new Map(traces.map((trace) => [trace.bodyId, trace]));
  assert.equal(traceById.size, 10);
  assert.equal(traceById.has('sun'), false, 'Sun is the centre');

  const nowPositions = fakeSolarSystemPositions(jd);

  for (const body of BODIES) {
    if (body.id === 'sun') continue;
    const trace = traceById.get(body.id);
    assert.ok(trace, `missing trace for ${body.id}`);
    assert.equal(trace.centerId, 'sun');
    assertValidTrace(trace, samples);
    assertPointClose(
      trace.points[samples - 1],
      expectedRelative(nowPositions, body.id, 'sun'),
      1e-12,
      `${body.id} head`
    );

    if (body.id === 'moon') {
      // The Moon-from-Sun special case: a short local trail, not a ring.
      assertClose(trace.windowDays, 2.2 * MOON_ORBIT_DAYS, 1e-12);
      assert.ok(trace.windowDays < 90);
      assert.equal(trace.isClosed, false);
      // The trail hugs Earth's 1 AU orbit.
      for (const point of trace.points) {
        assertClose(Math.hypot(...point), 1.00000261, 0.003);
      }
    } else {
      assert.equal(
        trace.windowDays,
        body.orbitDays,
        `${body.id} gets one sidereal orbit`
      );
      assert.equal(trace.isClosed, true);
    }
  }
});

test('buildTraces: 11-body fake solar system smoke test (geocentric)', () => {
  const jd = J2000_JD + 2500.25;
  const samples = 120;

  const traces = buildTraces({
    jd,
    centerId: 'earth',
    bodies: BODIES,
    getPositions: fakeSolarSystemPositions,
    samples,
  });

  assert.equal(traces.length, BODIES.length - 1);
  const traceById = new Map(traces.map((trace) => [trace.bodyId, trace]));
  assert.equal(traceById.has('earth'), false);

  const moonTrace = traceById.get('moon');
  assert.ok(moonTrace);
  assert.equal(moonTrace.windowDays, MOON_ORBIT_DAYS);
  assert.equal(moonTrace.isClosed, true);
  // One lunar month around Earth, constant geocentric radius.
  for (const point of moonTrace.points) {
    assertClose(Math.hypot(...point), MOON_RADIUS_AU, 1e-12);
  }

  const sunTrace = traceById.get('sun');
  assert.ok(sunTrace);
  assert.equal(sunTrace.windowDays, 365.256);
  assert.equal(sunTrace.isClosed, false);

  const nowPositions = fakeSolarSystemPositions(jd);
  for (const trace of traces) {
    assertValidTrace(trace, samples);
    assertPointClose(
      trace.points[samples - 1],
      expectedRelative(nowPositions, trace.bodyId, 'earth'),
      1e-12,
      `${trace.bodyId} head`
    );
  }
});

/* ------------------------------------------------------------------------- */
/* 6. Defensive behaviour and helpers                                        */
/* ------------------------------------------------------------------------- */

test('relativePosition: exact subtraction, Map support, null on missing data', () => {
  const positions = Object.freeze({
    a: Object.freeze([1.5, -2, 0.25]),
    b: Object.freeze([0.5, 0.5, -0.75]),
  });

  assert.deepEqual(relativePosition(positions, 'a', 'b'), [1, -2.5, 1]);
  assert.deepEqual(relativePosition(positions, 'a', 'a'), [0, 0, 0]);
  assert.equal(relativePosition(positions, 'a', 'missing'), null);
  assert.equal(relativePosition(positions, 'missing', 'a'), null);
  assert.equal(relativePosition({}, 'a', 'b'), null);
  assert.equal(relativePosition(null, 'a', 'b'), null);
  assert.equal(
    relativePosition({ a: [Number.NaN, 0, 0], b: [0, 0, 0] }, 'a', 'b'),
    null
  );
  assert.equal(
    relativePosition({ a: [1, 0], b: [0, 0, 0] }, 'a', 'b'),
    null
  );

  const map = new Map([
    ['a', [2, 0, 0]],
    ['b', [1, -1, 0]],
  ]);
  assert.deepEqual(relativePosition(map, 'a', 'b'), [1, 1, 0]);
});

test('synodicPeriodDays: formula, symmetry, degenerate periods', () => {
  const expected = 1 / Math.abs(1 / 365.256 - 1 / 686.98);
  assertClose(synodicPeriodDays(365.256, 686.98), expected, 1e-9);
  assertClose(synodicPeriodDays(686.98, 365.256), expected, 1e-9);
  assertClose(synodicPeriodDays(1, 2), 2, 1e-12);

  assert.equal(synodicPeriodDays(365.256, 365.256), Infinity);
  assert.equal(synodicPeriodDays(null, 365.256), Infinity);
  assert.equal(synodicPeriodDays(365.256, null), Infinity);
  assert.equal(synodicPeriodDays(0, 365.256), Infinity);
  assert.equal(synodicPeriodDays(Number.NaN, 365.256), Infinity);
  assert.equal(synodicPeriodDays(-1, 365.256), Infinity);
});

test('clampNumber: bounds, NaN, infinities, reversed ranges', () => {
  assert.equal(clampNumber(5, 0, 10), 5);
  assert.equal(clampNumber(-1, 0, 10), 0);
  assert.equal(clampNumber(11, 0, 10), 10);
  assert.equal(clampNumber(Number.NaN, 2, 8), 2);
  assert.equal(clampNumber(Number.POSITIVE_INFINITY, 2, 8), 8);
  assert.equal(clampNumber(Number.NEGATIVE_INFINITY, 2, 8), 2);
  assert.equal(clampNumber(5, 10, 0), 5, 'reversed bounds are tolerated');
  assert.equal(clampNumber(5, 0, 0), 0);
  assert.equal(clampNumber(undefined, 2, 8), 2);
});

test('buildTraces: errors are clear and bad data skips bodies', () => {
  const center = makeBody({
    id: 'center',
    kind: 'star',
    parentId: null,
    orbitDays: null,
    yearDays: null,
  });
  const planet = makeBody({
    id: 'planet',
    parentId: 'center',
    orbitDays: 100,
    yearDays: 100,
  });
  const bodies = [center, planet];
  const goodPositions = () => ({
    center: [0, 0, 0],
    planet: [1, 0, 0],
  });

  assert.throws(
    () =>
      buildTraces({
        jd: J2000_JD,
        centerId: 'nope',
        bodies,
        getPositions: goodPositions,
      }),
    (error) =>
      error instanceof RangeError && /unknown centerId/.test(error.message)
  );

  assert.throws(
    () =>
      buildTraces({
        jd: J2000_JD,
        centerId: 'center',
        bodies,
        getPositions: null,
      }),
    (error) => error instanceof TypeError
  );

  assert.throws(
    () =>
      buildTraces({
        jd: Number.NaN,
        centerId: 'center',
        bodies,
        getPositions: goodPositions,
      }),
    (error) => error instanceof TypeError
  );

  assert.throws(
    () =>
      buildTraces({
        jd: J2000_JD,
        centerId: 'center',
        bodies: null,
        getPositions: goodPositions,
      }),
    (error) => error instanceof TypeError
  );

  // Missing target position -> body is skipped, never a partial trace.
  assert.deepEqual(
    buildTraces({
      jd: J2000_JD,
      centerId: 'center',
      bodies,
      getPositions: () => ({ center: [0, 0, 0] }),
    }),
    []
  );

  // One bad body must not take valid bodies down with it.
  const ghost = makeBody({
    id: 'ghost',
    parentId: 'center',
    orbitDays: 200,
    yearDays: 200,
  });
  const partial = buildTraces({
    jd: J2000_JD,
    centerId: 'center',
    bodies: [center, ghost, planet],
    getPositions: () => ({
      center: [0, 0, 0],
      planet: [1, 0, 0],
    }),
  });
  assert.equal(partial.length, 1);
  assert.equal(partial[0].bodyId, 'planet');

  // A single missing sample invalidates the whole body: no partial tail.
  let sampleIndex = 0;
  assert.deepEqual(
    buildTraces({
      jd: J2000_JD,
      centerId: 'center',
      bodies: [center, planet],
      samples: 5,
      getPositions: () => {
        sampleIndex += 1;
        return sampleIndex === 3
          ? { center: [0, 0, 0] }
          : { center: [0, 0, 0], planet: [1, 0, 0] };
      },
    }),
    []
  );

  // Non-finite position -> skipped (no NaN reaches the renderer).
  assert.deepEqual(
    buildTraces({
      jd: J2000_JD,
      centerId: 'center',
      bodies,
      getPositions: () => ({ center: [0, 0, 0], planet: [Number.NaN, 0, 0] }),
    }),
    []
  );

  // Provider failure -> skipped rather than crashing the frame.
  assert.deepEqual(
    buildTraces({
      jd: J2000_JD,
      centerId: 'center',
      bodies,
      getPositions: () => {
        throw new Error('boom');
      },
    }),
    []
  );

  // samples is normalised to at least two points.
  const twoSamples = buildTraces({
    jd: J2000_JD,
    centerId: 'center',
    bodies,
    getPositions: goodPositions,
    samples: 1,
  });
  assert.equal(twoSamples.length, 1);
  assert.equal(twoSamples[0].points.length, 2);
  assert.deepEqual(twoSamples[0].alphas, [0, 0.9]);

  // No mutation of metadata: BODIES is frozen and buildTraces succeeded above.
  assert.ok(Object.isFrozen(BODIES));
});

test('buildTraces: one getPositions call per sample per trace (multi-trace)', () => {
  const jd = J2000_JD + 123.5;
  const samples = 60;
  const center = makeBody({
    id: 'hub',
    kind: 'star',
    parentId: null,
    orbitDays: null,
    yearDays: null,
  });
  const bodies = [center];
  for (let i = 0; i < 3; i += 1) {
    bodies.push(
      makeBody({
        id: `satellite-${i}`,
        parentId: 'hub',
        orbitDays: 200 + i * 100,
        yearDays: 200 + i * 100,
      })
    );
  }

  let calls = 0;
  const traces = buildTraces({
    jd,
    centerId: 'hub',
    bodies,
    samples,
    getPositions: (time) => {
      calls += 1;
      const snapshot = { hub: [0, 0, 0] };
      for (const body of bodies) {
        if (body.id === 'hub') continue;
        snapshot[body.id] = circularPosition(
          1,
          body.orbitDays,
          0.1,
          time
        );
      }
      return snapshot;
    },
  });

  assert.equal(traces.length, 3);
  assert.ok(
    calls <= 3 * samples,
    `expected at most ${3 * samples} provider calls, got ${calls}`
  );
  for (const trace of traces) assertValidTrace(trace, samples);
});

test('buildTraces: optional direct provider evaluates only target and center', () => {
  const jd = J2000_JD + 400;
  const samples = 24;
  const center = makeBody({
    id: 'center',
    name: 'Center',
    kind: 'star',
    orbitDays: null,
    yearDays: null,
    semiMajorAU: 0,
  });
  const planet = makeBody({
    id: 'planet',
    name: 'Planet',
    parentId: 'center',
    orbitDays: 100,
    yearDays: 100,
    semiMajorAU: 1,
  });

  let directCalls = 0;
  let bulkCalls = 0;
  const traces = buildTraces({
    jd,
    centerId: 'center',
    bodies: [center, planet],
    samples,
    getPositions: () => {
      bulkCalls += 1;
      throw new Error('bulk provider should not be called when getPosition is supplied');
    },
    getPosition: (id, time) => {
      directCalls += 1;
      if (id === 'center') return [0, 0, 0];
      const angle = ((time - jd) / 100) * TAU;
      return [Math.cos(angle), Math.sin(angle), 0];
    },
  });

  assert.equal(traces.length, 1);
  assert.equal(bulkCalls, 0, 'bulk getPositions must be bypassed');
  assert.equal(directCalls, samples * 2, 'one call each for target and center per sample');
  assert.equal(traces[0].bodyId, 'planet');
  assert.equal(traces[0].points.length, samples);
  assert.ok(Math.abs(traces[0].points[samples - 1][0] - 1) < 1e-12);
  assert.ok(Math.abs(traces[0].points[samples - 1][1]) < 1e-12);
  for (const point of traces[0].points) {
    assert.ok(point.every(Number.isFinite));
  }
});

/* ------------------------------------------------------------------------- */
/* 7. Performance sanity (no timing assertions)                              */
/* ------------------------------------------------------------------------- */

test('buildTraces: 10 bodies × 480 samples completes comfortably', (t) => {
  const jd = J2000_JD + 5000;
  const samples = 480;
  let calls = 0;

  const startedAt = performance.now();
  const traces = buildTraces({
    jd,
    centerId: 'sun',
    bodies: BODIES,
    samples,
    getPositions: (time) => {
      calls += 1;
      return fakeSolarSystemPositions(time);
    },
  });
  const elapsedMs = performance.now() - startedAt;

  t.diagnostic(
    `10 traces × ${samples} samples in ${elapsedMs.toFixed(1)} ms; ` +
      `${calls} provider calls`
  );

  assert.equal(traces.length, 10);
  assert.ok(calls <= 10 * samples);
  for (const trace of traces) {
    assert.equal(trace.points.length, samples);
    assertValidTrace(trace, samples);
  }
});


/* ------------------------------------------------------------------------- */
/* Complete-orbit traces for the Always style                                */
/* ------------------------------------------------------------------------- */

test('buildCompleteOrbitTraces: every non-center body gets a closed full orbit', () => {
  const jd = J2000_JD + 8000;
  const samples = 64;
  const positions = fakeSolarSystemPositions(jd);
  const traces = buildCompleteOrbitTraces({
    jd,
    centerId: 'earth',
    bodies: BODIES,
    getPositions: fakeSolarSystemPositions,
    samples,
  });
  const byId = new Map(traces.map((trace) => [trace.bodyId, trace]));

  assert.equal(traces.length, BODIES.length - 1);
  assert.equal(byId.has('earth'), false);

  for (const trace of traces) {
    assert.equal(trace.centerId, 'earth');
    assert.equal(trace.fullOrbit, true);
    assert.equal(trace.isClosed, true);
    assert.equal(trace.points.length, samples);
    assert.equal(trace.alphas.length, samples);
    assert.equal(trace.alphas[0], 0.9);
    assert.equal(trace.alphas[samples - 1], 0.9);
    assert.ok(trace.windowDays > 0 && Number.isFinite(trace.windowDays));
    assertFinitePoints(trace.points);
    assertPointClose(
      trace.points[trace.points.length - 1],
      expectedRelative(positions, trace.bodyId, 'earth'),
      1e-12,
      `${trace.bodyId} current position`
    );
    // A complete orbit is a closed loop: the first and last samples coincide.
    assertPointClose(trace.points[0], trace.points[trace.points.length - 1], 1e-6, `${trace.bodyId} loop closure`);
  }

  // The Moon is translated into Earth's frame and still forms a full lunar loop.
  const moon = byId.get('moon');
  assertClose(moon.windowDays, MOON_ORBIT_DAYS, 1e-9, 'lunar period');
});

test('buildCompleteOrbitTraces: heliocentric ellipses and validation', () => {
  const jd = J2000_JD + 1000;
  const positions = fakeSolarSystemPositions(jd);
  const traces = buildCompleteOrbitTraces({
    jd,
    centerId: 'sun',
    bodies: BODIES,
    getPosition: (bodyId, time) => fakeSolarSystemPositions(time)[bodyId],
    samples: 48,
  });
  const earth = traces.find((trace) => trace.bodyId === 'earth');

  assert.ok(earth);
  assert.equal(earth.fullOrbit, true);
  assertPointClose(earth.points[earth.points.length - 1], positions.earth, 1e-12, 'Earth current');
  assertPointClose(earth.points[0], positions.earth, 1e-6, 'Earth returns to start after one year');
  // The Sun has no parent and is not a target in a heliocentric view.
  assert.equal(traces.some((trace) => trace.bodyId === 'sun'), false);

  assert.throws(
    () => buildCompleteOrbitTraces({ jd, centerId: 'sun', bodies: BODIES, samples: 8 }),
    /getPosition or getPositions/
  );
  assert.throws(
    () => buildCompleteOrbitTraces({
      jd,
      centerId: 'not-a-world',
      bodies: BODIES,
      getPositions: fakeSolarSystemPositions,
      samples: 8,
    }),
    /unknown centerId/
  );
});


test('getTraceWindowDays: history span multiplies base windows and respects caps', () => {
  const earth = BY_ID.earth;
  const sun = BY_ID.sun;
  const pluto = BY_ID.pluto;

  assert.equal(getTraceWindowDays(earth, sun, 1), 365.256);
  assertClose(getTraceWindowDays(earth, sun, 2), 365.256 * 2, 1e-9);
  assertClose(getTraceWindowDays(earth, sun, 0.5), 365.256 * 0.5, 1e-9);
  assertClose(getTraceWindowDays(earth, sun, 10), 365.256 * 10, 1e-9);

  // An outer-planet orbit can push beyond the generic cap but is never
  // shortened. Pluto's base (≈248 yr) extends to the 300-year ceiling.
  assert.equal(getTraceWindowDays(pluto, sun, 10), 300 * 365.25);
  const ultraSlow = makeBody({
    id: 'ultra-slow',
    parentId: 'sun',
    orbitDays: 400 * 365.25,
    yearDays: 400 * 365.25,
  });
  assert.equal(getTraceWindowDays(ultraSlow, sun, 50), 400 * 365.25);

  // Generic windows can exceed their 40-year base, but stop at 300 years.
  const slowA = makeBody({ id: 'slow-a', yearDays: 1000, parentId: null });
  const slowB = makeBody({ id: 'slow-b', yearDays: 1000.01, parentId: null });
  const slowBase = getTraceWindowDays(slowA, slowB);
  assertClose(getTraceWindowDays(slowA, slowB, 2), slowBase * 2, 1e-9);
  assertClose(getTraceWindowDays(slowA, slowB, 50), 300 * 365.25, 1e-9);

  // Extended options and the documented clamp.
  assert.equal(getTraceWindowDays(earth, sun, Number.NaN), 365.256);
  assert.equal(getTraceWindowDays(earth, sun, 0), 365.256);
  assertClose(getTraceWindowDays(earth, sun, 20), 365.256 * 20, 1e-9);
  assertClose(getTraceWindowDays(earth, sun, 100), 365.256 * 50, 1e-9);
});

test('buildTraces: history span changes the sampled window', () => {
  const jd = J2000_JD + 1200;
  const sun = BY_ID.sun;
  const traces = buildTraces({
    jd,
    centerId: 'sun',
    bodies: BODIES,
    getPositions: fakeSolarSystemPositions,
    span: 2,
    samples: 12,
  });
  const earth = traces.find((trace) => trace.bodyId === 'earth');
  assert.ok(earth);
  assertClose(earth.windowDays, getTraceWindowDays(BY_ID.earth, sun, 2), 1e-12);
  assert.equal(earth.points.length, 12);
  assertPointClose(
    earth.points[earth.points.length - 1],
    fakeSolarSystemPositions(jd).earth,
    1e-12,
    'Earth head position',
  );
});

test('trace builders expose Julian-day endpoints for point tooltips', () => {
  const jd = J2000_JD + 4321;
  const relative = buildTraces({
    jd,
    centerId: 'earth',
    bodies: BODIES,
    getPositions: fakeSolarSystemPositions,
    samples: 16,
  });
  for (const trace of relative) {
    assert.equal(trace.endJd, jd);
    assertClose(trace.startJd, jd - trace.windowDays, 1e-12);
    assert.ok(trace.startJd < trace.endJd);
  }

  const complete = buildCompleteOrbitTraces({
    jd,
    centerId: 'earth',
    bodies: BODIES,
    getPositions: fakeSolarSystemPositions,
    samples: 16,
  });
  for (const trace of complete) {
    assert.equal(trace.endJd, jd);
    assertClose(trace.startJd, jd - trace.windowDays, 1e-12);
    assert.ok(trace.startJd < trace.endJd);
  }
});

test('getTraceWindowDays: fixed windows override the relative multiplier', () => {
  const earth = BY_ID.earth;
  const sun = BY_ID.sun;
  const fixed = 10 * 365.25;

  assert.equal(getTraceWindowDays(earth, sun, 1, fixed), fixed);
  assert.equal(getTraceWindowDays(earth, sun, 50, fixed), fixed);
  assert.equal(getTraceWindowDays(BY_ID.pluto, sun, 1, 365.25), 365.25);
  assert.equal(getTraceWindowDays(earth, sun, 1, 400 * 365.25), 300 * 365.25);
  // Invalid fixed values fall back to the relative window.
  assert.equal(getTraceWindowDays(earth, sun, 2, null), 365.256 * 2);
  assert.equal(getTraceWindowDays(earth, sun, 2, Number.NaN), 365.256 * 2);
});

test('buildTraces: a fixed window is shared by every trace', () => {
  const jd = J2000_JD + 2400;
  const fixed = 50 * 365.25;
  const traces = buildTraces({
    jd,
    centerId: 'earth',
    bodies: BODIES,
    getPositions: fakeSolarSystemPositions,
    span: 50,
    fixedWindowDays: fixed,
    samples: 16,
  });
  assert.ok(traces.length > 1);
  for (const trace of traces) {
    assert.equal(trace.windowDays, fixed);
    assert.equal(trace.endJd, jd);
    assertClose(trace.startJd, jd - fixed, 1e-12);
  }
});


test('buildTraces: overlapping histories are cycle-capped with adaptive sampling', () => {
  const jd = J2000_JD + 3000;
  const requested = 300 * 365.25;
  const traces = buildTraces({
    jd,
    centerId: 'sun',
    bodies: BODIES,
    getPositions: fakeSolarSystemPositions,
    fixedWindowDays: requested,
    maxCycles: 12,
    samplesPerCycle: 72,
    minSamplesPerTrace: 10,
    maxSamplesPerTrace: 1000,
    samples: 12,
  });

  const earth = traces.find((trace) => trace.bodyId === 'earth');
  const pluto = traces.find((trace) => trace.bodyId === 'pluto');
  assert.ok(earth);
  assert.ok(pluto);

  // Earth repeats twelve times, so drawing 300 loops would be redundant.
  assertClose(earth.windowDays, 12 * 365.256, 1e-9);
  assert.equal(earth.requestedWindowDays, requested);
  assertClose(earth.cycles, 12, 1e-9);
  assert.equal(earth.points.length, 864);

  // Pluto has not completed two cycles in 300 years, so it keeps the window.
  assertClose(pluto.windowDays, requested, 1e-12);
  assertClose(pluto.cycles, requested / 90560, 1e-9);
  assert.ok(pluto.points.length >= 10 && pluto.points.length <= 1000);
});
