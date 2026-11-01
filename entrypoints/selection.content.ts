import type {
  SelectionTranslationUiLoadRequest,
  SelectionTranslationUiLoadResponse,
} from "@/lib/selection-translation";
import { readEligibleSelection } from "@/lib/selection-eligibility";
import { browser } from "wxt/browser";

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_end",
  allFrames: true,
  main(ctx) {
    let loading = false;
    let loaded = false;
    let pageActive = true;
    let listening = false;
    let selectionReadTimer: number | undefined;

    const load = async () => {
      if (loading || loaded || !pageActive || !readEligibleSelection()) return;
      loading = true;
      try {
        const response = (await browser.runtime.sendMessage({
          type: "LOAD_SELECTION_TRANSLATION_UI",
        } satisfies SelectionTranslationUiLoadRequest)) as SelectionTranslationUiLoadResponse;
        if (!ctx.isInvalid && pageActive && response?.loaded) {
          loaded = true;
          removeListeners();
        }
      } catch {
        // A later selection retries the fixed runtime script injection.
      } finally {
        loading = false;
      }
    };
    function scheduleLoad() {
      if (selectionReadTimer !== undefined) return;
      selectionReadTimer = window.setTimeout(() => {
        selectionReadTimer = undefined;
        void load();
      });
    }
    function addListeners() {
      if (listening || loaded) return;
      listening = true;
      document.addEventListener("pointerup", scheduleLoad, true);
      document.addEventListener("keyup", scheduleLoad, true);
      document.addEventListener("dblclick", scheduleLoad, true);
    }
    function removeListeners() {
      listening = false;
      document.removeEventListener("pointerup", scheduleLoad, true);
      document.removeEventListener("keyup", scheduleLoad, true);
      document.removeEventListener("dblclick", scheduleLoad, true);
      if (selectionReadTimer !== undefined)
        window.clearTimeout(selectionReadTimer);
      selectionReadTimer = undefined;
    }
    function onPageHide() {
      pageActive = false;
      removeListeners();
    }
    function onPageShow(event: PageTransitionEvent) {
      if (ctx.isInvalid) return;
      pageActive = true;
      if (event.persisted) addListeners();
    }
    function cleanup() {
      removeListeners();
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
    }

    addListeners();
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    ctx.onInvalidated(cleanup);
  },
});
