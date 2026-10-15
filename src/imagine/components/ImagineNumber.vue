<template>
  <UInputNumber
    :id="id"
    :model-value="display"
    :min="min"
    :max="max"
    :step="step"
    :disabled="disabled"
    :format-options="formatOptions"
    size="xs"
    :ui="{ root: 'w-28' }"
    @update:model-value="onInput"
  />
</template>

<script setup>
// Number input with the Configurator's ranges. Values are stored in CLI units; `scale` converts to
// the displayed value (e.g. dyn_notch_q is stored x10 and shown as 2.5).
import { computed } from "vue";

const props = defineProps({
  id: { type: String, default: undefined },
  modelValue: { type: Number, default: 0 },
  min: { type: Number, default: 0 },
  max: { type: Number, default: 1000 },
  step: { type: Number, default: 1 },
  scale: { type: Number, default: 1 },
  disabled: { type: Boolean, default: false },
});
const emit = defineEmits(["update:modelValue"]);

const decimals = computed(() => {
  const s = String(props.step);
  return s.includes(".") ? s.split(".")[1].length : 0;
});
const formatOptions = computed(() => ({
  useGrouping: false,
  minimumFractionDigits: decimals.value,
  maximumFractionDigits: decimals.value,
}));
const display = computed(() => props.modelValue / props.scale);

function onInput(value) {
  if (value == null || Number.isNaN(value)) return;
  emit("update:modelValue", Math.round(value * props.scale));
}
</script>
