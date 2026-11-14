/**
 * Solar Atlas — body metadata.
 *
 * Physical values are mean/volumetric radii and best-known masses from the
 * NASA/JPL planetary and satellite fact sheets (JPL SSD, 2024–2025 revisions).
 * Orbital periods are sidereal. The `semiMajorAU`, `eccentricity`, and
 * `inclinationDeg` values are the mean J2000 Keplerian elements used by the
 * ephemeris (JPL "Approximate Positions of the Planets", Table 1), which keeps
 * the display metadata consistent with the model. The Moon's elements are
 * geocentric.
 *
 * Palette note: colors are chosen for a deep-space background; `color` is the
 * body/marker fill, `glow` is the softer halo and leader color.
 */

/** Kilometres in one astronomical unit (IAU 2012 definition). */
export const AU_KM = 149597870.7;

/** Julian date of the J2000.0 epoch: 2000 January 1, 12:00 TT. */
export const J2000_JD = 2451545.0;

/** Primary fit era of the JPL Table 1 Keplerian elements. */
export const MODEL_RANGE = Object.freeze({ startYear: 1800, endYear: 2050 });

/**
 * @typedef {Object} Body
 * @property {string} id
 * @property {string} name
 * @property {'star'|'planet'|'dwarf'|'moon'} kind
 * @property {string|null} parentId
 * @property {string} symbol
 * @property {string} color
 * @property {string} glow
 * @property {number} radiusKm
 * @property {number} massKg
 * @property {number|null} orbitDays
 * @property {number|null} yearDays
 * @property {number} semiMajorAU
 * @property {number} eccentricity
 * @property {number} inclinationDeg
 * @property {string} centric
 * @property {string} tagline
 * @property {string} blurb
 */

/** @type {ReadonlyArray<Body>} */
export const BODIES = Object.freeze([
  {
    id: 'sun',
    name: 'Sun',
    kind: 'star',
    parentId: null,
    symbol: '☉',
    color: '#f2c56a',
    glow: '#f8dfa6',
    radiusKm: 695700,
    massKg: 1.9885e30,
    orbitDays: null,
    yearDays: null,
    semiMajorAU: 0,
    eccentricity: 0,
    inclinationDeg: 0,
    centric: 'Heliocentric',
    tagline: 'The star that anchors every orbit',
    blurb:
      'A G2V main-sequence star holding 99.86% of the Solar System’s mass; its gravity turns every world in this atlas into a companion.',
  },
  {
    id: 'mercury',
    name: 'Mercury',
    kind: 'planet',
    parentId: 'sun',
    symbol: '☿',
    color: '#b9b1a8',
    glow: '#d9d2c8',
    radiusKm: 2439.7,
    massKg: 3.3011e23,
    orbitDays: 87.9691,
    yearDays: 87.9691,
    semiMajorAU: 0.38709927,
    eccentricity: 0.20563593,
    inclinationDeg: 7.00497902,
    centric: 'Hermocentric',
    tagline: 'A scorched world of extremes',
    blurb:
      'The smallest planet races around the Sun in 88 days, its cratered crust swinging from about 430 °C in daylight to −180 °C at night.',
  },
  {
    id: 'venus',
    name: 'Venus',
    kind: 'planet',
    parentId: 'sun',
    symbol: '♀',
    color: '#e8d4a4',
    glow: '#f6e8c8',
    radiusKm: 6051.8,
    massKg: 4.8675e24,
    orbitDays: 224.701,
    yearDays: 224.701,
    semiMajorAU: 0.72333566,
    eccentricity: 0.00677672,
    inclinationDeg: 3.39467605,
    centric: 'Cytherean',
    tagline: 'Earth’s veiled twin',
    blurb:
      'A runaway greenhouse of carbon dioxide keeps Venus near 465 °C beneath permanent sulfuric-acid clouds, hotter than Mercury despite its greater distance.',
  },
  {
    id: 'earth',
    name: 'Earth',
    kind: 'planet',
    parentId: 'sun',
    symbol: '⊕',
    color: '#6da6e8',
    glow: '#b5d3ff',
    radiusKm: 6371.0,
    massKg: 5.97237e24,
    orbitDays: 365.256,
    yearDays: 365.256,
    semiMajorAU: 1.00000261,
    eccentricity: 0.01671123,
    inclinationDeg: 0.00001531,
    centric: 'Geocentric',
    tagline: 'The pale blue cradle',
    blurb:
      'The only world known to harbor life, with liquid oceans, a protective magnetic field, and one large natural moon.',
  },
  {
    id: 'moon',
    name: 'Moon',
    kind: 'moon',
    parentId: 'earth',
    symbol: '☾',
    color: '#cfd8e3',
    glow: '#e8eef7',
    radiusKm: 1737.4,
    massKg: 7.342e22,
    orbitDays: 27.321661,
    yearDays: 365.256,
    semiMajorAU: 384400 / AU_KM,
    eccentricity: 0.0549,
    inclinationDeg: 5.145,
    centric: 'Selenocentric',
    tagline: 'Our silver companion',
    blurb:
      'Tidally locked to Earth, the Moon stabilizes our axial tilt and raises the tides while slowly receding by about 3.8 centimetres each year.',
  },
  {
    id: 'mars',
    name: 'Mars',
    kind: 'planet',
    parentId: 'sun',
    symbol: '♂',
    color: '#c57c5c',
    glow: '#e3a88e',
    radiusKm: 3389.5,
    massKg: 6.4171e23,
    orbitDays: 686.98,
    yearDays: 686.98,
    semiMajorAU: 1.52371034,
    eccentricity: 0.0933941,
    inclinationDeg: 1.84969142,
    centric: 'Areocentric',
    tagline: 'The rust-red frontier',
    blurb:
      'Home to Olympus Mons and Valles Marineris, Mars preserves ancient riverbeds and polar ice beneath a thin carbon-dioxide sky.',
  },
  {
    id: 'jupiter',
    name: 'Jupiter',
    kind: 'planet',
    parentId: 'sun',
    symbol: '♃',
    color: '#d9b98a',
    glow: '#efd7b1',
    radiusKm: 69911,
    massKg: 1.8982e27,
    orbitDays: 4332.589,
    yearDays: 4332.589,
    semiMajorAU: 5.202887,
    eccentricity: 0.04838624,
    inclinationDeg: 1.30439695,
    centric: 'Jovian',
    tagline: 'The giant’s court',
    blurb:
      'A gas giant more than 300 times Earth’s mass, Jupiter’s Great Red Spot and four Galilean moons make it a planetary system in miniature.',
  },
  {
    id: 'saturn',
    name: 'Saturn',
    kind: 'planet',
    parentId: 'sun',
    symbol: '♄',
    color: '#e5d3a6',
    glow: '#f5e8c8',
    radiusKm: 58232,
    massKg: 5.6834e26,
    orbitDays: 10759.22,
    yearDays: 10759.22,
    semiMajorAU: 9.53667594,
    eccentricity: 0.05386179,
    inclinationDeg: 2.48599187,
    centric: 'Saturnian',
    tagline: 'The jewel of the rings',
    blurb:
      'Saturn’s bright rings span nearly 300,000 kilometres, while the planet itself is so tenuous it would float in water.',
  },
  {
    id: 'uranus',
    name: 'Uranus',
    kind: 'planet',
    parentId: 'sun',
    symbol: '♅',
    color: '#8fd3d8',
    glow: '#c4eef1',
    radiusKm: 25362,
    massKg: 8.681e25,
    orbitDays: 30685.4,
    yearDays: 30685.4,
    semiMajorAU: 19.18916464,
    eccentricity: 0.04725744,
    inclinationDeg: 0.77263783,
    centric: 'Uranian',
    tagline: 'The tilted ice giant',
    blurb:
      'Uranus rolls through its 84-year orbit at a 98° tilt, wrapped in methane-blue haze and a set of faint, dark rings.',
  },
  {
    id: 'neptune',
    name: 'Neptune',
    kind: 'planet',
    parentId: 'sun',
    symbol: '♆',
    color: '#5b7fd6',
    glow: '#9db2ee',
    radiusKm: 24622,
    massKg: 1.02413e26,
    orbitDays: 60189,
    yearDays: 60189,
    semiMajorAU: 30.06992276,
    eccentricity: 0.00859048,
    inclinationDeg: 1.77004347,
    centric: 'Neptunian',
    tagline: 'The wind-scoured deep',
    blurb:
      'Supersonic winds and a methane-tinted atmosphere make Neptune the most dynamic of the giant planets at the cold edge of the classical system.',
  },
  {
    id: 'pluto',
    name: 'Pluto',
    kind: 'dwarf',
    parentId: 'sun',
    symbol: '♇',
    color: '#c69b9b',
    glow: '#e3c2c2',
    radiusKm: 1188.3,
    massKg: 1.303e22,
    orbitDays: 90560,
    yearDays: 90560,
    semiMajorAU: 39.48211675,
    eccentricity: 0.2488273,
    inclinationDeg: 17.14001206,
    centric: 'Plutonian',
    tagline: 'The distant heart',
    blurb:
      'A dwarf planet on a tilted, eccentric orbit, Pluto’s nitrogen-ice plains and its large moon Charon form a near-binary pair.',
  },
]);

/** Ordered body ids, useful for UI lists and stable iteration. */
export const BODY_IDS = Object.freeze(BODIES.map((body) => body.id));

/** Fast id → metadata lookup. */
export const BY_ID = Object.freeze(
  Object.fromEntries(BODIES.map((body) => [body.id, body]))
);

/**
 * Look up a body by id.
 * @param {string} id
 * @returns {Body|null} metadata, or null for an unknown id.
 */
export function bodyById(id) {
  return BY_ID[id] ?? null;
}
