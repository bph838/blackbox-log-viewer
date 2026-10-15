// Frequency response and delay of the gyro filter chain at a representative operating point.
//
// Dynamic filters (RPM notches, dynamic notch, dynamic LPF) are frozen at the operating point:
// median headspeed / tailspeed and the median tracked dynamic notch centres over the analysed range.
// Delay is phase delay: -phase / (2 pi f). It covers the software filters only; the gyro decimation
// filter sits before gyroRAW and is the same whatever the settings.

import { GyroFilterChain } from "./filters/gyro_chain.js";
import { multiplyResponses } from "./filters/filters.js";
import { BIQUAD } from "./filters/filters.js";
import { constrain } from "./filters/fw_math.js";

export const DELAY_FREQUENCIES = Object.freeze([5, 10, 20, 40, 80]);

function phaseOf(h) {
  return Math.atan2(h.im, h.re);
}

/**
 * @param {object} p
 *   settings, rates, rotor
 *   axis 0..2
 *   operatingPoint {headRpm, tailRpm, dynNotchCenters: [[Hz,...] x3] | null}
 *   frequencies list of Hz
 */
export function chainResponse({ settings, rates, rotor, axis, operatingPoint, frequencies = DELAY_FREQUENCIES }) {
  const chain = new GyroFilterChain(settings, rates, rotor);
  const fs = rates.filterRateHz;
  const head = operatingPoint?.headRpm ?? 0;
  const tail = operatingPoint?.tailRpm ?? 0;

  if (chain.dynLpf) {
    const cutoff = constrain(chain.headSpeedRatio(head) * chain.dynLpf.hz, chain.dynLpf.min, chain.dynLpf.max);
    chain.lpf1[axis].update(cutoff, fs);
  }

  if (chain.rpm) {
    // one full round robin pass updates every bank
    const passes = Math.ceil((3 * 16) / Math.max(1, chain.rpm.updateBankCount)) + 1;
    for (let i = 0; i < passes; i++) chain.rpm.update(head, tail);
  }

  if (chain.dynNotch && operatingPoint?.dynNotchCenters?.[axis]) {
    const centers = operatingPoint.dynNotchCenters[axis];
    chain.dynNotch.notch[axis].forEach((notch, p) => {
      if (centers[p] > 0) {
        notch.setCoefficients(centers[p], fs, chain.dynNotch.q + p * 0.2, BIQUAD.NOTCH);
      }
    });
  }

  const stages = [];
  if (chain.rpm) {
    for (const bank of chain.rpm.banks[axis]) {
      stages.push((f) => {
        const hn = bank.notch.response(f, fs);
        return { re: 1 - bank.fader + bank.fader * hn.re, im: bank.fader * hn.im };
      });
    }
  }
  stages.push((f) => chain.lpf2[axis].response(f, fs));
  stages.push((f) => chain.lpf1[axis].response(f, fs));
  stages.push((f) => chain.notch2[axis].response(f, fs));
  stages.push((f) => chain.notch1[axis].response(f, fs));
  if (chain.dynNotch) {
    for (const notch of chain.dynNotch.notch[axis]) stages.push((f) => notch.response(f, fs));
  }

  return frequencies.map((f) => {
    const responses = stages.map((stage) => stage(f));
    const h = multiplyResponses(responses);
    const phase = responses.reduce((acc, r) => acc + phaseOf(r), 0);
    const magnitude = Math.hypot(h.re, h.im);
    return {
      frequencyHz: f,
      gainDb: magnitude > 0 ? 20 * Math.log10(magnitude) : -Infinity,
      phaseDeg: (phase * 180) / Math.PI,
      delayMs: f > 0 ? (-phase / (2 * Math.PI * f)) * 1000 : 0,
    };
  });
}
