<template>
  <div class="py-1">
    <div v-if="label" class="border-b border-default/60 pb-0.5 text-xs font-semibold text-muted">{{ label }}</div>
    <div :class="{ 'pl-3': indent }">
      <slot />
    </div>
  </div>
</template>

<script setup>
// A labelled group inside a section, like the Configurator's SubSection. `indent` is used for the
// fields that appear under an Enable switch.
defineProps({
  label: { type: String, default: "" },
  indent: { type: Boolean, default: false },
});
</script>
