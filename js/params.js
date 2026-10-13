// Scene parameters. Numeric values glide toward their targets so that every
// toggle, preset and tour step becomes a smooth transition instead of a cut.

export const DEFAULTS = {
  curvature: 1,      // 0 = flat spacetime, 1 = Schwarzschild
  diskOn: 1,
  diskInner: 3,      // ISCO, in r_s
  diskOuter: 14,
  diskTemp: 4300,    // peak temperature, K
  diskDensity: 1,
  diskGain: 7,
  corona: 0.12,
  doppler: 1,
  gravShift: 1,
  starGain: 1,
  skyGain: 1,
  bloom: 0.12,
  exposure: 1,
  eht: 0,
  fade: 1,
  timeSpeed: 1,
};

// Values that should glide in log space.
const LOG_KEYS = new Set(['diskTemp', 'diskGain', 'exposure', 'diskDensity']);

export class Params {
  constructor() {
    this.value = { ...DEFAULTS };
    this.target = { ...DEFAULTS };
    this.rate = {};
    this.listeners = new Set();
  }

  get(key) { return this.value[key]; }

  // rate: approach speed (1/s); Infinity snaps immediately.
  set(key, v, rate = 5) {
    this.target[key] = v;
    this.rate[key] = rate;
    if (rate === Infinity) this.value[key] = v;
    this.listeners.forEach((fn) => fn(key, v));
  }

  setMany(obj, rate = 5) {
    for (const k in obj) this.set(k, obj[k], rate);
  }

  reset(rate = 3) { this.setMany(DEFAULTS, rate); }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  update(dt) {
    for (const k in this.target) {
      const t = this.target[k];
      const v = this.value[k];
      if (v === t) continue;
      const a = 1 - Math.exp(-dt * (this.rate[k] ?? 5));
      let next;
      if (LOG_KEYS.has(k) && v > 0 && t > 0) next = Math.exp(Math.log(v) + (Math.log(t) - Math.log(v)) * a);
      else next = v + (t - v) * a;
      if (Math.abs(next - t) < Math.abs(t) * 1e-4 + 1e-5) next = t;
      this.value[k] = next;
    }
  }
}
