// Runs the filter search off the UI thread. The last search stays in the worker, so more of its
// setups can be verified later without searching again.
import { FilterSearch } from "./search.js";

let current = null;

function transferables(result) {
  return [result.cloud.delayMs.buffer, result.cloud.noiseRms.buffer, result.cloud.feasible.buffer];
}

self.onmessage = (event) => {
  const { id, type } = event.data;
  const progress = (p) => self.postMessage({ id, progress: p });
  try {
    let result;
    if (type === "search") {
      current = new FilterSearch(event.data.input);
      result = current.run(progress);
    } else if (type === "verifyNear") {
      if (!current) throw new Error("No search to add to. Run the search again.");
      result = current.verifyNear(event.data.noiseRms, event.data.count, progress);
    } else {
      throw new Error(`Unknown request ${type}`);
    }
    self.postMessage({ id, result }, transferables(result));
  } catch (error) {
    self.postMessage({ id, error: String(error?.message ?? error) });
  }
};
