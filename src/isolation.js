import pinia from "./pinia_instance.js";
import { usePlaybackStore } from "./stores/playback.js";
import { useGraphStore } from "./stores/graph.js";

/**
 * Isolated block: a finer-grained selection (Ctrl+I / Ctrl+O) that sits inside the
 * trimmed log range (I / O). Intended as the slice of the log that gets handed to
 * downstream consumers such as the AI tuning analysis.
 */

/**
 * Clamp a time to the trimmed range [trimIn, trimOut], where either bound may be false/null
 * (meaning "no trim on that side").
 */
export function clampToTrim(time, trimIn, trimOut) {
  if (trimIn != null && trimIn !== false && time < trimIn) {
    return trimIn;
  }
  if (trimOut != null && trimOut !== false && time > trimOut) {
    return trimOut;
  }
  return time;
}

/**
 * Resolve the effective isolated block from the raw isolate points, constrained to the trim range
 * and the log bounds. Returns { start, end } in blackbox microseconds, or null when no isolate point
 * is set or the block is empty.
 */
export function resolveIsolatedRange({ isolateIn, isolateOut, trimIn, trimOut, minTime, maxTime }) {
  const hasIn = isolateIn != null && isolateIn !== false;
  const hasOut = isolateOut != null && isolateOut !== false;
  if (!hasIn && !hasOut) {
    return null;
  }

  const lower = trimIn != null && trimIn !== false ? trimIn : minTime;
  const upper = trimOut != null && trimOut !== false ? trimOut : maxTime;

  const start = Math.max(hasIn ? isolateIn : lower, lower);
  const end = Math.min(hasOut ? isolateOut : upper, upper);

  return end > start ? { start, end } : null;
}

function pushToViews() {
  const playbackStore = usePlaybackStore(pinia);
  const graphStore = useGraphStore(pinia);
  const inTime = playbackStore.isolateInTime ?? false;
  const outTime = playbackStore.isolateOutTime ?? false;

  graphStore.seekBar?.setIsolateRange(inTime, outTime);
  if (graphStore.graph) {
    graphStore.graph.setIsolateRange(inTime, outTime);
    graphStore.invalidateGraph?.();
  }
}

export function setIsolateInTime(time) {
  const playbackStore = usePlaybackStore(pinia);
  if (time != null && time !== false) {
    time = clampToTrim(time, playbackStore.videoExportInTime, playbackStore.videoExportOutTime);
    if (playbackStore.isolateOutTime != null && playbackStore.isolateOutTime <= time) {
      playbackStore.isolateOutTime = null;
    }
  }
  playbackStore.isolateInTime = time === false ? null : time;
  pushToViews();
}

export function setIsolateOutTime(time) {
  const playbackStore = usePlaybackStore(pinia);
  if (time != null && time !== false) {
    time = clampToTrim(time, playbackStore.videoExportInTime, playbackStore.videoExportOutTime);
    if (playbackStore.isolateInTime != null && playbackStore.isolateInTime >= time) {
      playbackStore.isolateInTime = null;
    }
  }
  playbackStore.isolateOutTime = time === false ? null : time;
  pushToViews();
}

export function clearIsolation() {
  const playbackStore = usePlaybackStore(pinia);
  playbackStore.isolateInTime = null;
  playbackStore.isolateOutTime = null;
  pushToViews();
}

/**
 * The isolated block for the current log, or null if none is set.
 */
export function getIsolatedRange(flightLog) {
  const playbackStore = usePlaybackStore(pinia);
  return resolveIsolatedRange({
    isolateIn: playbackStore.isolateInTime,
    isolateOut: playbackStore.isolateOutTime,
    trimIn: playbackStore.videoExportInTime,
    trimOut: playbackStore.videoExportOutTime,
    minTime: flightLog?.getMinTime() ?? 0,
    maxTime: flightLog?.getMaxTime() ?? 0,
  });
}
