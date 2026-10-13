import { BLACK_HOLES, OBSERVERS, fmt } from './physics.js';
import { QUALITY } from './renderer.js';
import { blackbodyCSS } from './blackbody.js';

const $ = (id) => document.getElementById(id);

const pct = (v) => `${Math.round(v * 100)}%`;
const times = (v) => `${v.toFixed(2)}×`;

// Control definitions, grouped as they appear in the drawer.
const CONTROLS = {
  'group-spacetime': [
    { key: 'curvature', type: 'range', label: 'Curvature', min: 0, max: 1, step: 0.005,
      format: (v) => (v >= 0.995 ? 'Schwarzschild' : v <= 0.005 ? 'Flat' : pct(v)) },
  ],
  'group-disk': [
    { key: 'diskOn', type: 'toggle', label: 'Show the disk' },
    { key: 'diskTemp', type: 'range', label: 'Peak temperature', min: 1800, max: 30000, log: true, temp: true,
      format: (v) => `${(Math.round(v / 50) * 50).toLocaleString('en-US')} K` },
    { key: 'diskOuter', type: 'range', label: 'Outer edge', min: 5, max: 30, step: 0.5, format: (v) => `${v.toFixed(1)} rₛ` },
    { key: 'diskDensity', type: 'range', label: 'Gas density', min: 0.1, max: 5, log: true, format: times },
    { key: 'corona', type: 'range', label: 'Corona glow', min: 0, max: 0.5, step: 0.01, format: (v) => v.toFixed(2) },
  ],
  'group-light': [
    { key: 'doppler', type: 'toggle', label: 'Doppler shift and beaming' },
    { key: 'gravShift', type: 'toggle', label: 'Gravitational redshift' },
    { key: 'eht', type: 'toggle', label: 'Radio telescope view (EHT)' },
  ],
  'group-camera': [
    { key: 'fov', type: 'range', label: 'Field of view', min: 15, max: 120, step: 1, camera: true, format: (v) => `${Math.round(v)}°` },
    { key: 'exposure', type: 'range', label: 'Exposure', min: 0.2, max: 5, log: true, format: (v) => `${v >= 1 ? '+' : ''}${Math.log2(v).toFixed(1)} EV` },
    { key: 'bloom', type: 'range', label: 'Glow', min: 0, max: 0.4, step: 0.005, format: (v) => v.toFixed(2) },
    { key: 'starGain', type: 'range', label: 'Starlight', min: 0, max: 3, step: 0.05, format: times },
    { key: 'timeSpeed', type: 'range', label: 'Time speed', min: 0, max: 4, step: 0.05, user: true, format: (v) => (v === 0 ? 'Paused' : times(v)) },
  ],
};

export class UI {
  constructor(app) {
    this.app = app;
    this.inputs = new Map();
    this.toastTimer = 0;
    this.buildControls();
    this.buildSegments();
    this.bindChrome();
    app.params.onChange((key, v) => this.sync(key, v));
  }

  // ---------------------------------------------------------------- controls
  buildControls() {
    for (const [groupId, defs] of Object.entries(CONTROLS)) {
      const group = $(groupId);
      for (const def of defs) group.appendChild(def.type === 'toggle' ? this.makeToggle(def) : this.makeRange(def));
    }
    // Paint the temperature track with real blackbody colours.
    const stops = [];
    for (let i = 0; i <= 12; i++) {
      const T = Math.exp(Math.log(1800) + (Math.log(30000) - Math.log(1800)) * (i / 12));
      stops.push(`${blackbodyCSS(T)} ${((i / 12) * 100).toFixed(1)}%`);
    }
    document.documentElement.style.setProperty('--bb-stops', stops.join(', '));
  }

  makeRange(def, idPrefix = 'c') {
    const wrap = document.createElement('label');
    wrap.className = `slider${def.temp ? ' temp' : ''}`;
    const id = `${idPrefix}-${def.key}`;
    wrap.htmlFor = id;
    const row = document.createElement('span');
    row.className = 'row';
    const name = document.createElement('span');
    name.textContent = def.label;
    const out = document.createElement('output');
    row.append(name, out);
    const input = document.createElement('input');
    input.type = 'range';
    input.id = id;
    input.min = 0;
    input.max = 1000;
    input.step = 1;
    const toSlider = (v) => (def.log
      ? (Math.log(v) - Math.log(def.min)) / (Math.log(def.max) - Math.log(def.min))
      : (v - def.min) / (def.max - def.min)) * 1000;
    const fromSlider = (s) => {
      const t = s / 1000;
      let v = def.log ? Math.exp(Math.log(def.min) + (Math.log(def.max) - Math.log(def.min)) * t) : def.min + (def.max - def.min) * t;
      if (def.step) v = Math.round(v / def.step) * def.step;
      return v;
    };
    const show = (v) => { out.textContent = def.format(v); };
    input.addEventListener('input', () => {
      const v = fromSlider(+input.value);
      show(v);
      this.app.setParam(def, v);
      if (idPrefix === 'cap') this.app.tour.touchedControl();
    });
    wrap.append(row, input);
    const entry = { def, input, set: (v) => { input.value = toSlider(v); show(v); } };
    this.register(def.key, entry);
    entry.set(def.camera ? this.app.camera[def.key] : def.user ? this.app.userTimeSpeed : this.app.params.target[def.key]);
    return wrap;
  }

  makeToggle(def, idPrefix = 'c') {
    const wrap = document.createElement('label');
    wrap.className = 'switch';
    const id = `${idPrefix}-${def.key}`;
    wrap.htmlFor = id;
    const name = document.createElement('span');
    name.textContent = def.label;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = id;
    input.setAttribute('role', 'switch');
    input.addEventListener('change', () => {
      this.app.setParam(def, input.checked ? 1 : 0);
      if (idPrefix === 'cap') this.app.tour.touchedControl();
    });
    wrap.append(name, input);
    const entry = { def, input, set: (v) => { input.checked = v > 0.5; } };
    this.register(def.key, entry);
    entry.set(this.app.params.target[def.key]);
    return wrap;
  }

  register(key, entry) {
    if (!this.inputs.has(key)) this.inputs.set(key, []);
    this.inputs.get(key).push(entry);
  }

  sync(key, v) {
    for (const entry of this.inputs.get(key) || []) {
      if (document.activeElement !== entry.input) entry.set(v);
    }
  }

  buildSegments() {
    const app = this.app;
    this.segment('seg-mass', BLACK_HOLES.map((b) => ({ value: b.id, label: b.name })), app.massId, (v) => app.setMass(v, true));
    this.segment('seg-observer', Object.entries(OBSERVERS).map(([value, o]) => ({ value, label: o.label })), app.observer, (v) => app.setObserver(v));
    this.segment('seg-quality', [{ value: 'auto', label: 'Auto' }, ...Object.entries(QUALITY).map(([value, q]) => ({ value, label: q.label }))], 'auto', (v) => app.setQuality(v));
    this.refreshNotes();
  }

  segment(id, options, current, onPick) {
    const el = $(id);
    el.innerHTML = '';
    for (const o of options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.value = o.value;
      b.textContent = o.label;
      b.setAttribute('aria-checked', String(o.value === current));
      b.addEventListener('click', () => onPick(o.value));
      el.appendChild(b);
    }
  }

  setSegment(id, value) {
    for (const b of $(id).children) b.setAttribute('aria-checked', String(b.dataset.value === value));
  }

  refreshNotes() {
    const bh = BLACK_HOLES.find((b) => b.id === this.app.massId);
    $('note-mass').textContent = `${bh.note}. ${massText(bh.mass)}.`;
    $('note-observer').textContent = OBSERVERS[this.app.observer].blurb + '.';
    $('brand-bh').textContent = bh.name;
    $('brand-mass').textContent = massText(bh.mass);
    this.setSegment('seg-mass', this.app.massId);
    this.setSegment('seg-observer', this.app.observer);
  }

  // ---------------------------------------------------------------- chrome
  bindChrome() {
    const app = this.app;
    $('btn-tour').addEventListener('click', () => (app.tour.active ? app.tour.stop() : app.startTour()));
    $('btn-controls').addEventListener('click', () => this.toggleControls());
    $('controls-close').addEventListener('click', () => this.toggleControls(false));
    $('btn-about').addEventListener('click', () => this.toggleAbout(true));
    $('about-close').addEventListener('click', () => this.toggleAbout(false));
    $('about').addEventListener('click', (e) => { if (e.target.id === 'about') this.toggleAbout(false); });
    $('btn-sound').addEventListener('click', () => app.toggleSound());
    $('btn-capture').addEventListener('click', () => app.capture());
    $('btn-hide').addEventListener('click', () => this.toggleHidden(true));
    $('btn-full').addEventListener('click', () => app.toggleFullscreen());
    $('c-reset').addEventListener('click', () => app.resetAll());
    $('cap-next').addEventListener('click', () => app.tour.next());
    $('cap-prev').addEventListener('click', () => app.tour.prev());
    $('cap-exit').addEventListener('click', () => app.tour.stop());
    if (!document.documentElement.requestFullscreen) $('btn-full').hidden = true;
    if (window.top !== window.self) $('btn-capture').hidden = true; // downloads are blocked in embeds
  }

  toggleControls(force) {
    const el = $('controls');
    const open = force ?? el.hidden;
    el.hidden = !open;
    $('btn-controls').setAttribute('aria-expanded', String(open));
    document.body.classList.toggle('controls-open', open);
  }

  toggleAbout(open) {
    $('about').hidden = !open;
    if (open) $('about-close').focus();
  }

  toggleHidden(force) {
    const ui = $('ui');
    const hide = force ?? !ui.classList.contains('hidden-ui');
    ui.classList.toggle('hidden-ui', hide);
    if (hide) this.toast('Interface hidden. Press H or tap the screen to bring it back.', 2600, true);
  }

  get uiHidden() { return $('ui').classList.contains('hidden-ui'); }

  toast(msg, ms = 2600, force = false) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    if (force) el.style.opacity = 1;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { el.classList.remove('show'); el.style.opacity = ''; }, ms);
  }

  setSoundPressed(on) { $('btn-sound').setAttribute('aria-pressed', String(on)); }

  // ---------------------------------------------------------------- tour caption
  showChapter(i, n, ch, body) {
    document.body.classList.add('touring');
    $('btn-tour').setAttribute('aria-pressed', 'true');
    $('btn-tour').title = 'Leave the tour (T)';
    $('hint').classList.add('gone');
    const cap = $('caption');
    cap.hidden = false;
    $('cap-count').textContent = `${String(i + 1).padStart(2, '0')} / ${String(n).padStart(2, '0')}`;
    $('cap-title').textContent = ch.title;
    const p = $('cap-body');
    p.textContent = body;
    p.classList.remove('swap');
    void p.offsetWidth;
    p.classList.add('swap');
    $('cap-prev').disabled = i === 0;
    $('cap-next').disabled = i === n - 1;
    const ctl = $('cap-control');
    ctl.innerHTML = '';
    this.inputs.forEach((list, key) => this.inputs.set(key, list.filter((e) => !e.input.id.startsWith('cap-'))));
    if (ch.control) {
      const def = Object.values(CONTROLS).flat().find((d) => d.key === ch.control.key);
      const spec = { ...def, label: ch.control.label };
      ctl.appendChild(spec.type === 'toggle' ? this.makeToggle(spec, 'cap') : this.makeRange(spec, 'cap'));
    }
    $('cap-progress').style.width = '0%';
  }

  setChapterProgress(p) { $('cap-progress').style.width = `${(p * 100).toFixed(1)}%`; }

  hideCaption() {
    document.body.classList.remove('touring');
    $('caption').hidden = true;
    $('btn-tour').setAttribute('aria-pressed', 'false');
    $('btn-tour').title = 'Start the tour (T)';
  }

  showEnding(text) {
    $('ending-body').textContent = text;
    const el = $('ending');
    el.hidden = false;
    el.classList.remove('leaving');
    $('caption').hidden = true;
    document.body.classList.add('ending-open');
  }

  hideEnding() {
    const el = $('ending');
    document.body.classList.remove('ending-open');
    if (el.hidden) return;
    el.classList.add('leaving');
    setTimeout(() => { el.hidden = true; el.classList.remove('leaving'); }, 1100);
  }

  // ---------------------------------------------------------------- instruments
  setText(id, text) {
    const el = $(id);
    if (el.textContent !== text) el.textContent = text;
  }
}

const sig2 = (v) => String(Number(v.toPrecision(2)));

export function massText(m) {
  if (m >= 1e9) return `${sig2(m / 1e9)} billion suns`;
  if (m >= 1e6) return `${sig2(m / 1e6)} million suns`;
  return `${sig2(m)} suns`;
}
