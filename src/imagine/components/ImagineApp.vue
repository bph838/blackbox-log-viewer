<template>
  <UApp>
    <div
      class="flex h-screen flex-col bg-default text-default"
      @dragover.prevent="dragging = true"
      @dragleave.self="dragging = false"
      @drop.prevent="onDrop"
    >
      <ImagineToolbar @open-file="openFile" />

      <div v-if="store.hasLog" class="flex min-h-0 flex-1">
        <ImagineSettingsPanel />
        <main class="flex min-w-0 flex-1 flex-col">
          <UAlert
            v-if="store.firmware && store.firmware.status !== 'match'"
            color="warning"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            :title="store.firmware.message"
            class="rounded-none"
          />
          <UAlert
            v-if="store.status === 'error'"
            color="error"
            variant="subtle"
            icon="i-lucide-circle-x"
            :title="store.statusMessage"
            class="rounded-none"
          />
          <UAlert
            v-else-if="store.statusMessage.startsWith('Simulation failed')"
            color="error"
            variant="subtle"
            :title="store.statusMessage"
            class="rounded-none"
          />
          <div class="min-h-0 flex-1">
            <ImagineSpectrum />
          </div>
          <ImagineResults />
        </main>
      </div>

      <div v-else class="flex flex-1 items-center justify-center p-6">
        <div class="max-w-lg space-y-4 text-center">
          <UIcon name="i-lucide-sparkles" class="size-10 text-primary" />
          <h2 class="text-xl font-semibold">Gyro – Imagine</h2>
          <p class="text-sm text-muted">
            See what changing your Rotorflight gyro filters would do to a logged flight, before you fly.
          </p>
          <p v-if="store.status === 'waiting'" class="text-sm">
            <UIcon name="i-lucide-loader-circle" class="mr-1 inline size-4 animate-spin align-[-3px]" />
            Waiting for the log from Blackbox Explorer…
          </p>
          <p v-else-if="store.status === 'loading'" class="text-sm">{{ store.statusMessage }}</p>
          <p v-else-if="store.status === 'error'" class="text-sm text-error">{{ store.statusMessage }}</p>
          <div v-if="store.status !== 'waiting' && store.status !== 'loading'" class="space-y-2">
            <UButton label="Open a log file" icon="i-lucide-folder-open" @click="picker.click()" />
            <p class="text-xs text-dimmed">or drop a .bbl file here. The log needs the unfiltered gyro (gyroRAW) field.</p>
            <input ref="picker" type="file" accept=".bbl,.bfl,.txt,.cfl,.bin,.log" class="hidden" @change="onPick" />
          </div>
        </div>
      </div>

      <div
        v-if="dragging"
        class="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-primary/20 text-lg font-semibold"
      >
        Drop the log to open it
      </div>
    </div>
  </UApp>
</template>

<script setup>
import { onMounted, ref } from "vue";
import { useImagineStore } from "../imagine_store.js";
import { requestLogFromOpener } from "../handoff.js";
import ImagineToolbar from "./ImagineToolbar.vue";
import ImagineSettingsPanel from "./ImagineSettingsPanel.vue";
import ImagineSpectrum from "./ImagineSpectrum.vue";
import ImagineResults from "./ImagineResults.vue";

const store = useImagineStore();
const dragging = ref(false);
const picker = ref(null);

function openFile(file) {
  store.status = "loading";
  store.statusMessage = `Reading ${file.name}…`;
  const reader = new FileReader();
  reader.onload = () => store.loadBytes(reader.result, { fileName: file.name });
  reader.onerror = () => store.fail(`Could not read ${file.name}`);
  reader.readAsArrayBuffer(file);
}

function onPick(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (file) openFile(file);
}

function onDrop(event) {
  dragging.value = false;
  const file = event.dataTransfer?.files?.[0];
  if (file) openFile(file);
}

onMounted(async () => {
  const received = await requestLogFromOpener((payload) => {
    store.loadBytes(payload.bytes, {
      fileName: payload.fileName,
      logIndex: payload.logIndex,
      timeRange: payload.timeRange,
      craft: payload.craft,
    });
  });
  if (!received && store.status === "waiting") {
    store.status = "empty";
    store.statusMessage = "";
  }
});
</script>
