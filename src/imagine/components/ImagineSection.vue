<template>
  <section class="rounded-md border border-default bg-elevated/40">
    <header class="flex items-center gap-2 border-b border-default px-3 py-1.5">
      <h3 class="flex-1 text-sm font-semibold">{{ title }}</h3>
      <HelpIcon v-if="help" :text="help" class="text-dimmed" />
      <USwitch v-if="toggle" :model-value="enabled" :aria-label="`Enable ${title}`" @update:model-value="$emit('update:enabled', $event)" />
    </header>
    <div v-if="!toggle || enabled" class="space-y-1 px-3 py-2">
      <slot />
    </div>
  </section>
</template>

<script setup>
import HelpIcon from "../../components/HelpIcon.vue";

defineProps({
  title: { type: String, required: true },
  help: { type: String, default: "" },
  toggle: { type: Boolean, default: false },
  enabled: { type: Boolean, default: true },
});
defineEmits(["update:enabled"]);
</script>
