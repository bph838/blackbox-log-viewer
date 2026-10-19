// State for the Filter search view: options, the running search and its result.

import { defineStore } from "pinia";
import { computed, reactive, ref, shallowRef, watch } from "vue";
import { useImagineStore } from "../imagine_store.js";
import { diffSettings, changesToCli } from "../ai/filter_tool.js";
import { DIMENSIONS } from "./search_space.js";
import { runSearch, verifyNear as verifyNearInWorker, cancelSearch } from "./search_client.js";

const PREFS_KEY = "imagine.filterSearch";
export const DEFAULT_BOUNDARY_HZ = 20;

function readPrefs() {
  try {
    return JSON.parse(globalThis.localStorage?.getItem(PREFS_KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

/**
 * The setup to recommend: on the verified front, the one with the least delay whose noise is at
 * most the acceptable noise. When nothing is that quiet, the quietest one.
 */
export function recommend(front, acceptableNoise) {
  if (!front.length) return null;
  const ok = front.filter((p) => p.noiseRms <= acceptableNoise + 1e-9);
  if (ok.length) return ok.reduce((a, b) => (b.delayMs < a.delayMs ? b : a));
  return front.reduce((a, b) => (b.noiseRms < a.noiseRms ? b : a));
}

export const useFilterSearchStore = defineStore("imagineFilterSearch", () => {
  const imagine = useImagineStore();
  const prefs = readPrefs();

  const open = ref(false);
  const boundaryHz = ref(prefs.boundaryHz ?? DEFAULT_BOUNDARY_HZ);
  const cliTypes = ref(prefs.cliTypes ?? true);
  const vary = reactive(Object.fromEntries(DIMENSIONS.map((d) => [d, prefs.vary?.[d] ?? true])));
  const acceptableNoise = ref(null); // deg/s; null = the log's own settings' noise

  const running = ref(false);
  const progress = ref(null);
  const error = ref("");
  const result = shallowRef(null);
  const resultKey = ref(null);
  const selectedIndex = ref(null);

  function savePrefs() {
    try {
      globalThis.localStorage?.setItem(PREFS_KEY, JSON.stringify({ boundaryHz: boundaryHz.value, cliTypes: cliTypes.value, vary: { ...vary } }));
    } catch {
      // not remembered
    }
  }
  watch([boundaryHz, cliTypes, () => ({ ...vary })], savePrefs, { deep: true });

  // What a result was computed from; when it changes the result is out of date
  const inputKey = computed(() => {
    if (!imagine.data) return null;
    const r = imagine.range;
    return JSON.stringify([imagine.fileName, imagine.logIndex, r.start, r.end, imagine.craftFileName, boundaryHz.value, cliTypes.value, vary]);
  });
  const stale = computed(() => result.value !== null && resultKey.value !== inputKey.value);

  const byIndex = computed(() => new Map((result.value?.verified ?? []).map((v) => [v.index, v])));
  const front = computed(() => (result.value?.front ?? []).map((i) => byIndex.value.get(i)));
  const logPoint = computed(() => byIndex.value.get(result.value?.logIndex) ?? null);
  const acceptable = computed(() => acceptableNoise.value ?? logPoint.value?.noiseRms ?? 0);
  const recommended = computed(() => recommend(front.value, acceptable.value));
  const selected = computed(() => byIndex.value.get(selectedIndex.value) ?? recommended.value);

  function changesFor(point) {
    if (!point || !imagine.logSettings) return [];
    return diffSettings(imagine.logSettings, point.settings);
  }

  function cliFor(point) {
    return changesToCli(changesFor(point));
  }

  async function run() {
    if (!imagine.data || running.value) return;
    running.value = true;
    error.value = "";
    progress.value = { phase: "search", done: 0, total: 1, evaluated: 0 };
    const key = inputKey.value;
    try {
      const sim = imagine.simulationInput(imagine.logSettings);
      const input = {
        raw: sim.raw,
        headspeed: sim.headspeed,
        tailspeed: sim.tailspeed,
        rates: sim.rates,
        rotor: sim.rotor,
        settings: sim.settings,
        start: imagine.range.start,
        end: imagine.range.end,
        settleSamples: Math.round(imagine.rates.logRateHz),
        boundaryHz: boundaryHz.value,
        vary: { ...vary },
        cliTypes: cliTypes.value,
      };
      const r = await runSearch(input, (p) => (progress.value = p));
      result.value = r;
      resultKey.value = key;
      selectedIndex.value = null;
      acceptableNoise.value = null;
    } catch (e) {
      if (e.message !== "cancelled") error.value = e.message ?? String(e);
    } finally {
      running.value = false;
      progress.value = null;
    }
  }

  async function verifyMore() {
    if (!result.value || running.value || stale.value) return;
    running.value = true;
    error.value = "";
    try {
      result.value = await verifyNearInWorker(acceptable.value, 8, (p) => (progress.value = p));
    } catch (e) {
      if (e.message !== "cancelled") error.value = e.message ?? String(e);
    } finally {
      running.value = false;
      progress.value = null;
    }
  }

  function cancel() {
    cancelSearch();
  }

  function select(index) {
    selectedIndex.value = index;
  }

  /** Loads a setup into the Filters panel and runs Imagine on it, then shows the spectrum. */
  async function imagineSetup(point) {
    if (!point) return;
    imagine.applySettings(point.settings);
    open.value = false;
    await imagine.imagine();
  }

  return {
    open,
    boundaryHz,
    cliTypes,
    vary,
    acceptableNoise,
    acceptable,
    running,
    progress,
    error,
    result,
    stale,
    front,
    logPoint,
    recommended,
    selected,
    selectedIndex,
    changesFor,
    cliFor,
    run,
    verifyMore,
    cancel,
    select,
    imagineSetup,
  };
});
