// Validation: simulate a real log with its own filter settings and compare with the logged
// filtered gyro. Needs a Rotorflight log with gyroRAW, so it only runs when IMAGINE_SAMPLE_LOG
// points at one:
//
//   IMAGINE_SAMPLE_LOG=path/to/log.bbl [IMAGINE_TAIL_RATIO=4.6] npx vitest run src/imagine/validation.test.js
//
// Without IMAGINE_TAIL_RATIO the tail rotor ratio is fitted by sweeping it (the log header does
// not carry gear ratios).

import fs from "node:fs";
import process from "node:process";
import { describe, expect, test } from "vitest";
import { FlightLog } from "../flightlog.js";
import { extractLogData } from "./log_data.js";
import { settingsFromSysConfig, ratesFromSysConfig, checkFirmware } from "./header_settings.js";
import { simulateGyroFilters } from "./simulate.js";
import { compareAxis } from "./analysis.js";
import { chainResponse } from "./response.js";

const LOG_PATH = process.env.IMAGINE_SAMPLE_LOG;
const AXES = ["roll", "pitch", "yaw"];

function rotorFor(data, tailPerHead) {
  return {
    mainGearRatio: null,
    tailGearRatio: null,
    tailPerHead,
    motorisedTail: data.motorisedTail,
    hasTailSpeed: data.hasTailspeed || tailPerHead != null,
    governorActive: false,
    fullHeadSpeed: 0,
  };
}

function run(data, settings, rates, tailPerHead, range) {
  const tailspeed = data.tailspeed ?? (tailPerHead != null ? data.headspeed.map((h) => h * tailPerHead) : null);
  const sim = simulateGyroFilters({
    raw: data.raw,
    headspeed: data.headspeed,
    tailspeed,
    rates,
    settings,
    rotor: rotorFor(data, tailPerHead),
  });
  const metrics = [0, 1, 2].map((a) =>
    compareAxis({
      unfiltered: data.raw[a],
      simulated: sim.filtered[a],
      logged: data.logged[a],
      start: range.start,
      end: range.end,
      rateHz: rates.logRateHz,
    }),
  );
  return { sim, metrics };
}

describe.skipIf(!LOG_PATH)("Imagine validation against a real log", () => {
  test("simulating the log's own settings reproduces the logged filtered gyro", () => {
    const flightLog = new FlightLog(new Uint8Array(fs.readFileSync(LOG_PATH)));
    flightLog.openLog(Number(process.env.IMAGINE_LOG_INDEX ?? 0));
    const sysConfig = flightLog.getSysConfig();
    const data = extractLogData(flightLog);
    const rates = ratesFromSysConfig(sysConfig, data.measuredLogRateHz);
    const settings = settingsFromSysConfig(sysConfig);
    // ignore the first second (filter start-up)
    const range = { start: Math.round(rates.logRateHz), end: data.count };

    let tailPerHead = process.env.IMAGINE_TAIL_RATIO ? Number(process.env.IMAGINE_TAIL_RATIO) : null;
    const needsTail = settings.rpm.enabled && settings.rpm.source.some((axis) => axis.some((s) => s >= 20));
    if (tailPerHead == null && needsTail && !data.hasTailspeed) {
      let best = null;
      for (let r = 3.0; r <= 6.01; r += 0.05) {
        const { metrics } = run(data, settings, rates, r, range);
        const score = metrics.reduce((acc, m) => acc + m.noiseResidualRatio, 0);
        if (!best || score < best.score) best = { r, score };
      }
      tailPerHead = Math.round(best.r * 100) / 100;
    }

    const { sim, metrics } = run(data, settings, rates, tailPerHead, range);
    const noRpm = run(data, { ...settings, rpm: { ...settings.rpm, enabled: false } }, rates, tailPerHead, range);

    const lines = [];
    lines.push(`Firmware: ${checkFirmware(sysConfig).message}`);
    lines.push(
      `Rates: gyro ${rates.gyroRateHz} Hz, filter ${rates.filterRateHz} Hz, PID ${rates.pidRateHz} Hz, log ${rates.logRateHz.toFixed(1)} Hz (measured ${rates.measuredLogRateHz.toFixed(1)} Hz), upsample x${rates.upsampleRatio}`,
    );
    lines.push(`Samples: ${data.count}, max frame gap ${data.maxGapUs} us, simulation ${sim.elapsedMs.toFixed(0)} ms`);
    lines.push(`Chain: ${JSON.stringify(sim.chain)}`);
    lines.push(`Tail ratio used: ${tailPerHead ?? "n/a"}`);
    metrics.forEach((m, a) => {
      lines.push(
        `${AXES[a]}: corr ${m.correlation.toFixed(5)}, rms err ${m.rmsError.toFixed(2)} deg/s (logged rms ${m.loggedRms.toFixed(1)}), ` +
          `>20Hz noise logged ${m.loggedNoiseRms.toFixed(3)} residual ${m.residualNoiseRms.toFixed(3)} (${(m.noiseResidualRatio * 100).toFixed(1)}%), ` +
          `without RPM filter residual ${(noRpm.metrics[a].noiseResidualRatio * 100).toFixed(1)}%`,
      );
      for (const b of m.bands) {
        lines.push(
          `   ${String(b.fromHz).padStart(3)}-${String(b.toHz).padEnd(3)} Hz  unfilt ${b.unfilteredRms.toFixed(3)}  logged ${b.loggedRms.toFixed(3)} (${b.loggedReductionDb.toFixed(1)} dB)  sim ${b.simulatedRms.toFixed(3)} (${b.simulatedReductionDb.toFixed(1)} dB)  diff ${b.differenceDb.toFixed(2)} dB`,
        );
      }
    });

    const headMedian = [...data.headspeed].filter((h) => h > 100).sort((a, b) => a - b);
    const head = headMedian[Math.floor(headMedian.length / 2)] ?? 0;
    const delay = chainResponse({
      settings,
      rates,
      rotor: rotorFor(data, tailPerHead),
      axis: 0,
      operatingPoint: { headRpm: head, tailRpm: tailPerHead ? head * tailPerHead : 0 },
    });
    lines.push(`Roll delay at ${head} rpm: ${delay.map((d) => `${d.frequencyHz}Hz ${d.delayMs.toFixed(2)}ms ${d.gainDb.toFixed(1)}dB`).join(", ")}`);
    console.log(lines.join("\n"));

    for (const m of metrics) {
      expect(m.correlation).toBeGreaterThan(0.99);
    }
  }, 600000);
});
