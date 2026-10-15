<template>
  <aside class="flex h-full min-h-0 w-[27rem] shrink-0 flex-col border-l border-default">
    <div class="flex items-center gap-2 border-b border-default px-3 py-1.5 text-xs">
      <span class="flex-1 text-muted">Laid out like the Configurator's Gyro tab</span>
      <USwitch v-model="expertMode" size="xs" aria-label="Expert mode" />
      <span title="Show Lowpass Filter 2, Notch Filters, Dynamic Cutoff and the RPM Minimum Frequency, as Expert Mode does in the Configurator">
        Expert Mode
      </span>
    </div>

    <div class="flex-1 space-y-3 overflow-y-auto p-3">
      <!-- Lowpass Filter -->
      <ImagineSection title="Lowpass Filter" :help="HELP.lowpass">
        <template #header>
          <ImagineChartToggle
            :on="store.chartOverlays.lowpass"
            what="lowpass cutoffs"
            detail="a line at each cutoff frequency"
            @toggle="store.setChartOverlay('lowpass', $event)"
          />
        </template>
        <ImagineSubSection :label="showLpf2 ? 'Lowpass Filter 1' : ''">
          <ImagineField id="lpf1-enable" label="Enable" :changed="(s.lpf1.type > 0) !== (log.lpf1.type > 0)">
            <USwitch id="lpf1-enable" :model-value="s.lpf1.type > 0" @update:model-value="toggleLpf1" />
          </ImagineField>
          <ImagineSubSection v-if="s.lpf1.type > 0" indent>
            <ImagineField id="lpf1-type" label="Filter Type" cli="gyro_lpf1_type" :changed="s.lpf1.type !== log.lpf1.type">
              <ImagineTypeSelect id="lpf1-type" v-model="s.lpf1.type" />
            </ImagineField>
            <ImagineField id="lpf1-hz" label="Cutoff Frequency" unit="Hz" cli="gyro_lpf1_static_hz" :changed="s.lpf1.staticHz !== log.lpf1.staticHz">
              <ImagineNumber id="lpf1-hz" v-model="s.lpf1.staticHz" :min="0" :max="1000" />
            </ImagineField>
            <template v-if="showDynLpf">
              <ImagineField id="lpf1-dyn" label="Dynamic Cutoff" :changed="dynLpfOn !== (log.lpf1.dynMinHz > 0)">
                <USwitch id="lpf1-dyn" :model-value="dynLpfOn" @update:model-value="toggleDynLpf" />
              </ImagineField>
              <ImagineSubSection v-if="dynLpfOn" indent>
                <ImagineField id="lpf1-dyn-min" label="Min Cutoff Frequency" unit="Hz" cli="gyro_lpf1_dyn_min_hz" :changed="s.lpf1.dynMinHz !== log.lpf1.dynMinHz">
                  <ImagineNumber id="lpf1-dyn-min" v-model="s.lpf1.dynMinHz" :min="0" :max="1000" />
                </ImagineField>
                <ImagineField id="lpf1-dyn-max" label="Max Cutoff Frequency" unit="Hz" cli="gyro_lpf1_dyn_max_hz" :changed="s.lpf1.dynMaxHz !== log.lpf1.dynMaxHz">
                  <ImagineNumber id="lpf1-dyn-max" v-model="s.lpf1.dynMaxHz" :min="0" :max="1000" />
                </ImagineField>
                <p v-if="!store.rotor?.governorActive || !store.rotor?.fullHeadSpeed" class="pb-1 text-xs text-warning">
                  Needs the governor mode and headspeed from a craft config. Without them the cutoff stays at its static value.
                </p>
              </ImagineSubSection>
            </template>
          </ImagineSubSection>
        </ImagineSubSection>

        <ImagineSubSection v-if="showLpf2" label="Lowpass Filter 2">
          <ImagineField id="lpf2-enable" label="Enable" :changed="(s.lpf2.type > 0) !== (log.lpf2.type > 0)">
            <USwitch id="lpf2-enable" :model-value="s.lpf2.type > 0" @update:model-value="toggleLpf2" />
          </ImagineField>
          <ImagineSubSection v-if="s.lpf2.type > 0" indent>
            <ImagineField id="lpf2-type" label="Filter Type" cli="gyro_lpf2_type" :changed="s.lpf2.type !== log.lpf2.type">
              <ImagineTypeSelect id="lpf2-type" v-model="s.lpf2.type" />
            </ImagineField>
            <ImagineField id="lpf2-hz" label="Cutoff Frequency" unit="Hz" cli="gyro_lpf2_static_hz" :changed="s.lpf2.staticHz !== log.lpf2.staticHz">
              <ImagineNumber id="lpf2-hz" v-model="s.lpf2.staticHz" :min="0" :max="1000" />
            </ImagineField>
          </ImagineSubSection>
        </ImagineSubSection>
      </ImagineSection>

      <!-- Notch Filter (expert) -->
      <ImagineSection v-if="showNotches" title="Notch Filter" :help="HELP.notch">
        <template #header>
          <ImagineChartToggle
            :on="store.chartOverlays.notch"
            what="notch filters"
            detail="a triangle from each notch's cutoff up to its center"
            @toggle="store.setChartOverlay('notch', $event)"
          />
        </template>
        <ImagineSubSection v-for="(n, i) in NOTCHES" :key="n.key" :label="`Notch Filter ${i + 1}`">
          <ImagineField :id="`${n.key}-enable`" label="Enable" :changed="notchOn(s, n.key) !== notchOn(log, n.key)">
            <USwitch :id="`${n.key}-enable`" :model-value="notchOn(s, n.key)" @update:model-value="toggleNotch(n.key, $event)" />
          </ImagineField>
          <ImagineSubSection v-if="notchOn(s, n.key)" indent>
            <ImagineField :id="`${n.key}-hz`" label="Center Frequency" unit="Hz" :cli="`gyro_notch${i + 1}_hz`" :changed="s[n.key].hz !== log[n.key].hz">
              <ImagineNumber :id="`${n.key}-hz`" v-model="s[n.key].hz" :min="0" :max="1000" />
            </ImagineField>
            <ImagineField :id="`${n.key}-cutoff`" label="Cutoff Frequency" unit="Hz" :cli="`gyro_notch${i + 1}_cutoff`" :changed="s[n.key].cutoff !== log[n.key].cutoff">
              <ImagineNumber :id="`${n.key}-cutoff`" v-model="s[n.key].cutoff" :min="0" :max="1000" />
            </ImagineField>
            <p v-if="s[n.key].cutoff >= s[n.key].hz" class="pb-1 text-xs text-warning">
              The cutoff must be below the center, otherwise the firmware disables this notch.
            </p>
            <p v-else-if="s[n.key].hz > nyquist" class="pb-1 text-xs text-warning">
              Above the log's {{ nyquist }} Hz Nyquist limit, so the log can't show its effect.
            </p>
          </ImagineSubSection>
        </ImagineSubSection>
      </ImagineSection>

      <!-- Dynamic Filter -->
      <ImagineSection title="Dynamic Filter" :help="HELP.dynamic">
        <template #header>
          <ImagineChartToggle
            :on="store.chartOverlays.dynNotch"
            what="dynamic notch"
            detail="its range, and after Imagine where each notch sat"
            @toggle="store.setChartOverlay('dynNotch', $event)"
          />
        </template>
        <ImagineField id="dyn-enable" label="Enable" cli="feature DYN_NOTCH" :changed="s.dynNotch.enabled !== log.dynNotch.enabled">
          <USwitch id="dyn-enable" v-model="s.dynNotch.enabled" />
        </ImagineField>
        <ImagineSubSection v-if="s.dynNotch.enabled" indent>
          <ImagineField id="dyn-count" label="Notch Count" :help="HELP.dynCount" cli="dyn_notch_count" :changed="s.dynNotch.count !== log.dynNotch.count">
            <ImagineNumber id="dyn-count" v-model="s.dynNotch.count" :min="0" :max="8" />
          </ImagineField>
          <ImagineField id="dyn-q" label="Notch Q" :help="HELP.dynQ" cli="dyn_notch_q" :changed="s.dynNotch.q !== log.dynNotch.q">
            <ImagineNumber id="dyn-q" v-model="s.dynNotch.q" :min="1" :max="10" :step="0.1" :scale="10" />
          </ImagineField>
          <ImagineField id="dyn-min" label="Notch Minimum Frequency" unit="Hz" :help="HELP.dynMin" cli="dyn_notch_min_hz" :changed="s.dynNotch.minHz !== log.dynNotch.minHz">
            <ImagineNumber id="dyn-min" v-model="s.dynNotch.minHz" :min="10" :max="200" />
          </ImagineField>
          <ImagineField id="dyn-max" label="Notch Maximum Frequency" unit="Hz" :help="HELP.dynMax" cli="dyn_notch_max_hz" :changed="s.dynNotch.maxHz !== log.dynNotch.maxHz">
            <ImagineNumber id="dyn-max" v-model="s.dynNotch.maxHz" :min="100" :max="500" />
          </ImagineField>
          <p v-if="store.rates?.pidRateHz < 1000" class="pb-1 text-xs text-warning">
            The PID loop runs below 1 kHz, so the firmware disables the dynamic notch.
          </p>
          <p v-else-if="s.dynNotch.maxHz > nyquist" class="pb-1 text-xs text-dimmed">
            Peaks above {{ nyquist }} Hz are tracked by the firmware but invisible in this log.
          </p>
        </ImagineSubSection>
      </ImagineSection>

      <!-- RPM Filter -->
      <ImagineSection title="RPM Filter" :help="HELP.rpm">
        <UAlert
          v-if="!store.data?.hasHeadspeed"
          color="warning"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          title="This log has no headspeed, so the RPM filter can't follow the rotor."
          class="my-1"
        />
        <ImagineField id="rpm-enable" label="Enable" cli="feature RPM_FILTER" :changed="s.rpm.enabled !== log.rpm.enabled">
          <USwitch id="rpm-enable" v-model="s.rpm.enabled" />
        </ImagineField>
        <ImagineSubSection v-if="s.rpm.enabled" indent>
          <ImagineField id="rpm-preset" label="Strength" :help="HELP.rpmPreset" cli="gyro_rpm_notch_preset" :changed="s.rpm.preset !== log.rpm.preset">
            <USelect id="rpm-preset" :model-value="s.rpm.preset" :items="PRESETS" size="xs" class="w-28" @update:model-value="setPreset" />
          </ImagineField>
          <ImagineField
            v-if="expertMode || s.rpm.minHz !== log.rpm.minHz"
            id="rpm-min"
            label="Minimum Frequency"
            unit="Hz"
            :help="HELP.rpmMin"
            cli="gyro_rpm_notch_min_hz"
            :changed="s.rpm.minHz !== log.rpm.minHz"
          >
            <ImagineNumber id="rpm-min" v-model="s.rpm.minHz" :min="1" :max="100" />
          </ImagineField>
          <p v-if="s.rpm.preset > 0" class="pb-1 text-xs text-dimmed">
            Using the {{ PRESETS[s.rpm.preset].label }} preset. Choose Custom to edit the individual notches.
          </p>
        </ImagineSubSection>
      </ImagineSection>

      <ImagineRpmNotches
        v-if="s.rpm.enabled && s.rpm.preset === 0"
        :rpm="s.rpm"
        :speeds="store.rotorSpeeds"
        :rotor="store.rotor"
        :nyquist="nyquist"
      />

      <!-- Rotor data (Imagine only) -->
      <ImagineSection title="Rotor Data" :help="HELP.rotor">
        <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 py-1 text-xs">
          <dt class="text-dimmed">Craft config</dt>
          <dd class="truncate">{{ store.craftFileName ?? "none" }}</dd>
          <dt class="text-dimmed">Main gear ratio</dt>
          <dd>{{ store.rotor?.mainGearRatio ? `${(1 / store.rotor.mainGearRatio).toFixed(2)} : 1` : "unknown" }}</dd>
          <dt class="text-dimmed">Tail rotor speed</dt>
          <dd>
            {{ store.rotor?.tailSource ?? "unknown" }}<template v-if="store.rotor?.tailPerHead"> ({{ store.rotor.tailPerHead.toFixed(2) }} × headspeed)</template>
          </dd>
          <dt class="text-dimmed">Governor</dt>
          <dd>{{ store.rotor?.governorActive ? `on, full headspeed ${store.rotor.fullHeadSpeed || "unknown"} rpm` : "off or unknown" }}</dd>
        </dl>
        <p v-for="note in store.rotor?.notes ?? []" :key="note" class="text-xs text-warning">{{ note }}</p>
        <UButton label="Open craft config…" icon="i-lucide-file-cog" size="xs" variant="outline" color="neutral" class="my-1" @click="craftInput.click()" />
        <input ref="craftInput" type="file" accept=".txt,.cli,.diff,.dump,text/plain" class="hidden" @change="onCraftFile" />
      </ImagineSection>
    </div>

    <div class="space-y-2 border-t border-default p-3">
      <UButton
        block
        size="lg"
        label="Imagine"
        icon="i-lucide-sparkles"
        :loading="store.running"
        :disabled="!store.hasLog || store.status !== 'ready'"
        @click="store.imagine()"
      />
      <div class="flex gap-2">
        <UButton class="flex-1" block label="Reset to log values" icon="i-lucide-rotate-ccw" size="sm" variant="outline" color="neutral" @click="store.resetSettings()" />
        <UButton label="Copy CLI" icon="i-lucide-clipboard-copy" size="sm" variant="outline" color="neutral" title="Copy the imagined settings as Rotorflight CLI commands" @click="copyCli" />
      </div>
      <p v-if="copied" class="text-xs text-success">CLI commands copied.</p>
    </div>
  </aside>
</template>

<script setup>
import { computed, ref, watch } from "vue";
import { useImagineStore } from "../imagine_store.js";
import { useCraftConfigStore } from "../../stores/craftConfig.js";
import { settingsToCli } from "../header_settings.js";
import { resolveRpmBanks } from "../filters/rpm_filter.js";
import ImagineChartToggle from "./ImagineChartToggle.vue";
import ImagineField from "./ImagineField.vue";
import ImagineNumber from "./ImagineNumber.vue";
import ImagineRpmNotches from "./ImagineRpmNotches.vue";
import ImagineSection from "./ImagineSection.vue";
import ImagineSubSection from "./ImagineSubSection.vue";
import ImagineTypeSelect from "./ImagineTypeSelect.vue";

const store = useImagineStore();
const craftConfigStore = useCraftConfigStore();
const s = store.settings;
const log = computed(() => store.logSettings);
const nyquist = computed(() => Math.round((store.rates?.logRateHz ?? 0) / 2));
const craftInput = ref(null);
const copied = ref(false);

// Help texts are the Rotorflight Configurator's (locales/en/messages.json)
const HELP = {
  lowpass:
    "The Gyro Lowpass Filters are used for cutting off excess noise in the gyro signal. Two filters can be used, either 1<sup>st</sup> or 2<sup>nd</sup> order. The first filter can be dynamic, changing its cutoff frequency with the main rotor RPM. The minimum and maximum are limiting the dynamic range. With RPM Filters or Dynamic Notch Filters, one extra filter is needed around 100Hz.",
  notch:
    "The Notch Filters are used for filtering out additional resonances. Each filter has a Center and a Cutoff. The Center Frequency is the center of the filter and the Cutoff Frequency is where filter starts. For example with cutoff of 160 and center of 260, it means the range is 160-360Hz with most attenuation around the center.",
  dynamic:
    "Dynamic Notch Filter tracks peak noise frequencies in the gyro signal and places notch filters at those frequencies automatically.",
  dynCount:
    "Select the number of dynamic notch filters. If used standalone without the RPM filters, 4-6 is recommended. With the RPM filters, 2-4 is recommended.",
  dynQ: "The Q factor adjusts how wide the dynamic notch filters are. A higher value makes it narrower and more selective, and a lower value makes it wider and broader. Values between 2.0 and 4.0 are recommended. A value lower than 2.0 will greatly increase filter delay and may degrade flight performance.",
  dynMin:
    "Set this to the lowest incoming noise frequency that is needed to be filtered. Should be lower than main rotor frequency, but no lower that 20Hz, which is equivalent to 1200rpm.",
  dynMax:
    "Set this to the highest incoming noise frequency that is needed to be filtered. Should be 10-20% higher than the max tail rotor frequency, but no higher than 250Hz, if filter rate is 1k. If filter rate is 2k or higher, then 330-500 Hz can be used.",
  rpm: "Every rotating part on a helicopter generates vibrations, which can significantly affect the performance of the flight control loops. The <i>RPM Filter</i> utilizes the motor's RPM signal and the model's gear ratios to precisely eliminate these vibrations from the gyro's output.",
  rpmPreset: "Higher strength removes more vibrations, but introduces more delay. Default: Medium.",
  rpmMin: "Set slightly below the frequency of the main rotor at the lowest flying RPM. Default: 20Hz.",
  rotor:
    "Not part of the Configurator's Gyro tab. Gear ratios and full headspeed are not in the log header; they come from the craft config (CLI dump or diff) loaded in the main window, or one you open here.",
};

const PRESETS = [
  { label: "Custom", value: 0 },
  { label: "Low", value: 1 },
  { label: "Medium", value: 2 },
  { label: "High", value: 3 },
];
const NOTCHES = [{ key: "notch1" }, { key: "notch2" }];

// Configurator defaults used when a filter is switched on (FC.getFilterDefaults / FC.DEFAULT)
const DEFAULTS = {
  lpf1: { type: 1, staticHz: 125, dynMinHz: 50, dynMaxHz: 150 },
  lpf2: { type: 1, staticHz: 500 },
  notch1: { hz: 400, cutoff: 300 },
  notch2: { hz: 200, cutoff: 100 },
};

// Expert Mode, remembered per browser like the Configurator's own switch
const EXPERT_KEY = "imagine.expertMode";
function readExpert() {
  try {
    return globalThis.localStorage?.getItem(EXPERT_KEY) === "1";
  } catch {
    return false;
  }
}
const expertMode = ref(readExpert());
watch(expertMode, (on) => {
  try {
    globalThis.localStorage?.setItem(EXPERT_KEY, on ? "1" : "0");
  } catch {
    // not remembered
  }
});

// Expert-only parts stay visible whenever the log or the imagined settings use them, so nothing
// that affects the simulation is ever hidden.
const dynLpfOn = computed(() => s.lpf1.dynMinHz > 0);
const showDynLpf = computed(() => expertMode.value || dynLpfOn.value || log.value.lpf1.dynMinHz > 0);
const showLpf2 = computed(() => expertMode.value || s.lpf2.type > 0 || log.value.lpf2.type > 0);
const showNotches = computed(
  () => expertMode.value || notchOn(s, "notch1") || notchOn(s, "notch2") || notchOn(log.value, "notch1") || notchOn(log.value, "notch2"),
);

function notchOn(settings, key) {
  return settings[key].hz > 0 && settings[key].cutoff > 0;
}

// Configurator loadValue(): current value, else the value before it was switched off, else default
const previous = {};
function load(group, field) {
  return s[group][field] || previous[`${group}.${field}`] || log.value[group][field] || DEFAULTS[group][field];
}
function remember(group, fields) {
  for (const f of fields) if (s[group][f]) previous[`${group}.${f}`] = s[group][f];
}

function toggleLpf1(on) {
  if (on) {
    s.lpf1.type = load("lpf1", "type");
    s.lpf1.staticHz = load("lpf1", "staticHz");
    if (previous["lpf1.dynOn"]) {
      s.lpf1.dynMinHz = load("lpf1", "dynMinHz");
      s.lpf1.dynMaxHz = load("lpf1", "dynMaxHz");
    }
  } else {
    remember("lpf1", ["type", "staticHz", "dynMinHz", "dynMaxHz"]);
    previous["lpf1.dynOn"] = dynLpfOn.value;
    Object.assign(s.lpf1, { type: 0, staticHz: 0, dynMinHz: 0, dynMaxHz: 0 });
  }
}

function toggleDynLpf(on) {
  if (on) {
    s.lpf1.dynMinHz = load("lpf1", "dynMinHz");
    s.lpf1.dynMaxHz = load("lpf1", "dynMaxHz");
  } else {
    remember("lpf1", ["dynMinHz", "dynMaxHz"]);
    s.lpf1.dynMinHz = 0;
    s.lpf1.dynMaxHz = 0;
  }
}

function toggleLpf2(on) {
  if (on) {
    s.lpf2.type = load("lpf2", "type");
    s.lpf2.staticHz = load("lpf2", "staticHz");
  } else {
    remember("lpf2", ["type", "staticHz"]);
    Object.assign(s.lpf2, { type: 0, staticHz: 0 });
  }
}

function toggleNotch(key, on) {
  if (on) {
    s[key].hz = load(key, "hz");
    s[key].cutoff = load(key, "cutoff");
  } else {
    remember(key, ["hz", "cutoff"]);
    Object.assign(s[key], { hz: 0, cutoff: 0 });
  }
}

// Switching from a preset to Custom starts from that preset's notches, as the firmware copies the
// preset into the custom banks.
function setPreset(value) {
  if (value === 0 && s.rpm.preset > 0) {
    const banks = resolveRpmBanks(s.rpm);
    s.rpm.source = banks.source;
    s.rpm.center = banks.center;
    s.rpm.q = banks.q;
  }
  s.rpm.preset = value;
}

async function onCraftFile(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  await craftConfigStore.loadFile(file);
  store.craft = null; // use the store's (just loaded) config
  store.invalidateResults();
}

async function copyCli() {
  try {
    await navigator.clipboard.writeText(settingsToCli(s));
    copied.value = true;
    setTimeout(() => (copied.value = false), 2500);
  } catch {
    copied.value = false;
  }
}
</script>
