import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Select } from "@/components/Select";
import {
  PREF_PREFIX,
  TARGET_LANGUAGES,
  hostnameFromUrl,
  preferenceKey,
  type TargetLanguage,
} from "@/lib/translation";
import {
  canonicalPreferenceKey,
  readAlwaysTranslatePreference,
} from "@/lib/translate/site-scope";
import {
  shouldEnableTranslate,
  type PageTranslationState,
} from "@/lib/translate/page-language";
import type { NativeRecoveryProgress } from "@/lib/translate/browser-native";
import {
  chooseTranslationPath,
  type EngineSource,
} from "@/lib/translation-path";
import {
  readReaderPreferences,
  saveReaderPreferences,
} from "@/lib/reader-preferences";
import { extensionStorage } from "@/lib/indexeddb-storage";
import { parseWorkspaceEditorUrl } from "@/lib/google-workspace-reader";
import { isGoogleWorkspaceWebClientId } from "@/shared/google-workspace-config";
import { readSheetsReaderFlag } from "@/lib/workspace-features";
import type { UiLocale } from "@/lib/i18n/core";
import {
  browserUiLanguage,
  requestUiLocale,
  resolveUiLocale,
} from "@/lib/i18n/locale";
import { UiLocaleProvider, UiLocaleScope, useMessages } from "@/lib/i18n/react";
import { languageKey } from "@/lib/i18n/catalog/common";
import { popupMessages, type PopupMessage } from "@/lib/i18n/catalog/popup";
import {
  readerIntentKey,
  type WorkspaceReaderIntent,
} from "@/lib/workspace-reader-intent";
import { AccountMenu } from "./AccountMenu";
import { AlwaysTranslateSwitch } from "./AlwaysTranslateSwitch";
import { LocalSpreadsheetTool } from "./LocalSpreadsheetTool";
import {
  DisabledReason,
  LanguageRow,
  NativeDownloadProgress,
  PageCard,
} from "./PageCard";
import { PopupHeader } from "./PopupHeader";
import { SettingsButton } from "./SettingsButton";
import { PopupSkeleton } from "./PopupSkeleton";
import {
  OnDeviceNotice,
  SheetsComingSoonNotice,
  StatusSlot,
} from "./StatusSlot";
import { topStatusNotice } from "./status-priority";
import {
  PageStatusLine,
  TranslateControl,
  pageStatusFor,
  translateControlView,
} from "./TranslateControl";

/** A status line message; `""` shows nothing. */
type PopupStatus = Extract<PopupMessage, string> | "";

interface ContentStateResponse {
  error?: "auth-required" | "auth-unavailable";
  state: PageTranslationState;
  targetLanguage: TargetLanguage;
  translated: boolean;
  appliedTarget?: TargetLanguage;
  hasUnresolved: boolean;
  nativeRecoveryProgress?: NativeRecoveryProgress;
}

interface AuthStatusResponse {
  authenticated?: boolean;
  user?: { email?: unknown };
  /** On-device Translator feature detection where native translation runs. */
  onDeviceTranslation?: unknown;
  /** Engine the next translation starts from (ADR 0020). */
  engineSource?: unknown;
  /** OpenAI refused the saved key. */
  providerKeyRejected?: unknown;
}

interface PopupBootstrapResult {
  tabId?: number;
  host: string;
  available: boolean;
  unavailableMessage: Extract<PopupMessage, string>;
  /** The background answered the status request (ADR 0020: no accounts). */
  authenticated: boolean;
  authUnavailable: boolean;
  contentRevision?: number;
  authChecking?: boolean;
  always: boolean;
  target: TargetLanguage;
  pageLanguage: string;
  sourceLanguage?: TargetLanguage;
  pageState: PageTranslationState;
  appliedTarget?: TargetLanguage;
  status: PopupStatus;
  workspaceReaderMode: boolean;
  workspaceReaderState?: "available" | "not-configured" | "unsupported-browser";
  workspaceSidePanelReady?: boolean;
  workspaceSourceWindowId?: number;
  /** Native Sheet while the Sheets Reader flag is off (ADR 0015). */
  sheetsComingSoon?: boolean;
  /** Whether the background can translate on-device (ADR 0014). */
  onDeviceTranslation?: OnDeviceTranslation;
  /** Engine the next translation starts from (ADR 0020). */
  engineSource?: EngineSource;
  /** OpenAI refused the saved key; translation runs on-device. */
  providerKeyRejected?: boolean;
  /** UI locale from the background (`UI_LOCALE_GET`). */
  uiLocale: UiLocale;
}

type OnDeviceTranslation = "supported" | "unsupported";

type AuthenticationState = Pick<
  PopupBootstrapResult,
  | "authenticated"
  | "authUnavailable"
  | "status"
  | "onDeviceTranslation"
  | "engineSource"
  | "providerKeyRejected"
>;

async function ensureContentState(
  tabId: number,
): Promise<ContentStateResponse> {
  try {
    return await browser.tabs.sendMessage(
      tabId,
      { type: "CONTENT_STATE" },
      { frameId: 0 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      !message.includes("Could not establish connection") &&
      !message.includes("Receiving end does not exist")
    )
      throw error;
    const current = await browser.tabs.get(tabId);
    if (!/^https?:\/\//i.test(current.url ?? "")) throw error;
    const target = { tabId, allFrames: true };
    await browser.scripting.insertCSS({
      target,
      files: ["content-scripts/content.css"],
    });
    await browser.scripting.executeScript({
      target,
      files: ["/content-scripts/content.js"],
    });
    return browser.tabs.sendMessage(
      tabId,
      { type: "CONTENT_STATE" },
      { frameId: 0 },
    );
  }
}

function detectedLanguageKey(value: string) {
  const language = value.trim().toLowerCase();
  if (language === "en" || language === "english") return languageKey("en");
  if (language === "vi" || language === "vietnamese") return languageKey("vi");
  if (language === "ja" || language === "japanese") return languageKey("ja");
  return "language.unknown" as const;
}

async function activeTab() {
  const [current] = await browser.tabs.query({
    active: true,
    currentWindow: true,
  });
  return current;
}

interface WorkspaceSidePanel {
  setOptions(options: {
    tabId?: number;
    path: string;
    enabled: boolean;
  }): Promise<void>;
  open(options: { windowId: number }): Promise<void>;
}

function workspaceSidePanel() {
  return (browser as unknown as { sidePanel?: WorkspaceSidePanel }).sidePanel;
}

function workspaceReaderState(): PopupBootstrapResult["workspaceReaderState"] {
  const webClientId =
    import.meta.env.BROWSER === "firefox"
      ? undefined
      : import.meta.env.WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID?.trim();
  const identity = (
    browser as unknown as {
      identity?: {
        getAuthToken?: unknown;
        removeCachedAuthToken?: unknown;
        getRedirectURL?: unknown;
        launchWebAuthFlow?: unknown;
      };
    }
  ).identity;
  if (webClientId) {
    // `identity` is optional and granted at Connect (ADR 0015).
    return isGoogleWorkspaceWebClientId(webClientId)
      ? "available"
      : "not-configured";
  }
  const manifest = browser.runtime.getManifest() as {
    oauth2?: { client_id?: unknown; scopes?: unknown };
  };
  if (
    typeof manifest.oauth2?.client_id !== "string" ||
    !manifest.oauth2.client_id ||
    !Array.isArray(manifest.oauth2.scopes)
  )
    return "not-configured";
  return identity?.getAuthToken && identity.removeCachedAuthToken
    ? "available"
    : "unsupported-browser";
}

function readAuthentication(): Promise<AuthStatusResponse | undefined> {
  return browser.runtime
    .sendMessage({ type: "AUTH_STATUS" })
    .catch(() => undefined);
}

/**
 * What the popup knows from the background's status answer (ADR 0020):
 * there are no accounts, so "authenticated" only means the background
 * answered; without an answer the popup shows the service as unavailable.
 */
function authenticationState(
  authStatus: AuthStatusResponse | undefined,
  _pageState: PageTranslationState,
  previous?: AuthenticationState,
): AuthenticationState {
  if (authStatus?.authenticated !== true)
    return {
      authenticated: previous?.authenticated ?? false,
      onDeviceTranslation: previous?.onDeviceTranslation,
      engineSource: previous?.engineSource,
      providerKeyRejected: previous?.providerKeyRejected,
      authUnavailable: true,
      status: "",
    };
  return {
    authenticated: true,
    authUnavailable: false,
    onDeviceTranslation:
      authStatus.onDeviceTranslation === "supported" ||
      authStatus.onDeviceTranslation === "unsupported"
        ? authStatus.onDeviceTranslation
        : undefined,
    engineSource:
      authStatus.engineSource === "byok-openai" ||
      authStatus.engineSource === "on-device"
        ? authStatus.engineSource
        : undefined,
    providerKeyRejected: authStatus.providerKeyRejected === true,
    // The card's status line reports page states, not the footer.
    status: "",
  };
}

async function bootstrapPopup(): Promise<PopupBootstrapResult> {
  const tabPromise = activeTab().catch(() => undefined);
  const authPromise = readAuthentication();
  const pagePromise = tabPromise.then(async (current) => {
    const host = hostnameFromUrl(current?.url);
    if (!current?.id || !host || !/^https?:\/\//i.test(current.url ?? ""))
      return {
        host,
        available: false,
        unavailableMessage: "unavailable.page" as const,
        always: false,
        target: "en" as TargetLanguage,
        pageLanguage: "Unknown",
        pageState: "original" as PageTranslationState,
        contentError: undefined,
        workspaceReaderMode: false,
      };

    const tabId = current.id;
    const workspaceSource = parseWorkspaceEditorUrl(current.url ?? "");
    if (workspaceSource?.kind === "docs")
      return {
        tabId,
        host,
        available: false,
        unavailableMessage: "unavailable.docs" as const,
        always: false,
        target: "en" as TargetLanguage,
        pageLanguage: "Unknown",
        pageState: "original" as PageTranslationState,
        contentError: undefined,
        workspaceReaderMode: false,
      };
    // ADR 0015: while the remote flag is off (or the build has no Workspace
    // client), a native Sheet shows the download notice instead of Reader.
    if (
      workspaceSource?.kind === "sheets" &&
      (workspaceReaderState() !== "available" ||
        !(await readSheetsReaderFlag()))
    )
      return {
        tabId,
        host,
        available: false,
        unavailableMessage: "notice.sheetsComingSoon" as const,
        always: false,
        target: "en" as TargetLanguage,
        pageLanguage: "Unknown",
        pageState: "original" as PageTranslationState,
        contentError: undefined,
        workspaceReaderMode: false,
        sheetsComingSoon: true,
      };
    const workspaceReaderMode = workspaceSource?.kind === "sheets";
    const readerState = workspaceReaderMode
      ? workspaceReaderState()
      : undefined;
    const sidePanelPromise =
      readerState === "available" && workspaceSidePanel()?.setOptions
        ? workspaceSidePanel()!
            .setOptions({
              path: "reader.html",
              enabled: true,
            })
            .then(
              () => true,
              () => false,
            )
        : Promise.resolve(false);
    const preferencePromise = extensionStorage
      .getMany([canonicalPreferenceKey(host), preferenceKey(host)])
      .then(
        async (stored) =>
          readAlwaysTranslatePreference(host, stored) ??
          readAlwaysTranslatePreference(
            host,
            await extensionStorage.getByPrefix(PREF_PREFIX),
          ),
      )
      .catch(() => undefined);
    const detectionPromise = browser.runtime
      .sendMessage({ type: "DETECT_TAB_LANGUAGE", tabId })
      .catch(() => undefined);
    const contentPromise = ensureContentState(tabId)
      .then((state) => ({ state, failed: false as const }))
      .catch(() => ({ state: undefined, failed: true as const }));
    const [preference, detection, content, workspaceSidePanelReady] =
      await Promise.all([
        preferencePromise,
        detectionPromise,
        contentPromise,
        sidePanelPromise,
      ]);
    const sourceLanguage = TARGET_LANGUAGES.some(
      (language) => language.code === detection?.sourceLanguage,
    )
      ? (detection.sourceLanguage as TargetLanguage)
      : undefined;
    return {
      tabId,
      host,
      available: workspaceReaderMode
        ? readerState === "available"
        : !content.failed,
      unavailableMessage: workspaceReaderMode
        ? readerState === "not-configured"
          ? ("unavailable.readerNotConfigured" as const)
          : ("unavailable.readerBrowser" as const)
        : content.failed
          ? ("unavailable.toolsFailed" as const)
          : ("unavailable.page" as const),
      always: Boolean(preference?.enabled),
      target: preference?.targetLanguage ?? ("en" as TargetLanguage),
      pageLanguage: detection?.pageLanguage || "Unknown",
      sourceLanguage,
      pageState: content.state?.state ?? ("original" as PageTranslationState),
      appliedTarget: content.state?.appliedTarget,
      contentError: content.state?.error,
      workspaceReaderMode,
      workspaceReaderState: readerState,
      workspaceSidePanelReady,
      workspaceSourceWindowId: current.windowId,
    };
  });
  const [page, authStatus, uiLocale] = await Promise.all([
    pagePromise,
    authPromise,
    requestUiLocale(),
  ]);
  const readerPreferences = page.workspaceReaderMode
    ? await readReaderPreferences().catch(() => ({
        targetLanguage: "vi" as const,
      }))
    : undefined;
  const authentication = authenticationState(authStatus, page.pageState);
  return {
    ...page,
    target: readerPreferences?.targetLanguage ?? page.target,
    ...authentication,
    uiLocale,
  };
}

/**
 * The client path selector (ADR 0020) for this popup: without a usable
 * provider key and without the on-device Translator there is no path.
 */
function onDevicePathUnavailable(
  engineSource: EngineSource | undefined,
  support: OnDeviceTranslation | undefined,
) {
  if (!engineSource || !support) return false;
  return (
    chooseTranslationPath(
      engineSource,
      support === "supported" ? "unknown" : "unsupported",
    ) === "unavailable"
  );
}

function PopupReady({
  initial,
  authGeneration,
  onAuthenticationChange,
}: {
  initial: PopupBootstrapResult;
  authGeneration: RefObject<number>;
  onAuthenticationChange: (
    authentication: Partial<AuthenticationState>,
  ) => void;
}) {
  const t = useMessages(popupMessages);
  const pageLanguage = t.t(detectedLanguageKey(initial.pageLanguage));
  const targetOptions = TARGET_LANGUAGES.map(({ code }) => ({
    label: t.t(languageKey(code)),
    value: code,
  }));
  const sourceLanguage = initial.sourceLanguage;
  const [target, setTarget] = useState<TargetLanguage>(initial.target);
  const [always, setAlways] = useState(initial.always);
  const [pageState, setPageState] = useState<PageTranslationState>(
    initial.pageState,
  );
  const [appliedTarget, setAppliedTarget] = useState<
    TargetLanguage | undefined
  >(initial.appliedTarget);
  const [operationStatus, setOperationStatus] = useState<
    PopupStatus | undefined
  >(initial.authenticated ? initial.status : undefined);
  const [busy, setBusy] = useState(false);
  // **Show original** ran from this popup: keep the Translation | Original
  // toggle so switching back re-translates (Decision 6).
  const [restored, setRestored] = useState(false);
  const [localFileOpening, setLocalFileOpening] = useState(false);
  const [previousAuthentication, setPreviousAuthentication] = useState(initial);
  const workspaceOpening = useRef(false);
  const localFileOpeningRef = useRef(false);
  useLayoutEffect(() => {
    workspaceOpening.current = false;
  }, [initial]);
  if (previousAuthentication !== initial) {
    setPreviousAuthentication(initial);
    setBusy(false);
    setOperationStatus(undefined);
  }
  const operationGeneration = useRef(0);
  function operationIsCurrent(auth: number, operation: number) {
    return (
      authGeneration.current === auth &&
      operationGeneration.current === operation
    );
  }
  const acceptTerminal = useEffectEvent(
    async (terminal: ContentStateResponse, refresh: boolean) => {
      setPageState(terminal.state);
      setAppliedTarget(terminal.appliedTarget);
      if (!refresh) {
        if (terminal.error) await handleContentAuth(terminal.error);
        else setOperationStatus("");
      }
    },
  );
  const { authenticated, available, unavailableMessage, host } = initial;
  const translated = pageState === "translated" || pageState === "partial";
  const workspaceReaderMode = initial.workspaceReaderMode;
  const displayedStatus = initial.authUnavailable
    ? initial.status
    : (operationStatus ?? initial.status);
  const translationInProgress =
    busy || pageState === "translating" || pageState === "preparing";
  const translationActive =
    pageState === "translating" || pageState === "preparing";
  // Translated, but the target changed since: the action comes back as
  // "Translate to <language>" instead of the view switch.
  const retarget =
    translated && appliedTarget !== undefined && appliedTarget !== target;
  const translateLabel = workspaceReaderMode
    ? t.t(busy ? "translate.opening" : "translate.button")
    : translationActive
      ? t.t(
          pageState === "preparing" && !busy
            ? "translate.preparing"
            : "translate.translating",
        )
      : pageState === "error"
        ? t.t("translate.retry")
        : retarget
          ? t.t("translate.translateTo", {
              language: t.t(languageKey(target)),
            })
          : t.t("translate.button");
  const onDeviceBlocked =
    authenticated &&
    !workspaceReaderMode &&
    onDevicePathUnavailable(initial.engineSource, initial.onDeviceTranslation);
  const translateDisabled = workspaceReaderMode
    ? !authenticated ||
      Boolean(initial.authChecking) ||
      initial.workspaceReaderState !== "available" ||
      busy
    : !authenticated ||
      Boolean(initial.authChecking) ||
      onDeviceBlocked ||
      !shouldEnableTranslate({
        state: pageState,
        targetLanguage: target,
        appliedTarget,
        busy,
        openAiBlocked: false,
      });
  // First-use language-pack progress broadcast by the background native
  // host; it carries only languages and byte progress.
  const [nativeProgress, setNativeProgress] =
    useState<NativeRecoveryProgress>();
  useEffect(() => {
    const listener = (message: unknown, sender: { id?: string }) => {
      const update = message as {
        type?: unknown;
        sourceLanguage?: unknown;
        targetLanguage?: unknown;
        progress?: NativeRecoveryProgress;
      } | null;
      if (
        sender.id !== browser.runtime.id ||
        update?.type !== "NATIVE_TRANSLATOR_PROGRESS" ||
        update.targetLanguage !== target ||
        (sourceLanguage !== undefined &&
          update.sourceLanguage !== sourceLanguage) ||
        !update.progress ||
        typeof update.progress.phase !== "string"
      )
        return;
      setNativeProgress(update.progress);
    };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, [target, sourceLanguage]);
  useEffect(() => {
    if (!initial.tabId) return;
    const refresh = initial.contentRevision !== undefined;
    if (
      !refresh &&
      initial.pageState !== "translating" &&
      initial.pageState !== "preparing"
    )
      return;
    let active = true;
    const generation = authGeneration.current;
    const operation = operationGeneration.current;
    void browser.tabs
      .sendMessage(
        initial.tabId,
        { type: refresh ? "CONTENT_STATE" : "WAIT_FOR_CONTENT_TERMINAL_STATE" },
        { frameId: 0 },
      )
      .then(async (terminal: ContentStateResponse) => {
        if (
          refresh &&
          (terminal.state === "translating" || terminal.state === "preparing")
        )
          terminal = await browser.tabs.sendMessage(
            initial.tabId!,
            { type: "WAIT_FOR_CONTENT_TERMINAL_STATE" },
            { frameId: 0 },
          );
        if (
          !active ||
          authGeneration.current !== generation ||
          operationGeneration.current !== operation
        )
          return;
        await acceptTerminal(terminal, refresh);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [
    initial.pageState,
    initial.tabId,
    initial.contentRevision,
    authGeneration,
  ]);
  async function handleContentAuth(error: ContentStateResponse["error"]) {
    if (!error) return;
    const generation = authGeneration.current;
    const operation = operationGeneration.current;
    if (error === "auth-required") {
      const auth = await readAuthentication();
      if (!operationIsCurrent(generation, operation)) return;
      onAuthenticationChange(authenticationState(auth, pageState, initial));
    } else
      onAuthenticationChange({
        authUnavailable: true,
        status: "session.unavailable",
      });
    setOperationStatus(undefined);
  }
  function startTranslation() {
    if (translateDisabled) return;
    if (workspaceReaderMode) {
      openWorkspaceReader();
      return;
    }
    if (sourceLanguage && sourceLanguage !== target) {
      void browser.runtime
        .sendMessage({
          type: "PREPARE_NATIVE_TRANSLATOR",
          sourceLanguage,
          targetLanguage: target,
        })
        .catch(() => undefined);
    }
    void send("START_TRANSLATION", { targetLanguage: target });
  }
  function openWorkspaceReader() {
    const tabId = initial.tabId;
    if (!tabId || workspaceOpening.current) return;
    workspaceOpening.current = true;
    const generation = authGeneration.current;
    const operation = ++operationGeneration.current;
    setBusy(true);
    setOperationStatus("");
    if (pageState !== "original") {
      void browser.tabs
        .sendMessage(tabId, { type: "SHOW_ORIGINAL" })
        .then(() => {
          if (!operationIsCurrent(generation, operation)) return;
          setPageState("original");
          setAppliedTarget(undefined);
        })
        .catch(() => undefined);
    }
    let opened: Promise<unknown>;
    try {
      const sidePanel = workspaceSidePanel();
      opened =
        initial.workspaceSidePanelReady &&
        sidePanel?.open &&
        initial.workspaceSourceWindowId !== undefined
          ? Promise.resolve(
              sidePanel.open({ windowId: initial.workspaceSourceWindowId }),
            )
          : Promise.reject(new Error("Side panel unavailable"));
    } catch (error) {
      opened = Promise.reject(error);
    }
    // Open above stays synchronous with the trusted click; the panel listens
    // for this handoff even if it was already mounted.
    const saved = Promise.all([
      browser.tabs.get(tabId),
      readAuthentication(),
    ]).then(([tab, auth]) => {
      const context = parseWorkspaceEditorUrl(tab.url ?? "");
      if (context?.kind !== "sheets") throw new Error("Reader source changed");
      if (!auth?.authenticated || typeof auth.user?.email !== "string")
        throw new Error("Reader account changed");
      if (!browser.storage?.session)
        throw new Error("Reader intent storage unavailable");
      const intent = {
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        context: { ...context, sourceTabId: tabId },
        targetLanguage: target,
        account: auth.user.email,
      } satisfies WorkspaceReaderIntent;
      return browser.storage.session
        .set({ [readerIntentKey(tabId)]: intent })
        .then(() => ({ sourceTabId: tabId, sourceWindowId: tab.windowId }));
    });
    void Promise.all([
      saved,
      // The fallback tab takes focus, which closes this popup: create it only
      // once the intent is saved, or the Reader opens without the Translate.
      opened.catch(() =>
        saved.then(() =>
          browser.tabs.create({
            url: browser.runtime.getURL(
              `/reader.html?sourceTabId=${tabId}` as never,
            ),
          }),
        ),
      ),
    ])
      .then(async ([source]) => {
        if (!operationIsCurrent(generation, operation)) return;
        await browser.runtime.sendMessage({
          type: "WORKSPACE_READER_OPEN",
          sourceTabId: source.sourceTabId,
          ...(source.sourceWindowId === undefined
            ? {}
            : { sourceWindowId: source.sourceWindowId }),
        });
        if (operationIsCurrent(generation, operation)) window.close();
      })
      .catch(() => {
        if (operationIsCurrent(generation, operation))
          setOperationStatus("status.readerOpenFailed");
      })
      .finally(() => {
        if (operationIsCurrent(generation, operation)) {
          workspaceOpening.current = false;
          setBusy(false);
        }
      });
  }
  async function send(type: string, extra: Record<string, unknown> = {}) {
    if (type === "START_TRANSLATION" && translateDisabled) return;
    if (type === "SHOW_ORIGINAL" && translationInProgress) return;
    const generation = authGeneration.current;
    const operation = ++operationGeneration.current;
    setBusy(type === "START_TRANSLATION");
    if (type === "START_TRANSLATION") {
      setPageState("translating");
      setRestored(false);
    }
    setOperationStatus("");
    try {
      const current = await activeTab();
      if (!operationIsCurrent(generation, operation)) return;
      if (!current?.id) throw new Error("No active tab");
      const response = await browser.tabs.sendMessage(current.id, {
        type,
        ...extra,
      });
      if (!operationIsCurrent(generation, operation)) return;
      if (type === "START_TRANSLATION") {
        const nextState = (response?.state ?? "error") as PageTranslationState;
        setPageState(nextState);
        setAppliedTarget(response?.appliedTarget);
        if (
          response?.error === "auth-required" ||
          response?.error === "auth-unavailable"
        )
          await handleContentAuth(response.error);
        else {
          if (initial.authUnavailable)
            onAuthenticationChange({ authUnavailable: false, status: "" });
          setOperationStatus("");
        }
      }
      if (type === "SHOW_ORIGINAL") {
        setPageState("original");
        setAppliedTarget(undefined);
        setRestored(true);
        setOperationStatus(authenticated ? "" : "status.originalRestored");
      }
    } catch {
      if (!operationIsCurrent(generation, operation)) return;
      if (type === "START_TRANSLATION") {
        setPageState("error");
        setOperationStatus("");
      } else {
        setOperationStatus("status.cannotTranslate");
      }
    } finally {
      if (operationIsCurrent(generation, operation)) setBusy(false);
    }
  }
  /**
   * Stop a running page translation: retire the in-flight START_TRANSLATION
   * (its late response is ignored) and send SHOW_ORIGINAL, which cancels the
   * content run and restores the exact source. The popup returns to the
   * untranslated state.
   */
  async function stopTranslation() {
    if (!translationActive || workspaceReaderMode) return;
    const generation = authGeneration.current;
    const operation = ++operationGeneration.current;
    setBusy(false);
    try {
      const current = await activeTab();
      if (!operationIsCurrent(generation, operation)) return;
      if (!current?.id) throw new Error("No active tab");
      await browser.tabs.sendMessage(current.id, { type: "SHOW_ORIGINAL" });
      if (!operationIsCurrent(generation, operation)) return;
      setPageState("original");
      setAppliedTarget(undefined);
      setRestored(false);
      setOperationStatus("status.translationStopped");
    } catch {
      if (operationIsCurrent(generation, operation))
        setOperationStatus("status.cannotTranslate");
    }
  }
  async function toggle(value: boolean) {
    setAlways(value);
    await extensionStorage.set(canonicalPreferenceKey(host), {
      enabled: value,
      targetLanguage: target,
    });
  }
  async function chooseTarget(value: TargetLanguage) {
    setTarget(value);
    if (workspaceReaderMode) {
      await saveReaderPreferences({ targetLanguage: value });
      return;
    }
    await extensionStorage.set(canonicalPreferenceKey(host), {
      enabled: always,
      targetLanguage: value,
    });
  }
  async function clearSavedTranslations() {
    if (translationInProgress) return;
    if (!window.confirm(t.t("status.clearConfirm"))) return;
    setBusy(true);
    const generation = authGeneration.current;
    const operation = ++operationGeneration.current;
    setOperationStatus("status.clearing");
    try {
      await browser.runtime.sendMessage({ type: "CLEAR_SAVED_TRANSLATIONS" });
      if (!operationIsCurrent(generation, operation)) return;
      setOperationStatus("status.cleared");
    } catch {
      if (!operationIsCurrent(generation, operation)) return;
      setOperationStatus("status.clearFailed");
    } finally {
      if (operationIsCurrent(generation, operation)) setBusy(false);
    }
  }
  async function openLocalSpreadsheetReader() {
    if (localFileOpeningRef.current) return;
    localFileOpeningRef.current = true;
    setLocalFileOpening(true);
    try {
      await browser.tabs.create({
        url: browser.runtime.getURL("/reader.html?local=1" as never),
      });
      window.close();
    } catch {
      setOperationStatus("status.localReaderFailed");
    } finally {
      localFileOpeningRef.current = false;
      setLocalFileOpening(false);
    }
  }
  const statusReady = authenticated && !initial.authUnavailable;
  const sheetsComingSoon = !available && Boolean(initial.sheetsComingSoon);
  const notice = topStatusNotice({
    onDeviceUnsupported: statusReady && onDeviceBlocked,
    sheetsComingSoon,
  });
  const openSettings = () => void browser.runtime.openOptionsPage();
  const noticeNode =
    notice === "on-device-unsupported" ? (
      <OnDeviceNotice onOpenSettings={openSettings} />
    ) : notice === "sheets-coming-soon" ? (
      <SheetsComingSoonNotice
        message={t.text(unavailableMessage)}
        opening={localFileOpening}
        onOpen={() => void openLocalSpreadsheetReader()}
      />
    ) : undefined;
  const slotVisible = Boolean(noticeNode);
  const showTools =
    authenticated &&
    !initial.authChecking &&
    !initial.authUnavailable &&
    // On a Sheet the coming-soon notice carries the same action; when a
    // more urgent notice takes the slot, the tool row keeps it reachable.
    (!initial.sheetsComingSoon || notice !== "sheets-coming-soon");
  const translateView = translateControlView({
    readerMode: workspaceReaderMode,
    readerOpening: workspaceReaderMode && busy,
    pageState,
    translationActive,
    translated,
    retarget,
    restored,
    label: translateLabel,
    disabled: translateDisabled,
    originalLocked: translationInProgress,
  });
  const pageStatusKind = pageStatusFor({
    readerMode: workspaceReaderMode,
    pageState,
    translated,
    restored,
    translationActive,
  });
  const pageStatusLine = pageStatusKind ? (
    <PageStatusLine
      status={pageStatusKind}
      action={
        pageStatusKind === "partial" && !retarget
          ? {
              label: t.t("page.translateRest"),
              disabled: translateDisabled,
              onClick: startTranslation,
            }
          : undefined
      }
    >
      {pageStatusKind === "translated" || pageStatusKind === "partial"
        ? pageStatusKind === "partial"
          ? t.t("page.statusPartial")
          : t.t("page.statusTranslated", {
              language: t.t(languageKey(appliedTarget ?? target)),
            })
        : pageStatusKind === "original"
          ? t.t("page.statusOriginal")
          : t.t("status.translateFailed")}
    </PageStatusLine>
  ) : null;
  const disabledReason =
    translateView.kind === "button" && translateView.disabled
      ? initial.authChecking
        ? t.t("translate.checkingSession")
        : onDeviceBlocked
          ? t.t("translate.freeBlocked")
          : undefined
      : undefined;
  let content: ReactNode;
  if (!available)
    content = (
      <PageCard host={host}>
        <p className="mt-3 text-[13px] leading-[18px] text-ink-soft">
          {t.text(sheetsComingSoon ? "page.sheetsInPlace" : unavailableMessage)}
        </p>
      </PageCard>
    );
  else if (!authenticated)
    content = (
      <PageCard host={host}>
        <p className="mt-3 text-[13px] leading-[18px] text-ink-soft">
          {t.t("page.serviceUnavailable")}
        </p>
      </PageCard>
    );
  else
    content = (
      <>
        <PageCard host={host}>
          <LanguageRow
            detected={workspaceReaderMode ? undefined : pageLanguage}
            target={
              <Select
                variant="popup"
                labelHidden
                disabled={translationInProgress}
                label={t.t("page.translateTo")}
                options={targetOptions}
                value={target}
                onValueChange={(value) =>
                  void chooseTarget(value as TargetLanguage)
                }
              />
            }
          />
          {pageStatusLine}
          <div className={pageStatusLine ? "mt-2.5" : "mt-3"}>
            <TranslateControl
              view={translateView}
              describedBy={
                disabledReason ? "translate-disabled-reason" : undefined
              }
              onTranslate={startTranslation}
              onShowOriginal={() => void send("SHOW_ORIGINAL")}
              onStop={() => void stopTranslation()}
            />
          </div>
          {disabledReason ? (
            <DisabledReason id="translate-disabled-reason">
              {disabledReason}
            </DisabledReason>
          ) : null}
          {!workspaceReaderMode &&
          translationInProgress &&
          nativeProgress?.phase === "downloading" ? (
            <NativeDownloadProgress progress={nativeProgress} />
          ) : null}
          {!workspaceReaderMode ? (
            <AlwaysTranslateSwitch
              checked={always}
              onChange={(value) => void toggle(value)}
            />
          ) : null}
        </PageCard>
      </>
    );
  return (
    <main
      className="flex w-90 flex-col gap-3 bg-paper font-sans text-ink"
      aria-busy="false"
    >
      <PopupHeader
        settings={
          <SettingsButton
            label={t.t("settings.open")}
            {...(authenticated && initial.providerKeyRejected
              ? { hint: t.t("engine.keyRejected"), tone: "warn" as const }
              : authenticated && initial.engineSource === "on-device"
                ? { hint: t.t("engine.onDevice"), tone: "info" as const }
                : {})}
            onOpen={openSettings}
          />
        }
        account={
          <AccountMenu
            clearDisabled={translationInProgress}
            onClear={() => void clearSavedTranslations()}
          />
        }
      />
      {content}
      {showTools ? (
        <LocalSpreadsheetTool
          opening={localFileOpening}
          onOpen={() => void openLocalSpreadsheetReader()}
        />
      ) : null}
      <StatusSlot notice={noticeNode} />
      <p
        role="status"
        aria-live="polite"
        className={
          slotVisible
            ? "-mt-1 px-4 pb-3 text-xs leading-4 text-muted"
            : "px-4 pb-3 text-xs leading-4 text-muted empty:-mt-3 empty:pb-1"
        }
      >
        {!displayedStatus ? null : (
          <span key={displayedStatus} className="block animate-rl-fade">
            {t.text(displayedStatus)}
          </span>
        )}
      </p>
    </main>
  );
}

function App() {
  const [initial, setInitial] = useState<PopupBootstrapResult>();
  const authGeneration = useRef(0);
  useEffect(() => {
    let active = true;
    let latestAuthentication:
      Promise<AuthStatusResponse | undefined> | undefined;
    const handleAuthStateChanged = (message: unknown) => {
      if (
        (message as { type?: string } | undefined)?.type !==
        "AUTH_STATE_CHANGED"
      )
        return;
      const generation = ++authGeneration.current;
      setInitial((current) =>
        current
          ? {
              ...current,
              contentRevision: generation,
              authChecking: true,
            }
          : current,
      );
      const request = readAuthentication();
      latestAuthentication = request;
      void request.then((authStatus) => {
        if (
          !active ||
          latestAuthentication !== request ||
          authGeneration.current !== generation
        )
          return;
        setInitial((current) =>
          current
            ? {
                ...current,
                ...authenticationState(authStatus, current.pageState, current),
                authChecking: false,
              }
            : current,
        );
      });
    };
    browser.runtime.onMessage.addListener(handleAuthStateChanged);
    void bootstrapPopup().then(async (result) => {
      while (latestAuthentication) {
        const request = latestAuthentication;
        const authStatus = await request;
        if (!active) return;
        if (latestAuthentication !== request) continue;
        result = {
          ...result,
          ...authenticationState(authStatus, result.pageState, result),
        };
        break;
      }
      if (active) setInitial(result);
    });
    return () => {
      active = false;
      browser.runtime.onMessage.removeListener(handleAuthStateChanged);
    };
  }, []);
  return initial ? (
    <UiLocaleProvider initialLocale={initial.uiLocale}>
      <PopupReady
        initial={initial}
        authGeneration={authGeneration}
        onAuthenticationChange={(authentication) => {
          ++authGeneration.current;
          setInitial((current) =>
            current
              ? {
                  ...current,
                  ...authentication,
                  authChecking: false,
                }
              : current,
          );
        }}
      />
    </UiLocaleProvider>
  ) : (
    <UiLocaleScope locale={resolveUiLocale(undefined, browserUiLanguage())}>
      <PopupSkeleton />
    </UiLocaleScope>
  );
}

export default App;
