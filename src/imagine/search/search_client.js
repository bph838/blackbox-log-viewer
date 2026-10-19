// Promise wrapper around the filter search worker, with an in-page fallback.
import { FilterSearch } from "./search.js";

let worker = null;
let nextId = 1;
const pending = new Map();
let inPage = null; // the last search when workers aren't available

function getWorker() {
  if (worker === null) {
    try {
      worker = new Worker(new URL("./search.worker.js", import.meta.url), { type: "module" });
      worker.onmessage = (event) => {
        const { id, result, error, progress } = event.data;
        const p = pending.get(id);
        if (!p) return;
        if (progress) {
          p.onProgress?.(progress);
          return;
        }
        pending.delete(id);
        if (error) p.reject(new Error(error));
        else p.resolve(result);
      };
      worker.onerror = (event) => {
        for (const p of pending.values()) p.reject(new Error(event.message || "The search worker failed."));
        pending.clear();
        worker = false;
      };
    } catch {
      worker = false;
    }
  }
  return worker || null;
}

function request(message, onProgress) {
  const w = getWorker();
  if (!w) {
    return new Promise((resolve, reject) => {
      try {
        if (message.type === "search") {
          inPage = new FilterSearch(message.input);
          resolve(inPage.run(onProgress));
        } else {
          if (!inPage) throw new Error("No search to add to. Run the search again.");
          resolve(inPage.verifyNear(message.noiseRms, message.count, onProgress));
        }
      } catch (error) {
        reject(error);
      }
    });
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    w.postMessage({ id, ...message });
  });
}

/** Runs a new search. Input arrays are copied, the caller keeps its own. */
export function runSearch(input, onProgress) {
  return request({ type: "search", input }, onProgress);
}

/** Verifies more setups of the last search near a noise level (deg/s). */
export function verifyNear(noiseRms, count, onProgress) {
  return request({ type: "verifyNear", noiseRms, count }, onProgress);
}

/** Stops whatever the worker is doing. The next request starts a fresh worker. */
export function cancelSearch() {
  if (worker) worker.terminate();
  worker = null;
  for (const p of pending.values()) p.reject(new Error("cancelled"));
  pending.clear();
}
