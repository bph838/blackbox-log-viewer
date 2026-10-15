<template>
  <div>
    <table class="w-full text-xs">
      <thead class="text-dimmed">
        <tr>
          <th class="text-left font-normal">Source</th>
          <th class="text-right font-normal">Q</th>
          <th class="text-right font-normal" title="Centre correction, % of the source frequency">Offset %</th>
          <th class="text-right font-normal">Hz</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.slot">
          <td class="py-0.5 pr-1">
            <USelect
              :model-value="row.source"
              :items="RPM_SOURCE_OPTIONS"
              size="xs"
              class="w-28"
              @update:model-value="rpm.source[axis][row.slot] = $event"
            />
          </td>
          <td class="text-right">
            <UInputNumber
              :model-value="row.q / 10"
              :min="1"
              :max="25"
              :step="0.1"
              :increment="false"
              :decrement="false"
              :format-options="{ useGrouping: false, minimumFractionDigits: 1, maximumFractionDigits: 1 }"
              size="xs"
              :ui="{ root: 'w-16', base: 'text-right px-2' }"
              @update:model-value="(v) => v != null && (rpm.q[axis][row.slot] = Math.round(v * 10))"
            />
          </td>
          <td class="text-right">
            <UInputNumber
              :model-value="row.center / 100"
              :min="-20"
              :max="20"
              :step="0.01"
              :increment="false"
              :decrement="false"
              :format-options="{ useGrouping: false, minimumFractionDigits: 2, maximumFractionDigits: 2 }"
              size="xs"
              :ui="{ root: 'w-16', base: 'text-right px-2' }"
              @update:model-value="(v) => v != null && (rpm.center[axis][row.slot] = Math.round(v * 100))"
            />
          </td>
          <td class="pl-1 text-right tabular-nums" :class="hzClass(row.hz)">{{ row.hz == null ? "–" : row.hz.toFixed(1) }}</td>
          <td class="pl-1 text-right">
            <UButton icon="i-lucide-x" size="xs" variant="ghost" color="neutral" title="Remove notch" @click="remove(row.slot)" />
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td colspan="5" class="py-1 text-dimmed">No notches on this axis.</td>
        </tr>
      </tbody>
    </table>
    <UButton class="mt-1" label="Add notch" icon="i-lucide-plus" size="xs" variant="outline" color="neutral" :disabled="rows.length >= 16" @click="add" />
  </div>
</template>

<script setup>
// Slot-by-slot editor for RPM notch banks the Configurator's layout can't show (the CLI view).
import { computed } from "vue";
import { rpmBankFrequency, RPM_SOURCE_OPTIONS } from "../filters/rpm_filter.js";

const props = defineProps({
  rpm: { type: Object, required: true },
  axis: { type: Number, required: true },
  speeds: { type: Object, default: null },
  rotor: { type: Object, default: null },
  nyquist: { type: Number, default: 0 },
});

const rows = computed(() => {
  const out = [];
  for (let slot = 0; slot < 16; slot++) {
    const source = props.rpm.source[props.axis][slot];
    if (!source) continue;
    const center = props.rpm.center[props.axis][slot];
    out.push({
      slot,
      source,
      q: props.rpm.q[props.axis][slot],
      center,
      hz: rpmBankFrequency(source, center, props.speeds, props.rotor),
    });
  }
  return out;
});

function hzClass(hz) {
  if (hz == null) return "text-dimmed";
  return hz > props.nyquist ? "text-warning" : "";
}

function add() {
  const slot = props.rpm.source[props.axis].findIndex((v) => !v);
  if (slot < 0) return;
  props.rpm.source[props.axis][slot] = 11;
  props.rpm.q[props.axis][slot] = 50;
  props.rpm.center[props.axis][slot] = 0;
}

function remove(slot) {
  for (const key of ["source", "q", "center"]) {
    const arr = props.rpm[key][props.axis];
    arr.splice(slot, 1);
    arr.push(0);
  }
}
</script>
