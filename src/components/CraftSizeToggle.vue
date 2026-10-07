<template>
  <UButton
    v-if="visible"
    variant="ghost"
    color="neutral"
    size="xs"
    class="craft-size-toggle absolute"
    :style="style"
    :icon="graphStore.craftEnlarged ? 'i-lucide-minimize-2' : 'i-lucide-maximize-2'"
    :title="graphStore.craftEnlarged ? 'Back to normal size' : 'Double the craft size'"
    @click="graphStore.toggleCraftEnlarged()"
  />
</template>

<script setup>
// Sits in the top right corner of the craft overlay (#craftCanvas, drawn by grapher.js) and
// switches it between its configured size and double that.
import { computed } from "vue";
import { useGraphStore } from "../stores/graph.js";
import { useLogStore } from "../stores/log.js";

const graphStore = useGraphStore();
const logStore = useLogStore();

const BUTTON_INSET = 4;
const BUTTON_SIZE = 24;

const visible = computed(() => logStore.hasLog && graphStore.hasCraft && graphStore.craftLayout.size > BUTTON_SIZE * 2);

const style = computed(() => {
  const { left, top, size } = graphStore.craftLayout;
  return {
    left: `${left + size - BUTTON_SIZE - BUTTON_INSET}px`,
    top: `${top + BUTTON_INSET}px`,
  };
});
</script>

<style scoped>
/* Comes straight after #craftCanvas in the DOM, so it sits on the craft and under later overlays. */
.craft-size-toggle {
  color: #fff;
  opacity: 0.6;
}

.craft-size-toggle:hover {
  opacity: 1;
}
</style>
