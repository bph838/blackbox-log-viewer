<template>
  <div class="border-t border-default">
    <div class="flex items-center gap-1 px-3 py-1">
      <UButton
        v-for="tab in tabs"
        :key="tab.id"
        :label="tab.label"
        size="xs"
        :color="active === tab.id && open ? 'primary' : 'neutral'"
        :variant="active === tab.id && open ? 'soft' : 'ghost'"
        @click="select(tab.id)"
      />
      <span class="ml-2 text-xs text-dimmed">{{ AXIS_NAMES[store.axis] }} axis</span>
      <UButton
        class="ml-auto"
        :icon="open ? 'i-lucide-chevron-down' : 'i-lucide-chevron-up'"
        size="xs"
        variant="ghost"
        color="neutral"
        :title="open ? 'Hide results' : 'Show results'"
        @click="open = !open"
      />
    </div>

    <div v-if="open" class="max-h-64 overflow-y-auto px-3 pb-3 text-xs">
      <!-- Filter delay -->
      <template v-if="active === 'delay'">
        <p v-if="!store.delays" class="text-dimmed">Press Imagine to compare the filter delay of the log settings and the imagined settings.</p>
        <template v-else>
          <table class="w-full max-w-3xl tabular-nums">
            <thead class="text-dimmed">
              <tr>
                <th class="text-left font-normal">Frequency</th>
                <th class="text-right font-normal">Log settings delay</th>
                <th class="text-right font-normal">gain</th>
                <th class="text-right font-normal">Imagined delay</th>
                <th class="text-right font-normal">gain</th>
                <th class="text-right font-normal">Change</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in delayRows" :key="row.f" class="border-t border-default/50">
                <td>{{ row.f }} Hz</td>
                <td class="text-right">{{ row.log.delayMs.toFixed(2) }} ms</td>
                <td class="text-right text-dimmed">{{ fmtDb(row.log.gainDb) }}</td>
                <td class="text-right">{{ row.imagined.delayMs.toFixed(2) }} ms</td>
                <td class="text-right text-dimmed">{{ fmtDb(row.imagined.gainDb) }}</td>
                <td class="text-right" :class="changeClass(row.change)">{{ row.change > 0 ? "+" : "" }}{{ row.change.toFixed(2) }} ms</td>
              </tr>
            </tbody>
          </table>
          <p class="mt-2 text-dimmed">
            Phase delay of the software gyro filters at the median headspeed{{ store.delays.operatingPoint.headRpm ? ` (${Math.round(store.delays.operatingPoint.headRpm)} rpm)` : "" }}
            and the median tracked dynamic notch positions. Lower is better for control response. Notches close to a frequency can
            make its delay negative or jump; read those rows with care.
          </p>
        </template>
      </template>

      <!-- Reproduce check -->
      <template v-else-if="active === 'validation'">
        <p v-if="!store.data?.logged" class="text-dimmed">This log has no filtered gyro (gyroADC), so there is nothing to check against.</p>
        <p v-else-if="!store.validation" class="text-dimmed">
          Press Imagine. The log's own settings are simulated first and compared with the logged filtered gyro.
        </p>
        <template v-else>
          <div class="mb-2 flex flex-wrap gap-4">
            <div v-for="(m, a) in store.validation.axes" :key="a">
              <span class="font-semibold">{{ AXIS_NAMES[a] }}</span>
              <span class="text-dimmed"> correlation </span>{{ m.correlation.toFixed(4) }}
              <span class="text-dimmed"> rms error </span>{{ m.rmsError.toFixed(2) }} °/s
            </div>
          </div>
          <table class="w-full max-w-3xl tabular-nums">
            <thead class="text-dimmed">
              <tr>
                <th class="text-left font-normal">Band</th>
                <th class="text-right font-normal">Unfiltered rms</th>
                <th class="text-right font-normal">Logged filtered</th>
                <th class="text-right font-normal">Simulated</th>
                <th class="text-right font-normal">Difference</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="b in validationAxis.bands" :key="b.fromHz" class="border-t border-default/50">
                <td>{{ b.fromHz }}–{{ b.toHz }} Hz</td>
                <td class="text-right">{{ b.unfilteredRms.toFixed(2) }} °/s</td>
                <td class="text-right">{{ b.loggedRms.toFixed(2) }} <span class="text-dimmed">({{ b.loggedReductionDb.toFixed(1) }} dB)</span></td>
                <td class="text-right">{{ b.simulatedRms.toFixed(2) }} <span class="text-dimmed">({{ b.simulatedReductionDb.toFixed(1) }} dB)</span></td>
                <td class="text-right font-semibold" :class="diffClass(b.differenceDb)">{{ b.differenceDb > 0 ? "+" : "" }}{{ b.differenceDb.toFixed(1) }} dB</td>
              </tr>
            </tbody>
          </table>
          <p class="mt-2 text-dimmed">
            Bands closer to the {{ nyquist }} Hz log Nyquist limit are less reliable: vibration above it is folded into the log at
            the wrong frequency, so the simulation filters it as if it were lower. Expect the best match below about
            {{ Math.round(nyquist * 0.4) }} Hz.
          </p>
          <div v-if="store.validation.dynNotchTracking" class="mt-2">
            <span class="font-semibold">Dynamic notch tracking</span>
            <span class="text-dimmed"> (log debug mode DYN_NOTCH_FREQ, {{ AXIS_NAMES[store.validation.dynNotchTracking.axis] }} axis): </span>
            <span v-for="n in store.validation.dynNotchTracking.perNotch" :key="n.notch" class="mr-3">
              #{{ n.notch }} median error {{ n.medianErrorHz?.toFixed(1) ?? "–" }} Hz
            </span>
          </div>
        </template>
      </template>

      <!-- Details -->
      <template v-else>
        <dl class="grid max-w-3xl grid-cols-[auto_1fr] gap-x-4 gap-y-0.5">
          <dt class="text-dimmed">Firmware</dt>
          <dd>{{ store.firmware?.message }}</dd>
          <dt class="text-dimmed">Ported from</dt>
          <dd>
            rotorflight-firmware {{ FIRMWARE_REFERENCE.branch }} @ {{ FIRMWARE_REFERENCE.commit }} ({{ FIRMWARE_REFERENCE.description }})
          </dd>
          <template v-if="store.rates">
            <dt class="text-dimmed">Loop rates</dt>
            <dd>
              gyro {{ fmtHz(store.rates.gyroRateHz) }}, filters {{ fmtHz(store.rates.filterRateHz) }}, PID {{ fmtHz(store.rates.pidRateHz) }}
            </dd>
            <dt class="text-dimmed">Log rate</dt>
            <dd>
              {{ fmtHz(store.rates.logRateHz) }} from the {{ store.rates.logRateSource }} (timestamps say {{ fmtHz(store.rates.measuredLogRateHz) }}),
              Nyquist {{ nyquist }} Hz
            </dd>
            <dt class="text-dimmed">Simulation</dt>
            <dd>
              log upsampled ×{{ store.rates.upsampleRatio.toFixed(2) }} to the filter rate, filtered, then sampled back at the logged instants
              <template v-if="store.imagined"> ({{ store.imagined.elapsedMs.toFixed(0) }} ms)</template>
            </dd>
          </template>
          <template v-if="store.imagined">
            <dt class="text-dimmed">Active filters</dt>
            <dd>{{ activeFilters }}</dd>
          </template>
          <template v-if="skipped.length">
            <dt class="text-dimmed">Skipped RPM notches</dt>
            <dd>
              <span v-for="sk in skipped" :key="`${sk.axis}-${sk.slot}`" class="mr-3">
                {{ AXIS_NAMES[sk.axis] }} {{ rpmSourceName(sk.source) }}: {{ sk.reason }}
              </span>
            </dd>
          </template>
          <template v-if="store.data">
            <dt class="text-dimmed">Log</dt>
            <dd>
              {{ store.data.count }} samples, longest gap {{ (store.data.maxGapUs / 1000).toFixed(1) }} ms
              <template v-if="store.data.maxGapUs > 3e6 / store.rates.logRateHz">
                (gaps are treated as continuous data)
              </template>
            </dd>
          </template>
        </dl>
      </template>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from "vue";
import { AXIS_NAMES, useImagineStore } from "../imagine_store.js";
import { FIRMWARE_REFERENCE } from "../header_settings.js";
import { rpmSourceName } from "../filters/rpm_filter.js";

const store = useImagineStore();
const open = ref(true);
const active = ref("delay");
const tabs = [
  { id: "delay", label: "Filter delay" },
  { id: "validation", label: "Reproduce check" },
  { id: "details", label: "Details" },
];

const nyquist = computed(() => Math.round((store.rates?.logRateHz ?? 0) / 2));

function select(id) {
  if (active.value === id) {
    open.value = !open.value;
  } else {
    active.value = id;
    open.value = true;
  }
}

const delayRows = computed(() => {
  const axis = store.delays?.axes[store.axis];
  if (!axis) return [];
  return store.delays.frequencies.map((f, i) => ({
    f,
    log: axis.log[i],
    imagined: axis.imagined[i],
    change: axis.imagined[i].delayMs - axis.log[i].delayMs,
  }));
});

const validationAxis = computed(() => store.validation?.axes[store.axis] ?? { bands: [] });

const activeFilters = computed(() => {
  const c = store.imagined?.chain;
  if (!c) return "";
  const parts = [];
  if (c.rpm) parts.push(`RPM notches (${c.rpmBankCount})`);
  if (c.lpf2) parts.push("LPF2");
  if (c.lpf1) parts.push(c.dynLpf ? "LPF1 (dynamic)" : "LPF1");
  if (c.notch2) parts.push("notch 2");
  if (c.notch1) parts.push("notch 1");
  if (c.dynNotch) parts.push("dynamic notch");
  if (c.dynNotchDisabledReason) parts.push(`dynamic notch off: ${c.dynNotchDisabledReason}`);
  return parts.join(" → ") || "none";
});

const skipped = computed(() => store.imagined?.chain?.rpmSkipped ?? []);

function fmtHz(v) {
  return `${Math.round(v * 10) / 10} Hz`;
}

function fmtDb(v) {
  return Number.isFinite(v) ? `${v.toFixed(1)} dB` : "–";
}

function changeClass(v) {
  if (Math.abs(v) < 0.05) return "text-dimmed";
  return v > 0 ? "text-warning" : "text-success";
}

function diffClass(v) {
  const a = Math.abs(v);
  if (a < 2) return "text-success";
  if (a < 6) return "text-warning";
  return "text-error";
}
</script>
