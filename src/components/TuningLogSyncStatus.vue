<template>
  <UTooltip v-if="indicator" :text="indicator.tooltip" :delay-duration="0">
    <button
      type="button"
      class="flex items-center gap-1 text-xs rounded px-1.5 py-0.5 hover:bg-elevated"
      :class="indicator.class"
      :disabled="tuningLogStore.syncStatus === 'syncing'"
      @click="tuningLogStore.syncNow()"
    >
      <UIcon
        :name="indicator.icon"
        class="size-3.5"
        :class="{ 'animate-spin': tuningLogStore.syncStatus === 'syncing' }"
      />
      {{ indicator.label }}
    </button>
  </UTooltip>
</template>

<script setup>
// Tuning log cloud (GitHub) sync status - syncing, changes waiting, offline, failed - as a small
// button that syncs now when clicked. Shown in the Tuning Log dialog, and in the main toolbar
// (with hideWhenSynced) so a sync in progress or needing attention is visible without opening it.
import { computed } from "vue";
import { useTuningLogStore } from "../stores/tuningLog.js";

const props = defineProps({
  // Show nothing when everything's synced - only when there's something to see.
  hideWhenSynced: { type: Boolean, default: false },
});

const tuningLogStore = useTuningLogStore();

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

const status = computed(() => {
  const pending = tuningLogStore.totalPendingCount;
  const waiting = pending ? `${plural(pending, "change")} saved on this computer` : "";

  switch (tuningLogStore.syncStatus) {
    case "syncing":
      return {
        icon: "i-lucide-refresh-cw",
        label: "Syncing…",
        class: "text-dimmed",
        tooltip: "Syncing tuning logs with GitHub",
      };
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
        label: `${plural(pending, "change")} to upload`,
        class: "text-dimmed",
        tooltip: "Changes are uploaded to GitHub a few seconds after you stop editing. Click to upload now.",
      };
    case "offline":
      return {
        icon: "i-lucide-cloud-off",
        label: pending ? `Offline · ${plural(pending, "change")} waiting` : "Offline",
        class: "text-warning",
        tooltip: `Can't reach GitHub.${waiting ? ` ${waiting}, and will upload` : " Will sync"} automatically when back online. Click to retry now.`,
      };
    case "error":
      return {
        icon: "i-lucide-cloud-alert",
        label: "Sync failed",
        class: "text-error",
        tooltip: `${(tuningLogStore.syncError?.message || "Sync failed").replace(/\.+$/, "")}.${waiting ? ` ${waiting} - nothing is lost.` : ""} Click to retry.`,
      };
    default:
      return null;
  }
});

const indicator = computed(() =>
  props.hideWhenSynced && tuningLogStore.syncStatus === "synced" ? null : status.value,
);
</script>
