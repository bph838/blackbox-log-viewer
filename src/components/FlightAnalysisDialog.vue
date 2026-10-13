<template>
  <UModal v-model:open="open" :ui="{ content: 'sm:max-w-[980px]' }">
    <template #header>
      <div class="flex items-center gap-2">
        <UIcon name="i-lucide-activity" class="size-5 text-primary" />
        <h4 class="font-semibold">Flight Analysis</h4>
      </div>
    </template>

    <template #body>
      <p v-if="!logStore.flightLog" class="fa-muted">
        No flight log is currently open.
      </p>
      <p v-else-if="analysing" class="fa-muted">Analysing flight&hellip;</p>
      <p v-else-if="error" class="fa-muted">
        Could not analyse this flight: {{ error }}
      </p>

      <div v-else-if="result" class="fa-body">
        <div class="fa-context">
          <span
            ><strong>{{ result.context.craftName }}</strong></span
          >
          <span v-if="result.context.firmwareVersion"
            >Firmware {{ result.context.firmwareVersion }}</span
          >
          <span
            >Flight length
            {{ formatSeconds(result.context.durationSeconds) }}</span
          >
          <span
            >{{ formatSeconds(result.context.stableSeconds) }} identified as
            steady flight</span
          >
        </div>
        <p v-if="result.context.capped" class="fa-capped-note">
          This flight is long enough that analysing all of it would take several
          minutes to decode, so this covers the steadiest
          {{ formatSeconds(result.context.analyzedSeconds) }} found rather than
          the whole flight.
        </p>

        <section class="fa-verdict">
          <h4 class="fa-heading">Verdict</h4>
          <p class="fa-summary">{{ result.verdict.summary }}</p>
          <div v-if="result.verdict.cards.length" class="fa-cards">
            <div
              v-for="card in result.verdict.cards"
              :key="card.key"
              :class="['fa-box', `status-${card.status}`]"
            >
              <div class="fa-row">
                <span class="font-semibold">{{ card.title }}</span>
                <span class="fa-status">{{ STATUS_LABEL[card.status] }}</span>
              </div>
              <div class="fa-headline">{{ card.headline }}</div>
              <div
                v-if="card.action && card.status !== 'good'"
                class="fa-action"
              >
                <strong>Suggestion:</strong> {{ card.action }}
              </div>
            </div>
          </div>
        </section>

        <template v-for="section in LAB_ORDER" :key="section.key">
          <section
            v-if="result.labs[section.key]"
            :class="[
              'fa-box',
              'fa-lab',
              `status-${result.labs[section.key].status}`,
            ]"
          >
            <h4 class="fa-row fa-lab-title">
              <span>{{ section.title }}</span>
              <span
                v-if="STATUS_LABEL[result.labs[section.key].status]"
                class="fa-status"
              >
                {{ STATUS_LABEL[result.labs[section.key].status] }}
              </span>
            </h4>
            <p
              :class="[
                'fa-story',
                {
                  'fa-insufficient':
                    result.labs[section.key].status === 'insufficient',
                },
              ]"
            >
              {{ result.labs[section.key].story }}
            </p>
            <div
              v-if="result.labs[section.key].metrics.length"
              class="fa-tiles"
            >
              <div
                v-for="metric in result.labs[section.key].metrics"
                :key="metric.label"
                class="fa-tile"
              >
                <div class="fa-tile-label">{{ metric.label }}</div>
                <div class="fa-tile-value">{{ metric.value }}</div>
              </div>
            </div>
          </section>
        </template>
      </div>
    </template>

    <template #footer>
      <UButton
        variant="soft"
        color="neutral"
        label="Close"
        size="sm"
        @click="open = false"
      />
    </template>
  </UModal>
</template>

<script setup>
import { ref, shallowRef, toRaw, watch } from "vue";
import { useLogStore } from "../stores/log.js";
import { FlightAnalysis } from "../flight_analysis.js";

const open = defineModel("open", { type: Boolean, default: false });

const logStore = useLogStore();

const STATUS_LABEL = {
  good: "Looks good",
  watch: "Worth watching",
  attention: "Needs attention",
  info: "Findings",
};

const LAB_ORDER = [
  { key: "governor", title: "Headspeed / Governor" },
  { key: "esc", title: "Power / ESC" },
  { key: "battery", title: "Battery" },
  { key: "vibration", title: "Vibration" },
  { key: "pid", title: "PID Tracking" },
];

const result = shallowRef(null);
const analysing = ref(false);
const error = ref(null);

// logStore.flightLog is the same object for every sub-log of a multi-log file, so key the cached
// result on the log index and time range too.
let lastKey = null;

function formatSeconds(seconds) {
  if (!seconds) return "0s";
  return seconds >= 60
    ? `${(seconds / 60).toFixed(1)} min`
    : `${seconds.toFixed(0)}s`;
}

function analyse() {
  const flightLog = toRaw(logStore.flightLog);
  if (!flightLog) return;

  const key = `${logStore.activeLogIndex}:${flightLog.getMinTime()}:${flightLog.getMaxTime()}`;
  if (flightLog === lastKey?.flightLog && key === lastKey.key && result.value)
    return;

  analysing.value = true;
  error.value = null;
  result.value = null;

  // Give the modal a frame to paint the loading message before the (synchronous) analysis runs.
  window.setTimeout(() => {
    try {
      result.value = FlightAnalysis.build(flightLog);
      lastKey = { flightLog, key };
    } catch (e) {
      console.error("Flight analysis failed", e);
      error.value = e.message;
    } finally {
      analysing.value = false;
    }
  }, 50);
}

watch(open, (isOpen) => {
  if (isOpen) analyse();
});
</script>

<style scoped>
.fa-muted {
  color: var(--ui-text-muted);
  font-style: italic;
}

.fa-context {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  margin-bottom: 14px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--ui-border);
  color: var(--ui-text-muted);
  font-size: 13px;
}

.fa-context strong {
  color: var(--ui-text-highlighted);
}

.fa-capped-note {
  margin: -6px 0 14px 0;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--ui-border);
  font-size: 12px;
  font-style: italic;
  color: #b8860b;
}

.fa-verdict {
  margin-bottom: 18px;
}

.fa-heading {
  font-weight: 600;
  margin-bottom: 4px;
}

.fa-summary {
  font-size: 15px;
  margin-bottom: 12px;
}

.fa-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 10px;
}

.fa-box {
  --fa-accent: #b0b0b0;
  border: 1px solid var(--ui-border);
  border-left: 4px solid var(--fa-accent);
  border-radius: 4px;
  padding: 10px 12px;
  background: color-mix(in srgb, var(--fa-accent) 8%, var(--ui-bg));
}

.fa-box.status-good {
  --fa-accent: #3c9d40;
}

.fa-box.status-watch {
  --fa-accent: #d99a1f;
}

.fa-box.status-attention {
  --fa-accent: #c9483f;
}

.fa-box.status-info {
  --fa-accent: #3a7fc1;
}

.fa-lab {
  margin-bottom: 12px;
}

.fa-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.fa-lab-title {
  margin: 0 0 6px 0;
  font-size: 14px;
  font-weight: 600;
}

.fa-status {
  font-size: 11px;
  font-weight: normal;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: var(--ui-text-muted);
  white-space: nowrap;
}

.fa-headline {
  margin-top: 4px;
  font-size: 13px;
}

.fa-action {
  margin-top: 8px;
  font-size: 12px;
  color: var(--ui-text-muted);
}

.fa-story {
  margin: 0 0 8px 0;
  font-size: 13px;
}

.fa-insufficient {
  margin-bottom: 0;
  font-style: italic;
  color: var(--ui-text-muted);
}

.fa-tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 8px;
}

.fa-tile {
  background: var(--ui-bg);
  border: 1px solid var(--ui-border);
  border-radius: 3px;
  padding: 6px 9px;
}

.fa-tile-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: var(--ui-text-dimmed);
}

.fa-tile-value {
  font-weight: 600;
  font-size: 13px;
  margin-top: 1px;
  color: var(--ui-text-highlighted);
}
</style>
