<template>
  <UModal v-model:open="open">
    <template #header>
      <div class="flex items-center gap-2">
        <UIcon name="i-lucide-gauge" class="size-5 text-primary" />
        <h4 class="font-semibold">HeadSpeed - Information</h4>
      </div>
    </template>

    <template #body>
      <p v-if="!stats" class="text-sm">
        No headspeed data in this log (no RPM source configured, or the rotor never spooled up).
      </p>
      <template v-else>
        <div class="grid grid-cols-3 gap-3 text-center">
          <div v-for="item in items" :key="item.label" class="rounded-md border border-default p-3">
            <div class="text-xs text-muted">{{ item.label }}</div>
            <div class="text-2xl font-semibold">{{ item.value }}</div>
            <div class="text-xs text-dimmed">rpm</div>
            <div class="mt-1 text-sm">{{ item.hz }} <span class="text-xs text-dimmed">Hz</span></div>
          </div>
        </div>
        <p class="text-xs text-dimmed mt-3">
          Over {{ stats.durationSeconds.toFixed(1) }}s of flight with the rotor above
          {{ HEADSPEED_MIN_RPM }} rpm<template v-if="rangeLabel">, between {{ rangeLabel }}</template>.
        </p>
      </template>
    </template>

    <template #footer>
      <UButton variant="soft" color="neutral" label="Close" size="sm" @click="open = false" />
    </template>
  </UModal>
</template>

<script setup>
import { ref, computed, watch } from "vue";
import { useLogStore } from "../stores/log.js";
import { usePlaybackStore } from "../stores/playback.js";
import { HeadspeedStats, HEADSPEED_MIN_RPM } from "../headspeed_stats.js";
import { formatTime } from "../tools.js";

const open = defineModel("open", { type: Boolean, default: false });

const logStore = useLogStore();
const playbackStore = usePlaybackStore();
const stats = ref(null);
const rangeLabel = ref("");

// Computed on open rather than reactively - it walks the whole log. Limited to the
// IN/OUT points when either is set; a missing one falls back to the log start/end.
watch(open, (isOpen) => {
  if (!isOpen) return;
  const flightLog = logStore.flightLog;
  const inTime = playbackStore.videoExportInTime;
  const outTime = playbackStore.videoExportOutTime;
  stats.value = HeadspeedStats.compute(flightLog, {
    startTime: inTime ?? undefined,
    endTime: outTime ?? undefined,
  });
  if (flightLog && (inTime != null || outTime != null)) {
    const minTime = flightLog.getMinTime();
    const label = (t, fallback) => formatTime(((t ?? fallback) - minTime) / 1000, true);
    rangeLabel.value = `IN ${label(inTime, minTime)} and OUT ${label(outTime, flightLog.getMaxTime())}`;
  } else {
    rangeLabel.value = "";
  }
});

// rpm, and the main rotor frequency (Hz = rpm / 60) to match against the spectrum
function speed(rpm) {
  return { value: Math.round(rpm), hz: (rpm / 60).toFixed(1) };
}

const items = computed(() =>
  stats.value
    ? [
        { label: "Average", ...speed(stats.value.average) },
        { label: "Min", ...speed(stats.value.min) },
        { label: "Max", ...speed(stats.value.max) },
      ]
    : [],
);
</script>
