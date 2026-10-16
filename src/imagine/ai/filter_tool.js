// The tool Claude uses to suggest filter settings in the AI Filters conversation, and the checks
// every suggestion goes through before it can be applied. Values are Rotorflight CLI names and
// CLI units (Q x10, RPM notch centre offsets x10000), the same as `diff all`.
//
// Ranges are the firmware's CLI limits (rotorflight-firmware RF-4.6.x src/main/cli/settings.c);
// where the Configurator offers a narrower range it is reported as a warning, not an error.

import { cloneSettings, lpfTypeCli } from "../header_settings.js";
import { RPM_FILTER_NOTCH_COUNT } from "../filters/rpm_filter.js";
import {
  axisArrays,
  axisLayout,
  describeBank,
  emptyBank,
  MAX_Q,
  MIN_Q,
  MULTI_NOTCH_SOURCE,
  notchCount,
  NOTCH_TYPE,
  RPM_SOURCE,
} from "../rpm_notch_layout.js";

export const FILTER_TOOL_NAME = "propose_filter_config";

const AXES = ["roll", "pitch", "yaw"];
const AXIS_INDEX = { roll: 0, pitch: 1, yaw: 2 };
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

const BANK_PARAM = /^gyro_rpm_notch_(source|center|q)_(roll|pitch|yaw)$/;
/**
 * Parameters Claude sets directly. RPM notch banks are not among them: Claude proposes those as
 * Configurator rows (rpm_notches), so a suggestion always fits the Configurator's RPM layout.
 */
export const TOOL_PARAM_NAMES = FILTER_PARAM_NAMES.filter((n) => !BANK_PARAM.test(n));

const TYPE_VALUE = { SINGLE: NOTCH_TYPE.SINGLE, DOUBLE: NOTCH_TYPE.DOUBLE, TRIPLE: NOTCH_TYPE.TRIPLE };

/** An axis's RPM notches in Configurator terms, for cards and summaries. */
export function describeAxisNotches(rpm, axis) {
  const layout = axisLayout(rpm, axis);
  return layout ? describeBank(layout) : "custom layout the Configurator can't show";
}

/** Tool definition for the Messages API (strict schema; validated again client-side). */
export const FILTER_TOOL = {
  name: FILTER_TOOL_NAME,
  description:
    "Propose a set of gyro filter setting changes for the user to review. The user sees them as a card " +
    "listing old -> new values and decides whether to apply them; nothing changes until they press Apply, " +
    "after which Imagine simulates the result and it may be sent back to you. Use Rotorflight CLI parameter " +
    "names and CLI units: Q values are x10 (25 means Q 2.5), RPM notch centre offsets are x10000, feature " +
    "toggles are feature_DYN_NOTCH / feature_RPM_FILTER with 1 = on and 0 = off. Every value in `changes` " +
    "is a list with one integer. RPM notches are not set through `changes`: put them in `rpm_notches`, one " +
    "entry per axis you change, listing every notch that axis should have afterwards (it replaces the axis), " +
    "as Rotorflight Configurator rows (source, SINGLE/DOUBLE/TRIPLE, Q). Leave `rpm_notches` empty when the " +
    "RPM notches don't change. Only list parameters you want to change. Custom RPM notches are only used " +
    "when gyro_rpm_notch_preset is 0.",
  strict: true,
  eager_input_streaming: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["name", "summary", "changes", "rpm_notches"],
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
            parameter: { type: "string", enum: TOOL_PARAM_NAMES },
            value: { type: "array", items: { type: "integer" } },
            reason: { type: "string", description: "Why, citing the peak or result it addresses." },
          },
        },
      },
      rpm_notches: {
        type: "array",
        description:
          "RPM filter notches per axis, as Configurator rows. Each entry replaces that axis's notches entirely. " +
          "Empty when the RPM notches don't change.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["axis", "notches", "reason"],
          properties: {
            axis: { type: "string", enum: AXES },
            notches: {
              type: "array",
              description:
                "Every notch for this axis. source: 10 main motor (geared main motor only), 11-18 main rotor " +
                "harmonic 1-8, 20 tail motor (motorised tail only), 21-24 tail rotor harmonic 1-4. type: DOUBLE " +
                "or TRIPLE only for sources 11, 12, 21, 22. q: 1.5-10 in steps of 0.1. At most 16 notches per " +
                "axis, counting DOUBLE as 2 and TRIPLE as 3.",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["source", "type", "q"],
                properties: {
                  source: { type: "integer", enum: RPM_SOURCE },
                  type: { type: "string", enum: ["SINGLE", "DOUBLE", "TRIPLE"] },
                  q: { type: "number" },
                },
              },
            },
            reason: { type: "string", description: "Why, citing the peaks it addresses." },
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
  const rpmList = Array.isArray(input.rpm_notches) ? input.rpm_notches : [];
  if (!list.length && !rpmList.length) errors.push("The proposal has no changes.");

  const seen = new Set();
  for (const change of list) {
    const name = change?.parameter;
    const def = FILTER_PARAMS[name];
    if (!def) {
      errors.push(`Unknown parameter "${name}".`);
      continue;
    }
    if (BANK_PARAM.test(name)) {
      errors.push(`${name} can't be set directly - give that axis's notches in rpm_notches instead.`);
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

  // RPM notches, as Configurator rows per axis
  const seenAxes = new Set();
  for (const entry of rpmList) {
    const axisName = entry?.axis;
    const a = AXIS_INDEX[axisName];
    if (a === undefined) {
      errors.push(`rpm_notches: unknown axis "${axisName}".`);
      continue;
    }
    if (seenAxes.has(axisName)) {
      errors.push(`rpm_notches: ${axisName} is listed more than once.`);
      continue;
    }
    seenAxes.add(axisName);
    const bank = emptyBank();
    let ok = true;
    for (const n of Array.isArray(entry.notches) ? entry.notches : []) {
      const label = `rpm_notches ${axisName} source ${n?.source}`;
      if (!RPM_SOURCE.includes(n?.source)) {
        errors.push(`${label}: not a Configurator RPM source (10-18 main motor/rotor, 20-24 tail motor/rotor).`);
        ok = false;
        continue;
      }
      if (bank[n.source].enabled) {
        errors.push(`${label}: listed more than once - one row per source, use DOUBLE/TRIPLE for wider notches.`);
        ok = false;
        continue;
      }
      const type = TYPE_VALUE[n.type];
      if (!type) {
        errors.push(`${label}: type must be SINGLE, DOUBLE or TRIPLE.`);
        ok = false;
        continue;
      }
      if (type > 1 && !MULTI_NOTCH_SOURCE.includes(n.source)) {
        errors.push(`${label}: ${n.type} is only available for main/tail rotor harmonic 1 and 2 (sources 11, 12, 21, 22).`);
        ok = false;
        continue;
      }
      const q = Math.round(Number(n.q) * 10) / 10;
      if (!Number.isFinite(q) || q < MIN_Q || q > MAX_Q) {
        errors.push(`${label}: Q ${n.q} is outside the Configurator's ${MIN_Q}-${MAX_Q} range.`);
        ok = false;
        continue;
      }
      bank[n.source] = { enabled: true, type, q };
    }
    const count = notchCount(bank);
    if (count > RPM_FILTER_NOTCH_COUNT) {
      errors.push(`rpm_notches ${axisName}: ${count} notches (DOUBLE counts 2, TRIPLE 3); the firmware has ${RPM_FILTER_NOTCH_COUNT}.`);
      ok = false;
    }
    if (!ok) continue;
    const oldArrays = { source: settings.rpm.source[a].slice(), center: settings.rpm.center[a].slice(), q: settings.rpm.q[a].slice() };
    const oldText = describeAxisNotches(settings.rpm, a);
    const arrays = axisArrays(bank);
    settings.rpm.source[a] = arrays.source;
    settings.rpm.center[a] = arrays.center;
    settings.rpm.q[a] = arrays.q;
    if (bank[10]?.enabled && !(rotor?.mainGearRatio && rotor.mainGearRatio !== 1)) {
      warnings.push(`${axisName}: the main motor notch only works with a geared main motor and a known main gear ratio.`);
    }
    changes.push({
      parameter: `rpm_notches_${axisName}`,
      axis: a,
      label: `RPM Notches · ${axisName[0].toUpperCase()}${axisName.slice(1)}`,
      old: oldArrays,
      new: arrays,
      oldText,
      newText: describeBank(bank),
      multiline: true,
      reason: String(entry.reason ?? ""),
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

  const rpmChanged = changes.some((c) => c.parameter.startsWith("rpm_notches_"));
  if (rpmChanged && s.rpm.preset !== 0) {
    warnings.push(`Custom RPM notches are ignored while gyro_rpm_notch_preset is ${s.rpm.preset}; set it to 0 to use them.`);
  }
  if (s.rpm.enabled && s.rpm.preset === 0) {
    const custom = AXES.filter((_, a) => !axisLayout(s.rpm, a));
    if (custom.length) {
      warnings.push(
        `The ${custom.join(", ")} RPM notches still use a custom layout the Configurator can't show; give ${custom.length > 1 ? "those axes" : "that axis"} in rpm_notches to replace it.`,
      );
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
    if (BANK_PARAM.test(name)) continue;
    const a = def.get(from);
    const b = def.get(to);
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      out.push({ parameter: name, label: def.label, old: a, new: b, oldText: display(def, a), newText: display(def, b), reason: "" });
    }
  }
  // RPM notch banks, one change per axis, described as Configurator rows
  AXES.forEach((axisName, a) => {
    const pick = (st) => ({ source: st.rpm.source[a].slice(0, 16), center: st.rpm.center[a].slice(0, 16), q: st.rpm.q[a].slice(0, 16) });
    const before = pick(from);
    const after = pick(to);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      out.push({
        parameter: `rpm_notches_${axisName}`,
        axis: a,
        label: `RPM Notches · ${axisName[0].toUpperCase()}${axisName.slice(1)}`,
        old: before,
        new: after,
        oldText: describeAxisNotches(from.rpm, a),
        newText: describeAxisNotches(to.rpm, a),
        multiline: true,
        reason: "",
      });
    }
  });
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
      if (c.parameter.startsWith("rpm_notches_")) {
        const axisName = c.parameter.slice("rpm_notches_".length);
        const pad = (v) => [...v, ...new Array(Math.max(0, 16 - v.length)).fill(0)].slice(0, 16).join(",");
        return [
          `set gyro_rpm_notch_source_${axisName} = ${pad(c.new.source)}`,
          `set gyro_rpm_notch_center_${axisName} = ${pad(c.new.center)}`,
          `set gyro_rpm_notch_q_${axisName} = ${pad(c.new.q)}`,
        ].join("\n");
      }
      if (c.parameter === "gyro_lpf1_type" || c.parameter === "gyro_lpf2_type") {
        return `set ${c.parameter} = ${lpfTypeCli(c.new)}`;
      }
      return `set ${c.parameter} = ${Array.isArray(c.new) ? c.new.join(",") : c.new}`;
    })
    .join("\n");
}
