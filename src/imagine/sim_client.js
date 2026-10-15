// Promise wrapper around the simulation worker, with an in-page fallback.
import { simulateGyroFilters } from "./simulate.js";

let worker = null;
let nextId = 1;
const pending = new Map();

function getWorker() {
  if (worker === null) {
    try {
      worker = new Worker(new URL("./sim.worker.js", import.meta.url), { type: "module" });
      worker.onmessage = (event) => {
        const { id, result, error } = event.data;
        const p = pending.get(id);
        if (!p) return;
        pending.delete(id);
        if (error) p.reject(new Error(error));
        else p.resolve(result);
      };
      worker.onerror = () => {
        worker = false;
      };
    } catch {
      worker = false;
    }
  }
  return worker || null;
}

/** Simulate in the worker. Input arrays are copied, the caller keeps its own. */
export function runSimulation(input) {
  const w = getWorker();
  if (!w) {
    return Promise.resolve(simulateGyroFilters(input));
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, input });
  });
}
