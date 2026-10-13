// The backdrop universe, baked once into an HDR cubemap: a Milky Way band with a
// bulge and dust lanes, emission nebulae and one distant spiral galaxy. Point
// stars are drawn analytically in the tracer instead, so they stay sharp.

export const SKY_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform int uFace;

vec3 faceDir(int f, vec2 st) {
  float sc = st.x * 2.0 - 1.0;
  float tc = st.y * 2.0 - 1.0;
  if (f == 0) return vec3(1.0, -tc, -sc);
  if (f == 1) return vec3(-1.0, -tc, sc);
  if (f == 2) return vec3(sc, 1.0, tc);
  if (f == 3) return vec3(sc, -1.0, -tc);
  if (f == 4) return vec3(sc, -tc, 1.0);
  return vec3(-sc, -tc, -1.0);
}

vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx) * 2.0 - 1.0;
}
float gnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n000 = dot(hash33(i), f);
  float n100 = dot(hash33(i + vec3(1, 0, 0)), f - vec3(1, 0, 0));
  float n010 = dot(hash33(i + vec3(0, 1, 0)), f - vec3(0, 1, 0));
  float n110 = dot(hash33(i + vec3(1, 1, 0)), f - vec3(1, 1, 0));
  float n001 = dot(hash33(i + vec3(0, 0, 1)), f - vec3(0, 0, 1));
  float n101 = dot(hash33(i + vec3(1, 0, 1)), f - vec3(1, 0, 1));
  float n011 = dot(hash33(i + vec3(0, 1, 1)), f - vec3(0, 1, 1));
  float n111 = dot(hash33(i + vec3(1, 1, 1)), f - vec3(1, 1, 1));
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
             mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}
float fbm(vec3 p, int oct) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 9; i++) {
    if (i >= oct) break;
    s += a * gnoise(p);
    p = p * 2.03 + vec3(5.1, 1.3, 7.7);
    a *= 0.5;
  }
  return s;
}
float ridged(vec3 p, int oct) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 9; i++) {
    if (i >= oct) break;
    float n = 1.0 - abs(gnoise(p) * 2.0);
    s += a * n * n;
    p = p * 2.07 + vec3(2.3, 8.1, 4.4);
    a *= 0.5;
  }
  return s;
}

// Galactic frame, tilted well away from the accretion disk plane.
const vec3 GN = vec3(-0.4116, 0.8233, 0.3906);   // galactic north pole
const vec3 GC = vec3(0.8701, 0.2785, 0.4066);    // galactic centre direction

vec3 milkyWay(vec3 d) {
  vec3 GCo = normalize(GC - dot(GC, GN) * GN);
  vec3 GB = cross(GN, GCo);
  float lat = dot(d, GN);
  vec3 inPlane = normalize(d - lat * GN + 1e-6);
  float lon = atan(dot(inPlane, GB), dot(inPlane, GCo));
  float toCentre = acos(clamp(dot(d, GCo), -1.0, 1.0));

  vec3 warp = vec3(fbm(d * 3.0, 4), fbm(d * 3.0 + 7.3, 4), fbm(d * 3.0 + 3.1, 4));
  float wl = lat + 0.035 * warp.x;
  float thick = 0.075 + 0.11 * exp(-lon * lon * 1.6);
  float band = exp(-pow(wl / thick, 2.0));
  float halo = exp(-pow(wl / (thick * 3.2), 2.0));
  float bulge = exp(-pow(toCentre / 0.30, 2.0));

  float clouds = fbm(d * 5.0 + warp * 0.6, 7) * 0.5 + 0.5;
  float stars = band * (0.25 + 1.4 * pow(clouds, 2.2)) + halo * 0.10 + bulge * 1.6 * (0.6 + 0.4 * clouds);

  // Dust lanes: ridged noise concentrated near the mid-plane.
  float dustMask = exp(-pow((wl - 0.012 * sin(lon * 3.0)) / (thick * 0.55), 2.0));
  float dust = smoothstep(0.42, 0.85, ridged(d * 7.0 + warp, 6)) * dustMask;
  dust = max(dust, smoothstep(0.55, 0.9, fbm(d * 14.0 + 2.0, 5) * 0.5 + 0.5) * dustMask * 0.8);

  vec3 warm = vec3(1.0, 0.80, 0.58);
  vec3 cool = vec3(0.70, 0.78, 1.0);
  vec3 col = mix(cool, warm, clamp(bulge * 1.4 + 0.25 - 0.3 * clouds, 0.0, 1.0)) * stars;
  col *= 1.0 - 0.9 * dust;
  // Reddened light at the edges of the lanes.
  col += vec3(0.35, 0.12, 0.05) * dust * band * 0.25;

  // HII regions along the arms.
  float knots = pow(max(fbm(d * 26.0, 5) - 0.18, 0.0) * 3.2, 3.0) * band * (1.0 - dust);
  col += vec3(1.0, 0.28, 0.42) * knots * 0.9;

  // Unresolved star grain.
  float grain = pow(max(gnoise(d * 420.0) + 0.25, 0.0), 6.0) * 30.0;
  col += vec3(0.9, 0.92, 1.0) * grain * (band * 0.8 + halo * 0.15) * (1.0 - 0.8 * dust);
  return col;
}

vec3 nebula(vec3 d, vec3 c, float radius, vec3 tintA, vec3 tintB, float seed) {
  float a = acos(clamp(dot(d, c), -1.0, 1.0));
  if (a > radius * 2.2) return vec3(0.0);
  vec3 q = d * 6.0 + seed;
  vec3 w = vec3(fbm(q, 5), fbm(q + 4.7, 5), fbm(q + 9.1, 5));
  float n = fbm(q * 1.7 + w * 1.6, 7) * 0.5 + 0.5;
  float fil = ridged(q * 2.2 + w * 2.0, 6);
  float env = exp(-pow(a / radius, 2.0) * 1.6);
  float m = pow(n, 2.5) * env;
  vec3 col = mix(tintB, tintA, smoothstep(0.35, 0.75, n)) * m * 1.6;
  col += tintA * pow(fil, 4.0) * env * 0.9;
  return col;
}

vec3 galaxy(vec3 d) {
  vec3 c = normalize(vec3(-0.62, -0.28, 0.73));
  float a = acos(clamp(dot(d, c), -1.0, 1.0));
  if (a > 0.12) return vec3(0.0);
  vec3 t1 = normalize(cross(c, vec3(0.0, 1.0, 0.0)));
  vec3 t2 = cross(c, t1);
  vec2 p = vec2(dot(d, t1), dot(d, t2)) / 0.035;
  float ang = 0.6;
  p = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * p;
  p.y /= 0.36; // inclined disk
  float r = length(p);
  float th = atan(p.y, p.x);
  float arms = 0.5 + 0.5 * cos(2.0 * th - 4.2 * log(r + 0.05));
  float disk = exp(-r * 2.1) * (0.5 + 0.7 * arms);
  float core = exp(-r * r * 30.0);
  return vec3(1.0, 0.86, 0.70) * core * 3.0 + vec3(0.75, 0.80, 1.0) * disk * 0.45;
}

void main() {
  vec3 d = normalize(faceDir(uFace, vUv));
  vec3 col = milkyWay(d) * 0.030;
  col += nebula(d, normalize(vec3(0.35, -0.55, -0.76)), 0.32, vec3(1.0, 0.30, 0.38), vec3(0.20, 0.45, 0.85), 3.0) * 0.022;
  col += nebula(d, normalize(vec3(-0.85, 0.30, -0.42)), 0.24, vec3(0.20, 0.85, 0.80), vec3(0.55, 0.25, 0.85), 11.0) * 0.016;
  col += galaxy(d) * 0.05;
  col += vec3(0.0012, 0.0014, 0.0022); // faint extragalactic background
  fragColor = vec4(col, 1.0);
}
`;
