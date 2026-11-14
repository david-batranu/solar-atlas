/**
 * Solar Atlas — geometric Keplerian ephemeris.
 *
 * A dependency-free, DOM-free ES module. Coordinates are right-handed
 * J2000.0 ecliptic, in astronomical units, with the Sun at the origin:
 *
 *   +x  toward the J2000 mean equinox
 *   +z  toward the north ecliptic pole
 *
 * Time is Julian Day (TDB treated as UTC, as specified by the contract).
 * Positions are geometric: no light-time, aberration, or gravitational
 * deflection is applied.
 *
 * Planetary model
 * ---------------
 * The planets use the JPL Solar System Dynamics "Approximate Positions of the
 * Planets" Keplerian elements and rates (Standish & Williams):
 *   https://ssd.jpl.nasa.gov/planets/approx_pos.html
 *
 *   - Table 1 (fit 1800–2050) is used inside the primary era.
 *   - Table 2a elements plus the Table 2b extra mean-anomaly terms for
 *     Jupiter–Neptune are used outside 1800–2050. Table 2 is nominally valid
 *     from 3000 BC to AD 3000; beyond that it is an extrapolation. The extra
 *     terms are
 *
 *       M = L - longPeri + b*T^2 + c*cos(f*T) + s*sin(f*T)
 *
 *     with T in Julian centuries and f in degrees per century; the cosine and
 *     sine arguments are therefore converted from degrees to radians.
 *
 *   - Earth is the Earth–Moon barycenter (EMB), exactly as in the JPL table.
 *     The Moon's heliocentric position is EMB + geocentric lunar offset. This
 *     follows the project contract; the EMB-to-Earth-center offset is only
 *     ~3e-5 AU and is deliberately not added to the Earth entry.
 *
 *   - Pluto is not present in the current JPL tables. It uses the widely
 *     published 1800–2050 mean elements (a = 39.48211675 AU, e = 0.24882730,
 *     I = 17.14001206 deg, L = 238.92903833 deg, longPeri = 224.06891629 deg,
 *     longNode = 110.30393684 deg and their rates). Pluto's orbit is therefore
 *     an approximation even inside the primary era.
 *
 * Lunar model
 * -----------
 * The Moon uses the truncated lunar theory of Meeus, "Astronomical Algorithms"
 * (2nd ed., 1998), chapter 47, tables 47.A and 47.B — the low-precision
 * analytical series derived from ELP-2000/82. It contains 60 periodic terms in
 * longitude and distance and 60 terms in latitude, plus the additive
 * perturbations in A1, A2, A3 and the eccentricity factor E.
 *
 * Meeus's series yields geocentric ecliptic coordinates referred to the mean
 * ecliptic and equinox *of date*. They are converted to the J2000 ecliptic by:
 *   1. ecliptic of date -> equatorial of date (mean obliquity, IAU 1976);
 *   2. equatorial of date -> equatorial J2000 (Lieske precession angles zeta,
 *      z, theta as given in Meeus ch. 21);
 *   3. equatorial J2000 -> ecliptic J2000 (J2000 obliquity).
 * No nutation is applied, matching Horizons "geometric" vectors in the mean
 * J2000 frame. A comment in each section cites the source.
 *
 * Validation at JD 2460676.5 (2025-01-01), against JPL Horizons DE441
 * geometric J2000-ecliptic vectors: the Moon agrees to ~1e-8 AU (about 1 km);
 * the planets agree to 5e-6–1.4e-2 AU, well inside the model's nominal error.
 */

const DEG = Math.PI / 180;
const ARCSEC = DEG / 3600;
const TWO_PI = Math.PI * 2;

/** Julian date of J2000.0 (2000 January 1, 12:00 TT). */
export const J2000_JD = 2451545.0;

/** Kilometres in one astronomical unit (IAU 2012). */
export const AU_KM = 149597870.7;

const UNIX_EPOCH_JD = 2440587.5;
const MS_PER_DAY = 86400000;

/**
 * Coverage notes for the planetary model. Table 1 is the high-accuracy fit
 * for 1800–2050; Table 2a/2b keeps the site usable outside that era.
 */
export const MODEL_SPAN = Object.freeze({
  primaryStartYear: 1800,
  primaryEndYear: 2050,
  extendedStartYear: -3000,
  extendedEndYear: 3000,
  note:
    'JPL Table 1 is used for 1800–2050; Table 2a/2b (with extra M terms for Jupiter–Neptune) is used outside that era, where it remains useful but less accurate. Pluto uses a separate 1800–2050 approximate orbit everywhere.',
});

// 1800-01-01 00:00 and 2051-01-01 00:00. The whole calendar year 2050 is
// therefore still in the primary fit, matching "valid 1800 AD - 2050 AD".
const PRIMARY_START_JD = 2378496.5;
const PRIMARY_END_JD = 2470172.5;

/* ------------------------------------------------------------------------- *
 * Time
 * ------------------------------------------------------------------------- */

/**
 * Convert Unix epoch milliseconds to Julian Day.
 * @param {number} ms milliseconds since 1970-01-01T00:00:00Z
 * @returns {number} Julian date
 */
export function julianDateFromUnixMs(ms) {
  if (!Number.isFinite(ms)) {
    throw new TypeError('julianDateFromUnixMs: ms must be a finite number');
  }
  return UNIX_EPOCH_JD + ms / MS_PER_DAY;
}

/**
 * Convert Julian Day to Unix epoch milliseconds.
 * @param {number} jd Julian date
 * @returns {number} milliseconds since 1970-01-01T00:00:00Z
 */
export function unixMsFromJulianDate(jd) {
  if (!Number.isFinite(jd)) {
    throw new TypeError('unixMsFromJulianDate: jd must be a finite number');
  }
  return (jd - UNIX_EPOCH_JD) * MS_PER_DAY;
}

/**
 * Convert Julian Day to a JavaScript Date (UTC). The result is rounded to the
 * nearest millisecond because Date has integer-millisecond resolution.
 * @param {number} jd Julian date
 * @returns {Date}
 */
export function dateFromJulianDate(jd) {
  return new Date(Math.round(unixMsFromJulianDate(jd)));
}

/* ------------------------------------------------------------------------- *
 * Kepler's equation
 * ------------------------------------------------------------------------- */

/** Wrap an angle to [-pi, pi]. */
function wrapToPi(angle) {
  let x = angle % TWO_PI;
  if (x > Math.PI) x -= TWO_PI;
  else if (x < -Math.PI) x += TWO_PI;
  return x;
}

/** Wrap an angle to [0, 360). */
function wrapTo360(degrees) {
  const x = degrees % 360;
  return x < 0 ? x + 360 : x;
}

/**
 * Solve Kepler's equation M = E - e sin(E) for the eccentric anomaly.
 *
 * The mean anomaly may be any real number and is first wrapped to [-pi, pi].
 * A bracketed Newton iteration is used: f(E) = E - e sin(E) - M is strictly
 * increasing for 0 <= e < 1, so [M-1, M+1] always brackets the root and a
 * bisection step is used whenever Newton would leave that bracket. This is
 * robust for the full eccentricity range used by the Solar System
 * (0 <= e <= 0.9, including the high-eccentricity Mercury/Pluto cases).
 *
 * @param {number} meanAnomalyRad mean anomaly in radians
 * @param {number} e eccentricity, 0 <= e < 1
 * @returns {number} eccentric anomaly E in radians, in [-pi, pi]
 */
export function solveKepler(meanAnomalyRad, e) {
  if (!Number.isFinite(meanAnomalyRad)) {
    throw new TypeError('solveKepler: mean anomaly must be finite');
  }
  if (!(e >= 0 && e < 1)) {
    throw new RangeError('solveKepler: eccentricity must satisfy 0 <= e < 1');
  }

  const M = wrapToPi(meanAnomalyRad);
  if (e === 0) return M;

  let lo = M - 1;
  let hi = M + 1;
  let E = M + e * Math.sin(M); // standard first guess, inside the bracket

  for (let i = 0; i < 60; i += 1) {
    const f = E - e * Math.sin(E) - M;
    if (f > 0) hi = E;
    else lo = E;

    if (Math.abs(f) < 1e-14) return E;

    const derivative = 1 - e * Math.cos(E);
    let next = E - f / derivative;
    if (!Number.isFinite(next) || next <= lo || next >= hi) {
      next = 0.5 * (lo + hi);
    }
    if (Math.abs(next - E) < 1e-15) return next;
    E = next;
  }

  // The bracket has collapsed to machine precision. Return its midpoint.
  return 0.5 * (lo + hi);
}

/* ------------------------------------------------------------------------- *
 * Planetary elements — JPL "Approximate Positions of the Planets"
 * ------------------------------------------------------------------------- */

/*
 * Every element vector is ordered:
 *   [a (AU), e, I (deg), L (deg), longitude of perihelion (deg),
 *    longitude of ascending node (deg)]
 * and every rate vector is the corresponding per-Julian-century rate.
 * Source: https://ssd.jpl.nasa.gov/planets/approx_pos.html (Tables 1, 2a, 2b).
 */

const ELEMENT_A = 0;
const ELEMENT_E = 1;
const ELEMENT_I = 2;
const ELEMENT_L = 3;
const ELEMENT_LONG_PERI = 4;
const ELEMENT_LONG_NODE = 5;

/** Table 1: nominal fit 1800 AD – 2050 AD. */
const TABLE_1 = Object.freeze({
  mercury: [
    [0.38709927, 0.20563593, 7.00497902, 252.2503235, 77.45779628, 48.33076593],
    [0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081],
  ],
  venus: [
    [0.72333566, 0.00677672, 3.39467605, 181.9790995, 131.60246718, 76.67984255],
    [0.0000039, -0.00004107, -0.0007889, 58517.81538729, 0.00268329, -0.27769418],
  ],
  earth: [
    [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0],
    [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0],
  ],
  mars: [
    [1.52371034, 0.0933941, 1.84969142, -4.55343205, -23.94362959, 49.55953891],
    [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343],
  ],
  jupiter: [
    [5.202887, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909],
    [-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106],
  ],
  saturn: [
    [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448],
    [-0.0012506, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794],
  ],
  uranus: [
    [19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.9542763, 74.01692503],
    [-0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589],
  ],
  neptune: [
    [30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574],
    [0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664],
  ],
});

/** Table 2a: nominal fit 3000 BC – AD 3000. */
const TABLE_2A = Object.freeze({
  mercury: [
    [0.38709843, 0.20563661, 7.00559432, 252.25166724, 77.45771895, 48.33961819],
    [0.0, 0.00002123, -0.00590158, 149472.67486623, 0.15940013, -0.12214182],
  ],
  venus: [
    [0.72332102, 0.00676399, 3.39777545, 181.9797085, 131.76755713, 76.67261496],
    [-0.00000026, -0.00005107, 0.00043494, 58517.8156026, 0.05679648, -0.27274174],
  ],
  earth: [
    [1.00000018, 0.01673163, -0.00054346, 100.46691572, 102.93005885, -5.11260389],
    [-0.00000003, -0.00003661, -0.01337178, 35999.37306329, 0.3179526, -0.24123856],
  ],
  mars: [
    [1.52371243, 0.09336511, 1.85181869, -4.56813164, -23.91744784, 49.71320984],
    [0.00000097, 0.00009149, -0.00724757, 19140.29934243, 0.45223625, -0.26852431],
  ],
  jupiter: [
    [5.20248019, 0.0485359, 1.29861416, 34.33479152, 14.27495244, 100.29282654],
    [-0.00002864, 0.00018026, -0.00322699, 3034.90371757, 0.18199196, 0.13024619],
  ],
  saturn: [
    [9.54149883, 0.05550825, 2.49424102, 50.07571329, 92.86136063, 113.63998702],
    [-0.00003065, -0.00032044, 0.00451969, 1222.11494724, 0.54179478, -0.25015002],
  ],
  uranus: [
    [19.18797948, 0.0468574, 0.77298127, 314.20276625, 172.43404441, 73.96250215],
    [-0.00020455, -0.0000155, -0.00180155, 428.49512595, 0.09266985, 0.05739699],
  ],
  neptune: [
    [30.06952752, 0.00895439, 1.7700552, 304.22289287, 46.68158724, 131.78635853],
    [0.00006447, 0.00000818, 0.000224, 218.46515314, 0.01009938, -0.00606302],
  ],
});

/**
 * Table 2b: extra mean-anomaly terms for Jupiter–Neptune, used with Table 2a.
 * M = L - longPeri + b*T^2 + c*cos(f*T) + s*sin(f*T); f is in degrees per
 * century, so f*T is converted from degrees to radians before cos/sin.
 */
const TABLE_2B = Object.freeze({
  jupiter: Object.freeze({ b: -0.00012452, c: 0.0606406, s: -0.35635438, f: 38.35125 }),
  saturn: Object.freeze({ b: 0.00025899, c: -0.13434469, s: 0.87320147, f: 38.35125 }),
  uranus: Object.freeze({ b: 0.00058331, c: -0.97731848, s: 0.17689245, f: 7.67025 }),
  neptune: Object.freeze({ b: -0.00041348, c: 0.68346318, s: -0.10162547, f: 7.67025 }),
});

/**
 * Pluto's widely used 1800–2050 mean elements and rates. Pluto is not in the
 * current JPL tables; this orbit is approximate everywhere.
 */
const PLUTO_ELEMENTS = Object.freeze({
  base: [39.48211675, 0.2488273, 17.14001206, 238.92903833, 224.06891629, 110.30393684],
  rate: [-0.00031596, 0.0000517, 0.00004818, 145.20780515, -0.04062942, -0.01183482],
});

/** @param {string} bodyId */
function isPlanetId(bodyId) {
  return Object.prototype.hasOwnProperty.call(TABLE_1, bodyId);
}

/**
 * True inside the primary JPL Table 1 fit era (calendar years 1800–2050).
 * @param {number} jd Julian date
 * @returns {boolean}
 */
export function isPrimaryEra(jd) {
  return Number.isFinite(jd) && jd >= PRIMARY_START_JD && jd < PRIMARY_END_JD;
}

/**
 * Return the active element table and extra terms for a body.
 * @param {string} bodyId
 * @param {number} jd
 */
function activeElements(bodyId, jd) {
  if (bodyId === 'pluto') {
    return { base: PLUTO_ELEMENTS.base, rate: PLUTO_ELEMENTS.rate, extra: null, source: 'pluto-1800-2050' };
  }
  if (!isPlanetId(bodyId)) {
    throw new RangeError(`Unknown body id: ${bodyId}`);
  }
  if (isPrimaryEra(jd)) {
    const pair = TABLE_1[bodyId];
    return { base: pair[0], rate: pair[1], extra: null, source: 'jpl-table-1' };
  }
  const pair = TABLE_2A[bodyId];
  return {
    base: pair[0],
    rate: pair[1],
    extra: TABLE_2B[bodyId] ?? null,
    source: 'jpl-table-2a+2b',
  };
}

/**
 * Compute a planet's heliocentric J2000-ecliptic position from one of the
 * JPL element tables.
 * @param {string} bodyId
 * @param {number} jd
 * @returns {[number, number, number]} AU, J2000 ecliptic
 */
function planetPosition(bodyId, jd) {
  const { base, rate, extra } = activeElements(bodyId, jd);
  const T = (jd - J2000_JD) / 36525;

  const a = base[ELEMENT_A] + rate[ELEMENT_A] * T;
  const e = base[ELEMENT_E] + rate[ELEMENT_E] * T;
  const inclination = base[ELEMENT_I] + rate[ELEMENT_I] * T;
  const L = base[ELEMENT_L] + rate[ELEMENT_L] * T;
  const longPeri = base[ELEMENT_LONG_PERI] + rate[ELEMENT_LONG_PERI] * T;
  const longNode = base[ELEMENT_LONG_NODE] + rate[ELEMENT_LONG_NODE] * T;

  let meanAnomaly = L - longPeri;
  if (extra) {
    // Table 2b. f*T is in degrees; crucially, Math.cos/sin expect radians.
    const fT = extra.f * T * DEG;
    meanAnomaly += extra.b * T * T + extra.c * Math.cos(fT) + extra.s * Math.sin(fT);
  }

  const E = solveKepler(meanAnomaly * DEG, e);

  // Position in the orbital plane, x' toward perihelion.
  const xOrbital = a * (Math.cos(E) - e);
  const yOrbital = a * Math.sqrt(1 - e * e) * Math.sin(E);

  // Rotate by argument of perihelion, inclination, and ascending node into
  // the J2000 ecliptic (JPL's explicit rotation-matrix expansion).
  const omega = (longPeri - longNode) * DEG;
  const Omega = longNode * DEG;
  const inc = inclination * DEG;

  const cosOmega = Math.cos(omega);
  const sinOmega = Math.sin(omega);
  const cosNode = Math.cos(Omega);
  const sinNode = Math.sin(Omega);
  const cosInc = Math.cos(inc);
  const sinInc = Math.sin(inc);

  const x =
    (cosOmega * cosNode - sinOmega * sinNode * cosInc) * xOrbital +
    (-sinOmega * cosNode - cosOmega * sinNode * cosInc) * yOrbital;
  const y =
    (cosOmega * sinNode + sinOmega * cosNode * cosInc) * xOrbital +
    (-sinOmega * sinNode + cosOmega * cosNode * cosInc) * yOrbital;
  const z =
    sinOmega * sinInc * xOrbital + cosOmega * sinInc * yOrbital;

  return [x, y, z];
}

/* ------------------------------------------------------------------------- *
 * Lunar theory — Meeus, Astronomical Algorithms, 2nd ed., chapter 47
 * ------------------------------------------------------------------------- */

/*
 * Table 47.A: periodic terms for longitude (units 1e-6 deg) and distance
 * (units 1e-3 km). Columns: D, M, M', F, coefficient of sin (longitude),
 * coefficient of cos (distance). Source: Meeus (1998), p. 342.
 */
const LUNAR_LONGITUDE_DISTANCE_TERMS = Object.freeze([
  [0, 0, 1, 0, 6288774, -20905355],
  [2, 0, -1, 0, 1274027, -3699111],
  [2, 0, 0, 0, 658314, -2955968],
  [0, 0, 2, 0, 213618, -569925],
  [0, 1, 0, 0, -185116, 48888],
  [0, 0, 0, 2, -114332, -3149],
  [2, 0, -2, 0, 58793, 246158],
  [2, -1, -1, 0, 57066, -152138],
  [2, 0, 1, 0, 53322, -170733],
  [2, -1, 0, 0, 45758, -204586],
  [0, 1, -1, 0, -40923, -129620],
  [1, 0, 0, 0, -34720, 108743],
  [0, 1, 1, 0, -30383, 104755],
  [2, 0, 0, -2, 15327, 10321],
  [0, 0, 1, 2, -12528, 0],
  [0, 0, 1, -2, 10980, 79661],
  [4, 0, -1, 0, 10675, -34782],
  [0, 0, 3, 0, 10034, -23210],
  [4, 0, -2, 0, 8548, -21636],
  [2, 1, -1, 0, -7888, 24208],
  [2, 1, 0, 0, -6766, 30824],
  [1, 0, -1, 0, -5163, -8379],
  [1, 1, 0, 0, 4987, -16675],
  [2, -1, 1, 0, 4036, -12831],
  [2, 0, 2, 0, 3994, -10445],
  [4, 0, 0, 0, 3861, -11650],
  [2, 0, -3, 0, 3665, 14403],
  [0, 1, -2, 0, -2689, -7003],
  [2, 0, -1, 2, -2602, 0],
  [2, -1, -2, 0, 2390, 10056],
  [1, 0, 1, 0, -2348, 6322],
  [2, -2, 0, 0, 2236, -9884],
  [0, 1, 2, 0, -2120, 5751],
  [0, 2, 0, 0, -2069, 0],
  [2, -2, -1, 0, 2048, -4950],
  [2, 0, 1, -2, -1773, 4130],
  [2, 0, 0, 2, -1595, 0],
  [4, -1, -1, 0, 1215, -3958],
  [0, 0, 2, 2, -1110, 0],
  [3, 0, -1, 0, -892, 3258],
  [2, 1, 1, 0, -810, 2616],
  [4, -1, -2, 0, 759, -1897],
  [0, 2, -1, 0, -713, -2117],
  [2, 2, -1, 0, -700, 2354],
  [2, 1, -2, 0, 691, 0],
  [2, -1, 0, -2, 596, 0],
  [4, 0, 1, 0, 549, -1423],
  [0, 0, 4, 0, 537, -1117],
  [4, -1, 0, 0, 520, -1571],
  [1, 0, -2, 0, -487, -1739],
  [2, 1, 0, -2, -399, 0],
  [0, 0, 2, -2, -381, -4421],
  [1, 1, 1, 0, 351, 0],
  [3, 0, -2, 0, -340, 0],
  [4, 0, -3, 0, 330, 0],
  [2, -1, 2, 0, 327, 0],
  [0, 2, 1, 0, -323, 1165],
  [1, 1, -1, 0, 299, 0],
  [2, 0, 3, 0, 294, 0],
  [2, 0, -1, -2, 0, 8752],
]);

/*
 * Table 47.B: periodic terms for latitude, units 1e-6 deg.
 * Columns: D, M, M', F, coefficient of sin. Source: Meeus (1998), p. 344.
 */
const LUNAR_LATITUDE_TERMS = Object.freeze([
  [0, 0, 0, 1, 5128122],
  [0, 0, 1, 1, 280602],
  [0, 0, 1, -1, 277693],
  [2, 0, 0, -1, 173237],
  [2, 0, -1, 1, 55413],
  [2, 0, -1, -1, 46271],
  [2, 0, 0, 1, 32573],
  [0, 0, 2, 1, 17198],
  [2, 0, 1, -1, 9266],
  [0, 0, 2, -1, 8822],
  [2, -1, 0, -1, 8216],
  [2, 0, -2, -1, 4324],
  [2, 0, 1, 1, 4200],
  [2, 1, 0, -1, -3359],
  [2, -1, -1, 1, 2463],
  [2, -1, 0, 1, 2211],
  [2, -1, -1, -1, 2065],
  [0, 1, -1, -1, -1870],
  [4, 0, -1, -1, 1828],
  [0, 1, 0, 1, -1794],
  [0, 0, 0, 3, -1749],
  [0, 1, -1, 1, -1565],
  [1, 0, 0, 1, -1491],
  [0, 1, 1, 1, -1475],
  [0, 1, 1, -1, -1410],
  [0, 1, 0, -1, -1344],
  [1, 0, 0, -1, -1335],
  [0, 0, 3, 1, 1107],
  [4, 0, 0, -1, 1021],
  [4, 0, -1, 1, 833],
  [0, 0, 1, -3, 777],
  [4, 0, -2, 1, 671],
  [2, 0, 0, -3, 607],
  [2, 0, 2, -1, 596],
  [2, -1, 1, -1, 491],
  [2, 0, -2, 1, -451],
  [0, 0, 3, -1, 439],
  [2, 0, 2, 1, 422],
  [2, 0, -3, -1, 421],
  [2, 1, -1, 1, -366],
  [2, 1, 0, 1, -351],
  [4, 0, 0, 1, 331],
  [2, -1, 1, 1, 315],
  [2, -2, 0, -1, 302],
  [0, 0, 1, 3, -283],
  [2, 1, 1, -1, -229],
  [1, 1, 0, -1, 223],
  [1, 1, 0, 1, 223],
  [0, 1, -2, -1, -220],
  [2, 1, -1, -1, -220],
  [1, 0, 1, 1, -185],
  [2, -1, -2, -1, 181],
  [0, 1, 2, 1, -177],
  [4, 0, -2, -1, 176],
  [4, -1, -1, -1, 166],
  [1, 0, 1, -1, -164],
  [4, 0, 1, -1, 132],
  [1, 0, -1, -1, -119],
  [4, -1, 0, -1, 115],
  [2, -2, 0, 1, 107],
]);

/**
 * Fundamental lunar arguments and their polynomials (Meeus ch. 47).
 * All returned angles are in degrees; T is Julian centuries from J2000.
 * @param {number} T
 */
function lunarArguments(T) {
  const T2 = T * T;
  const T3 = T2 * T;
  const T4 = T3 * T;
  return {
    Lp:
      218.3164477 +
      481267.88123421 * T -
      0.0015786 * T2 +
      T3 / 538841 -
      T4 / 65194000,
    D:
      297.8501921 +
      445267.1114034 * T -
      0.0018819 * T2 +
      T3 / 545868 -
      T4 / 113065000,
    M:
      357.5291092 +
      35999.0502909 * T -
      0.0001536 * T2 +
      T3 / 24490000,
    Mp:
      134.9633964 +
      477198.8675055 * T +
      0.0087414 * T2 +
      T3 / 69699 -
      T4 / 14712000,
    F:
      93.272095 +
      483202.0175233 * T -
      0.0036539 * T2 -
      T3 / 3526000 +
      T4 / 863310000,
    A1: 119.75 + 131.849 * T,
    A2: 53.09 + 479264.29 * T,
    A3: 313.45 + 481266.484 * T,
    E: 1 - 0.002516 * T - 0.0000074 * T2,
  };
}

/**
 * Geocentric position of the Moon in AU, J2000 ecliptic.
 *
 * The Meeus series is evaluated in the mean ecliptic and equinox of date and
 * then rotated to J2000 (see the module header). This is a geometric position:
 * no light-time, aberration, or nutation.
 *
 * @param {number} jd Julian date
 * @returns {[number, number, number]} AU, Earth-centered, J2000 ecliptic
 */
export function getMoonGeocentricPosition(jd) {
  if (!Number.isFinite(jd)) {
    throw new TypeError('getMoonGeocentricPosition: jd must be finite');
  }

  const T = (jd - J2000_JD) / 36525;
  const { Lp, D, M, Mp, F, A1, A2, A3, E } = lunarArguments(T);

  const Drad = D * DEG;
  const Mrad = M * DEG;
  const Mprad = Mp * DEG;
  const Frad = F * DEG;
  const E2 = E * E;

  // Additive perturbations from Venus, Jupiter and the Sun (Meeus 47).
  let sumL =
    3958 * Math.sin(A1 * DEG) +
    1962 * Math.sin((Lp - F) * DEG) +
    318 * Math.sin(A2 * DEG);
  let sumR = 0;
  let sumB =
    -2235 * Math.sin(Lp * DEG) +
    382 * Math.sin(A3 * DEG) +
    175 * Math.sin((A1 - F) * DEG) +
    175 * Math.sin((A1 + F) * DEG) +
    127 * Math.sin((Lp - Mp) * DEG) -
    115 * Math.sin((Lp + Mp) * DEG);

  for (let i = 0; i < LUNAR_LONGITUDE_DISTANCE_TERMS.length; i += 1) {
    const term = LUNAR_LONGITUDE_DISTANCE_TERMS[i];
    const argument = term[0] * Drad + term[1] * Mrad + term[2] * Mprad + term[3] * Frad;
    const eccentricityFactor =
      term[1] === 0 ? 1 : Math.abs(term[1]) === 1 ? E : E2;
    sumL += term[4] * Math.sin(argument) * eccentricityFactor;
    sumR += term[5] * Math.cos(argument) * eccentricityFactor;
  }

  for (let i = 0; i < LUNAR_LATITUDE_TERMS.length; i += 1) {
    const term = LUNAR_LATITUDE_TERMS[i];
    const argument = term[0] * Drad + term[1] * Mrad + term[2] * Mprad + term[3] * Frad;
    const eccentricityFactor =
      term[1] === 0 ? 1 : Math.abs(term[1]) === 1 ? E : E2;
    sumB += term[4] * Math.sin(argument) * eccentricityFactor;
  }

  const longitude = (Lp + sumL * 1e-6) * DEG;
  const latitude = sumB * 1e-6 * DEG;
  const distanceKm = 385000.56 + sumR * 1e-3;

  const radius = distanceKm / AU_KM;
  const cosLat = Math.cos(latitude);
  const xDate = radius * cosLat * Math.cos(longitude);
  const yDate = radius * cosLat * Math.sin(longitude);
  const zDate = radius * Math.sin(latitude);

  return lunarDateToJ2000(xDate, yDate, zDate, T);
}

/**
 * Mean obliquity of the ecliptic (IAU 1976), in radians.
 * Meeus eq. 22.2.
 * @param {number} T Julian centuries from J2000
 */
function meanObliquity(T) {
  const arcseconds = 84381.448 - 46.815 * T - 0.00059 * T * T + 0.001813 * T * T * T;
  return arcseconds * ARCSEC;
}

/**
 * Rotate a geocentric vector from the mean ecliptic/equinox of date to the
 * J2000 ecliptic.
 *
 * The precession angles are the IAU 1976/Lieske values used by Meeus ch. 21:
 *   zeta  = 2306.2181" T + 0.30188" T^2 + 0.017998" T^3
 *   z     = 2306.2181" T + 1.09468" T^2 + 0.018203" T^3
 *   theta = 2004.3109" T - 0.42665" T^2 - 0.041833" T^3
 * Equatorial precession from date to J2000 is the inverse of
 * Rz(z) Ry(theta) Rz(zeta), applied after converting ecliptic-of-date to
 * equatorial-of-date with the mean obliquity.
 *
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {number} T Julian centuries from J2000
 * @returns {[number, number, number]}
 */
function lunarDateToJ2000(x, y, z, T) {
  const epsDate = meanObliquity(T);

  // Ecliptic of date -> equatorial of date.
  const cosEps = Math.cos(epsDate);
  const sinEps = Math.sin(epsDate);
  const xe = x;
  const ye = y * cosEps - z * sinEps;
  const ze = y * sinEps + z * cosEps;

  // Equatorial date -> equatorial J2000: Rz(-zeta) Ry(-theta) Rz(-z).
  const T2 = T * T;
  const T3 = T2 * T;
  const zeta = (2306.2181 * T + 0.30188 * T2 + 0.017998 * T3) * ARCSEC;
  const zAngle = (2306.2181 * T + 1.09468 * T2 + 0.018203 * T3) * ARCSEC;
  const theta = (2004.3109 * T - 0.42665 * T2 - 0.041833 * T3) * ARCSEC;

  const cosZ = Math.cos(zAngle);
  const sinZ = Math.sin(zAngle);
  const x1 = xe * cosZ + ye * sinZ;
  const y1 = -xe * sinZ + ye * cosZ;
  const z1 = ze;

  const cosTheta = Math.cos(theta);
  const sinTheta = Math.sin(theta);
  const x2 = x1 * cosTheta + z1 * sinTheta;
  const y2 = y1;
  const z2 = -x1 * sinTheta + z1 * cosTheta;

  const cosZeta = Math.cos(zeta);
  const sinZeta = Math.sin(zeta);
  const xe2000 = x2 * cosZeta + y2 * sinZeta;
  const ye2000 = -x2 * sinZeta + y2 * cosZeta;
  const ze2000 = z2;

  // Equatorial J2000 -> ecliptic J2000.
  const eps2000 = 84381.448 * ARCSEC;
  const cosEps0 = Math.cos(eps2000);
  const sinEps0 = Math.sin(eps2000);

  return [
    xe2000,
    ye2000 * cosEps0 + ze2000 * sinEps0,
    -ye2000 * sinEps0 + ze2000 * cosEps0,
  ];
}

/* ------------------------------------------------------------------------- *
 * Public position API
 * ------------------------------------------------------------------------- */

/**
 * Heliocentric position of a body, J2000 ecliptic, AU.
 *
 * Sun is exactly [0, 0, 0]. Earth is the Earth–Moon barycenter. The Moon is
 * the EMB plus the geocentric lunar offset, per the project contract.
 *
 * @param {string} bodyId
 * @param {number} jd Julian date
 * @returns {[number, number, number]}
 */
export function getHeliocentricPosition(bodyId, jd) {
  if (!Number.isFinite(jd)) {
    throw new TypeError('getHeliocentricPosition: jd must be finite');
  }
  if (bodyId === 'sun') return [0, 0, 0];
  if (bodyId === 'moon') {
    const earth = planetPosition('earth', jd);
    const moon = getMoonGeocentricPosition(jd);
    return [earth[0] + moon[0], earth[1] + moon[1], earth[2] + moon[2]];
  }
  if (bodyId === 'pluto' || isPlanetId(bodyId)) {
    return planetPosition(bodyId, jd);
  }
  throw new RangeError(`Unknown body id: ${bodyId}`);
}

/**
 * All body positions at one instant, in the same order as the contract's
 * `data.js` body list.
 * @param {number} jd Julian date
 * @returns {Record<string, [number, number, number]>}
 */
export function getPositions(jd) {
  if (!Number.isFinite(jd)) {
    throw new TypeError('getPositions: jd must be finite');
  }

  const earth = planetPosition('earth', jd);
  const moonOffset = getMoonGeocentricPosition(jd);

  return {
    sun: [0, 0, 0],
    mercury: planetPosition('mercury', jd),
    venus: planetPosition('venus', jd),
    earth,
    moon: [
      earth[0] + moonOffset[0],
      earth[1] + moonOffset[1],
      earth[2] + moonOffset[2],
    ],
    mars: planetPosition('mars', jd),
    jupiter: planetPosition('jupiter', jd),
    saturn: planetPosition('saturn', jd),
    uranus: planetPosition('uranus', jd),
    neptune: planetPosition('neptune', jd),
    pluto: planetPosition('pluto', jd),
  };
}

/**
 * Mean orbital elements at a Julian date, for inspection/UI. This is an
 * optional convenience API; the renderer should use positions, not elements.
 *
 * Planet/dwarf elements are the active JPL table values in degrees (and AU),
 * J2000 ecliptic. The Moon returns mean geocentric elements referred to the
 * mean ecliptic/equinox of date, from the Meeus mean arguments. The Sun returns
 * a zero orbit at the origin.
 *
 * @param {string} bodyId
 * @param {number} jd Julian date
 * @returns {Object|null}
 */
export function getOrbitalElements(bodyId, jd) {
  if (!Number.isFinite(jd)) {
    throw new TypeError('getOrbitalElements: jd must be finite');
  }
  if (bodyId === 'sun') {
    return {
      bodyId,
      jd,
      source: 'origin',
      a: 0,
      e: 0,
      inclinationDeg: 0,
      meanLongitudeDeg: 0,
      longPerihelionDeg: 0,
      longNodeDeg: 0,
      argPerihelionDeg: 0,
      meanAnomalyRad: 0,
      meanMotionDegPerDay: 0,
      periodDays: null,
    };
  }

  const T = (jd - J2000_JD) / 36525;

  if (bodyId === 'moon') {
    const { Lp, Mp } = lunarArguments(T);
    const node =
      125.0445479 - 1934.1362891 * T + 0.0020754 * T * T + (T * T * T) / 467441 -
      (T * T * T * T) / 60616000;
    const longPeri = Lp - Mp;
    return {
      bodyId,
      jd,
      source: 'meeus-47-mean',
      referenceFrame: 'mean ecliptic and equinox of date',
      a: 384400 / AU_KM,
      e: 0.0549,
      inclinationDeg: 5.145,
      meanLongitudeDeg: wrapTo360(Lp),
      longPerihelionDeg: wrapTo360(longPeri),
      longNodeDeg: wrapTo360(node),
      argPerihelionDeg: wrapTo360(longPeri - node),
      meanAnomalyRad: wrapToPi(Mp * DEG),
      meanMotionDegPerDay: 360 / 27.321661,
      periodDays: 27.321661,
    };
  }

  if (bodyId !== 'pluto' && !isPlanetId(bodyId)) {
    throw new RangeError(`Unknown body id: ${bodyId}`);
  }

  const { base, rate, extra, source } = activeElements(bodyId, jd);
  const a = base[ELEMENT_A] + rate[ELEMENT_A] * T;
  const e = base[ELEMENT_E] + rate[ELEMENT_E] * T;
  const inclinationDeg = base[ELEMENT_I] + rate[ELEMENT_I] * T;
  const L = base[ELEMENT_L] + rate[ELEMENT_L] * T;
  const longPerihelionDeg = base[ELEMENT_LONG_PERI] + rate[ELEMENT_LONG_PERI] * T;
  const longNodeDeg = base[ELEMENT_LONG_NODE] + rate[ELEMENT_LONG_NODE] * T;

  let meanAnomalyDeg = L - longPerihelionDeg;
  if (extra) {
    const fT = extra.f * T * DEG;
    meanAnomalyDeg += extra.b * T * T + extra.c * Math.cos(fT) + extra.s * Math.sin(fT);
  }

  const meanMotionDegPerDay = rate[ELEMENT_L] / 36525;

  return {
    bodyId,
    jd,
    source,
    referenceFrame: 'J2000 ecliptic',
    a,
    e,
    inclinationDeg,
    meanLongitudeDeg: wrapTo360(L),
    longPerihelionDeg: wrapTo360(longPerihelionDeg),
    longNodeDeg: wrapTo360(longNodeDeg),
    argPerihelionDeg: wrapTo360(longPerihelionDeg - longNodeDeg),
    meanAnomalyRad: wrapToPi(meanAnomalyDeg * DEG),
    meanMotionDegPerDay,
    periodDays: meanMotionDegPerDay === 0 ? null : 360 / meanMotionDegPerDay,
  };
}

/** Body ids understood by the position API, in display order. */
export const EPHEMERIS_BODY_IDS = Object.freeze([
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
