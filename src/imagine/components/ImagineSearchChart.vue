<template>
  <div ref="box" class="relative h-full min-h-0 w-full select-none">
    <svg
      v-if="width > 0 && height > 0"
      :width="width"
      :height="height"
      class="block"
      role="img"
      aria-label="Filter delay against remaining gyro noise for every setup the search tried"
      @pointermove="onMove"
      @pointerleave="onLeave"
      @pointerup="endDrag"
      @click="onClick"
    >
      <!-- grid and axes -->
      <g class="text-[11px]" fill="currentColor">
        <g v-for="t in xTicks" :key="`x${t}`">
          <line :x1="x(t)" :x2="x(t)" :y1="pad.top" :y2="height - pad.bottom" class="stroke-(--ui-border)" stroke-width="1" />
          <text :x="x(t)" :y="height - pad.bottom + 16" text-anchor="middle" class="fill-(--ui-text-muted)">{{ fmt(t) }}</text>
        </g>
        <g v-for="t in yTicks" :key="`y${t}`">
          <line :x1="pad.left" :x2="width - pad.right" :y1="y(t)" :y2="y(t)" class="stroke-(--ui-border)" stroke-width="1" />
          <text :x="pad.left - 6" :y="y(t) + 4" text-anchor="end" class="fill-(--ui-text-muted)">{{ fmt(t) }}</text>
        </g>
        <text :x="pad.left + plotW / 2" :y="height - 6" text-anchor="middle" class="fill-(--ui-text-muted)">
          Filter delay, ms (average {{ delayBand }})
        </text>
        <text :transform="`translate(14 ${pad.top + plotH / 2}) rotate(-90)`" text-anchor="middle" class="fill-(--ui-text-muted)">
          Noise left above {{ result.boundaryHz }} Hz, °/s rms
        </text>
      </g>

      <clipPath id="search-plot-clip">
        <rect :x="pad.left" :y="pad.top" :width="plotW" :height="plotH" />
      </clipPath>

      <g clip-path="url(#search-plot-clip)">
        <!-- every feasible setup the search scored (estimated noise) -->
        <path :d="cloudPath" class="fill-(--ui-text-dimmed)" fill-opacity="0.35" />

        <!-- acceptable noise -->
        <line
          :x1="pad.left"
          :x2="width - pad.right"
          :y1="y(acceptable)"
          :y2="y(acceptable)"
          stroke="var(--ui-warning)"
          stroke-width="1.5"
          stroke-dasharray="6 4"
        />
        <rect
          :x="pad.left"
          :y="y(acceptable) - 6"
          :width="plotW"
          height="12"
          fill="transparent"
          class="cursor-ns-resize"
          @pointerdown.stop="startDrag"
        />

        <!-- verified best trade-off line -->
        <path :d="frontPath" fill="none" stroke="var(--ui-primary)" stroke-width="2" stroke-linejoin="round" />
        <circle
          v-for="p in front"
          :key="p.index"
          :cx="x(p.delayMs)"
          :cy="y(p.noiseRms)"
          r="4.5"
          fill="var(--ui-primary)"
          stroke="var(--ui-bg)"
          stroke-width="2"
        />

        <!-- the log's own settings -->
        <g v-if="logPoint" :transform="`translate(${x(logPoint.delayMs)} ${y(logPoint.noiseRms)})`">
          <rect x="-6" y="-6" width="12" height="12" transform="rotate(45)" :fill="LOG_COLOR" stroke="var(--ui-bg)" stroke-width="2" />
        </g>

        <!-- recommended and selected -->
        <circle v-if="recommended" :cx="x(recommended.delayMs)" :cy="y(recommended.noiseRms)" r="9" fill="none" stroke="var(--ui-primary)" stroke-width="2" />
        <circle v-if="selected" :cx="x(selected.delayMs)" :cy="y(selected.noiseRms)" r="6" :fill="SELECTED_COLOR" stroke="var(--ui-bg)" stroke-width="2" />
      </g>

      <!-- direct labels -->
      <g class="pointer-events-none text-[11px] font-semibold" fill="currentColor" paint-order="stroke" stroke="var(--ui-bg)" stroke-width="4" stroke-linejoin="round">
        <text v-if="logPoint" :x="x(logPoint.delayMs) + 10" :y="y(logPoint.noiseRms) - 10">Your log</text>
        <text
          v-if="recommended && recommended.index !== logPoint?.index"
          :x="x(recommended.delayMs) - 12"
          :y="y(recommended.noiseRms) - 12"
          text-anchor="end"
        >
          Recommended
        </text>
        <text :x="width - pad.right - 4" :y="y(acceptable) - 5" text-anchor="end" class="fill-(--ui-text-muted) font-normal">
          acceptable noise {{ acceptable.toFixed(2) }} °/s (drag)
        </text>
      </g>
    </svg>

    <div
      v-if="hover"
      class="pointer-events-none absolute z-10 max-w-80 rounded border border-default bg-default/95 px-2 py-1 text-xs shadow"
      :style="{ left: `${hover.left}px`, top: `${hover.top}px` }"
    >
      <div class="font-semibold">{{ hover.title }}</div>
      <div class="tabular-nums">{{ hover.point.delayMs.toFixed(2) }} ms delay · {{ hover.point.noiseRms.toFixed(2) }} °/s noise</div>
      <div v-for="c in hover.changes" :key="c" class="text-muted">{{ c }}</div>
    </div>
  </div>
</template>

<script setup>
// Delay (x) against verified noise (y). Lower left is better. The faint dots are every setup the
// search scored with the fast estimate; the line joins the verified setups nothing else beats on
// both noise and delay.
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

const LOG_COLOR = "#4dabf7"; // the spectrum's "Logged filtered" colour
const SELECTED_COLOR = "#ff9f40"; // the spectrum's "Imagined" colour

const props = defineProps({
  result: { type: Object, required: true },
  front: { type: Array, required: true },
  logPoint: { type: Object, default: null },
  recommended: { type: Object, default: null },
  selected: { type: Object, default: null },
  acceptable: { type: Number, required: true },
  describe: { type: Function, required: true }, // point -> list of change strings
});
const emit = defineEmits(["select", "update:acceptable"]);

const box = ref(null);
const width = ref(0);
const height = ref(0);
const pad = { left: 52, right: 16, top: 14, bottom: 40 };
const plotW = computed(() => Math.max(10, width.value - pad.left - pad.right));
const plotH = computed(() => Math.max(10, height.value - pad.top - pad.bottom));

let observer = null;
onMounted(() => {
  observer = new ResizeObserver(([entry]) => {
    width.value = Math.floor(entry.contentRect.width);
    height.value = Math.floor(entry.contentRect.height);
  });
  observer.observe(box.value);
});
onBeforeUnmount(() => observer?.disconnect());

const delayBand = computed(() => {
  const f = props.result.delayHz;
  return f.length > 1 ? `${f[0]}–${f[f.length - 1]} Hz` : `at ${f[0]} Hz`;
});

// Axis ranges: the verified points, the log, and the acceptable noise, with some room
const domain = computed(() => {
  const pts = [...props.front, props.logPoint].filter(Boolean);
  let maxDelay = 0;
  let maxNoise = props.acceptable;
  for (const p of pts) {
    maxDelay = Math.max(maxDelay, p.delayMs);
    maxNoise = Math.max(maxNoise, p.noiseRms);
  }
  return { x: [0, niceCeil(maxDelay * 1.12 || 1)], y: [0, niceCeil(maxNoise * 1.12 || 1)] };
});

function niceStep(span, count) {
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
}
function niceCeil(v) {
  const step = niceStep(v, 5);
  return Math.ceil(v / step) * step;
}
function ticks([lo, hi], count) {
  const step = niceStep(hi - lo, count);
  const out = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + 1e-9; t += step) out.push(Math.round(t * 1e6) / 1e6);
  return out;
}
const xTicks = computed(() => ticks(domain.value.x, Math.max(2, Math.floor(plotW.value / 80))));
const yTicks = computed(() => ticks(domain.value.y, Math.max(2, Math.floor(plotH.value / 50))));

function x(v) {
  const [a, b] = domain.value.x;
  return pad.left + ((v - a) / (b - a)) * plotW.value;
}
function y(v) {
  const [a, b] = domain.value.y;
  return pad.top + plotH.value - ((v - a) / (b - a)) * plotH.value;
}
function fmt(v) {
  return Math.abs(v) >= 10 ? String(Math.round(v)) : String(Math.round(v * 100) / 100);
}

// One path of small squares for the whole cloud (thousands of points, kept cheap)
const cloudPath = computed(() => {
  const c = props.result.cloud;
  const [x0, x1] = domain.value.x;
  const [y0, y1] = domain.value.y;
  const parts = [];
  const seen = new Set();
  for (let i = 0; i < c.delayMs.length; i++) {
    if (!c.feasible[i]) continue;
    const d = c.delayMs[i];
    const n = c.noiseRms[i];
    if (d < x0 || d > x1 || n < y0 || n > y1) continue;
    const px = Math.round(x(d));
    const py = Math.round(y(n));
    const key = px * 100000 + py;
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(`M${px - 1} ${py - 1}h2v2h-2z`);
  }
  return parts.join("");
});

const frontPath = computed(() => {
  if (!props.front.length) return "";
  // staircase: a setup's noise holds until the next one
  let d = "";
  props.front.forEach((p, i) => {
    const px = x(p.delayMs);
    const py = y(p.noiseRms);
    d += i === 0 ? `M${px} ${py}` : `H${px}V${py}`;
  });
  return d;
});

// hover and click on verified points
const hover = ref(null);
const dragging = ref(false);

function pointerPos(event) {
  const rect = box.value.getBoundingClientRect();
  return { mx: event.clientX - rect.left, my: event.clientY - rect.top };
}

function nearest(mx, my) {
  const pts = [...props.front, props.logPoint].filter(Boolean);
  let best = null;
  let bestD = 14 * 14;
  for (const p of pts) {
    const d = (x(p.delayMs) - mx) ** 2 + (y(p.noiseRms) - my) ** 2;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

function yToNoise(my) {
  const [a, b] = domain.value.y;
  return a + ((pad.top + plotH.value - my) / plotH.value) * (b - a);
}

let justDragged = false;
function startDrag(event) {
  dragging.value = true;
  event.currentTarget?.setPointerCapture?.(event.pointerId);
}
function endDrag() {
  if (dragging.value) justDragged = true;
  dragging.value = false;
}

function onMove(event) {
  const { mx, my } = pointerPos(event);
  if (dragging.value) {
    if (event.buttons === 0) {
      dragging.value = false;
    } else {
      const v = Math.max(0, Math.min(domain.value.y[1], yToNoise(my)));
      emit("update:acceptable", Math.round(v * 100) / 100);
      hover.value = null;
      return;
    }
  }
  const p = nearest(mx, my);
  if (!p) {
    hover.value = null;
    return;
  }
  const isLog = p === props.logPoint;
  hover.value = {
    point: p,
    title: isLog ? "Your log's settings" : p === props.recommended ? "Recommended setup" : "Verified setup",
    changes: isLog ? [] : props.describe(p),
    left: Math.min(mx + 14, width.value - 240),
    top: Math.max(4, my - 50),
  };
}

function onLeave() {
  hover.value = null;
}

function onClick(event) {
  if (dragging.value || justDragged) {
    justDragged = false;
    return;
  }
  const { mx, my } = pointerPos(event);
  const p = nearest(mx, my);
  if (p) emit("select", p.index);
}
</script>
