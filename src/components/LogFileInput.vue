<template>
  <button v-if="buttonClass" type="button" :class="buttonClass" @click="$refs.fileInput.click()">
    {{ label }}
  </button>
  <UButton
    v-else
    :size="size"
    color="primary"
    :label="label"
    icon="i-lucide-folder-open"
    @click="$refs.fileInput.click()"
  />
  <input
    ref="fileInput"
    type="file"
    class="hidden"
    accept=".bbl,.txt,.cfl,.bfl,.log,.avi,.mov,.mp4,.mpeg,.json"
    multiple
    @change="onFileChange"
  />
</template>

<script setup>
import { ref } from "vue";

defineProps({
  size: {
    type: String,
    default: "sm",
  },
  label: {
    type: String,
    default: "Open log file/video",
  },
  // When set, renders a plain <button> with this class instead of the Nuxt UI button
  buttonClass: {
    type: String,
    default: "",
  },
});

const emit = defineEmits(["files-selected"]);
const fileInput = ref(null);

function onFileChange(event) {
  const files = event.target.files;
  if (files.length > 0) {
    emit("files-selected", files);
  }
  // Reset input so same file can be selected again
  event.target.value = "";
}
</script>
