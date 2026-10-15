// The tool Claude uses to suggest filter settings in the AI Filters conversation, and the checks
// every suggestion goes through before it can be applied. Values are Rotorflight CLI names and
// CLI units (Q x10, RPM notch centre offsets x10000), the same as `diff all`.
//
// Ranges are the firmware's CLI limits (rotorflight-firmware RF-4.6.x src/main/cli/settings.c);
// where the Configurator offers a narrower range it is reported as a warning, not an error.

import { cloneSettings, lpfTypeCli } from "../header_settings.js";
import { RPM_FILTER_NOTCH_COUNT } from "../filters/rpm_filter.js";

export const FILTER_TOOL_NAME = "propose_filter_config";

const AXES = ["roll", "pitch", "yaw"];
const AXIS_INDEX = { roll: 0, pitch: 1, yaw: 2 };
const RPM_SOURCES = new Set([0, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 21, 22, 23, 24, 25, 26, 27, 28]);
const LPF_TYPE_NAMES = ["NONE", "1st order", "2nd order", "PT1", "PT2", "PT3", "Order1", "Butter", "Bessel", "Damped"];

function scalar(label, unit, min, max, get, set, extra = {}) {
  return { kind: "scalar", label, unit, min, max, get, set, ...extra };
}

function bank(label, axis, field, min, max, extra = {}) {
  const a = AXIS_INDEX[axis];
  return {
    kind: "array",
    label,
    min,
    max,
    get: (s) => s.rpm[field][a].slice(0, RPM_FILTER_NOTCH_COUNT),
    set: (s, v) => {
      const padded = new Array(RPM_FILTER_NOTCH_COUNT).fill(0);
      v.slice(0, RPM_FILTER_NOTCH_COUNT).forEach((x, i) => {
        padded[i] = x;
      });
      s.rpm[field][a] = padded;
    },
    ...extra,
  };
}

/** Every parameter Claude may change, keyed by its Rotorflight CLI name. */
export const FILTER_PARAMS = {
  gyro_lpf1_type: scalar("Lowpass Filter 1 · Filter Type", "", 0, 9, (s) => s.lpf1.type, (s, v) => (s.lpf1.type = v), { names: LPF_TYPE_NAMES, cfgValues: [0, 1, 2] }),
  gyro_lpf1_static_hz: scalar("Lowpass Filter 1 · Cutoff Frequency", "Hz", 0, 1000, (s) => s.lpf1.staticHz, (s, v) => (s.lpf1.staticHz = v)),
  gyro_lpf1_dyn_min_hz: scalar("Lowpass Filter 1 · Min Cutoff Frequency", "Hz", 0, 1000, (s) => s.lpf1.dynMinHz, (s, v) => (s.lpf1.dynMinHz = v)),
  gyro_lpf1_dyn_max_hz: scalar("Lowpass Filter 1 · Max Cutoff Frequency", "Hz", 0, 1000, (s) => s.lpf1.dynMaxHz, (s, v) => (s.lpf1.dynMaxHz = v)),
  gyro_lpf2_type: scalar("Lowpass Filter 2 · Filter Type", "", 0, 9, (s) => s.lpf2.type, (s, v) => (s.lpf2.type = v), { names: LPF_TYPE_NAMES, cfgValues: [0, 1, 2] }),
  gyro_lpf2_static_hz: scalar("Lowpass Filter 2 · Cutoff Frequency", "Hz", 0, 1000, (s) => s.lpf2.staticHz, (s, v) => (s.lpf2.staticHz = v)),
  gyro_notch1_hz: scalar("Notch Filter 1 · Center Frequency", "Hz", 0, 1000, (s) => s.notch1.hz, (s, v) => (s.notch1.hz = v)),
  gyro_notch1_cutoff: scalar("Notch Filter 1 · Cutoff Frequency", "Hz", 0, 1000, (s) => s.notch1.cutoff, (s, v) => (s.notch1.cutoff = v)),
  gyro_notch2_hz: scalar("Notch Filter 2 · Center Frequency", "Hz", 0, 1000, (s) => s.notch2.hz, (s, v) => (s.notch2.hz = v)),
  gyro_notch2_cutoff: scalar("Notch Filter 2 · Cutoff Frequency", "Hz", 0, 1000, (s) => s.notch2.cutoff, (s, v) => (s.notch2.cutoff = v)),
  feature_DYN_NOTCH: scalar("Dynamic Filter · Enable", "", 0, 1, (s) => (s.dynNotch.enabled ? 1 : 0), (s, v) => (s.dynNotch.enabled = v === 1), { names: ["off", "on"] }),
  dyn_notch_count: scalar("Dynamic Filter · Notch Count", "", 0, 8, (s) => s.dynNotch.count, (s, v) => (s.dynNotch.count = v)),
  dyn_notch_q: scalar("Dynamic Filter · Notch Q", "x10", 10, 100, (s) => s.dynNotch.q, (s, v) => (s.dynNotch.q = v), { scale: 10 }),
  dyn_notch_min_hz: scalar("Dynamic Filter · Notch Minimum Frequency", "Hz", 10, 200, (s) => s.dynNotch.minHz, (s, v) => (s.dynNotch.minHz = v)),
  dyn_notch_max_hz: scalar("Dynamic Filter · Notch Maximum Frequency", "Hz", 100, 500, (s) => s.dynNotch.maxHz, (s, v) => (s.dynNotch.maxHz = v)),
  feature_RPM_FILTER: scalar("RPM Filter · Enable", "", 0, 1, (s) => (s.rpm.enabled ? 1 : 0), (s, v) => (s.rpm.enabled = v === 1), { names: ["off", "on"] }),
  gyro_rpm_notch_preset: scalar("RPM Filter · Strength", "", 0, 3, (s) => s.rpm.preset, (s, v) => (s.rpm.preset = v), { names: ["Custom", "Low", "Medium", "High"] }),
  gyro_rpm_notch_min_hz: scalar("RPM Filter · Minimum Frequency", "Hz", 1, 100, (s) => s.rpm.minHz, (s, v) => (s.rpm.minHz = v)),
};
for (const axis of AXES) {
  const name = axis[0].toUpperCase() + axis.slice(1);
  FILTER_PARAMS[`gyro_rpm_notch_source_${axis}`] = bank(`RPM Notches · ${name} sources`, axis, "source", 0, 28);
  FILTER_PARAMS[`gyro_rpm_notch_center_${axis}`] = bank(`RPM Notches · ${name} centre offsets (x10000)`, axis, "center", -32768, 32767);
  FILTER_PARAMS[`gyro_rpm_notch_q_${axis}`] = bank(`RPM Notches · ${name} Q (x10)`, axis, "q", 0, 255);
}

export const FILTER_PARAM_NAMES = Object.keys(FILTER_PARAMS);

/** Tool definition for the Messages API (strict schema; validated again client-side). */
export const FILTER_TOOL = {
  name: FILTER_TOOL_NAME,
  description:
    "Propose a set of gyro filter setting changes for the user to review. The user sees them as a card " +
    "listing old -> new values and decides whether to apply them; nothing changes until they press Apply, " +
    "after which Imagine simulates the result and it may be sent back to you. Use Rotorflight CLI parameter " +
    "names and CLI units: Q values are x10 (25 means Q 2.5), RPM notch centre offsets are x10000, feature " +
    "toggles are feature_DYN_NOTCH / feature_RPM_FILTER with 1 = on and 0 = off. Every value is a list of " +
    "integers: one element for a single setting; for gyro_rpm_notch_source_*/center_*/q_* the full bank for " +
    "that axis in slot order (up to 16, missing slots become 0). Only list parameters you want to change. " +
    "Custom RPM banks are only used when gyro_rpm_notch_preset is 0.",
  strict: true,
  eager_input_streaming: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["name", "summary", "changes"],
    properties: {
      name: { type: "string", description: "Short label for this config, e.g. 'Step 1: LPF1 to 70 Hz'." },
      summary: { type: "string", description: "One or two sentences on what this step does and why." },
      changes: {
        type: "array",
        description: "The parameters to change.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["parameter", "value", "reason"],
          properties: {
            parameter: { type: "string", enum: FILTER_PARAM_NAMES },
            value: { type: "array", items: { type: "integer" } },
            reason: { type: "string", description: "Why, citing the peak or result it addresses." },
          },
        },
      },
    },
  },
};

function display(def, value) {
  if (def.kind === "array") return value.join(",");
  if (def.names?.[value] !== undefined) return `${def.names[value]}${def.kind === "scalar" && def.names.length > 4 ? ` (${value})` : ""}`;
  if (def.scale) return (value / def.scale).toFixed(1);
  return `${value}${def.unit && def.unit !== "x10" ? ` ${def.unit}` : ""}`;
}

/**
 * Checks a proposal and applies it to a copy of `baseSettings`.
 * @param {object} input the tool_use input
 * @param {object} baseSettings Filters panel settings the proposal is relative to
 * @param {object} [rotor] rotor info, to warn about motor notches that can't be placed
 * @returns {{ok:boolean, errors:string[], warnings:string[], changes:Array, settings:object|null}}
 */
export function validateProposal(input, baseSettings, rotor = null) {
  const errors = [];
  const warnings = [];
  const changes = [];
  const settings = cloneSettings(baseSettings);

  if (!input || typeof input !== "object") {
    return { ok: false, errors: ["The proposal is empty."], warnings, changes, settings: null };
  }
  const list = Array.isArray(input.changes) ? input.changes : [];
  if (!list.length) errors.push("The proposal has no changes.");

  const seen = new Set();
  for (const change of list) {
    const name = change?.parameter;
    const def = FILTER_PARAMS[name];
    if (!def) {
      errors.push(`Unknown parameter "${name}".`);
      continue;
    }
    if (seen.has(name)) {
      errors.push(`${name} is listed more than once.`);
      continue;
    }
    seen.add(name);
    const value = Array.isArray(change.value) ? change.value : [change.value];
    if (!value.length || value.some((v) => !Number.isInteger(v))) {
      errors.push(`${name} must be whole numbers in CLI units (got ${JSON.stringify(change.value)}).`);
      continue;
    }
    if (def.kind === "scalar" && value.length !== 1) {
      errors.push(`${name} takes a single value (got ${value.length}).`);
      continue;
    }
    if (def.kind === "array" && value.length > RPM_FILTER_NOTCH_COUNT) {
      errors.push(`${name} has ${value.length} values; a bank has ${RPM_FILTER_NOTCH_COUNT} slots.`);
      continue;
    }
    const bad = value.filter((v) => v < def.min || v > def.max);
    if (bad.length) {
      errors.push(`${name} = ${bad.join(",")} is outside the firmware range ${def.min}–${def.max}.`);
      continue;
    }
    if (name.startsWith("gyro_rpm_notch_source_") && value.some((v) => !RPM_SOURCES.has(v))) {
      errors.push(`${name} has an invalid source; valid sources are 0 (off), 10–18 (main motor, main rotor x1–x8), 20–28 (tail motor, tail rotor x1–x8).`);
      continue;
    }
    const old = def.get(settings);
    def.set(settings, def.kind === "scalar" ? value[0] : value);
    const newValue = def.get(settings);
    changes.push({
      parameter: name,
      label: def.label,
      old,
      new: newValue,
      oldText: display(def, old),
      newText: display(def, newValue),
      reason: String(change.reason ?? ""),
    });
  }

  // Checks across parameters, on the resulting settings
  const s = settings;
  if (s.lpf1.type && s.lpf1.dynMinHz > 0 && s.lpf1.dynMaxHz < s.lpf1.dynMinHz) {
    errors.push(`gyro_lpf1_dyn_max_hz (${s.lpf1.dynMaxHz}) must not be below gyro_lpf1_dyn_min_hz (${s.lpf1.dynMinHz}).`);
  }
  for (const [key, n] of [["notch1", 1], ["notch2", 2]]) {
    if (s[key].hz > 0 && s[key].cutoff > 0 && s[key].cutoff >= s[key].hz) {
      errors.push(`gyro_notch${n}_cutoff (${s[key].cutoff}) must be below gyro_notch${n}_hz (${s[key].hz}), or the firmware disables the notch.`);
    }
    if ((s[key].hz > 0) !== (s[key].cutoff > 0)) {
      warnings.push(`Notch filter ${n} is off unless both gyro_notch${n}_hz and gyro_notch${n}_cutoff are set.`);
    }
  }
  if (s.dynNotch.enabled && s.dynNotch.maxHz <= s.dynNotch.minHz) {
    errors.push(`dyn_notch_max_hz (${s.dynNotch.maxHz}) must be above dyn_notch_min_hz (${s.dynNotch.minHz}).`);
  }
  for (const lpf of ["lpf1", "lpf2"]) {
    const type = s[lpf].type;
    if (type > 2 && changes.some((c) => c.parameter === `gyro_${lpf}_type`)) {
      warnings.push(`gyro_${lpf}_type ${LPF_TYPE_NAMES[type]} isn't offered by the Configurator (only 1st/2nd order); set it from the CLI.`);
    }
  }

  const bankChanged = changes.some((c) => c.parameter.startsWith("gyro_rpm_notch_source_") || c.parameter.startsWith("gyro_rpm_notch_center_") || c.parameter.startsWith("gyro_rpm_notch_q_"));
  if (bankChanged && s.rpm.preset !== 0) {
    warnings.push(`Custom RPM notch banks are ignored while gyro_rpm_notch_preset is ${s.rpm.preset}; set it to 0 to use them.`);
  }
  if (bankChanged) {
    for (let a = 0; a < 3; a++) {
      for (let i = 0; i < RPM_FILTER_NOTCH_COUNT; i++) {
        const src = s.rpm.source[a][i];
        const q = s.rpm.q[a][i];
        if ((src && !q) || (!src && q)) {
          warnings.push(`${AXES[a]} RPM slot ${i + 1} has ${src ? "a source but Q 0" : "a Q but no source"}, so the firmware ignores it.`);
        } else if (src && (q < 15 || q > 100)) {
          warnings.push(`${AXES[a]} RPM slot ${i + 1} Q ${(q / 10).toFixed(1)} is outside the Configurator's 1.5–10 range (the firmware accepts 1.0–25.0).`);
        }
        if (src === 10 && !(rotor?.mainGearRatio && rotor.mainGearRatio !== 1)) {
          warnings.push(`${AXES[a]} RPM slot ${i + 1} (main motor) only works with a geared main motor and a known main gear ratio.`);
        }
      }
    }
  }
  if (changes.some((c) => c.parameter === "gyro_rpm_notch_preset") && s.rpm.preset > 0) {
    warnings.push("A preset replaces all custom RPM notches.");
  }

  return { ok: errors.length === 0, errors, warnings, changes, settings: errors.length ? null : settings };
}

/** The tool_result text sent back to Claude for a proposal. */
export function toolResultText(validation) {
  if (!validation.ok) {
    return (
      `The proposal was rejected and was NOT shown as applicable. Fix these and propose again:\n${ 
      validation.errors.map((e) => `- ${e}`).join("\n")}`
    );
  }
  let text =
    "Shown to the user as a card with an Apply button; nothing has been applied yet. If they apply it, " +
    "Imagine will simulate it and the result may be sent to you.";
  if (validation.warnings.length) {
    text += `\nWarnings shown with it:\n${validation.warnings.map((w) => `- ${w}`).join("\n")}`;
  }
  return text;
}

/** Changes between two settings snapshots, in the same shape as validateProposal's changes. */
export function diffSettings(from, to) {
  const out = [];
  for (const [name, def] of Object.entries(FILTER_PARAMS)) {
    const a = def.get(from);
    const b = def.get(to);
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      out.push({ parameter: name, label: def.label, old: a, new: b, oldText: display(def, a), newText: display(def, b), reason: "" });
    }
  }
  return out;
}

/** `set ...` lines for just the given changes (feature toggles as `feature [-]NAME`). */
export function changesToCli(changes) {
  return changes
    .map((c) => {
      if (c.parameter.startsWith("feature_")) {
        const feature = c.parameter.slice("feature_".length);
        return c.new ? `feature ${feature}` : `feature -${feature}`;
      }
      if (c.parameter === "gyro_lpf1_type" || c.parameter === "gyro_lpf2_type") {
        return `set ${c.parameter} = ${lpfTypeCli(c.new)}`;
      }
      return `set ${c.parameter} = ${Array.isArray(c.new) ? c.new.join(",") : c.new}`;
    })
    .join("\n");
}
