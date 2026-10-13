// Schwarzschild physics for the instruments and the light-path diagram.
// Distances are in Schwarzschild radii (r_s = 2GM/c²) unless stated otherwise.

export const SUN_RS_M = 2953.25;          // Schwarzschild radius of one solar mass, metres
export const C = 299792458;               // m/s
export const G0 = 9.80665;                // standard gravity, m/s²
export const AU_M = 1.495978707e11;
export const B_CRIT = 1.5 * Math.sqrt(3); // critical impact parameter, 3√3/2 r_s
export const PHOTON_SPHERE = 1.5;
export const ISCO = 3;

export const BLACK_HOLES = [
  { id: 'cygx1', name: 'Cygnus X-1', mass: 21.2, note: 'A stellar black hole, 7,200 light-years away' },
  { id: 'sgra', name: 'Sagittarius A*', mass: 4.3e6, note: 'The black hole at the centre of the Milky Way' },
  { id: 'm87', name: 'M87*', mass: 6.5e9, note: 'The first black hole ever photographed' },
  { id: 'ton618', name: 'TON 618', mass: 6.6e10, note: 'One of the most massive black holes known' },
];

export const OBSERVERS = {
  hover: { label: 'Hovering', blurb: 'Rockets hold you at a fixed distance' },
  orbit: { label: 'Orbiting', blurb: 'Coasting on a circular orbit' },
  fall: { label: 'Falling', blurb: 'Dropped from rest far away, falling straight in' },
};

export const rsMetres = (mass) => SUN_RS_M * mass;
export const timeUnitSeconds = (mass) => rsMetres(mass) / C;   // r_s / c
export const lapse = (r) => Math.sqrt(Math.max(1 - 1 / r, 0));

// Local speed of the observer, measured by a static observer at the same place.
export function observerSpeed(r, mode) {
  if (mode === 'orbit') return r > PHOTON_SPHERE ? Math.sqrt(0.5 / (r - 1)) : 0;
  if (mode === 'fall') return Math.sqrt(1 / r);
  return 0;
}

// dt/dτ: how much far-away time passes per unit of the observer's own time.
export function timeDilation(r, mode) {
  if (mode === 'orbit' && r > PHOTON_SPHERE) return 1 / Math.sqrt(1 - 1.5 / r);
  if (mode === 'fall') return 1 / (1 - 1 / r);
  return 1 / lapse(r);
}

// Angular radius of the shadow (radians), centred on the direction to the hole.
export function shadowRadius(r, mode) {
  const x = Math.min(1, (B_CRIT * lapse(r)) / r);
  let psi = r >= PHOTON_SPHERE ? Math.asin(x) : Math.PI - Math.asin(x);
  if (mode === 'fall') {
    // Aberration: the faller moves toward the hole, which shrinks the shadow.
    const b = observerSpeed(r, mode);
    const c = Math.cos(psi);
    psi = Math.acos((c + b) / (1 + b * c));
  }
  return psi;
}

// Proper acceleration needed to hover, in g.
export function hoverThrustG(r, mass) {
  const gm = (C * C * rsMetres(mass)) / 2;
  const R = r * rsMetres(mass);
  return gm / (R * R * lapse(r)) / G0;
}

// Head-to-toe tidal acceleration on a 2 m body pointing at the hole, in g.
export function tidalG(r, mass, L = 2) {
  const rs = rsMetres(mass);
  return (C * C * L) / (Math.pow(r, 3) * rs * rs) / G0;
}

// Proper time to fall from r0 to r1 (radial, from rest at infinity), units r_s/c.
export const fallTime = (r0, r1) => (2 / 3) * (Math.pow(r0, 1.5) - Math.pow(r1, 1.5));
// Inverse: radius after falling for τ from r0.
export const fallRadius = (r0, tau) => Math.pow(Math.max(Math.pow(r0, 1.5) - 1.5 * tau, 0), 2 / 3);

// ---------------------------------------------------------------- formatting
export function formatDistance(metres) {
  const km = metres / 1000;
  if (metres >= 0.1 * AU_M) return `${fmt(metres / AU_M)} AU`;
  if (km >= 1e6) return `${fmt(km / 1e6)} million km`;
  if (km >= 1) return `${fmt(km)} km`;
  return `${fmt(metres)} m`;
}

export function formatDuration(seconds) {
  const s = Math.abs(seconds);
  if (s < 1e-3) return `${fmt(seconds * 1e6)} µs`;
  if (s < 1) return `${fmt(seconds * 1e3)} ms`;
  if (s < 60) return `${fmt(seconds)} s`;
  if (s < 3600) return `${fmt(seconds / 60)} min`;
  if (s < 86400 * 2) return `${fmt(seconds / 3600)} h`;
  if (s < 86400 * 365.25 * 2) return `${fmt(seconds / 86400)} days`;
  return `${fmt(seconds / (86400 * 365.25))} years`;
}

// A running clock face: mm:ss.cc for short spans, then h:mm:ss, then days.
export function formatClock(seconds) {
  const s = Math.max(0, seconds);
  if (s < 1) return `${(s * 1000).toFixed(2)} ms`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const sec = s - m * 60;
    return `${String(m).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`;
  }
  if (s < 86400 * 3) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }
  return `${(s / 86400).toFixed(2)} days`;
}

export function fmt(v) {
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1e15 || a < 1e-3) {
    const e = Math.floor(Math.log10(a));
    const m = v / Math.pow(10, e);
    return `${m.toFixed(1)}×10${superscript(e)}`;
  }
  if (a >= 1e3) return Math.round(v).toLocaleString('en-US');
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  return v.toPrecision(2);
}

function superscript(n) {
  const map = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
  return String(n).split('').map((ch) => map[ch]).join('');
}

// ---------------------------------------------------------------- vectors
export const v3 = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
};

// Camera ray (observer frame) -> coordinate direction, exactly as in the shader.
export function observerRayToCoordinate(sObs, camPos, obsVel, curvature) {
  let s = sObs;
  const beta = v3.len(obsVel);
  if (beta > 1e-5) {
    const bh = v3.mul(obsVel, 1 / beta);
    const c1 = v3.dot(sObs, bh);
    const c = (c1 - beta) / (1 - beta * c1);
    const perp = v3.sub(sObs, v3.mul(bh, c1));
    const pl = v3.len(perp);
    s = v3.add(v3.mul(bh, c), pl > 1e-9 ? v3.mul(perp, Math.sqrt(Math.max(0, 1 - c * c)) / pl) : [0, 0, 0]);
  }
  const r0 = v3.len(camPos);
  const rhat = v3.mul(camPos, 1 / r0);
  const l0 = Math.sqrt(Math.max(1 - curvature / r0, 1e-6));
  const sr = v3.dot(s, rhat);
  return v3.norm(v3.add(s, v3.mul(rhat, sr * (l0 - 1))));
}

// Step length, as in the shader: at most a fraction of r (more far out, where
// space is nearly flat), and short enough that Verlet's local error, which grows
// with the rate of change of the force (4k/r⁵), stays below stepErr.
export function stepLength(r, k, stepK, stepErr) {
  const geometric = stepK * r * Math.min(1 + Math.max(r - 8, 0) * 0.06, 2);
  const errorLimited = Math.cbrt((stepErr * r ** 5) / (4 * Math.max(k, 1e-9)));
  return Math.min(Math.max(Math.min(geometric, errorLimited), 0.004), 60);
}

// Integrate one photon path with the shader's integrator. Allocation-free:
// when `out` is given, the path is appended to it as flat x, y, z triples.
// Returns the fate ('horizon', 'disk' or 'sky') and the number of steps.
export function tracePath(camPos, dir, { curvature, diskInner, diskOuter, diskOn, stepK = 0.2, stepErr = 2e-3, maxSteps = 900 }, out = null) {
  let px = camPos[0], py = camPos[1], pz = camPos[2];
  let vx = dir[0], vy = dir[1], vz = dir[2];
  const hx = py * vz - pz * vy, hy = pz * vx - px * vz, hz = px * vy - py * vx;
  const k = 1.5 * (hx * hx + hy * hy + hz * hz) * curvature;
  let r = Math.sqrt(px * px + py * py + pz * pz);
  let f = -k / (r * r * r * r * r);
  let ax = px * f, ay = py * f, az = pz * f;
  const escapeR = Math.max(r * 1.15, 40);
  if (out) out.push(px, py, pz);
  let fate = 'sky';
  let steps = 0;
  for (; steps < maxSteps; steps++) {
    const dl = stepLength(r, k, stepK, stepErr);
    const h2 = 0.5 * dl * dl;
    const nx = px + vx * dl + ax * h2, ny = py + vy * dl + ay * h2, nz = pz + vz * dl + az * h2;
    const nr = Math.sqrt(nx * nx + ny * ny + nz * nz);
    const nf = -k / (nr * nr * nr * nr * nr);
    const nax = nx * nf, nay = ny * nf, naz = nz * nf;
    vx += 0.5 * (ax + nax) * dl; vy += 0.5 * (ay + nay) * dl; vz += 0.5 * (az + naz) * dl;
    if (diskOn && py * ny < 0) {
      const t = py / (py - ny);
      const cx = px + (nx - px) * t, cz = pz + (nz - pz) * t;
      const hr = Math.sqrt(cx * cx + cz * cz);
      if (hr > diskInner && hr < diskOuter) {
        if (out) out.push(cx, 0, cz);
        fate = 'disk';
        break;
      }
    }
    px = nx; py = ny; pz = nz; ax = nax; ay = nay; az = naz; r = nr;
    if (out) out.push(px, py, pz);
    if (nr < 1) { fate = 'horizon'; break; }
    if (nr > escapeR && px * vx + py * vy + pz * vz > 0) break;
  }
  return { fate, steps };
}
