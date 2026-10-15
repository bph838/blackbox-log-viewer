/**
 * HeadspeedStats - average / min / max main rotor headspeed for a loaded FlightLog.
 *
 * Kept free of any UI so other features can reuse it. Only samples where the
 * rotor is spooled up (>= minRpm) count, otherwise ground time before spool-up
 * and after spool-down would drag the average down and pin the min at zero.
 */

import { FlightLogParser } from "./flightlog_parser.js";

export const HEADSPEED_MIN_RPM = 500;

/**
 * @param {Object} flightLog - a loaded FlightLog
 * @param {Object} [options]
 * @param {number} [options.minRpm] - samples below this are treated as rotor not spinning
 * @param {number} [options.startTime] - microseconds, defaults to log start
 * @param {number} [options.endTime] - microseconds, defaults to log end
 * @returns {{average: number, min: number, max: number, minTime: number, maxTime: number,
 *            sampleCount: number, totalSamples: number, durationSeconds: number} | null}
 *   null if the log has no headspeed field or the rotor never spooled up.
 */
function compute(flightLog, options = {}) {
  if (!flightLog) return null;
  const headspeedIndex = flightLog.getMainFieldIndexByName("headspeed");
  if (headspeedIndex === undefined) return null;

  const minRpm = options.minRpm ?? HEADSPEED_MIN_RPM;
  const timeIndex = FlightLogParser.prototype.FLIGHT_LOG_FIELD_INDEX_TIME;
  const startTime = options.startTime ?? flightLog.getMinTime();
  const endTime = options.endTime ?? flightLog.getMaxTime();
  const chunks = flightLog.getChunksInTimeRange(startTime, endTime);

  let sum = 0,
    count = 0,
    total = 0;
  let min = Infinity,
    max = -Infinity,
    minTime = null,
    maxTime = null,
    firstTime = null,
    lastTime = null;

  for (const chunk of chunks) {
    for (const frame of chunk.frames) {
      // Chunks are whole, so they can run past either end of the range.
      const time = frame[timeIndex];
      if (time < startTime || time > endTime) continue;
      const speed = frame[headspeedIndex];
      if (!Number.isFinite(speed)) continue;
      total++;
      if (speed < minRpm) continue;
      sum += speed;
      count++;
      if (speed < min) {
        min = speed;
        minTime = time;
      }
      if (speed > max) {
        max = speed;
        maxTime = time;
      }
      if (firstTime === null) firstTime = time;
      lastTime = time;
    }
  }

  if (count === 0) return null;

  return {
    average: sum / count,
    min,
    max,
    minTime,
    maxTime,
    sampleCount: count,
    totalSamples: total,
    durationSeconds: (lastTime - firstTime) / 1000000,
  };
}

export const HeadspeedStats = { compute };
