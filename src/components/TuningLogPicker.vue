<template>
  <div class="flex flex-col gap-2 text-sm">
    <div v-if="loading" class="flex items-center gap-2 text-xs text-dimmed py-2">
      <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />
      Looking for tuning logs for {{ craftLabel }}…
    </div>

    <template v-else>
      <p v-if="cloudError" class="text-xs text-warning flex items-center gap-1">
        <UIcon name="i-lucide-cloud-off" class="size-3.5 shrink-0" />
        {{ cloudError }}
      </p>

      <ul v-if="logs.length" class="flex flex-col divide-y divide-default border border-default rounded-md">
        <li v-for="log in logs" :key="log.logId" class="flex items-center gap-3 px-3 py-2">
          <template v-if="confirmingId === log.logId">
            <div class="flex-1 min-w-0 text-xs">
              <div class="font-medium">Delete “{{ log.name }}”?</div>
              <div class="text-dimmed">
                {{ log.entryCount }} {{ log.entryCount === 1 ? "entry" : "entries" }} will be deleted
                {{ deleteLocation(log) }}. This can't be undone.
              </div>
            </div>
            <UButton
              size="xs"
              variant="ghost"
              color="neutral"
              label="Cancel"
              :disabled="!!deletingId"
              @click="confirmingId = null"
            />
            <UButton
              size="xs"
              color="error"
              label="Delete"
              :loading="deletingId === log.logId"
              :disabled="!!deletingId"
              @click="onDelete(log)"
            />
          </template>
          <template v-else>
            <div class="flex-1 min-w-0">
              <div class="font-medium truncate">{{ log.name }}</div>
              <div class="text-xs text-dimmed flex items-center gap-1 flex-wrap">
                <span>{{ log.entryCount }} {{ log.entryCount === 1 ? "entry" : "entries" }}</span>
                <span v-if="log.updated">· {{ formatUpdated(log.updated) }}</span>
                <span v-if="!log.inCloud && tuningLogStore.cloudEnabled">· This computer only</span>
                <span v-else-if="!log.isLocal">· In the cloud</span>
                <span v-if="log.pendingCount && tuningLogStore.cloudEnabled" class="text-warning">· {{ log.pendingCount }} unsynced</span>
              </div>
            </div>
            <UBadge v-if="log.logId === currentLogId" color="neutral" variant="subtle" size="sm">Open</UBadge>
            <UButton
              v-else
              size="xs"
              color="primary"
              variant="soft"
              :label="log.isLocal ? 'Open' : 'Download & open'"
              :loading="openingId === log.logId"
              :disabled="!!openingId"
              @click="onOpen(log)"
            />
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              icon="i-lucide-trash-2"
              title="Delete this tuning log"
              :disabled="!!openingId || !!deletingId"
              @click="confirmDelete(log)"
            />
          </template>
        </li>
      </ul>
      <p v-else class="text-xs text-dimmed">No tuning logs for {{ craftLabel }} yet.</p>

      <p v-if="openError" class="text-xs text-error">{{ openError }}</p>
      <p v-if="deleteError" class="text-xs text-error">{{ deleteError }}</p>

      <div class="flex items-center gap-2">
        <UButton
          size="xs"
          variant="outline"
          color="neutral"
          icon="i-lucide-plus"
          :label="`New log for ${craftLabel}`"
          @click="emit('new')"
        />
        <slot name="actions" />
      </div>
    </template>
  </div>
</template>

<script setup>
// Lists every tuning log for one heli (by craft name) - on this computer and in the cloud - so the
// user can switch to one, or start a new one. Used by the Tuning Log dialog's log switcher and its
// "this flight log is for a different heli" banner.
import { ref, computed, watch } from "vue";
import { useTuningLogStore } from "../stores/tuningLog.js";

const props = defineProps({
  craftName: { type: String, default: "" },
  currentLogId: { type: String, default: null },
});

const emit = defineEmits(["opened", "new", "deleted"]);

const tuningLogStore = useTuningLogStore();

const loading = ref(false);
const logs = ref([]);
const cloudError = ref(null);
const openingId = ref(null);
const openError = ref("");
const confirmingId = ref(null);
const deletingId = ref(null);
const deleteError = ref("");

const craftLabel = computed(() => props.craftName || "this heli");

let loadId = 0;

async function load() {
  const id = ++loadId;
  loading.value = true;
  openError.value = "";
  try {
    const result = await tuningLogStore.listLogsForCraft(props.craftName);
    if (id !== loadId) return;
    logs.value = result.logs;
    cloudError.value = result.cloudError;
  } finally {
    if (id === loadId) loading.value = false;
  }
}

watch(() => props.craftName, load, { immediate: true });

async function onOpen(log) {
  openingId.value = log.logId;
  openError.value = "";
  try {
    const opened = await tuningLogStore.openLog(log);
    if (opened) {
      emit("opened", log);
    } else {
      openError.value = `Couldn't find “${log.name}” - it may have been deleted.`;
      load();
    }
  } catch (error) {
    openError.value = `Couldn't open “${log.name}”: ${error.message}`;
  } finally {
    openingId.value = null;
  }
}

function deleteLocation(log) {
  const fromCloud = log.inCloud && tuningLogStore.cloudEnabled;
  if (fromCloud && log.isLocal) return "from this computer and from GitHub (and other computers when they next sync)";
  if (fromCloud) return "from GitHub (and other computers when they next sync)";
  return "from this computer";
}

function confirmDelete(log) {
  confirmingId.value = log.logId;
  deleteError.value = "";
}

async function onDelete(log) {
  deletingId.value = log.logId;
  deleteError.value = "";
  try {
    await tuningLogStore.deleteLog(log);
    emit("deleted", log);
  } catch (error) {
    deleteError.value = `Couldn't delete “${log.name}” from GitHub: ${error.message}`;
  } finally {
    deletingId.value = null;
    confirmingId.value = null;
    load();
  }
}

function formatUpdated(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const days = Math.floor((Date.now() - date.getTime()) / 86400000);
  if (days <= 0) return "updated today";
  if (days === 1) return "updated yesterday";
  if (days < 30) return `updated ${days} days ago`;
  return `updated ${date.toLocaleDateString()}`;
}

defineExpose({ reload: load });
</script>
