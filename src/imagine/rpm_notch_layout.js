// The Rotorflight Configurator's way of presenting RPM filter notches (src/tabs/gyro/filter_config.js
// parseRpmFilterConfig2 / generateRpmFilterConfig2 in rotorflight-configurator).
//
// Per axis, every RPM source gets one row: enabled, a notch type (single / double / triple, only for
// the 1st and 2nd harmonics) and one Q. Double and triple notches are expanded into side notches at
// a fixed offset that depends on Q. Bank layouts the Configurator can't show (mixed Q values, Q
// outside 1.5..10, unusual offsets) are reported as not representable; Imagine then falls back to
// its list editor, like the Configurator's "custom configuration in use" note.

export const RPM_NOTCH_COUNT = 16;
export const MAIN_ROTOR_SOURCE = [10, 11, 12, 13, 14, 15, 16, 17, 18];
export const TAIL_ROTOR_SOURCE = [20, 21, 22, 23, 24];
export const RPM_SOURCE = [...MAIN_ROTOR_SOURCE, ...TAIL_ROTOR_SOURCE];
export const MULTI_NOTCH_SOURCE = [11, 12, 21, 22];
export const NOTCH_TYPE = Object.freeze({ SINGLE: 1, DOUBLE: 2, TRIPLE: 3 });
export const DEFAULT_Q = 2.5;
export const MIN_Q = 1.5; // display units (CLI value / 10)
export const MAX_Q = 10;
const DOUBLE_NOTCH_OFFSET = 1; // %
const TRIPLE_NOTCH_OFFSET = 2; // %

export function doubleCenter(q) {
  return Math.trunc((100 * DOUBLE_NOTCH_OFFSET) / q);
}

export function tripleCenter(q) {
  return Math.trunc((100 * TRIPLE_NOTCH_OFFSET) / q);
}

function emptyRow() {
  return { enabled: false, type: NOTCH_TYPE.SINGLE, q: DEFAULT_Q };
}

function fillDisabled(bank) {
  for (const source of RPM_SOURCE) {
    if (!bank[source]) bank[source] = emptyRow();
  }
  return bank;
}

/** Notches one row expands to (single 1, double 2, triple 3), for the 16 notch limit. */
export function notchCount(bank) {
  let count = 0;
  for (const row of Object.values(bank)) {
    if (row.enabled) count += row.type;
  }
  return count;
}

/**
 * Configurator parseRpmFilterConfig2: CLI arrays [axis][slot] -> rows per source, or null when the
 * Configurator could not show this configuration.
 * @param {{source:number[][], center:number[][], q:number[][]}} rpm
 */
export function parseRpmLayout(rpm) {
  const banks = [];
  for (let axis = 0; axis < 3; axis++) {
    const bank = {};
    const sources = rpm.source[axis] ?? [];
    const centers = rpm.center[axis] ?? [];
    const qs = rpm.q[axis] ?? [];

    for (let i = 0; i < sources.length; i++) {
      const source = sources[i];
      const qRaw = qs[i];
      if (!source) continue;
      if (bank[source]) return null; // duplicate source
      if (!RPM_SOURCE.includes(source)) return null;
      if (qRaw < MIN_Q * 10 || qRaw > MAX_Q * 10) return null;

      const group = [];
      for (let j = i; j < sources.length; j++) {
        if (sources[j] === source && qs[j] === qRaw) group.push(centers[j] ?? 0);
        else break;
      }
      const q = qRaw / 10;

      if (group.length === 1) {
        if (group[0] !== 0) return null;
        bank[source] = { enabled: true, type: NOTCH_TYPE.SINGLE, q };
      } else if (group.length === 2) {
        if (!MULTI_NOTCH_SOURCE.includes(source)) return null;
        if (Math.abs(group[0]) !== doubleCenter(q) || group[0] !== -group[1]) return null;
        bank[source] = { enabled: true, type: NOTCH_TYPE.DOUBLE, q };
      } else if (group.length === 3) {
        if (!MULTI_NOTCH_SOURCE.includes(source)) return null;
        const c = tripleCenter(q);
        if (!group.includes(0) || !group.includes(c) || !group.includes(-c)) return null;
        bank[source] = { enabled: true, type: NOTCH_TYPE.TRIPLE, q };
      } else {
        return null;
      }
      i += group.length - 1;
    }
    banks.push(fillDisabled(bank));
  }
  return banks;
}

/**
 * Configurator generateRpmFilterConfig2: rows per source -> CLI arrays [axis][16].
 * Rows are written in source order (motor, main rotor, tail rotor), as the Configurator does.
 */
export function generateRpmLayout(banks) {
  const out = { source: [], center: [], q: [] };
  for (const bank of banks) {
    const source = [];
    const center = [];
    const q = [];
    const push = (s, c, qv) => {
      source.push(s);
      center.push(c);
      q.push(Math.round(qv * 10));
    };
    for (const s of RPM_SOURCE) {
      const row = bank[s];
      if (!row?.enabled) continue;
      if (row.type === NOTCH_TYPE.DOUBLE) {
        const c = doubleCenter(row.q);
        push(s, c, row.q);
        push(s, -c, row.q);
      } else if (row.type === NOTCH_TYPE.TRIPLE) {
        const c = tripleCenter(row.q);
        push(s, 0, row.q);
        push(s, -c, row.q);
        push(s, c, row.q);
      } else {
        push(s, 0, row.q);
      }
    }
    // the firmware has 16 slots; anything beyond is dropped (the UI warns before that happens)
    while (source.length < RPM_NOTCH_COUNT) {
      source.push(0);
      center.push(0);
      q.push(0);
    }
    out.source.push(source.slice(0, RPM_NOTCH_COUNT));
    out.center.push(center.slice(0, RPM_NOTCH_COUNT));
    out.q.push(q.slice(0, RPM_NOTCH_COUNT));
  }
  return out;
}

/**
 * Best effort conversion of any bank layout into the Configurator's rows: one row per source,
 * notch count -> type (sources that can't be double/triple become single), Q = the median Q of the
 * source's notches clamped to 1.5..10. Sources the Configurator has no row for are dropped.
 * Returns {banks, changed} where changed says whether the conversion altered the filter.
 */
export function convertToLayout(rpm) {
  const banks = [];
  for (let axis = 0; axis < 3; axis++) {
    const groups = new Map();
    const sources = rpm.source[axis] ?? [];
    sources.forEach((s, i) => {
      if (!s || !rpm.q[axis]?.[i]) return;
      if (!groups.has(s)) groups.set(s, []);
      groups.get(s).push(rpm.q[axis][i] / 10);
    });
    const bank = {};
    for (const [s, qs] of groups) {
      if (!RPM_SOURCE.includes(s)) continue;
      const sorted = [...qs].sort((a, b) => a - b);
      const q = Math.min(MAX_Q, Math.max(MIN_Q, sorted[Math.floor(sorted.length / 2)]));
      let type = Math.min(qs.length, 3);
      if (!MULTI_NOTCH_SOURCE.includes(s)) type = NOTCH_TYPE.SINGLE;
      bank[s] = { enabled: true, type, q: Math.round(q * 10) / 10 };
    }
    banks.push(fillDisabled(bank));
  }
  // a layout the Configurator can show converts without change; anything else is approximated
  return { banks, changed: parseRpmLayout(rpm) === null };
}
