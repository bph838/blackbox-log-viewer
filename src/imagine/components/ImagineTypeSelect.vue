<template>
  <div class="flex items-center gap-2 py-0.5 text-sm">
    <div class="min-w-0 flex-1">
      <div>Filter type</div>
      <div class="font-mono text-[10px] text-dimmed">{{ cli }}</div>
    </div>
    <span
      v-if="logValue != null && logValue !== modelValue"
      class="size-1.5 shrink-0 rounded-full bg-warning"
      title="Changed from the log value"
    />
    <USelect :model-value="modelValue" :items="LPF_OPTIONS" size="xs" class="w-40" @update:model-value="$emit('update:modelValue', $event)" />
  </div>
</template>

<script setup>
// Lowpass type picker. Values are the firmware LPF enum (gyro_lpf*_type).
defineProps({
  modelValue: { type: Number, default: 0 },
  logValue: { type: Number, default: null },
  cli: { type: String, default: "" },
});
defineEmits(["update:modelValue"]);

const LPF_OPTIONS = [
  { label: "1st order", value: 1 },
  { label: "2nd order", value: 2 },
  { label: "PT1", value: 3 },
  { label: "PT2", value: 4 },
  { label: "PT3", value: 5 },
  { label: "Order 1 (bilinear)", value: 6 },
  { label: "Butterworth", value: 7 },
  { label: "Bessel", value: 8 },
  { label: "Damped", value: 9 },
];
</script>
