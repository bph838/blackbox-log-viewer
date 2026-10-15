<template>
  <USelect
    :id="id"
    :model-value="modelValue"
    :items="items"
    size="xs"
    class="w-28"
    @update:model-value="$emit('update:modelValue', $event)"
  />
</template>

<script setup>
// Lowpass type picker, as in the Configurator: only 1st and 2nd order are offered; any other type
// the firmware supports is listed only while it is the current value. Values are the firmware enum.
import { computed } from "vue";

const props = defineProps({
  id: { type: String, default: undefined },
  modelValue: { type: Number, default: 1 },
});
defineEmits(["update:modelValue"]);

const FILTER_TYPES = [
  { value: 1, label: "1ˢᵗ order", visible: true },
  { value: 2, label: "2ⁿᵈ order", visible: true },
  { value: 3, label: "PT1" },
  { value: 4, label: "PT2" },
  { value: 5, label: "PT3" },
  { value: 6, label: "Order1" },
  { value: 7, label: "Butter" },
  { value: 8, label: "Bessel" },
  { value: 9, label: "Damped" },
];

const items = computed(() =>
  FILTER_TYPES.filter((t) => t.visible || t.value === props.modelValue).map(({ value, label }) => ({ value, label })),
);
</script>
