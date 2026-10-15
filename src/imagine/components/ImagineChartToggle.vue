<template>
  <UButton
    :icon="on ? 'i-lucide-eye' : 'i-lucide-eye-off'"
    size="xs"
    variant="ghost"
    :color="on ? 'primary' : 'neutral'"
    :title="on ? `Hide the ${what} on the chart` : `Show the ${what} on the chart${detail ? `: ${detail}` : ''}`"
    :aria-label="on ? `Hide ${what} on chart` : `Show ${what} on chart`"
    @click="$emit('toggle', !on)"
  />
</template>

<script setup>
// Eye button in a section header that shows or hides that filter's markers on the chart.
defineProps({
  on: { type: Boolean, required: true },
  what: { type: String, required: true },
  detail: { type: String, default: "" },
});
defineEmits(["toggle"]);
</script>
