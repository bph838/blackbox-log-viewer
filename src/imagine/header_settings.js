// Maps the blackbox log header (FlightLog sysConfig) and the craft config (CLI dump/diff) onto
// Imagine's filter settings, rotor information and loop rates.

import semver from "semver";
import { FIRMWARE_TYPE_ROTORFLIGHT, FLIGHT_LOG_FEATURES } from "../flightlog_fielddefs.js";
import { parseGearRatio } from "../craft_config.js";
import { RPM_FILTER_NOTCH_COUNT } from "./filters/rpm_filter.js";
import { LPF_TYPE_NAMES } from "./filters/filters.js";

// The firmware source the filter port was taken from.
export const FIRMWARE_REFERENCE = Object.freeze({
  repository: "https://github.com/rotorflight/rotorflight-firmware",
  branch: "RF-4.6.x",
  commit: "53fd0637",
  version: "4.6.0",
  description: "release/4.6.0 + 1 commit; filter code identical to master as of 2026-10-15",
});

const AXIS_NAMES = ["roll", "pitch", "yaw"];

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pair(value) {
  if (Array.isArray(value)) return [num(value[0]), num(value[1])];
  if (value == null) return [0, 0];
  return [num(value), 0];
}

function bankArray(value) {
  const out = new Array(RPM_FILTER_NOTCH_COUNT).fill(0);
  if (Array.isArray(value)) {
    value.slice(0, RPM_FILTER_NOTCH_COUNT).forEach((v, i) => {
      out[i] = num(v);
    });
  }
  return out;
}

export function isFeatureEnabled(sysConfig, featureName) {
  const bit = FLIGHT_LOG_FEATURES.indexOf(featureName);
  if (bit < 0 || sysConfig.features == null) return false;
  return (Number(sysConfig.features) & (1 << bit)) !== 0;
}

/**
 * Imagine settings from the log header. All values are in CLI units (Q values are x10, RPM notch
 * centre corrections are x10000) so they compare one to one with `diff all`.
 */
export function settingsFromSysConfig(sysConfig) {
  const dyn = pair(sysConfig.gyro_lowpass_dyn_hz);
  const notchHz = pair(sysConfig.gyro_notch_hz);
  const notchCutoff = pair(sysConfig.gyro_notch_cutoff);

  const rpm = {
    enabled: isFeatureEnabled(sysConfig, "RPM_FILTER"),
    minHz: num(sysConfig.gyro_rpm_notch_min_hz, 20),
    preset: num(sysConfig.gyro_rpm_notch_preset, 0),
    source: AXIS_NAMES.map((a) => bankArray(sysConfig[`gyro_rpm_notch_source_${a}`])),
    center: AXIS_NAMES.map((a) => bankArray(sysConfig[`gyro_rpm_notch_center_${a}`])),
    q: AXIS_NAMES.map((a) => bankArray(sysConfig[`gyro_rpm_notch_q_${a}`])),
  };

  return {
    lpf1: {
      type: num(sysConfig.gyro_soft_type),
      staticHz: num(sysConfig.gyro_lowpass_hz),
      dynMinHz: dyn[0],
      dynMaxHz: dyn[1],
    },
    lpf2: {
      type: num(sysConfig.gyro_soft2_type),
      staticHz: num(sysConfig.gyro_lowpass2_hz),
    },
    notch1: { hz: notchHz[0], cutoff: notchCutoff[0] },
    notch2: { hz: notchHz[1], cutoff: notchCutoff[1] },
    dynNotch: {
      enabled: isFeatureEnabled(sysConfig, "DYN_NOTCH"),
      count: num(sysConfig.dyn_notch_count),
      q: num(sysConfig.dyn_notch_q, 20),
      minHz: num(sysConfig.dyn_notch_min_hz, 20),
      maxHz: num(sysConfig.dyn_notch_max_hz, 200),
    },
    rpm,
  };
}

// Plain deep copy (also strips Vue reactive proxies, which structuredClone/postMessage reject)
export function cloneSettings(settings) {
  return JSON.parse(JSON.stringify(settings));
}

/**
 * The lowpass types are lookup settings in the Rotorflight CLI: it takes the name
 * (`set gyro_lpf1_type = FIRST_ORDER`) and rejects the number with "INVALID VALUE".
 */
export function lpfTypeCli(type) {
  return LPF_TYPE_NAMES[type] ?? String(type);
}

/** CLI lines for the settings, so the user can paste their imagined setup into the CLI. */
export function settingsToCli(s) {
  const lines = [
    `set gyro_lpf1_type = ${lpfTypeCli(s.lpf1.type)}`,
    `set gyro_lpf1_static_hz = ${s.lpf1.staticHz}`,
    `set gyro_lpf1_dyn_min_hz = ${s.lpf1.dynMinHz}`,
    `set gyro_lpf1_dyn_max_hz = ${s.lpf1.dynMaxHz}`,
    `set gyro_lpf2_type = ${lpfTypeCli(s.lpf2.type)}`,
    `set gyro_lpf2_static_hz = ${s.lpf2.staticHz}`,
    `set gyro_notch1_hz = ${s.notch1.hz}`,
    `set gyro_notch1_cutoff = ${s.notch1.cutoff}`,
    `set gyro_notch2_hz = ${s.notch2.hz}`,
    `set gyro_notch2_cutoff = ${s.notch2.cutoff}`,
    s.dynNotch.enabled ? "feature DYN_NOTCH" : "feature -DYN_NOTCH",
    `set dyn_notch_count = ${s.dynNotch.count}`,
    `set dyn_notch_q = ${s.dynNotch.q}`,
    `set dyn_notch_min_hz = ${s.dynNotch.minHz}`,
    `set dyn_notch_max_hz = ${s.dynNotch.maxHz}`,
    s.rpm.enabled ? "feature RPM_FILTER" : "feature -RPM_FILTER",
    `set gyro_rpm_notch_preset = ${s.rpm.preset}`,
    `set gyro_rpm_notch_min_hz = ${s.rpm.minHz}`,
  ];
  AXIS_NAMES.forEach((axis, i) => {
    lines.push(`set gyro_rpm_notch_source_${axis} = ${s.rpm.source[i].join(",")}`);
    lines.push(`set gyro_rpm_notch_center_${axis} = ${s.rpm.center[i].join(",")}`);
    lines.push(`set gyro_rpm_notch_q_${axis} = ${s.rpm.q[i].join(",")}`);
  });
  return lines.join("\n");
}

/**
 * Loop rates. The firmware runs the gyro at 1e6/looptime, the filters at gyro/filter_process_denom
 * (falling back to the PID denominator, see gyroSetLooptime) and the PID loop at
 * gyro/pid_process_denom. The log rate is measured from the frame timestamps.
 */
export function ratesFromSysConfig(sysConfig, measuredLogRateHz) {
  const looptime = num(sysConfig.looptime, 0);
  const gyroRateHz = looptime > 0 ? 1e6 / looptime : 0;
  const pidDenom = Math.max(1, num(sysConfig.pid_process_denom, 1));
  const filterDenomRaw = num(sysConfig.filter_process_denom, 0);
  const filterDenom = filterDenomRaw > 0 ? filterDenomRaw : pidDenom;
  const pidRateHz = gyroRateHz / pidDenom;
  const filterRateHz = gyroRateHz / filterDenom;

  const pNum = num(sysConfig.frameIntervalPNum, 1);
  const pDenom = num(sysConfig.frameIntervalPDenom, 1);
  const nominalLogRateHz = pidRateHz * (pNum / pDenom);

  // Prefer the configured rate unless the timestamps disagree by more than 2%
  let logRateHz = nominalLogRateHz;
  let logRateSource = "header";
  if (!(nominalLogRateHz > 0) || (measuredLogRateHz > 0 && Math.abs(nominalLogRateHz - measuredLogRateHz) / measuredLogRateHz > 0.02)) {
    logRateHz = measuredLogRateHz;
    logRateSource = "timestamps";
  }

  return {
    gyroRateHz,
    filterRateHz,
    pidRateHz,
    logRateHz,
    nominalLogRateHz,
    measuredLogRateHz,
    logRateSource,
    upsampleRatio: filterRateHz / logRateHz,
    decimationHz: num(sysConfig.gyro_decimation_hz, 0),
  };
}

/**
 * Rotor information for the RPM filter and dynamic LPF, from the craft config and the log fields.
 * The app's craft config ratios are "motor RPM per rotor RPM" (b/a of `main_rotor_gear_ratio`),
 * the firmware uses the inverse (a/b), see motors.c motorInit().
 */
export function rotorInfo({ craftSettings, hasCraftConfig, hasHeadspeed, hasTailspeed, motorisedTail }) {
  const settings = craftSettings ?? {};
  const notes = [];

  let mainGearRatio = null; // firmware: rotor per motor
  let tailGearRatio = null; // firmware
  let tailPerHead = null; // tail rotor RPM per main rotor RPM (mechanical tail)

  if (hasCraftConfig) {
    const appMain = settings.main_rotor_gear_ratio === undefined ? 1 : parseGearRatio(settings.main_rotor_gear_ratio);
    const appTail = settings.tail_rotor_gear_ratio === undefined ? 1 : parseGearRatio(settings.tail_rotor_gear_ratio);
    if (appMain) mainGearRatio = 1 / appMain;
    if (appTail) {
      if (motorisedTail) {
        tailGearRatio = 1 / appTail;
      } else if (mainGearRatio != null) {
        tailGearRatio = mainGearRatio * appTail;
        tailPerHead = appTail;
      }
    }
  } else {
    notes.push("No craft config loaded: main motor and tail notches need gear ratios.");
  }

  let tailSource = null;
  if (hasTailspeed) {
    tailSource = "tailspeed";
  } else if (!motorisedTail && tailPerHead != null) {
    tailSource = "headspeed × tail ratio";
  }

  const govMode = String(settings.gov_mode ?? "").toUpperCase();
  const governorActive = govMode === "ELECTRIC" || govMode === "NITRO" || Number(govMode) > 2;
  const fullHeadSpeed = num(settings.gov_headspeed, 0);

  if (!hasHeadspeed) {
    notes.push("The log has no headspeed field, so the RPM filter cannot track.");
  }

  return {
    mainGearRatio,
    tailGearRatio,
    tailPerHead,
    motorisedTail: !!motorisedTail,
    hasTailSpeed: tailSource != null,
    tailSource,
    hasHeadspeed: !!hasHeadspeed,
    governorActive,
    fullHeadSpeed,
    notes,
  };
}

/**
 * Compares the log's firmware with the version the filter port is based on.
 * @returns {{status:'match'|'approximate'|'unsupported', message:string, version:string}}
 */
export function checkFirmware(sysConfig) {
  const version = sysConfig.firmwareVersion ?? "0.0.0";
  if (sysConfig.firmwareType !== FIRMWARE_TYPE_ROTORFLIGHT) {
    return {
      status: "unsupported",
      version,
      message: "This log is not from Rotorflight. Imagine models the Rotorflight gyro filters only.",
    };
  }
  const coerced = semver.coerce(version)?.version ?? "0.0.0";
  if (semver.major(coerced) === 4 && semver.minor(coerced) === 6) {
    return {
      status: "match",
      version,
      message: `Rotorflight ${version} matches the ported filter code (${FIRMWARE_REFERENCE.branch}).`,
    };
  }
  return {
    status: "approximate",
    version,
    message: `Rotorflight ${version} differs from the ported ${FIRMWARE_REFERENCE.version} filter code, so results are approximate.`,
  };
}
