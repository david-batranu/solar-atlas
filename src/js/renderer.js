/**
 * Canvas renderer for Solar Atlas.
 *
 * The renderer is intentionally stateless: main.js computes time, traces and
 * camera state, then hands over a single scene description. Everything drawn
 * here is in CSS pixels; the canvas backing store is scaled for HiDPI.
 */

import { projectPoint, getInsetArea } from './camera.js';
import { displayPosition, compressDistance } from './orbits.js';
import { AU_KM } from './data.js';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const MONO = '500 10px "SFMono-Regular", ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace';
const MONO_SMALL = '400 8px "SFMono-Regular", ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace';

/* ------------------------------------------------------------------ colors */

const colorCache = new Map();

function parseColor(hex) {
  if (colorCache.has(hex)) return colorCache.get(hex);
  let value = String(hex || '#ffffff').replace('#', '');
  if (value.length === 3) value = value.split('').map((c) => c + c).join('');
  const num = Number.parseInt(value, 16);
  const rgb = Number.isFinite(num)
    ? [(num >> 16) & 255, (num >> 8) & 255, num & 255]
    : [255, 255, 255];
  colorCache.set(hex, rgb);
  return rgb;
}

function mix(hex, target, amount) {
  const [r, g, b] = parseColor(hex);
  return `rgb(${Math.round(r + (target[0] - r) * amount)}, ${Math.round(g + (target[1] - g) * amount)}, ${Math.round(b + (target[2] - b) * amount)})`;
}

function lighten(hex, amount = 0.35) {
  return mix(hex, [255, 255, 255], amount);
}

function darken(hex, amount = 0.4) {
  return mix(hex, [4, 8, 16], amount);
}

function rgbaOf(hex, alpha) {
  const [r, g, b] = parseColor(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/* ------------------------------------------------------------------ stars */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildStarCatalog(count) {
  const random = mulberry32(0x51a7a7);
  const tints = ['#fff7e8', '#dfe9ff', '#ffe7c4', '#e8f1ff', '#fff2d2'];
  return Array.from({ length: count }, () => ({
    x: random(),
    y: random(),
    radius: 0.25 + Math.pow(random(), 2.6) * 1.6,
    alpha: 0.16 + random() * 0.62,
    phase: random() * TAU,
    speed: 0.35 + random() * 0.9,
    tint: tints[Math.floor(random() * tints.length)],
    bright: random() > 0.9,
  }));
}

const STAR_CATALOG = buildStarCatalog(340);

/* ------------------------------------------------------------------ helpers */

function smoothstep(edge0, edge1, value) {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function niceNumber(value) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const fraction = value / Math.pow(10, exponent);
  const nice = fraction < 1.5 ? 1 : fraction < 3.5 ? 2 : fraction < 7.5 ? 5 : 10;
  return nice * Math.pow(10, exponent);
}

function formatDistanceAU(au) {
  if (!Number.isFinite(au)) return '—';
  if (au >= 10) return `${au.toFixed(0)} AU`;
  if (au >= 1) return `${au.toFixed(au < 2 ? 2 : 1)} AU`;
  if (au >= 0.01) return `${au.toFixed(3)} AU`;
  return `${au.toFixed(5)} AU`;
}

function formatKm(km) {
  if (!Number.isFinite(km)) return '—';
  if (km >= 1e9) return `${(km / 1e9).toFixed(1)} billion km`;
  if (km >= 1e6) return `${(km / 1e6).toFixed(1)} million km`;
  if (km >= 1e4) return `${Math.round(km / 1000).toLocaleString('en-US')},000 km`;
  return `${Math.round(km).toLocaleString('en-US')} km`;
}

function markerRadius(body, atlasBlend, options = {}) {
  const hovered = Boolean(options.hovered);
  const isCenter = Boolean(options.isCenter);
  let radius;

  if (body.kind === 'star') {
    radius = 10.8 + atlasBlend * 2.4;
  } else {
    const min = body.kind === 'moon' ? 2.05 : 2.4;
    const budget = 4.45;
    const span = Math.log10(70000 / 1000);
    const t = Math.log10(Math.max(1000, body.radiusKm || 1000) / 1000) / span;
    radius = min + Math.min(1, Math.max(0, t)) * budget;
    radius *= 1 + atlasBlend * 0.22;
  }

  if (isCenter) radius += 0.35;
  if (hovered) radius += 0.9;
  return radius;
}

/** Draw a soft, luminous halo behind the Sun (traces then draw on top). */
function drawSunAura(ctx, x, y, radius, atlasBlend, time) {
  const pulse = 1 + Math.sin(time * 0.00038) * 0.012;
  const reach = radius * (atlasBlend > 0.5 ? 10 : 12) * pulse;
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, reach);
  gradient.addColorStop(0, 'rgba(255, 215, 140, 0.30)');
  gradient.addColorStop(0.12, 'rgba(255, 186, 86, 0.17)');
  gradient.addColorStop(0.34, 'rgba(255, 152, 62, 0.07)');
  gradient.addColorStop(0.68, 'rgba(255, 132, 48, 0.022)');
  gradient.addColorStop(1, 'rgba(255, 120, 40, 0)');

  ctx.save();
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(x, y, reach, 0, TAU);
  ctx.fill();
  ctx.restore();
}

function drawSun(ctx, x, y, radius, time, reducedMotion) {
  const pulse = reducedMotion ? 1 : 1 + Math.sin(time * 0.0011) * 0.025;

  // Outer corona.
  const corona = ctx.createRadialGradient(x, y, radius * 0.7, x, y, radius * 4.2 * pulse);
  corona.addColorStop(0, 'rgba(255, 210, 126, 0.42)');
  corona.addColorStop(0.28, 'rgba(255, 177, 79, 0.19)');
  corona.addColorStop(1, 'rgba(255, 150, 60, 0)');
  ctx.save();
  ctx.fillStyle = corona;
  ctx.beginPath();
  ctx.arc(x, y, radius * 4.2 * pulse, 0, TAU);
  ctx.fill();

  // Fine diffraction rays.
  ctx.strokeStyle = 'rgba(255, 222, 160, 0.22)';
  ctx.lineWidth = 0.8;
  for (let i = 0; i < 10; i += 1) {
    const angle = (i / 10) * TAU + (reducedMotion ? 0 : time * 0.000008);
    const inner = radius * 1.15;
    const outer = radius * (i % 3 === 0 ? 3.3 : 2.15);
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(angle) * inner, y + Math.sin(angle) * inner);
    ctx.lineTo(x + Math.cos(angle) * outer, y + Math.sin(angle) * outer);
    ctx.stroke();
  }

  // Photosphere.
  const disc = ctx.createRadialGradient(
    x - radius * 0.3,
    y - radius * 0.34,
    radius * 0.15,
    x,
    y,
    radius * 1.08,
  );
  disc.addColorStop(0, '#fffdf2');
  disc.addColorStop(0.28, '#fff2c9');
  disc.addColorStop(0.6, '#ffdd97');
  disc.addColorStop(0.86, '#f6b761');
  disc.addColorStop(1, '#df8f3e');

  ctx.fillStyle = disc;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, TAU);
  ctx.fill();

  ctx.strokeStyle = 'rgba(255, 242, 206, 0.46)';
  ctx.lineWidth = 0.7;
  ctx.stroke();
  ctx.restore();
}

function drawPlanet(ctx, view, time, reducedMotion) {
  const { body, x, y, radius, hovered, isCenter } = view;
  if (body.kind === 'star') {
    drawSun(ctx, x, y, radius, time, reducedMotion);
    return;
  }

  ctx.save();

  // Atmospheric halo.
  const halo = ctx.createRadialGradient(x, y, radius * 0.6, x, y, radius * 3.6);
  halo.addColorStop(0, rgbaOf(body.color, hovered ? 0.3 : 0.17));
  halo.addColorStop(0.45, rgbaOf(body.color, hovered ? 0.1 : 0.055));
  halo.addColorStop(1, rgbaOf(body.color, 0));
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(x, y, radius * 3.6, 0, TAU);
  ctx.fill();

  // Saturn's rings live behind the disc; the front half is over-painted below.
  if (body.id === 'saturn' && radius >= 3.1) {
    drawSaturnRings(ctx, x, y, radius, false);
  }

  // Lit sphere.
  const disc = ctx.createRadialGradient(
    x - radius * 0.36,
    y - radius * 0.4,
    Math.max(0.2, radius * 0.08),
    x,
    y,
    radius * 1.06,
  );
  disc.addColorStop(0, lighten(body.color, 0.62));
  disc.addColorStop(0.36, lighten(body.color, 0.16));
  disc.addColorStop(0.82, body.color);
  disc.addColorStop(1, darken(body.color, 0.38));

  ctx.fillStyle = disc;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, TAU);
  ctx.fill();

  if (radius > 2.6) {
    ctx.strokeStyle = rgbaOf('#f0f6ff', 0.2);
    ctx.lineWidth = 0.55;
    ctx.stroke();
  }

  if (body.id === 'saturn' && radius >= 3.1) {
    drawSaturnRings(ctx, x, y, radius, true);
  }

  // Hover and centre rings.
  if (hovered) {
    ctx.strokeStyle = rgbaOf(body.color, 0.75);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, radius + 5.2, 0, TAU);
    ctx.stroke();
  }

  if (isCenter) {
    ctx.strokeStyle = rgbaOf(body.color, 0.62);
    ctx.lineWidth = 0.9;
    ctx.setLineDash([2, 3.4]);
    ctx.beginPath();
    ctx.arc(x, y, radius + (hovered ? 11 : 9), 0, TAU);
    ctx.stroke();
    ctx.setLineDash([]);

    const tick = 4.8;
    const ring = radius + 13.2;
    for (let i = 0; i < 4; i += 1) {
      const angle = (i / 4) * TAU;
      const inner = ring;
      const outer = ring + tick;
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(angle) * inner, y + Math.sin(angle) * inner);
      ctx.lineTo(x + Math.cos(angle) * outer, y + Math.sin(angle) * outer);
      ctx.stroke();
    }

    ctx.globalAlpha = 0.4;
    ctx.strokeStyle = rgbaOf(body.color, 0.38);
    ctx.beginPath();
    ctx.arc(x, y, radius + 21, 0, TAU);
    ctx.stroke();
  }

  ctx.restore();
}

function drawSaturnRings(ctx, x, y, radius, foreground) {
  ctx.save();
  const tilt = -0.24;
  const rx = radius * 2.1;
  const ry = Math.max(1.1, radius * 0.62);

  ctx.translate(x, y);
  ctx.rotate(tilt);

  if (!foreground) {
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, Math.PI, TAU);
    ctx.strokeStyle = 'rgba(236, 211, 161, 0.66)';
    ctx.lineWidth = Math.max(0.75, radius * 0.16);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(0, 0, rx * 0.72, ry * 0.75, 0, Math.PI, TAU);
    ctx.strokeStyle = 'rgba(238, 220, 181, 0.35)';
    ctx.lineWidth = Math.max(0.55, radius * 0.09);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI);
    ctx.strokeStyle = 'rgba(246, 225, 183, 0.84)';
    ctx.lineWidth = Math.max(0.8, radius * 0.17);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(0, 0, rx * 1.12, ry * 1.04, 0, 0, Math.PI);
    ctx.strokeStyle = 'rgba(214, 189, 145, 0.34)';
    ctx.lineWidth = Math.max(0.5, radius * 0.08);
    ctx.stroke();
  }

  ctx.restore();
}

/* ------------------------------------------------------------------ labels */

function buildLabelCandidates(radius, labelWidth, labelHeight) {
  const candidates = [];
  const angles = [-0.24, 0.26, -0.62, 0.64, -1.05, 1.05, -1.52, 1.52, Math.PI];
  const distances = [11, 23, 37, 54, 76];

  for (let d = 0; d < distances.length; d += 1) {
    const distance = radius + distances[d];
    for (let a = 0; a < angles.length; a += 1) {
      const angle = angles[a];
      const dx = Math.cos(angle) * distance;
      const dy = Math.sin(angle) * distance * 0.88;
      const alignLeft = dx >= 0;
      const x = alignLeft ? dx : dx - labelWidth;
      const y = dy - labelHeight * 0.5;
      candidates.push({
        x,
        y,
        distance: distance + (d === 0 ? 0 : 4),
        order: d * angles.length + a,
      });
    }
  }
  return candidates;
}

function overlaps(a, b, pad = 2) {
  return !(
    a.x + a.w + pad <= b.x ||
    b.x + b.w + pad <= a.x ||
    a.y + a.h + pad <= b.y ||
    b.y + b.h + pad <= a.y
  );
}

function overlapArea(a, b, pad = 2) {
  const x1 = Math.max(a.x, b.x - pad);
  const y1 = Math.max(a.y, b.y - pad);
  const x2 = Math.min(a.x + a.w, b.x + b.w + pad);
  const y2 = Math.min(a.y + a.h, b.y + b.h + pad);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

/**
 * Place labels in screen space, avoiding collisions and preferring small
 * offsets. Returns rectangles for hit-testing in main.js.
 */
function drawLabels(ctx, scene, views) {
  const { viewport, showLabels, hoveredId, centerId } = scene;
  const obstacles = Array.isArray(scene.avoidRects) ? scene.avoidRects : [];
  if (!showLabels) return [];

  const margin = 10;
  const hitsObstacle = (rect) => obstacles.some((obstacle) => overlapArea(rect, obstacle, 0) > 0.5);
  const placed = [];
  const labelItems = [];

  for (const view of views) {
    if (!view.visible || view.offscreen) continue;
    // A label pinned inside the canvas for a marker beyond its edge is
    // misleading (and would be an invisible click target). Only label worlds
    // whose marker is actually on-screen.
    if (view.x < 0 || view.x > viewport.width || view.y < 0 || view.y > viewport.height) {
      continue;
    }
    if (obstacles.some((obstacle) => (
      view.x >= obstacle.x && view.x <= obstacle.x + obstacle.w
      && view.y >= obstacle.y && view.y <= obstacle.y + obstacle.h
    ))) {
      continue;
    }
    const { body } = view;

    // At heliocentric/zoomed-out scales the Moon sits inside Earth's marker;
    // its label would be noise. Show it when there is enough separation.
    if (body.id === 'moon' && centerId !== 'moon') {
      const earth = views.find((v) => v.body.id === 'earth');
      if (earth && earth.visible) {
        const separation = Math.hypot(view.x - earth.x, view.y - earth.y);
        if (separation < 15 && hoveredId !== body.id) continue;
      }
    }

    const isCenter = body.id === centerId;
    const isHovered = body.id === hoveredId;
    const size = viewport.width < 620 ? 9 : 10.5;
    const weight = isCenter || isHovered ? 600 : 500;
    ctx.font = `${weight} ${size}px "SFMono-Regular", ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace`;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0.12em';

    const text = body.name.toUpperCase();
    const width = Math.ceil(ctx.measureText(text).width);
    const dotSpace = 8;
    const labelWidth = width + dotSpace + 4;
    const labelHeight = size + 6;

    const priority = (isHovered ? 1000 : 0) + (isCenter ? 500 : 0)
      + (body.kind === 'star' ? 400 : 0) + (body.kind === 'planet' ? 100 : 0)
      + (body.kind === 'dwarf' ? 30 : 0) + (body.radiusKm || 0) / 1e7;

    labelItems.push({
      body,
      view,
      text,
      labelWidth,
      labelHeight,
      size,
      priority,
      isCenter,
      isHovered,
      color: isHovered ? '#f7fbff'
        : isCenter ? lighten(body.color, 0.28)
          : body.kind === 'star' ? lighten(body.color, 0.16)
            : 'rgba(229, 236, 248, 0.83)',
    });
  }

  labelItems.sort((a, b) => b.priority - a.priority);

  for (const item of labelItems) {
    const { body, view, labelWidth, labelHeight, size } = item;
    const candidates = buildLabelCandidates(view.radius + 3, labelWidth, labelHeight);
    let best = null;
    let bestScore = Infinity;

    for (const candidate of candidates) {
      const rect = {
        x: view.x + candidate.x,
        y: view.y + candidate.y,
        w: labelWidth,
        h: labelHeight,
      };

      let score = candidate.order * 0.35 + candidate.distance * 0.15;
      let overlapPenalty = 0;
      for (const other of placed) {
        const area = overlapArea(rect, other, 3);
        if (area > 0) overlapPenalty += area * 30 + 68;
      }
      for (const other of views) {
        if (other === view || !other.visible || other.offscreen) continue;
        const dx = Math.max(rect.x - other.x, 0, other.x - (rect.x + rect.w));
        const dy = Math.max(rect.y - other.y, 0, other.y - (rect.y + rect.h));
        if (Math.hypot(dx, dy) < other.radius + 4) overlapPenalty += 30;
      }

      let obstaclePenalty = 0;
      for (const obstacle of obstacles) {
        const area = overlapArea(rect, obstacle, 0);
        if (area > 0) obstaclePenalty += area * 40 + 600;
      }

      let edgePenalty = 0;
      if (rect.x < margin) edgePenalty += (margin - rect.x) * 6;
      if (rect.y < margin) edgePenalty += (margin - rect.y) * 6;
      if (rect.x + rect.w > viewport.width - margin) {
        edgePenalty += (rect.x + rect.w - (viewport.width - margin)) * 6;
      }
      if (rect.y + rect.h > viewport.height - margin) {
        edgePenalty += (rect.y + rect.h - (viewport.height - margin)) * 6;
      }

      score += overlapPenalty + edgePenalty + obstaclePenalty;
      if (score < bestScore) {
        bestScore = score;
        best = rect;
      }
      if (overlapPenalty === 0 && edgePenalty === 0 && obstaclePenalty === 0 && candidate.order < 2) {
        break;
      }
    }

    if (!best) continue;

    // Keep text on screen even in extreme cases.
    best.x = Math.min(Math.max(margin, best.x), viewport.width - margin - best.w);
    best.y = Math.min(Math.max(margin, best.y), viewport.height - margin - best.h);
    if (hitsObstacle(best)) continue;

    placed.push(best);

    const centerY = best.y + best.h * 0.5;
    const dotX = best.x + 3.5;
    const textX = best.x + 9;

    // Leader line when the label has drifted away from its world.
    const anchorX = view.x;
    const anchorY = view.y;
    const nearX = Math.min(Math.max(anchorX, best.x), best.x + best.w);
    const nearY = Math.min(Math.max(anchorY, best.y), best.y + best.h);
    const distance = Math.hypot(nearX - anchorX, nearY - anchorY);
    if (distance > 14) {
      ctx.save();
      ctx.strokeStyle = rgbaOf(body.color, item.isHovered ? 0.5 : 0.24);
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.moveTo(anchorX, anchorY);
      ctx.lineTo(nearX, nearY);
      ctx.stroke();
      ctx.restore();
    }

    ctx.save();
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0.12em';
    ctx.font = `${item.isHovered || item.isCenter ? 600 : 500} ${size}px "SFMono-Regular", ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace`;

    // Colored world dot.
    ctx.globalAlpha = 0.95;
    ctx.fillStyle = body.color;
    ctx.beginPath();
    ctx.arc(dotX, centerY, item.isHovered ? 2.1 : 1.65, 0, TAU);
    ctx.fill();

    // Dark keyline keeps typography readable over bright orbit lines.
    ctx.globalAlpha = 0.72;
    ctx.strokeStyle = 'rgba(3, 7, 14, 0.92)';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.strokeText(item.text, textX, centerY);

    ctx.globalAlpha = 1;
    ctx.fillStyle = item.color;
    ctx.textBaseline = 'middle';
    ctx.fillText(item.text, textX, centerY);

    if (item.isHovered) {
      ctx.globalAlpha = 0.72;
      ctx.strokeStyle = rgbaOf(body.color, 0.65);
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(textX, centerY + size * 0.58);
      ctx.lineTo(textX + ctx.measureText(item.text).width, centerY + size * 0.58);
      ctx.stroke();
    }

    ctx.restore();
    placed[placed.length - 1].bodyId = body.id;
  }

  const labelRects = [];
  for (let i = 0; i < placed.length; i += 1) {
    const rect = placed[i];
    if (rect.bodyId) {
      labelRects.push({
        bodyId: rect.bodyId,
        x: rect.x,
        y: rect.y,
        w: rect.w,
        h: rect.h,
      });
    }
  }
  return labelRects;
}

/* ------------------------------------------------------------------ main */

export function createRenderer(canvas) {
  const context = canvas.getContext('2d', { alpha: true });
  if (!context) throw new Error('Canvas 2D is not available in this browser.');

  let ctx = context;
  let viewport = { width: 1, height: 1, dpr: 1 };
  let lastLayout = { bodies: [], labels: [], origin: { x: 0, y: 0 } };

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const backingW = Math.max(1, Math.round(width * dpr));
    const backingH = Math.max(1, Math.round(height * dpr));

    if (canvas.width !== backingW || canvas.height !== backingH) {
      canvas.width = backingW;
      canvas.height = backingH;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    viewport = { width, height, dpr };
    return viewport;
  }

  function drawStars(camera, timeMs, reducedMotion) {
    const { width, height } = viewport;
    const area = width * height;
    const count = Math.round(Math.min(STAR_CATALOG.length, Math.max(100, area / 6200)));
    const offsetX = (camera.panX * 0.00009 + camera.yaw * 0.02) % 1;
    const offsetY = (camera.panY * 0.00009 - (camera.elevation - 58 * DEG) * 0.035) % 1;
    const seconds = timeMs * 0.001;

    ctx.save();
    for (let i = 0; i < count; i += 1) {
      const star = STAR_CATALOG[i];
      let x = (star.x + offsetX) % 1;
      let y = (star.y + offsetY) % 1;
      if (x < 0) x += 1;
      if (y < 0) y += 1;
      const px = x * width;
      const py = y * height;
      const twinkle = reducedMotion
        ? 1
        : 0.82 + Math.sin(seconds * star.speed * 0.55 + star.phase) * 0.18;
      const alpha = star.alpha * twinkle;
      if (alpha <= 0.01) continue;

      ctx.globalAlpha = alpha;
      ctx.fillStyle = star.tint;
      ctx.beginPath();
      ctx.arc(px, py, star.radius, 0, TAU);
      ctx.fill();

      if (star.bright && star.radius > 0.8) {
        ctx.globalAlpha = alpha * 0.24;
        ctx.strokeStyle = star.tint;
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(px - 3.5, py);
        ctx.lineTo(px + 3.5, py);
        ctx.moveTo(px, py - 3.5);
        ctx.lineTo(px, py + 3.5);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function drawAtlasGrid(camera, blend, centerId) {
    if (blend < 0.55) return;
    const strength = smoothstep(0.55, 0.98, blend);
    const origin = projectPoint([0, 0, 0], camera, viewport);
    const area = getInsetArea(viewport, {
      left: 20,
      right: 20,
      top: 80,
      bottom: 140,
    });
    const reach = Math.hypot(viewport.width, viewport.height) * 0.8;

    ctx.save();
    ctx.lineWidth = 0.6;

    // Faint polar spokes make the compressed chart feel measured.
    ctx.strokeStyle = `rgba(151, 183, 224, ${0.04 * strength})`;
    for (let i = 0; i < 12; i += 1) {
      const angle = (i / 12) * TAU + camera.yaw;
      ctx.beginPath();
      ctx.moveTo(origin.x, origin.y);
      ctx.lineTo(
        origin.x + Math.cos(angle) * reach,
        origin.y + Math.sin(angle) * reach,
      );
      ctx.stroke();
    }

    const rings = centerId === 'sun'
      ? [0.39, 1, 5.2, 9.5, 19.2, 30.1, 39.5]
      : [0.1, 0.5, 1, 5, 10, 30];
    const labelRings = new Set(centerId === 'sun' ? [1, 5.2, 9.5, 30.1] : [0.1, 1, 10, 30]);

    const ringsToDraw = [];
    for (const au of rings) {
      const radiusPx = compressDistance(au) * camera.scale;
      if (radiusPx > 26 && radiusPx < Math.max(area.width, area.height) * 1.35) {
        ringsToDraw.push({ au, radius: compressDistance(au) });
      }
    }

    for (const ring of ringsToDraw) {
      const points = [];
      const segments = 120;
      for (let i = 0; i <= segments; i += 1) {
        const angle = (i / segments) * TAU;
        points.push(projectPoint([
          Math.cos(angle) * ring.radius,
          Math.sin(angle) * ring.radius,
          0,
        ], camera, viewport));
      }
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x, points[i].y);
      ctx.strokeStyle = `rgba(146, 178, 221, ${(labelRings.has(ring.au) ? 0.1 : 0.05) * strength})`;
      ctx.setLineDash([1, 6]);
      ctx.stroke();
      ctx.setLineDash([]);

      if (labelRings.has(ring.au)) {
        const angle = -0.62 + camera.yaw;
        const labelPoint = projectPoint([
          Math.cos(angle) * ring.radius,
          Math.sin(angle) * ring.radius,
          0,
        ], camera, viewport);
        if (
          labelPoint.x > 24
          && labelPoint.x < viewport.width - 24
          && labelPoint.y > 90
          && labelPoint.y < viewport.height - 120
        ) {
          ctx.font = MONO_SMALL;
          if ('letterSpacing' in ctx) ctx.letterSpacing = '0.08em';
          ctx.fillStyle = `rgba(165, 192, 226, ${0.3 * strength})`;
          ctx.globalAlpha = 1;
          ctx.fillText(formatDistanceAU(ring.au), labelPoint.x + 5, labelPoint.y - 4);
        }
      }
    }

    ctx.restore();
  }

  function traceScreenPoints(trace, camera, blend, liveView) {
    const raw = Array.isArray(trace.points) ? trace.points : [];
    if (raw.length < 2) return null;

    const points = [];
    for (let i = 0; i < raw.length; i += 1) {
      const display = displayPosition(raw[i], blend);
      const projected = projectPoint(display, camera, viewport);
      if (Number.isFinite(projected.x) && Number.isFinite(projected.y)) points.push(projected);
    }
    if (points.length < 2) return null;

    // Bridge trace rebuild latency by ending the line at the live world.
    if (liveView && liveView.visible && !liveView.offscreen) {
      const last = points[points.length - 1];
      const gap = Math.hypot(last.x - liveView.x, last.y - liveView.y);
      if (gap > 0.6 && gap < 110) {
        points.push({ x: liveView.x, y: liveView.y });
      }
    }
    return points;
  }

  function drawTrace(ctx, body, points, trace, style, hovered, isLoop = false) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const margin = 100;
    if (
      maxX < -margin
      || minX > viewport.width + margin
      || maxY < -margin
      || minY > viewport.height + margin
    ) return;

    if (maxX - minX < 1.2 && maxY - minY < 1.2) return;

    const color = body.color || '#ffffff';
    const n = points.length;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = color;

    if (style === 'solid') {
      ctx.globalAlpha = hovered ? 0.7 : 0.4;
      ctx.lineWidth = hovered ? 1.7 : 1.1;
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < n; i += 1) ctx.lineTo(points[i].x, points[i].y);
      ctx.stroke();

      if (hovered) {
        ctx.globalAlpha = 0.09;
        ctx.lineWidth = 5;
        ctx.stroke();
      }
    } else if (style === 'always') {
      // Unbroken, high-contrast paths with a soft halo. Unlike Solid, these
      // are deliberately bright enough to read against the star field even
      // when several orbits cross; unlike Fading, every segment stays visible.
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < n; i += 1) ctx.lineTo(points[i].x, points[i].y);
      if (trace?.fullOrbit) ctx.closePath();

      ctx.strokeStyle = body.glow || color;
      ctx.globalAlpha = hovered ? 0.26 : 0.14;
      ctx.lineWidth = hovered ? 7 : 5.2;
      ctx.stroke();

      ctx.strokeStyle = color;
      ctx.globalAlpha = hovered ? 1 : 0.96;
      ctx.lineWidth = hovered ? 1.9 : 1.4;
      ctx.stroke();

      if (hovered) {
        ctx.strokeStyle = lighten(color, 0.55);
        ctx.globalAlpha = 0.24;
        ctx.lineWidth = 0.7;
        ctx.stroke();
      }
    } else {
      // For closed or apparent loops, a whisper of the whole path keeps the
      // scale legible while the bright head fades back into the sky.
      if (isLoop) {
        ctx.globalAlpha = 0.055;
        ctx.lineWidth = 0.85;
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < n; i += 1) ctx.lineTo(points[i].x, points[i].y);
        ctx.stroke();
      }

      const buckets = Math.min(34, Math.max(14, Math.floor(n / 9)));
      for (let b = 0; b < buckets; b += 1) {
        const start = Math.max(0, Math.floor((b * (n - 1)) / buckets));
        const end = Math.min(n - 1, Math.max(start + 1, Math.floor(((b + 1) * (n - 1)) / buckets)));
        if (end <= start) continue;

        ctx.beginPath();
        ctx.moveTo(points[start].x, points[start].y);
        for (let i = start + 1; i <= end; i += 1) ctx.lineTo(points[i].x, points[i].y);

        const t = end / Math.max(1, n - 1);
        const supplied = trace && Array.isArray(trace.alphas)
          ? trace.alphas[Math.min(end, trace.alphas.length - 1)]
          : null;
        const rawFade = Math.max(0, Math.min(1, Number.isFinite(supplied) ? supplied : Math.pow(t, 1.5)));
        // A gentle gamma lift keeps most of the orbit legible while the tail
        // still dissolves into the sky.
        const fade = Math.pow(rawFade, 0.62);
        ctx.globalAlpha = Math.max(0.01, fade * (hovered ? 1.08 : 0.84));
        ctx.lineWidth = (hovered ? 1.55 : 1.08) + t * 0.26;
        ctx.stroke();
      }

      // A faint bloom on the last stretch of the comet tail.
      const bloomStart = Math.max(0, Math.floor(n * 0.9));
      ctx.beginPath();
      ctx.moveTo(points[bloomStart].x, points[bloomStart].y);
      for (let i = bloomStart + 1; i < n; i += 1) ctx.lineTo(points[i].x, points[i].y);
      ctx.globalAlpha = hovered ? 0.12 : 0.065;
      ctx.lineWidth = hovered ? 7 : 4.5;
      ctx.stroke();
    }

    ctx.restore();
  }

  function drawScaleBar(camera, blend) {
    if (blend > 0.35 || viewport.width < 900) return;

    const target = 96;
    const rawAU = target / camera.scale;
    const nice = niceNumber(rawAU);
    const pixels = nice * camera.scale;
    if (!Number.isFinite(pixels) || pixels < 24 || pixels > 190) return;

    const right = viewport.width - 36;
    const y = 104;
    const left = right - pixels;

    let label;
    const km = nice * AU_KM;
    if (km < 1000000) {
      if (km >= 1000) {
        label = `${Math.round(km / 1000).toLocaleString('en-US')} thousand km`;
      } else {
        label = `${Math.round(km).toLocaleString('en-US')} km`;
      }
    } else if (nice >= 0.01 && nice < 0.1) {
      label = formatKm(km);
    } else {
      label = formatDistanceAU(nice);
    }

    ctx.save();
    ctx.strokeStyle = 'rgba(176, 201, 232, 0.36)';
    ctx.fillStyle = 'rgba(176, 201, 232, 0.56)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.moveTo(left, y - 3);
    ctx.lineTo(left, y + 3);
    ctx.moveTo(right, y - 3);
    ctx.lineTo(right, y + 3);
    ctx.stroke();

    ctx.font = MONO_SMALL;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0.1em';
    ctx.textAlign = 'center';
    ctx.fillText(label.toUpperCase(), (left + right) * 0.5, y - 8);
    ctx.textAlign = 'left';
    ctx.restore();
  }

  function draw(scene) {
    if (viewport.width <= 1 || viewport.height <= 1) resize();

    const {
      camera,
      atlasBlend = 0,
      bodies = [],
      positions = {},
      traces = [],
      centerId = 'sun',
      trailStyle = 'fading',
      showLabels = true,
      hiddenBodies = null,
      hoveredId = null,
      avoidRects = [],
      reducedMotion = false,
      timeMs = 0,
    } = scene || {};

    const time = Number.isFinite(timeMs) ? timeMs : 0;
    ctx.clearRect(0, 0, viewport.width, viewport.height);

    // --- Prepare the world layout once per frame ------------------------
    const centerPosition = positions[centerId] || [0, 0, 0];
    const hiddenSet = hiddenBodies instanceof Set
      ? hiddenBodies
      : new Set(Array.isArray(hiddenBodies) ? hiddenBodies : []);
    const isVisible = (id) => id === centerId || !hiddenSet.has(id);
    const views = [];
    const viewById = new Map();

    for (const body of bodies) {
      if (!isVisible(body.id)) continue;
      const helio = positions[body.id];
      if (!helio) continue;
      const relative = [
        (helio[0] || 0) - (centerPosition[0] || 0),
        (helio[1] || 0) - (centerPosition[1] || 0),
        (helio[2] || 0) - (centerPosition[2] || 0),
      ];
      const displayed = displayPosition(relative, atlasBlend);
      const screen = projectPoint(displayed, camera, viewport);
      const radius = markerRadius(body, atlasBlend, {
        hovered: body.id === hoveredId,
        isCenter: body.id === centerId,
      });
      const offscreen = (
        screen.x < -60
        || screen.x > viewport.width + 60
        || screen.y < -60
        || screen.y > viewport.height + 60
      );
      const visible = !offscreen;
      const view = {
        body,
        relative,
        displayed,
        x: screen.x,
        y: screen.y,
        depth: screen.depth,
        radius,
        visible,
        offscreen,
        hovered: body.id === hoveredId,
        isCenter: body.id === centerId,
      };
      views.push(view);
      viewById.set(body.id, view);
    }

    // --- Sky and atlas chart -------------------------------------------
    drawStars(camera, time, reducedMotion);

    // The Sun's atmospheric reach is drawn beneath the orbital paths.
    const sunView = viewById.get('sun');
    if (sunView && sunView.visible) {
      drawSunAura(ctx, sunView.x, sunView.y, sunView.radius, atlasBlend, time);
    }

    drawAtlasGrid(camera, atlasBlend, centerId);

    // --- Orbit traces ---------------------------------------------------
    const traceOrder = traces.slice().sort((a, b) => {
      const av = viewById.get(a.bodyId);
      const bv = viewById.get(b.bodyId);
      return (bv?.depth || 0) - (av?.depth || 0);
    });

    for (const trace of traceOrder) {
      const bodyView = viewById.get(trace.bodyId);
      if (!bodyView) continue;
      const points = traceScreenPoints(trace, camera, atlasBlend, bodyView);
      if (!points) continue;
      const isLoop = Boolean(trace.isClosed)
        || trace.bodyId === 'sun'
        || (trace.centerId === 'moon' && trace.bodyId === 'earth');
      drawTrace(
        ctx,
        bodyView.body,
        points,
        trace,
        trailStyle,
        trace.bodyId === hoveredId,
        isLoop,
      );
    }

    // --- Worlds ---------------------------------------------------------
    const sortedViews = views.slice().sort((a, b) => b.depth - a.depth);
    for (const view of sortedViews) {
      if (view.offscreen) continue;
      drawPlanet(ctx, view, time, reducedMotion);
    }

    // --- Labels and HUD -------------------------------------------------
    const labels = drawLabels(ctx, {
      viewport,
      showLabels,
      hoveredId,
      centerId,
      avoidRects,
      reducedMotion,
    }, sortedViews);

    drawScaleBar(camera, atlasBlend);

    // Origin reticle: a small, calm indication of the coordinate centre.
    const origin = projectPoint([0, 0, 0], camera, viewport);
    if (atlasBlend > 0.4) {
      ctx.save();
      ctx.globalAlpha = 0.32 * smoothstep(0.4, 0.9, atlasBlend);
      ctx.strokeStyle = 'rgba(190, 211, 237, 0.7)';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.arc(origin.x, origin.y, 7, 0, TAU);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(origin.x - 13, origin.y);
      ctx.lineTo(origin.x - 3, origin.y);
      ctx.moveTo(origin.x + 3, origin.y);
      ctx.lineTo(origin.x + 13, origin.y);
      ctx.moveTo(origin.x, origin.y - 13);
      ctx.lineTo(origin.x, origin.y - 3);
      ctx.moveTo(origin.x, origin.y + 3);
      ctx.lineTo(origin.x, origin.y + 13);
      ctx.stroke();
      ctx.restore();
    }

    const bodyLayout = views.map((view) => ({
      id: view.body.id,
      x: view.x,
      y: view.y,
      radius: view.radius,
      visible: view.visible,
      isCenter: view.isCenter,
    }));

    lastLayout = { bodies: bodyLayout, labels, origin };
    return lastLayout;
  }

  return {
    resize,
    draw,
    getLastLayout: () => lastLayout,
    getViewport: () => viewport,
  };
}
