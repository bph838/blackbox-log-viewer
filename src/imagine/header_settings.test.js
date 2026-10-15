import { describe, expect, test } from "vitest";
import { adjustFieldDefsList, FIRMWARE_TYPE_ROTORFLIGHT } from "../flightlog_fielddefs.js";
import {
  checkFirmware,
  cloneSettings,
  ratesFromSysConfig,
  rotorInfo,
  settingsFromSysConfig,
  settingsToCli,
} from "./header_settings.js";
import { buildSpectrumView, markerSysConfig } from "./spectrum_view.js";
import { rpmBankFrequency } from "./filters/rpm_filter.js";

// Header values as parsed from a Rotorflight 4.6.0 log (TRON 5.8 sample)
const sysConfig = {
  firmwareType: FIRMWARE_TYPE_ROTORFLIGHT,
  firmwareVersion: "4.6.0",
  looptime: 250,
  pid_process_denom: 2,
  filter_process_denom: 2,
  frameIntervalPNum: 1,
  frameIntervalPDenom: 4,
  gyro_soft_type: 1,
  gyro_lowpass_hz: 55,
  gyro_lowpass_dyn_hz: [0, 0],
  gyro_soft2_type: 0,
  gyro_lowpass2_hz: 0,
  gyro_notch_hz: [0, 0],
  gyro_notch_cutoff: [0, 0],
  dyn_notch_count: 4,
  dyn_notch_q: 45,
  dyn_notch_min_hz: 30,
  dyn_notch_max_hz: 160,
  features: 1543504904,
  gyro_rpm_notch_preset: 0,
  gyro_rpm_notch_min_hz: 27,
  gyro_rpm_notch_source_roll: [11, 12, 13, 14, 21, 21, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  gyro_rpm_notch_center_roll: [0, 0, 0, 0, 66, -66, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  gyro_rpm_notch_q_roll: [60, 20, 100, 100, 15, 15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  gyro_rpm_notch_source_pitch: [11, 12, 14, 21],
  gyro_rpm_notch_center_pitch: [0, 0, 0, 0],
  gyro_rpm_notch_q_pitch: [70, 30, 100, 50],
  gyro_rpm_notch_source_yaw: [11, 12, 13, 14, 21],
  gyro_rpm_notch_center_yaw: [0, 0, 0, 0, 0],
  gyro_rpm_notch_q_yaw: [92, 31, 100, 100, 15],
};

adjustFieldDefsList(FIRMWARE_TYPE_ROTORFLIGHT, "4.6.0");

describe("settings from the log header", () => {
  test("maps the RF 4.6 header onto Imagine settings", () => {
    const s = settingsFromSysConfig(sysConfig);
    expect(s.lpf1).toEqual({ type: 1, staticHz: 55, dynMinHz: 0, dynMaxHz: 0 });
    expect(s.lpf2).toEqual({ type: 0, staticHz: 0 });
    expect(s.notch1).toEqual({ hz: 0, cutoff: 0 });
    // features 1543504904: RPM_FILTER (bit 30) on, DYN_NOTCH (bit 29) off
    expect(s.dynNotch).toEqual({ enabled: false, count: 4, q: 45, minHz: 30, maxHz: 160 });
    expect(s.rpm.enabled).toBe(true);
    expect(s.rpm.minHz).toBe(27);
    expect(s.rpm.source[0].slice(0, 6)).toEqual([11, 12, 13, 14, 21, 21]);
    expect(s.rpm.center[0][4]).toBe(66);
    expect(s.rpm.q[2].length).toBe(16);
  });

  test("CLI export uses Rotorflight names", () => {
    const cli = settingsToCli(settingsFromSysConfig(sysConfig));
    expect(cli).toContain("set gyro_lpf1_static_hz = 55");
    expect(cli).toContain("feature -DYN_NOTCH");
    expect(cli).toContain("feature RPM_FILTER");
    expect(cli).toContain("set gyro_rpm_notch_center_roll = 0,0,0,0,66,-66,0,0,0,0,0,0,0,0,0,0");
  });

  test("clone is a plain deep copy", () => {
    const s = settingsFromSysConfig(sysConfig);
    const c = cloneSettings(s);
    c.rpm.source[0][0] = 99;
    expect(s.rpm.source[0][0]).toBe(11);
  });
});

describe("rates", () => {
  test("derives gyro, filter, PID and log rates", () => {
    const r = ratesFromSysConfig(sysConfig, 499.1);
    expect(r.gyroRateHz).toBe(4000);
    expect(r.filterRateHz).toBe(2000);
    expect(r.pidRateHz).toBe(2000);
    expect(r.logRateHz).toBe(500);
    expect(r.upsampleRatio).toBe(4);
  });

  test("falls back to the PID divider and to measured timestamps", () => {
    const r = ratesFromSysConfig({ ...sysConfig, filter_process_denom: 0 }, 250);
    expect(r.filterRateHz).toBe(2000);
    expect(r.logRateHz).toBe(250);
    expect(r.logRateSource).toBe("timestamps");
  });
});

describe("rotor info from the craft config", () => {
  test("converts the app's motor-per-rotor ratios into the firmware's", () => {
    const r = rotorInfo({
      craftSettings: { main_rotor_gear_ratio: "12,104", tail_rotor_gear_ratio: "20,115", gov_mode: "ELECTRIC", gov_headspeed: "2000" },
      hasCraftConfig: true,
      hasHeadspeed: true,
      hasTailspeed: false,
      motorisedTail: false,
    });
    expect(r.mainGearRatio).toBeCloseTo(12 / 104, 10);
    expect(r.tailPerHead).toBeCloseTo(115 / 20, 10);
    expect(r.tailGearRatio).toBeCloseTo((12 / 104) * (115 / 20), 10);
    expect(r.hasTailSpeed).toBe(true);
    expect(r.governorActive).toBe(true);
    expect(r.fullHeadSpeed).toBe(2000);
    // main motor notch: headspeed / firmware ratio = motor RPM
    expect(rpmBankFrequency(10, 0, { head: 2000, tail: 11500 }, r)).toBeCloseTo((2000 * 104) / 12 / 60, 6);
    expect(rpmBankFrequency(21, 0, { head: 2000, tail: 11500 }, r)).toBeCloseTo(11500 / 60, 6);
  });

  test("without a craft config only the logged speeds can be used", () => {
    const r = rotorInfo({ craftSettings: null, hasCraftConfig: false, hasHeadspeed: true, hasTailspeed: true, motorisedTail: false });
    expect(r.mainGearRatio).toBeNull();
    expect(r.tailSource).toBe("tailspeed");
    expect(r.notes.length).toBe(1);
  });
});

describe("firmware check", () => {
  test("4.6.x matches, others are approximate, non Rotorflight unsupported", () => {
    expect(checkFirmware(sysConfig).status).toBe("match");
    expect(checkFirmware({ ...sysConfig, firmwareVersion: "4.6.2" }).status).toBe("match");
    expect(checkFirmware({ ...sysConfig, firmwareVersion: "4.5.1" }).status).toBe("approximate");
    expect(checkFirmware({ ...sysConfig, firmwareType: 3 }).status).toBe("unsupported");
  });
});

describe("spectrum view", () => {
  const n = 4096;
  const rate = 500;
  const tone = (f, a) => Float64Array.from({ length: n }, (_, i) => a * Math.sin((2 * Math.PI * f * i) / rate));
  const data = {
    raw: [tone(120, 10), tone(60, 5), tone(30, 2)],
    logged: [tone(120, 1), tone(60, 1), tone(30, 1)],
  };
  const imagined = { filtered: [tone(120, 2), tone(60, 2), tone(30, 2)] };

  test("linear view: unfiltered bars scaled to the plot, overlays keep their peaks", () => {
    const view = buildSpectrumView({ data, imagined, axis: 0, range: { start: 0, end: n }, rateHz: rate, show: { unfiltered: true, imagined: true, logged: true }, mode: "linear" });
    expect(view.fftData.blackBoxRate).toBe(rate);
    expect(Math.max(...view.fftData.fftOutput)).toBeCloseTo(90, 0);
    expect(view.curves.map((c) => c.name)).toEqual(["Unfiltered", "Imagined", "Logged filtered"]);
    const peak = (c) => Math.max(...c.points.map((p) => p.y));
    // 10 : 2 : 1 amplitude ratio survives the envelope
    expect(peak(view.curves[1]) / peak(view.curves[0])).toBeCloseTo(0.2, 1);
    expect(peak(view.curves[2]) / peak(view.curves[0])).toBeCloseTo(0.1, 1);
    expect(view.fftData.maxNoiseFrequency).toBeCloseTo(120, 0);
  });

  test("dB view: imagined curve sits 14 dB under the unfiltered one", () => {
    const view = buildSpectrumView({ data, imagined, axis: 0, range: { start: 0, end: n }, rateHz: rate, show: { unfiltered: false, imagined: true, logged: false }, mode: "db" });
    const peak = (c) => Math.max(...c.points.map((p) => p.y));
    expect(view.curves[0].name).toBe("Unfiltered");
    expect(peak(view.curves[0]) - peak(view.curves[1])).toBeCloseTo(20 * Math.log10(5), 0);
  });

  test("filter markers follow the edited settings", () => {
    const s = settingsFromSysConfig(sysConfig);
    s.notch1 = { hz: 150, cutoff: 120 };
    const m = markerSysConfig(s);
    expect(m.gyro_lowpass_hz).toBe(55);
    expect(m.gyro_notch_hz).toEqual([150, 0]);
  });
});
