import { DEFAULTS } from './params.js';
import { lerpCamera, easeInOut } from './camera.js';
import {
  BLACK_HOLES, hoverThrustG, timeDilation, fallTime, timeUnitSeconds,
  formatDuration, fmt,
} from './physics.js';

const HOVER_R = 1.06;
const FALL_FROM = 12;

const massOf = (id) => BLACK_HOLES.find((b) => b.id === id);

export const CHAPTERS = [
  {
    id: 'shadow',
    title: 'The shadow',
    body: () => `The dark disc is the black hole's shadow. Every pixel inside it traces a ray of light that ends at the event horizon. It looks about 2.6 times wider than the horizon itself, because the hole pulls in light from all around it.`,
    camera: { r: 34, theta: 1.37, phi: 0.75, yaw: 0, pitch: 0, fov: 52 },
    drift: -0.012,
    duration: 15,
  },
  {
    id: 'images',
    title: 'One disk, seen three times',
    body: () => `The glowing gas is a single flat ring. The arch over the top is the far side of that ring, its light bent up and over the hole on the way to you. The loop beneath the shadow is the far side's underside, bent the other way. A third image, thin as a hair, hugs the shadow's edge.`,
    camera: { r: 21, theta: 1.535, phi: 1.6, yaw: 0, pitch: 0, fov: 50 },
    drift: -0.01,
    duration: 18,
  },
  {
    id: 'doppler',
    title: 'Doppler beaming',
    body: () => `Near the inner edge the gas orbits at half the speed of light. On the side turning toward you its light is squeezed to higher frequencies and thrown forward, so it shines brighter and bluer. The receding side dims and reddens. The film Interstellar left this out to keep its black hole symmetric.`,
    camera: { r: 24, theta: 1.42, phi: 2.4, yaw: 0, pitch: 0, fov: 55 },
    params: { doppler: 0 },
    drift: -0.006,
    duration: 18,
    control: { key: 'doppler', label: 'Doppler shift', type: 'toggle' },
    script(t, tour) {
      if (t > 3 && !this._done && !this._touched) { this._done = true; tour.params.set('doppler', 1, 1.2); }
    },
    enter() { this._done = false; },
  },
  {
    id: 'flat',
    title: 'Switch gravity off',
    body: () => `This is what is physically there: a black sphere, and a flat ring of gas starting at three times its radius. Everything else in the picture was light bending on its way to you. Drag the slider to curve spacetime back.`,
    camera: { r: 24, theta: 1.4, phi: 2.9, yaw: 0, pitch: 0, fov: 55 },
    drift: -0.006,
    duration: 20,
    control: { key: 'curvature', label: 'Spacetime curvature', type: 'range' },
    script(t, tour) {
      if (this._touched) return;
      if (t > 2 && this._phase === 0) { this._phase = 1; tour.params.set('curvature', 0, 0.9); }
      if (t > 10 && this._phase === 1) { this._phase = 2; tour.params.set('curvature', 1, 0.5); }
    },
    enter() { this._phase = 0; },
  },
  {
    id: 'lens',
    title: 'A lens made of spacetime',
    body: () => `With the gas removed, the hole works as a lens. Stars directly behind it smear into arcs along a bright circle, the Einstein ring. Every star also appears a second time on the opposite side, and again in thinner images crowding the edge of the shadow.`,
    // Aligned so the galactic centre sits behind the hole midway through the chapter.
    camera: { r: 15, theta: 1.8, phi: 3.42, yaw: 0, pitch: 0, fov: 62 },
    params: { diskOn: 0, starGain: 1.25, skyGain: 2.2 },
    drift: 0.012,
    duration: 18,
  },
  {
    id: 'eht',
    title: 'What a radio telescope sees',
    body: () => `In 2019 the Event Horizon Telescope, a network of radio dishes as wide as Earth, photographed the black hole in the galaxy M87 from close to this angle. At its resolution, all this detail blurs into a lopsided ring of light around a dark centre, brightest where the gas moves toward us.`,
    mass: 'm87',
    camera: { r: 90, theta: 0.297, phi: 4.2, yaw: 0, pitch: 0, roll: -1.35, fov: 18 },
    params: { diskOuter: 6.5, diskTemp: 5200, corona: 0.2, starGain: 0.35 },
    drift: 0,
    duration: 18,
    control: { key: 'eht', label: 'Radio view', type: 'toggle' },
    script(t, tour) {
      if (t > 4.5 && !this._done && !this._touched) { this._done = true; tour.params.set('eht', 1, 1.0); }
    },
    enter() { this._done = false; },
  },
  {
    id: 'hover',
    title: 'Hovering at the edge',
    body: (ctx) => `You are hovering ${Math.round((HOVER_R - 1) * 100)}% of a horizon radius above the horizon of ${ctx.bh.name}, held up by rockets pushing at ${fmt(hoverThrustG(HOVER_R, ctx.bh.mass))} g. Light from the entire universe now reaches you through one bright window, blueshifted, while the black hole fills the rest of the sky. Each hour on your watch is ${fmt(timeDilation(HOVER_R, 'hover'))} hours for everyone far away.`,
    mass: 'sgra',
    camera: { r: HOVER_R, theta: 0.55, phi: 4.8, yaw: Math.PI, pitch: 0, fov: 112 },
    transition: 7,
    drift: 0.02,
    duration: 20,
  },
  {
    id: 'fall',
    title: 'Falling in',
    body: (ctx) => `Now let go. You are falling freely from ${FALL_FROM} horizon radii. To a falling observer the shadow looks smaller than to one who hovers, and it never closes over the sky. From here your watch will advance ${formatDuration(fallTime(FALL_FROM, 1) * timeUnitSeconds(ctx.bh.mass))} before you cross.`,
    endBody: (ctx) => `You crossed the event horizon after ${formatDuration(fallTime(FALL_FROM, 1) * timeUnitSeconds(ctx.bh.mass))} on your own watch, and nothing marked the moment. A distant observer never sees you arrive. Your image slows, reddens and fades at the edge of the shadow, forever.`,
    mass: 'sgra',
    camera: { r: FALL_FROM, theta: 1.18, phi: 5.4, yaw: 0, pitch: -0.05, fov: 104 },
    params: { timeSpeed: 0.33 },
    transition: 5,
    drift: 0,
    duration: Infinity,
    enter() { this._state = 'wait'; },
    script(t, tour) {
      if (this._state === 'wait' && t > 1.5) {
        this._state = 'fall';
        tour.app.resetClocks();
        tour.app.setObserver('fall', { fromTour: true });
      }
    },
    // Called by the app when the camera reaches the horizon.
    crossed(tour) {
      this._state = 'done';
      tour.params.set('fade', 0, 3.5);
      setTimeout(() => { if (tour.ch === this) tour.ui.showEnding(this.endBody(tour.context())); }, 1200);
    },
  },
];

export class Tour {
  constructor(app) {
    this.app = app;
    this.params = app.params;
    this.camera = app.camera;
    this.ui = app.ui;
    this.index = -1;
    this.active = false;
    this.autoplay = true;
  }

  context() {
    return { bh: massOf(this.app.massId) };
  }

  start(i = 0) {
    this.active = true;
    this.go(i);
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.index = -1;
    this.ch = null;
    this.ui.hideCaption();
    this.ui.hideEnding();
    // Hand the scene back in its default state: level, hovering, out of the throat.
    const app = this.app;
    this.params.setMany({ ...DEFAULTS, timeSpeed: app.userTimeSpeed }, 2);
    if (app.observer !== 'hover') app.setObserver('hover', { fromTour: true });
    const s = this.camera.state;
    if (Math.abs(s.roll) > 0.01 || s.r < 1.6 || Math.abs(s.yaw) > 0.3) {
      app.flyTo({ ...s, roll: 0, yaw: 0, pitch: 0, r: Math.max(s.r, 6), fov: Math.min(Math.max(s.fov, 45), 75) }, 2.2);
    }
  }

  next() { if (this.index < CHAPTERS.length - 1) this.go(this.index + 1); }
  prev() { if (this.index > 0) this.go(this.index - 1); }

  go(i) {
    const ch = CHAPTERS[i];
    this.active = true;
    this.index = i;
    this.t = 0;
    this.userControl = false;
    this.ch = ch;
    if (ch.mass) this.app.setMass(ch.mass);
    this.app.resetClocks();
    this.app.setObserver(ch.observer || 'hover', { fromTour: true });
    // Each chapter fully defines the scene, so chapters can be visited in any order.
    this.params.setMany({ ...DEFAULTS, timeSpeed: this.app.userTimeSpeed, ...(ch.params || {}) }, 2.2);
    this.params.set('fade', 1, 2.5);
    ch._touched = false;
    ch.enter?.call(ch);
    this.from = this.camera.state;
    this.camera.stop();
    this.transition = ch.transition ?? 5;
    this.ui.showChapter(i, CHAPTERS.length, ch, ch.body(this.context()));
  }

  // The user grabbed the camera: let them look around for the rest of the chapter.
  interrupt() {
    if (this.active) this.userControl = true;
  }

  // The viewer used the chapter's own control: stop scripting that value.
  touchedControl() { if (this.ch) this.ch._touched = true; }

  // Returns true if the tour handled the horizon crossing.
  crossed() {
    if (!this.active || !this.ch?.crossed) return false;
    this.ch.crossed(this);
    return true;
  }

  update(dt) {
    if (!this.active) return;
    const ch = this.ch;
    this.t += dt;
    if (!this.userControl) {
      if (this.t < this.transition) {
        const k = easeInOut(Math.min(1, this.t / this.transition));
        this.camera.set(lerpCamera(this.from, ch.camera, k));
      } else if (ch.drift) {
        this.camera.phi += ch.drift * dt;
      }
    }
    ch.script?.call(ch, this.t - this.transition, this);
    const progress = Number.isFinite(ch.duration) ? Math.min(1, this.t / (ch.duration + this.transition)) : 0;
    this.ui.setChapterProgress(progress);
    if (this.autoplay && Number.isFinite(ch.duration) && this.t > ch.duration + this.transition) this.next();
  }
}
