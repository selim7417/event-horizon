// A generative drone. Its pitch follows the gravitational blueshift at the
// observer: as you sink toward the horizon, the hum of the outside universe
// rises with the light. Disk proximity adds a low, filtered roar.

export class Drone {
  constructor() {
    this.ctx = null;
    this.enabled = false;
    this.voices = [];
  }

  get running() { return !!this.ctx && this.enabled; }

  async start() {
    if (!this.ctx) this.build();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.enabled = true;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(0.55, t, 1.2);
  }

  // Silence the context while the page is hidden; pick up again when it returns.
  async setVisible(visible) {
    if (!this.ctx) return;
    if (!visible) await this.ctx.suspend();
    else if (this.enabled) await this.ctx.resume();
  }

  stop() {
    if (!this.ctx) return;
    this.enabled = false;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(0, t, 0.4);
  }

  build() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 3;
    this.master.connect(comp).connect(ctx.destination);

    const reverb = ctx.createConvolver();
    reverb.buffer = this.impulse(3.5, 2.2);
    const wet = ctx.createGain();
    wet.gain.value = 0.75;
    reverb.connect(wet).connect(this.master);

    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 520;
    this.filter.Q.value = 0.9;
    const dry = ctx.createGain();
    dry.gain.value = 0.5;
    this.filter.connect(dry).connect(this.master);
    this.filter.connect(reverb);

    // Drone voices: root, fifth, octave, a soft ninth. Each drifts slowly.
    const partials = [[1, 0.32, 'sine'], [1.5, 0.16, 'sine'], [2, 0.12, 'triangle'], [2.25, 0.05, 'sine'], [0.5, 0.22, 'sine']];
    this.base = 55;
    for (const [ratio, gain, type] of partials) {
      for (const detune of [-6, 5]) {
        const osc = ctx.createOscillator();
        osc.type = type;
        osc.frequency.value = this.base * ratio;
        osc.detune.value = detune;
        const g = ctx.createGain();
        g.gain.value = gain * 0.5;
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 0.03 + Math.random() * 0.07;
        const lfoGain = ctx.createGain();
        lfoGain.gain.value = gain * 0.25;
        lfo.connect(lfoGain).connect(g.gain);
        osc.connect(g).connect(this.filter);
        osc.start();
        lfo.start();
        this.voices.push({ osc, ratio });
      }
    }

    // Roar: brown noise through a resonant low-pass.
    const noise = ctx.createBufferSource();
    noise.buffer = this.brownNoise(4);
    noise.loop = true;
    this.roarFilter = ctx.createBiquadFilter();
    this.roarFilter.type = 'lowpass';
    this.roarFilter.frequency.value = 140;
    this.roarFilter.Q.value = 4;
    this.roarGain = ctx.createGain();
    this.roarGain.gain.value = 0;
    noise.connect(this.roarFilter).connect(this.roarGain);
    this.roarGain.connect(this.master);
    this.roarGain.connect(reverb);
    noise.start();

    // Shimmer: high partials that bloom with blueshift.
    this.shimmer = ctx.createGain();
    this.shimmer.gain.value = 0;
    for (const ratio of [8, 12, 16.02]) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = this.base * ratio;
      osc.connect(this.shimmer);
      osc.start();
      this.voices.push({ osc, ratio });
    }
    this.shimmer.connect(reverb);
  }

  // shift: frequency factor of light reaching the observer (≥ 1 near the hole);
  // proximity: 0 far away .. 1 at the disk; brightness: rough scene brightness.
  update({ shift, proximity }) {
    if (!this.running) return;
    const t = this.ctx.currentTime;
    const s = Math.min(Math.max(shift, 0.4), 6);
    const f = this.base * Math.pow(s, 0.75);
    for (const v of this.voices) v.osc.frequency.setTargetAtTime(f * v.ratio, t, 0.6);
    this.filter.frequency.setTargetAtTime(380 + 900 * proximity + 300 * (s - 1), t, 0.5);
    this.roarGain.gain.setTargetAtTime(0.05 + 0.5 * proximity * proximity, t, 0.6);
    this.roarFilter.frequency.setTargetAtTime(90 + 200 * proximity, t, 0.6);
    this.shimmer.gain.setTargetAtTime(Math.min(0.03, 0.012 * Math.max(0, s - 1.2)), t, 0.8);
  }

  impulse(seconds, decay) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  brownNoise(seconds) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      d[i] = last * 3.5;
    }
    return buf;
  }
}
