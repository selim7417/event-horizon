// Accuracy check for the photon integrator.
//
// For a static observer at several distances, bisect for the impact parameter
// that separates rays captured by the horizon from rays that escape, and compare
// it with the analytic critical value b_c = 3√3/2 r_s. Uses the same CPU
// integrator and camera-frame conversion as the light-path diagram, with the
// step-size limits of each rendering preset.
//
//   node tools/check-geodesics.mjs

import { tracePath, observerRayToCoordinate, B_CRIT } from '../js/physics.js';

const PRESETS = { low: [0.25, 8e-3], medium: [0.22, 4e-3], high: [0.2, 2e-3], ultra: [0.12, 5e-4] };
const DISTANCES = [3, 6, 26, 100];

function captured(r0, b, [stepK, stepErr]) {
  const lapse = Math.sqrt(1 - 1 / r0);
  const sinA = (b * lapse) / r0;
  if (sinA >= 1) return false;
  // Local static frame: aim inward at angle α from the inward radial direction.
  const sObs = [-Math.sqrt(1 - sinA * sinA), sinA, 0];
  const dir = observerRayToCoordinate(sObs, [r0, 0, 0], [0, 0, 0], 1);
  const { fate } = tracePath([r0, 0, 0], dir, { curvature: 1, diskInner: 3, diskOuter: 14, diskOn: false, stepK, stepErr, maxSteps: 4000 });
  return fate === 'horizon';
}

let worst = 0;
console.log(`analytic critical impact parameter: ${B_CRIT.toFixed(5)} r_s\n`);
console.log('preset   ' + DISTANCES.map((r) => `r=${r}`.padStart(11)).join(''));
for (const [name, k] of Object.entries(PRESETS)) {
  const cells = DISTANCES.map((r0) => {
    let lo = 2.0, hi = 3.2;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (captured(r0, mid, k)) lo = mid; else hi = mid;
    }
    const err = ((lo - B_CRIT) / B_CRIT) * 100;
    worst = Math.max(worst, Math.abs(err));
    return `${err >= 0 ? '+' : ''}${err.toFixed(3)}%`.padStart(11);
  });
  console.log(name.padEnd(9) + cells.join(''));
}
console.log(`\nlargest error: ${worst.toFixed(3)}%`);
process.exit(worst < 0.5 ? 0 : 1);
