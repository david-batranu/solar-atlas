# Solar Atlas — engineering contract

A dependency-free, static, real-time interactive orrery. Deep-space observatory aesthetic.
Target: 60fps on a laptop, graceful on mobile. No external runtime assets or fonts.

## Product requirements

- Realistic heliocentric orbits from Keplerian elements (eccentricity + inclination included).
- Center can be any of: Sun, Mercury, Venus, Earth, Moon, Mars, Jupiter, Saturn, Uranus,
  Neptune, Pluto. Heliocentric on first load. The center body sits at the origin.
- Orbit trail style: **solid**, **fading** (alpha increases toward the body's current position), or **always** (complete closed parent orbit in the selected center’s frame, uniform full brightness).
- Simulation time speed: play/pause, reverse, log speed control, speed presets, "now".
- Zoom in/out (wheel, pinch, buttons, fit view) and pan; a top-down, true-scale **Overview**
  mode using the same Solid/Fading/Always and History behavior as Orbits, and a top-down **Atlas**
  mode that compresses radial distance so the entire system is legible at once.
- Every non-center world can be hidden independently; hiding removes its marker, label and orbit trace and excludes it from Fit. The center world always remains visible. Persist the set in the URL as `hide=<comma-separated ids>`.
- Solid and Fading history has two modes: Relative (0.5×–50× the per-body automatic window via `span`) and Fixed (1, 10, 50 or 200 years for every body via `history=fixed&years=...`). Always ignores the window and draws complete parent orbits. Fading keeps a faint guide across the full selected history. Hovering or tapping an orbit segment shows its body and UTC date/time.
- Orbit lines / labels remain performant and legible in every center and in Overview/Atlas. On touch, a two-finger drag tilts/rotates the Orbits view (pinch still zooms) and tapping an orbit segment opens its UTC date card. The legacy URL value `mode=elliptic` normalizes to `overview`.

## Files and ownership

| File | Owner | Notes |
|---|---|---|
| `index.html`, `src/js/{main,camera,renderer,ui}.js` | lead | integration, rendering, controls |
| `src/js/data.js`, `src/js/ephemeris.js`, `tests/ephemeris.test.mjs` | astro-model | science engine |
| `src/js/orbits.js`, `tests/orbits.test.mjs` | orbit-engine | relative traces + overview/atlas mapping |
| `src/css/styles.css`, `assets/favicon.svg` | visual-design | presentation only |
| `tests/qa*`, `qa/*` | qa-verifier | browser verification |

Do not edit files outside your ownership without asking the lead. Never rewrite another
owner's file. Keep modules DOM-free unless stated.

## Coordinate & time conventions

- Coordinates: right-handed ecliptic J2000, **AU**, `[x, y, z]`, Sun at origin.
- Time: Julian Day (number, TDB≈UTC). `J2000_JD = 2451545.0`.
- All visual geometry uses center-relative coordinates: `pos(body, t) - pos(center, t)`.

## `data.js` exports (astro-model)

```js
export const AU_KM = 149597870.7;
export const J2000_JD = 2451545.0;
export const MODEL_RANGE = { startYear: 1800, endYear: 2050 }; // primary fit era
export const BODIES = [
  // astronomy + presentation metadata. Every body:
  {
    id,            // 'sun' | 'mercury' | ... | 'moon'
    name,          // 'Sun', 'Mercury', 'Moon'
    kind,          // 'star' | 'planet' | 'dwarf' | 'moon'
    parentId,      // null for Sun, 'sun' for planets/dwarfs, 'earth' for Moon
    symbol,        // '☉','☿','♀','⊕','☾','♂','♃','♄','♅','♆','♇'
    color,         // primary marker color (hex)
    glow,          // halo/leader color (hex)
    radiusKm,      // mean physical radius
    massKg,        // best-known mass
    orbitDays,     // sidereal period around parent; null/undefined for Sun
    yearDays,      // heliocentric period; Moon = Earth's year; Sun = null
    semiMajorAU,   // mean distance from parent (Moon in AU)
    eccentricity,  // mean eccentricity
    inclinationDeg,// mean inclination to J2000 ecliptic
    centric,       // 'Heliocentric' | 'Geocentric' | 'Areocentric' ... for UI
    tagline,       // one short evocative line
    blurb,         // 1–2 sentence description
  }
];
export const BODY_IDS = BODIES.map(b => b.id);
export const BY_ID = Object.fromEntries(BODIES.map(b => [b.id, b]));
export function bodyById(id) {}
```

The moon's `orbitDays ≈ 27.321661`, `yearDays ≈ 365.256` (heliocentric context),
`semiMajorAU = 384400 / AU_KM`.

## `ephemeris.js` exports (astro-model)

```js
export function julianDateFromUnixMs(ms)        // number
export function unixMsFromJulianDate(jd)        // number
export function dateFromJulianDate(jd)          // JS Date (UTC)
export function solveKepler(meanAnomalyRad, e)  // eccentric anomaly, radians
export function getHeliocentricPosition(bodyId, jd) // [x,y,z] AU J2000 ecliptic
export function getPositions(jd)                // { sun:[0,0,0], mercury:[...], ..., moon:[...] }
export function getMoonGeocentricPosition(jd)   // [x,y,z] AU, Earth-centered
export function getOrbitalElements(bodyId, jd)  // numeric mean elements (for UI/tests); optional
```

- Planets/dwarfs: JPL `Approximate Positions of the Planets` Keplerian elements and rates
  (1800–2050 table; table 2 + extra M terms may be used as a fallback outside the era but is
  not required). Phase: J2000 ecliptic, geometric positions, no light-time.
- Earth uses the Earth–Moon barycenter elements. Moon = Earth position + geocentric lunar
  offset. Use a truncated lunar theory (Meeus 47-style preferred; Schlyter main perturbations
  acceptable). Correct reference frame toward J2000.
- Sun is exactly `[0,0,0]`.
- Pure, Node-importable ES module; no DOM, no network, no dependencies.
- Validate against `test/fixtures/horizons_*.json` (JPL Horizons vectors at JD 2460676.5,
  heliocentric for planets, geocentric for Moon). Add tests using `node:test`.
  Realistic tolerance: ≤0.01 AU for every planet and the Moon at this epoch; Moon distance
  within 0.002 AU if achievable. Also test Kepler solver, JD round trips, center subtraction
  invariants, and monotonic lunar distance range 0.0023–0.0029 AU.

## `orbits.js` exports (orbit-engine)

Must be independent of direct ephemeris imports; receives a `getPositions(jd)` function.
Uses `BODIES`-shaped objects passed in. Pure, Node-importable.

```js
export const ATLAS_SCALE_AU = 0.18;
export function compressDistance(rAU)            // natural-log radial compression, r>=0 -> display AU
export function displayPosition(p, blend)        // blend 0 = true, 1 = compressed; never mutate p
export function getTraceWindowDays(target, center, span = 1, fixedWindowDays = null)
export function buildTraces({ jd, centerId, bodies, getPositions, getPosition?, span = 1, fixedWindowDays = null, samples = 480 })
```

`buildTraces` returns only bodies other than the center, each:

```js
{
  bodyId, centerId,
  points: [[x,y,z], ...], // center-relative raw AU, ordered oldest -> now
  alphas: [0..1, ...],    // strictly/loosely increasing fade profile, head brightest
  windowDays,
  isClosed,               // geometric loop (start≈end) when target.parentId === center.id
}
```

Trace window rules:
- target orbits center (`target.parentId === center.id`): one sidereal period; `isClosed: true`.
- center orbits target (`center.parentId === target.id`): center's orbital period.
- target is Sun (`id === 'sun'`): one year of the center (`center.yearDays`), centered view.
- target is Moon viewed from Sun: a ~60-day local lunar trail (not a heliocentric ring).
- otherwise planets: `clamp(2.5 * synodicPeriod(target, center), 120 days, 40 years)`,
  using `yearDays`, not `orbitDays`, for moons. This yields realistic geocentric rosettes.
- Sampling: last point at exactly `jd`; first at `jd - windowDays`. Fade alpha 0 at tail,
  approaching ~0.9 at head, with a perceptually pleasant curve. No NaNs, no zero-length traces.
- Efficiency matters: one `getPositions` call per sample, subtract the center, reuse arrays.
  If bodies have different windows, each gets its own sampling loop; that is acceptable.
- Tests with synthetic circular two-body systems, window rules, compression math, alphas,
  center subtraction, and real ephemeris smoke tests.

## DOM / CSS hooks (visual-design)

The final markup lives in `index.html` (lead-owned). Style these, do not rename:
- `.scene`, `.sky`, `.vignette`, `#veil`, `.masthead`, `.mode-switch`, `.mode-btn`, `.icon-btn`
- `.controls` (`#controls`), `.panel`, `.control`, `.eyebrow`, `.micro`, `.center-picker`,
  `.center-button`, `.center-menu`, `.center-group`, `.center-option`, `.segmented`, `.switch`,
  `.text-btn`, `.panel__note`, `.center-meta`
- `.timebar`, `.timebar__date`, `.timebar__controls`, `.speed`, `.speed-ticks`, `.speed-tick`,
  `.ghost-btn`, `.play-btn`, `.transport-btn`, `.chip`
- `.view-controls`, `.view-btn`, `.hover-card`, `.help-overlay`, `.help-card`, `.help-row`,
  `.shortcut`, `.toast`, `.status` (visually hidden live region)
- State classes: `.is-active`, `.is-open`, `.is-paused`, `[hidden]`, `[aria-pressed="true"]`,
  `body.is-atlas`, `body.is-overview`, `body.is-loading`, `.reduced-motion`.
- Custom properties for the palette; system font stacks only. The canvas is full-bleed;
  controls float above it. Plan around 1440×900 and 390×844. Play button + speed slider must
  be comfortable on touch. No horizontal scrolling.

## Integration notes

- ES modules loaded from `index.html`; no bundler in dev.
- `main.js` owns application state and the RAF loop. UI emits actions via callbacks in
  `ui.js`; renderer is stateless and draws a scene description.
- Provide `window.__solar` for automated QA: `{ getState, setCenter, setMode, setTrailStyle,
  setTrailSpan, setHistoryMode, setHistoryYears, setSpeed, setJd, togglePlay, zoomBy, fit,
  getSceneSummary, pickOrbitAt }`.
- Respect `prefers-reduced-motion`; simulation continues unless paused, camera easing is
  near-instant for reduced motion.
