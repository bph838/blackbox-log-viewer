// Where the RPM filter's notches sit, for drawing them on the chart while they're edited.
// Uses the same arithmetic as the ported filter (filters/rpm_filter.js): frequency from the rotor
// speed, clamped to [min Hz, 0.45 x filter rate], faded in between min Hz and 1.25 x min Hz.

import { constrain, transition } from "./filters/fw_math.js";
import { resolveRpmBanks, rpmBankFrequency, rpmSourceName, RPM_FILTER_NOTCH_COUNT } from "./filters/rpm_filter.js";
import { notchLowerCutoff } from "./dyn_notch_overlay.js";

/**
 * @param {object} p
 *   settings  Imagine settings (uses settings.rpm)
 *   axis      0..2
 *   speeds    {head, tail} rotor RPM (median)
 *   range     optional {head: [lo, hi], tail: [lo, hi]} - the spread of rotor speeds in the flight
 *   rotor     rotor info (gear ratios)
 *   filterRateHz
 * @returns {Array<{slot, source, name, hz, q, cutoffHz, fader, spread:[lo,hi]|null}>}
 */
export function rpmNotchMarkers({ settings, axis, speeds, range, rotor, filterRateHz }) {
  const rpm = settings?.rpm;
  if (!rpm?.enabled || !speeds?.head) return [];
  const banks = resolveRpmBanks(rpm);
  const maxHz = 0.45 * filterRateHz;
  const minHz = constrain(rpm.minHz, 10, 0.5 * maxHz);
  const fadeHz = 1.25 * minHz;
  const out = [];
  for (let slot = 0; slot < RPM_FILTER_NOTCH_COUNT; slot++) {
    const source = banks.source[axis][slot];
    const qRaw = banks.q[axis][slot];
    if (!source || !qRaw) continue;
    const center = banks.center[axis][slot];
    const freq = rpmBankFrequency(source, center, speeds, rotor);
    if (freq == null) continue;
    const hz = constrain(freq, minHz, maxHz);
    const q = constrain(qRaw, 10, 250) / 10;
    let spread = null;
    if (range) {
      const lo = rpmBankFrequency(source, center, { head: range.head[0], tail: range.tail?.[0] ?? null }, rotor);
      const hi = rpmBankFrequency(source, center, { head: range.head[1], tail: range.tail?.[1] ?? null }, rotor);
      if (lo != null && hi != null) spread = [constrain(lo, minHz, maxHz), constrain(hi, minHz, maxHz)];
    }
    out.push({
      slot,
      source,
      name: rpmSourceName(source),
      hz,
      q,
      cutoffHz: notchLowerCutoff(hz, q),
      fader: transition(freq, minHz, fadeHz, 0, 1),
      spread,
    });
  }
  return out;
}
