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
      <canvas ref="canvas" class="absolute inset-0" @mousemove="onMouseMove" @mouseleave="clearMouse" />
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
import { onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { GraphSpectrumPlot, SPECTRUM_OVERDRAW_TYPE, SPECTRUM_TYPE } from "../../graph_spectrum_plot.js";
import { AXIS_NAMES, useImagineStore } from "../imagine_store.js";
import { buildSpectrumView, CURVE_STYLE, markerSysConfig } from "../spectrum_view.js";

const store = useImagineStore();
const container = ref(null);
const canvas = ref(null);
const show = reactive({ unfiltered: false, imagined: true, logged: true });
const zoomX = ref(100);
const zoomY = ref(100);
const busy = ref(false);
const MODES = [
  { id: "linear", label: "Linear", title: "Amplitude spectrum, like the Analyser's Frequency view" },
  { id: "db", label: "dB", title: "Power spectral density in dB: easier to read how much each filter removes" },
];
const mode = ref("linear");
let hasData = false;
let resizeObserver = null;
let mouseActive = false;

function draw() {
  if (hasData) GraphSpectrumPlot.draw();
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

function onMouseMove(e) {
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
  () => [store.data, store.imagined, store.axis, store.range.start, store.range.end, show.unfiltered, show.imagined, show.logged, mode.value],
  rebuild,
);
watch(() => store.settings, updateMarkers, { deep: true });
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
  resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(container.value);
  resize();
  rebuild();
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
});
</script>
