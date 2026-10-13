// Post-processing: a mip-chain bloom (13-tap downsample, tent upsample) and the
// final composite with AgX tone mapping, film grain and the EHT "radio" view.

export const DOWNSAMPLE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSrc;
uniform vec2 uTexel;     // 1 / source size
uniform float uKaris;    // 1 on the first pass: suppress fireflies

vec3 s(vec2 o) { return texture(uSrc, vUv + o * uTexel).rgb; }
float w(vec3 c) { return 1.0 / (1.0 + dot(c, vec3(0.2126, 0.7152, 0.0722))); }

void main() {
  vec3 a = s(vec2(-2, 2)),  b = s(vec2(0, 2)),  c = s(vec2(2, 2));
  vec3 d = s(vec2(-2, 0)),  e = s(vec2(0, 0)),  f = s(vec2(2, 0));
  vec3 g = s(vec2(-2, -2)), h = s(vec2(0, -2)), i = s(vec2(2, -2));
  vec3 j = s(vec2(-1, 1)),  k = s(vec2(1, 1));
  vec3 l = s(vec2(-1, -1)), m = s(vec2(1, -1));
  vec3 res;
  if (uKaris > 0.5) {
    vec3 g0 = (a + b + d + e) * 0.25, g1 = (b + c + e + f) * 0.25;
    vec3 g2 = (d + e + g + h) * 0.25, g3 = (e + f + h + i) * 0.25;
    vec3 g4 = (j + k + l + m) * 0.25;
    float w0 = w(g0), w1 = w(g1), w2 = w(g2), w3 = w(g3), w4 = w(g4);
    res = (g0 * w0 * 0.125 + g1 * w1 * 0.125 + g2 * w2 * 0.125 + g3 * w3 * 0.125 + g4 * w4 * 0.5)
        / (w0 * 0.125 + w1 * 0.125 + w2 * 0.125 + w3 * 0.125 + w4 * 0.5);
  } else {
    res = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  }
  fragColor = vec4(max(res, 0.0), 1.0);
}
`;

export const UPSAMPLE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uRadius;
void main() {
  vec2 o = uTexel * uRadius;
  vec3 c = texture(uSrc, vUv).rgb * 4.0;
  c += (texture(uSrc, vUv + vec2(-o.x, 0.0)).rgb + texture(uSrc, vUv + vec2(o.x, 0.0)).rgb
      + texture(uSrc, vUv + vec2(0.0, -o.y)).rgb + texture(uSrc, vUv + vec2(0.0, o.y)).rgb) * 2.0;
  c += texture(uSrc, vUv + vec2(-o.x, -o.y)).rgb + texture(uSrc, vUv + vec2(o.x, -o.y)).rgb
     + texture(uSrc, vUv + vec2(-o.x, o.y)).rgb + texture(uSrc, vUv + vec2(o.x, o.y)).rgb;
  fragColor = vec4(c / 16.0, 1.0);
}
`;

// Temporal accumulation: an exponential moving average of jittered frames.
// While the view is still this converges to a supersampled image; when the
// camera moves the app raises uAlpha toward 1 so nothing smears.
export const ACCUMULATE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uCurrent;
uniform sampler2D uHistory;
uniform float uAlpha;
void main() {
  vec3 cur = texture(uCurrent, vUv).rgb;
  vec3 hist = texture(uHistory, vUv).rgb;
  fragColor = vec4(mix(hist, cur, uAlpha), 1.0);
}
`;

// Average scene luminance for auto-exposure, read from the smallest bloom level
// (centre-weighted) and blended with last frame's value so the eye adapts
// gradually instead of snapping.
export const LUMINANCE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSrc;
uniform sampler2D uPrev;
uniform float uBlend;
void main() {
  float sum = 0.0, wsum = 0.0;
  for (int j = 0; j < 5; j++) {
    for (int i = 0; i < 5; i++) {
      vec2 uv = (vec2(float(i), float(j)) + 0.5) / 5.0;
      float w = exp(-3.0 * dot(uv - 0.5, uv - 0.5));
      sum += w * dot(texture(uSrc, uv).rgb, vec3(0.2126, 0.7152, 0.0722));
      wsum += w;
    }
  }
  float L = sum / wsum;
  float prev = texelFetch(uPrev, ivec2(0), 0).r;
  float outL = uBlend >= 1.0 ? L : exp(mix(log(max(prev, 1e-5)), log(max(L, 1e-5)), uBlend));
  fragColor = vec4(outL, 0.0, 0.0, 1.0);
}
`;

export const COMPOSITE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uHDR;
uniform sampler2D uBloom;     // accumulated bloom (sum over levels)
uniform sampler2D uWide;      // a heavily blurred level, for the EHT view
uniform float uBloomLevels;
uniform float uBloomStrength;
uniform float uExposure;
uniform float uEHT;
uniform float uTime;
uniform float uFade;          // 0 = black, 1 = image
uniform sampler2D uLum;       // adapted average luminance (1×1)
uniform float uAutoKey;
uniform float uAutoStrength;
uniform vec2 uRes;

// AgX tone mapping (Troy Sobotka; polynomial fit by Benjamin Wrensch).
vec3 agxContrast(vec3 x) {
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
vec3 agx(vec3 v) {
  const mat3 inset = mat3(0.842479062253094, 0.0423282422610123, 0.0423756549057051,
                          0.0784335999999992, 0.878468636469772, 0.0784336,
                          0.0792237451477643, 0.0791661274605434, 0.879142973793104);
  const mat3 outset = mat3(1.19687900512017, -0.0528968517574562, -0.0529716355144438,
                           -0.0980208811401368, 1.15190312990417, -0.0980434501171241,
                           -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
  const float minEv = -12.47393, maxEv = 4.026069;
  v = inset * v;
  v = clamp(log2(max(v, 1e-10)), minEv, maxEv);
  v = (v - minEv) / (maxEv - minEv);
  v = agxContrast(v);
  // A gentle "punchy" look.
  float l = dot(v, vec3(0.2126, 0.7152, 0.0722));
  v = pow(max(v, 0.0), vec3(1.1));
  v = l + 1.3 * (v - l);
  return clamp(outset * v, 0.0, 1.0);
}

vec3 afmhot(float x) {
  x = clamp(x, 0.0, 1.0);
  return clamp(vec3(2.0 * x, 2.0 * x - 0.5, 2.0 * x - 1.0), 0.0, 1.0);
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec3 hdr = texture(uHDR, vUv).rgb;
  vec3 bloom = texture(uBloom, vUv).rgb / uBloomLevels;
  float avg = texelFetch(uLum, ivec2(0), 0).r;
  // Compensate strongly for glare, gently for darkness.
  float ratio = uAutoKey / max(avg, 1e-5);
  float autoExp = clamp(pow(ratio, ratio < 1.0 ? uAutoStrength : uAutoStrength * 0.5), 0.05, 2.5);
  vec3 c = mix(hdr, bloom, uBloomStrength) * uExposure * autoExp;

  vec3 col = agx(c);

  if (uEHT > 0.001) {
    // A planet-sized radio telescope resolves only the broad structure.
    float L = dot(texture(uWide, vUv).rgb, vec3(0.2126, 0.7152, 0.0722)) * uExposure * autoExp;
    L = max(L - 0.06, 0.0);   // the radio sky behind is dark
    float x = pow(L / (L + 0.9), 0.85);
    col = mix(col, afmhot(x * 1.15), uEHT);
  }

  vec2 q = vUv - 0.5;
  q.x *= uRes.x / uRes.y;
  col *= mix(1.0, 1.0 - dot(q, q) * 0.55, 0.85);

  float n = hash12(gl_FragCoord.xy + fract(uTime * 7.31) * 1000.0) - 0.5;
  col += n * (0.018 + 0.02 * (1.0 - col.g));
  col *= uFade;
  fragColor = vec4(col, 1.0);
}
`;
