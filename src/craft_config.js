// Parses a Rotorflight CLI "dump all" / "diff all" export ("craft config"), independent of how
// the result gets stored/persisted (see stores/craftConfig.js for that).
// Ported from https://github.com/rotorflight/rotorflight-blackbox (js/craft_config.js).

export function emptyParsedCraftConfig() {
  return { craftName: null, settings: {}, commands: {}, lines: [] };
}

/**
 * Parses a `<a>,<b>` gear ratio setting value (e.g. "15,137") into the multiplier b/a,
 * or null if the value is missing or not in that format.
 */
export function parseGearRatio(rawValue) {
  if (!rawValue) {
    return null;
  }

  const parts = rawValue.split(",");
  if (parts.length !== 2) {
    return null;
  }

  const a = Number.parseFloat(parts[0]);
  const b = Number.parseFloat(parts[1]);

  if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) {
    return null;
  }

  return b / a;
}

/**
 * Rotorflight's firmware defaults both main_rotor_gear_ratio and tail_rotor_gear_ratio to a
 * direct-drive 1:1 (see motorConfig_t in the firmware). `diff all` (unlike `dump all`) only
 * prints settings that differ from their default, so a craft dump with no line for a ratio is a
 * valid, complete config - it just means that ratio is still 1:1 - not that the ratio is unknown.
 * Resolve a missing setting to that same 1:1 default rather than treating it as missing data.
 */
export function resolveConfiguredGearRatio(rawValue) {
  return rawValue === undefined ? 1 : parseGearRatio(rawValue);
}

/**
 * Applies the all-or-nothing gear-ratio gate: both the main and tail rotor gear ratios must be
 * present/parseable numbers, or neither computed field (motorSpeed/tailSpeed) is produced.
 */
export function resolveGearRatios(mainRotorGearRatio, tailRotorGearRatio) {
  if (!Number.isFinite(mainRotorGearRatio) || !Number.isFinite(tailRotorGearRatio)) {
    return null;
  }

  return { main: mainRotorGearRatio, tail: tailRotorGearRatio };
}

/**
 * Parses the text of a Rotorflight/Betaflight CLI "dump all" or "diff all" export.
 *
 * `set key = value` lines populate `settings` (keyed lowercase). Every other bare CLI command
 * (name, mixer_type, feature, aux, mmix, smix, ...) is grouped by command name into `commands`,
 * since a fixed schema can't anticipate every field a future feature might need.
 */
export function parseCraftConfigText(text) {
  const lines = text.split("\n").map((line) => line.replace(/\r$/, ""));

  const settings = {};
  const commands = {};
  let craftName = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line || line.charAt(0) === "#") {
      continue;
    }

    const setMatch = line.match(/^set\s+([\w.-]+)\s*=\s*(.+)$/i);
    if (setMatch) {
      const setKey = setMatch[1].toLowerCase();
      const setValue = setMatch[2].trim();
      settings[setKey] = setValue;

      if (setKey === "name" && setValue) {
        craftName = setValue.replace(/^"(.*)"$/, "$1");
      }

      continue;
    }

    const spaceIndex = line.search(/\s/);
    const cmd = (spaceIndex === -1 ? line : line.substring(0, spaceIndex)).toLowerCase();
    const args = spaceIndex === -1 ? "" : line.substring(spaceIndex + 1).trim();

    if (!commands[cmd]) {
      commands[cmd] = [];
    }
    commands[cmd].push(args);

    if (cmd === "name" && args) {
      craftName = args.replace(/^"(.*)"$/, "$1");
    }
  }

  return { craftName, settings, commands, lines };
}
