import React from "react";
import ReactDOM from "react-dom/client";

import "./theme.css";
import App, {
  driveOfficeReaderPath,
  openReaderTabFallback,
  type DriveOfficeReaderSource,
} from "./App.tsx";
import LocalSpreadsheetReader from "./LocalSpreadsheetReader.tsx";
import {
  isLocalReaderGuidanceError,
  parseWorkspaceReaderSourceChanged,
  parseWorkspaceEditorUrl,
  parseWorkspaceReaderOpen,
  type WorkspaceReaderRequest,
  type WorkspaceReaderResponse,
  type WorkspaceEditorContext,
  type WorkspaceSourceVersion,
} from "@/lib/google-workspace-reader";
import { type WorkspaceReaderIntent } from "@/lib/workspace-reader-intent";
import { readerMessages } from "@/lib/i18n/catalog/reader";
import { UiLocaleProvider, useMessages } from "@/lib/i18n/react";
import { ReaderHeader } from "./ReaderHeader";
import { SpreadsheetReaderSourceState } from "./SpreadsheetReaderControls";
import "./style.css";

type ReaderMode =
  | {
      kind: "google";
      awaitingStart?: boolean;
      sourceTitle?: string;
      desiredSheetId?: string;
      key?: string;
    }
  | { kind: "local-file" }
  | { kind: "identifying" }
  | { kind: "unavailable"; fallbackSourceTabId?: number }
  | ({
      kind: "drive-office";
      awaitingStart?: boolean;
      sourceTitle?: string;
      translateIntent?: WorkspaceReaderIntent;
      key?: string;
    } & DriveOfficeReaderSource);

/**
 * One pane per source tab. Switching browser tabs only changes which pane is
 * visible, so a translation running in a background tab keeps going.
 */
interface Pane {
  key: string;
  /** Tab the Root tracks for this pane; may resolve after first render. */
  tabId?: number;
  /** Tab handed to the adapter at mount; never changes for a mounted pane. */
  appTabId?: number;
  mode: ReaderMode;
}
interface ReaderView {
  panes: Pane[];
  activeKey: string;
}
let paneSeq = 0;
const newPaneKey = () => `pane-${++paneSeq}`;
const isLive = (mode: ReaderMode) =>
  mode.kind === "google" || mode.kind === "drive-office";

function initialView(): ReaderView {
  const params = new URLSearchParams(window.location.search);
  if (params.get("local") === "1") return { panes: [], activeKey: "" };
  const parsed = Number(params.get("sourceTabId"));
  const tabId = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
  const pane: Pane = {
    key: newPaneKey(),
    tabId,
    appTabId: tabId,
    mode: {
      kind: "google",
      awaitingStart: params.get("awaitStart") === "1",
      desiredSheetId: params.get("readerSheetId") ?? undefined,
    },
  };
  return { panes: [pane], activeKey: pane.key };
}

export function ReaderRoot() {
  const isLocalFile =
    new URLSearchParams(window.location.search).get("local") === "1";
  const [view, setView] = React.useState<ReaderView>(initialView);
  const viewRef = React.useRef(view);
  const t = useMessages(readerMessages);
  React.useEffect(() => {
    // index.html keeps the English title; the active UI locale names the tab.
    document.title = t.t("shell.documentTitle");
  }, [t]);
  const [fallbackOpening, setFallbackOpening] = React.useState(false);
  const [fallbackError, setFallbackError] = React.useState(false);
  const hostingTabIdRef = React.useRef<number | null | undefined>(null);
  const observedSource = React.useRef(
    new Map<
      number,
      { context: WorkspaceEditorContext; version: WorkspaceSourceVersion }
    >(),
  );
  const commit = React.useCallback((next: ReaderView) => {
    viewRef.current = next;
    setView(next);
  }, []);
  const replaceReaderPath = React.useCallback((hostedPath: string) => {
    window.history.replaceState(
      {},
      "",
      hostingTabIdRef.current === undefined ? "/reader.html" : hostedPath,
    );
  }, []);
  const paneForTab = React.useCallback(
    (tabId: number) => viewRef.current.panes.find((p) => p.tabId === tabId),
    [],
  );
  const paneForKey = React.useCallback(
    (key: string) => viewRef.current.panes.find((p) => p.key === key),
    [],
  );
  const activeTabId = React.useCallback(() => {
    const current = viewRef.current;
    return current.panes.find((p) => p.key === current.activeKey)?.tabId;
  }, []);
  /** Replaces or creates the single Reader pane owned by a browser tab. */
  const upsertPane = React.useCallback(
    (tabId: number, mode: ReaderMode, activate = false) => {
      const current = viewRef.current;
      const existing = current.panes.find((p) => p.tabId === tabId);
      const wasActive = existing?.key === current.activeKey;
      const pane: Pane = existing
        ? {
            ...existing,
            mode,
            appTabId: tabId,
          }
        : {
            key: newPaneKey(),
            tabId,
            appTabId: tabId,
            mode,
          };
      commit({
        panes: existing
          ? current.panes.map((p) => (p === existing ? pane : p))
          : [...current.panes, pane],
        activeKey: activate || wasActive ? pane.key : current.activeKey,
      });
    },
    [commit],
  );
  const activatePane = React.useCallback(
    (pane: Pane) => {
      const current = viewRef.current;
      commit({ ...current, activeKey: pane.key });
    },
    [commit],
  );
  const setPaneMode = React.useCallback(
    (key: string, mode: ReaderMode) => {
      const current = viewRef.current;
      commit({
        ...current,
        panes: current.panes.map((p) => (p.key === key ? { ...p, mode } : p)),
      });
    },
    [commit],
  );
  const observeSource = React.useCallback(
    (context: WorkspaceEditorContext, version: WorkspaceSourceVersion) => {
      const observed = observedSource.current.get(context.sourceTabId);
      if (
        observed?.version.backgroundEpoch === version.backgroundEpoch &&
        observed.version.sourceRevision > version.sourceRevision
      )
        return;
      observedSource.current.set(context.sourceTabId, { context, version });
    },
    [],
  );
  React.useEffect(() => {
    if (isLocalFile) return;
    let disposed = false;
    let navRevision = 0;
    let revisionSeq = 0;
    const identifyRevision = new Map<number, number>();
    const identified = new Map<number, { fileId: string; kind: string }>();
    const lastSourceVersion = new Map<
      number,
      { backgroundEpoch: string; sourceRevision: number }
    >();
    let sourceWindowId: number | undefined;
    let hostingTabId: number | undefined;
    const urlTabId = Number(
      new URLSearchParams(window.location.search).get("sourceTabId"),
    );
    const bindingReady = Promise.all([
      Number.isSafeInteger(urlTabId) && urlTabId > 0
        ? browser.tabs.get(urlTabId).catch(() => undefined)
        : browser.tabs
            .query({ active: true, currentWindow: true })
            .then((tabs) => tabs[0])
            .catch(() => undefined),
      browser.tabs.getCurrent().catch(() => undefined),
    ]).then(([sourceTab, hostingTab]) => {
      if (disposed) return;
      const current = viewRef.current;
      const first = current.panes.find((p) => p.key === current.activeKey);
      if (navRevision === 0 && first?.tabId === undefined && first) {
        if (sourceTab?.id !== undefined)
          commit({
            ...current,
            panes: current.panes.map((p) =>
              p === first ? { ...p, tabId: sourceTab.id } : p,
            ),
          });
      }
      sourceWindowId = sourceTab?.windowId;
      hostingTabId = hostingTab?.id;
      hostingTabIdRef.current = hostingTab?.id;
    });
    const owner = globalThis.crypto.randomUUID();
    const showTab = (tabId: number) => {
      // The global panel hosts every bound tab; a tab-specific URL would make
      // background requests from its hidden panes look forged after a switch.
      replaceReaderPath(`/reader.html?sourceTabId=${tabId}`);
    };
    const identify = async (tabId: number, silent = false) => {
      const requestId = ++revisionSeq;
      identifyRevision.set(tabId, requestId);
      const previous = observedSource.current.get(tabId);
      if (!silent) upsertPane(tabId, { kind: "identifying" });
      const request = {
        type: "WORKSPACE_READER_CONTEXT",
        sourceTabId: tabId,
        readerInstanceId: owner,
        requestId,
        identifySource: true,
      } satisfies WorkspaceReaderRequest;
      const response = (await browser.runtime
        .sendMessage(request)
        .catch(() => undefined)) as WorkspaceReaderResponse | undefined;
      if (disposed || identifyRevision.get(tabId) !== requestId) return;
      if (
        response?.type === request.type &&
        response.readerInstanceId === owner &&
        response.requestId === requestId &&
        !response.ok &&
        isLocalReaderGuidanceError(response.error)
      ) {
        // ADR 0015: the flag is off or the file is a Drive Office workbook.
        // The source adapter re-reads this context and shows the download
        // guidance with the Local Reader action, not a generic failure.
        identified.delete(tabId);
        upsertPane(tabId, {
          kind: "google",
          key: `${tabId}:local-reader-guidance:${requestId}`,
          awaitingStart: true,
        });
        return;
      }
      if (
        !response?.ok ||
        response.type !== request.type ||
        response.readerInstanceId !== owner ||
        response.requestId !== requestId ||
        response.context.sourceTabId !== tabId
      ) {
        upsertPane(tabId, {
          kind: "unavailable",
          fallbackSourceTabId:
            response?.type === request.type &&
            response.readerInstanceId === owner &&
            response.requestId === requestId &&
            !response.ok &&
            response.error === "reader-channel-unavailable"
              ? tabId
              : undefined,
        });
        return;
      }
      const kind = response.sourceKind ?? "native";
      const key = `${tabId}:${response.context.fileId}:${kind}:${requestId}`;
      // What this tab's pane currently shows: the last identified file, else
      // the file its own handshake reported (observed before this response).
      const shown =
        identified.get(tabId) ??
        (previous
          ? {
              fileId: previous.context.fileId,
              kind:
                paneForTab(tabId)?.mode.kind === "drive-office"
                  ? "office"
                  : "native",
            }
          : undefined);
      observeSource(response.context, response.version);
      if (
        silent &&
        shown?.fileId === response.context.fileId &&
        shown.kind === kind
      )
        return; // same file: a worksheet/gid change must leave Reader untouched
      identified.set(tabId, { fileId: response.context.fileId, kind });
      upsertPane(
        tabId,
        response.sourceKind === "office"
          ? {
              kind: "drive-office",
              sourceTabId: tabId,
              fileId: response.context.fileId,
              version: response.version,
              key,
              awaitingStart: true,
              sourceTitle: response.sourceTitle,
            }
          : {
              kind: "google",
              key,
              awaitingStart: true,
              sourceTitle: response.sourceTitle,
            },
      );
    };
    const retireAll = (activeId: number | undefined, mode: ReaderMode) => {
      identifyRevision.clear();
      identified.clear();
      lastSourceVersion.clear();
      const pane: Pane = {
        key: newPaneKey(),
        tabId: activeId,
        appTabId: activeId,
        mode,
      };
      commit({ panes: [pane], activeKey: pane.key });
    };
    const onMessage = (
      message: unknown,
      sender?: { id?: string; tab?: unknown },
    ) => {
      const open = parseWorkspaceReaderOpen(message);
      if (open) {
        if (sender?.id !== browser.runtime.id || sender.tab) return;
        void (async () => {
          await bindingReady;
          if (
            disposed ||
            hostingTabId !== undefined ||
            sourceWindowId === undefined ||
            (open.sourceWindowId !== undefined &&
              open.sourceWindowId !== sourceWindowId)
          )
            return;
          const expectedRevision = navRevision;
          const target = await browser.tabs
            .get(open.sourceTabId)
            .catch(() => undefined);
          if (
            disposed ||
            navRevision !== expectedRevision ||
            target?.windowId !== sourceWindowId ||
            !parseWorkspaceEditorUrl(target.url ?? "")
          )
            return;
          const existing = paneForTab(open.sourceTabId);
          if (existing && isLive(existing.mode)) {
            if (viewRef.current.activeKey !== existing.key) {
              activatePane(existing);
              showTab(open.sourceTabId);
            }
            return;
          }
          navRevision += 1;
          identifyRevision.delete(open.sourceTabId);
          identified.delete(open.sourceTabId);
          lastSourceVersion.delete(open.sourceTabId);
          showTab(open.sourceTabId);
          upsertPane(
            open.sourceTabId,
            { kind: "google", key: `open:${++revisionSeq}` },
            true,
          );
        })();
        return;
      }
      if ((message as { type?: unknown })?.type === "AUTH_STATE_CHANGED") {
        navRevision += 1;
        retireAll(activeTabId(), { kind: "unavailable" });
        return;
      }
      const change = parseWorkspaceReaderSourceChanged(message);
      if (!change) return;
      const tabId = change.sourceTabId;
      if (!paneForTab(tabId)) return;
      const observed = observedSource.current.get(tabId);
      if (
        observed?.version.backgroundEpoch === change.version.backgroundEpoch &&
        change.version.sourceRevision <= observed.version.sourceRevision
      )
        return;
      const last = lastSourceVersion.get(tabId);
      if (
        last?.backgroundEpoch === change.version.backgroundEpoch &&
        change.version.sourceRevision <= last.sourceRevision
      )
        return;
      lastSourceVersion.set(tabId, change.version);
      const silent = change.version.sourceRevision === 0;
      if (activeTabId() !== tabId) {
        // The background only authorizes a first claim from the active tab:
        // a hidden pane whose file really changed is retired now and
        // identified when the user returns to it.
        if (silent) return;
        identifyRevision.delete(tabId);
        identified.delete(tabId);
        upsertPane(tabId, { kind: "identifying" });
        return;
      }
      // Revision 0 = the background lost its record (restart): verify silently.
      void identify(tabId, silent);
    };
    const onActivated = ({
      tabId,
      windowId,
    }: {
      tabId: number;
      windowId?: number;
    }) => {
      void (async () => {
        await bindingReady;
        if (
          disposed ||
          hostingTabId !== undefined ||
          sourceWindowId === undefined ||
          (windowId !== undefined && windowId !== sourceWindowId) ||
          tabId === activeTabId()
        )
          return;
        const expectedRevision = ++navRevision;
        const existing = paneForTab(tabId);
        if (existing && isLive(existing.mode)) {
          // Returning to a loaded tab only reveals its pane; its work kept running.
          activatePane(existing);
          showTab(tabId);
          return;
        }
        identified.delete(tabId);
        lastSourceVersion.delete(tabId);
        upsertPane(tabId, { kind: "identifying" }, true);
        const target = await browser.tabs.get(tabId).catch(() => undefined);
        if (disposed || navRevision !== expectedRevision) return;
        if (
          target?.windowId !== sourceWindowId ||
          !parseWorkspaceEditorUrl(target.url ?? "")
        ) {
          // An unrelated page retires every pane in this window, as the
          // background does; returning never reopens or translates by itself.
          retireAll(tabId, { kind: "unavailable" });
          return;
        }
        showTab(tabId);
        await identify(tabId);
      })();
    };
    const onRemoved = (tabId: number) => {
      identifyRevision.delete(tabId);
      identified.delete(tabId);
      lastSourceVersion.delete(tabId);
      observedSource.current.delete(tabId);
      if (hostingTabId !== undefined) return;
      const current = viewRef.current;
      const removed = current.panes.filter((p) => p.tabId === tabId);
      if (!removed.length) return;
      const panes = current.panes.filter((p) => p.tabId !== tabId);
      commit({
        panes,
        activeKey: removed.some((p) => p.key === current.activeKey)
          ? (panes[panes.length - 1]?.key ?? "")
          : current.activeKey,
      });
    };
    browser.runtime.onMessage.addListener(onMessage);
    browser.tabs.onActivated.addListener(onActivated);
    browser.tabs.onRemoved?.addListener(onRemoved);
    return () => {
      disposed = true;
      navRevision += 1;
      identifyRevision.clear();
      browser.runtime.onMessage.removeListener(onMessage);
      browser.tabs.onActivated.removeListener(onActivated);
      browser.tabs.onRemoved?.removeListener(onRemoved);
    };
  }, [
    isLocalFile,
    commit,
    observeSource,
    paneForTab,
    activeTabId,
    upsertPane,
    activatePane,
    replaceReaderPath,
  ]);

  if (isLocalFile) return <LocalSpreadsheetReader />;

  const renderStatus = (mode: ReaderMode, paneKey: string) => (
    <main className="reader-shell" aria-busy={mode.kind === "identifying"}>
      <ReaderHeader subtitle={t.t("reader.brandSubtitle")}>
        <span className="connection">
          {t.t(
            mode.kind === "identifying"
              ? "shell.loadingSource"
              : "shell.notLoaded",
          )}
        </span>
      </ReaderHeader>
      <section className="reader-results sheets-results">
        <SpreadsheetReaderSourceState
          phase={mode.kind === "identifying" ? "identifying" : "error"}
          description={
            mode.kind === "unavailable"
              ? t.t(
                  mode.fallbackSourceTabId === undefined
                    ? "shell.openSupportedSpreadsheet"
                    : fallbackError
                      ? "shell.openTabFailed"
                      : "shell.cannotVerifySource",
                )
              : undefined
          }
        />
        {mode.kind === "unavailable" &&
        mode.fallbackSourceTabId !== undefined ? (
          <button
            type="button"
            className="primary-button"
            disabled={fallbackOpening}
            onClick={() => {
              const expectedMode = mode;
              setFallbackError(false);
              setFallbackOpening(true);
              void openReaderTabFallback(
                mode.fallbackSourceTabId!,
                true,
                undefined,
                () => paneForKey(paneKey)?.mode === expectedMode,
              )
                .catch(() => {
                  if (paneForKey(paneKey)?.mode === expectedMode)
                    setFallbackError(true);
                })
                .finally(() => setFallbackOpening(false));
            }}
          >
            {t.t(fallbackOpening ? "shell.openingReader" : "shell.openInTab")}
          </button>
        ) : null}
      </section>
    </main>
  );

  const renderPane = (pane: Pane) => {
    const mode = pane.mode;
    if (mode.kind === "local-file") return <LocalSpreadsheetReader />;
    if (mode.kind === "identifying" || mode.kind === "unavailable")
      return renderStatus(mode, pane.key);
    if (mode.kind === "drive-office") {
      return (
        <LocalSpreadsheetReader
          key={mode.key}
          source={mode}
          managedSourceLifecycle
          awaitingStart={mode.awaitingStart}
          sourceTitle={mode.sourceTitle}
          translateIntent={mode.translateIntent}
          onExitDriveOffice={() => {
            if (paneForKey(pane.key)?.mode !== mode) return;
            if (viewRef.current.activeKey === pane.key)
              replaceReaderPath(`/reader.html?sourceTabId=${mode.sourceTabId}`);
            setPaneMode(pane.key, {
              kind: "google",
              awaitingStart: true,
              key: globalThis.crypto.randomUUID(),
            });
          }}
        />
      );
    }
    return (
      <App
        key={mode.key}
        sourceTabId={pane.appTabId}
        managedSourceLifecycle
        onSourceIdentified={observeSource}
        awaitingStart={mode.awaitingStart}
        desiredSheetId={mode.desiredSheetId}
        sourceTitle={mode.sourceTitle}
        onOpenDriveOfficeSpreadsheet={(source, translateIntent) => {
          if (viewRef.current.activeKey === pane.key)
            replaceReaderPath(driveOfficeReaderPath(source.sourceTabId));
          setPaneMode(pane.key, {
            kind: "drive-office",
            ...source,
            awaitingStart: source.awaitingStart ?? mode.awaitingStart,
            sourceTitle: source.sourceTitle ?? mode.sourceTitle,
            translateIntent,
          });
        }}
      />
    );
  };

  if (!view.panes.some((p) => p.key === view.activeKey))
    return renderStatus({ kind: "unavailable" }, "");
  return (
    <div className="reader-panes">
      {view.panes.map((pane) => {
        const active = pane.key === view.activeKey;
        return (
          <div
            key={pane.key}
            className="reader-pane"
            data-active={active}
            aria-hidden={active ? undefined : true}
          >
            {renderPane(pane)}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The Reader page: the shell in the UI locale, which it asks the background
 * for (`UI_LOCALE_GET`) and keeps following (`UI_LOCALE_CHANGED`).
 */
export function ReaderPage() {
  return (
    <UiLocaleProvider>
      <ReaderRoot />
    </UiLocaleProvider>
  );
}

const root = document.getElementById("root");
if (root)
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <ReaderPage />
    </React.StrictMode>,
  );
