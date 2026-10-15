<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-default px-3 py-2">
      <div class="flex items-center gap-1" role="group" aria-label="Axis">
        <UButton
          v-for="(name, index) in AXIS_NAMES"
          :key="name"
          :label="name"
          size="xs"
          :color="store.axis === index ? 'primary' : 'neutral'"
          :variant="store.axis === index ? 'solid' : 'outline'"
          @click="store.axis = index"
        />
      </div>

      <div class="flex items-center gap-1" role="group" aria-label="Scale">
        <UButton
          v-for="m in MODES"
          :key="m.id"
          :label="m.label"
          size="xs"
          :title="m.title"
          :color="mode === m.id ? 'primary' : 'neutral'"
          :variant="mode === m.id ? 'soft' : 'ghost'"
          @click="mode = m.id"
        />
      </div>

      <div class="flex items-center gap-3 text-xs">
        <UCheckbox
          v-model="analyserStyle"
          label="Match Analyser"
          :title="analyserStyleTitle"
          :disabled="mode === 'db'"
        />
        <UCheckbox
          v-model="show.bars"
          label="Bars"
          title="Show the unfiltered spectrum as bars behind the lines"
          :disabled="mode === 'db'"
        />
        <UCheckbox v-model="show.unfiltered" label="Unfiltered line" :disabled="mode === 'db'" />
        <UCheckbox v-model="show.imagined" :disabled="!store.imagined">
          <template #label><span :style="{ color: CURVE_STYLE.imagined.color }">Imagined</span></template>
        </UCheckbox>
        <UCheckbox v-model="show.logged" :disabled="!store.data?.logged">
          <template #label><span :style="{ color: CURVE_STYLE.logged.color }">Logged filtered</span></template>
        </UCheckbox>
      </div>

      <div class="flex items-center gap-2 text-xs text-muted">
        <span>Zoom X</span>
        <USlider v-model="zoomX" :min="100" :max="500" :step="10" class="w-24" @dblclick="zoomX = 100" />
        <template v-if="mode === 'linear'">
          <span>Zoom Y</span>
          <USlider v-model="zoomY" :min="10" :max="1000" :step="10" class="w-24" @dblclick="zoomY = 100" />
        </template>
      </div>

      <span class="ml-auto text-xs text-dimmed">Hold Shift for harmonics, Ctrl for rotor lines</span>
    </div>

    <div ref="container" class="relative min-h-0 flex-1 bg-black">
      <canvas ref="canvas" class="absolute inset-0" @mousemove="onMouseMove" @mouseleave="onMouseLeave" />
      <canvas ref="overlay" class="pointer-events-none absolute inset-0" />
      <div
        v-if="hover"
        class="pointer-events-none absolute top-2 rounded bg-neutral-900/85 px-2 py-1 font-mono text-xs leading-tight text-white"
        :style="{ left: `${hover.left}px` }"
      >
        <div class="text-sm font-semibold">{{ hover.hz.toFixed(1) }} Hz</div>
        <div class="text-neutral-300">{{ Math.round(hover.hz * 60) }} rpm</div>
        <div v-if="hover.harmonic" class="text-neutral-300">{{ hover.harmonic.toFixed(2) }} × main rotor</div>
      </div>
      <div
        v-if="store.settingsDirty && store.imagined"
        class="pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 rounded bg-warning/90 px-3 py-1 text-xs font-semibold text-black"
      >
        Settings changed. Press Imagine to update the orange curve.
      </div>
      <div
        v-if="busy"
        class="pointer-events-none absolute right-3 top-2 rounded bg-neutral-800/80 px-2 py-1 text-xs text-white"
      >
        Computing spectrum…
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useSettingsStore } from "../../stores/settings.js";
import { GraphSpectrumPlot, SPECTRUM_OVERDRAW_TYPE, SPECTRUM_TYPE } from "../../graph_spectrum_plot.js";
import { AXIS_NAMES, useImagineStore } from "../imagine_store.js";
import { buildSpectrumView, CURVE_STYLE, markerSysConfig } from "../spectrum_view.js";
import { dynNotchStats, notchLowerCutoff } from "../dyn_notch_overlay.js";

const store = useImagineStore();
const container = ref(null);
const canvas = ref(null);
const overlay = ref(null);
const show = reactive({ bars: true, unfiltered: false, imagined: true, logged: false });
const zoomX = ref(100);
const zoomY = ref(100);
const busy = ref(false);
const MODES = [
  { id: "linear", label: "Linear", title: "Amplitude spectrum, like the Analyser's Frequency view" },
  { id: "db", label: "dB", title: "Power spectral density in dB: easier to read how much each filter removes" },
];
const mode = ref("linear");

// "Match Analyser": draw the Linear view the way the main Analyser does (its Hanning setting, no
// average removal, absolute scale that clips big peaks). Remembered per browser.
const settingsStore = useSettingsStore();
const ANALYSER_STYLE_KEY = "imagine.matchAnalyser";
function readAnalyserStylePref() {
  try {
    return globalThis.localStorage?.getItem(ANALYSER_STYLE_KEY) === "1";
  } catch {
    return false;
  }
}
const analyserStyle = ref(readAnalyserStylePref());
watch(analyserStyle, (on) => {
  try {
    globalThis.localStorage?.setItem(ANALYSER_STYLE_KEY, on ? "1" : "0");
  } catch {
    // storage unavailable: the choice is just not remembered
  }
});
const analyserStyleTitle = computed(
  () =>
    `Draw like the main Analyser: Hanning window ${settingsStore.userSettings.analyserHanning ? "on" : "off"} ` +
    "(from User Settings), no average removal and an absolute scale where big peaks clip. " +
    "Off: Hann window and the tallest peak scaled to fit.",
);
let hasData = false;
let resizeObserver = null;
let mouseActive = false;

function draw() {
  if (hasData) GraphSpectrumPlot.draw();
  drawDynNotchOverlay();
}

// ---- Dynamic notch overlay ----
// Shaded band: the range the dynamic notches may move in (current settings).
// Triangles: each notch at its median tracked position over the analysed range, drawn like the
// static notches (cutoff, centre, mirrored cutoff) with its own Q (Q + 0.2 per extra notch).
// Strip along the bottom: how much time the notches spent at each frequency.
const DYN_COLOR = "217, 70, 239";

const dynStats = computed(() => {
  const result = store.imagined;
  if (!result?.dynNotchCenters || !result.dynNotchCount || !store.rates) return null;
  return dynNotchStats(
    result.dynNotchCenters,
    result.dynNotchCount,
    store.axis,
    store.range.start,
    store.range.end,
    store.rates.pidRateHz / 2,
  );
});

function drawDynNotchOverlay() {
  const c = overlay.value;
  if (!c || !canvas.value) return;
  if (c.width !== canvas.value.width || c.height !== canvas.value.height) {
    c.width = canvas.value.width;
    c.height = canvas.value.height;
  }
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, c.width, c.height);
  if (!hasData || !store.showDynNotchOverlay || !store.rates) return;

  const dn = store.settings.dynNotch;
  const stats = dynStats.value;
  if (!dn?.enabled && !stats) return;

  const marginLeft = GraphSpectrumPlot._getActualMarginLeft();
  const W = c.width - marginLeft;
  const H = c.height - 10; // plot MARGIN
  const maxHz = (0.5 * store.rates.logRateHz) / (zoomX.value / 100);
  const xOf = (f) => marginLeft + (f / maxHz) * W;
  ctx.save();
  ctx.font = "11px monospace";
  ctx.textBaseline = "middle";
  // text on a dark box so it stays readable over the bars and the Analyser's own labels
  const label = (text, x, y, alpha = 1) => {
    const w = ctx.measureText(text).width + 6;
    const left = Math.min(Math.max(x, marginLeft + 2), c.width - w - 2);
    ctx.fillStyle = "rgba(0, 0, 0, 0.75)";
    ctx.fillRect(left, y - 7, w, 14);
    ctx.fillStyle = `rgba(${DYN_COLOR}, ${alpha})`;
    ctx.fillText(text, left + 3, y);
  };

  // range band for the current settings
  if (dn?.enabled) {
    const min = Math.max(dn.minHz, 10);
    const max = Math.min(Math.max(min, dn.maxHz), store.rates.pidRateHz / 2);
    const x0 = xOf(min);
    const x1 = xOf(max);
    ctx.fillStyle = `rgba(${DYN_COLOR}, 0.08)`;
    ctx.fillRect(x0, 0, x1 - x0, H);
    ctx.strokeStyle = `rgba(${DYN_COLOR}, 0.6)`;
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, 0);
    ctx.lineTo(x0, H);
    ctx.moveTo(x1, 0);
    ctx.lineTo(x1, H);
    ctx.stroke();
    ctx.setLineDash([]);
    const note = stats ? "" : " · press Imagine to see the notches";
    label(`Dynamic notch range ${min}–${max} Hz${note}`, x0 + 4, 12);
  }

  // tracked notches from the last Imagine run
  if (stats && store.imaginedSettings) {
    const q0 = store.imaginedSettings.dynNotch.q / 10;
    const dirty = store.settingsDirty;
    // one label line per notch, in frequency order, so neighbouring notches don't collide
    const order = stats.medians.map((f, p) => ({ f, p })).sort((a, b) => a.f - b.f);
    order.forEach(({ f, p }, row) => {
      const q = q0 + p * 0.2;
      const cutoff = notchLowerCutoff(f, q);
      // below the Analyser's own marker labels, which stack from the top in 15 px rows
      const apexY = 105 + row * 15;
      ctx.strokeStyle = `rgba(${DYN_COLOR}, ${dirty ? 0.45 : 0.9})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(xOf(cutoff), H);
      ctx.lineTo(xOf(f), apexY);
      ctx.lineTo(xOf(2 * f - cutoff), H);
      ctx.stroke();
      label(`DN${p + 1} ${f.toFixed(0)} Hz Q${q.toFixed(1)}`, xOf(f) + 4, apexY, dirty ? 0.6 : 1);
    });

    // time spent at each frequency
    if (stats.maxBin > 0) {
      const binW = Math.max(1, (stats.binHz / maxHz) * W);
      for (let b = 0; b < stats.histogram.length; b++) {
        const v = stats.histogram[b];
        if (!v) continue;
        ctx.fillStyle = `rgba(${DYN_COLOR}, ${0.15 + 0.85 * (v / stats.maxBin)})`;
        ctx.fillRect(xOf(b * stats.binHz), H - 7, binW, 7);
      }
    }
    if (dirty) {
      label("Dynamic notches from the last Imagine run", marginLeft + 4, H - 16, 0.8);
    }
  }
  ctx.restore();
}

function resize() {
  const el = container.value;
  if (!el || !canvas.value) return;
  const width = Math.max(1, Math.floor(el.clientWidth));
  const height = Math.max(1, Math.floor(el.clientHeight));
  GraphSpectrumPlot.setSize(width, height);
  draw();
}

function rebuild() {
  if (!store.data || !store.rates) return;
  busy.value = true;
  // let the "computing" badge paint before the FFTs block the thread
  requestAnimationFrame(() => {
    try {
      const view = buildSpectrumView({
        data: store.data,
        imagined: store.imagined,
        axis: store.axis,
        range: store.range,
        rateHz: store.rates.logRateHz,
        show,
        mode: mode.value,
        analyserStyle: analyserStyle.value ? { hanning: !!settingsStore.userSettings.analyserHanning } : null,
      });
      GraphSpectrumPlot.curvesColors = view.colors.length ? view.colors : ["White"];
      GraphSpectrumPlot.setData(
        view.fftData,
        mode.value === "db" ? SPECTRUM_TYPE.POWER_SPECTRAL_DENSITY : SPECTRUM_TYPE.FREQUENCY,
      );
      GraphSpectrumPlot.setOverlayCurves(view.curves);
      hasData = true;
      draw();
    } finally {
      busy.value = false;
    }
  });
}

function updateMarkers() {
  GraphSpectrumPlot.setSysConfig(markerSysConfig(store.settings));
  draw();
}

// Frequency under the mouse, shown in the top left of the chart. The plot's x axis runs from 0 Hz
// at its left margin to (log rate / 2) / zoom at the right edge.
const hover = ref(null);

function updateHover(e) {
  if (!hasData || !store.rates || !canvas.value) {
    hover.value = null;
    return;
  }
  const rect = canvas.value.getBoundingClientRect();
  const marginLeft = GraphSpectrumPlot._getActualMarginLeft();
  const width = canvas.value.width - marginLeft;
  const x = e.clientX - rect.left - marginLeft;
  if (width <= 0 || x < 0) {
    hover.value = null;
    return;
  }
  const maxHz = (0.5 * store.rates.logRateHz) / (zoomX.value / 100);
  const hz = (x / width) * maxHz;
  const head = store.rotorSpeeds?.head;
  hover.value = {
    hz,
    harmonic: head ? hz / (head / 60) : null,
    left: marginLeft + 8,
  };
}

function onMouseLeave() {
  hover.value = null;
  clearMouse();
}

function onMouseMove(e) {
  updateHover(e);
  const ratios = store.rotor;
  const ctrlActive = e.ctrlKey && ratios?.mainGearRatio && ratios?.tailPerHead;
  if (e.shiftKey || ctrlActive) {
    const rect = canvas.value.getBoundingClientRect();
    const mode = ctrlActive ? "gearRatio" : "harmonics";
    if (mode === "gearRatio") {
      GraphSpectrumPlot.setRotorGearRatios({ main: 1 / ratios.mainGearRatio, tail: ratios.tailPerHead });
    }
    GraphSpectrumPlot.setMousePosition(e.clientX - rect.left, e.clientY - rect.top, mode);
    mouseActive = true;
    draw();
  } else if (mouseActive) {
    clearMouse();
  }
}

function clearMouse() {
  if (!mouseActive) return;
  mouseActive = false;
  GraphSpectrumPlot.setMousePosition(0, 0);
  draw();
}

watch(
  () => [store.data, store.imagined, store.axis, store.range.start, store.range.end, show.unfiltered, show.imagined, show.logged, mode.value, analyserStyle.value],
  rebuild,
);
watch(() => store.settings, updateMarkers, { deep: true });
watch(() => [store.showDynNotchOverlay, dynStats.value], () => drawDynNotchOverlay());
watch(
  () => show.bars,
  (visible) => {
    GraphSpectrumPlot.setShowMainBars(visible);
    draw();
  },
);
watch(zoomX, (v) => {
  GraphSpectrumPlot.setZoom(v / 100, 100 / zoomY.value);
  GraphSpectrumPlot.setMousePosition(0, 0);
  draw();
});
watch(zoomY, (v) => {
  GraphSpectrumPlot.setZoom(zoomX.value / 100, 100 / v);
  draw();
});

onMounted(() => {
  GraphSpectrumPlot.initialize(canvas.value, markerSysConfig(store.settings));
  GraphSpectrumPlot.setOverdraw(SPECTRUM_OVERDRAW_TYPE.GYRO_FILTERS);
  GraphSpectrumPlot.setFullScreen(true);
  GraphSpectrumPlot.setShowMainBars(show.bars);
  resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(container.value);
  resize();
  rebuild();
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
});
</script>
