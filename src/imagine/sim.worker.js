// Runs the filter simulation off the UI thread.
import { simulateGyroFilters } from "./simulate.js";

self.onmessage = (event) => {
  const { id, input } = event.data;
  try {
    const result = simulateGyroFilters(input);
    const transfer = result.filtered.map((a) => a.buffer);
    if (result.dynNotchCenters) transfer.push(result.dynNotchCenters.buffer);
    self.postMessage({ id, result }, transfer);
  } catch (error) {
    self.postMessage({ id, error: String(error?.message ?? error) });
  }
};
