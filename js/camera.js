// Orbit camera in spherical coordinates around the hole, with a free-look
// offset (yaw/pitch) so the observer can turn away from the black hole.

const TAU = Math.PI * 2;
export const R_MIN = 1.004;
export const R_MAX = 400;

export class Camera {
  constructor() {
    this.r = 26;
    this.theta = 1.43;   // polar angle from the disk axis (+y)
    this.phi = 0.9;
    this.yaw = 0;
    this.pitch = 0;
    this.roll = 0;
    this.fov = 60;
    // Inertia for direct manipulation.
    this.vel = { theta: 0, phi: 0, logR: 0, yaw: 0, pitch: 0 };
    this.dragging = false;
  }

  get state() {
    return { r: this.r, theta: this.theta, phi: this.phi, yaw: this.yaw, pitch: this.pitch, roll: this.roll, fov: this.fov };
  }

  set(s) {
    for (const k of ['r', 'theta', 'phi', 'yaw', 'pitch', 'roll', 'fov']) if (s[k] !== undefined) this[k] = s[k];
    this.clamp();
  }

  clamp() {
    this.r = Math.min(R_MAX, Math.max(R_MIN, this.r));
    this.theta = Math.min(Math.PI - 0.02, Math.max(0.02, this.theta));
    this.pitch = Math.min(1.5, Math.max(-1.5, this.pitch));
    this.yaw = ((this.yaw + Math.PI) % TAU + TAU) % TAU - Math.PI;
  }

  // Add momentum (wheel, keys). Zoom works on log(r − 0.9), which gives fine
  // control close to the horizon and quick travel far from it.
  nudge(dTheta, dPhi, dZoom, dYaw = 0, dPitch = 0) {
    this.vel.theta += dTheta;
    this.vel.phi += dPhi;
    this.vel.logR += dZoom;
    this.vel.yaw += dYaw;
    this.vel.pitch += dPitch;
  }

  // Direct manipulation (dragging): move now, and track the pointer's speed
  // (per 1/60 s) so a flick keeps gliding after release.
  drag(dTheta, dPhi, dYaw = 0, dPitch = 0) {
    this.theta += dTheta;
    this.phi += dPhi;
    this.yaw += dYaw;
    this.pitch += dPitch;
    const now = performance.now();
    const frames = Math.max((now - (this.lastDrag || now - 16.7)) / 16.7, 1);
    this.lastDrag = now;
    const v = this.vel;
    const lim = 0.05;
    const blend = (old, d) => Math.max(-lim, Math.min(lim, old * 0.4 + (d / frames) * 0.6));
    v.theta = blend(v.theta, dTheta);
    v.phi = blend(v.phi, dPhi);
    v.yaw = blend(v.yaw, dYaw);
    v.pitch = blend(v.pitch, dPitch);
    this.clamp();
  }

  // Called when the pointer is released; a pause before release cancels the glide.
  release() {
    if (performance.now() - (this.lastDrag || 0) > 90) {
      this.vel.theta = this.vel.phi = this.vel.yaw = this.vel.pitch = 0;
    }
    this.dragging = false;
  }

  zoomBy(dz) {
    this.r = 0.9 + Math.exp(Math.log(Math.max(this.r - 0.9, 1e-6)) + dz);
    this.clamp();
  }

  // Apply and damp inertial motion.
  update(dt) {
    const v = this.vel;
    const f = Math.min(dt * 60, 4); // velocities are per 1/60 s
    if (!this.dragging) {
      this.theta += v.theta * f;
      this.phi += v.phi * f;
      this.yaw += v.yaw * f;
      this.pitch += v.pitch * f;
    }
    this.zoomBy(v.logR * f);
    const damp = Math.exp(-dt * 6.5);
    for (const k in v) v[k] *= damp;
    this.clamp();
  }

  stop() { for (const k in this.vel) this.vel[k] = 0; }

  get moving() {
    const v = this.vel;
    return Math.abs(v.theta) + Math.abs(v.phi) + Math.abs(v.logR) + Math.abs(v.yaw) + Math.abs(v.pitch) > 1e-4;
  }

  // Position and orthonormal basis in world space.
  view() {
    const st = Math.sin(this.theta), ct = Math.cos(this.theta);
    const sp = Math.sin(this.phi), cp = Math.cos(this.phi);
    const er = [st * cp, ct, st * sp];
    const eth = [ct * cp, -st, ct * sp];
    const eph = [-sp, 0, cp];
    const pos = er.map((x) => x * this.r);
    // Looking at the hole: forward = -e_r, up = -e_θ, right = forward × up = -e_φ
    // (with +y as the polar axis this embedding is left-handed in r, θ, φ).
    const f0 = er.map((x) => -x);
    const u0 = eth.map((x) => -x);
    const r0 = eph.map((x) => -x);
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const f1 = f0.map((x, i) => cy * x + sy * r0[i]);
    const right = r0.map((x, i) => cy * x - sy * f0[i]);
    const cpt = Math.cos(this.pitch), spt = Math.sin(this.pitch);
    const fwd = f1.map((x, i) => cpt * x + spt * u0[i]);
    const up1 = u0.map((x, i) => cpt * x - spt * f1[i]);
    const cr = Math.cos(this.roll), sr = Math.sin(this.roll);
    const right2 = right.map((x, i) => cr * x + sr * up1[i]);
    const up = up1.map((x, i) => cr * x - sr * right[i]);
    return { pos, fwd, right: right2, up, er, eth, eph };
  }
}

// Interpolate two camera states. φ and yaw take the short way round; r in log space.
export function lerpCamera(a, b, t) {
  const ang = (x, y) => {
    let d = ((y - x + Math.PI) % TAU + TAU) % TAU - Math.PI;
    return x + d * t;
  };
  return {
    r: Math.exp(Math.log(a.r) + (Math.log(b.r) - Math.log(a.r)) * t),
    theta: a.theta + (b.theta - a.theta) * t,
    phi: ang(a.phi, b.phi),
    yaw: ang(a.yaw, b.yaw),
    pitch: a.pitch + (b.pitch - a.pitch) * t,
    roll: ang(a.roll ?? 0, b.roll ?? 0),
    fov: a.fov + (b.fov - a.fov) * t,
  };
}

export const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
