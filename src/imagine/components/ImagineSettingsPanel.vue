<template>
  <aside class="flex h-full min-h-0 w-[25rem] shrink-0 flex-col border-r border-default">
    <div class="flex-1 space-y-3 overflow-y-auto p-3">
      <!-- Lowpass filter 1 -->
      <ImagineSection
        title="Lowpass filter 1"
        :toggle="true"
        :enabled="s.lpf1.type !== 0"
        help="gyro_lpf1_*. With <b>dynamic cutoff</b> the cutoff follows headspeed: cutoff × headspeed / full headspeed, clamped to min and max."
        @update:enabled="setLpfEnabled(s.lpf1, log.lpf1, $event)"
      >
        <ImagineTypeSelect v-model="s.lpf1.type" :log-value="log.lpf1.type" cli="gyro_lpf1_type" />
        <ImagineNumber v-model="s.lpf1.staticHz" :log-value="log.lpf1.staticHz" label="Cutoff frequency" unit="Hz" cli="gyro_lpf1_static_hz" :max="4000" />
        <div class="flex items-center gap-2 py-0.5 text-sm">
          <span class="flex-1">Dynamic cutoff</span>
          <USwitch :model-value="s.lpf1.dynMinHz > 0" aria-label="Dynamic cutoff" @update:model-value="setDynLpf" />
        </div>
        <template v-if="s.lpf1.dynMinHz > 0">
          <ImagineNumber v-model="s.lpf1.dynMinHz" :log-value="log.lpf1.dynMinHz" label="Minimum cutoff" unit="Hz" cli="gyro_lpf1_dyn_min_hz" :max="1000" />
          <ImagineNumber v-model="s.lpf1.dynMaxHz" :log-value="log.lpf1.dynMaxHz" label="Maximum cutoff" unit="Hz" cli="gyro_lpf1_dyn_max_hz" :max="1000" />
          <p v-if="!store.rotor?.governorActive || !store.rotor?.fullHeadSpeed" class="text-xs text-warning">
            Needs the governor mode and gov_headspeed from a craft config. Without them the cutoff stays at its static value.
          </p>
        </template>
      </ImagineSection>

      <!-- Lowpass filter 2 -->
      <ImagineSection
        title="Lowpass filter 2"
        :toggle="true"
        :enabled="s.lpf2.type !== 0"
        help="gyro_lpf2_*. Runs before lowpass filter 1."
        @update:enabled="setLpfEnabled(s.lpf2, log.lpf2, $event)"
      >
        <ImagineTypeSelect v-model="s.lpf2.type" :log-value="log.lpf2.type" cli="gyro_lpf2_type" />
        <ImagineNumber v-model="s.lpf2.staticHz" :log-value="log.lpf2.staticHz" label="Cutoff frequency" unit="Hz" cli="gyro_lpf2_static_hz" :max="4000" />
      </ImagineSection>

      <!-- Static notches -->
      <ImagineSection
        v-for="(n, i) in notches"
        :key="n.key"
        :title="`Notch filter ${i + 1}`"
        :toggle="true"
        :enabled="s[n.key].hz > 0 && s[n.key].cutoff > 0"
        help="Static notch. The cutoff is the lower edge of the notch; it must be below the centre frequency."
        @update:enabled="setNotchEnabled(n.key, $event)"
      >
        <ImagineNumber v-model="s[n.key].hz" :log-value="log[n.key].hz" label="Centre frequency" unit="Hz" :cli="`gyro_notch${i + 1}_hz`" :max="4000" />
        <ImagineNumber v-model="s[n.key].cutoff" :log-value="log[n.key].cutoff" label="Cutoff frequency" unit="Hz" :cli="`gyro_notch${i + 1}_cutoff`" :max="4000" />
        <p v-if="s[n.key].cutoff >= s[n.key].hz" class="text-xs text-warning">The cutoff must be below the centre, otherwise the firmware disables this notch.</p>
        <p v-else-if="s[n.key].hz > nyquist" class="text-xs text-warning">Above the log's {{ nyquist }} Hz Nyquist limit, so the log can't show its effect.</p>
      </ImagineSection>

      <!-- Dynamic notch -->
      <ImagineSection
        title="Dynamic filter"
        :toggle="true"
        :enabled="s.dynNotch.enabled"
        help="feature DYN_NOTCH. Tracks the strongest peaks between min and max with a 72-point sliding DFT and places a notch on each. Each extra notch gets Q + 0.2."
        @update:enabled="s.dynNotch.enabled = $event"
      >
        <ImagineNumber v-model="s.dynNotch.count" :log-value="log.dynNotch.count" label="Notch count" cli="dyn_notch_count" :max="8" />
        <ImagineNumber v-model="s.dynNotch.q" :log-value="log.dynNotch.q" label="Notch Q" cli="dyn_notch_q" :min="10" :max="100" :step="0.1" :scale="10" />
        <ImagineNumber v-model="s.dynNotch.minHz" :log-value="log.dynNotch.minHz" label="Minimum frequency" unit="Hz" cli="dyn_notch_min_hz" :min="10" :max="200" />
        <ImagineNumber v-model="s.dynNotch.maxHz" :log-value="log.dynNotch.maxHz" label="Maximum frequency" unit="Hz" cli="dyn_notch_max_hz" :min="100" :max="500" />
        <p v-if="store.rates?.pidRateHz < 1000" class="text-xs text-warning">The PID loop runs below 1 kHz, so the firmware disables the dynamic notch.</p>
        <p v-else-if="s.dynNotch.maxHz > nyquist" class="text-xs text-dimmed">
          Peaks above {{ nyquist }} Hz are tracked by the firmware but invisible in this log.
        </p>
      </ImagineSection>

      <!-- RPM filter -->
      <ImagineSection
        title="RPM filter"
        :toggle="true"
        :enabled="s.rpm.enabled"
        help="feature RPM_FILTER, gyro_rpm_notch_*. Notches follow the logged headspeed. Main motor and tail notches need gear ratios from a craft config, or a logged tailspeed."
        @update:enabled="s.rpm.enabled = $event"
      >
        <ImagineNumber v-model="s.rpm.minHz" :log-value="log.rpm.minHz" label="Minimum frequency" unit="Hz" cli="gyro_rpm_notch_min_hz" :min="10" :max="200" />
        <div class="flex items-center gap-2 py-0.5 text-sm">
          <span class="flex-1">Preset <span class="font-mono text-[10px] text-dimmed">gyro_rpm_notch_preset</span></span>
          <USelect v-model="s.rpm.preset" :items="presetOptions" size="xs" class="w-40" />
        </div>
        <div class="flex items-center gap-1 pt-1">
          <UButton
            v-for="(name, a) in AXIS_NAMES"
            :key="name"
            :label="name"
            size="xs"
            :color="rpmAxis === a ? 'primary' : 'neutral'"
            :variant="rpmAxis === a ? 'soft' : 'ghost'"
            @click="rpmAxis = a"
          />
          <span class="ml-auto text-xs text-dimmed" v-if="store.rotorSpeeds.head">at {{ Math.round(store.rotorSpeeds.head) }} rpm</span>
        </div>
        <table class="w-full text-xs">
          <thead class="text-dimmed">
            <tr>
              <th class="text-left font-normal">Source</th>
              <th class="text-right font-normal">Q</th>
              <th class="text-right font-normal" title="Centre correction, % of the source frequency">Offset %</th>
              <th class="text-right font-normal">Hz</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rpmRows" :key="row.slot">
              <td class="py-0.5 pr-1">
                <USelect
                  v-if="isCustom"
                  :model-value="row.source"
                  :items="RPM_SOURCE_OPTIONS"
                  size="xs"
                  class="w-28"
                  @update:model-value="s.rpm.source[rpmAxis][row.slot] = $event"
                />
                <span v-else>{{ rpmSourceName(row.source) }}</span>
              </td>
              <td class="text-right">
                <UInputNumber
                  v-if="isCustom"
                  :model-value="row.q / 10"
                  :min="1"
                  :max="25"
                  :step="0.1"
                  :format-options="{ useGrouping: false, minimumFractionDigits: 1, maximumFractionDigits: 1 }"
                  size="xs"
                  :increment="false"
                  :decrement="false"
                  :ui="{ root: 'w-16', base: 'text-right px-2' }"
                  @update:model-value="(v) => v != null && (s.rpm.q[rpmAxis][row.slot] = Math.round(v * 10))"
                />
                <span v-else>{{ (row.q / 10).toFixed(1) }}</span>
              </td>
              <td class="text-right">
                <UInputNumber
                  v-if="isCustom"
                  :model-value="row.center / 100"
                  :min="-20"
                  :max="20"
                  :step="0.01"
                  :format-options="{ useGrouping: false, minimumFractionDigits: 2, maximumFractionDigits: 2 }"
                  size="xs"
                  :increment="false"
                  :decrement="false"
                  :ui="{ root: 'w-16', base: 'text-right px-2' }"
                  @update:model-value="(v) => v != null && (s.rpm.center[rpmAxis][row.slot] = Math.round(v * 100))"
                />
                <span v-else>{{ (row.center / 100).toFixed(2) }}</span>
              </td>
              <td class="pl-1 text-right tabular-nums" :class="hzClass(row.hz)" :title="hzTitle(row.hz)">
                {{ row.hz == null ? "–" : row.hz.toFixed(1) }}
              </td>
              <td class="pl-1 text-right">
                <UButton v-if="isCustom" icon="i-lucide-x" size="xs" variant="ghost" color="neutral" title="Remove notch" @click="removeBank(row.slot)" />
              </td>
            </tr>
            <tr v-if="!rpmRows.length">
              <td colspan="5" class="py-1 text-dimmed">No notches on this axis.</td>
            </tr>
          </tbody>
        </table>
        <div class="flex gap-2 pt-1">
          <UButton v-if="isCustom" label="Add notch" icon="i-lucide-plus" size="xs" variant="outline" color="neutral" :disabled="rpmRows.length >= 16" @click="addBank" />
          <UButton v-else label="Customise preset" icon="i-lucide-pencil" size="xs" variant="outline" color="neutral" @click="customisePreset" />
        </div>
      </ImagineSection>

      <!-- Rotor / craft config -->
      <ImagineSection title="Rotor data" help="Gear ratios and full headspeed are not in the log header. They come from the craft config (Rotorflight CLI dump or diff) loaded in the main window, or one you open here.">
        <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          <dt class="text-dimmed">Craft config</dt>
          <dd class="truncate">{{ store.craftFileName ?? "none" }}</dd>
          <dt class="text-dimmed">Main gear ratio</dt>
          <dd>{{ store.rotor?.mainGearRatio ? `${(1 / store.rotor.mainGearRatio).toFixed(2)} : 1` : "unknown" }}</dd>
          <dt class="text-dimmed">Tail rotor speed</dt>
          <dd>{{ store.rotor?.tailSource ?? "unknown" }}<template v-if="store.rotor?.tailPerHead"> ({{ store.rotor.tailPerHead.toFixed(2) }} × headspeed)</template></dd>
          <dt class="text-dimmed">Governor</dt>
          <dd>{{ store.rotor?.governorActive ? `on, full headspeed ${store.rotor.fullHeadSpeed || "unknown"} rpm` : "off or unknown" }}</dd>
        </dl>
        <p v-for="note in store.rotor?.notes ?? []" :key="note" class="text-xs text-warning">{{ note }}</p>
        <UButton label="Open craft config…" icon="i-lucide-file-cog" size="xs" variant="outline" color="neutral" class="mt-1" @click="craftInput.click()" />
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
import { computed, ref } from "vue";
import { AXIS_NAMES, useImagineStore } from "../imagine_store.js";
import { useCraftConfigStore } from "../../stores/craftConfig.js";
import { settingsToCli } from "../header_settings.js";
import { resolveRpmBanks, rpmBankFrequency, rpmSourceName, RPM_SOURCE_OPTIONS } from "../filters/rpm_filter.js";
import ImagineNumber from "./ImagineNumber.vue";
import ImagineSection from "./ImagineSection.vue";
import ImagineTypeSelect from "./ImagineTypeSelect.vue";

const store = useImagineStore();
const craftConfigStore = useCraftConfigStore();
const s = store.settings;
const log = computed(() => store.logSettings);
const nyquist = computed(() => Math.round((store.rates?.logRateHz ?? 0) / 2));
const notches = [{ key: "notch1" }, { key: "notch2" }];
const rpmAxis = ref(0);
const craftInput = ref(null);
const copied = ref(false);

const presetOptions = [
  { label: "Custom", value: 0 },
  { label: "Low vibration", value: 1 },
  { label: "Typical vibration", value: 2 },
  { label: "High vibration", value: 3 },
];

const isCustom = computed(() => !s.rpm.preset);

const rpmRows = computed(() => {
  const banks = isCustom.value ? s.rpm : resolveRpmBanks(s.rpm);
  const rows = [];
  for (let slot = 0; slot < 16; slot++) {
    const source = banks.source[rpmAxis.value][slot];
    if (!source) continue;
    const center = banks.center[rpmAxis.value][slot];
    rows.push({
      slot,
      source,
      q: banks.q[rpmAxis.value][slot],
      center,
      hz: rpmBankFrequency(source, center, store.rotorSpeeds, store.rotor),
    });
  }
  return rows;
});

function hzClass(hz) {
  if (hz == null) return "text-dimmed";
  return hz > nyquist.value ? "text-warning" : "";
}

function hzTitle(hz) {
  if (hz == null) return "Unknown: needs a gear ratio or a logged rotor speed";
  if (hz > nyquist.value) return `Above the log's ${nyquist.value} Hz Nyquist limit, so its effect can't be seen in this log`;
  return "Notch centre at the median headspeed";
}

function setLpfEnabled(target, logTarget, enabled) {
  if (enabled) {
    target.type = logTarget.type || 1;
    if (!target.staticHz) target.staticHz = logTarget.staticHz || 100;
  } else {
    target.type = 0;
    if (target.dynMinHz !== undefined) {
      target.dynMinHz = 0;
      target.dynMaxHz = 0;
    }
  }
}

function setDynLpf(enabled) {
  if (enabled) {
    const base = s.lpf1.staticHz || 100;
    s.lpf1.dynMinHz = log.value.lpf1.dynMinHz || Math.max(10, Math.round(base * 0.75));
    s.lpf1.dynMaxHz = log.value.lpf1.dynMaxHz || Math.round(base * 1.25);
  } else {
    s.lpf1.dynMinHz = 0;
    s.lpf1.dynMaxHz = 0;
  }
}

function setNotchEnabled(key, enabled) {
  if (enabled) {
    s[key].hz = log.value[key].hz || 150;
    s[key].cutoff = log.value[key].cutoff || 120;
  } else {
    s[key].hz = 0;
    s[key].cutoff = 0;
  }
}

function addBank() {
  const slot = s.rpm.source[rpmAxis.value].findIndex((v) => !v);
  if (slot < 0) return;
  s.rpm.source[rpmAxis.value][slot] = 11;
  s.rpm.q[rpmAxis.value][slot] = 50;
  s.rpm.center[rpmAxis.value][slot] = 0;
}

function removeBank(slot) {
  // keep the remaining banks packed in slot order, like the Configurator
  for (const key of ["source", "q", "center"]) {
    const arr = s.rpm[key][rpmAxis.value];
    arr.splice(slot, 1);
    arr.push(0);
  }
}

function customisePreset() {
  const banks = resolveRpmBanks(s.rpm);
  s.rpm.source = banks.source;
  s.rpm.center = banks.center;
  s.rpm.q = banks.q;
  s.rpm.preset = 0;
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
