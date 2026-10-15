// Entry point for the Imagine page (/imagine/).
import { createApp } from "vue";
import ui from "@nuxt/ui/vue-plugin";
import pinia from "../pinia_instance.js";
import { getNuxtUiRouter } from "../nuxt_ui_router.js";
import { PrefStorage } from "../pref_storage.js";
import ImagineApp from "./components/ImagineApp.vue";
import "../css/tailwind.css";
import "./imagine.css";

// Follow the main app's theme preference (0 = dark, 1 = light, 2 = follow the system).
function applyTheme() {
  const prefs = new PrefStorage();
  prefs.get("darkTheme", (mode) => {
    const media = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = mode === 0 || ((mode == null || mode === 2) && media?.matches);
      document.documentElement.classList.toggle("dark", !!dark);
    };
    apply();
    media?.addEventListener?.("change", apply);
  });
}

applyTheme();

const app = createApp(ImagineApp);
app.use(pinia);
app.use(getNuxtUiRouter());
app.use(ui);
app.mount("#imagine-app");
