/**
 * DOM controller for Solar Atlas.
 *
 * All UI state is echoed from a single `sync(state)` call; controls emit
 * intents through the `actions` object passed by main.js. The canvas knows
 * nothing about the DOM and this module knows nothing about orbital mechanics.
 */

import { BODIES, AU_KM } from './data.js';

export const SPEED_MIN = 0.020833333; // 30 minutes per real second
export const SPEED_MAX = 365.25; // one year per real second
export const DEFAULT_SPEED = 5; // five days per real second
export const SPEED_PRESETS = [1 / 24, 1, 7, 30.436875, 365.25];

const RELATIVE_HISTORY = { min: 0.5, max: 50, step: 0.5 };
const FIXED_HISTORY = { min: 1, max: 300, step: 1 };

const KIND_LABEL = {
  star: 'Star',
  planet: 'Planet',
  dwarf: 'Dwarf planet',
  moon: 'Satellite',
};

const KIND_GROUP = {
  star: 'Star',
  planet: 'Planets',
  dwarf: 'Dwarf planets',
  moon: 'Satellites',
};

const MONTH_FORMAT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

const TIME_FORMAT = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'UTC',
});

const ORBIT_DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

const FULL_FORMAT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
  timeZone: 'UTC',
});

function $(selector, root = document) {
  return root.querySelector(selector);
}

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

export function sliderToSpeed(value) {
  const t = clamp(Number(value) / 1000, 0, 1);
  return SPEED_MIN * Math.pow(SPEED_MAX / SPEED_MIN, t);
}

export function speedToSlider(speed) {
  const safe = clamp(Math.abs(Number(speed) || DEFAULT_SPEED), SPEED_MIN, SPEED_MAX);
  return Math.round((Math.log(safe / SPEED_MIN) / Math.log(SPEED_MAX / SPEED_MIN)) * 1000);
}

export function formatSpeed(speed) {
  const days = Math.abs(Number(speed) || DEFAULT_SPEED);
  const trim = (value) => {
    const rounded = Math.round(value);
    return Math.abs(value - rounded) < 1e-6 ? String(rounded) : value.toFixed(1);
  };
  const isOne = (value) => Math.abs(value - 1) < 0.02;
  let amount;

  if (days >= 300) {
    const years = days / 365.25;
    const shown = years >= 10 ? years.toFixed(0) : trim(years);
    amount = `${shown} ${isOne(years) ? 'year' : 'years'}`;
  } else if (days >= 15) {
    const months = days / 30.436875;
    const shown = months >= 10 ? months.toFixed(1) : trim(months);
    amount = `${shown} ${isOne(months) ? 'month' : 'months'}`;
  } else if (days >= 1) {
    const shown = days >= 10 ? days.toFixed(0) : trim(days);
    amount = `${shown} ${isOne(days) ? 'day' : 'days'}`;
  } else {
    const hours = days * 24;
    if (hours >= 1) {
      const shown = hours >= 10 ? hours.toFixed(0) : trim(hours);
      amount = `${shown} ${isOne(hours) ? 'hour' : 'hours'}`;
    } else {
      const minutes = hours * 60;
      const shown = minutes.toFixed(0);
      amount = `${shown} ${isOne(minutes) ? 'minute' : 'minutes'}`;
    }
  }

  return `${amount} / sec`;
}


function formatPeriod(days) {
  if (!Number.isFinite(days)) return '—';
  if (days >= 800) {
    const years = days / 365.25;
    return `${years.toFixed(years >= 100 ? 0 : years >= 10 ? 1 : 2)} yr`;
  }
  if (days >= 10) return `${days.toFixed(days >= 365 ? 1 : 2)} d`;
  return `${days.toFixed(2)} d`;
}

function formatDistanceToParent(body) {
  if (body.id === 'moon') {
    return `${Math.round(body.semiMajorAU * AU_KM).toLocaleString('en-US')} km`;
  }
  if (body.id === 'sun') return 'the system’s anchor';
  return `${body.semiMajorAU.toFixed(2)} AU`;
}

function centerMeta(body) {
  if (body.id === 'sun') {
    return 'G-type star · 99.86% of the system’s mass';
  }
  if (body.id === 'moon') {
    return `Orbits Earth · ${formatPeriod(body.orbitDays)}`;
  }
  return `Mean orbit ${body.semiMajorAU.toFixed(2)} AU · ${formatPeriod(body.orbitDays)}`;
}

function centerButtonMeta(body) {
  if (body.id === 'sun') return 'Star · the system’s anchor';
  if (body.id === 'moon') return `Satellite · ${formatDistanceToParent(body)} from Earth`;
  return `${KIND_LABEL[body.kind] || 'World'} · ${formatDistanceToParent(body)} from the Sun`;
}

export function createUI({ actions }) {
  let currentHistoryMode = 'relative';
  let historyCommitTimer = null;

  const refs = {
    body: document.body,
    canvas: $('#scene'),
    controls: $('#controls'),
    centerPicker: $('#center-picker'),
    centerButton: $('#center-button'),
    centerOrb: $('#center-orb'),
    centerName: $('#center-name'),
    centerType: $('#center-type'),
    centerDescriptor: $('#center-descriptor'),
    centerMeta: $('#center-meta'),
    centerMenu: $('#center-menu'),
    centerGroups: $('#center-menu-groups'),
    trailSwitch: $('#trail-switch'),
    historyControl: $('#history-control'),
    historyModeButtons: Array.from(document.querySelectorAll('[data-history-mode]')),
    historyRange: $('#history-range'),
    historyOutput: $('#history-output'),
    historyHint: $('#history-hint'),
    worldsOpen: $('#worlds-open'),
    worldsCount: $('#worlds-count'),
    worldsDialog: $('#worlds-dialog'),
    worldsClose: $('#worlds-close'),
    worldsAll: $('#worlds-all'),
    worldsCenterOnly: $('#worlds-center-only'),
    worldsSummary: $('#worlds-summary'),
    worldsOptions: $('#worlds-options'),
    labels: $('#toggle-labels'),
    resetView: $('#reset-view'),
    modeNote: $('#mode-note'),
    modeButtons: Array.from(document.querySelectorAll('[data-mode]')),
    trailButtons: Array.from(document.querySelectorAll('[data-trail]')),
    zoomIn: $('#zoom-in'),
    zoomOut: $('#zoom-out'),
    fitView: $('#fit-view'),
    reverse: $('#reverse'),
    play: $('#play'),
    speed: $('#speed'),
    speedLabel: $('#speed-label'),
    speedTicks: Array.from(document.querySelectorAll('.speed-tick')),
    now: $('#now'),
    dateDisplay: $('#date-display'),
    timeDisplay: $('#time-display'),
    dateEra: $('#date-era'),
    helpOpen: $('#help-open'),
    helpOverlay: $('#help-overlay'),
    helpClose: $('#help-close'),
    helpCard: $('#help-overlay .help-card'),
    hoverCard: $('#hover-card'),
    hoverDot: $('#hover-dot'),
    hoverName: $('#hover-name'),
    hoverMeta: $('#hover-meta'),
    hoverAction: $('#hover-card .hover-card__action'),
    toast: $('#toast'),
    liveRegion: $('#live-region'),
    veil: $('#veil'),
  };

  let optionsById = new Map();
  let menuOpen = false;
  let helpOpen = false;
  let worldsOpen = false;
  let lastFocus = null;
  let worldsLastFocus = null;
  const visibilityInputs = new Map();
  const worldRows = new Map();
  let toastTimer = null;
  let toastHideTimer = null;
  let menuCloseTimer = null;
  let helpCloseTimer = null;
  const modalHiddenBackground = new Map();

  /* ------------------------------------------------------------ center menu */

  function buildCenterMenu() {
    const groups = ['star', 'planet', 'dwarf', 'moon'];
    const fragment = document.createDocumentFragment();

    for (const kind of groups) {
      const members = BODIES.filter((body) => body.kind === kind);
      if (!members.length) continue;

      const group = document.createElement('div');
      group.className = 'center-group';
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', KIND_GROUP[kind]);

      const heading = document.createElement('p');
      heading.className = 'center-group__label';
      heading.setAttribute('aria-hidden', 'true');
      heading.textContent = KIND_GROUP[kind];
      group.appendChild(heading);

      for (const body of members) {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = 'center-option';
        option.dataset.center = body.id;
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', 'false');
        option.tabIndex = -1;
        const optionMeta = body.kind === 'star'
          ? 'Star'
          : body.id === 'moon'
            ? `${Math.round(body.semiMajorAU * AU_KM).toLocaleString('en-US')} km`
            : `${body.semiMajorAU.toFixed(2)} AU`;
        option.title = `${body.name}-centered view`;
        option.innerHTML = `
          <span class="center-option__dot" style="--body-color:${body.color}"></span>
          <span class="center-option__name">${body.name}</span>
          <span class="center-option__meta">${optionMeta}</span>
        `;
        option.addEventListener('click', () => {
          actions.setCenter(body.id);
          closeCenterMenu(true);
        });
        group.appendChild(option);
        optionsById.set(body.id, option);
      }

      fragment.appendChild(group);
    }

    refs.centerGroups.replaceChildren(fragment);
  }

  /* --------------------------------------------------------------- worlds */

  function buildWorldsOptions() {
    const fragment = document.createDocumentFragment();

    for (const body of BODIES) {
      const row = document.createElement('label');
      row.className = 'world-option';
      row.dataset.bodyId = body.id;
      row.style.setProperty('--body-color', body.color);

      const dot = document.createElement('span');
      dot.className = 'world-option__dot';
      dot.setAttribute('aria-hidden', 'true');

      const text = document.createElement('span');
      text.className = 'world-option__text';

      const name = document.createElement('span');
      name.className = 'world-option__name';
      name.textContent = body.name;

      const meta = document.createElement('span');
      meta.className = 'world-option__meta';
      meta.textContent = KIND_LABEL[body.kind] ?? body.kind;
      text.append(name, meta);

      const check = document.createElement('span');
      check.className = 'world-option__check';

      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = true;
      input.addEventListener('change', () => {
        actions.setVisibility(body.id, input.checked);
      });

      const box = document.createElement('span');
      box.className = 'world-option__box';
      box.setAttribute('aria-hidden', 'true');
      check.append(input, box);

      row.append(dot, text, check);
      fragment.appendChild(row);
      visibilityInputs.set(body.id, input);
      worldRows.set(body.id, { row, meta, input });
    }

    refs.worldsOptions.replaceChildren(fragment);
  }

  function openWorldsDialog() {
    if (worldsOpen || !refs.worldsDialog) return;
    worldsLastFocus = refs.worldsOpen;
    closeCenterMenu(true, true);
    closeHelp(true);
    hideToast();
    worldsOpen = true;
    refs.worldsOpen.setAttribute('aria-expanded', 'true');
    refs.worldsDialog.showModal();
    window.requestAnimationFrame(() => {
      const first = refs.worldsOptions.querySelector('input:not(:disabled)');
      first?.focus({ preventScroll: true });
    });
  }

  function closeWorldsDialog() {
    if (!worldsOpen) return;
    worldsOpen = false;
    refs.worldsOpen.setAttribute('aria-expanded', 'false');
    if (refs.worldsDialog.open) refs.worldsDialog.close();
  }

  function onWorldsDialogClose() {
    worldsOpen = false;
    refs.worldsOpen.setAttribute('aria-expanded', 'false');
    const target = worldsLastFocus && worldsLastFocus.isConnected
      ? worldsLastFocus
      : refs.worldsOpen;
    worldsLastFocus = null;
    try { target.focus({ preventScroll: true }); } catch { /* noop */ }
  }

  function openCenterMenu() {
    if (menuOpen) return;
    if (worldsOpen) closeWorldsDialog();
    hideToast();
    closeHelp(true);
    menuOpen = true;
    if (menuCloseTimer) {
      window.clearTimeout(menuCloseTimer);
      menuCloseTimer = null;
    }
    refs.centerMenu.hidden = false;
    refs.centerPicker.classList.add('is-open');
    refs.centerButton.setAttribute('aria-expanded', 'true');
    const currentId = refs.centerButton.dataset.currentCenter;
    const selected = optionsById.get(currentId) || refs.centerGroups.querySelector('.center-option');
    window.requestAnimationFrame(() => {
      refs.centerMenu.classList.add('is-open');
      if (selected) {
        selected.scrollIntoView({ block: 'nearest' });
        selected.focus({ preventScroll: true });
      }
    });
  }

  function closeCenterMenu(returnFocus = false, immediate = false) {
    if (!menuOpen) return;
    menuOpen = false;
    refs.centerMenu.classList.remove('is-open');
    refs.centerPicker.classList.remove('is-open');
    refs.centerButton.setAttribute('aria-expanded', 'false');
    if (menuCloseTimer) {
      window.clearTimeout(menuCloseTimer);
      menuCloseTimer = null;
    }
    if (immediate) {
      refs.centerMenu.hidden = true;
    } else {
      menuCloseTimer = window.setTimeout(() => {
        if (!menuOpen) refs.centerMenu.hidden = true;
        menuCloseTimer = null;
      }, 130);
    }
    if (returnFocus) refs.centerButton.focus({ preventScroll: true });
  }

  function currentOptions() {
    return Array.from(refs.centerGroups.querySelectorAll('.center-option'));
  }

  function onMenuKeyDown(event) {
    if (!menuOpen) return;
    const options = currentOptions();
    const index = options.indexOf(document.activeElement);

    if (event.key === 'Escape') {
      event.preventDefault();
      closeCenterMenu(true);
      return;
    }
    if (event.key === 'Tab') {
      // Return focus to the trigger before the browser advances the tab order.
      closeCenterMenu(true, true);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const next = index < 0
        ? (delta > 0 ? 0 : options.length - 1)
        : (index + delta + options.length) % options.length;
      options[next].focus();
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      options[event.key === 'Home' ? 0 : options.length - 1].focus();
    }
  }

  /* ------------------------------------------------------------------ help */

  function setModalBackgroundInert(inert) {
    const targets = [
      document.querySelector('.masthead'),
      document.querySelector('.controls'),
      document.querySelector('.timebar'),
      document.querySelector('.view-controls'),
      document.querySelector('.canvas-hint'),
      document.querySelector('.skip-link'),
      document.querySelector('.toast'),
      refs.canvas,
    ].filter(Boolean);

    if (inert) {
      for (const element of targets) {
        if (modalHiddenBackground.has(element)) continue;
        modalHiddenBackground.set(element, {
          ariaHidden: element.getAttribute('aria-hidden'),
          inert: element.hasAttribute('inert'),
        });
        element.setAttribute('aria-hidden', 'true');
        element.setAttribute('inert', '');
      }
    } else {
      for (const [element, previous] of modalHiddenBackground) {
        if (previous.ariaHidden === null) element.removeAttribute('aria-hidden');
        else element.setAttribute('aria-hidden', previous.ariaHidden);
        if (!previous.inert) element.removeAttribute('inert');
      }
      modalHiddenBackground.clear();
    }
  }

  function openHelp() {
    if (helpOpen) return;
    if (worldsOpen) closeWorldsDialog();
    hideToast();
    closeCenterMenu(true, true);
    lastFocus = document.activeElement;
    helpOpen = true;
    if (helpCloseTimer) {
      window.clearTimeout(helpCloseTimer);
      helpCloseTimer = null;
    }
    refs.helpOverlay.hidden = false;
    setModalBackgroundInert(true);
    refs.body.classList.add('is-help-open');
    window.requestAnimationFrame(() => {
      refs.helpOverlay.classList.add('is-open');
      refs.helpClose.focus({ preventScroll: true });
    });
  }

  function closeHelp(immediate = false) {
    if (!helpOpen) return;
    helpOpen = false;
    refs.helpOverlay.classList.remove('is-open');
    refs.body.classList.remove('is-help-open');
    setModalBackgroundInert(false);
    const finish = () => {
      refs.helpOverlay.hidden = true;
      helpCloseTimer = null;
    };
    if (immediate) {
      finish();
    } else {
      helpCloseTimer = window.setTimeout(finish, 190);
    }
    if (lastFocus && typeof lastFocus.focus === 'function') {
      try { lastFocus.focus({ preventScroll: true }); } catch { /* noop */ }
    }
  }

  function trapHelpFocus(event) {
    if (!helpOpen || event.key !== 'Tab') return;
    const focusables = refs.helpOverlay.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  /* ---------------------------------------------------------------- hover */

  function hideHover() {
    refs.hoverCard.hidden = true;
    refs.hoverCard.classList.remove('is-visible');
  }

  function showHover({
    name,
    meta,
    color,
    x,
    y,
    isCenter,
    action = null,
    preferBelow = false,
  }) {
    refs.hoverDot.style.setProperty('--body-color', color);
    refs.hoverName.textContent = name;
    refs.hoverMeta.textContent = meta;
    refs.hoverAction.textContent = action ?? (isCenter ? 'current center' : 'click to center');
    refs.hoverCard.hidden = false;
    refs.hoverCard.classList.add('is-visible');

    const cardW = refs.hoverCard.offsetWidth || 232;
    const cardH = refs.hoverCard.offsetHeight || 52;
    const left = clamp(x + 16, 10, window.innerWidth - cardW - 10);
    const below = y + 16;
    const above = y - cardH - 12;
    let top = preferBelow ? below : above;
    if (top < 10) top = below;
    else if (top + cardH > window.innerHeight - 10) top = above;
    top = clamp(top, 10, window.innerHeight - cardH - 10);
    refs.hoverCard.style.left = `${left}px`;
    refs.hoverCard.style.top = `${top}px`;
  }

  function showOrbitHover({ name, color, date, x, y }) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return;
    showHover({
      name,
      meta: `${ORBIT_DATE_FORMAT.format(date)} · ${TIME_FORMAT.format(date)} UTC`,
      color,
      x,
      y,
      isCenter: false,
      action: '',
      preferBelow: (globalThis.matchMedia?.('(pointer: coarse)')?.matches ?? false)
        && y < window.innerHeight * 0.55,
    });
  }

  /* ---------------------------------------------------------------- toast */

  function hideToast() {
    if (toastTimer) {
      window.clearTimeout(toastTimer);
      toastTimer = null;
    }
    if (toastHideTimer) {
      window.clearTimeout(toastHideTimer);
      toastHideTimer = null;
    }
    refs.toast.classList.remove('is-visible');
    refs.toast.hidden = true;
  }

  function showToast(message) {
    if (!message) return;
    refs.toast.textContent = message;
    refs.toast.hidden = false;
    if (toastTimer) window.clearTimeout(toastTimer);
    if (toastHideTimer) window.clearTimeout(toastHideTimer);
    window.requestAnimationFrame(() => refs.toast.classList.add('is-visible'));
    toastTimer = window.setTimeout(() => {
      refs.toast.classList.remove('is-visible');
      toastHideTimer = window.setTimeout(() => {
        refs.toast.hidden = true;
        toastHideTimer = null;
      }, 240);
      toastTimer = null;
    }, 2500);
  }

  function announce(message) {
    if (!message) return;
    refs.liveRegion.textContent = '';
    window.setTimeout(() => {
      refs.liveRegion.textContent = message;
    }, 30);
  }

  /* ------------------------------------------------------------------ sync */

  function setSpeedVisuals(speed) {
    const sliderValue = speedToSlider(speed);
    refs.speed.value = String(sliderValue);
    refs.speed.style.setProperty('--range-progress', `${sliderValue / 10}%`);
    refs.speedLabel.textContent = formatSpeed(speed);
    refs.speed.setAttribute('aria-valuetext', `${formatSpeed(speed)}`);

    const current = Math.abs(speed);
    for (const tick of refs.speedTicks) {
      const preset = Number(tick.dataset.days);
      const active = Math.abs(current - preset) / preset < 0.035;
      tick.classList.toggle('is-active', active);
      tick.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }

  function clearHistoryTimer() {
    if (historyCommitTimer) {
      window.clearTimeout(historyCommitTimer);
      historyCommitTimer = null;
    }
  }

  function formatHistoryValue(mode, value) {
    if (mode === 'fixed') {
      return `${value} ${value === 1 ? 'year' : 'years'}`;
    }
    return `${value}×`;
  }

  function updateHistoryControl(mode, value) {
    const fixed = mode === 'fixed';
    const spec = fixed ? FIXED_HISTORY : RELATIVE_HISTORY;
    refs.historyRange.min = String(spec.min);
    refs.historyRange.max = String(spec.max);
    refs.historyRange.step = String(spec.step);
    refs.historyRange.value = String(value);
    const progress = (Number(value) - spec.min) / (spec.max - spec.min);
    refs.historyRange.style.setProperty('--history-fill', `${Math.max(0, Math.min(1, progress)) * 100}%`);
    const label = formatHistoryValue(mode, value);
    refs.historyOutput.textContent = label;
    refs.historyRange.setAttribute('aria-label', fixed
      ? 'Fixed history window in years'
      : 'Relative history multiplier');
    refs.historyRange.setAttribute('aria-valuetext', label);
    if (fixed) refs.historyRange.setAttribute('aria-describedby', 'history-hint');
    else refs.historyRange.removeAttribute('aria-describedby');
  }

  function commitHistoryValue() {
    clearHistoryTimer();
    const value = Number(refs.historyRange.value);
    if (currentHistoryMode === 'fixed') actions.setHistoryYears(Math.round(value));
    else actions.setTrailSpan(value);
  }

  function sync(state) {
    const center = BODIES.find((body) => body.id === state.centerId) || BODIES[0];

    // Centre UI.
    refs.centerButton.dataset.currentCenter = center.id;
    refs.centerOrb.style.setProperty('--body-color', center.color);
    refs.centerName.textContent = center.name;
    refs.centerType.textContent = centerButtonMeta(center);
    refs.centerDescriptor.textContent = center.centric;
    refs.centerDescriptor.title = `${center.name}-centered view`;
    refs.centerMeta.textContent = centerMeta(center);
    refs.centerButton.setAttribute('aria-label', `Center of view: ${center.name}. Change center.`);

    for (const [id, option] of optionsById) {
      const selected = id === center.id;
      option.classList.toggle('is-selected', selected);
      option.setAttribute('aria-selected', selected ? 'true' : 'false');
    }

    // Mode.
    for (const button of refs.modeButtons) {
      const active = button.dataset.mode === state.mode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    refs.body.classList.toggle('is-atlas', state.mode === 'atlas');
    refs.body.classList.toggle('is-overview', state.mode === 'overview');
    refs.modeNote.textContent = state.mode === 'atlas'
      ? 'Radial distance compressed · top-down. Every world in one frame.'
      : state.mode === 'overview'
        ? 'True distances, true ellipses · top-down. Same line styles and spans as Orbits; no radial compression.'
        : center.id === 'sun'
          ? 'True distances & inclinations. Overview and Atlas are top-down.'
          : `${center.name}-centered view. True distances; Fit reveals the whole system.`;

    // Orbit style.
    for (const button of refs.trailButtons) {
      const active = button.dataset.trail === state.trailStyle;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    const always = state.trailStyle === 'always';
    const historyMode = state.historyMode === 'fixed' ? 'fixed' : 'relative';
    currentHistoryMode = historyMode;
    refs.historyControl.hidden = always;
    for (const button of refs.historyModeButtons) {
      const active = button.dataset.historyMode === historyMode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    const historyValue = historyMode === 'fixed' ? state.historyYears : state.trailSpan;
    updateHistoryControl(historyMode, historyValue);
    refs.historyHint.hidden = historyMode !== 'fixed';
    refs.historyControl.title = always
      ? 'Always shows complete orbits.'
      : historyMode === 'fixed'
        ? `Fixed ${state.historyYears}-year limit for every visible world. Repeated cycles stop after twelve loops to keep overlapping history readable and fast.`
        : 'Relative windows: multiples of each body\'s automatic history.';

    // Labels.
    refs.labels.checked = Boolean(state.labels);

    // Visible worlds.
    const hiddenSet = state.hiddenBodies instanceof Set
      ? state.hiddenBodies
      : new Set(Array.isArray(state.hiddenBodies) ? state.hiddenBodies : []);
    const visibleBodies = BODIES.filter(
      (body) => body.id === state.centerId || !hiddenSet.has(body.id),
    );
    const visibleCount = visibleBodies.length;
    refs.worldsCount.textContent = String(visibleCount);
    refs.worldsOpen.classList.toggle('is-filtered', visibleCount < BODIES.length);
    refs.worldsOpen.setAttribute(
      'aria-label',
      `${visibleCount} of ${BODIES.length} worlds visible. Show or hide worlds.`,
    );
    refs.worldsOpen.title = visibleCount === BODIES.length
      ? 'Show or hide worlds and their orbits'
      : `${visibleCount} of ${BODIES.length} worlds visible — choose worlds`;
    refs.worldsSummary.textContent = `${visibleCount} / ${BODIES.length} visible`;
    refs.worldsAll.disabled = visibleCount === BODIES.length;
    refs.worldsCenterOnly.disabled = visibleCount === 1;

    for (const body of BODIES) {
      const entry = worldRows.get(body.id);
      if (!entry) continue;
      const isCenter = body.id === state.centerId;
      const isVisible = isCenter || !hiddenSet.has(body.id);
      entry.input.checked = isVisible;
      entry.input.disabled = isCenter;
      entry.row.classList.toggle('is-center', isCenter);
      entry.row.classList.toggle('is-hidden', !isVisible);
      entry.meta.textContent = isCenter
        ? 'Center'
        : (KIND_LABEL[body.kind] ?? body.kind);
      entry.row.title = isCenter
        ? `${body.name} is the center and always stays visible.`
        : `${isVisible ? 'Hide' : 'Show'} ${body.name}, its label and orbit.`;
    }

    // Time transport.
    refs.play.dataset.playing = state.playing ? 'true' : 'false';
    refs.play.setAttribute('aria-label', state.playing ? 'Pause simulation' : 'Resume simulation');
    refs.play.setAttribute('aria-pressed', state.playing ? 'true' : 'false');
    refs.reverse.classList.toggle('is-active', state.direction < 0);
    refs.reverse.setAttribute('aria-pressed', state.direction < 0 ? 'true' : 'false');
    setSpeedVisuals(state.speedDaysPerSec);

    // The canvas is the primary visual; give assistive tech a useful summary.
    if (refs.canvas) {
      refs.canvas.setAttribute(
        'aria-label',
        `Orbital map of the Solar System centered on ${center.name}, shown in ${state.mode === 'atlas' ? 'top-down compressed atlas' : state.mode === 'overview' ? 'top-down true-scale overview' : 'tilted orbit'} view. ${state.playing ? 'Simulation running' : 'Simulation paused'} at ${formatSpeed(state.speedDaysPerSec)}. ${visibleCount} of ${BODIES.length} worlds visible.`,
      );
    }
  }

  function updateTime({ date, jd, outsidePrimaryEra, paused }) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return;
    const dateText = MONTH_FORMAT.format(date);
    const timeText = TIME_FORMAT.format(date);
    refs.dateDisplay.textContent = dateText;
    refs.dateDisplay.setAttribute('datetime', date.toISOString());
    refs.timeDisplay.textContent = `${timeText} UTC · JD ${jd.toFixed(2)}`;
    refs.dateDisplay.title = `${FULL_FORMAT.format(date)} UTC`;

    if (outsidePrimaryEra) {
      refs.dateEra.hidden = false;
      refs.dateEra.textContent = 'extended solution';
    } else {
      refs.dateEra.hidden = true;
    }

    refs.now.classList.toggle('is-active', Math.abs(Date.now() - date.getTime()) < 60000);
  }

  /* -------------------------------------------------------------- bindings */

  function bind() {
    buildCenterMenu();
    buildWorldsOptions();

    refs.centerButton.addEventListener('click', () => {
      if (menuOpen) closeCenterMenu(true);
      else openCenterMenu();
    });

    refs.centerButton.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        openCenterMenu();
      }
    });

    refs.centerMenu.addEventListener('keydown', onMenuKeyDown);

    document.addEventListener('pointerdown', (event) => {
      if (!menuOpen || refs.centerPicker.contains(event.target)) return;
      const focusWasInside = refs.centerMenu.contains(document.activeElement);
      closeCenterMenu(focusWasInside);
    });

    for (const button of refs.modeButtons) {
      button.addEventListener('click', () => actions.setMode(button.dataset.mode));
    }

    for (const button of refs.trailButtons) {
      button.addEventListener('click', () => actions.setTrailStyle(button.dataset.trail));
    }

    for (const button of refs.historyModeButtons) {
      button.addEventListener('click', () => {
        clearHistoryTimer();
        actions.setHistoryMode(button.dataset.historyMode);
      });
    }

    refs.historyRange.addEventListener('input', () => {
      updateHistoryControl(currentHistoryMode, Number(refs.historyRange.value));
      clearHistoryTimer();
      historyCommitTimer = window.setTimeout(commitHistoryValue, 140);
    });
    refs.historyRange.addEventListener('change', () => {
      commitHistoryValue();
    });

    refs.worldsOpen.addEventListener('click', () => openWorldsDialog());
    refs.worldsOpen.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        openWorldsDialog();
      }
    });
    refs.worldsClose.addEventListener('click', () => closeWorldsDialog());
    refs.worldsAll.addEventListener('click', () => actions.setAllVisible(true));
    refs.worldsCenterOnly.addEventListener('click', () => actions.setAllVisible(false));
    refs.worldsDialog.addEventListener('close', onWorldsDialogClose);
    refs.worldsDialog.addEventListener('click', (event) => {
      if (event.target === refs.worldsDialog) closeWorldsDialog();
    });

    refs.labels.addEventListener('change', () => actions.setLabels(refs.labels.checked));

    refs.play.addEventListener('click', () => actions.togglePlay());
    refs.reverse.addEventListener('click', () => actions.toggleReverse());
    refs.now.addEventListener('click', () => actions.setNow());

    refs.speed.addEventListener('input', () => {
      const speed = sliderToSpeed(Number(refs.speed.value));
      setSpeedVisuals(speed);
      actions.setSpeed(speed);
    });

    for (const tick of refs.speedTicks) {
      tick.addEventListener('click', () => {
        const speed = Number(tick.dataset.days);
        actions.setSpeed(speed);
      });
    }

    refs.zoomIn.addEventListener('click', () => actions.zoomIn());
    refs.zoomOut.addEventListener('click', () => actions.zoomOut());
    refs.fitView.addEventListener('click', () => actions.fitView());
    refs.resetView.addEventListener('click', () => actions.resetView());

    refs.helpOpen.addEventListener('click', () => openHelp());
    refs.helpClose.addEventListener('click', () => closeHelp());
    refs.helpOverlay.addEventListener('click', (event) => {
      if (event.target.closest('[data-close-help]')) closeHelp();
    });
    refs.helpOverlay.addEventListener('keydown', trapHelpFocus);

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (menuOpen) {
          closeCenterMenu(true);
          event.preventDefault();
        } else if (helpOpen) {
          closeHelp();
          event.preventDefault();
        }
      }
    });

    // If the pointer leaves the window, the tooltip should not linger.
    window.addEventListener('blur', () => hideHover());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) hideHover();
    });
  }

  bind();

  return {
    sync,
    updateTime,
    showHover,
    showOrbitHover,
    hideHover,
    showToast,
    announce,
    openHelp,
    closeHelp,
    openWorldsDialog,
    closeWorldsDialog,
    setVeilDone() {
      if (!refs.veil) return;
      refs.veil.classList.add('is-gone');
      refs.body.classList.remove('is-loading');
      refs.body.classList.add('is-ready');
      window.setTimeout(() => {
        refs.veil?.remove();
      }, 900);
    },
    isHelpOpen: () => helpOpen,
    isCenterMenuOpen: () => menuOpen,
    isWorldsOpen: () => worldsOpen,
    refs,
  };
}
