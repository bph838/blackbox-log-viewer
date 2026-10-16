<template>
  <aside class="relative flex h-full min-h-0 shrink-0 flex-col border-r border-default" :style="{ width: `${ai.width}px` }">
    <!-- header: conversation picker -->
    <div class="flex items-center gap-1.5 border-b border-default px-2 py-1.5">
      <UIcon name="i-lucide-sparkles" class="size-4 shrink-0 text-primary" />
      <span class="text-sm font-semibold">AI Filters</span>
      <USelect
        v-if="!renaming"
        :model-value="ai.current?.id ?? null"
        :items="conversationItems"
        placeholder="No conversations yet"
        size="xs"
        class="min-w-0 flex-1"
        @update:model-value="(id) => id && ai.openConversation(id)"
      />
      <UInput v-else v-model="renameText" size="xs" class="min-w-0 flex-1" autofocus @keydown.enter="finishRename" @keydown.esc="renaming = false" />
      <UButton v-if="renaming" icon="i-lucide-check" size="xs" variant="ghost" title="Save name" @click="finishRename" />
      <template v-else>
        <UButton icon="i-lucide-plus" size="xs" variant="ghost" color="neutral" title="New conversation" @click="ai.newConversation()" />
        <UButton icon="i-lucide-pencil" size="xs" variant="ghost" color="neutral" :disabled="!ai.current?.messages.length" title="Rename conversation" @click="startRename" />
        <UButton icon="i-lucide-trash-2" size="xs" variant="ghost" color="neutral" :disabled="!ai.current?.messages.length" title="Delete conversation" @click="confirmingDelete = true" />
      </template>
      <UButton icon="i-lucide-x" size="xs" variant="ghost" color="neutral" title="Close AI Filters" @click="ai.setOpen(false)" />
    </div>

    <div v-if="confirmingDelete" class="flex items-center gap-2 border-b border-default bg-error/10 px-3 py-1.5 text-xs">
      <span class="flex-1">Delete “{{ ai.current?.title }}” and its saved configs? This can't be undone.</span>
      <UButton size="xs" variant="ghost" color="neutral" label="Cancel" @click="confirmingDelete = false" />
      <UButton size="xs" color="error" label="Delete" @click="onDelete" />
    </div>

    <div class="flex items-center gap-2 border-b border-default px-2 py-1 text-xs">
      <USelect v-model="ai.model" :items="modelItems" size="xs" class="w-44" title="Model (shared with the Tuning Log)" />
      <span class="ml-auto text-dimmed" :title="usageTitle">{{ costText }}</span>
    </div>

    <!-- API key -->
    <div v-if="!ai.hasApiKey" class="space-y-1.5 border-b border-default bg-warning/10 px-3 py-2 text-xs">
      <p>
        AI Filters uses your own Anthropic API key - the same one as the Tuning Log. It's stored only in this browser and
        sent only to api.anthropic.com.
      </p>
      <div class="flex gap-1.5">
        <UInput v-model="keyInput" type="password" size="xs" placeholder="sk-ant-…" class="flex-1" autocomplete="off" />
        <UButton size="xs" label="Save key" :disabled="!keyInput.trim()" @click="saveKey" />
      </div>
    </div>

    <!-- saved configs -->
    <div v-if="ai.current?.configs.length || imagine.hasLog" class="border-b border-default px-2 py-1.5">
      <div class="mb-1 flex items-center gap-1 text-xs text-muted">
        <span class="flex-1">Configs in this conversation</span>
        <UButton
          v-if="!naming"
          size="xs"
          variant="ghost"
          color="neutral"
          icon="i-lucide-save"
          label="Save current…"
          :disabled="!imagine.hasLog"
          title="Save the Filters panel as a named config"
          @click="startNaming"
        />
      </div>
      <div v-if="naming" class="mb-1 flex gap-1">
        <UInput v-model="nameInput" size="xs" placeholder="Config name" class="flex-1" autofocus @keydown.enter="saveCurrent" @keydown.esc="naming = false" />
        <UButton size="xs" label="Save" @click="saveCurrent" />
        <UButton size="xs" variant="ghost" color="neutral" label="Cancel" @click="naming = false" />
      </div>
      <div class="flex flex-wrap gap-1">
        <button
          v-for="c in ai.current?.configs ?? []"
          :key="c.id"
          type="button"
          class="flex max-w-full cursor-pointer items-center gap-1 rounded border px-1.5 py-0.5 text-xs transition"
          :class="[
            ai.activeConfigId === c.id ? 'border-primary bg-primary/15' : 'border-default hover:bg-elevated',
            !c.settings ? 'cursor-not-allowed opacity-50' : '',
          ]"
          :disabled="!c.settings || ai.busy || !!ai.applyingConfigId"
          :title="c.settings ? `Load “${c.name}” into the Filters panel and run Imagine` : 'Failed its checks - can\'t be applied'"
          @click="ai.applyConfig(c.id)"
        >
          <UIcon :name="ai.applyingConfigId === c.id ? 'i-lucide-loader-circle' : c.source === 'ai' ? 'i-lucide-sparkles' : 'i-lucide-user'" class="size-3 shrink-0" :class="{ 'animate-spin': ai.applyingConfigId === c.id }" />
          <span class="truncate">{{ c.name }}</span>
          <UIcon v-if="c.result" name="i-lucide-chart-no-axes-column" class="size-3 shrink-0 text-dimmed" title="Imagine result available" />
        </button>
        <span v-if="!ai.current?.configs.length" class="text-xs text-dimmed">Suggestions and configs you save appear here.</span>
      </div>
      <ImagineAiConfigCard
        v-if="activeUserConfig"
        class="mt-1.5"
        :config="activeUserConfig"
        :active="true"
        :busy="ai.busy"
        :applying="ai.applyingConfigId === activeUserConfig.id"
        :cli="() => ai.configCli(activeUserConfig.id)"
        @apply="ai.applyConfig(activeUserConfig.id)"
        @send-result="ai.sendResult(activeUserConfig.id)"
        @delete="ai.deleteConfig(activeUserConfig.id)"
      />
    </div>

    <!-- conversation -->
    <div ref="scroller" class="min-h-0 flex-1 space-y-3 overflow-y-auto px-2.5 py-2 text-sm">
      <div v-if="!turns.length && !ai.busy" class="space-y-2 py-4 text-xs text-muted">
        <p>
          Ask Claude about your gyro filters. It gets a compact summary of this log - the noise peaks per axis and their likely
          source, rotor speeds, loop rates and your current Filters panel - and suggests changes step by step as cards you can
          apply here.
        </p>
        <div class="flex flex-col gap-1">
          <UButton
            v-for="s in STARTERS"
            :key="s"
            size="xs"
            variant="soft"
            color="neutral"
            :label="s"
            class="justify-start"
            :disabled="!ai.hasApiKey || !imagine.hasLog"
            @click="ai.send(s)"
          />
        </div>
      </div>

      <template v-for="(turn, i) in turns" :key="i">
        <div v-if="turn.role === 'user'" class="ml-6 space-y-1">
          <div class="flex flex-wrap justify-end gap-1">
            <button
              v-for="(chip, j) in turn.chips"
              :key="j"
              type="button"
              class="flex cursor-pointer items-center gap-1 rounded-full border border-default px-2 py-0.5 text-[11px] text-muted hover:bg-elevated"
              :title="'Show what was sent'"
              @click="toggleChip(`${i}-${j}`)"
            >
              <UIcon :name="CHIP_ICON[chip.kind]" class="size-3" />
              {{ chipLabel(chip) }}
            </button>
          </div>
          <template v-for="(chip, j) in turn.chips" :key="`p${j}`">
            <pre v-if="openChips.has(`${i}-${j}`)" class="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-elevated p-2 text-[11px] leading-snug">{{ chip.text }}</pre>
          </template>
          <div v-if="turn.text" class="whitespace-pre-wrap rounded-lg bg-primary/15 px-3 py-1.5">{{ turn.text }}</div>
        </div>
        <div v-else class="space-y-2">
          <template v-for="(part, j) in turn.parts" :key="j">
            <div v-if="part.kind === 'text'" class="prose prose-sm max-w-none dark:prose-invert" v-html="renderMarkdown(part.text)" />
            <ImagineAiConfigCard
              v-else-if="ai.findConfig(part.configId)"
              :config="ai.findConfig(part.configId)"
              :active="ai.activeConfigId === part.configId"
              :busy="ai.busy"
              :applying="ai.applyingConfigId === part.configId"
              :cli="() => ai.configCli(part.configId)"
              @apply="ai.applyConfig(part.configId)"
              @send-result="ai.sendResult(part.configId)"
            />
          </template>
        </div>
      </template>

      <div v-if="ai.busy" class="space-y-1">
        <div v-if="ai.streamingText" class="prose prose-sm max-w-none dark:prose-invert" v-html="renderMarkdown(ai.streamingText)" />
        <div class="flex items-center gap-2 text-xs text-dimmed">
          <UIcon name="i-lucide-loader-circle" class="size-3.5 animate-spin" />
          {{ statusText }}
        </div>
      </div>
    </div>

    <!-- input -->
    <div class="space-y-1.5 border-t border-default p-2">
      <UAlert v-if="ai.error" color="error" variant="subtle" :title="ai.error" :close="true" class="text-xs" @update:open="ai.error = ''" />
      <UTextarea
        v-model="draft"
        :rows="2"
        autoresize
        :maxrows="8"
        :disabled="!ai.hasApiKey || !imagine.hasLog"
        :placeholder="imagine.hasLog ? 'Ask about your filters… (Ctrl+Enter to send)' : 'Open a log first'"
        class="w-full"
        @keydown.enter.ctrl.prevent="onSend"
        @keydown.enter.meta.prevent="onSend"
      />
      <div class="flex items-center gap-2">
        <button type="button" class="cursor-pointer text-xs text-dimmed underline-offset-2 hover:underline" @click="togglePreview">
          {{ previewOpen ? "Hide" : "Show" }} data sent with this message
        </button>
        <UButton v-if="ai.busy" class="ml-auto" size="xs" color="neutral" variant="soft" label="Cancel" icon="i-lucide-square" @click="ai.cancel()" />
        <UButton
          v-else
          class="ml-auto"
          size="xs"
          label="Send"
          icon="i-lucide-send"
          :disabled="!ai.hasApiKey || !imagine.hasLog || (!draft.trim() && !hasPendingContext)"
          @click="onSend"
        />
      </div>
      <pre v-if="previewOpen" class="max-h-56 overflow-auto whitespace-pre-wrap rounded bg-elevated p-2 text-[11px] leading-snug">{{ previewText }}</pre>
    </div>

    <!-- resize handle -->
    <div
      class="absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize hover:bg-primary/30"
      title="Drag to resize"
      @pointerdown="startResize"
    />
  </aside>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { availableAiModels } from "../../user_settings_data.js";
import { useSettingsStore } from "../../stores/settings.js";
import { useImagineStore } from "../imagine_store.js";
import { useAiFiltersStore } from "../ai/ai_filters_store.js";
import { displayTurns } from "../ai/conversation.js";
import { renderMarkdown } from "../ai/markdown.js";
import ImagineAiConfigCard from "./ImagineAiConfigCard.vue";
import AI_FILTER_QUESTIONS from "../../data/ai_filter_questions.json";

const ai = useAiFiltersStore();
const imagine = useImagineStore();
const settingsStore = useSettingsStore();

// Starter questions shown in an empty conversation - edit src/data/ai_filter_questions.json
const STARTERS = (AI_FILTER_QUESTIONS.questions || []).filter((q) => typeof q === "string" && q.trim());
const CHIP_ICON = { summary: "i-lucide-file-chart-column", result: "i-lucide-chart-no-axes-column", settings: "i-lucide-sliders-horizontal" };

const draft = ref("");
const keyInput = ref("");
const renaming = ref(false);
const renameText = ref("");
const confirmingDelete = ref(false);
const naming = ref(false);
const nameInput = ref("");
const previewOpen = ref(false);
const previewText = ref("");
const openChips = ref(new Set());
const scroller = ref(null);
// ticks while a request runs, so the elapsed time in the status line counts up
const now = ref(Date.now());
let ticker = null;
watch(
  () => ai.busy,
  (busy) => {
    clearInterval(ticker);
    ticker = busy ? setInterval(() => (now.value = Date.now()), 1000) : null;
  },
);
onBeforeUnmount(() => clearInterval(ticker));

const modelItems = availableAiModels.map((m) => ({ label: m.displayName, value: m.id }));
const conversationItems = computed(() =>
  ai.conversations.map((c) => ({ label: `${c.title} · ${new Date(c.updatedAt).toLocaleDateString()}`, value: c.id })).concat(
    ai.current && !ai.conversations.some((c) => c.id === ai.current.id) ? [{ label: ai.current.title, value: ai.current.id }] : [],
  ),
);
const turns = computed(() => (ai.current ? displayTurns(ai.current) : []));
const activeUserConfig = computed(() => {
  const c = ai.activeConfigId ? ai.findConfig(ai.activeConfigId) : null;
  return c && c.source === "user" ? c : null;
});
const hasPendingContext = computed(() => (ai.current?.configs || []).some((c) => c.result && !c.result.sent));

const costText = computed(() => {
  const cost = ai.current?.costUsd || 0;
  return cost ? `$${cost.toFixed(cost < 0.1 ? 3 : 2)} this conversation` : "";
});
const usageTitle = computed(() => {
  const u = ai.current?.usage;
  if (!u) return "";
  return `${u.requests} requests · ${u.inputTokens} input, ${u.cacheReadTokens} cached, ${u.outputTokens} output tokens (estimate)`;
});

const statusText = computed(() => {
  const s = ai.status;
  if (!s) return "Working…";
  const secs = Math.max(0, Math.round((now.value - (s.startedAt || now.value)) / 1000));
  if (s.phase === "sending") return `Sending ${(s.requestBytes / 1024).toFixed(0)} KB to Claude…`;
  if (s.phase === "thinking") return `Claude is thinking… ${secs}s`;
  return "Claude is writing…";
});

function chipLabel(chip) {
  if (chip.kind === "summary") return `Log summary${chip.attrs?.file ? ` · ${chip.attrs.file}` : ""}`;
  if (chip.kind === "result") return `Imagine result · ${chip.attrs?.config ?? ""}`;
  return "Filters panel changed";
}

function toggleChip(key) {
  const s = new Set(openChips.value);
  if (s.has(key)) s.delete(key);
  else s.add(key);
  openChips.value = s;
}

function onSend() {
  if (ai.busy) return;
  const text = draft.value;
  if (!text.trim() && !hasPendingContext.value) return;
  draft.value = "";
  previewOpen.value = false;
  ai.send(text.trim() || "Here are the results.");
}

function togglePreview() {
  previewOpen.value = !previewOpen.value;
  if (previewOpen.value) {
    const c = ai.nextContext();
    const parts = [];
    if (c.summary) parts.push(`<log_summary>\n${c.summary.text}\n</log_summary>`);
    if (c.settingsText) parts.push(`<current_settings>\n${c.settingsText}\n</current_settings>`);
    for (const r of c.results || []) parts.push(`<imagine_result config="${r.name}">\n${r.text}\n</imagine_result>`);
    const text = parts.join("\n\n") || "Only your message - Claude already has the log summary and current settings.";
    previewText.value = `${text}\n\n(${(new TextEncoder().encode(text).length / 1024).toFixed(1)} KB, plus your message)`;
  }
}

function saveKey() {
  settingsStore.saveSetting("aiApiKey", keyInput.value.trim());
  keyInput.value = "";
}

function startRename() {
  renameText.value = ai.current?.title ?? "";
  renaming.value = true;
}
async function finishRename() {
  await ai.renameConversation(renameText.value);
  renaming.value = false;
}
async function onDelete() {
  confirmingDelete.value = false;
  if (ai.current) await ai.deleteConversation(ai.current.id);
}

function startNaming() {
  nameInput.value = `Config ${(ai.current?.configs.filter((c) => c.source === "user").length ?? 0) + 1}`;
  naming.value = true;
}
async function saveCurrent() {
  await ai.saveCurrentAsConfig(nameInput.value);
  naming.value = false;
}

function startResize(e) {
  const startX = e.clientX;
  const startW = ai.width;
  const move = (ev) => ai.setWidth(startW + ev.clientX - startX);
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

function scrollToEnd() {
  nextTick(() => {
    if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight;
  });
}

watch(() => [turns.value.length, ai.streamingText, ai.busy], scrollToEnd);
watch(() => ai.current?.id, () => {
  openChips.value = new Set();
  confirmingDelete.value = false;
  scrollToEnd();
});
watch(() => [imagine.hasLog, ai.craftName], () => imagine.hasLog && ai.loadForCraft());
onMounted(() => {
  if (imagine.hasLog) ai.loadForCraft();
});
</script>
