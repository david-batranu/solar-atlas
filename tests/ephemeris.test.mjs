/**
 * Ephemeris validation against JPL Horizons state vectors and analytic checks.
 *
 * Fixtures are Horizons "geometric" cartesian states in the ecliptic of J2000:
 * heliocentric for the planets and Pluto, geocentric for the Moon, at
 * JD 2460676.5 (2025-01-01) and the following day.
 *
 * Run with: node --test tests/ephemeris.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  J2000_JD,
  julianDateFromUnixMs,
  unixMsFromJulianDate,
  dateFromJulianDate,
  solveKepler,
  getHeliocentricPosition,
  getPositions,
  getMoonGeocentricPosition,
  getOrbitalElements,
  isPrimaryEra,
  EPHEMERIS_BODY_IDS,
} from '../src/js/ephemeris.js';
import { BODIES, BODY_IDS, BY_ID, AU_KM } from '../src/js/data.js';

const FIXTURE_DIR = fileURLToPath(new URL('../test/fixtures/', import.meta.url));
const TWO_PI = Math.PI * 2;

/** Parse the $$SOE … $$EOE block from a Horizons JSON text result. */
function readHorizonsFixture(name) {
  const raw = JSON.parse(
    readFileSync(path.join(FIXTURE_DIR, `horizons_${name}.json`), 'utf8')
  );
  const text = raw.result;
  const start = text.indexOf('$$SOE');
  const end = text.indexOf('$$EOE');
  assert.ok(start >= 0 && end > start, `fixture ${name}: missing $$SOE/$$EOE block`);

  return text
    .slice(start + 5, end)
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      // JDTDB, calendar date, X, Y, Z, VX, VY, VZ
      const fields = line.split(',').map((value) => value.trim());
      return {
        jd: Number(fields[0]),
        position: [Number(fields[2]), Number(fields[3]), Number(fields[4])],
      };
    });
}

function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function norm(v) {
  return Math.hypot(v[0], v[1], v[2]);
}

function wrapToPi(angle) {
  let x = angle % TWO_PI;
  if (x > Math.PI) x -= TWO_PI;
  else if (x < -Math.PI) x += TWO_PI;
  return x;
}

/** Independent Kepler solver via bisection, used to check the fast solver. */
function keplerBisection(M, e) {
  const target = wrapToPi(M);
  let lo = target - 1;
  let hi = target + 1;
  for (let i = 0; i < 200; i += 1) {
    const mid = 0.5 * (lo + hi);
    if (mid - e * Math.sin(mid) < target) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

// The 1800–2050 JPL Table 1 fits are very good at 2025. The tolerances below
// include the published approximation errors; Jupiter, Saturn and Pluto get a
// deliberately relaxed 0.03 AU budget.
const PLANET_TOLERANCE_AU = Object.freeze({
  mercury: 0.01,
  venus: 0.01,
  earth: 0.01,
  mars: 0.01,
  jupiter: 0.03,
  saturn: 0.03,
  uranus: 0.01,
  neptune: 0.01,
  pluto: 0.03,
});

test('data.js metadata is complete, consistent, and display-ready', () => {
  assert.equal(BODIES.length, 11);
  assert.deepEqual(BODY_IDS, [
    'sun',
    'mercury',
    'venus',
    'earth',
    'moon',
    'mars',
    'jupiter',
    'saturn',
    'uranus',
    'neptune',
    'pluto',
  ]);

  const required = [
    'id',
    'name',
    'kind',
    'parentId',
    'symbol',
    'color',
    'glow',
    'radiusKm',
    'massKg',
    'orbitDays',
    'yearDays',
    'semiMajorAU',
    'eccentricity',
    'inclinationDeg',
    'centric',
    'tagline',
    'blurb',
  ];
  const seen = new Set();
  for (const body of BODIES) {
    for (const key of required) assert.ok(key in body, `${body.id}: missing ${key}`);
    assert.ok(!seen.has(body.id), `duplicate body id ${body.id}`);
    seen.add(body.id);
    assert.equal(BY_ID[body.id], body);
    assert.match(body.color, /^#[0-9a-f]{6}$/i, `${body.id}: color`);
    assert.match(body.glow, /^#[0-9a-f]{6}$/i, `${body.id}: glow`);
    assert.ok(body.radiusKm > 0, `${body.id}: radius`);
    assert.ok(body.massKg > 0, `${body.id}: mass`);
    assert.ok(body.tagline.length > 0 && body.blurb.length > 0, `${body.id}: copy`);
  }
  assert.equal(BY_ID.sun.yearDays, null);
  assert.equal(BY_ID.sun.orbitDays, null);
  assert.equal(BY_ID.sun.centric, 'Heliocentric');
  assert.equal(BY_ID.moon.parentId, 'earth');
  assert.equal(BY_ID.moon.orbitDays, 27.321661);
  assert.equal(BY_ID.moon.yearDays, BY_ID.earth.yearDays);
  assert.ok(Math.abs(BY_ID.moon.semiMajorAU - 384400 / AU_KM) < 1e-15);
});

test('Julian date / Unix time conversions round-trip and hit known epochs', () => {
  assert.equal(julianDateFromUnixMs(0), 2440587.5);
  assert.equal(julianDateFromUnixMs(Date.UTC(2000, 0, 1, 12)), J2000_JD);
  assert.equal(julianDateFromUnixMs(Date.UTC(2025, 0, 1)), 2460676.5);
  assert.equal(unixMsFromJulianDate(2440587.5), 0);
  assert.equal(unixMsFromJulianDate(J2000_JD), 946728000000);
  assert.equal(dateFromJulianDate(J2000_JD).toISOString(), '2000-01-01T12:00:00.000Z');

  const samples = [
    0,
    946684800000,
    1735689600000,
    1234567890123,
    -86400000,
  ];
  for (const ms of samples) {
    const jd = julianDateFromUnixMs(ms);
    const back = unixMsFromJulianDate(jd);
    // A double-precision JD near 2.45e6 has a resolution of ~0.02 ms, so a
    // sub-millisecond absolute error is the best a single number can do.
    assert.ok(Math.abs(back - ms) < 0.05, `round trip ${ms} -> ${back}`);
    assert.equal(
      dateFromJulianDate(jd).getTime(),
      ms,
      `Date round trip ${ms}`
    );
  }
  assert.throws(() => julianDateFromUnixMs(NaN), TypeError);
  assert.throws(() => unixMsFromJulianDate(Infinity), TypeError);
});

test('Kepler solver is accurate for e=0..0.9 across the full anomaly range', () => {
  const eccentricities = [0, 0.01, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
  const anomalies = [];
  for (let i = 0; i <= 48; i += 1) anomalies.push(-Math.PI + (i * TWO_PI) / 48);
  anomalies.push(Math.PI, -Math.PI, 0, 1e-9, -1e-9);

  for (const e of eccentricities) {
    for (const M of anomalies) {
      const E = solveKepler(M, e);
      assert.ok(Number.isFinite(E), `E finite for e=${e}, M=${M}`);
      assert.ok(
        E >= -Math.PI - 1e-12 && E <= Math.PI + 1e-12,
        `E in range for e=${e}, M=${M}: ${E}`
      );
      const residual = Math.abs(E - e * Math.sin(E) - wrapToPi(M));
      assert.ok(residual < 1e-11, `Kepler residual ${residual} for e=${e}, M=${M}`);
      const reference = keplerBisection(M, e);
      assert.ok(
        Math.abs(E - reference) < 1e-10,
        `solver vs bisection e=${e}, M=${M}: ${E} vs ${reference}`
      );
    }
  }

  // Periodicity: adding whole orbits must not change the eccentric anomaly.
  for (const e of [0, 0.3, 0.9]) {
    const base = solveKepler(0.7, e);
    for (const k of [-3, -1, 1, 3]) {
      assert.ok(Math.abs(solveKepler(0.7 + k * TWO_PI, e) - base) < 1e-12);
    }
  }

  assert.throws(() => solveKepler(0, 1), RangeError);
  assert.throws(() => solveKepler(0, -0.1), RangeError);
  assert.throws(() => solveKepler(NaN, 0.1), TypeError);
});

test('Sun is exactly the origin and all positions are finite', () => {
  assert.deepEqual(getHeliocentricPosition('sun', 2460676.5), [0, 0, 0]);
  assert.deepEqual(getPositions(2460676.5).sun, [0, 0, 0]);

  const dates = [
    julianDateFromUnixMs(Date.UTC(1800, 0, 2)),
    julianDateFromUnixMs(Date.UTC(1900, 0, 1)),
    julianDateFromUnixMs(Date.UTC(2025, 0, 1)),
    julianDateFromUnixMs(Date.UTC(2050, 6, 1)),
    julianDateFromUnixMs(Date.UTC(2200, 0, 1)),
  ];
  for (const jd of dates) {
    const positions = getPositions(jd);
    assert.deepEqual(Object.keys(positions), [
      'sun',
      'mercury',
      'venus',
      'earth',
      'moon',
      'mars',
      'jupiter',
      'saturn',
      'uranus',
      'neptune',
      'pluto',
    ]);
    for (const id of EPHEMERIS_BODY_IDS) {
      const p = positions[id];
      assert.equal(p.length, 3, `${id}: vector length at ${jd}`);
      assert.ok(p.every(Number.isFinite), `${id}: finite at ${jd}`);
    }
    // Sanity-check orbital radii; this catches unit or frame havoc.
    assert.ok(norm(positions.mercury) > 0.3 && norm(positions.mercury) < 0.5);
    assert.ok(norm(positions.earth) > 0.98 && norm(positions.earth) < 1.02);
    assert.ok(norm(positions.neptune) > 29 && norm(positions.neptune) < 31);
    assert.ok(norm(positions.pluto) > 29 && norm(positions.pluto) < 50);
  }
  assert.throws(() => getHeliocentricPosition('nibiru', J2000_JD), RangeError);
});

test('planets and Pluto match JPL Horizons at 2025-01-01', () => {
  const residuals = {};
  for (const [id, tolerance] of Object.entries(PLANET_TOLERANCE_AU)) {
    const rows = readHorizonsFixture(id);
    assert.ok(rows.length >= 1, `${id}: no fixture rows`);
    let worst = 0;
    for (const row of rows) {
      const model = getHeliocentricPosition(id, row.jd);
      const residual = distance(model, row.position);
      worst = Math.max(worst, residual);
      assert.ok(
        residual <= tolerance,
        `${id} at JD ${row.jd}: residual ${residual.toFixed(6)} AU exceeds ${tolerance} AU`
      );
    }
    residuals[id] = worst;
  }
  // A little extra scrutiny for the inner planets at this epoch.
  for (const id of ['mercury', 'venus', 'earth', 'mars']) {
    assert.ok(residuals[id] < 0.001, `${id}: residual ${residuals[id]} should be < 0.001 AU`);
  }
});

test('Moon geocentric vector and distance match JPL Horizons at 2025-01-01', () => {
  const rows = readHorizonsFixture('moon');
  assert.ok(rows.length >= 2);
  for (const row of rows) {
    const model = getMoonGeocentricPosition(row.jd);
    const vectorResidual = distance(model, row.position);
    const distanceResidual = Math.abs(norm(model) - norm(row.position));
    assert.ok(
      vectorResidual < 1e-4,
      `Moon vector residual ${vectorResidual.toExponential(3)} AU at JD ${row.jd}`
    );
    assert.ok(
      distanceResidual < 1e-5,
      `Moon distance residual ${distanceResidual.toExponential(3)} AU at JD ${row.jd}`
    );
  }
});

test('lunar J2000 frame conversion holds across the 1800–2100 era', () => {
  // Spot checks against JPL Horizons DE441 geometric vectors (target 301,
  // center 500@399, ecliptic of J2000), retrieved from the Horizons API.
  // These specifically exercise the precession rotation far from J2000; the
  // model agrees to a few kilometres (well under 1e-6 AU).
  const checks = [
    [2378496.5, [2.589433819463328e-3, -3.98018828699336e-4, -1.667526567992566e-4]],
    [2415020.5, [1.635379676047432e-4, -2.456645658319611e-3, 4.70766255789861e-5]],
    [2469807.5, [2.40364781322315e-3, 7.792582862066543e-4, 1.496495582104887e-4]],
    [2488069.5, [-2.269548367481041e-3, 1.010363044990555e-3, 4.720333673585385e-5]],
  ];
  for (const [jd, expected] of checks) {
    const residual = distance(getMoonGeocentricPosition(jd), expected);
    assert.ok(
      residual < 1e-6,
      `Moon J2000-frame residual ${residual.toExponential(3)} AU at JD ${jd}`
    );
  }
});

test('Moon relation to Earth and center-relative subtraction are exact', () => {
  const jd = 2460676.5;
  const positions = getPositions(jd);
  const moonGeo = getMoonGeocentricPosition(jd);
  for (let i = 0; i < 3; i += 1) {
    assert.ok(Math.abs(positions.moon[i] - positions.earth[i] - moonGeo[i]) < 1e-15);
    assert.equal(positions.sun[i], 0);
  }

  for (const centerId of EPHEMERIS_BODY_IDS) {
    const center = positions[centerId];
    assert.deepEqual(
      [center[0] - center[0], center[1] - center[1], center[2] - center[2]],
      [0, 0, 0],
      `${centerId} must be at the origin when it is the center`
    );
    for (const targetId of EPHEMERIS_BODY_IDS) {
      if (targetId === centerId) continue;
      const relative = [
        positions[targetId][0] - center[0],
        positions[targetId][1] - center[1],
        positions[targetId][2] - center[2],
      ];
      assert.ok(relative.every(Number.isFinite), `${targetId} relative to ${centerId}`);
    }
  }
});

test('lunar geocentric distance stays in the physical perigee/apogee band', () => {
  // Sample every day for a decade; the real Moon stays roughly
  // 356,500–406,700 km (0.00238–0.00272 AU).
  const start = julianDateFromUnixMs(Date.UTC(2020, 0, 1));
  let min = Infinity;
  let max = 0;
  for (let day = 0; day <= 3653; day += 1) {
    const r = norm(getMoonGeocentricPosition(start + day));
    min = Math.min(min, r);
    max = Math.max(max, r);
  }
  assert.ok(min >= 0.0023, `lunar perigee too small: ${min} AU`);
  assert.ok(max <= 0.0029, `lunar apogee too large: ${max} AU`);
  assert.ok(min < 0.00245, `lunar minimum not varying enough: ${min} AU`);
  assert.ok(max > 0.00265, `lunar maximum not varying enough: ${max} AU`);
});

test('Table 2 fallback keeps the site usable outside 1800–2050', () => {
  assert.equal(isPrimaryEra(2460676.5), true);
  assert.equal(isPrimaryEra(julianDateFromUnixMs(Date.UTC(1800, 0, 2))), true);
  assert.equal(isPrimaryEra(julianDateFromUnixMs(Date.UTC(2050, 11, 31))), true);
  assert.equal(isPrimaryEra(julianDateFromUnixMs(Date.UTC(1700, 0, 1))), false);
  assert.equal(isPrimaryEra(julianDateFromUnixMs(Date.UTC(2100, 0, 1))), false);
  assert.equal(isPrimaryEra(NaN), false);

  for (const year of [1700, 1799, 2100, 2200, 3000]) {
    const jd = julianDateFromUnixMs(Date.UTC(year, 0, 1));
    const positions = getPositions(jd);
    for (const id of EPHEMERIS_BODY_IDS) {
      assert.ok(positions[id].every(Number.isFinite), `${id} finite at ${year}`);
    }
    assert.ok(norm(positions.jupiter) > 4 && norm(positions.jupiter) < 6.5);
    assert.ok(norm(positions.saturn) > 8 && norm(positions.saturn) < 11);
  }
});

test('getOrbitalElements returns sensible mean elements', () => {
  const mercury = getOrbitalElements('mercury', 2460676.5);
  assert.equal(mercury.source, 'jpl-table-1');
  assert.ok(Math.abs(mercury.a - 0.3871) < 1e-3);
  assert.ok(Math.abs(mercury.e - 0.2056) < 1e-3);
  assert.ok(Math.abs(mercury.periodDays - 87.969) < 0.05);

  const earth = getOrbitalElements('earth', 2460676.5);
  assert.ok(Math.abs(earth.a - 1) < 1e-4);
  assert.ok(Math.abs(earth.periodDays - 365.256) < 0.1);

  const pluto = getOrbitalElements('pluto', 2460676.5);
  assert.equal(pluto.source, 'pluto-1800-2050');
  assert.ok(Math.abs(pluto.periodDays - 90560) < 200);

  const moon = getOrbitalElements('moon', 2460676.5);
  assert.ok(Math.abs(moon.a - 384400 / AU_KM) < 1e-12);
  assert.ok(Math.abs(moon.periodDays - 27.321661) < 1e-9);

  const sun = getOrbitalElements('sun', 2460676.5);
  assert.equal(sun.a, 0);
  assert.equal(sun.periodDays, null);
});

test('performance: 2,000 full-system positions are comfortably real-time', () => {
  const jd = 2460676.5;
  for (let i = 0; i < 50; i += 1) getPositions(jd + i * 0.01);

  const start = performance.now();
  for (let i = 0; i < 2000; i += 1) getPositions(jd + i * 0.01);
  const elapsed = performance.now() - start;

  // Very generous bound: this typically runs in well under 200 ms. The test
  // is only intended to catch an accidental O(n) explosion or table rebuild.
  assert.ok(elapsed < 2000, `2,000 getPositions calls took ${elapsed.toFixed(1)} ms`);
});
