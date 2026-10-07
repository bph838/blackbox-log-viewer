<template>
  <template v-if="visible">
    <UButton
      variant="ghost"
      color="neutral"
      size="xs"
      class="craft-overlay-control absolute"
      :style="toggleStyle"
      :icon="graphStore.craftEnlarged ? 'i-lucide-minimize-2' : 'i-lucide-maximize-2'"
      :title="graphStore.craftEnlarged ? 'Back to normal size' : 'Double the craft size'"
      @click="graphStore.toggleCraftEnlarged()"
    />

    <!-- While enlarged: show the movement of just one axis -->
    <div
      v-if="graphStore.craftEnlarged && graphStore.craftAxes.length"
      class="craft-axis-picker absolute flex gap-0.5"
      :style="axisStyle"
    >
      <UButton
        v-for="option in axisOptions"
        :key="option.label"
        size="xs"
        :variant="graphStore.craftAxis === option.value ? 'solid' : 'ghost'"
        :color="graphStore.craftAxis === option.value ? 'primary' : 'neutral'"
        :class="{ 'craft-axis-unselected': graphStore.craftAxis !== option.value }"
        :label="option.label"
        :title="option.title"
        @click="graphStore.setCraftAxis(option.value)"
      />
      <!-- How slow a change still counts as movement: changes slower than this are taken out -->
      <template v-if="graphStore.craftAxis">
        <span class="craft-axis-divider" />
        <UButton
          v-for="seconds in WINDOW_OPTIONS"
          :key="seconds"
          size="xs"
          :variant="graphStore.craftAxisWindow === seconds ? 'solid' : 'ghost'"
          :color="graphStore.craftAxisWindow === seconds ? 'primary' : 'neutral'"
          :class="{ 'craft-axis-unselected': graphStore.craftAxisWindow !== seconds }"
          :label="`${seconds}s`"
          :title="`Show movement relative to the average over ${seconds} s - slower changes, like flips or holding inverted, are left out`"
          @click="graphStore.setCraftAxisWindow(seconds)"
        />
      </template>
    </div>
  </template>
</template>

<script setup>
// Controls on the craft overlay (#craftCanvas, drawn by grapher.js): a button in its top right
// corner that switches it between its configured size and double that, and - while doubled - a
// picker to show the movement of just one axis.
import { computed } from "vue";
import { useGraphStore } from "../stores/graph.js";
import { useLogStore } from "../stores/log.js";

const graphStore = useGraphStore();
const logStore = useLogStore();

const INSET = 4;
const BUTTON_SIZE = 24;

const AXIS_LABELS = { roll: "Roll", pitch: "Pitch", yaw: "Yaw" };
const WINDOW_OPTIONS = [0.5, 1, 2];

const visible = computed(() => logStore.hasLog && graphStore.hasCraft && graphStore.craftLayout.size > BUTTON_SIZE * 2);

const axisOptions = computed(() => [
  { label: "All", value: null, title: "Show the movement of every axis" },
  ...graphStore.craftAxes.map((axis) => ({
    label: AXIS_LABELS[axis],
    value: axis,
    title: `Show only ${axis} movement (from the gyro), on an otherwise level craft`,
  })),
]);

const toggleStyle = computed(() => {
  const { left, top, size } = graphStore.craftLayout;
  return {
    left: `${left + size - BUTTON_SIZE - INSET}px`,
    top: `${top + INSET}px`,
  };
});

const axisStyle = computed(() => {
  const { left, top, size } = graphStore.craftLayout;
  return {
    left: `${left + INSET}px`,
    top: `${top + size - BUTTON_SIZE - INSET}px`,
  };
});
</script>

<style scoped>
/* Comes straight after #craftCanvas in the DOM, so it sits on the craft and under later overlays. */
.craft-overlay-control {
  color: #fff;
  opacity: 0.6;
}

.craft-overlay-control:hover {
  opacity: 1;
}

/* Unselected axes: a dark chip with a light outline, so they read as buttons over both the
   craft's grey backdrop and the graph lines behind it. */
.craft-axis-unselected {
  color: #fff;
  background-color: rgb(0 0 0 / 0.55);
  box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.45);
}

.craft-axis-divider {
  width: 1px;
  margin: 2px 4px;
  background-color: rgb(255 255 255 / 0.45);
}

.craft-axis-unselected:hover {
  background-color: rgb(0 0 0 / 0.75);
  box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.8);
}
</style>
