<template>
  <div class="flex items-center gap-2 py-0.5">
    <div class="min-w-0 flex-1">
      <div class="flex items-center gap-1 text-sm">
        <span>{{ label }}</span>
        <span v-if="unit" class="text-xs text-dimmed">[{{ unit }}]</span>
        <HelpIcon v-if="help" :text="help" class="text-dimmed" />
      </div>
      <div v-if="cli" class="truncate font-mono text-[10px] text-dimmed">{{ cli }}</div>
    </div>
    <span
      v-if="changed"
      class="size-1.5 shrink-0 rounded-full bg-warning"
      :title="`Changed from the log value ${formatted(logValue)}`"
    />
    <UInputNumber
      :model-value="display"
      :min="min"
      :max="max"
      :step="step"
      :disabled="disabled"
      :format-options="formatOptions"
      size="xs"
      :ui="{ root: 'w-28 shrink-0' }"
      @update:model-value="onInput"
    />
  </div>
</template>

<script setup>
// Numeric setting row. `scale` converts the stored CLI value to the displayed one
// (e.g. dyn_notch_q is stored x10 and shown as 2.5).
import { computed } from "vue";
import HelpIcon from "../../components/HelpIcon.vue";

const props = defineProps({
  modelValue: { type: Number, default: 0 },
  logValue: { type: Number, default: null },
  label: { type: String, required: true },
  cli: { type: String, default: "" },
  unit: { type: String, default: "" },
  help: { type: String, default: "" },
  min: { type: Number, default: 0 },
  max: { type: Number, default: 1000 },
  step: { type: Number, default: 1 },
  scale: { type: Number, default: 1 },
  disabled: { type: Boolean, default: false },
});
const emit = defineEmits(["update:modelValue"]);

const decimals = computed(() => (props.scale > 1 ? Math.round(Math.log10(props.scale)) : 0));
const formatOptions = computed(() => ({
  useGrouping: false,
  minimumFractionDigits: decimals.value,
  maximumFractionDigits: decimals.value,
}));
const display = computed(() => props.modelValue / props.scale);
const changed = computed(() => props.logValue != null && props.logValue !== props.modelValue);

function formatted(value) {
  return (value / props.scale).toFixed(decimals.value);
}

function onInput(value) {
  if (value == null || Number.isNaN(value)) return;
  emit("update:modelValue", Math.round(value * props.scale));
}
</script>
