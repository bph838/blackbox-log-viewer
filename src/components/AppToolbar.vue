<template>
  <div>
    <!-- Logo bar with amber accent bottom border -->
    <div class="toolbar-logo" @mouseenter="replayTrace">
      <!-- Same stylised gyro traces as the welcome page hero, squashed into the bar.
           Re-keyed on the first hover so the draw-in animation replays once per page load. -->
      <div class="toolbar-trace" aria-hidden="true">
        <svg :key="traceKey" viewBox="0 0 1200 200" preserveAspectRatio="none">
          <path
            class="toolbar-trace-a"
            d="M0 110 C 60 60, 110 160, 170 105 S 280 40, 340 100 S 450 170, 520 95 S 640 30, 700 110 S 820 180, 880 90 S 1000 40, 1060 115 S 1160 150, 1200 100"
          />
          <path
            class="toolbar-trace-b"
            d="M0 120 C 80 150, 130 70, 200 115 S 320 160, 380 105 S 480 60, 560 120 S 660 150, 740 95 S 860 70, 920 125 S 1040 150, 1100 100 S 1170 90, 1200 110"
          />
        </svg>
      </div>
      <div class="flex items-center gap-2">
        <img src="/images/rf_logo_white.svg" alt="Rotorflight" class="toolbar-logo-img" />
        <span class="toolbar-logo-subtitle">Blackbox Explorer</span>
      </div>
      <div class="flex items-center gap-3">
        <span v-if="appStore.logFilename" class="toolbar-filename" :title="appStore.logFilename">
          {{ appStore.logFilename }}
        </span>
        <LogFileInput size="xs" @files-selected="$emit('files-selected', $event)" />
      </div>
    </div>

    <!-- Action buttons row -->
    <div v-if="logStore.hasLog || logStore.hasVideo" class="toolbar-actions">
      <div class="flex items-center gap-1">
        <UButton
          variant="ghost"
          color="neutral"
          label="New Window"
          icon="i-lucide-external-link"
          size="xs"
          @click="$emit('new-window')"
        />
        <USeparator orientation="vertical" class="h-4" />
        <UButton
          variant="ghost"
          color="neutral"
          label="Video"
          icon="i-lucide-video"
          size="xs"
          :disabled="!logStore.hasLog"
          title="Requires a flight log"
          @click="$emit('export-video')"
        />
        <UButton
          variant="ghost"
          color="neutral"
          label="Workspaces"
          icon="i-lucide-layout-grid"
          size="xs"
          @click="$emit('export-workspaces')"
        />
        <UButton
          variant="ghost"
          color="neutral"
          label="CSV"
          icon="i-lucide-file-spreadsheet"
          size="xs"
          :disabled="!logStore.hasLog"
          title="Requires a flight log"
          @click="$emit('export-csv')"
        />
        <UButton
          v-if="logStore.hasGps"
          variant="ghost"
          color="neutral"
          label="GPX"
          icon="i-lucide-map-pin"
          size="xs"
          :disabled="!logStore.hasLog"
          title="Requires a flight log"
          @click="$emit('export-gpx')"
        />
        <USeparator orientation="vertical" class="h-4" />
        <UButton
          variant="ghost"
          color="neutral"
          label="Flight Analysis"
          icon="i-lucide-activity"
          size="xs"
          :disabled="!logStore.hasLog"
          title="Flight Analysis: headspeed, power, battery, vibration and PID tracking checks"
          @click="$emit('open-flight-analysis')"
        />
        <UButton
          variant="ghost"
          color="neutral"
          label="Imagine"
          icon="i-lucide-sparkles"
          size="xs"
          :disabled="!logStore.hasLog"
          title="Gyro – Imagine: preview what changing the gyro filter settings would do to this flight (opens a new tab)"
          @click="$emit('open-imagine')"
        />
        <UButton
          variant="ghost"
          color="neutral"
          label="Craft Config"
          icon="i-lucide-file-cog"
          size="xs"
          title="Load Rotorflight CLI configuration (dump/diff)"
          @click="$emit('open-craft-config')"
        />
        <UButton
          variant="ghost"
          color="neutral"
          label="Tuning Log"
          icon="i-lucide-message-square"
          size="xs"
          title="Tuning Log: capture step response history and get AI tuning advice"
          @click="$emit('open-tuning-log')"
        />
        <TuningLogSyncStatus hide-when-synced />
      </div>
      <div class="flex items-center gap-1">
        <UButton
          variant="ghost"
          color="neutral"
          icon="i-lucide-settings"
          size="xs"
          title="User Settings"
          @click="$emit('open-settings')"
        />
        <UButton
          variant="ghost"
          color="neutral"
          icon="i-lucide-keyboard"
          size="xs"
          title="Keyboard Shortcuts"
          @click="$emit('open-keys')"
        />
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from "vue";
import { useLogStore } from "../stores/log.js";
import { useAppStore } from "../stores/app.js";
import LogFileInput from "./LogFileInput.vue";
import TuningLogSyncStatus from "./TuningLogSyncStatus.vue";

defineEmits([
  "files-selected",
  "export-csv",
  "export-gpx",
  "export-video",
  "export-workspaces",
  "new-window",
  "open-settings",
  "open-keys",
  "open-craft-config",
  "open-tuning-log",
  "open-flight-analysis",
  "open-imagine",
]);

const logStore = useLogStore();
const appStore = useAppStore();
const traceKey = ref(0);

function replayTrace() {
  if (traceKey.value === 0) traceKey.value++;
}
</script>

<style scoped>
.toolbar-logo {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.35rem 0.75rem;
  background: hsl(0, 0%, 12%);
  border-bottom: 2px solid var(--color-primary-500, #0850ac);
  position: relative;
  overflow: hidden;
}

.toolbar-logo > :not(.toolbar-trace) {
  position: relative;
  z-index: 1;
}

.toolbar-trace {
  position: absolute;
  inset: 0;
  pointer-events: none;
  opacity: 0.5;
  /* Keep the traces mostly clear of the logo + "Blackbox Explorer" subtitle, fading in after them */
  mask-image: linear-gradient(
    90deg,
    transparent 0,
    rgba(0, 0, 0, 0.5) 260px,
    #000 480px,
    #000 80%,
    transparent 100%
  );
  -webkit-mask-image: linear-gradient(
    90deg,
    transparent 0,
    rgba(0, 0, 0, 0.5) 260px,
    #000 480px,
    #000 80%,
    transparent 100%
  );
}

.toolbar-trace svg {
  width: 100%;
  height: 100%;
}

.toolbar-trace path {
  fill: none;
  stroke-width: 1.5;
  vector-effect: non-scaling-stroke;
  stroke-dasharray: 3000;
  stroke-dashoffset: 3000;
  animation: toolbar-trace-draw 2.4s ease-out forwards;
}

.toolbar-trace-a {
  stroke: #4da8da;
}

.toolbar-trace path.toolbar-trace-b {
  stroke: rgba(255, 255, 255, 0.25);
  animation-delay: 0.3s;
}

@keyframes toolbar-trace-draw {
  to {
    stroke-dashoffset: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .toolbar-trace path {
    animation: none;
    stroke-dashoffset: 0;
  }
}

.toolbar-logo-img {
  height: 1.5rem;
  width: auto;
}

.toolbar-logo-subtitle {
  font-size: 0.65rem;
  font-weight: 300;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--color-primary-500, #0850ac);
}

.toolbar-filename {
  font-size: 0.7rem;
  color: hsl(0, 0%, 60%);
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.toolbar-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.2rem 0.75rem;
  background: var(--surface-100, hsl(0, 0%, 95%));
  border-bottom: 1px solid var(--border-color, #ccc);
}

:root.dark .toolbar-actions {
  background: var(--surface-200, hsl(0, 0%, 12%));
  border-bottom-color: var(--surface-800, hsl(0, 0%, 25%));
}
</style>
