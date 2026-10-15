// Port of the Rotorflight RPM filter (src/main/flight/rpm_filter.c).
//
// The firmware works from motor RPM and gear ratios. Every source frequency it uses can be
// written in terms of rotor speeds, which is what the blackbox log gives us:
//
//   source 10      main motor        = headspeed / mainGearRatio      (needs the gear ratio)
//   source 11..18  main rotor xN     = headspeed * N
//   source 20      tail motor        = tailspeed / tailGearRatio      (motorised tail only)
//   source 21..28  tail rotor xN     = tailspeed * N
//
// where mainGearRatio / tailGearRatio are the firmware's (rotor per motor) ratios. The logged
// headspeed is lrintf(motorRpm[0] * mainGearRatio) with motorRpm already low-pass filtered, so it is
// the very same signal the firmware RPM filter tracks, just sampled at the log rate.
//
// Reference: rotorflight-firmware RF-4.6.x @ 53fd0637 (release/4.6.0 + 1).

import { Biquad, BIQUAD } from "./filters.js";
import { constrain, transition } from "./fw_math.js";

export const RPM_FILTER_NOTCH_COUNT = 16;
export const RPM_FILTER_AXIS_COUNT = 3;
const RPM_UPDATE_BANK_COUNT = 3;

const LNC2 = (q) => Math.trunc(-1000 / q);
const RNC2 = (q) => Math.trunc(1000 / q);

function padBank(values) {
  const out = new Array(RPM_FILTER_NOTCH_COUNT).fill(0);
  values.forEach((v, i) => {
    out[i] = v;
  });
  return out;
}

function preset(sources, centers, qs) {
  return {
    source: sources.map(padBank),
    center: centers.map(padBank),
    q: qs.map(padBank),
  };
}

// RF 4.6 presets (rpmFilterPreset[]). Axis order: roll, pitch, yaw.
export const RPM_FILTER_PRESETS = Object.freeze([
  // 1: Low vibration
  preset(
    [[11, 12, 14, 21], [11, 12, 14, 21], [11, 12, 21]],
    [[0], [0], [0]],
    [[80, 40, 60, 50], [80, 40, 60, 50], [80, 40, 50]],
  ),
  // 2: Typical vibration
  preset(
    [
      [11, 12, 13, 14, 21, 22, 10],
      [11, 12, 13, 14, 21, 22, 10],
      [11, 12, 13, 14, 21, 22, 10],
    ],
    [[0], [0], [0]],
    [
      [80, 30, 80, 60, 60, 50, 80],
      [80, 30, 80, 60, 60, 50, 80],
      [80, 40, 80, 80, 60, 50, 80],
    ],
  ),
  // 3: High vibration
  preset(
    [
      [11, 12, 12, 13, 14, 15, 16, 21, 22, 10],
      [11, 12, 12, 13, 14, 15, 16, 21, 22, 10],
      [11, 12, 13, 14, 21, 22, 10],
    ],
    [[0, LNC2(30), RNC2(30), 0], [0, LNC2(30), RNC2(30), 0], [0]],
    [
      [50, 30, 30, 80, 50, 80, 80, 60, 50, 80],
      [50, 30, 30, 80, 50, 80, 80, 60, 50, 80],
      [80, 40, 80, 80, 50, 40, 80],
    ],
  ),
]);

/**
 * validateAndFixRPMFilterConfig(): resolves a preset into explicit banks, and clears
 * incomplete custom banks. Returns {source, center, q} as [axis][bank] arrays.
 */
export function resolveRpmBanks(rpmConfig) {
  const presetIndex = rpmConfig.preset ?? 0;
  if (presetIndex > 0 && presetIndex <= RPM_FILTER_PRESETS.length) {
    const p = RPM_FILTER_PRESETS[presetIndex - 1];
    return {
      source: p.source.map((a) => a.slice()),
      center: p.center.map((a) => a.slice()),
      q: p.q.map((a) => a.slice()),
    };
  }
  const out = { source: [], center: [], q: [] };
  for (let axis = 0; axis < RPM_FILTER_AXIS_COUNT; axis++) {
    const source = padBank(rpmConfig.source?.[axis] ?? []);
    const center = padBank(rpmConfig.center?.[axis] ?? []);
    const q = padBank(rpmConfig.q?.[axis] ?? []);
    for (let bank = 0; bank < RPM_FILTER_NOTCH_COUNT; bank++) {
      if (!source[bank] || !q[bank]) {
        source[bank] = 0;
        center[bank] = 0;
        q[bank] = 0;
      }
    }
    out.source.push(source);
    out.center.push(center);
    out.q.push(q);
  }
  return out;
}

/** Human readable name for an RPM notch source number. */
export function rpmSourceName(source) {
  if (source === 10) return "Main motor";
  if (source >= 11 && source <= 18) return `Main rotor ×${source - 10}`;
  if (source === 20) return "Tail motor";
  if (source >= 21 && source <= 28) return `Tail rotor ×${source - 20}`;
  return "Off";
}

/**
 * @param {object} rpmConfig {minHz, preset, source[3][16], center[3][16], q[3][16]} in CLI units
 * @param {number} filterRateHz
 * @param {object} rotor
 *   mainGearRatio  firmware main ratio (rotor RPM per motor RPM), or null if unknown
 *   tailGearRatio  firmware tail ratio, or null if unknown
 *   motorisedTail  true for a separate tail motor
 *   hasTailSpeed   true when a tail rotor speed signal is available
 */
export class RpmFilter {
  constructor(rpmConfig, filterRateHz, rotor) {
    this.filterRateHz = filterRateHz;
    this.notchMaxHz = 0.45 * filterRateHz;
    this.notchMinHz = constrain(rpmConfig.minHz, 10, 0.5 * this.notchMaxHz);
    this.notchFadeHz = 1.25 * this.notchMinHz;
    this.skipped = [];

    const banks = resolveRpmBanks(rpmConfig);
    const mainGearRatio = rotor.mainGearRatio;
    const tailGearRatio = rotor.tailGearRatio;

    // Main motor fundamental used if not direct-drive
    const enable10 = mainGearRatio != null && mainGearRatio !== 1;
    // Tail motor fundamental used if geared motorised tail
    const enable20 = rotor.motorisedTail && tailGearRatio != null && tailGearRatio !== 1;

    // this.banks[axis] = list of active banks in firmware slot order
    this.banks = [];
    this.slots = []; // [axis][slot] -> bank or null, for the round robin update order
    let total = 0;

    for (let axis = 0; axis < RPM_FILTER_AXIS_COUNT; axis++) {
      const axisBanks = [];
      const axisSlots = new Array(RPM_FILTER_NOTCH_COUNT).fill(null);
      for (let slot = 0; slot < RPM_FILTER_NOTCH_COUNT; slot++) {
        const source = banks.source[axis][slot];
        const qRaw = banks.q[axis][slot];
        if (!source || !qRaw) continue;

        const centerRatio = 1 + banks.center[axis][slot] / 10000;
        const notchQ = constrain(qRaw, 10, 250) / 10;
        let signal = null; // 'head' or 'tail'
        let multiplier = 0; // Hz = rpm(signal) * multiplier

        if (source === 10) {
          if (enable10) {
            signal = "head";
            multiplier = centerRatio / mainGearRatio / 60;
          }
        } else if (source >= 11 && source <= 18) {
          signal = "head";
          multiplier = ((source - 10) * centerRatio) / 60;
        } else if (source === 20) {
          if (enable20) {
            signal = "tail";
            multiplier = centerRatio / tailGearRatio / 60;
          }
        } else if (source >= 21 && source <= 28) {
          signal = "tail";
          multiplier = ((source - 20) * centerRatio) / 60;
        }

        if (signal === "tail" && !rotor.hasTailSpeed) {
          this.skipped.push({ axis, slot, source, reason: "tail rotor speed unknown" });
          signal = null;
        }
        if (source === 10 && !enable10) {
          this.skipped.push({
            axis,
            slot,
            source,
            reason: mainGearRatio == null ? "main gear ratio unknown" : "direct drive",
          });
        }
        if (signal === null) continue;

        const bank = {
          axis,
          slot,
          source,
          signal,
          multiplier,
          notchQ,
          fader: 0,
          center: this.notchMinHz,
          notch: new Biquad(this.notchMinHz, filterRateHz, notchQ, BIQUAD.NOTCH, true),
        };
        axisBanks.push(bank);
        axisSlots[slot] = bank;
        total++;
      }
      this.banks.push(axisBanks);
      this.slots.push(axisSlots);
    }

    this.totalBankCount = total;
    this.updateBankCount = Math.min(total, RPM_UPDATE_BANK_COUNT);
    this.updateAxisNumber = 0;
    this.updateBankNumber = 0;
  }

  // rpmFilterGyro()
  filter(axis, value) {
    const banks = this.banks[axis];
    for (let i = 0; i < banks.length; i++) {
      const b = banks[i];
      value += (b.notch.applyDF1(value) - value) * b.fader;
    }
    return value;
  }

  // rpmFilterUpdate(): called every PID loop. headRpm / tailRpm are rotor speeds in RPM.
  update(headRpm, tailRpm) {
    if (!this.totalBankCount) return;
    for (let count = 0; count < this.updateBankCount; ) {
      const bank = this.slots[this.updateAxisNumber][this.updateBankNumber];
      if (bank) {
        const rpm = bank.signal === "head" ? headRpm : tailRpm;
        const freq = rpm * bank.multiplier;
        const center = constrain(freq, this.notchMinHz, this.notchMaxHz);
        bank.fader = transition(freq, this.notchMinHz, this.notchFadeHz, 0, 1);
        bank.center = center;
        bank.notch.setCoefficients(center, this.filterRateHz, bank.notchQ, BIQUAD.NOTCH);
        count++;
      }
      this.updateBankNumber = (this.updateBankNumber + 1) % RPM_FILTER_NOTCH_COUNT;
      if (this.updateBankNumber === 0) {
        this.updateAxisNumber = (this.updateAxisNumber + 1) % RPM_FILTER_AXIS_COUNT;
      }
    }
  }
}

/**
 * Frequency (Hz) a bank tracks at the given rotor speeds, or null when it can't be placed.
 * Same arithmetic as RpmFilter, for display.
 */
export function rpmBankFrequency(source, center, speeds, rotor) {
  const ratio = 1 + (center || 0) / 10000;
  const head = speeds?.head;
  const tail = speeds?.tail;
  if (source === 10) {
    return head != null && rotor?.mainGearRatio ? ((head / rotor.mainGearRatio) * ratio) / 60 : null;
  }
  if (source >= 11 && source <= 18) {
    return head != null ? (head * (source - 10) * ratio) / 60 : null;
  }
  if (source === 20) {
    return tail != null && rotor?.tailGearRatio ? ((tail / rotor.tailGearRatio) * ratio) / 60 : null;
  }
  if (source >= 21 && source <= 28) {
    return tail != null ? (tail * (source - 20) * ratio) / 60 : null;
  }
  return null;
}

export const RPM_SOURCE_OPTIONS = Object.freeze([
  { label: "Off", value: 0 },
  { label: "Main motor", value: 10 },
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((h) => ({ label: `Main rotor ×${h}`, value: 10 + h })),
  { label: "Tail motor", value: 20 },
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((h) => ({ label: `Tail rotor ×${h}`, value: 20 + h })),
]);
