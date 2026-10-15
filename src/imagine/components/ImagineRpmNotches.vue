<template>
  <section class="overflow-hidden rounded-md border border-default bg-elevated/40">
    <header class="flex items-stretch border-b-4" :style="{ borderColor: AXES[axis].color }">
      <h3 class="flex flex-1 items-center bg-elevated px-3 py-1.5 text-sm font-semibold">RPM Filter Notches</h3>
      <div class="flex items-center bg-elevated pr-1">
        <ImagineChartToggle
          :on="imagine.chartOverlays.rpm"
          what="RPM notches"
          detail="where each notch sits at the median headspeed for the chart's axis, with the range it moves over in the flight"
          @toggle="imagine.setChartOverlay('rpm', $event)"
        />
      </div>
      <button
        v-for="(a, i) in AXES"
        :key="a.label"
        type="button"
        class="w-16 cursor-pointer text-xs font-semibold text-white transition"
        :style="{ background: a.color, filter: axis === i ? 'none' : 'brightness(0.6)' }"
        @click="axis = i"
      >
        {{ a.label }}
      </button>
    </header>

    <div class="px-3 py-1.5">
      <!-- Layout the Configurator can show: one row per source -->
      <template v-if="layout">
        <UAlert
          v-if="limitError"
          color="error"
          variant="subtle"
          :title="`A maximum of 16 notches can be enabled per axis (${limitError} / 16).`"
          class="mb-1"
        />
        <p class="mb-1 text-right text-xs text-dimmed">
          {{ count }} / 16 notches<template v-if="speeds?.head"> · Hz at {{ Math.round(speeds.head) }} rpm</template>
        </p>

        <template v-for="group in groups" :key="group.label">
          <ImagineSubSection v-if="group.rows.length" :label="group.label">
            <div
              v-for="row in group.rows"
              :key="row.source"
              class="-mx-1 flex gap-2 rounded px-1"
              :class="{ 'bg-elevated': hoveredSource === row.source }"
              @mouseenter="hover([row.source], row.source)"
              @mouseleave="hover(null)"
            >
              <div class="flex h-8 items-center">
                <USwitch
                  :model-value="bank[row.source].enabled"
                  :aria-label="`Enable ${row.name}`"
                  :style="{ '--ui-primary': AXES[axis].color }"
                  @update:model-value="setEnabled(row.source, $event)"
                />
              </div>
              <div class="min-w-0 flex-1">
                <ImagineField
                  v-if="row.typeLabel"
                  :label="row.typeLabel"
                  :disabled="!bank[row.source].enabled"
                >
                  <USelect
                    :model-value="shown(row.source).type"
                    :items="typeItems"
                    :disabled="!bank[row.source].enabled"
                    size="xs"
                    class="w-28"
                    @update:model-value="setRow(row.source, { type: $event })"
                  />
                </ImagineField>
                <ImagineField
                  :label="row.qLabel"
                  :disabled="!bank[row.source].enabled"
                  :hint="hzText(row.source)"
                  :hint-class="hzClass(row.source)"
                  :hint-title="hzTitle(row.source)"
                >
                  <UInputNumber
                    :model-value="shown(row.source).q"
                    :min="MIN_Q"
                    :max="MAX_Q"
                    :step="0.1"
                    :disabled="!bank[row.source].enabled"
                    :format-options="{ useGrouping: false, minimumFractionDigits: 1, maximumFractionDigits: 1 }"
                    size="xs"
                    :ui="{ root: 'w-28' }"
                    @update:model-value="(v) => v != null && setRow(row.source, { q: Math.round(v * 10) / 10 })"
                  />
                </ImagineField>
              </div>
            </div>
          </ImagineSubSection>
        </template>
      </template>

      <!-- Anything else: the Configurator would say "custom configuration in use" -->
      <template v-else>
        <UAlert
          color="warning"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          title="Custom RPM notch configuration in use"
          description="These notches can't be shown in the Configurator's layout (it needs one Q per source, Q 1.5–10 and standard double/triple spacing), so they are listed slot by slot as in the CLI."
          class="mb-2"
        />
        <ImagineRpmList :rpm="rpm" :axis="axis" :speeds="speeds" :rotor="rotor" :nyquist="nyquist" @hover-slot="hoverSlot" />
        <div class="mt-2 flex justify-end">
          <UButton
            label="Convert to Configurator layout"
            icon="i-lucide-wand-sparkles"
            size="xs"
            variant="outline"
            color="neutral"
            title="One row per source: notch count becomes Single/Double/Triple and Q becomes the median Q of that source's notches (clamped to 1.5–10). This changes the filter slightly."
            @click="convert"
          />
        </div>
      </template>
    </div>
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, reactive, ref } from "vue";
import { useImagineStore } from "../imagine_store.js";
import {
  convertToLayout,
  DEFAULT_Q,
  generateRpmLayout,
  MAX_Q,
  MIN_Q,
  notchCount,
  NOTCH_TYPE,
  parseRpmLayout,
  RPM_NOTCH_COUNT,
} from "../rpm_notch_layout.js";
import { rpmBankFrequency } from "../filters/rpm_filter.js";
import ImagineField from "./ImagineField.vue";
import ImagineSubSection from "./ImagineSubSection.vue";
import ImagineRpmList from "./ImagineRpmList.vue";
import ImagineChartToggle from "./ImagineChartToggle.vue";

const props = defineProps({
  rpm: { type: Object, required: true }, // settings.rpm (CLI arrays), edited in place
  speeds: { type: Object, default: null },
  rotor: { type: Object, default: null },
  nyquist: { type: Number, default: 0 },
});

// Configurator axis colours (css/app.css --color-roll / pitch / yaw)
const AXES = [
  { label: "Roll", color: "hsl(2, 55%, 52%)" },
  { label: "Pitch", color: "hsl(122, 48%, 40%)" },
  { label: "Yaw", color: "hsl(242, 55%, 58%)" },
];
const typeItems = [
  { label: "SINGLE", value: NOTCH_TYPE.SINGLE },
  { label: "DOUBLE", value: NOTCH_TYPE.DOUBLE },
  { label: "TRIPLE", value: NOTCH_TYPE.TRIPLE },
];

// The tab follows the chart's axis, and picking a tab switches the chart too
const imagine = useImagineStore();
const axis = computed({
  get: () => imagine.axis,
  set: (v) => (imagine.axis = v),
});
const hoveredSource = ref(null);

function hover(sources, source = null) {
  hoveredSource.value = source;
  imagine.rpmHighlight = sources ? { axis: axis.value, sources } : null;
}

function hoverSlot(slot) {
  imagine.rpmHighlight = slot == null ? null : { axis: axis.value, slots: [slot] };
}

onBeforeUnmount(() => {
  imagine.rpmHighlight = null;
});
const limitError = ref(null);
// Q/type of rows while they are switched off, so switching back on restores them
const memory = reactive([{}, {}, {}]);

const layout = computed(() => parseRpmLayout(props.rpm));
const bank = computed(() => layout.value?.[axis.value] ?? {});
const count = computed(() => notchCount(bank.value));

const ORDINAL = ["", "Fundamental Frequency", "2<sup>nd</sup> Harmonic", "3<sup>rd</sup> Harmonic", "4<sup>th</sup> Harmonic",
  "5<sup>th</sup> Harmonic", "6<sup>th</sup> Harmonic", "7<sup>th</sup> Harmonic", "8<sup>th</sup> Harmonic"];

function harmonicRow(source, harmonic) {
  const multi = harmonic <= 2;
  return {
    source,
    name: `${ORDINAL[harmonic].replace(/<\/?sup>/g, "")} notch`,
    typeLabel: multi ? `${ORDINAL[harmonic]} Notch Type` : "",
    qLabel: `${ORDINAL[harmonic]} Notch Q`,
  };
}

const groups = computed(() => {
  const r = props.rotor ?? {};
  // As the Configurator: motor notches only for geared main motors / geared motorised tails,
  // but always shown when the configuration already uses them.
  const showMain = (r.mainGearRatio != null && r.mainGearRatio !== 1) || bank.value[10]?.enabled;
  const showTail = (r.motorisedTail && r.tailGearRatio != null && r.tailGearRatio !== 1) || bank.value[20]?.enabled;
  const motors = [];
  if (showMain) motors.push({ source: 10, name: "Main motor notch", typeLabel: "", qLabel: "Main Motor Notch Q" });
  if (showTail) motors.push({ source: 20, name: "Tail motor notch", typeLabel: "", qLabel: "Tail Motor Notch Q" });
  return [
    { label: "Motors", rows: motors },
    { label: "Main Rotor", rows: [1, 2, 3, 4, 5, 6, 7, 8].map((h) => harmonicRow(10 + h, h)) },
    { label: "Tail Rotor", rows: [1, 2, 3, 4].map((h) => harmonicRow(20 + h, h)) },
  ];
});

function shown(source) {
  const row = bank.value[source];
  if (row?.enabled) return row;
  return memory[axis.value][source] ?? { type: NOTCH_TYPE.SINGLE, q: DEFAULT_Q };
}

function write(banks) {
  const n = notchCount(banks[axis.value]);
  if (n > RPM_NOTCH_COUNT) {
    limitError.value = n;
    return;
  }
  limitError.value = null;
  const g = generateRpmLayout(banks);
  props.rpm.source = g.source;
  props.rpm.center = g.center;
  props.rpm.q = g.q;
}

function cloneBanks() {
  return layout.value.map((b) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, { ...v }])));
}

function setEnabled(source, enabled) {
  const banks = cloneBanks();
  const row = banks[axis.value][source];
  if (enabled) {
    const saved = memory[axis.value][source];
    banks[axis.value][source] = { enabled: true, type: saved?.type ?? row.type, q: saved?.q ?? row.q };
  } else {
    memory[axis.value][source] = { type: row.type, q: row.q };
    row.enabled = false;
  }
  write(banks);
}

function setRow(source, patch) {
  const banks = cloneBanks();
  Object.assign(banks[axis.value][source], patch);
  write(banks);
}

function convert() {
  const { banks } = convertToLayout(props.rpm);
  for (let a = 0; a < 3; a++) {
    if (notchCount(banks[a]) > RPM_NOTCH_COUNT) {
      // keep the lowest sources until the axis fits
      for (const s of Object.keys(banks[a]).map(Number).sort((x, y) => y - x)) {
        if (notchCount(banks[a]) <= RPM_NOTCH_COUNT) break;
        banks[a][s].enabled = false;
      }
    }
  }
  const g = generateRpmLayout(banks);
  props.rpm.source = g.source;
  props.rpm.center = g.center;
  props.rpm.q = g.q;
}

function hz(source) {
  return rpmBankFrequency(source, 0, props.speeds, props.rotor);
}

function hzText(source) {
  const f = hz(source);
  return f == null ? "frequency unknown" : `at ${f.toFixed(1)} Hz`;
}

function hzClass(source) {
  const f = hz(source);
  if (f == null) return "text-dimmed";
  return f > props.nyquist ? "text-warning" : "text-dimmed";
}

function hzTitle(source) {
  const f = hz(source);
  if (f == null) return "Unknown: needs a gear ratio from the craft config, or a logged rotor speed";
  if (f > props.nyquist) return `Above the log's ${props.nyquist} Hz Nyquist limit, so its effect can't be seen in this log`;
  return "Notch centre at the median headspeed";
}
</script>
