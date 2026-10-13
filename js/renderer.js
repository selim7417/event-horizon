import { GPU } from './gl.js';
import { TRACE_FS } from './shaders/trace.js';
import { SKY_FS } from './shaders/sky.js';
import { DOWNSAMPLE_FS, UPSAMPLE_FS, COMPOSITE_FS, LUMINANCE_FS, ACCUMULATE_FS } from './shaders/post.js';
import { buildBlackbodyTable, BB_SIZE } from './blackbody.js';

// Quality presets: integration accuracy and the largest share of device pixels
// the tracer may render. "auto" adapts the pixel share to hold a frame rate.
export const QUALITY = {
  low:    { steps: 220, stepK: 0.09, maxScale: 0.45, label: 'Low' },
  medium: { steps: 320, stepK: 0.07, maxScale: 0.65, label: 'Medium' },
  high:   { steps: 420, stepK: 0.055, maxScale: 0.85, label: 'High' },
  ultra:  { steps: 640, stepK: 0.04, maxScale: 1.0, label: 'Ultra' },
};

const BLOOM_LEVELS = 7;

// Low-discrepancy sequence for sub-pixel jitter.
function halton(i, base) {
  let f = 1, r = 0;
  while (i > 0) { f /= base; r += f * (i % base); i = Math.floor(i / base); }
  return r;
}

// The field of view applies to the shorter side of the screen, so portrait
// phones see as much of the scene horizontally as landscape screens do vertically.
export function tanHalfVertical(fov, aspect) {
  const t = Math.tan((fov * Math.PI) / 360);
  return aspect < 1 ? t / aspect : t;
}

export class Renderer {
  constructor(canvas) {
    this.gpu = new GPU(canvas);
    const gpu = this.gpu;
    this.gl = gpu.gl;
    this.canvas = canvas;

    this.traceProg = gpu.program('trace', TRACE_FS);
    this.skyProg = gpu.program('sky', SKY_FS);
    this.downProg = gpu.program('downsample', DOWNSAMPLE_FS);
    this.upProg = gpu.program('upsample', UPSAMPLE_FS);
    this.compProg = gpu.program('composite', COMPOSITE_FS);
    this.lumProg = gpu.program('luminance', LUMINANCE_FS);
    this.accumProg = gpu.program('accumulate', ACCUMULATE_FS);
    this.history = [];
    this.historyValid = false;
    this.frameIndex = 0;
    this.lum = [gpu.target(1, 1), gpu.target(1, 1)];
    this.lumFresh = true;
    this.autoKey = 0.085;
    this.autoStrength = 0.6;

    this.bbTex = this.makeBlackbodyTexture();
    this.skyTex = null;
    this.target = null;
    this.bloom = [];
    this.scale = 0.6;          // share of device pixels traced
    this.quality = 'high';
    this.auto = true;
    this.frameTimes = [];
    this.lastScaleChange = 0;
    this.dpr = 1;
  }

  makeBlackbodyTexture() {
    const gl = this.gl;
    const data = buildBlackbodyTable();
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, BB_SIZE, 1, 0, gl.RGBA, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  // Render the six faces of the backdrop once, then mipmap them.
  bakeSky(size) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, tex);
    const fmt = this.gpu.hdrFormat;
    for (let f = 0; f < 6; f++) {
      gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + f, 0, fmt.internal, size, size, 0, fmt.format, fmt.type, null);
    }
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    for (let f = 0; f < 6; f++) {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_CUBE_MAP_POSITIVE_X + f, tex, 0);
      gl.viewport(0, 0, size, size);
      this.skyProg.use({ uFace: f });
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, tex);
    gl.generateMipmap(gl.TEXTURE_CUBE_MAP);
    if (this.skyTex) gl.deleteTexture(this.skyTex);
    this.skyTex = tex;
  }

  setQuality(q) {
    if (q === 'auto') { this.auto = true; this.quality = 'high'; }
    else { this.auto = false; this.quality = q; this.scale = QUALITY[q].maxScale; }
  }

  // Resize the canvas backing store to the CSS size; returns tracer size.
  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.dpr = dpr;
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const maxScale = this.auto ? 0.9 : QUALITY[this.quality].maxScale;
    this.scale = Math.min(this.scale, maxScale);
    const tw = Math.max(64, Math.round(w * this.scale));
    const th = Math.max(64, Math.round(h * this.scale));
    if (!this.target || this.target.w !== tw || this.target.h !== th) this.allocate(tw, th);
  }

  allocate(w, h) {
    const gpu = this.gpu;
    gpu.dispose(this.target);
    this.bloom.forEach((t) => gpu.dispose(t));
    this.history.forEach((t) => gpu.dispose(t));
    this.target = gpu.target(w, h);
    this.history = [gpu.target(w, h), gpu.target(w, h)];
    this.historyValid = false;
    this.bloom = [];
    let bw = w, bh = h;
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      bw = Math.max(1, bw >> 1);
      bh = Math.max(1, bh >> 1);
      this.bloom.push(gpu.target(bw, bh));
    }
  }

  // Adapt the traced pixel share to the measured frame time.
  adapt(dtMs, now) {
    if (!this.auto) return;
    this.frameTimes.push(dtMs);
    if (this.frameTimes.length > 24) this.frameTimes.shift();
    if (now - this.lastScaleChange < 700 || this.frameTimes.length < 12) return;
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    let next = this.scale;
    if (median > 26) next = this.scale * 0.86;
    else if (median > 21) next = this.scale * 0.94;
    else if (median < 17.6) next = this.scale * 1.06;
    next = Math.min(0.9, Math.max(0.28, next));
    if (Math.abs(next - this.scale) > 0.01) {
      this.scale = next;
      this.lastScaleChange = now;
      this.frameTimes.length = 0;
    }
  }

  // historyAlpha: weight of the new frame (1 = no history, small = long accumulation).
  render(view, post) {
    const gl = this.gl;
    const gpu = this.gpu;
    const q = QUALITY[this.quality];
    const T = this.target;
    const alpha = this.historyValid ? Math.min(1, Math.max(0.02, post.historyAlpha ?? 1)) : 1;
    this.frameIndex = (this.frameIndex + 1) % 64;
    const jitter = alpha < 1 ? [halton(this.frameIndex + 1, 2) - 0.5, halton(this.frameIndex + 1, 3) - 0.5] : [0, 0];

    gpu.pass(this.traceProg, T, {
      uRes: [T.w, T.h],
      uCamPos: view.pos,
      uCamRight: view.right,
      uCamUp: view.up,
      uCamFwd: view.fwd,
      uTanHalfFov: tanHalfVertical(view.fov, T.w / T.h),
      uLensShift: [0, view.lensShift || 0],
      uJitter: jitter,
      uObsVel: view.obsVel,
      uTime: view.time,
      uMaxSteps: q.steps,
      uStepK: q.stepK,
      uCurvature: view.curvature,
      uDiskOn: view.diskOn,
      uDiskInner: view.diskInner,
      uDiskOuter: view.diskOuter,
      uDiskTemp: view.diskTemp,
      uDiskDensity: view.diskDensity,
      uDiskGain: view.diskGain,
      uCorona: view.corona,
      uDoppler: view.doppler,
      uGravShift: view.gravShift,
      uStarGain: view.starGain,
      uSkyGain: view.skyGain,
      uBlackbody: this.bbTex,
      uSky: this.skyTex,
    });

    // Temporal accumulation into the history ping-pong.
    const [histPrev, histNext] = this.history;
    gpu.pass(this.accumProg, histNext, { uCurrent: T.tex, uHistory: histPrev.tex, uAlpha: alpha });
    this.history = [histNext, histPrev];
    this.historyValid = true;
    const H = histNext;

    // Bloom: downsample chain, then accumulate back up with additive blending.
    let src = H;
    this.bloom.forEach((dst, i) => {
      gpu.pass(this.downProg, dst, { uSrc: src.tex, uTexel: [1 / src.w, 1 / src.h], uKaris: i === 0 ? 1 : 0 });
      src = dst;
    });
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    for (let i = this.bloom.length - 1; i > 0; i--) {
      const lo = this.bloom[i];
      gpu.pass(this.upProg, this.bloom[i - 1], { uSrc: lo.tex, uTexel: [1 / lo.w, 1 / lo.h], uRadius: 1.0 });
    }
    gl.disable(gl.BLEND);

    // Auto-exposure: adapt toward the new average with a ~0.7 s time constant.
    const [lumPrev, lumNext] = this.lum;
    gpu.pass(this.lumProg, lumNext, {
      uSrc: this.bloom[this.bloom.length - 1].tex,
      uPrev: lumPrev.tex,
      uBlend: this.lumFresh ? 1 : 1 - Math.exp(-(post.dt ?? 0.016) * 1.4),
    });
    this.lum = [lumNext, lumPrev];
    this.lumFresh = false;

    gpu.pass(this.compProg, null, {
      uLum: lumNext.tex,
      uHDR: H.tex,
      uAutoKey: this.autoKey,
      uAutoStrength: post.autoStrength ?? this.autoStrength,
      uBloom: this.bloom[0].tex,
      uWide: this.bloom[2].tex,
      uBloomLevels: BLOOM_LEVELS,
      uBloomStrength: post.bloom,
      uExposure: post.exposure,
      uEHT: post.eht,
      uTime: view.wallTime,
      uFade: post.fade,
      uRes: [this.canvas.width, this.canvas.height],
    });
  }
}
