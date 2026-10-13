// Dynamic resolution. The number of traced pixels is sized to a GPU time budget.
//
// Where the browser exposes GPU timer queries (Chrome, Edge) every frame is
// timed on the GPU itself. Elsewhere (Safari, Firefox) the pacer watches fences
// to see whether frames are piling up in the GPU queue. Frame-to-frame timing in
// JavaScript alone is not enough: a browser can keep firing animation frames at
// the display rate while the GPU falls further and further behind.

// GPU budget: three quarters of the frame interval the browser actually grants
// (16.7 ms at 60 Hz; 33 ms when Low Power Mode or a battery saver caps animation
// at 30 fps), within these bounds. The interval is read from the fast end of
// recent frame times, so occasional long frames don't inflate it.
const BUDGET_MIN = 10;
const BUDGET_MAX = 26;
const SETTLE_MS = 450;      // minimum time between resolution changes
const MAX_IN_FLIGHT = 6;

export class FramePacer {
  constructor(gl) {
    this.gl = gl;
    this.timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.queries = [];
    this.active = null;
    this.fences = [];
    this.samples = [];
    this.dts = [];
    this.backlog = 0;
    this.idle = 0;
    this.lastChange = 0;
    this.ceiling = 1;
    this.ceilingUntil = 0;
    this.gpuMs = 0;
  }

  begin() {
    if (!this.timer || this.active || this.queries.length >= 4) return;
    const q = this.gl.createQuery();
    this.gl.beginQuery(this.timer.TIME_ELAPSED_EXT, q);
    this.active = q;
  }

  end() {
    const gl = this.gl;
    if (this.active) {
      gl.endQuery(this.timer.TIME_ELAPSED_EXT);
      this.queries.push(this.active);
      this.active = null;
    }
    if (this.fences.length < MAX_IN_FLIGHT) this.fences.push(gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0));
  }

  // Collect finished measurements; returns how many frames are still queued.
  poll() {
    const gl = this.gl;
    while (this.queries.length) {
      const q = this.queries[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      if (!gl.getParameter(this.timer.GPU_DISJOINT_EXT)) this.samples.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
      gl.deleteQuery(q);
      this.queries.shift();
    }
    if (this.samples.length > 24) this.samples.splice(0, this.samples.length - 24);
    while (this.fences.length) {
      const f = this.fences[0];
      if (gl.getSyncParameter(f, gl.SYNC_STATUS) !== gl.SIGNALED) break;
      gl.deleteSync(f);
      this.fences.shift();
    }
    return this.fences.length;
  }

  // Given the current scale, return the scale for the next frame.
  next(scale, dtMs, now, min, max) {
    const inFlight = this.poll();
    this.dts.push(dtMs);
    if (this.dts.length > 30) this.dts.shift();
    if (inFlight >= 2) { this.backlog++; this.idle = 0; } else { this.backlog = 0; this.idle = inFlight === 0 ? this.idle + 1 : 0; }

    const recent = this.samples.slice(-10);
    if (recent.length) this.gpuMs = median(recent);
    if (now - this.lastChange < SETTLE_MS) return scale;

    let target = scale;
    if (this.backlog >= 4) {
      // The GPU is several frames behind: back off hard, whatever the timers say.
      target = scale * 0.8;
    } else if (this.timer && recent.length >= 6 && this.dts.length >= 10) {
      // Cost grows with pixel count, i.e. with scale².
      const budget = Math.min(BUDGET_MAX, Math.max(BUDGET_MIN, 0.75 * percentile(this.dts, 0.1)));
      const ratio = budget / Math.max(this.gpuMs, 0.5);
      if (ratio < 0.9 || ratio > 1.15) target = scale * Math.min(1.1, Math.max(0.75, Math.sqrt(ratio)));
    } else if (!this.timer && this.dts.length >= 20) {
      const dt = median(this.dts);
      if (this.backlog >= 2 || dt > 21) target = scale * 0.88;
      else if (this.idle > 60 && dt < 18) target = scale * 1.05;
    }

    if (target < scale) { this.ceiling = scale; this.ceilingUntil = now + 15000; }
    if (target > scale && now < this.ceilingUntil) target = Math.max(scale, Math.min(target, this.ceiling * 0.97));
    target = Math.round(Math.min(max, Math.max(min, target)) * 50) / 50;
    if (target !== scale) {
      this.lastChange = now;
      this.samples.length = 0;
      this.dts.length = 0;
      this.idle = 0;
    }
    return target;
  }
}

function percentile(xs, p) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

const median = (xs) => percentile(xs, 0.5);
