<template>
  <div v-if="!logStore.hasLog && !logStore.hasVideo" class="welcome-page">
    <!-- Hero, with a stylised pair of gyro traces drawn behind it (from rotorflight-blackbox's welcome page) -->
    <div class="hero-wrap">
    <div class="rf-trace" aria-hidden="true">
      <svg viewBox="0 0 1200 200" preserveAspectRatio="none">
        <path
          class="rf-trace-a"
          d="M0 110 C 60 60, 110 160, 170 105 S 280 40, 340 100 S 450 170, 520 95 S 640 30, 700 110 S 820 180, 880 90 S 1000 40, 1060 115 S 1160 150, 1200 100"
        />
        <path
          class="rf-trace-b"
          d="M0 120 C 80 150, 130 70, 200 115 S 320 160, 380 105 S 480 60, 560 120 S 660 150, 740 95 S 860 70, 920 125 S 1040 150, 1100 100 S 1170 90, 1200 110"
        />
      </svg>
    </div>
    <div class="hero">
      <img :src="logoSrc" alt="Rotorflight" class="hero-logo" />
      <p class="hero-subtitle">Blackbox Explorer</p>
      <p class="hero-tagline">Analyze flight logs recorded by Rotorflights's Blackbox feature.</p>      
      <p class="tag-version">{{ appStore.statusViewerVersion }}</p>
      <!-- Drop zone (from rotorflight-blackbox's welcome page) - drops are handled window-wide in App.vue -->
      <div class="rf-dropzone" :class="{ 'is-dragging': isDragging }">
        <svg
          class="rf-dropzone-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.75"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
        <p class="rf-dropzone-title">Drop a log or video anywhere</p>
        <p class="rf-dropzone-or">or</p>
        <LogFileInput
          label="Open log file / video"
          button-class="rf-btn-primary"
          @files-selected="$emit('files-selected', $event)"
        />
        <p v-if="loadingFileText" class="loading-file-indicator">{{ loadingFileText }}</p>
        <ul class="rf-formats">
          <li v-for="format in FORMATS" :key="format">{{ format }}</li>
        </ul>
      </div>
    </div>
    </div>

    <!-- Info cards (styled after rotorflight-blackbox's welcome page cards) -->
    <div class="info-grid">
      <div class="info-card">
        <span class="info-card-icon" aria-hidden="true"><UIcon name="i-lucide-book-open" /></span>
        <h3>Getting Started</h3>
        <p>
          Blackbox is built in to
          <a href="https://github.com/rotorflight/rotorflight/releases" target="_blank" rel="noopener noreferrer"
            >Rotorflight</a
          >
          and supported on most flight controllers.
        </p>
        <div class="info-links">
          <a href="https://rotorflight.org/docs/examples" target="_blank" rel="noopener noreferrer">Getting started &rarr;</a>
          <a
            href="https://www.rcgroups.com/forums/showthread.php?4000345-Rotorflight-Flight-Control-%28FBL%29-Software-Official-discussion"
            target="_blank"
            rel="noopener noreferrer"
            >RC Groups &rarr;</a
          >
          <a href="https://discord.gg/6QUySXdEvd" target="_blank" rel="noopener noreferrer">Discord &rarr;</a>
        </div>
      </div>

      <div class="info-card">
        <span class="info-card-icon" aria-hidden="true"><UIcon name="i-lucide-trending-up" /></span>
        <h3>Tuning Resources</h3>
        <p>Use Blackbox insights to tune PIDs and filter settings.</p>
        <div class="info-links">
          <a href="https://rotorflight.org/docs/Tuning/First-Flight-Filter-Tuning" target="_blank" rel="noopener noreferrer"
            >Filter tuning &rarr;</a
          >
        </div>
      </div>

      <div class="info-card">
        <span class="info-card-icon" aria-hidden="true"><UIcon name="i-lucide-globe" /></span>
        <h3>Links</h3>
        <div class="info-links">
          <a href="https://www.rotorflight.org" target="_blank" rel="noopener noreferrer">Rotorflight &rarr;</a>
        </div>
      </div>
    </div>

    <!-- Footer info-->
     <div class="footer">
     <p><strong>Note:</strong> this isn't the official Rotorflight Blackbox viewer, it's a fork from the latest Betaflight Blackbox Viewer.</p>
     </div>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useLogStore } from "../stores/log.js";
import { useAppStore } from "../stores/app.js";
import LogFileInput from "./LogFileInput.vue";

defineEmits(["files-selected"]);
const logStore = useLogStore();
const appStore = useAppStore();

// rf_logo_white.svg/rf_logo_black.svg each have the "ROTOR" wordmark's blue baked in already -
// pick whichever reads correctly against the current background instead of CSS-filtering a
// single source file flat, which was wiping out that blue along with everything else.
const logoSrc = computed(() =>
  appStore.darkThemeEnabled ? "/images/rf_logo_white.svg" : "/images/rf_logo_black.svg",
);

const FORMATS = [".BBL", ".BFL", ".TXT", ".MP4", ".MOV", ".AVI", "Workspace .JSON"];

// Highlight the drop zone while files are dragged over the window. dragenter/dragleave fire for
// every child element crossed, so count them rather than toggling on each event.
const isDragging = ref(false);
let dragDepth = 0;

function hasFiles(e) {
  return [...(e.dataTransfer?.types ?? [])].includes("Files");
}

function onDragEnter(e) {
  if (!hasFiles(e)) return;
  dragDepth++;
  isDragging.value = true;
}

function onDragLeave(e) {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) isDragging.value = false;
}

function onDragEnd() {
  dragDepth = 0;
  isDragging.value = false;
}

onMounted(() => {
  document.addEventListener("dragenter", onDragEnter);
  document.addEventListener("dragleave", onDragLeave);
  document.addEventListener("drop", onDragEnd);
});

onUnmounted(() => {
  document.removeEventListener("dragenter", onDragEnter);
  document.removeEventListener("dragleave", onDragLeave);
  document.removeEventListener("drop", onDragEnd);
});

const loadingFileText = computed(() => {
  const names = appStore.loadingFileNames;
  if (!names.length) return "";
  return `${names.join(", ")} ${names.length > 1 ? "are" : "is"} being loaded...`;
});
</script>

<style scoped>
.welcome-page {
  --rf-accent: #4da8da;
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  min-height: 100vh;
  overflow: hidden;
  gap: 2rem;
  padding: 2.5rem 1.5rem 1.5rem;
  background:
    radial-gradient(circle at 85% -10%, rgba(77, 168, 218, 0.18) 0%, transparent 45%),
    radial-gradient(circle at 0% 110%, rgba(0, 0, 0, 0.04) 0%, transparent 40%),
    linear-gradient(160deg, hsl(220, 14%, 98%) 0%, hsl(220, 12%, 92%) 100%);
}

/* Same background as rotorflight-blackbox's welcome page */
:root.dark .welcome-page {
  background:
    radial-gradient(circle at 85% -10%, rgba(77, 168, 218, 0.22) 0%, transparent 45%),
    radial-gradient(circle at 0% 110%, rgba(255, 255, 255, 0.06) 0%, transparent 40%),
    linear-gradient(160deg, hsl(220, 9%, 13%) 0%, hsl(220, 10%, 9%) 100%);
}

/* Hero section */
.hero-wrap {
  position: relative;
  display: flex;
  justify-content: center;
  width: 100%;
}

.rf-trace {
  position: absolute;
  left: -1.5rem;
  right: -1.5rem;
  top: 50%;
  height: 240px;
  transform: translateY(-50%);
  pointer-events: none;
  opacity: 0.5;
  mask-image: linear-gradient(90deg, transparent 0%, #000 20%, #000 80%, transparent 100%);
  -webkit-mask-image: linear-gradient(90deg, transparent 0%, #000 20%, #000 80%, transparent 100%);
}

.rf-trace svg {
  width: 100%;
  height: 100%;
}

.rf-trace path {
  fill: none;
  stroke-width: 2;
  vector-effect: non-scaling-stroke;
  stroke-dasharray: 3000;
  stroke-dashoffset: 3000;
  animation: rf-trace-draw 2.4s ease-out forwards;
}

.rf-trace-a {
  stroke: var(--rf-accent);
}

.rf-trace path.rf-trace-b {
  stroke: rgba(0, 0, 0, 0.25);
  animation-delay: 0.3s;
}

:root.dark .rf-trace path.rf-trace-b {
  stroke: rgba(255, 255, 255, 0.25);
}

@keyframes rf-trace-draw {
  to {
    stroke-dashoffset: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .rf-trace path {
    animation: none;
    stroke-dashoffset: 0;
  }
}

.hero {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 0.25rem;
}


.footer{
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 0.25rem;
}

.footer p{
   font-size: 0.7rem;
  color: var(--text-secondary);
  opacity: 0.6;
  margin: -0.5rem 0 0.75rem;
}

.hero-logo {
  width: min(360px, 80vw);
  margin-bottom: 0.25rem;
}

.hero-subtitle {
  font-size: 1.1rem;
  font-weight: 300;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  color: var(--color-primary-500);
  margin: 0;
}

.hero-tagline {
  font-size: 0.85rem;
  color: var(--text-secondary);
  margin: 0 0 0.75rem;
}

.tag-version {
  font-size: 0.7rem;
  color: var(--text-secondary);
  opacity: 0.6;
  margin: -0.5rem 0 0.75rem;
}

.loading-file-indicator {
  font-size: 0.8rem;
  font-weight: 500;
  color: var(--color-primary-500);
  margin: 0.85rem 0 0;
  overflow-wrap: anywhere;
}

/* Drop zone */
.rf-dropzone {
  width: min(560px, 100%);
  margin-top: 0.75rem;
  padding: 36px 32px 28px;
  border: 2px dashed rgba(0, 0, 0, 0.18);
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.65);
  backdrop-filter: blur(8px);
  transition:
    border-color 0.2s ease,
    background 0.2s ease,
    transform 0.2s ease;
}

:root.dark .rf-dropzone {
  border-color: rgba(255, 255, 255, 0.18);
  background: rgba(20, 22, 26, 0.65);
}

.rf-dropzone.is-dragging,
:root.dark .rf-dropzone.is-dragging {
  border-color: #80c5eb;
  background: rgba(77, 168, 218, 0.12);
  transform: scale(1.02);
}

.rf-dropzone-icon {
  width: 44px;
  height: 44px;
  margin: 0 auto 12px;
  color: var(--rf-accent);
}

:root.dark .rf-dropzone-icon {
  color: #80c5eb;
}

.rf-dropzone-title {
  margin: 0;
  font-size: 1.25em;
  font-weight: 700;
  color: var(--text-primary);
}

.rf-dropzone-or {
  margin: 6px 0 14px;
  font-size: 0.85em;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--text-secondary);
}

.rf-dropzone :deep(.rf-btn-primary) {
  padding: 14px 34px;
  border: none;
  border-radius: 8px;
  background: var(--rf-accent);
  color: #181818;
  font-size: 0.95em;
  font-weight: 700;
  letter-spacing: 1px;
  text-transform: uppercase;
  cursor: pointer;
  box-shadow: 0 10px 30px rgba(77, 168, 218, 0.3);
  transition:
    background 0.2s ease,
    transform 0.2s ease,
    box-shadow 0.2s ease;
}

.rf-dropzone :deep(.rf-btn-primary:hover),
.rf-dropzone :deep(.rf-btn-primary:focus-visible) {
  background: #80c5eb;
  transform: translateY(-2px);
  box-shadow: 0 14px 36px rgba(77, 168, 218, 0.4);
}

.rf-formats {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px;
  margin: 22px 0 0;
  padding: 0;
  list-style: none;
}

.rf-formats li {
  padding: 3px 9px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.06);
  font-size: 0.75em;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
}

:root.dark .rf-formats li {
  background: rgba(255, 255, 255, 0.06);
}

/* Info cards */
.info-grid {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 20px;
  width: 100%;
  max-width: 1100px;
  margin-top: 1rem;
}

@media (max-width: 900px) {
  .info-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 500px) {
  .info-grid {
    grid-template-columns: 1fr;
  }
}

.info-card {
  display: flex;
  flex-direction: column;
  padding: 24px;
  border: 1px solid hsl(220, 12%, 85%);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.8);
  transition:
    border-color 0.2s ease,
    transform 0.2s ease;
}

:root.dark .info-card {
  border-color: hsl(220, 10%, 22%);
  background: rgba(31, 33, 37, 0.8);
}

.info-card:hover,
:root.dark .info-card:hover {
  border-color: var(--rf-accent);
  transform: translateY(-4px);
}

.info-card-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  margin-bottom: 14px;
  border-radius: 10px;
  background: rgba(77, 168, 218, 0.15);
  color: var(--rf-accent);
  font-size: 22px;
}

:root.dark .info-card-icon {
  color: #80c5eb;
}

.info-card h3 {
  margin: 0 0 8px;
  font-size: 1.2em;
  font-weight: 800;
  color: var(--text-primary);
}

.info-card p {
  margin: 0 0 14px;
  font-size: 0.95em;
  line-height: 1.6;
  color: var(--text-secondary);
}

.info-card p a {
  color: var(--text-primary);
  text-decoration: underline;
  text-underline-offset: 2px;
}

/* Links sit at the bottom of the card, like the "Logging guide ->" link on the upstream cards */
.info-links {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: auto;
}

.info-links a {
  align-self: flex-start;
  font-size: 0.85em;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  text-decoration: none;
  color: var(--rf-accent);
  transition: color 0.15s ease;
}

.info-links a:hover {
  color: #2f8ed0;
}

:root.dark .info-links a {
  color: #80c5eb;
}

:root.dark .info-links a:hover {
  color: #b3dcf3;
}
</style>
