<template>
  <UButton
    variant="ghost"
    color="neutral"
    size="xs"
    class="piro-wobble-size-toggle absolute"
    :icon="graphStore.piroWobbleEnlarged ? 'i-lucide-minimize-2' : 'i-lucide-maximize-2'"
    :title="graphStore.piroWobbleEnlarged ? 'Back to normal size' : 'Double the piro wobble window size'"
    @click="graphStore.togglePiroWobbleEnlarged()"
  />
</template>

<script setup>
// The size toggle in the piro wobble window's top right corner (teleported into #piroWobble, so
// it shows and hides with the window - see grapher.js drawPiroWobble), like the craft's.
import { useGraphStore } from "../stores/graph.js";

const graphStore = useGraphStore();
</script>

<style scoped>
.piro-wobble-size-toggle {
  top: 4px;
  right: 4px;
  color: #fff;
  opacity: 0.6;
  /* The window itself lets clicks through to the graph; the button doesn't. */
  pointer-events: auto;
}

.piro-wobble-size-toggle:hover {
  opacity: 1;
}
</style>
