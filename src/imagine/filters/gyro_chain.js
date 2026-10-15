// Port of the Rotorflight gyro filter pipeline: gyroInitFilters() (sensors/gyro_init.c),
// the per-axis filter function (sensors/gyro_filter_impl.c), dynLpfUpdate() (sensors/gyro.c)
// and the filter update sub-task order (fc/core.c subTaskFilterUpdate).
//
// Per filter loop, for each axis (input = decimated gyro, i.e. the logged gyroRAW):
//   RPM notch bank -> LPF2 -> LPF1 -> notch 2 -> notch 1 -> dynamic notch
// Per PID loop: dynamic LPF (every 5 ms), dynamic notch tracking, RPM notch tracking.
//
// Reference: rotorflight-firmware RF-4.6.x @ 53fd0637 (release/4.6.0 + 1).

import { createLowpassFilter, createNotchFilter, notchFilterGetQ, LPF_TYPE } from "./filters.js";
import { DynNotch } from "./dyn_notch.js";
import { RpmFilter } from "./rpm_filter.js";
import { constrain } from "./fw_math.js";

export const DYN_LPF_UPDATE_DELAY_US = 5000;
const XYZ_AXIS_COUNT = 3;

// gyro_init.c calculateNyquistAdjustedNotchHz()
export function nyquistAdjustedNotchHz(notchHz, notchCutoffHz, filterRateHz) {
  const nyquist = filterRateHz / 2;
  if (notchHz > nyquist) {
    return notchCutoffHz < nyquist ? nyquist : 0;
  }
  return notchHz;
}

// gyro_init.c gyroInitNotchFilter() - returns {hz, q} actually used (q = 0 means disabled)
export function staticNotchParams(notchHz, notchCutoffHz, filterRateHz) {
  const hz = nyquistAdjustedNotchHz(notchHz, notchCutoffHz, filterRateHz);
  const q = hz > 0 && notchCutoffHz > 0 ? notchFilterGetQ(hz, notchCutoffHz) : 0;
  return { hz, q };
}

/**
 * Is the dynamic LPF in use? (gyroInitFilters: lpf1 type set and dyn min > 0)
 */
export function isDynLpfEnabled(settings) {
  return !!settings.lpf1.type && settings.lpf1.dynMinHz > 0;
}

/**
 * Builds the complete filter state for all three axes.
 *
 * @param {object} settings  Imagine settings (see header_settings.js)
 * @param {object} rates     {filterRateHz, pidRateHz}
 * @param {object} rotor     {mainGearRatio, tailGearRatio, motorisedTail, hasTailSpeed,
 *                            fullHeadSpeed, governorActive}
 */
export class GyroFilterChain {
  constructor(settings, rates, rotor) {
    const fs = rates.filterRateHz;
    this.settings = settings;
    this.rates = rates;
    this.rotor = rotor;
    this.filterRateHz = fs;

    this.dynLpf = isDynLpfEnabled(settings)
      ? { hz: settings.lpf1.staticHz, min: settings.lpf1.dynMinHz, max: settings.lpf1.dynMaxHz }
      : null;

    this.lpf1 = [];
    this.lpf2 = [];
    this.notch1 = [];
    this.notch2 = [];
    const n1 = staticNotchParams(settings.notch1.hz, settings.notch1.cutoff, fs);
    const n2 = staticNotchParams(settings.notch2.hz, settings.notch2.cutoff, fs);
    this.notchParams = [n1, n2];

    for (let axis = 0; axis < XYZ_AXIS_COUNT; axis++) {
      this.lpf1.push(createLowpassFilter(settings.lpf1.type, settings.lpf1.staticHz, fs, !!this.dynLpf));
      this.lpf2.push(createLowpassFilter(settings.lpf2.type, settings.lpf2.staticHz, fs, false));
      this.notch1.push(createNotchFilter(n1.hz, n1.q, fs));
      this.notch2.push(createNotchFilter(n2.hz, n2.q, fs));
    }

    this.dynNotch = null;
    if (settings.dynNotch.enabled) {
      const dn = new DynNotch(settings.dynNotch, fs, rates.pidRateHz);
      this.dynNotchDisabledReason = dn.disabledReason;
      if (dn.isActive()) this.dynNotch = dn;
    }

    this.rpm = null;
    if (settings.rpm.enabled) {
      const rpm = new RpmFilter(settings.rpm, fs, rotor);
      this.rpmSkipped = rpm.skipped;
      if (rpm.totalBankCount > 0) this.rpm = rpm;
    }

    this.lastDynLpfUpdateUs = 0;
    this.dynLpfCutoff = this.dynLpf ? settings.lpf1.staticHz : null;
  }

  // gyro_filter_impl.c, one axis
  filterAxis(axis, value) {
    if (this.rpm) value = this.rpm.filter(axis, value);
    value = this.lpf2[axis].apply(value);
    value = this.lpf1[axis].apply(value);
    value = this.notch2[axis].apply(value);
    value = this.notch1[axis].apply(value);
    if (this.dynNotch) value = this.dynNotch.filter(axis, value);
    return value;
  }

  // getFullHeadSpeedRatio(): the governor's headspeed / full headspeed while it is spooling up or
  // active, 1.0 otherwise. The governor state is not in the log, so a rotor turning slower than
  // 10% of full headspeed is treated as idle (ratio 1.0).
  headSpeedRatio(headRpm) {
    const r = this.rotor;
    if (r.governorActive && r.fullHeadSpeed > 0 && headRpm > 0.1 * r.fullHeadSpeed) {
      return headRpm / r.fullHeadSpeed;
    }
    return 1.0;
  }

  // subTaskFilterUpdate(): dynLpfUpdate, dynNotchUpdate, rpmFilterUpdate
  updateTask(timeUs, headRpm, tailRpm) {
    if (this.dynLpf && timeUs - this.lastDynLpfUpdateUs >= DYN_LPF_UPDATE_DELAY_US) {
      const ratio = this.headSpeedRatio(headRpm);
      const cutoff = constrain(ratio * this.dynLpf.hz, this.dynLpf.min, this.dynLpf.max);
      for (let axis = 0; axis < XYZ_AXIS_COUNT; axis++) {
        this.lpf1[axis].update(cutoff, this.filterRateHz);
      }
      this.dynLpfCutoff = cutoff;
      this.lastDynLpfUpdateUs = timeUs;
    }
    if (this.dynNotch) this.dynNotch.update();
    if (this.rpm) this.rpm.update(headRpm, tailRpm);
  }

  describe() {
    const s = this.settings;
    return {
      lpf1: s.lpf1.type !== LPF_TYPE.NONE && s.lpf1.staticHz > 0,
      lpf2: s.lpf2.type !== LPF_TYPE.NONE && s.lpf2.staticHz > 0,
      dynLpf: !!this.dynLpf,
      notch1: this.notchParams[0].q > 0,
      notch2: this.notchParams[1].q > 0,
      dynNotch: !!this.dynNotch,
      dynNotchDisabledReason: this.dynNotchDisabledReason ?? null,
      rpm: !!this.rpm,
      rpmBankCount: this.rpm?.totalBankCount ?? 0,
      rpmSkipped: this.rpmSkipped ?? [],
    };
  }
}
