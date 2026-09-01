<template>
  <div class="toolbar-panel log-workspace-panel">
    <h4>Workspace</h4>

    <UDropdownMenu :items="workspaceItems" class="w-full">
      <UButton
        variant="outline"
        color="neutral"
        size="xs"
        block
        class="justify-between font-mono"
        trailing-icon="i-lucide-chevron-down"
      >
        <span v-if="activeEntry" class="flex items-center gap-1 truncate">
          <span class="opacity-50">{{ workspaceStore.activeWorkspace }}</span>
          <span class="truncate">{{ activeEntry.title }}</span>
        </span>
        <span v-else class="opacity-50">No workspace</span>
      </UButton>

      <template #ws-trailing="{ item }">
        <UIcon v-if="item.wsActive" name="i-lucide-check" class="size-4 text-green-500" />
        <UIcon
          name="i-lucide-save"
          class="size-4 opacity-40 hover:opacity-100 cursor-pointer"
          title="Save current graph setup to this workspace"
          @click.stop.prevent="onSaveClick(item)"
        />
      </template>
    </UDropdownMenu>
  </div>
</template>

<script setup>
import { computed } from "vue";
import { useToast } from "@nuxt/ui/composables";
import { useWorkspaceStore } from "../stores/workspace.js";

const emit = defineEmits([
  "switch-workspace",
  "save-workspace",
  "apply-default",
  "sync-rotation",
]);

const workspaceStore = useWorkspaceStore();
const toast = useToast();

function onSaveClick(item) {
  emit("save-workspace", item.wsId, item.wsTitle);

  const saved = toast.add({
    title: "Workspace saved",
    icon: "i-lucide-check",
    color: "primary",
    duration: 1000,
  });

  function dismiss() {
    toast.remove(saved.id);
    document.removeEventListener("click", dismiss);
  }

  // Register after this click finishes bubbling so it doesn't dismiss itself immediately.
  setTimeout(() => document.addEventListener("click", dismiss), 0);
  setTimeout(() => document.removeEventListener("click", dismiss), 2000);
}

const activeEntry = computed(() => {
  const configs = workspaceStore.workspaceGraphConfigs;
  return configs?.[workspaceStore.activeWorkspace] ?? null;
});

const workspaceItems = computed(() => {
  const configs = workspaceStore.workspaceGraphConfigs;
  const wsItems = [];

  for (let index = 1; index < 11; index++) {
    const id = index % 10;
    const entry = configs?.[id];
    const isActive = id === workspaceStore.activeWorkspace;

    wsItems.push({
      slot: "ws",
      label: entry ? `${id}  ${entry.title}` : `${id}  <empty>`,
      disabled: !entry,
      wsId: id,
      wsActive: isActive,
      wsTitle: entry?.title || "Unnamed",
      onSelect() {
        if (entry) {
          emit("switch-workspace", id);
        }
      },
    });
  }

  const presetItems = [
    {
      label: "Preset: Ben",
      icon: "i-lucide-layout-template",
      onSelect() {
        emit("apply-default", 1);
      },
    }
    ,
    {
      label: "Preset: UAVTech",
      icon: "i-lucide-layout-template",
      onSelect() {
        emit("apply-default", 2);
      },
    },
  ];

  const syncItems = [
    {
      label: "Sync Rotation to Workspace",
      icon: "i-lucide-refresh-cw",
      onSelect() {
        emit("sync-rotation");
        toast.add({
          title: "Rotation rates synced",
          icon: "i-lucide-check",
          color: "primary",
          duration: 1000,
        });
      },
    },
  ];

  return [wsItems, presetItems, syncItems];
});
</script>
