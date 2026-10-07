<template>
  <!-- Redraws a saved isolated-flight slice (see flight_slice.js) from its CSV, so the block the
       user isolated can be seen on any Tuning Log entry, with or without the flight log open.
       Drawn on black with the workspace's line colours to match the main graph. -->
  <div class="flex flex-col gap-1">
    <div v-if="!strips.length" class="text-xs text-dimmed">No numeric fields to draw in this slice.</div>

    <div
      v-else
      ref="plotEl"
      class="relative rounded border border-default bg-black select-none"
      @mousemove="onMouseMove"
      @mouseleave="hoverIndex = null"
    >
      <div v-for="strip in strips" :key="strip.graph" class="relative" :style="{ height: `${STRIP_HEIGHT}px` }">
        <svg
          :viewBox="`0 0 ${VIEW_WIDTH} ${STRIP_HEIGHT}`"
          preserveAspectRatio="none"
          class="absolute inset-0 w-full h-full"
        >
          <line
            x1="0"
            :x2="VIEW_WIDTH"
            :y1="STRIP_HEIGHT / 2"
            :y2="STRIP_HEIGHT / 2"
            stroke="#555"
            stroke-dasharray="4 4"
            vector-effect="non-scaling-stroke"
          />
          <path
            v-for="line in strip.lines"
            :key="line.name"
            :d="line.path"
            :stroke="line.color"
            fill="none"
            stroke-width="1.25"
            stroke-linejoin="round"
            vector-effect="non-scaling-stroke"
          />
        </svg>
        <div class="absolute top-0.5 left-1 text-[10px] leading-tight text-neutral-400 pointer-events-none">
          <span class="text-neutral-200">{{ strip.graph || "Fields" }}</span>
          <span v-for="scale in strip.scales" :key="scale.unit"> · ±{{ formatValue(scale.max) }}{{ scale.unit ? ` ${scale.unit}` : "" }}</span>
        </div>
      </div>

      <div class="relative h-4 border-t border-neutral-800 text-[10px] text-neutral-400">
        <span
          v-for="tick in timeTicks"
          :key="tick.t"
          class="absolute top-0.5 -translate-x-1/2"
          :style="{ left: `${tick.pct}%` }"
          >{{ tick.label }}</span
        >
      </div>

      <div
        v-if="hoverIndex !== null"
        class="absolute top-0 bottom-4 w-px bg-red-500/80 pointer-events-none"
        :style="{ left: `${hoverPct}%` }"
      />
    </div>

    <div v-if="strips.length" class="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
      <span class="text-dimmed tabular-nums">{{ hoverIndex === null ? "Hover for values" : `t = ${formatSeconds(times[hoverIndex])}` }}</span>
      <button
        v-for="series in allSeries"
        :key="series.name"
        type="button"
        class="flex items-center gap-1 cursor-pointer"
        :class="{ 'opacity-40 line-through': hidden.has(series.name) }"
        :title="hidden.has(series.name) ? 'Show this field' : 'Hide this field'"
        @click="toggle(series.name)"
      >
        <span class="inline-block w-2.5 h-2.5 rounded-sm" :style="{ background: series.color }" />
        {{ series.label }}
        <span v-if="hoverIndex !== null && series.values[hoverIndex] !== null" class="tabular-nums text-dimmed">
          {{ formatValue(series.values[hoverIndex]) }}{{ series.unit ? ` ${series.unit}` : "" }}
        </span>
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from "vue";
import { parseSliceSeries, decimateMinMax } from "../flight_slice.js";
import { GraphConfig } from "../graph_config.js";

const props = defineProps({
  slice: { type: Object, required: true },
});

const VIEW_WIDTH = 1000;
const STRIP_HEIGHT = 110;
// Each strip keeps a little headroom so peaks don't touch the strip edges
const STRIP_PADDING = 8;
// min/max buckets per line - comfortably more than the chart's pixel width
const DECIMATE_BUCKETS = 800;

const parsed = computed(() => parseSliceSeries(props.slice));
const times = computed(() => parsed.value.times);

// Fall back to the graph palette for slices saved before field colours were kept
const allSeries = computed(() =>
  parsed.value.series.map((series, i) => ({
    ...series,
    color: series.color || GraphConfig.PALETTE[i % GraphConfig.PALETTE.length].color,
  })),
);

const hidden = ref(new Set());

function toggle(name) {
  const next = new Set(hidden.value);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  hidden.value = next;
}

const durationMs = computed(() => {
  const last = times.value[times.value.length - 1] ?? 0;
  return Math.max(props.slice.durationMs || 0, last) || 1;
});

// One strip per workspace graph. Like the main graph each strip is centred on zero, and fields
// that share a unit share a scale (so setpoint and gyro line up), with one scale per unit.
const strips = computed(() => {
  const groups = new Map();
  for (const series of allSeries.value) {
    if (!groups.has(series.graph)) groups.set(series.graph, []);
    groups.get(series.graph).push(series);
  }

  const half = STRIP_HEIGHT / 2 - STRIP_PADDING;
  const xScale = VIEW_WIDTH / durationMs.value;

  return [...groups.entries()].map(([graph, seriesList]) => {
    const visible = seriesList.filter((series) => !hidden.value.has(series.name));

    const maxByUnit = new Map();
    for (const series of visible) {
      let max = maxByUnit.get(series.unit) || 0;
      for (const value of series.values) {
        if (value !== null && Math.abs(value) > max) max = Math.abs(value);
      }
      maxByUnit.set(series.unit, max);
    }

    const lines = visible.map((series) => {
      const max = maxByUnit.get(series.unit) || 1;
      const points = decimateMinMax(times.value, series.values, DECIMATE_BUCKETS);
      const path = points
        .map((p, i) => `${i ? "L" : "M"}${(p.t * xScale).toFixed(1)},${(STRIP_HEIGHT / 2 - (p.v / max) * half).toFixed(1)}`)
        .join("");
      return { name: series.name, color: series.color, path };
    });

    const scales = [...maxByUnit.entries()].map(([unit, max]) => ({ unit, max }));
    return { graph, lines, scales };
  });
});

function niceStep(rough) {
  const pow = 10 ** Math.floor(Math.log10(rough));
  const unit = rough / pow;
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * pow;
}

// Time from the start of the isolated block - the same t_ms the AI was given
const timeTicks = computed(() => {
  const step = niceStep(durationMs.value / 8);
  const ticks = [];
  for (let t = step; t < durationMs.value - step / 4; t += step) {
    ticks.push({ t, pct: (t / durationMs.value) * 100, label: formatSeconds(t) });
  }
  return ticks;
});

function formatSeconds(ms) {
  return `${(ms / 1000).toFixed(ms < 10000 && ms % 1000 ? 2 : 1)} s`;
}

function formatValue(value) {
  const abs = Math.abs(value);
  return String(Number(value.toFixed(abs >= 100 ? 0 : abs >= 10 ? 1 : 2)));
}

// ---- Hover readout ----

const plotEl = ref(null);
const hoverIndex = ref(null);

const hoverPct = computed(() =>
  hoverIndex.value === null ? 0 : (times.value[hoverIndex.value] / durationMs.value) * 100,
);

function nearestIndex(t) {
  const list = times.value;
  let lo = 0;
  let hi = list.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 && t - list[lo - 1] < list[lo] - t ? lo - 1 : lo;
}

function onMouseMove(e) {
  if (!plotEl.value || !times.value.length) return;
  const rect = plotEl.value.getBoundingClientRect();
  const fraction = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  hoverIndex.value = nearestIndex(fraction * durationMs.value);
}
</script>
