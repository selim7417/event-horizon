// The ray tracer. One fragment = one photon, followed backwards in time from the
// camera through Schwarzschild spacetime.
//
// Units: Schwarzschild radius r_s = 1 (so M = 1/2, G = c = 1). Positions are
// Schwarzschild coordinates (r, θ, φ) laid out as a flat Cartesian embedding.
// In that picture a photon obeys the Binet equation u'' + u = (3/2) r_s u², which
// is exactly the orbit of a particle under the acceleration
//
//        a = −(3/2) · h² · x / r⁵,     h = |x × v| (conserved)
//
// We integrate it with velocity Verlet and a step proportional to r.

export const TRACE_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp samplerCube;

in vec2 vUv;
out vec4 fragColor;

uniform vec2  uRes;
uniform vec3  uCamPos;
uniform vec3  uCamRight;
uniform vec3  uCamUp;
uniform vec3  uCamFwd;
uniform float uTanHalfFov;
uniform vec2  uLensShift;     // off-centre projection, in NDC (like a shift lens)
uniform vec2  uJitter;        // sub-pixel offset for temporal anti-aliasing
uniform vec3  uObsVel;        // observer velocity relative to a static observer (units of c)
uniform float uTime;          // coordinate time, units of r_s / c
uniform int   uMaxSteps;
uniform float uStepK;
uniform float uCurvature;     // 0 = flat spacetime, 1 = Schwarzschild
uniform float uDiskOn;
uniform float uDiskInner;
uniform float uDiskOuter;
uniform float uDiskTemp;      // peak temperature, kelvin
uniform float uDiskDensity;
uniform float uDiskGain;
uniform float uCorona;       // brightness of the thick, optically thin layer around the disk
uniform float uDoppler;       // 0..1 blend of kinematic shifts
uniform float uGravShift;     // 0..1 blend of gravitational shifts
uniform float uStarGain;
uniform float uSkyGain;
uniform sampler2D uBlackbody;
uniform samplerCube uSky;

#define MAX_STEPS 640
#define BB_SIZE 1024.0

// ---------------------------------------------------------------- blackbody
vec4 bbTexel(float T) {
  float u = (log(max(T, 1.0)) - 5.70378247) / 6.90775528; // ln(300) .. ln(300000)
  u = clamp(u, 0.0, 1.0) * (BB_SIZE - 1.0) / BB_SIZE + 0.5 / BB_SIZE;
  return textureLod(uBlackbody, vec2(u, 0.5), 0.0);
}
// Linear sRGB radiance of a blackbody at T, relative to 6500 K = 1.
vec3 blackbody(float T) {
  vec4 s = bbTexel(T);
  return s.rgb * exp2(s.a);
}

// ---------------------------------------------------------------- noise
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float a = hash13(i);
  float b = hash13(i + vec3(1.0, 0.0, 0.0));
  float c = hash13(i + vec3(0.0, 1.0, 0.0));
  float d = hash13(i + vec3(1.0, 1.0, 0.0));
  float e = hash13(i + vec3(0.0, 0.0, 1.0));
  float f1 = hash13(i + vec3(1.0, 0.0, 1.0));
  float g = hash13(i + vec3(0.0, 1.0, 1.0));
  float h = hash13(i + vec3(1.0, 1.0, 1.0));
  return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y),
             mix(mix(e, f1, u.x), mix(g, h, u.x), u.y), u.z);
}
float fbm4(vec3 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * vnoise(p);
    p = p * 2.13 + vec3(1.7, 9.2, 3.1);
    a *= 0.5;
  }
  return s / 0.9375;
}

// ---------------------------------------------------------------- accretion disk
// Turbulence at log-radius lr and corotating azimuth a: broad clumps plus thin
// arcs that are stretched along the orbit.
float diskLayer(float lr, float a, float seed) {
  float ca = cos(a), sa = sin(a);
  float base = fbm4(vec3(ca * 1.5, sa * 1.5, lr * 7.0 + seed));
  float arcs = fbm4(vec3(ca * 3.4, sa * 3.4, lr * 36.0 + seed * 1.7));
  return base * 0.68 + arcs * 0.32;
}

// The pattern is advected by Keplerian differential rotation. Two copies, half a
// cycle apart, are cross-faded so the shear never winds up without bound; the
// blend is renormalised so the turbulence keeps its contrast mid-fade.
float diskTurbulence(float r, float phi) {
  const float P = 90.0;
  float omega = sqrt(0.5 / (r * r * r));
  float ph = fract(uTime / P);
  float ph2 = fract(ph + 0.5);
  float w = 1.0 - abs(2.0 * ph - 1.0);
  float lr = log(r);
  float n1 = diskLayer(lr, phi + omega * ph * P, 0.0);
  float n2 = diskLayer(lr, phi + omega * ph2 * P, 23.7);
  float n = 0.5 + (mix(n2, n1, w) - 0.5) * inversesqrt(w * w + (1.0 - w) * (1.0 - w));
  return clamp((n - 0.5) * 2.4 + 0.5, 0.0, 1.0);
}

float diskProfile(float r) {
  // Novikov–Thorne / Shakura–Sunyaev profile with zero torque at the ISCO.
  float x = uDiskInner / r;
  return r > uDiskInner ? pow(x, 0.75) * pow(1.0 - sqrt(x), 0.25) / 0.48795 : 0.0;
}

// Frequency shift g = ν_observed / ν_emitted for gas on circular orbits.
float diskShift(float r, float Ly, float camGrav, float camKin) {
  float omega = sqrt(0.5 / (r * r * r));
  float v2 = min(0.5 / max(r - uCurvature, 1e-3), 0.995);   // orbital speed² seen by a static observer
  float kin = sqrt(1.0 - v2) / max(1.0 - omega * Ly, 1e-3); // Doppler + transverse time dilation
  float grav = sqrt(max(1.0 - uCurvature / r, 1e-5));        // climbing out of the well
  return mix(1.0, kin * camKin, uDoppler) * mix(1.0, grav * camGrav, uGravShift);
}

float erfApprox(float x) {
  float s = sign(x);
  x = abs(x);
  float t = 1.0 / (1.0 + 0.47047 * x);
  float y = 1.0 - t * (0.3480242 + t * (-0.0958798 + t * 0.7478556)) * exp(-x * x);
  return s * y;
}

// Emission and optical depth where the ray crosses the disk plane.
// Ly is the photon's angular momentum about the disk axis per unit energy.
vec4 shadeDisk(vec3 p, float r, vec3 rayDir, float Ly, float camGrav, float camKin) {
  float rin = uDiskInner;
  float prof = diskProfile(r);

  float phi = atan(p.z, p.x);
  float n = diskTurbulence(r, phi);
  float lanes = 0.5 + 0.5 * sin(r * 13.0 + n * 6.0);
  float env = smoothstep(rin * 0.985, rin * 1.06, r) * (1.0 - smoothstep(uDiskOuter * 0.5, uDiskOuter, r));
  float dens = (0.04 + 1.5 * pow(n, 2.2)) * (0.78 + 0.22 * lanes) * env;
  // Denser filaments run hotter.
  float T = uDiskTemp * prof * (0.8 + 0.4 * n);

  float g = diskShift(r, Ly, camGrav, camKin);
  float tau = uDiskDensity * dens / max(abs(rayDir.y), 0.04);
  vec3 S = blackbody(T * g) * uDiskGain * (0.35 + 0.9 * n);
  return vec4(S, tau);
}

// ---------------------------------------------------------------- sky
// Procedural stars on a cube-sphere grid. Each cell holds at most one star kept
// away from the cell border, so a single lookup per layer is enough. The pixel
// footprint (how much sky one pixel covers after lensing) widens and dims stars
// that are being demagnified, which keeps them from sparkling.
vec3 starLayer(vec3 d, float N, float density, float gain, float fp, float g, float seed) {
  vec3 a = abs(d);
  vec2 uv; float face; float sgn;
  if (a.x >= a.y && a.x >= a.z) { uv = d.yz / a.x; face = 0.0; sgn = sign(d.x); }
  else if (a.y >= a.z)          { uv = d.xz / a.y; face = 2.0; sgn = sign(d.y); }
  else                          { uv = d.xy / a.z; face = 4.0; sgn = sign(d.z); }
  face += sgn > 0.0 ? 0.0 : 1.0;
  vec2 cell = floor((uv * 0.5 + 0.5) * N);
  vec3 cid = vec3(cell, face * 13.0 + seed);
  float h = hash13(cid);
  if (h > density) return vec3(0.0);
  vec2 off = 0.25 + 0.5 * vec2(hash13(cid + 11.17), hash13(cid + 23.71));
  vec2 suv = (cell + off) / N * 2.0 - 1.0;
  vec3 sd;
  if (face < 1.5)      sd = vec3(sgn, suv.x, suv.y);
  else if (face < 3.5) sd = vec3(suv.x, sgn, suv.y);
  else                 sd = vec3(suv.x, suv.y, sgn);
  sd = normalize(sd);
  vec3 dd = d - sd;
  float dist2 = dot(dd, dd);
  float cellAng = 2.0 / N;
  float sig = 0.00045;
  float s2 = sig * sig + 0.3 * fp * fp;
  float fade = 1.0 - smoothstep(0.04, 0.08, sqrt(s2) / cellAng);
  float m = hash13(cid + 5.3);
  float bright = gain * (0.03 + 0.4 * pow(m, 4.0) + 9.0 * pow(m, 30.0));
  float ht = hash13(cid + 41.9);
  float T = 3600.0 + 8000.0 * pow(ht, 1.6) + step(0.93, ht) * 14000.0;
  vec3 col = blackbody(T * g) / exp2(bbTexel(T).a);
  col = mix(vec3(dot(col, vec3(0.2126, 0.7152, 0.0722))), col, 0.7);
  return col * bright * (sig * sig / s2) * exp(-0.5 * dist2 / s2) * fade;
}

mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
mat3 rotX(float a) { float c = cos(a), s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }

vec3 skyColor(vec3 d, float fp, float g) {
  vec3 neb = texture(uSky, d).rgb * blackbody(6500.0 * g) * uSkyGain;
  vec3 s = vec3(0.0);
  s += starLayer(d, 46.0, 0.3, 1.0, fp, g, 1.0);
  s += starLayer(rotX(0.71) * rotY(0.37) * d, 90.0, 0.6, 0.3, fp, g, 2.0);
  s += starLayer(rotY(1.93) * rotX(-0.52) * d, 150.0, 0.8, 0.12, fp, g, 3.0);
  return neb + s * uStarGain;
}

// ---------------------------------------------------------------- main
void main() {
  vec2 ndc = ((gl_FragCoord.xy + uJitter) / uRes) * 2.0 - 1.0 - uLensShift;
  float aspect = uRes.x / uRes.y;
  vec3 sObs = normalize(uCamFwd + ndc.x * aspect * uTanHalfFov * uCamRight + ndc.y * uTanHalfFov * uCamUp);

  // Relativistic aberration: observer frame -> local static frame.
  float beta = length(uObsVel);
  vec3 sStat = sObs;
  float gammaObs = 1.0;
  if (beta > 1e-5) {
    vec3 bh = uObsVel / beta;
    float c1 = dot(sObs, bh);
    float c = (c1 - beta) / (1.0 - beta * c1);
    vec3 perp = sObs - c1 * bh;
    float pl = length(perp);
    sStat = c * bh + (pl > 1e-7 ? perp / pl : vec3(0.0)) * sqrt(max(0.0, 1.0 - c * c));
    gammaObs = inversesqrt(1.0 - beta * beta);
  }

  float r0 = length(uCamPos);
  vec3 rhat = uCamPos / r0;
  float lapse0 = sqrt(max(1.0 - uCurvature / r0, 1e-6));
  // Frequency of a photon at the camera relative to its frequency far away.
  float camGrav = 1.0 / lapse0;
  float camKin = gammaObs * (1.0 + dot(uObsVel, sStat));

  // Local static frame -> coordinate direction: the radial component shrinks by the lapse.
  float sr = dot(sStat, rhat);
  vec3 dir = normalize(sStat + rhat * sr * (lapse0 - 1.0));

  vec3 hv = cross(uCamPos, dir);
  float h2 = dot(hv, hv);
  float sinA = length(cross(sStat, rhat));
  float bImpact = r0 * sinA / lapse0;
  float Ly = h2 > 1e-14 ? -bImpact * hv.y * inversesqrt(h2) : 0.0;

  float k = 1.5 * h2 * uCurvature;
  vec3 pos = uCamPos;
  vec3 vel = dir;
  float rr = r0;
  vec3 acc = -k * pos / (rr * rr * rr * rr * rr);
  vec3 col = vec3(0.0);
  float trans = 1.0;
  bool captured = false;
  float escapeR = max(r0 * 1.02, 34.0);
  float travelled = 0.0;
  bool diskActive = uDiskOn > 0.001;

  for (int i = 0; i < MAX_STEPS; i++) {
    if (i >= uMaxSteps) break;
    float dl = clamp(uStepK * rr, 0.004, 60.0);
    vec3 np = pos + vel * dl + 0.5 * acc * dl * dl;
    float nr2 = dot(np, np);
    float nr = sqrt(nr2);
    vec3 na = -k * np / (nr2 * nr2 * nr);
    vec3 nv = vel + 0.5 * (acc + na) * dl;

    // Corona: an optically thin Gaussian layer of height H around the disk. The
    // density is integrated exactly along each straight step (erf), so coarse
    // steps do not band.
    if (diskActive && uCorona > 0.0) {
      vec3 mid = 0.5 * (pos + np);
      float rc = length(mid.xz);
      float H = 0.042 * rc + 0.05;
      if (min(abs(pos.y), abs(np.y)) < 3.0 * H && rc > uDiskInner * 0.9 && rc < uDiskOuter) {
        float dy = np.y - pos.y;
        float path = abs(dy) > 1e-4 * dl
          ? dl * H * 0.886227 * abs(erfApprox(np.y / H) - erfApprox(pos.y / H)) / abs(dy)
          : dl * exp(-pos.y * pos.y / (H * H));
        float envc = smoothstep(uDiskInner * 0.9, uDiskInner * 1.2, rc) * (1.0 - smoothstep(uDiskOuter * 0.4, uDiskOuter, rc));
        float gc = diskShift(rc, Ly, camGrav, camKin);
        float nearCam = smoothstep(0.0, 2.5, travelled);   // keep the lens clear of fog
        col += trans * blackbody(uDiskTemp * diskProfile(max(rc, uDiskInner * 1.02)) * gc) * (uDiskGain * uCorona * uDiskOn * envc * nearCam * path / H);
      }
    }

    if (diskActive && pos.y * np.y < 0.0) {
      float t = pos.y / (pos.y - np.y);
      vec3 hp = mix(pos, np, t);
      float hr = length(hp.xz);
      if (hr > uDiskInner * 0.97 && hr < uDiskOuter) {
        vec4 em = shadeDisk(hp, hr, normalize(mix(vel, nv, t)), Ly, camGrav, camKin);
        float alpha = (1.0 - exp(-em.a)) * uDiskOn;
        col += trans * alpha * em.rgb;
        trans *= 1.0 - alpha;
        if (trans < 0.004) break;
      }
    }

    pos = np; vel = nv; acc = na; rr = nr;
    travelled += dl;
    if (nr < 1.0) { captured = true; break; }
    if (nr > escapeR && dot(np, nv) > 0.0) break;
  }

  // Kept outside any branch so screen-space derivatives stay valid.
  vec3 skyDir = normalize(vel);
  float fp = length(fwidth(skyDir));
  float gSky = mix(1.0, camKin, uDoppler) * mix(1.0, camGrav, uGravShift);
  vec3 sky = skyColor(skyDir, fp, gSky);
  col += sky * (captured ? 0.0 : trans);

  fragColor = vec4(col, 1.0);
}
`;
