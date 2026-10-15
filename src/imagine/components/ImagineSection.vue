<template>
  <section class="overflow-hidden rounded-md border border-default bg-elevated/40">
    <header class="flex items-center gap-2 border-b border-default bg-elevated px-3 py-1.5">
      <h3 class="flex-1 text-sm font-semibold">{{ title }}</h3>
      <slot name="header" />
      <HelpIcon v-if="help" :text="help" class="text-dimmed" />
    </header>
    <div class="px-3 py-1.5">
      <slot />
    </div>
  </section>
</template>

<script setup>
// A settings section, like the Configurator's Section: title bar with help, then fields.
import HelpIcon from "../../components/HelpIcon.vue";

defineProps({
  title: { type: String, required: true },
  help: { type: String, default: "" },
});
</script>
