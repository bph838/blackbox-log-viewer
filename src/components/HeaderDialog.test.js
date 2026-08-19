import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import HeaderDialog from "./HeaderDialog.vue";
import ParamTable from "./ParamTable.vue";
import FeatureTable from "./FeatureTable.vue";
import {
  FIRMWARE_TYPE_ROTORFLIGHT,
  FIRMWARE_TYPE_BETAFLIGHT,
} from "../flightlog_fielddefs.js";

function mountWithSysConfig(sysConfig) {
  return mount(HeaderDialog, {
    props: { open: true, sysConfig },
    shallow: true,
    global: {
      renderStubDefaultSlot: true,
    },
  });
}

function yawPrecompPaneParams(wrapper) {
  const pane = wrapper.find('[data-group="Yaw Precompensation"]');
  if (!pane.exists()) {
    return null;
  }
  return pane.findComponent(ParamTable).props("params");
}

function featuresPaneData(wrapper) {
  const pane = wrapper.find('[data-group="Features"]');
  if (!pane.exists()) {
    return null;
  }
  return pane.findComponent(FeatureTable).props("data");
}

describe("HeaderDialog Yaw Precompensation pane", () => {
  it("shows piro compensation and yaw precomp values parsed from the log header", () => {
    const wrapper = mountWithSysConfig({
      firmwareType: FIRMWARE_TYPE_ROTORFLIGHT,
      firmwareVersion: "4.6.0",
      piro_compensation: 1,
      yaw_precomp: [10, 20, 30],
      yaw_precomp_impulse: [5, null],
    });

    const params = yawPrecompPaneParams(wrapper);
    expect(params).not.toBeNull();

    const byName = Object.fromEntries(params.map((p) => [p.name, p.value]));
    expect(byName["Piro Compensation"]).toBe("ON");
    expect(byName["Cutoff"]).toBe("10");
    expect(byName["Cyclic"]).toBe("20");
    expect(byName["Collective"]).toBe("30");
    expect(byName["Impulse Gain"]).toBe("5");
    // Impulse Decay was null in the header -> dropped entirely, matching every other
    // param() field in this file (missing values are filtered out, not shown as "-").
    expect(byName["Impulse Decay"]).toBeUndefined();
  });

  it("hides the whole pane when the log has none of these header fields", () => {
    const wrapper = mountWithSysConfig({
      firmwareType: FIRMWARE_TYPE_ROTORFLIGHT,
      firmwareVersion: "4.6.0",
    });

    expect(wrapper.find('[data-group="Yaw Precompensation"]').exists()).toBe(false);
  });
});

describe("HeaderDialog Features pane", () => {
  it("decodes Rotorflight feature bits using Rotorflight's own bit assignments", () => {
    // bit 3 RX_SERIAL, bit 10 TELEMETRY, bit 27 ESC_SENSOR, bit 28 FREQ_SENSOR
    const features = (1 << 3) | (1 << 10) | (1 << 27) | (1 << 28);
    const wrapper = mountWithSysConfig({
      firmwareType: FIRMWARE_TYPE_ROTORFLIGHT,
      firmwareVersion: "4.6.0",
      features,
    });

    const names = featuresPaneData(wrapper).map((f) => f.name);
    expect(names).toEqual(
      expect.arrayContaining(["RX_SERIAL", "TELEMETRY", "ESC_SENSOR", "FREQ_SENSOR"]),
    );
    // Rotorflight bit 28 is FREQ_SENSOR, not Betaflight's ANTI_GRAVITY.
    expect(names).not.toContain("ANTI_GRAVITY");
  });

  it("still decodes Betaflight feature bits using Betaflight's bit assignments", () => {
    // bit 27 ESC_SENSOR, bit 28 ANTI_GRAVITY (Betaflight numbering)
    const features = (1 << 27) | (1 << 28);
    const wrapper = mountWithSysConfig({
      firmwareType: FIRMWARE_TYPE_BETAFLIGHT,
      firmwareVersion: "4.3.0",
      features,
    });

    const names = featuresPaneData(wrapper).map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(["ESC_SENSOR", "ANTI_GRAVITY"]));
    expect(names).not.toContain("FREQ_SENSOR");
  });
});
