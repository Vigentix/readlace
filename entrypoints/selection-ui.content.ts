import "@/assets/selection.css";
import { mountSelectionTranslation } from "@/lib/selection-translation";
import { createShadowRootUi } from "wxt/utils/content-script-ui/shadow-root";

const RUNTIME_KEY = "__readlaceSelectionTranslationUi";

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_end",
  allFrames: true,
  registration: "runtime",
  cssInjectionMode: "ui",
  noScriptStartedPostMessage: true,
  async main(ctx) {
    const runtime = globalThis as typeof globalThis &
      Record<typeof RUNTIME_KEY, boolean | undefined>;
    if (runtime[RUNTIME_KEY]) return;
    runtime[RUNTIME_KEY] = true;

    let cleaned = false;
    try {
      const ui = await createShadowRootUi(ctx, {
        name: "readlace-selection-translator",
        mode: "closed",
        position: "inline",
        isolateEvents: [
          "click",
          "keydown",
          "keypress",
          "keyup",
          "pointerdown",
          "pointerup",
          "scroll",
        ],
        onMount: (container, shadow) =>
          mountSelectionTranslation(container, shadow, ctx),
        onRemove: (cleanup) => cleanup?.(),
      });
      ui.shadowHost.classList.add("notranslate");
      ui.shadowHost.setAttribute("translate", "no");
      if (ctx.isInvalid) {
        runtime[RUNTIME_KEY] = undefined;
        return;
      }
      ui.mount();

      function onPageHide(event: PageTransitionEvent) {
        if (event.persisted) {
          ui.shadowHost.setAttribute("data-readlace-suspended", "");
          return;
        }
        cleanup();
      }
      function onPageShow(event: PageTransitionEvent) {
        if (event.persisted)
          ui.shadowHost.removeAttribute("data-readlace-suspended");
      }
      function cleanup() {
        if (cleaned) return;
        cleaned = true;
        window.removeEventListener("pagehide", onPageHide);
        window.removeEventListener("pageshow", onPageShow);
        ui.shadowHost.removeAttribute("data-readlace-suspended");
        ui.remove();
        runtime[RUNTIME_KEY] = undefined;
      }

      window.addEventListener("pagehide", onPageHide);
      window.addEventListener("pageshow", onPageShow);
      ctx.onInvalidated(cleanup);
    } catch (error) {
      runtime[RUNTIME_KEY] = undefined;
      throw error;
    }
  },
});
