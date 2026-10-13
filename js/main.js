import { Renderer } from './renderer.js';
import { Camera } from './camera.js';
import { Params, DEFAULTS } from './params.js';
import { UI } from './ui.js';
import { Tour } from './tour.js';
import { Diagram } from './diagram.js';
import { Drone } from './audio.js';
import {
  BLACK_HOLES, OBSERVERS, PHOTON_SPHERE, v3, rsMetres, timeUnitSeconds, observerSpeed,
  timeDilation, shadowRadius, hoverThrustG, tidalG, formatDistance, formatDuration, formatClock, fmt,
} from './physics.js';

// One second on screen is BASE units of the observer's own time (r_s / c),
// times the user's time-speed setting.
const BASE = 6;
const HORIZON_STOP = 1.004;
const FREE_VIEW = { r: 26, theta: 1.43, phi: 0.9, yaw: 0, pitch: 0, roll: 0, fov: 60 };
const INTRO_VIEW = { r: 30, theta: 1.47, phi: 0.2, yaw: 0, pitch: 0, roll: 0, fov: 58 };

const $ = (id) => document.getElementById(id);

class App {
  constructor() {
    this.canvas = $('view');
    this.params = new Params();
    this.camera = new Camera();
    this.camera.set(INTRO_VIEW);
    this.massId = 'sgra';
    this.observer = 'hover';
    this.obsVel = [0, 0, 0];
    this.orbitAxis = null;
    this.time = 0;
    this.clockLocal = 0;
    this.clockFar = 0;
    this.userTimeSpeed = 1;
    this.paused = false;
    this.introOpen = true;
    this.lastFrame = performance.now();
    this.lastInstruments = 0;
    this.lastDiagram = 0;
    this.fps = 60;
    this.respawnAt = 0;
    this.lensShift = 0.3;
  }

  async init() {
    document.body.classList.add('intro-open');
    await paint();
    try {
      this.renderer = new Renderer(this.canvas);
      const small = Math.min(screen.width, screen.height) < 700;
      this.renderer.bakeSky(small ? 512 : 1024);
      this.renderer.scale = small ? 0.4 : 0.5;
    } catch (err) {
      console.error(err);
      this.fail(err.message === 'WEBGL2_UNAVAILABLE' ? null : 'The GPU could not compile the ray tracer on this device. Try another browser or computer.');
      return;
    }
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.fail('The graphics driver reset. Reload the page to start again.');
    });

    this.ui = new UI(this);
    this.tour = new Tour(this);
    this.diagram = new Diagram($('diagram-canvas'));
    this.audio = new Drone();
    this.bindInput();
    this.bindIntro();
    this.detectDownloads();
    requestAnimationFrame((t) => this.frame(t));
  }

  // Embedded in the Claude artifact viewer, plain downloads are blocked; the
  // viewer's downloads capability saves files instead (with the viewer's OK).
  detectDownloads() {
    if (!window.claude?.use) return;
    window.claude.use('downloads').then((d) => {
      this.downloads = d;
      if (d) $('btn-capture').hidden = false;
    }).catch(() => {});
  }

  fail(message) {
    if (message) $('fallback-msg').textContent = message;
    $('fallback').hidden = false;
    $('intro').hidden = true;
  }

  // ---------------------------------------------------------------- state changes
  setParam(def, v) {
    if (def.camera) { this.camera[def.key] = v; return; }
    if (def.user) this.userTimeSpeed = v;
    this.params.set(def.key, v, 8);
  }

  setMass(id, fromUser = false) {
    if (id === this.massId) return;
    this.massId = id;
    this.ui.refreshNotes();
    if (fromUser && !this.massHintShown) {
      this.massHintShown = true;
      this.ui.toast('The picture is the same for every mass. Only distances and times scale.', 4200);
    }
  }

  setObserver(mode, { fromTour = false } = {}) {
    if (mode === 'orbit' && this.camera.r <= PHOTON_SPHERE + 0.05) {
      if (!fromTour) this.ui.toast('No circular orbits exist inside the photon sphere, at 1.5 rₛ. Move further out first.', 3800);
      mode = 'hover';
    }
    this.observer = mode;
    if (mode === 'orbit') this.resetOrbitAxis();
    this.ui.refreshNotes();
    if (!fromTour && mode === 'fall') this.ui.toast('Falling. Scroll back out at any time.', 2400);
  }

  resetOrbitAxis() {
    const pos = this.camera.view().pos;
    let vdir = v3.cross([0, 1, 0], pos); // co-rotating with the disk
    if (v3.len(vdir) < 1e-3 * v3.len(pos)) vdir = this.camera.view().right;
    this.orbitAxis = v3.norm(v3.cross(pos, vdir));
  }

  setQuality(q) {
    this.renderer.setQuality(q);
    this.ui.setSegment('seg-quality', q);
  }

  resetClocks() { this.clockLocal = 0; this.clockFar = 0; }

  resetAll() {
    this.tour.stop();
    this.userTimeSpeed = 1;
    this.params.reset(3);
    this.params.set('fade', 1, 3);
    this.camera.stop();
    this.flyTo(FREE_VIEW);
    this.setObserver('hover');
    this.setMass('sgra');
    this.setQuality('auto');
    this.resetClocks();
    this.ui.sync('fov', FREE_VIEW.fov);
  }

  // A short eased camera move outside the tour.
  flyTo(target, seconds = 2.5) {
    this.flight = { from: this.camera.state, to: target, t: 0, seconds };
  }

  startTour() {
    this.ui.hideEnding();
    this.ui.toggleControls(false);
    this.flight = null;
    this.tour.start(0);
  }

  // ---------------------------------------------------------------- intro
  bindIntro() {
    const ready = () => {
      $('intro-status').textContent = '';
      $('intro-tour').disabled = false;
      $('intro-free').disabled = false;
    };
    ready();
    const leave = (thenTour, withGesture = true) => {
      if (!this.introOpen) return;
      this.introOpen = false;
      const intro = $('intro');
      intro.classList.add('leaving');
      document.body.classList.remove('intro-open');
      setTimeout(() => { intro.hidden = true; }, 1200);
      if (withGesture && $('intro-sound').checked) this.toggleSound(true);
      this.resetClocks();
      if (thenTour) this.startTour();
      else {
        this.flyTo(FREE_VIEW, 3);
        if (getComputedStyle($('hint')).display === 'none') {
          setTimeout(() => this.ui.toast('Drag to orbit. Scroll or pinch to move closer.', 4200), 1400);
        }
        setTimeout(() => $('hint').classList.add('gone'), 9000);
      }
    };
    $('intro-tour').addEventListener('click', () => leave(true));
    $('intro-free').addEventListener('click', () => leave(false));
    // Deep links skip the intro: #tour starts the tour, #explore goes straight to free flight.
    if (location.hash === '#tour') setTimeout(() => leave(true, false), 600);
    if (location.hash === '#explore') setTimeout(() => leave(false, false), 600);
    $('ending-free').addEventListener('click', () => {
      this.ui.hideEnding();
      this.tour.stop();
      this.flight = null;
      this.setObserver('hover');
      this.camera.set(FREE_VIEW);
      this.params.setMany({ ...DEFAULTS, timeSpeed: this.userTimeSpeed }, 2);
      this.params.set('fade', 1, 1.5);
      this.resetClocks();
    });
    $('ending-again').addEventListener('click', () => {
      this.tour.stop();
      this.flight = null;
      this.camera.set(INTRO_VIEW);
      this.setObserver('hover');
      this.resetClocks();
      this.startTour();
    });
  }

  // ---------------------------------------------------------------- input
  bindInput() {
    const c = this.canvas;
    const pointers = new Map();
    let mode = null;
    let pinch = 0;
    let downAt = null;

    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
      mode = e.button === 2 || e.shiftKey || e.altKey ? 'look' : 'orbit';
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = Math.hypot(a.x - b.x, a.y - b.y);
        mode = 'pinch';
      }
      this.camera.stop();
      this.camera.dragging = true;
      this.camera.lastDrag = performance.now();
      c.classList.add('dragging');
    });
    c.addEventListener('pointermove', (e) => {
      const p = pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (mode === 'pinch' && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch > 0) this.camera.zoomBy(-Math.log(d / pinch) * 1.6);
        pinch = d;
        this.userMoved();
        return;
      }
      const k = (0.0042 * this.camera.fov) / 60;
      if (mode === 'look') this.camera.drag(0, 0, dx * k, -dy * k);
      else this.camera.drag(-dy * k, dx * k);
      if (Math.abs(dx) + Math.abs(dy) > 0) this.userMoved();
    });
    const end = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size === 0) {
        this.camera.release();
        c.classList.remove('dragging');
        // A tap brings a hidden interface back.
        if (downAt && this.ui.uiHidden && performance.now() - downAt.t < 300
          && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) < 6) this.ui.toggleHidden(false);
        mode = null;
      } else if (pointers.size === 1) {
        mode = 'orbit';
      }
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const scale = e.deltaMode === 1 ? 16 : 1;
      this.camera.nudge(0, 0, Math.max(-0.05, Math.min(0.05, e.deltaY * scale * 0.00011)));
      this.userMoved();
    }, { passive: false });

    window.addEventListener('keydown', (e) => this.onKey(e));
  }

  userMoved() {
    if (this.tour.active) this.tour.interrupt();
    this.flight = null;
    if (this.observer === 'orbit') this.orbitDirty = true;
    $('hint').classList.add('gone');
  }

  onKey(e) {
    if (e.target.closest && e.target.closest('input, textarea, select')) return;
    if (e.metaKey || e.ctrlKey) return;
    const k = e.key.toLowerCase();
    const cam = this.camera;
    const touring = this.tour.active;
    if (this.introOpen && k !== 'escape') return;
    const step = 0.02;
    switch (k) {
      case 'arrowleft': if (touring) this.tour.prev(); else { cam.nudge(0, -step, 0); this.userMoved(); } break;
      case 'arrowright': if (touring) this.tour.next(); else { cam.nudge(0, step, 0); this.userMoved(); } break;
      case 'arrowup': case 'w': cam.nudge(0, 0, -0.012); this.userMoved(); break;
      case 'arrowdown': case 's': cam.nudge(0, 0, 0.012); this.userMoved(); break;
      case 'a': cam.nudge(0, -step, 0); this.userMoved(); break;
      case 'd': cam.nudge(0, step, 0); this.userMoved(); break;
      case 'q': cam.nudge(-step * 0.6, 0, 0); this.userMoved(); break;
      case 'e': cam.nudge(step * 0.6, 0, 0); this.userMoved(); break;
      case ' ':
        this.paused = !this.paused;
        this.ui.toast(this.paused ? 'Time paused' : 'Time running');
        break;
      case 't': touring ? this.tour.stop() : this.startTour(); break;
      case 'c': this.ui.toggleControls(); break;
      case 'h': this.ui.toggleHidden(); break;
      case 'p': this.capture(); break;
      case 'f': this.toggleFullscreen(); break;
      case 'm': this.toggleSound(); break;
      case 'escape':
        if (!$('about').hidden) this.ui.toggleAbout(false);
        else if (!$('controls').hidden) this.ui.toggleControls(false);
        else if (this.ui.uiHidden) this.ui.toggleHidden(false);
        else if (touring) this.tour.stop();
        break;
      default: return;
    }
    e.preventDefault();
  }

  async toggleSound(force) {
    const on = force ?? !this.audio.running;
    try {
      if (on) await this.audio.start();
      else this.audio.stop();
      this.ui.setSoundPressed(on);
    } catch {
      this.ui.toast('Sound is not available in this browser.');
    }
  }

  toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  }

  capture() {
    if (this.capturing) return;
    this.capturing = true;
    this.ui.toast('Developing a full-resolution still…', 1800);
    setTimeout(() => this.renderStill(), 80);
  }

  // A still photograph: trace at full resolution with the Ultra preset and
  // average 12 jittered frames of the frozen scene, then save the canvas.
  renderStill() {
    const R = this.renderer;
    const prev = { quality: R.quality, auto: R.auto, scale: R.scale };
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const px = this.canvas.clientWidth * this.canvas.clientHeight * dpr * dpr;
    R.fullRes = true;
    R.quality = 'ultra';
    R.auto = false;
    R.scale = Math.min(1, Math.sqrt(6e6 / px));
    R.resize();
    const p = this.params.value;
    const view = {
      ...this.camera.view(), ...p, fov: this.camera.fov, obsVel: this.obsVel, time: this.time,
      wallTime: performance.now() / 1000, lensShift: this.lensShift,
    };
    for (let k = 0; k < 12; k++) {
      R.render(view, { bloom: p.bloom, exposure: p.exposure, eht: p.eht, fade: p.fade, dt: 0, historyAlpha: 1 / (k + 1) });
    }
    this.canvas.toBlob((blob) => {
      this.capturing = false;
      if (!blob) { this.ui.toast('The image could not be saved.'); return; }
      const bh = BLACK_HOLES.find((b) => b.id === this.massId).name.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
      const filename = `event-horizon-${bh}-${this.camera.r.toFixed(2)}rs.png`;
      if (this.downloads) {
        this.downloads.save({ filename, data: blob })
          .then(() => this.ui.toast('Image saved'))
          .catch((err) => {
            if (err?.code === 'declined') return;
            if (err?.code === 'rate_limited') { this.ui.toast('A save is already waiting for your answer.'); return; }
            this.ui.toast('Saving images is not available here.');
            $('btn-capture').hidden = true;
          });
        return;
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      this.ui.toast('Image saved');
    }, 'image/png');
    Object.assign(R, prev, { fullRes: false });
  }

  // ---------------------------------------------------------------- simulation
  observerVelocity(view) {
    const r = this.camera.r;
    if (this.observer === 'fall') return v3.mul(view.er, -observerSpeed(r, 'fall'));
    if (this.observer === 'orbit' && r > PHOTON_SPHERE && this.orbitAxis) {
      return v3.mul(v3.norm(v3.cross(this.orbitAxis, view.er)), observerSpeed(r, 'orbit'));
    }
    return [0, 0, 0];
  }

  step(dt) {
    const cam = this.camera;
    const p = this.params.value;
    const speed = this.paused ? 0 : p.timeSpeed;
    const dTau = dt * BASE * speed;              // observer's proper time, r_s / c
    const mode = this.observer === 'orbit' && cam.r <= PHOTON_SPHERE ? 'hover' : this.observer;
    const dil = timeDilation(cam.r, mode);
    this.time += dTau * Math.min(dil, 30);       // far-away (coordinate) time drives the disk
    const unit = timeUnitSeconds(BLACK_HOLES.find((b) => b.id === this.massId).mass);
    this.clockLocal += dTau * unit;
    this.clockFar += dTau * Math.min(dil, 1e5) * unit;

    // Observers that move on their own.
    if (this.observer === 'fall' && cam.r > HORIZON_STOP && !cam.dragging) {
      const r15 = Math.pow(cam.r, 1.5) - 1.5 * dTau;
      cam.r = Math.max(HORIZON_STOP, Math.pow(Math.max(r15, 0), 2 / 3));
      if (cam.r <= HORIZON_STOP) this.crossHorizon();
    } else if (this.observer === 'orbit' && cam.r > PHOTON_SPHERE) {
      if (this.orbitDirty && !cam.dragging) { this.resetOrbitAxis(); this.orbitDirty = false; }
      if (!cam.dragging) this.advanceOrbit(Math.sqrt(0.5 / Math.pow(cam.r, 3)) * dTau * Math.min(dil, 30));
    }
  }

  // Rotate the camera along its orbit plane by angle a.
  advanceOrbit(a) {
    const cam = this.camera;
    const n = this.orbitAxis;
    const pos = cam.view().pos;
    const c = Math.cos(a), s = Math.sin(a);
    const cr = v3.cross(n, pos);
    const np = v3.add(v3.add(v3.mul(pos, c), v3.mul(cr, s)), v3.mul(n, v3.dot(n, pos) * (1 - c)));
    const r = v3.len(np);
    cam.theta = Math.acos(Math.max(-1, Math.min(1, np[1] / r)));
    cam.phi = Math.atan2(np[2], np[0]);
  }

  crossHorizon() {
    if (this.tour.crossed()) return;
    this.params.set('fade', 0, 4);
    this.ui.toast('You crossed the event horizon. Nothing marked the moment.', 3600);
    this.respawnAt = performance.now() + 2600;
  }

  // ---------------------------------------------------------------- frame
  frame(now) {
    this.tick(now);
    requestAnimationFrame((t) => this.frame(t));
  }

  tick(now) {
    const dt = Math.min(0.1, Math.max(0, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    this.fps += (1 / Math.max(dt, 1e-3) - this.fps) * 0.05;

    if (this.respawnAt && now > this.respawnAt) {
      this.respawnAt = 0;
      this.setObserver('hover');
      this.camera.set(FREE_VIEW);
      this.camera.stop();
      this.params.set('fade', 1, 1.2);
    }

    if (this.introOpen) this.camera.phi -= dt * 0.03;
    if (this.flight) {
      const f = this.flight;
      f.t += dt / f.seconds;
      const k = f.t >= 1 ? 1 : f.t < 0.5 ? 4 * f.t ** 3 : 1 - Math.pow(-2 * f.t + 2, 3) / 2;
      const a = f.from, b = f.to;
      this.camera.set({
        r: Math.exp(Math.log(a.r) + (Math.log(b.r) - Math.log(a.r)) * k),
        theta: a.theta + (b.theta - a.theta) * k,
        phi: a.phi + (((b.phi - a.phi + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI) * k,
        yaw: a.yaw + (b.yaw - a.yaw) * k,
        pitch: a.pitch + (b.pitch - a.pitch) * k,
        roll: (a.roll ?? 0) + ((b.roll ?? 0) - (a.roll ?? 0)) * k,
        fov: a.fov + (b.fov - a.fov) * k,
      });
      if (f.t >= 1) this.flight = null;
    }

    this.tour.update(dt);
    this.params.update(dt);
    this.camera.update(dt);
    this.step(dt);

    // Lift the subject above the caption (intro, tour) with an off-centre projection.
    const portrait = this.canvas.clientHeight > this.canvas.clientWidth * 1.15;
    const shiftTarget = this.introOpen ? (portrait ? 0.34 : 0.3)
      : this.tour.active && !$('caption').hidden ? (portrait ? 0.42 : 0.14) : 0;
    this.lensShift += (shiftTarget - this.lensShift) * (1 - Math.exp(-dt * 2.5));

    const view = this.camera.view();
    const target = this.observerVelocity(view);
    const a = 1 - Math.exp(-dt * 5);
    this.obsVel = this.obsVel.map((v, i) => v + (target[i] - v) * a);
    const speed = v3.len(this.obsVel);
    if (speed > 0.995) this.obsVel = v3.mul(this.obsVel, 0.995 / speed);

    const p = this.params.value;
    this.renderer.resize();
    this.renderer.adapt(dt * 1000, now);
    this.renderer.render(
      { ...view, ...p, fov: this.camera.fov, obsVel: this.obsVel, time: this.time, wallTime: now / 1000, lensShift: this.lensShift },
      { bloom: p.bloom, exposure: p.exposure, eht: p.eht, fade: p.fade, dt, historyAlpha: this.historyAlpha(view) },
    );

    if (now - this.lastInstruments > 100) {
      this.lastInstruments = now;
      this.updateInstruments();
    }
    if (now - this.lastDiagram > 120 && !this.ui.uiHidden) {
      this.lastDiagram = now;
      this.diagram.update({ ...view, fov: this.camera.fov }, p, this.obsVel, this.canvas.width / this.canvas.height);
    }
    if (this.audio.running) {
      const r = this.camera.r;
      const mode = this.observer;
      const shift = mode === 'fall' ? Math.sqrt(timeDilation(r, mode)) : timeDilation(r, mode);
      this.audio.update({ shift, proximity: Math.max(0, Math.min(1, 1 - (r - 2.5) / 30)) * (0.3 + 0.7 * p.diskOn) });
    }
  }

  // Temporal anti-aliasing: how much of the new frame to blend in, from how far
  // the view moved since the last frame, measured in traced pixels.
  historyAlpha(view) {
    const last = this.lastView;
    this.lastView = { pos: view.pos, fwd: view.fwd, up: view.up, fov: this.camera.fov, shift: this.lensShift, vel: this.obsVel };
    if (!last) return 1;
    const T = this.renderer.target;
    const pixel = (2 * Math.tan((this.camera.fov * Math.PI) / 360)) / Math.min(T.w, T.h);
    const ang = (a, b) => Math.acos(Math.min(1, Math.max(-1, v3.dot(a, b))));
    const motion = ang(view.fwd, last.fwd) + ang(view.up, last.up)
      + v3.len(v3.sub(view.pos, last.pos)) / Math.max(this.camera.r, 1)
      + Math.abs(this.camera.fov - last.fov) / this.camera.fov
      + Math.abs(this.lensShift - last.shift) * 0.5
      + v3.len(v3.sub(this.obsVel, last.vel));
    const px = motion / pixel;
    if (px < 0.15) return 0.1;
    if (px < 0.6) return 0.3;
    if (px < 1.5) return 0.6;
    return 1;
  }

  updateInstruments() {
    const ui = this.ui;
    const r = this.camera.r;
    const bh = BLACK_HOLES.find((b) => b.id === this.massId);
    let mode = this.observer;
    const noOrbit = mode === 'orbit' && r <= PHOTON_SPHERE;
    if (noOrbit) mode = 'hover';

    ui.setText('ins-observer', OBSERVERS[this.observer].label + (noOrbit ? ' (no orbit here)' : ''));
    ui.setText('ins-r', r < 2 ? r.toFixed(3) : r < 10 ? r.toFixed(2) : r.toFixed(1));
    ui.setText('ins-r-phys', formatDistance(r * rsMetres(bh.mass)) + ' from the centre');
    const dil = timeDilation(r, mode);
    ui.setText('ins-dilation', dil < 1.0005 ? 'Same as far away' : `1 h = ${fmt(dil)} h far away`);
    const psi = shadowRadius(r, mode === 'orbit' ? 'hover' : mode);
    const across = (2 * psi * 180) / Math.PI;
    const sky = ((1 - Math.cos(psi)) / 2) * 100;
    ui.setText('ins-shadow', `${mode === 'orbit' ? '≈ ' : ''}${fmt(across)}° · ${sky < 1 ? sky.toFixed(2) : sky.toFixed(0)}% of sky`);
    const v = observerSpeed(r, mode);
    ui.setText('ins-speed', mode === 'hover' ? 'Held still by rockets' : `${v.toFixed(3)} c`);
    $('row-thrust').hidden = mode !== 'hover';
    if (mode === 'hover') ui.setText('ins-thrust', `${fmt(hoverThrustG(r, bh.mass))} g`);
    ui.setText('ins-tidal', `${fmt(tidalG(r, bh.mass))} g`);
    ui.setText('clock-local', formatClock(this.clockLocal));
    ui.setText('clock-far', formatClock(this.clockFar));
    const p = this.params.value;
    const rate = this.paused ? 0 : BASE * p.timeSpeed * timeUnitSeconds(bh.mass);
    ui.setText('ins-playback', rate === 0 ? 'Time paused' : `1 s on screen = ${formatDuration(rate)} on your watch`);
    ui.sync('fov', this.camera.fov);
    const T = this.renderer.target;
    const gpu = this.renderer.gpuMs ? ` · GPU ${this.renderer.gpuMs.toFixed(1)} ms` : '';
    ui.setText('perf', `${Math.round(this.fps)} fps${gpu} · ${(T.w * T.h / 1e6).toFixed(2)} million rays per frame`);
  }
}

// Let the intro paint before shader compilation blocks the main thread.
function paint() { return new Promise((r) => setTimeout(r, 40)); }

const app = new App();
window.eventHorizon = app;
app.init();
