<template>
  <UTooltip v-if="indicator" :text="indicator.tooltip" :delay-duration="0">
    <button
      type="button"
      class="flex items-center gap-1 text-xs rounded px-1.5 py-0.5 hover:bg-elevated"
      :class="indicator.class"
      :disabled="syncStore.syncStatus === 'syncing'"
      @click="syncStore.syncNow()"
    >
      <UIcon
        :name="indicator.icon"
        class="size-3.5"
        :class="{ 'animate-spin': syncStore.syncStatus === 'syncing' }"
      />
      {{ indicator.label }}
    </button>
  </UTooltip>
</template>

<script setup>
// Tuning log cloud (GitHub) sync status - syncing, changes waiting, offline, failed - as a small
// button that syncs now when clicked. Shown in the Tuning Log dialog, and in the main toolbar
// (with hideWhenSynced) so a sync in progress or needing attention is visible without opening it.
// Also used for Imagine's AI Filters conversations: pass their store, subject and unit.
import { computed } from "vue";
import { useTuningLogStore } from "../stores/tuningLog.js";

const props = defineProps({
  // Show nothing when everything's synced - only when there's something to see.
  hideWhenSynced: { type: Boolean, default: false },
  // Any store with syncStatus, syncError, syncNow() and totalPendingCount or pendingCount.
  store: { type: Object, default: null },
  // What's being synced, for the tooltips, and what a pending count counts.
  subject: { type: String, default: "tuning logs" },
  unit: { type: String, default: "change" },
});

const syncStore = props.store || useTuningLogStore();

function formatBytes(bytes) {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

const status = computed(() => {
  const pending = syncStore.totalPendingCount ?? syncStore.pendingCount ?? 0;
  const unit = props.unit;
  const waiting = pending ? `${plural(pending, unit)} saved on this computer` : "";

  switch (syncStore.syncStatus) {
    case "syncing": {
      const progress = syncStore.syncProgress;
      if (progress && progress.totalBytes) {
        const percent = Math.floor((progress.sentBytes / progress.totalBytes) * 100);
        return {
          icon: "i-lucide-refresh-cw",
          label: `Uploading ${formatBytes(progress.totalBytes)} · ${percent}%`,
          class: "text-dimmed",
          tooltip: `Uploading to GitHub - ${formatBytes(progress.sentBytes)} of ${formatBytes(progress.totalBytes)} sent`,
        };
      }
      return {
        icon: "i-lucide-refresh-cw",
        label: "Syncing…",
        class: "text-dimmed",
        tooltip: `Syncing ${props.subject} with GitHub`,
      };
    }
    case "synced":
      return {
        icon: "i-lucide-cloud-check",
        label: "Synced",
        class: "text-dimmed",
        tooltip: "Everything is saved to GitHub. Click to check for changes made elsewhere.",
      };
    case "pending":
      return {
        icon: "i-lucide-cloud-upload",
        label: `${plural(pending, unit)} to upload`,
        class: "text-dimmed",
        tooltip: "Changes are uploaded to GitHub a few seconds after you stop editing. Click to upload now.",
      };
    case "offline":
      return {
        icon: "i-lucide-cloud-off",
        label: pending ? `Offline · ${plural(pending, unit)} waiting` : "Offline",
        class: "text-warning",
        tooltip: `Can't reach GitHub.${waiting ? ` ${waiting}, and will upload` : " Will sync"} automatically when back online. Click to retry now.`,
      };
    case "error":
      return {
        icon: "i-lucide-cloud-alert",
        label: "Sync failed",
        class: "text-error",
        tooltip: `${(syncStore.syncError?.message || "Sync failed").replace(/\.+$/, "")}.${waiting ? ` ${waiting} - nothing is lost.` : ""} Click to retry.`,
      };
    default:
      return null;
  }
});

const indicator = computed(() =>
  props.hideWhenSynced && syncStore.syncStatus === "synced" ? null : status.value,
);
</script>
