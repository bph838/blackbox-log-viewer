<template>
  <div class="flex min-h-8 items-center gap-2 py-0.5" :title="cli || undefined">
    <div class="min-w-0 flex-1" :class="{ 'opacity-50': disabled }">
      <label :for="id" class="flex items-center gap-1 text-sm">
        <!-- labels use the Configurator's wording, which includes <sup> ordinals -->
        <span v-html="label" />
        <span v-if="unit" class="text-xs text-dimmed">[ {{ unit }} ]</span>
        <HelpIcon v-if="help" :text="help" class="text-dimmed" />
      </label>
      <div v-if="hint" class="text-[11px] leading-tight tabular-nums" :class="hintClass" :title="hintTitle || undefined">{{ hint }}</div>
    </div>
    <span
      v-if="changed"
      class="size-1.5 shrink-0 rounded-full bg-warning"
      :title="changedTitle || 'Changed from the log value'"
    />
    <div class="shrink-0">
      <slot />
    </div>
  </div>
</template>

<script setup>
// One setting row, laid out like the Rotorflight Configurator's Field: label (and unit) on the left,
// control on the right. `changed` shows a dot when the value differs from the log.
import HelpIcon from "../../components/HelpIcon.vue";

defineProps({
  id: { type: String, default: undefined },
  label: { type: String, required: true },
  unit: { type: String, default: "" },
  help: { type: String, default: "" },
  cli: { type: String, default: "" },
  changed: { type: Boolean, default: false },
  changedTitle: { type: String, default: "" },
  disabled: { type: Boolean, default: false },
  // small line under the label (e.g. a notch's frequency)
  hint: { type: String, default: "" },
  hintClass: { type: String, default: "text-dimmed" },
  hintTitle: { type: String, default: "" },
});
</script>
