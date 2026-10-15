// State and actions for the Imagine page.

import { defineStore } from "pinia";
import { computed, reactive, ref, shallowRef } from "vue";
import { FlightLog } from "../flightlog.js";
import { useCraftConfigStore } from "../stores/craftConfig.js";
import { extractLogData, sampleRange } from "./log_data.js";
import {
  checkFirmware,
  cloneSettings,
  ratesFromSysConfig,
  rotorInfo,
  settingsFromSysConfig,
} from "./header_settings.js";
import { runSimulation } from "./sim_client.js";
import { compareAxis, compareDynNotchTracking, median } from "./analysis.js";
import { chainResponse, DELAY_FREQUENCIES } from "./response.js";

export const AXIS_NAMES = ["Roll", "Pitch", "Yaw"];

function settingsEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export const useImagineStore = defineStore("imagine", () => {
  const craftConfigStore = useCraftConfigStore();

  const status = ref("waiting"); // waiting | loading | ready | error
  const statusMessage = ref("");
  const fileName = ref(null);
  const logIndex = ref(0);
  const logCount = ref(0);
  const timeRange = ref({ in: null, out: null });

  const flightLog = shallowRef(null);
  const bytes = shallowRef(null);
  const sysConfig = shallowRef(null);
  const data = shallowRef(null);
  const rates = shallowRef(null);
  const firmware = shallowRef(null);
  const logSettings = shallowRef(null);
  const settings = reactive({});
  const craft = shallowRef(null); // {fileName, settings} snapshot
  const axis = ref(0);

  // Which filters are drawn on the chart (lowpass cutoffs, static notches, dynamic notch).
  // Everything is shown each time Imagine opens.
  const chartOverlays = reactive({ lowpass: true, notch: true, dynNotch: true });
  function setChartOverlay(name, on) {
    chartOverlays[name] = on;
  }

  const running = ref(false);
  const imagined = shallowRef(null); // simulation result for the imagined settings
  const imaginedSettings = shallowRef(null); // settings the imagined result was made with
  const reproduced = shallowRef(null); // simulation result with the log's own settings
  const validation = shallowRef(null);
  const delays = shallowRef(null);

  const hasLog = computed(() => data.value !== null);
  const settingsDirty = computed(
    () => imaginedSettings.value !== null && !settingsEqual(imaginedSettings.value, settings),
  );
  const range = computed(() => {
    if (!data.value) return { start: 0, end: 0 };
    return sampleRange(data.value.time, timeRange.value.in, timeRange.value.out);
  });

  const craftSettings = computed(() => craft.value?.settings ?? (craftConfigStore.hasConfig ? craftConfigStore.settings : null));
  const craftFileName = computed(() => craft.value?.fileName ?? (craftConfigStore.hasConfig ? craftConfigStore.fileName : null));

  const rotor = computed(() => {
    if (!data.value) return null;
    return rotorInfo({
      craftSettings: craftSettings.value,
      hasCraftConfig: !!craftSettings.value,
      hasHeadspeed: data.value.hasHeadspeed,
      hasTailspeed: data.value.hasTailspeed,
      motorisedTail: data.value.motorisedTail,
    });
  });

  // Median rotor speeds while spinning, over the analysed range
  const rotorSpeeds = computed(() => {
    const d = data.value;
    if (!d || !d.hasHeadspeed) return { head: null, tail: null };
    const { start, end } = range.value;
    const heads = [];
    const tails = [];
    for (let i = start; i < end; i++) {
      if (d.headspeed[i] > 100) {
        heads.push(d.headspeed[i]);
        if (d.tailspeed) tails.push(d.tailspeed[i]);
      }
    }
    if (!heads.length) return { head: null, tail: null };
    const head = median(heads);
    let tail = d.tailspeed ? median(tails) : null;
    if (tail == null && rotor.value?.tailPerHead != null) tail = head * rotor.value.tailPerHead;
    return { head, tail };
  });

  function setSettings(newSettings) {
    for (const key of Object.keys(settings)) delete settings[key];
    Object.assign(settings, cloneSettings(newSettings));
  }

  function resetSettings() {
    if (logSettings.value) setSettings(logSettings.value);
  }

  function fail(message) {
    status.value = "error";
    statusMessage.value = message;
  }

  /** Accepts the payload from the main window, or a file opened in Imagine. */
  function loadBytes(arrayBuffer, options = {}) {
    status.value = "loading";
    statusMessage.value = "Parsing log…";
    try {
      bytes.value = new Uint8Array(arrayBuffer);
      const log = new FlightLog(bytes.value);
      flightLog.value = log;
      fileName.value = options.fileName ?? "log";
      logCount.value = log.getLogCount();
      timeRange.value = options.timeRange ?? { in: null, out: null };
      craft.value = options.craft ?? null;
      openSubLog(options.logIndex ?? 0, true);
    } catch (error) {
      fail(`Could not open this log: ${error.message ?? error}`);
    }
  }

  function openSubLog(index, keepRange = false) {
    const log = flightLog.value;
    if (!log) return;
    if (!keepRange) timeRange.value = { in: null, out: null };
    if (!log.openLog(index)) {
      // fall back to the first readable sub-log
      let ok = false;
      for (let i = 0; i < log.getLogCount(); i++) {
        if (log.openLog(i)) {
          index = i;
          ok = true;
          break;
        }
      }
      if (!ok) {
        fail(log.getLogError?.(index) ?? "No readable flight log in this file.");
        return;
      }
    }
    logIndex.value = index;
    try {
      const sc = log.getSysConfig();
      const d = extractLogData(log);
      sysConfig.value = sc;
      data.value = d;
      rates.value = ratesFromSysConfig(sc, d.measuredLogRateHz);
      firmware.value = checkFirmware(sc);
      logSettings.value = settingsFromSysConfig(sc);
      setSettings(logSettings.value);
      imagined.value = null;
      imaginedSettings.value = null;
      reproduced.value = null;
      validation.value = null;
      delays.value = null;
      status.value = "ready";
      statusMessage.value = "";
      if (!(rates.value.filterRateHz > 0) || !(rates.value.logRateHz > 0)) {
        fail("The log header has no loop time, so the firmware filter rate is unknown.");
      }
    } catch (error) {
      fail(error.message ?? String(error));
    }
  }

  function simulationInput(forSettings) {
    const d = data.value;
    const r = rotor.value;
    let tailspeed = d.tailspeed;
    if (!tailspeed && r.tailPerHead != null) {
      tailspeed = d.headspeed.map((h) => h * r.tailPerHead);
    }
    return {
      raw: d.raw,
      headspeed: d.headspeed,
      tailspeed,
      rates: { logRateHz: rates.value.logRateHz, filterRateHz: rates.value.filterRateHz, pidRateHz: rates.value.pidRateHz },
      settings: cloneSettings(forSettings),
      rotor: { ...r, notes: undefined },
      record: { dynNotch: true },
    };
  }

  function operatingPoint(result) {
    const d = data.value;
    const { start, end } = range.value;
    const spinning = [];
    const tails = [];
    for (let i = start; i < end; i++) {
      if (d.headspeed[i] > 100) {
        spinning.push(d.headspeed[i]);
        if (d.tailspeed) tails.push(d.tailspeed[i]);
      }
    }
    const headRpm = median(spinning);
    let tailRpm = d.tailspeed ? median(tails) : 0;
    if (!d.tailspeed && rotor.value.tailPerHead != null) tailRpm = headRpm * rotor.value.tailPerHead;

    let dynNotchCenters = null;
    if (result?.dynNotchCenters && result.dynNotchCount) {
      const c = result.dynNotchCount;
      dynNotchCenters = [0, 1, 2].map((a) => {
        const out = [];
        for (let p = 0; p < c; p++) {
          const values = [];
          for (let i = start; i < end; i++) values.push(result.dynNotchCenters[i * 3 * c + a * c + p]);
          out.push(median(values));
        }
        return out;
      });
    }
    return { headRpm, tailRpm, dynNotchCenters };
  }

  function computeDelays() {
    if (!data.value) return;
    const base = { rates: rates.value, rotor: rotor.value };
    const logPoint = operatingPoint(reproduced.value);
    const imaginedPoint = operatingPoint(imagined.value);
    delays.value = {
      frequencies: DELAY_FREQUENCIES,
      operatingPoint: imaginedPoint,
      axes: [0, 1, 2].map((a) => ({
        log: chainResponse({ ...base, settings: logSettings.value, axis: a, operatingPoint: logPoint }),
        imagined: chainResponse({ ...base, settings: imaginedSettings.value ?? settings, axis: a, operatingPoint: imaginedPoint }),
      })),
    };
  }

  function computeValidation() {
    const d = data.value;
    if (!d.logged || !reproduced.value) {
      validation.value = null;
      return;
    }
    // skip the first second so filter start-up transients don't count
    const settle = Math.round(rates.value.logRateHz);
    const start = Math.max(range.value.start, settle);
    const end = range.value.end;
    if (end - start < 1024) {
      validation.value = null;
      return;
    }
    validation.value = {
      axes: [0, 1, 2].map((a) =>
        compareAxis({
          unfiltered: d.raw[a],
          simulated: reproduced.value.filtered[a],
          logged: d.logged[a],
          start,
          end,
          rateHz: rates.value.logRateHz,
        }),
      ),
      dynNotchTracking: compareDynNotchTracking({
        debug: d.dynNotchDebug,
        centers: reproduced.value.dynNotchCenters,
        count: reproduced.value.dynNotchCount,
        start,
        end,
      }),
    };
  }

  async function imagine() {
    if (!data.value || running.value) return;
    running.value = true;
    statusMessage.value = "Simulating…";
    try {
      const snapshot = cloneSettings(settings);
      if (!reproduced.value) {
        reproduced.value = await runSimulation(simulationInput(logSettings.value));
        computeValidation();
      }
      imagined.value = settingsEqual(snapshot, logSettings.value)
        ? reproduced.value
        : await runSimulation(simulationInput(snapshot));
      imaginedSettings.value = snapshot;
      computeDelays();
      statusMessage.value = "";
    } catch (error) {
      statusMessage.value = `Simulation failed: ${error.message ?? error}`;
    } finally {
      running.value = false;
    }
  }

  /** Craft config changed (loaded in this tab) - rotor info changes, results must be redone. */
  function invalidateResults() {
    reproduced.value = null;
    imagined.value = null;
    imaginedSettings.value = null;
    validation.value = null;
    delays.value = null;
  }

  function setTimeRange(inUs, outUs) {
    timeRange.value = { in: inUs, out: outUs };
    if (reproduced.value) {
      computeValidation();
      computeDelays();
    }
  }

  return {
    status,
    statusMessage,
    fileName,
    logIndex,
    logCount,
    timeRange,
    flightLog,
    sysConfig,
    data,
    rates,
    firmware,
    logSettings,
    settings,
    craft,
    craftFileName,
    craftSettings,
    rotor,
    rotorSpeeds,
    axis,
    chartOverlays,
    setChartOverlay,
    running,
    imagined,
    imaginedSettings,
    reproduced,
    validation,
    delays,
    hasLog,
    settingsDirty,
    range,
    loadBytes,
    openSubLog,
    resetSettings,
    imagine,
    invalidateResults,
    setTimeRange,
    fail,
  };
});
