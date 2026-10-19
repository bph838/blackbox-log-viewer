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
        <UButton
          icon="i-lucide-rotate-ccw"
          label="Reset"
          size="xs"
          variant="ghost"
          color="neutral"
          :disabled="zoomX === 100 && zoomY === 100"
          title="Put both zooms back to 100%"
          @click="resetZoom"
        />
      </div>

      <span class="ml-auto text-xs text-dimmed">
        <template v-if="zoomed">Drag or scroll to move around · </template>Hold Shift for harmonics, Ctrl for rotor lines
      </span>
    </div>

    <div ref="container" class="relative min-h-0 flex-1 bg-black">
      <!-- Zoomed in, the plot is drawn larger than the view and scrolls (see layout()) -->
      <div
        ref="scroller"
        class="spectrum-scroller absolute inset-0"
        :class="zoomed ? 'overflow-auto' : 'overflow-hidden'"
        @wheel="onWheel"
        @scroll="onScroll"
      >
        <div class="relative" :style="{ width: `${plotSize.width}px`, height: `${plotSize.height}px` }">
          <canvas
            ref="canvas"
            class="absolute inset-0"
            :class="{ 'cursor-grab': zoomed && !panning, 'cursor-grabbing': panning }"
            @mousemove="onMouseMove"
            @mouseleave="onMouseLeave"
            @pointerdown="startPan"
          />
          <canvas ref="overlay" class="pointer-events-none absolute inset-0" />
        </div>
      </div>
      <!-- the plot's own frequency labels are at its bottom: pinned here while scrolled up from it -->
      <div
        v-if="ruler.length"
        class="pointer-events-none absolute inset-x-0 h-5 bg-black/70 font-mono text-[11px] text-white"
        :style="{ bottom: `${scrollbarSize || 0}px` }"
      >
        <span v-for="t in ruler" :key="t.hz" class="absolute top-0.5 -translate-x-1/2" :style="{ left: `${t.x}px` }">{{ t.hz }}Hz</span>
      </div>
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
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useSettingsStore } from "../../stores/settings.js";
import { GraphSpectrumPlot, SPECTRUM_OVERDRAW_TYPE, SPECTRUM_TYPE } from "../../graph_spectrum_plot.js";
import { AXIS_NAMES, useImagineStore } from "../imagine_store.js";
import { buildSpectrumView, CURVE_STYLE, markerSysConfig } from "../spectrum_view.js";
import { dynNotchStats, notchLowerCutoff } from "../dyn_notch_overlay.js";
import { rpmNotchMarkers } from "../rpm_overlay.js";

const store = useImagineStore();
const container = ref(null);
const scroller = ref(null);
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
const hasPlot = ref(false); // hasData, for computeds
let resizeObserver = null;
let mouseActive = false;

function draw() {
  if (hasData) GraphSpectrumPlot.draw();
  drawOverlays();
}

// ---- Overlays drawn over the plot: RPM notches and the dynamic notch ----
const DYN_COLOR = "217, 70, 239";
const RPM_COLOR = "34, 211, 238";

// Dynamic notch: where each simulated notch sat (needs an Imagine run)
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

// RPM notches: from the current settings, so they move as they're edited (no Imagine needed)
const rpmMarkers = computed(() => {
  if (!store.rates || !store.settings?.rpm) return [];
  return rpmNotchMarkers({
    settings: store.settings,
    axis: store.axis,
    speeds: store.rotorSpeeds,
    range: store.rotorSpeedRange,
    rotor: store.rotor,
    filterRateHz: store.rates.filterRateHz,
  });
});

function drawOverlays() {
  const c = overlay.value;
  if (!c || !canvas.value) return;
  if (c.width !== canvas.value.width || c.height !== canvas.value.height) {
    c.width = canvas.value.width;
    c.height = canvas.value.height;
  }
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, c.width, c.height);
  if (!hasData || !store.rates) return;

  const marginLeft = GraphSpectrumPlot._getActualMarginLeft();
  const W = c.width - marginLeft;
  const g = {
    ctx,
    marginLeft,
    W,
    H: c.height - 10, // plot MARGIN
    maxHz: 0.5 * store.rates.logRateHz, // the whole plot; zooming makes it wider instead
  };
  g.xOf = (f) => marginLeft + (f / g.maxHz) * W;
  // text on a dark box so it stays readable over the bars and the Analyser's own labels
  g.label = (text, x, y, color, alpha = 1) => {
    const w = ctx.measureText(text).width + 6;
    const left = Math.min(Math.max(x, marginLeft + 2), c.width - w - 2);
    ctx.fillStyle = "rgba(0, 0, 0, 0.75)";
    ctx.fillRect(left, y - 7, w, 14);
    ctx.fillStyle = `rgba(${color}, ${alpha})`;
    ctx.fillText(text, left + 3, y);
  };

  ctx.save();
  ctx.font = "11px monospace";
  ctx.textBaseline = "middle";
  if (store.chartOverlays.rpmMin) drawRpmMinimum(g);
  if (store.chartOverlays.rpm) drawRpmNotches(g);
  if (store.chartOverlays.dynNotch) drawDynNotch(g);
  ctx.restore();
}

// The RPM filter's Minimum Frequency: below the line notches are off (parked at the minimum),
// and in the shaded zone up to 1.25x it they fade in, so a harmonic there is only partly removed.
function drawRpmMinimum(g) {
  const rpm = store.settings?.rpm;
  if (!rpm?.enabled) return;
  const { ctx, H, xOf } = g;
  const maxNotchHz = 0.45 * store.rates.filterRateHz;
  const minHz = Math.min(Math.max(rpm.minHz, 10), 0.5 * maxNotchHz);
  const fadeHz = 1.25 * minHz;
  if (minHz > g.maxHz) return;
  const x0 = xOf(minHz);
  const x1 = xOf(Math.min(fadeHz, g.maxHz));
  const grad = ctx.createLinearGradient(x0, 0, x1, 0);
  grad.addColorStop(0, `rgba(${RPM_COLOR}, 0.16)`);
  grad.addColorStop(1, `rgba(${RPM_COLOR}, 0.02)`);
  ctx.fillStyle = grad;
  ctx.fillRect(x0, 0, x1 - x0, H);
  ctx.strokeStyle = `rgba(${RPM_COLOR}, 0.7)`;
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 3]);
  ctx.beginPath();
  ctx.moveTo(x0, 0);
  ctx.lineTo(x0, H);
  ctx.stroke();
  ctx.setLineDash([]);
  g.label(`RPM min ${minHz} Hz · fades in to ${fadeHz.toFixed(fadeHz % 1 ? 1 : 0)} Hz`, x0 + 4, H - 46, RPM_COLOR, 0.9);
}

// Each RPM notch as a triangle from its cutoff up to its centre, like the static notches. A notch
// still fading in (just above the RPM Minimum Frequency) is drawn shorter and dashed. A bar under
// each shows how far it moves with the headspeed spread of the flight (10th-90th percentile).
function drawRpmNotches(g) {
  const markers = rpmMarkers.value;
  if (!markers.length) return;
  const { ctx, H, xOf, label } = g;
  const hl = store.rpmHighlight && store.rpmHighlight.axis === store.axis ? store.rpmHighlight : null;
  const isHl = (m) => !!hl && ((hl.sources && hl.sources.includes(m.source)) || (hl.slots && hl.slots.includes(m.slot)));
  const top = 55;

  for (const m of markers) {
    if (m.hz > g.maxHz * 1.02) continue;
    const highlighted = isHl(m);
    const alpha = highlighted ? 1 : hl ? 0.25 : 0.75;
    const apexY = H - (H - top) * (0.3 + 0.7 * m.fader);
    ctx.strokeStyle = `rgba(${RPM_COLOR}, ${alpha})`;
    ctx.lineWidth = highlighted ? 2.5 : 1.5;
    ctx.setLineDash(m.fader < 1 ? [5, 4] : []);
    ctx.beginPath();
    ctx.moveTo(xOf(m.cutoffHz), H);
    ctx.lineTo(xOf(m.hz), apexY);
    ctx.lineTo(xOf(2 * m.hz - m.cutoffHz), H);
    ctx.stroke();
    ctx.setLineDash([]);

    if (m.spread && xOf(m.spread[1]) - xOf(m.spread[0]) >= 1) {
      ctx.fillStyle = `rgba(${RPM_COLOR}, ${highlighted ? 0.8 : hl ? 0.15 : 0.45})`;
      ctx.fillRect(xOf(m.spread[0]), H - 14, Math.max(1, xOf(m.spread[1]) - xOf(m.spread[0])), 4);
    }
  }

  // labels only for the hovered row, so a full bank stays readable
  const labelled = markers.filter(isHl);
  labelled.forEach((m, i) => {
    const fade = m.fader < 1 ? ` · only ${Math.round(m.fader * 100)}% (fading in above ${store.settings.rpm.minHz} Hz)` : "";
    const spread = m.spread ? ` · moves ${m.spread[0].toFixed(0)}–${m.spread[1].toFixed(0)} Hz` : "";
    label(`${m.name} ${m.hz.toFixed(1)} Hz Q${m.q.toFixed(1)}${fade}${spread}`, xOf(m.hz) + 4, H - 44 - i * 15, RPM_COLOR);
  });
  if (!labelled.length) {
    const axisName = ["roll", "pitch", "yaw"][store.axis];
    label(
      `RPM notches (${axisName}) at ${Math.round(store.rotorSpeeds.head)} rpm - hover a notch row to see it`,
      g.marginLeft + 4,
      H - 28,
      RPM_COLOR,
      0.9,
    );
  }
}

// Shaded band: the range the dynamic notches may move in (current settings).
// Triangles: each notch at its median tracked position over the analysed range, drawn like the
// static notches (cutoff, centre, mirrored cutoff) with its own Q (Q + 0.2 per extra notch).
// Strip along the bottom: how much time the notches spent at each frequency.
function drawDynNotch(g) {
  const dn = store.settings.dynNotch;
  const stats = dynStats.value;
  if (!dn?.enabled && !stats) return;
  const { ctx, H, xOf, W, maxHz, marginLeft } = g;
  const label = (text, x, y, alpha = 1) => g.label(text, x, y, DYN_COLOR, alpha);

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
}

// ---- Zoom and scrolling ----
// Rather than the Analyser's zoom (which always shows from 0 Hz and clips tall peaks), the plot
// is drawn zoomX times wider - and in Linear, up to zoomY times taller - than the view, inside a
// scrolling box, so any part of it can be reached. Past MAX_PLOT_PIXELS the extra Y zoom goes back
// to the Analyser's (clipping) zoom, to keep the canvases a sensible size.
const MAX_PLOT_PIXELS = 24e6;
const plotSize = reactive({ width: 1, height: 1 });
const zoomed = computed(() => zoomX.value > 100 || (mode.value === "linear" && zoomY.value > 100));
const panning = ref(false);
const scrollbarSize = ref(null);
const scrollPos = reactive({ left: 0, top: 0, viewW: 0, viewH: 0 });

function onScroll() {
  const sc = scroller.value;
  if (!sc) return;
  scrollPos.left = sc.scrollLeft;
  scrollPos.top = sc.scrollTop;
  scrollPos.viewW = sc.clientWidth;
  scrollPos.viewH = sc.clientHeight;
}

// Frequency labels for the visible part of the plot, at round steps.
const ruler = computed(() => {
  if (!zoomed.value || !store.rates || !hasPlot.value) return [];
  if (plotSize.height - scrollPos.top - scrollPos.viewH < 24) return []; // the plot's own are in view
  const marginLeft = GraphSpectrumPlot._getActualMarginLeft();
  const maxHz = 0.5 * store.rates.logRateHz;
  const hzPerPx = maxHz / Math.max(1, plotSize.width - marginLeft);
  const span = scrollPos.viewW * hzPerPx;
  const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500].find((st) => span / st <= 8) ?? 1000;
  const ticks = [];
  for (let hz = Math.ceil((scrollPos.left - marginLeft) * hzPerPx / step) * step; hz <= maxHz; hz += step) {
    const x = marginLeft + hz / hzPerPx - scrollPos.left;
    if (x > scrollPos.viewW - 20) break;
    if (x >= 20) ticks.push({ hz, x });
  }
  return ticks;
});

// About 5 grid lines per view width, at a round step that divides the whole range (the plot
// spaces its labels evenly from 0 Hz to the end).
function xTickCount(fx) {
  const maxHz = store.rates ? 0.5 * store.rates.logRateHz : 0;
  const want = 5 * fx;
  if (!maxHz) return Math.round(want);
  let best = null;
  for (let t = Math.max(1, Math.floor(want * 0.6)); t <= Math.ceil(want * 1.6); t++) {
    const step = maxHz / t;
    if (!Number.isInteger(step)) continue;
    const roundness = step % 10 === 0 ? 0 : step % 5 === 0 ? 1 : 2;
    const score = roundness * 10 + Math.abs(t - want) / want;
    if (!best || score < best.score) best = { t, score };
  }
  return best ? best.t : Math.round(want);
}

function measureScrollbar() {
  const probe = document.createElement("div");
  probe.className = "spectrum-scroller";
  probe.style.cssText = "position:absolute;visibility:hidden;width:100px;height:100px;overflow:scroll";
  document.body.appendChild(probe);
  const size = probe.offsetWidth - probe.clientWidth;
  probe.remove();
  return size;
}

function layout() {
  const el = container.value;
  const sc = scroller.value;
  if (!el || !sc || !canvas.value) return;
  if (scrollbarSize.value === null) scrollbarSize.value = measureScrollbar();
  const bar = scrollbarSize.value;

  const fx = zoomX.value / 100;
  const zy = mode.value === "linear" ? zoomY.value / 100 : 1;
  const viewW = Math.max(1, Math.floor(el.clientWidth));
  const viewH = Math.max(1, Math.floor(el.clientHeight));
  // room for the scrollbar(s) that will appear
  const tallerWanted = zy > 1;
  const w = Math.max(1, viewW - (tallerWanted ? bar : 0));
  const h = Math.max(1, viewH - (fx > 1 ? bar : 0));
  const width = Math.round(w * fx);
  const fy = tallerWanted ? Math.max(1, Math.min(zy, MAX_PLOT_PIXELS / (width * h))) : 1;
  const height = Math.round(h * fy);

  // keep the frequency at the left of the view (0 Hz to start with, as the Analyser's zoom) and
  // the distance from the bottom in place
  const leftX = sc.scrollWidth > 0 ? sc.scrollLeft / sc.scrollWidth : 0;
  const fromBottom = sc.scrollHeight > 0 ? (sc.scrollHeight - sc.scrollTop - sc.clientHeight) / sc.scrollHeight : 0;

  plotSize.width = width;
  plotSize.height = height;
  GraphSpectrumPlot.setXTicks(xTickCount(fx));
  // zoomY < 1 magnifies in the Analyser; whatever the taller canvas doesn't cover is left to it
  GraphSpectrumPlot.setZoom(1, mode.value === "linear" ? fy / zy : 100 / zoomY.value);
  GraphSpectrumPlot.setSize(width, height);
  draw();

  nextTick(() => {
    sc.scrollLeft = leftX * sc.scrollWidth;
    sc.scrollTop = sc.scrollHeight - sc.clientHeight - fromBottom * sc.scrollHeight;
    onScroll();
  });
}

function resize() {
  layout();
}

function resetZoom() {
  zoomX.value = 100;
  zoomY.value = 100;
}

// The mouse wheel scrolls up/down when the plot is taller than the view, otherwise sideways.
function onWheel(e) {
  const sc = scroller.value;
  if (!sc || !zoomed.value || e.ctrlKey) return;
  const canScrollY = sc.scrollHeight > sc.clientHeight;
  const canScrollX = sc.scrollWidth > sc.clientWidth;
  if (!canScrollY && canScrollX && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
    sc.scrollLeft += e.deltaY;
    e.preventDefault();
  }
}

// Drag the plot to move around it.
function startPan(e) {
  const sc = scroller.value;
  if (!zoomed.value || !sc || e.button !== 0 || e.shiftKey || e.ctrlKey) return;
  const start = { x: e.clientX, y: e.clientY, left: sc.scrollLeft, top: sc.scrollTop };
  const target = e.currentTarget;
  target.setPointerCapture?.(e.pointerId);
  panning.value = true;
  const move = (ev) => {
    sc.scrollLeft = start.left - (ev.clientX - start.x);
    sc.scrollTop = start.top - (ev.clientY - start.y);
  };
  const up = () => {
    panning.value = false;
    target.removeEventListener("pointermove", move);
    target.removeEventListener("pointerup", up);
    target.removeEventListener("pointercancel", up);
  };
  target.addEventListener("pointermove", move);
  target.addEventListener("pointerup", up);
  target.addEventListener("pointercancel", up);
  e.preventDefault();
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
      hasPlot.value = true;
      draw();
    } finally {
      busy.value = false;
    }
  });
}

function updateMarkers() {
  GraphSpectrumPlot.setSysConfig(markerSysConfig(store.settings, store.chartOverlays));
  draw();
}

// Frequency under the mouse, shown in the top left of the chart. The plot's x axis runs from 0 Hz
// at its left margin to log rate / 2 at the right edge of the (possibly scrolled) plot.
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
  const maxHz = 0.5 * store.rates.logRateHz; // across the whole (possibly scrolled) plot
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
watch(
  () => [store.chartOverlays.dynNotch, store.chartOverlays.rpm, store.chartOverlays.rpmMin, dynStats.value, store.rpmHighlight, rpmMarkers.value],
  () => drawOverlays(),
);
watch(() => [store.chartOverlays.lowpass, store.chartOverlays.notch], updateMarkers);
watch(
  () => show.bars,
  (visible) => {
    GraphSpectrumPlot.setShowMainBars(visible);
    draw();
  },
);
watch(zoomX, () => {
  GraphSpectrumPlot.setMousePosition(0, 0);
  layout();
});
watch([zoomY, mode], () => layout());

onMounted(() => {
  GraphSpectrumPlot.initialize(canvas.value, markerSysConfig(store.settings, store.chartOverlays));
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

<style>
.spectrum-scroller {
  scrollbar-width: thin;
  scrollbar-color: rgb(255 255 255 / 0.3) transparent;
}
</style>
