<template>
  <header class="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-default bg-elevated/60 px-3 py-2">
    <div class="flex items-center gap-2">
      <UIcon name="i-lucide-sparkles" class="size-5 text-primary" />
      <h1 class="text-base font-semibold">Gyro – Imagine</h1>
    </div>

    <template v-if="store.hasLog">
      <USeparator orientation="vertical" class="h-5" />
      <span class="max-w-64 truncate text-sm" :title="store.fileName">{{ store.fileName }}</span>

      <USelect
        v-if="store.logCount > 1"
        :model-value="store.logIndex"
        :items="logItems"
        size="xs"
        class="w-28"
        @update:model-value="store.openSubLog($event)"
      />

      <span class="flex items-center gap-1 text-xs">
        <span class="text-dimmed">Range</span>
        <span>{{ rangeLabel }}</span>
        <UButton
          v-if="hasRange"
          icon="i-lucide-x"
          size="xs"
          variant="ghost"
          color="neutral"
          title="Analyse the whole log"
          @click="store.setTimeRange(null, null)"
        />
      </span>

      <UBadge
        v-if="store.firmware"
        :color="store.firmware.status === 'match' ? 'success' : 'warning'"
        variant="subtle"
        size="sm"
        :title="store.firmware.message"
      >
        {{ store.firmware.status === "match" ? "Firmware match" : "Approximate" }} · RF {{ store.firmware.version }}
      </UBadge>

      <span v-if="store.rates" class="text-xs text-dimmed">
        Log {{ Math.round(store.rates.logRateHz) }} Hz · filters {{ Math.round(store.rates.filterRateHz) }} Hz
      </span>
    </template>

    <div class="ml-auto flex items-center gap-2">
      <span v-if="store.statusMessage && store.status === 'ready'" class="text-xs text-dimmed">{{ store.statusMessage }}</span>
      <UButton
        v-if="store.hasLog"
        label="Filter search"
        icon="i-lucide-chart-scatter"
        size="xs"
        :variant="search.open ? 'solid' : 'outline'"
        :color="search.open ? 'primary' : 'neutral'"
        title="Search for the filter setups with the least noise for the least delay (replaces the spectrum while open)"
        @click="search.open = !search.open"
      />
      <UButton
        label="AI Filters"
        icon="i-lucide-sparkles"
        size="xs"
        :variant="ai.open ? 'solid' : 'outline'"
        :color="ai.open ? 'primary' : 'neutral'"
        title="Chat with Claude about your gyro filters (opens a panel on the left)"
        @click="ai.setOpen(!ai.open)"
      />
      <UButton label="Open log" icon="i-lucide-folder-open" size="xs" variant="outline" color="neutral" @click="fileInput.click()" />
      <input ref="fileInput" type="file" accept=".bbl,.bfl,.txt,.cfl,.bin,.log" class="hidden" @change="onFile" />
    </div>
  </header>
</template>

<script setup>
import { computed, ref } from "vue";
import { useImagineStore } from "../imagine_store.js";
import { useAiFiltersStore } from "../ai/ai_filters_store.js";
import { useFilterSearchStore } from "../search/search_store.js";

const store = useImagineStore();
const ai = useAiFiltersStore();
const search = useFilterSearchStore();
const fileInput = ref(null);
const emit = defineEmits(["open-file"]);

const logItems = computed(() =>
  Array.from({ length: store.logCount }, (_, i) => ({ label: `Log ${i + 1}`, value: i })),
);

const hasRange = computed(() => store.timeRange.in != null || store.timeRange.out != null);

function seconds(us) {
  const t0 = store.data?.time[0] ?? 0;
  return `${((us - t0) / 1e6).toFixed(1)} s`;
}

const rangeLabel = computed(() => {
  if (!hasRange.value || !store.data) return "whole log";
  const t = store.data.time;
  const from = store.timeRange.in ?? t[0];
  const to = store.timeRange.out ?? t[t.length - 1];
  return `${seconds(from)} – ${seconds(to)}`;
});

function onFile(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (file) emit("open-file", file);
}
</script>
