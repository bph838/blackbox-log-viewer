<template>
  <div class="flex h-full min-h-0 flex-col">
    <!-- options -->
    <div class="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-default px-3 py-2 text-xs">
      <label v-if="!search.result" class="flex items-center gap-1.5" :title="BOUNDARY_TITLE">
        <span class="text-muted">Flight motion up to</span>
        <UInputNumber v-model="search.boundaryHz" :min="5" :max="80" :step="5" size="xs" :ui="{ root: 'w-24' }" :disabled="search.running" />
        <span class="text-muted">Hz</span>
      </label>

      <div class="flex flex-wrap items-center gap-x-3 gap-y-1" role="group" aria-label="Filters the search may change">
        <span class="text-muted">Search</span>
        <UCheckbox v-for="d in DIMENSIONS" :key="d" v-model="search.vary[d]" :label="DIMENSION_LABELS[d]" size="xs" :disabled="search.running" />
      </div>

      <UCheckbox
        v-model="search.cliTypes"
        label="CLI-only lowpass types"
        size="xs"
        title="Also try PT1, PT2, PT3, Butterworth and Damped lowpass filters. The Configurator only offers 1st and 2nd order; the others are set with the CLI."
        :disabled="search.running"
      />

      <div class="ml-auto flex items-center gap-2">
        <template v-if="search.running">
          <span class="tabular-nums text-muted">{{ progressText }}</span>
          <UButton label="Stop" icon="i-lucide-square" size="xs" color="neutral" variant="outline" @click="search.cancel()" />
        </template>
        <UButton
          v-else
          :label="search.result ? 'Search again' : 'Find filters'"
          icon="i-lucide-search"
          size="xs"
          :disabled="!store.hasLog || store.status !== 'ready'"
          @click="search.run()"
        />
      </div>
    </div>

    <UAlert v-if="search.error" color="error" variant="subtle" :title="search.error" class="rounded-none" />
    <UAlert
      v-if="search.stale && !search.running"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      title="The log, range or search options changed since this search. Press Search again to update it."
      class="rounded-none"
    />

    <!-- empty state -->
    <div v-if="!search.result" class="flex flex-1 items-center justify-center p-6">
      <div class="max-w-xl space-y-3 text-sm text-muted">
        <h2 class="text-base font-semibold text-default">Find the filters with the least noise for the least delay</h2>
        <p>
          The search tries tens of thousands of filter setups on this flight's unfiltered gyro. It looks for the ones nothing else
          beats on both remaining noise and filter delay. The best of them are then run through the full filter simulation, so the
          numbers on the chart are measured, not estimated.
        </p>
        <p>
          Set where flight motion ends. Movement below that frequency is the heli flying and is left alone. Everything above it
          counts as noise. Setups that cut the flight band by more than 3 dB are left out.
        </p>
        <p class="text-dimmed">
          The results fit this flight. Open-loop simulation can't show how less filtering changes the PID loop, so check a big
          change in the air.
        </p>
        <UButton
          v-if="!search.running"
          label="Find filters"
          icon="i-lucide-search"
          :disabled="!store.hasLog || store.status !== 'ready'"
          @click="search.run()"
        />
        <p v-else class="tabular-nums">{{ progressText }}</p>
      </div>
    </div>

    <!-- result -->
    <div v-else class="flex min-h-0 flex-1">
      <div class="flex min-w-0 flex-1 flex-col">
        <div class="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 pt-2 text-xs">
          <label class="flex items-center gap-1.5" :title="BOUNDARY_TITLE">
            <span class="text-muted">Noise counted above</span>
            <UInputNumber v-model="search.boundaryHz" :min="5" :max="80" :step="5" size="xs" :ui="{ root: 'w-24' }" :disabled="search.running" />
            <span class="text-muted">Hz</span>
          </label>
          <label class="flex items-center gap-2" title="The recommended setup is the one with the least delay whose noise is at or below this. It starts at your log's own noise.">
            <span class="text-muted">Acceptable noise</span>
            <USlider
              :model-value="search.acceptable"
              :min="0"
              :max="sliderMax"
              :step="0.01"
              class="w-40"
              @update:model-value="search.acceptableNoise = $event"
            />
            <UInputNumber
              :model-value="search.acceptable"
              :min="0"
              :step="0.05"
              :format-options="{ minimumFractionDigits: 2, maximumFractionDigits: 2 }"
              size="xs"
              :ui="{ root: 'w-24' }"
              @update:model-value="search.acceptableNoise = $event"
            />
            <span class="text-muted">°/s</span>
          </label>
          <UButton
            v-if="search.acceptableNoise !== null"
            label="Same as my log"
            size="xs"
            variant="ghost"
            color="neutral"
            @click="search.acceptableNoise = null"
          />
          <UButton
            label="Check more near this noise"
            icon="i-lucide-flask-conical"
            size="xs"
            variant="outline"
            color="neutral"
            title="Run the full simulation on more setups from the search close to the acceptable noise"
            :disabled="search.running || search.stale"
            @click="search.verifyMore()"
          />
          <span class="ml-auto flex items-center gap-3 text-dimmed">
            <span class="flex items-center gap-1"><span class="inline-block size-2.5 rounded-full bg-primary" />Verified best</span>
            <span class="flex items-center gap-1"><span class="inline-block size-2.5 rotate-45" :style="{ background: '#4dabf7' }" />Your log</span>
            <span class="flex items-center gap-1"><span class="inline-block size-2.5 rounded-full" :style="{ background: '#ff9f40' }" />Selected</span>
            <span class="flex items-center gap-1"><span class="inline-block size-1.5 bg-(--ui-text-dimmed) opacity-60" />Estimated</span>
          </span>
        </div>

        <div class="min-h-56 flex-1 px-2 pb-1">
          <ImagineSearchChart
            :result="search.result"
            :front="search.front"
            :log-point="search.logPoint"
            :recommended="search.recommended"
            :selected="search.selected"
            :acceptable="search.acceptable"
            :describe="changeLines"
            @select="search.select($event)"
            @update:acceptable="search.acceptableNoise = $event"
          />
        </div>

        <!-- table view of the verified front -->
        <div class="max-h-48 overflow-y-auto border-t border-default px-3 py-1 text-xs">
          <table class="w-full table-fixed tabular-nums">
            <colgroup>
              <col class="w-20" />
              <col class="w-20" />
              <col class="w-24" />
              <col />
            </colgroup>
            <thead class="sticky top-0 bg-default text-dimmed">
              <tr>
                <th class="py-1 text-right font-normal">Delay</th>
                <th class="text-right font-normal">Noise</th>
                <th class="text-right font-normal">vs log</th>
                <th class="pl-4 text-left font-normal">Changes from your log</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="p in tableRows"
                :key="p.index"
                class="cursor-pointer border-t border-default/50 hover:bg-elevated"
                :class="{ 'bg-elevated': search.selected?.index === p.index }"
                @click="search.select(p.index)"
              >
                <td class="whitespace-nowrap py-0.5 text-right">{{ p.delayMs.toFixed(2) }} ms</td>
                <td class="whitespace-nowrap text-right">{{ p.noiseRms.toFixed(2) }} °/s</td>
                <td class="whitespace-nowrap text-right" :class="vsLogClass(p)">{{ vsLog(p) }}</td>
                <td class="truncate pl-4" :title="changeLines(p).join(' · ')">
                  <span v-if="p.index === search.result.logIndex" class="text-dimmed">your log's settings</span>
                  <span v-else>{{ changeLines(p).join(" · ") || "no change" }}</span>
                  <UBadge v-if="p.index === search.recommended?.index" label="recommended" size="sm" variant="subtle" class="ml-2" />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- selected setup -->
      <aside v-if="search.selected" class="w-80 shrink-0 overflow-y-auto border-l border-default p-3 text-xs">
        <div class="mb-2 flex items-center gap-2">
          <h3 class="text-sm font-semibold">{{ selectedTitle }}</h3>
        </div>
        <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 tabular-nums">
          <dt class="text-dimmed">Delay</dt>
          <dd>
            {{ search.selected.delayMs.toFixed(2) }} ms
            <span v-if="search.logPoint" :class="changeClass(search.selected.delayMs - search.logPoint.delayMs)">
              ({{ signed(search.selected.delayMs - search.logPoint.delayMs) }} ms)
            </span>
          </dd>
          <dt class="text-dimmed">Noise</dt>
          <dd>
            {{ search.selected.noiseRms.toFixed(2) }} °/s
            <span v-if="search.logPoint" :class="changeClass(search.selected.noiseRms - search.logPoint.noiseRms)">({{ vsLog(search.selected) }})</span>
          </dd>
          <dt class="text-dimmed">Per axis</dt>
          <dd>
            <span v-for="(n, a) in search.selected.noise" :key="a" class="mr-2">{{ AXIS_NAMES[a][0] }} {{ n.toFixed(2) }}</span>
          </dd>
          <dt class="text-dimmed">Flight band</dt>
          <dd>at most {{ search.selected.bandLossDb.toFixed(1) }} dB cut</dd>
          <dt class="text-dimmed">Unfiltered</dt>
          <dd>{{ search.result.unfiltered.noiseRms.toFixed(2) }} °/s</dd>
        </dl>

        <h4 class="mb-1 mt-3 font-semibold">Changes from your log</h4>
        <p v-if="!selectedChanges.length" class="text-dimmed">None. These are the log's own settings.</p>
        <ul v-else class="mb-2 list-disc pl-4">
          <li v-for="line in changeLines(search.selected)" :key="line">{{ line }}</li>
        </ul>
        <details v-if="selectedChanges.length">
          <summary class="cursor-pointer text-muted">Every parameter</summary>
          <ul class="mt-1 space-y-1">
          <li v-for="c in selectedChanges" :key="c.parameter">
            <div class="text-muted">{{ c.label }}</div>
            <div class="whitespace-pre-line">
              <span class="text-dimmed line-through">{{ c.oldText }}</span> → <span>{{ c.newText }}</span>
            </div>
          </li>
          </ul>
        </details>

        <div class="mt-3 flex flex-wrap gap-2">
          <UButton
            label="Imagine this"
            icon="i-lucide-sparkles"
            size="xs"
            title="Load this setup into the Filters panel and show it on the spectrum"
            @click="search.imagineSetup(search.selected)"
          />
          <UButton
            :label="copied ? 'Copied' : 'Copy CLI'"
            :icon="copied ? 'i-lucide-check' : 'i-lucide-clipboard-copy'"
            size="xs"
            variant="outline"
            color="neutral"
            :disabled="!selectedChanges.length"
            title="Copy the changes as Rotorflight CLI commands"
            @click="copyCli"
          />
        </div>

        <p class="mt-4 text-dimmed">
          {{ search.result.evaluated.toLocaleString() }} setups scored, {{ search.result.verified.length }} run through the full simulation, in
          {{ (search.result.elapsedMs / 1000).toFixed(1) }} s. Noise is counted from {{ search.result.boundaryHz }} Hz to the log's
          {{ Math.round(store.rates.logRateHz / 2) }} Hz Nyquist limit; vibration above that can't be seen in the log.
          Candidate notch centres: {{ search.result.notchPeaks.join(", ") || "none" }} Hz.
        </p>
      </aside>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from "vue";
import { AXIS_NAMES, useImagineStore } from "../imagine_store.js";
import { useFilterSearchStore } from "../search/search_store.js";
import { DIMENSIONS, DIMENSION_LABELS, describeSetup } from "../search/search_space.js";
import ImagineSearchChart from "./ImagineSearchChart.vue";

const BOUNDARY_TITLE =
  "Gyro movement below this frequency is flight motion and is left alone. Noise is counted from here up, and the delay is averaged from 5 Hz up to here. Changing it needs a new search.";

const store = useImagineStore();
const search = useFilterSearchStore();
const copied = ref(false);

const progressText = computed(() => {
  const p = search.progress;
  if (!p) return "Starting…";
  if (p.phase === "search") return `Trying random setups… ${p.evaluated.toLocaleString()}`;
  if (p.phase === "refine") return `Refining the best… ${p.evaluated.toLocaleString()} setups`;
  if (p.phase === "verify") return `Full simulation ${p.done + 1} of ${p.total}`;
  return "Working…";
});

const sliderMax = computed(() => {
  const r = search.result;
  if (!r) return 1;
  const top = Math.max(...search.front.map((p) => p.noiseRms), search.logPoint?.noiseRms ?? 0);
  return Math.ceil(top * 1.2 * 10) / 10;
});

const tableRows = computed(() => {
  const rows = [...search.front];
  if (search.logPoint && !rows.some((p) => p.index === search.logPoint.index)) rows.push(search.logPoint);
  return rows.sort((a, b) => a.delayMs - b.delayMs);
});

const selectedChanges = computed(() => search.changesFor(search.selected));

const selectedTitle = computed(() => {
  const s = search.selected;
  if (!s) return "";
  if (s.index === search.result?.logIndex) return "Your log's settings";
  if (s.index === search.recommended?.index) return "Recommended setup";
  return "Selected setup";
});

function changeLines(point) {
  if (!point || !store.logSettings) return [];
  return describeSetup(point.settings, store.logSettings);
}

function vsLog(p) {
  const log = search.logPoint;
  if (!log || p.index === log.index) return "–";
  const pct = ((p.noiseRms - log.noiseRms) / log.noiseRms) * 100;
  return `${pct > 0 ? "+" : ""}${pct.toFixed(0)}% noise`;
}

function vsLogClass(p) {
  const log = search.logPoint;
  if (!log || p.index === log.index) return "text-dimmed";
  return changeClass(p.noiseRms - log.noiseRms);
}

function signed(v) {
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}`;
}

function changeClass(v) {
  if (Math.abs(v) < 0.01) return "text-dimmed";
  return v > 0 ? "text-warning" : "text-success";
}

async function copyCli() {
  try {
    await navigator.clipboard.writeText(search.cliFor(search.selected));
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    // clipboard blocked
  }
}
</script>
