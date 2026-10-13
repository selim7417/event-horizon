// Blackbody colour table.
//
// For every temperature we integrate Planck's law against the CIE 1931 2° colour
// matching functions, convert XYZ to linear sRGB and white-balance so that a
// 6500 K body is neutral. The table stores chromaticity (RGB with luminance 1)
// in .rgb and log2 of the *absolute* visible luminance, relative to 6500 K, in .a.
//
// Because I_ν/ν³ is invariant along a ray, a blackbody at temperature T seen with
// a frequency shift g is exactly a blackbody at temperature g·T. The shaders use
// this table for the disk, the stars and the sky, so every Doppler and
// gravitational shift in the image is just a lookup at a shifted temperature.

export const BB_TMIN = 300;
export const BB_TMAX = 300000;
export const BB_SIZE = 1024;

// Multi-lobe Gaussian fit to the CIE 1931 observer (Wyman, Sloan & Shirley 2013).
function lobe(x, mu, s1, s2) {
  const t = (x - mu) / (x < mu ? s1 : s2);
  return Math.exp(-0.5 * t * t);
}
function cieX(l) { return 1.056 * lobe(l, 599.8, 37.9, 31.0) + 0.362 * lobe(l, 442.0, 16.0, 26.7) - 0.065 * lobe(l, 501.1, 20.4, 26.2); }
function cieY(l) { return 0.821 * lobe(l, 568.8, 46.9, 40.5) + 0.286 * lobe(l, 530.9, 16.3, 31.1); }
function cieZ(l) { return 1.217 * lobe(l, 437.0, 11.8, 36.0) + 0.681 * lobe(l, 459.0, 26.0, 13.8); }

// Planck spectral radiance up to a constant factor; λ in nm.
function planck(lambdaNm, T) {
  const l = lambdaNm * 1e-9;
  const c2 = 1.4387769e-2; // hc/k, m·K
  return 1 / (Math.pow(l, 5) * (Math.exp(c2 / (l * T)) - 1));
}

function blackbodyXYZ(T) {
  let X = 0, Y = 0, Z = 0;
  for (let l = 380; l <= 780; l += 2) {
    const p = planck(l, T);
    X += p * cieX(l);
    Y += p * cieY(l);
    Z += p * cieZ(l);
  }
  return [X, Y, Z];
}

function xyzToLinearSRGB([X, Y, Z]) {
  return [
    3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z,
    -0.9692660 * X + 1.8760108 * Y + 0.0415560 * Z,
    0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z,
  ];
}

const luma = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

export function buildBlackbodyTable() {
  const ref = xyzToLinearSRGB(blackbodyXYZ(6500));
  const refY = blackbodyXYZ(6500)[1];
  const data = new Float32Array(BB_SIZE * 4);
  const lmin = Math.log(BB_TMIN), lmax = Math.log(BB_TMAX);
  for (let i = 0; i < BB_SIZE; i++) {
    const T = Math.exp(lmin + (lmax - lmin) * (i / (BB_SIZE - 1)));
    const xyz = blackbodyXYZ(T);
    let rgb = xyzToLinearSRGB(xyz).map((v, k) => Math.max(v / ref[k], 0));
    const y = Math.max(luma(rgb), 1e-30);
    rgb = rgb.map((v) => v / y);
    data[i * 4 + 0] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = Math.max(Math.log2(Math.max(xyz[1], 1e-300) / refY), -120);
  }
  return data;
}

// CPU-side lookup for UI swatches (returns display-ready sRGB 0..255).
export function blackbodyCSS(T) {
  const ref = xyzToLinearSRGB(blackbodyXYZ(6500));
  let rgb = xyzToLinearSRGB(blackbodyXYZ(T)).map((v, k) => Math.max(v / ref[k], 0));
  const m = Math.max(...rgb, 1e-9);
  rgb = rgb.map((v) => v / m);
  const enc = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
  return `rgb(${rgb.map((v) => Math.round(enc(v) * 255)).join(',')})`;
}
