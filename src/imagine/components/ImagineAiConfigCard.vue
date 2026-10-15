<template>
  <div
    class="rounded-md border bg-default/60 text-xs"
    :class="active ? 'border-primary ring-1 ring-primary/40' : config.errors.length ? 'border-error/60' : 'border-default'"
  >
    <div class="flex items-start gap-2 border-b border-default px-2.5 py-1.5">
      <UIcon :name="config.source === 'ai' ? 'i-lucide-sparkles' : 'i-lucide-user'" class="mt-0.5 size-3.5 shrink-0 text-primary" />
      <div class="min-w-0 flex-1">
        <div class="font-semibold">{{ config.name }}</div>
        <div v-if="config.summary" class="text-muted">{{ config.summary }}</div>
      </div>
      <UBadge v-if="active" size="sm" variant="subtle" color="primary">In Filters panel</UBadge>
    </div>

    <ul v-if="config.changes.length" class="space-y-1 px-2.5 py-1.5">
      <li v-for="c in config.changes" :key="c.parameter">
        <div class="flex items-baseline gap-2">
          <span class="min-w-0 flex-1 truncate" :title="c.parameter">{{ c.label }}</span>
          <span class="shrink-0 whitespace-nowrap font-mono tabular-nums">
            <span class="text-dimmed line-through">{{ c.oldText }}</span>
            <UIcon name="i-lucide-arrow-right" class="mx-1 size-3 align-[-1px] text-dimmed" />
            <span class="font-semibold">{{ c.newText }}</span>
          </span>
        </div>
        <div v-if="c.reason" class="text-dimmed">{{ c.reason }}</div>
      </li>
    </ul>
    <p v-else class="px-2.5 py-1.5 text-dimmed">Same as the log's settings.</p>

    <ul v-if="config.errors.length || config.warnings.length" class="space-y-0.5 px-2.5 pb-1.5">
      <li v-for="e in config.errors" :key="e" class="flex gap-1 text-error"><UIcon name="i-lucide-circle-x" class="mt-0.5 size-3 shrink-0" />{{ e }}</li>
      <li v-for="w in config.warnings" :key="w" class="flex gap-1 text-warning"><UIcon name="i-lucide-triangle-alert" class="mt-0.5 size-3 shrink-0" />{{ w }}</li>
    </ul>

    <div class="flex flex-wrap items-center gap-1.5 border-t border-default px-2.5 py-1.5">
      <UButton
        size="xs"
        :label="active ? 'Re-apply' : 'Apply'"
        icon="i-lucide-play"
        :loading="applying"
        :disabled="!config.settings || busy"
        :title="config.settings ? 'Load into the Filters panel and run Imagine' : 'This suggestion failed its checks and can\'t be applied'"
        @click="$emit('apply')"
      />
      <UButton
        v-if="config.result && !config.result.sent"
        size="xs"
        variant="soft"
        label="Send result"
        icon="i-lucide-send"
        :disabled="busy"
        title="Send Imagine's result for this config to Claude now (it is also sent with your next message)"
        @click="$emit('send-result')"
      />
      <span v-else-if="config.result?.sent" class="text-dimmed">Result sent</span>
      <UButton
        size="xs"
        variant="ghost"
        color="neutral"
        :label="copied ? 'Copied' : 'Copy CLI'"
        :icon="copied ? 'i-lucide-check' : 'i-lucide-clipboard-copy'"
        :disabled="!config.settings"
        title="Copy the `set …` lines that differ from the log's settings"
        @click="copy"
      />
      <UButton
        v-if="config.source === 'user'"
        size="xs"
        variant="ghost"
        color="neutral"
        icon="i-lucide-trash-2"
        class="ml-auto"
        title="Delete this saved config"
        @click="$emit('delete')"
      />
    </div>
  </div>
</template>

<script setup>
import { ref } from "vue";

const props = defineProps({
  config: { type: Object, required: true },
  active: { type: Boolean, default: false },
  applying: { type: Boolean, default: false },
  busy: { type: Boolean, default: false },
  cli: { type: Function, required: true },
});
defineEmits(["apply", "send-result", "delete"]);

const copied = ref(false);
async function copy() {
  try {
    await navigator.clipboard.writeText(props.cli());
    copied.value = true;
    setTimeout(() => (copied.value = false), 2000);
  } catch {
    copied.value = false;
  }
}
</script>
