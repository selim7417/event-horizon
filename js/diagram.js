import { tracePath, observerRayToCoordinate, v3, B_CRIT } from './physics.js';
import { tanHalfVertical } from './renderer.js';

// The light-path diagram: a side view of the slice through the black hole that
// contains the camera and the screen's vertical. A fan of rays along the
// screen's vertical centre line is integrated with the same equations as the
// shader and coloured by where each ray ends up, which shows directly why the
// far side of the disk appears above and below the hole. Radii are compressed
// (asinh) so the horizon stays legible from far away.

const COLORS = {
  horizon: 'rgba(255, 92, 60, 0.75)',
  disk: 'rgba(255, 190, 110, 0.95)',
  sky: 'rgba(170, 200, 255, 0.55)',
};

export class Diagram {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.lastKey = '';
    this.paths = [];
    this.view = null;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(this.canvas.clientWidth * dpr);
    const h = Math.round(this.canvas.clientHeight * dpr);
    if (w && h && (this.canvas.width !== w || this.canvas.height !== h)) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.lastKey = '';
    }
  }

  // Recompute rays only when the view changed noticeably.
  update(cam, p, obsVel, aspect) {
    if (!this.canvas.offsetParent) return;
    this.resize();
    const key = [cam.pos, cam.fwd, obsVel].flat().map((x) => x.toFixed(3)).join(',')
      + `|${cam.fov.toFixed(1)}|${aspect.toFixed(2)}|${p.curvature.toFixed(3)}|${p.diskOn > 0.5}|${p.diskOuter.toFixed(1)}`;
    if (key === this.lastKey) return;
    this.lastKey = key;

    // Diagram plane: spanned by the direction to the camera and the screen's up vector.
    const e1 = v3.norm(cam.pos);
    let side = v3.sub(cam.up, v3.mul(e1, v3.dot(cam.up, e1)));
    if (v3.len(side) < 1e-3) side = v3.sub(cam.right, v3.mul(e1, v3.dot(cam.right, e1)));
    const e2 = v3.norm(side);
    const tanV = tanHalfVertical(cam.fov, aspect);
    const N = 29;
    const opts = { curvature: p.curvature, diskInner: p.diskInner, diskOuter: p.diskOuter, diskOn: p.diskOn > 0.5 };
    this.paths = [];
    for (let i = 0; i < N; i++) {
      const x = -1 + (2 * i) / (N - 1);
      const sObs = v3.norm(v3.add(cam.fwd, v3.mul(cam.up, x * tanV)));
      const dir = observerRayToCoordinate(sObs, cam.pos, obsVel, p.curvature);
      const res = tracePath(cam.pos, dir, opts);
      this.paths.push({ fate: res.fate, pts: res.pts.map((q) => [v3.dot(q, e1), v3.dot(q, e2)]) });
    }

    // Where the disk plane cuts the diagram plane.
    const n = v3.norm(v3.cross(e1, e2));
    const ny = Math.abs(n[1]);
    let diskLine = null;
    if (ny < 0.985) {
      const l = v3.norm(v3.cross(n, [0, 1, 0]));
      diskLine = [v3.dot(l, e1), v3.dot(l, e2)];
    }
    this.view = { r: v3.len(cam.pos), diskLine, faceOn: ny >= 0.985, p };
    this.draw();
  }

  draw() {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    const dpr = W / (canvas.clientWidth || 1);
    ctx.clearRect(0, 0, W, H);
    if (!this.view) return;
    const { r, diskLine, faceOn, p } = this.view;

    const R = Math.max(r * 1.12, 8);
    const a = 2.2;
    const S = (Math.min(W, H) * 0.5 - 6 * dpr) / Math.asinh(R / a);
    const cx = W * 0.5, cy = H * 0.5;
    // Side view: the camera sits on the left looking right; screen-up is up.
    const map = (x, y) => {
      const rr = Math.hypot(x, y);
      if (rr < 1e-9) return [cx, cy];
      const k = (S * Math.asinh(rr / a)) / rr;
      return [cx - x * k, cy - y * k];
    };
    const rad = (rr) => S * Math.asinh(rr / a);

    // Reference circles.
    ctx.lineWidth = 1 * dpr;
    ctx.setLineDash([3 * dpr, 4 * dpr]);
    ctx.strokeStyle = 'rgba(236,230,220,0.22)';
    ctx.beginPath(); ctx.arc(cx, cy, rad(1.5), 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([1 * dpr, 5 * dpr]);
    ctx.strokeStyle = 'rgba(236,230,220,0.18)';
    ctx.beginPath(); ctx.arc(cx, cy, rad(B_CRIT), 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);

    // The disk, as it meets this plane.
    if (p.diskOn > 0.5) {
      ctx.strokeStyle = 'rgba(255, 180, 100, 0.55)';
      ctx.fillStyle = 'rgba(255, 180, 100, 0.10)';
      if (faceOn) {
        ctx.beginPath();
        ctx.arc(cx, cy, rad(p.diskOuter), 0, Math.PI * 2);
        ctx.arc(cx, cy, rad(p.diskInner), 0, Math.PI * 2, true);
        ctx.fill();
      } else if (diskLine) {
        ctx.lineWidth = 3 * dpr;
        ctx.lineCap = 'round';
        for (const s of [1, -1]) {
          const [x0, y0] = map(diskLine[0] * p.diskInner * s, diskLine[1] * p.diskInner * s);
          const [x1, y1] = map(diskLine[0] * p.diskOuter * s, diskLine[1] * p.diskOuter * s);
          ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
        }
      }
    }

    // Rays.
    ctx.lineWidth = 1.1 * dpr;
    ctx.lineJoin = 'round';
    for (const path of this.paths) {
      ctx.strokeStyle = COLORS[path.fate];
      ctx.beginPath();
      path.pts.forEach(([x, y], i) => {
        const [px, py] = map(x, y);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.stroke();
      if (path.fate === 'disk') {
        const [x, y] = path.pts[path.pts.length - 1];
        const [px, py] = map(x, y);
        ctx.fillStyle = COLORS.disk;
        ctx.beginPath(); ctx.arc(px, py, 1.8 * dpr, 0, Math.PI * 2); ctx.fill();
      }
    }

    // Horizon.
    const g = ctx.createRadialGradient(cx, cy, rad(1) * 0.6, cx, cy, rad(1) * 1.5);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(0.62, 'rgba(0,0,0,1)');
    g.addColorStop(0.7, 'rgba(255,120,60,0.35)');
    g.addColorStop(1, 'rgba(255,120,60,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, rad(1) * 1.5, 0, Math.PI * 2); ctx.fill();

    // Camera.
    const [camX, camY] = map(r, 0);
    ctx.fillStyle = '#ece6dc';
    ctx.beginPath(); ctx.arc(camX, camY, 3 * dpr, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(236,230,220,0.5)';
    ctx.beginPath(); ctx.arc(camX, camY, 6 * dpr, 0, Math.PI * 2); ctx.stroke();
  }
}
