import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertCircle,
  FileSpreadsheet,
  Languages,
  LoaderCircle,
  RefreshCw,
  Trash2,
} from "lucide-react";

import { Select, type SelectOption } from "@/components/Select";
import {
  isLocalReaderGuidanceError,
  MAX_LOADED_RECORDS,
  MAX_LOADED_SOURCE_CHARACTERS,
  MAX_TRANSLATION_MESSAGE_CHARACTERS,
  MAX_TRANSLATION_MESSAGE_RECORDS,
  MAX_TRANSLATION_RECORD_CHARACTERS,
  type WorkspaceEditorContext,
  type WorkspaceLoadCursor,
  type WorkspaceReaderErrorCode,
  type WorkspaceReaderRequest,
  type WorkspaceReaderResponse,
  type WorkspaceReaderSheetDescriptor,
  type WorkspaceReaderTab,
  type WorkspaceRecord,
  type WorkspaceSourceVersion,
  type WorkspaceSheetGrid,
  type WorkspaceSheetDiscoveryAxis,
  type WorkspaceSheetDiscoveryCursor,
  type WorkspaceSheetPage,
  parseWorkspaceReaderSourceChanged,
  parseWorkspaceEditorUrl,
} from "@/lib/google-workspace-reader";
import {
  INITIAL_SPREADSHEET_TRANSLATION_STATE,
  deriveSpreadsheetTranslationCapabilities,
  transitionSpreadsheetTranslation,
  type SpreadsheetTranslationState,
} from "@/lib/spreadsheet-reader-state";
import { TARGET_LANGUAGES, type TargetLanguage } from "@/lib/translation";
import {
  readReaderPreferences,
  saveReaderPreferences,
} from "@/lib/reader-preferences";
import { LOCAL_READER_PATH } from "@/lib/workspace-features";
import { languageKey } from "@/lib/i18n/catalog/common";
import { readerMessages, type ReaderMessage } from "@/lib/i18n/catalog/reader";
import { useMessages } from "@/lib/i18n/react";
import {
  GOOGLE_WORKSPACE_OPTIONAL_HOST_PERMISSIONS,
  GOOGLE_WORKSPACE_OPTIONAL_PERMISSIONS,
} from "@/shared/google-workspace-config";
import { ReaderHeader } from "./ReaderHeader";
import SheetsGrid from "./SheetsGrid";
import SpreadsheetReaderControls, {
  SpreadsheetReaderSourceState,
  type SpreadsheetReaderActionableMessage,
  type SpreadsheetSourcePhase,
} from "./SpreadsheetReaderControls";
import {
  readerIntentKey,
  readerIntentForCurrentSource,
  readReaderIntent,
  takeReaderIntent,
  readerIntentIsCurrent,
  type WorkspaceReaderIntent,
} from "@/lib/workspace-reader-intent";

type PendingAction =
  | "context"
  | "connect"
  | "select"
  | "discover"
  | "load"
  | "translate"
  | "disconnect";
type RecordError = "unresolved" | "provider-error" | "too-large";
type ReaderRecord = WorkspaceRecord & {
  translation?: string;
  translationError?: RecordError;
};

type DiscoveryState =
  | { status: "idle" }
  | {
      status: "scanning" | "paused";
      axis: WorkspaceSheetDiscoveryAxis;
      scanned: number;
      total: number;
      cursor: WorkspaceSheetDiscoveryCursor | null;
    }
  | { status: "complete" };

function discoveryStatus(
  axis: WorkspaceSheetDiscoveryAxis,
  scanned: number,
  total: number,
): ReaderMessage {
  return {
    key:
      axis === "rows"
        ? "workspace.status.discoveringRows"
        : "workspace.status.discoveringColumns",
    params: { scanned, total },
  };
}

function recordsLoaded(count: number): ReaderMessage {
  return { key: "workspace.status.recordsLoaded", params: { count } };
}

/** Status/announcement refs are compared by value to skip no-op updates. */
function sameMessage(left: ReaderMessage | "", right: ReaderMessage | "") {
  return (
    left === right ||
    (typeof left === "object" &&
      typeof right === "object" &&
      JSON.stringify(left) === JSON.stringify(right))
  );
}

interface AcceptedTranslation {
  sourceHash: string;
  text: string;
}

interface ReaderState {
  sourceTabId?: number;
  configured?: boolean;
  connection: "checking" | "connected" | "disconnected" | "unavailable";
  context?: WorkspaceEditorContext;
  title: string;
  records: ReaderRecord[];
  grid?: WorkspaceSheetGrid;
  pages: Map<number, WorkspaceSheetPage>;
  translations: Map<string, AcceptedTranslation>;
  unresolved: Set<string>;
  oversized: Set<string>;
  discovery: DiscoveryState;
  cursor: WorkspaceLoadCursor;
  tabs: WorkspaceReaderTab[];
  sheets: WorkspaceReaderSheetDescriptor[];
  targetLanguage: TargetLanguage;
  generation?: number;
  version?: WorkspaceSourceVersion;
  spreadsheetTranslation: SpreadsheetTranslationState;
  completionAnnouncement: ReaderMessage | "";
  selected: Set<string>;
  pending?: PendingAction;
  status: ReaderMessage | "";
  error?: ReaderMessage;
  /** The error is the launch notice: offer the Local Reader (ADR 0015). */
  localReaderGuidance?: boolean;
  channelUnavailable?: boolean;
}

const initialState: ReaderState = {
  connection: "checking",
  title: "",
  records: [],
  pages: new Map(),
  translations: new Map(),
  unresolved: new Set(),
  oversized: new Set(),
  discovery: { status: "idle" },
  cursor: null,
  tabs: [],
  sheets: [],
  targetLanguage: "vi",
  selected: new Set(),
  spreadsheetTranslation: INITIAL_SPREADSHEET_TRANSLATION_STATE,
  completionAnnouncement: "",
  pending: "context",
  status: "workspace.status.loadingReader",
};

export interface ReaderSheetMock {
  grid: WorkspaceSheetGrid;
  pages: readonly WorkspaceSheetPage[];
  translations?: ReadonlyMap<string, string>;
}

interface AppProps {
  sheetMock?: ReaderSheetMock;
  /** Tab this pane is bound to; panes of other tabs stay mounted alongside. */
  sourceTabId?: number;
  managedSourceLifecycle?: boolean;
  awaitingStart?: boolean;
  desiredSheetId?: string;
  sourceTitle?: string;
  onSourceIdentified?: (
    context: WorkspaceEditorContext,
    version: WorkspaceSourceVersion,
  ) => void;
  onOpenDriveOfficeSpreadsheet?: (
    source: DriveOfficeReaderSource,
    intent?: WorkspaceReaderIntent,
  ) => void;
}

export interface DriveOfficeReaderSource {
  fileId?: string;
  sourceTabId: number;
  version: WorkspaceSourceVersion;
  sourceTitle?: string;
  awaitingStart?: boolean;
}

export function driveOfficeReaderPath(sourceTabId: number) {
  return `/reader.html?office=1&sourceTabId=${sourceTabId}`;
}

interface SheetTranslationRun {
  id: number;
  session: number;
  sourceTabId: number;
  generation: number;
  targetLanguage: TargetLanguage;
  pending: boolean;
  eligible: ReadonlySet<string> | null;
  settled: Set<string>;
  resolvedIds: Set<string>;
  unresolvedIds: Set<string>;
  translated: number;
}

interface SheetWorkerRecovery {
  session: number;
  context: WorkspaceEditorContext;
  pages: Set<number>;
  run?: SheetTranslationRun;
}

interface SheetPageLoad {
  sourceTabId: number;
  cursor: WorkspaceLoadCursor;
  grid: WorkspaceSheetGrid;
  session: number;
  startRow: number;
  version: WorkspaceSourceVersion;
}

const errorMessages: Record<WorkspaceReaderErrorCode, ReaderMessage> = {
  "not-configured": "workspace.error.notConfigured",
  "unsupported-browser": "workspace.error.unsupportedBrowser",
  "unsupported-url": "workspace.error.unsupportedUrl",
  "unsupported-file-type": "workspace.error.unsupportedFileType",
  "google-auth-required": "workspace.error.googleAuthRequired",
  "google-access-denied": "workspace.error.googleAccessDenied",
  "google-oauth-configuration": "workspace.error.googleOauthConfiguration",
  "google-oauth-response": "workspace.error.googleOauthResponse",
  "google-oauth-scope": "workspace.error.googleOauthScope",
  "google-oauth-expired": "workspace.error.googleOauthExpired",
  "google-oauth-network": "workspace.error.googleOauthNetwork",
  "google-oauth-failed": "workspace.error.googleOauthFailed",
  "sheets-reader-unavailable": "workspace.error.sheetsReaderUnavailable",
  "office-download-required": "workspace.error.officeDownloadRequired",
  "google-permission-denied": "workspace.error.googlePermissionDenied",
  "source-tab-changed": "workspace.error.sourceTabChanged",
  "response-too-large": "workspace.error.responseTooLarge",
  "content-too-large": "workspace.error.contentTooLarge",
  "rate-limited": "workspace.error.rateLimited",
  "temporarily-unavailable": "workspace.error.temporarilyUnavailable",
  "reader-channel-unavailable": "workspace.error.readerChannelUnavailable",
  "invalid-request": "workspace.error.invalidRequest",
  "auth-required": "workspace.error.authRequired",
  "auth-unavailable": "workspace.error.authUnavailable",
};

/** The message key of a background error code, translated at render. */
function errorMessage(code: WorkspaceReaderErrorCode): ReaderMessage {
  return errorMessages[code];
}

function needsLocalReader(code: WorkspaceReaderErrorCode) {
  return isLocalReaderGuidanceError(code);
}

/**
 * `identity` and the Google API host are optional permissions (ADR 0015).
 * Chrome grants them only from a user gesture, so this must be called
 * synchronously inside the Connect click, before any `await`.
 */
function requestWorkspacePermissions(): Promise<boolean> {
  const permissions = (
    browser as unknown as {
      permissions?: {
        request?(request: {
          permissions: string[];
          origins: string[];
        }): Promise<boolean>;
      };
    }
  ).permissions;
  if (!permissions?.request) return Promise.resolve(false);
  try {
    return Promise.resolve(
      permissions.request({
        permissions: [...GOOGLE_WORKSPACE_OPTIONAL_PERMISSIONS],
        origins: [...GOOGLE_WORKSPACE_OPTIONAL_HOST_PERMISSIONS],
      }),
    ).then(
      (granted) => granted === true,
      () => false,
    );
  } catch {
    return Promise.resolve(false);
  }
}

function connectionAfterError(
  current: ReaderState["connection"],
  error: WorkspaceReaderErrorCode,
): ReaderState["connection"] {
  if (
    error === "google-auth-required" ||
    error === "google-oauth-expired" ||
    error === "google-access-denied" ||
    error === "google-permission-denied"
  )
    return "disconnected";
  // The Sheets API answered: Google access works, the file needs download.
  if (error === "office-download-required") return "connected";
  if (
    error === "sheets-reader-unavailable" ||
    error === "unsupported-browser" ||
    error === "google-oauth-configuration" ||
    error === "google-oauth-response" ||
    error === "google-oauth-network" ||
    error === "google-oauth-failed"
  )
    return "unavailable";
  return current;
}

function querySourceTabId() {
  const value = new URLSearchParams(window.location.search).get("sourceTabId");
  if (value && /^(0|[1-9]\d*)$/.test(value)) {
    const id = Number(value);
    if (Number.isSafeInteger(id)) return id;
  }
  return undefined;
}

function translationSource(record: WorkspaceRecord) {
  return record.kind === "formula" ? record.display : record.source;
}

function translationBatches(records: ReaderRecord[]) {
  const batches: ReaderRecord[][] = [];
  let batch: ReaderRecord[] = [];
  let characters = 0;
  for (const record of records) {
    const length = translationSource(record).length;
    if (length > MAX_TRANSLATION_RECORD_CHARACTERS) continue;
    if (
      batch.length === MAX_TRANSLATION_MESSAGE_RECORDS ||
      characters + length > MAX_TRANSLATION_MESSAGE_CHARACTERS
    ) {
      batches.push(batch);
      batch = [];
      characters = 0;
    }
    batch.push(record);
    characters += length;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

function mergeLoadedRecords(
  current: ReaderRecord[],
  incoming: WorkspaceRecord[],
  translations: ReadonlyMap<string, AcceptedTranslation>,
) {
  const merged = new Map(current.map((record) => [record.id, record]));
  for (const record of incoming) {
    const previous = merged.get(record.id);
    const accepted = translations.get(record.id);
    merged.set(
      record.id,
      previous?.sourceHash === record.sourceHash
        ? {
            ...record,
            translation: previous.translation,
            translationError: previous.translationError,
          }
        : accepted?.sourceHash === record.sourceHash
          ? { ...record, translation: accepted.text }
          : record,
    );
  }
  return [...merged.values()];
}

export function displayedSheetTranslations(
  records: readonly (WorkspaceRecord & { translation?: string })[],
  acceptedTranslations: ReadonlyMap<string, AcceptedTranslation>,
) {
  const translations = new Map<string, string>();
  for (const record of records) {
    const accepted = acceptedTranslations.get(record.id);
    if (accepted?.sourceHash === record.sourceHash)
      translations.set(record.id, accepted.text);
    else if (record.translation !== undefined)
      translations.set(record.id, record.translation);
  }
  return translations;
}

function pageRecords(page: WorkspaceSheetPage) {
  return page.rows.flatMap((row) => row.cells);
}

function residentPages(
  current: ReadonlyMap<number, WorkspaceSheetPage>,
  incoming: WorkspaceSheetPage,
) {
  const pages = new Map(current);
  pages.set(incoming.startRow, incoming);
  const totals = () => {
    let records = 0;
    let characters = 0;
    for (const page of pages.values()) {
      for (const record of pageRecords(page)) {
        records += 1;
        characters += translationSource(record).length;
      }
    }
    return { records, characters };
  };
  let total = totals();
  while (
    total.records > MAX_LOADED_RECORDS ||
    total.characters > MAX_LOADED_SOURCE_CHARACTERS
  ) {
    const evict = [...pages.keys()]
      .filter((startRow) => startRow !== incoming.startRow)
      .sort(
        (left, right) =>
          Math.abs(right - incoming.startRow) -
          Math.abs(left - incoming.startRow),
      )[0];
    if (evict === undefined) return null;
    pages.delete(evict);
    total = totals();
  }
  return pages;
}

async function send(
  request: WorkspaceReaderRequest,
): Promise<WorkspaceReaderResponse> {
  try {
    const response = (await browser.runtime.sendMessage(request)) as unknown;
    if (
      response &&
      typeof response === "object" &&
      "type" in response &&
      response.type === request.type &&
      "readerInstanceId" in response &&
      response.readerInstanceId === request.readerInstanceId &&
      "requestId" in response &&
      response.requestId === request.requestId &&
      "ok" in response &&
      typeof response.ok === "boolean"
    ) {
      return response as WorkspaceReaderResponse;
    }
    return {
      type: request.type,
      readerInstanceId: request.readerInstanceId,
      requestId: request.requestId,
      ok: false,
      error: "invalid-request",
      ...("version" in request ? { version: request.version } : {}),
    } as WorkspaceReaderResponse;
  } catch {
    return {
      type: request.type,
      readerInstanceId: request.readerInstanceId,
      requestId: request.requestId,
      ok: false,
      error: "reader-channel-unavailable",
      ...("version" in request ? { version: request.version } : {}),
    } as WorkspaceReaderResponse;
  }
}

function responseMatches(
  response: WorkspaceReaderResponse,
  request: WorkspaceReaderRequest,
) {
  return (
    response.type === request.type &&
    response.readerInstanceId === request.readerInstanceId &&
    response.requestId === request.requestId &&
    (!("version" in request) ||
      (!response.ok &&
        (response.error === "auth-required" ||
          response.error === "auth-unavailable" ||
          !("version" in response) ||
          !response.version)) ||
      ("version" in response &&
        response.version?.backgroundEpoch === request.version.backgroundEpoch &&
        response.version?.sourceRevision === request.version.sourceRevision))
  );
}

function openDriveOfficeSpreadsheet(source: DriveOfficeReaderSource) {
  window.location.replace(
    browser.runtime.getURL(driveOfficeReaderPath(source.sourceTabId) as never),
  );
}

export async function openReaderTabFallback(
  sourceTabId: number,
  awaitingStart = false,
  expectedFileId?: string,
  isCurrent?: () => boolean,
  desiredSheetId?: string,
  beforeOpen?: () => Promise<void>,
) {
  const tab = await browser.tabs.get(sourceTabId);
  const source = parseWorkspaceEditorUrl(tab.url ?? "");
  if (
    tab.id !== sourceTabId ||
    !Number.isSafeInteger(tab.windowId) ||
    tab.windowId! < 0 ||
    !source ||
    (expectedFileId !== undefined && source.fileId !== expectedFileId) ||
    isCurrent?.() === false
  )
    throw new Error("Reader source is unavailable");
  await beforeOpen?.();
  if (isCurrent?.() === false) throw new Error("Reader source is unavailable");
  return browser.tabs.create({
    windowId: tab.windowId,
    active: true,
    url: browser.runtime.getURL(
      `/reader.html?sourceTabId=${sourceTabId}${awaitingStart ? "&awaitStart=1" : ""}${desiredSheetId ? `&readerSheetId=${desiredSheetId}` : ""}` as never,
    ),
  });
}

export default function App({
  sheetMock,
  sourceTabId: boundSourceTabId,
  managedSourceLifecycle = false,
  awaitingStart = false,
  desiredSheetId,
  sourceTitle = "",
  onSourceIdentified,
  onOpenDriveOfficeSpreadsheet = openDriveOfficeSpreadsheet,
}: AppProps = {}) {
  // Parent tab switches replace callbacks; they must not restart this source session.
  const sourceCallbacks = useRef({
    onSourceIdentified,
    onOpenDriveOfficeSpreadsheet,
  });
  useLayoutEffect(() => {
    sourceCallbacks.current = {
      onSourceIdentified,
      onOpenDriveOfficeSpreadsheet,
    };
  }, [onSourceIdentified, onOpenDriveOfficeSpreadsheet]);
  const t = useMessages(readerMessages);
  const targetOptions = useMemo<readonly SelectOption[]>(
    () =>
      TARGET_LANGUAGES.map(({ code }) => ({
        value: code,
        label: t.t(languageKey(code)),
      })),
    [t],
  );
  const [state, setState] = useState(initialState);
  const [awaitingSourceStart, setAwaitingSourceStart] = useState(awaitingStart);
  const preferencesDirty = useRef(new Set<"targetLanguage">());
  useEffect(() => {
    let cancelled = false;
    void readReaderPreferences()
      .then((preferences) => {
        if (!cancelled)
          setState((current) => ({
            ...current,
            targetLanguage: preferencesDirty.current.has("targetLanguage")
              ? current.targetLanguage
              : preferences.targetLanguage,
          }));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  const [sheetPresentation, setSheetPresentation] = useState<
    "original" | "translation"
  >("translation");
  const [visibleSheetRecordIds, setVisibleSheetRecordIds] = useState<
    readonly string[]
  >([]);
  const requestId = useRef(0);
  const [readerInstanceId] = useState(() => globalThis.crypto.randomUUID());
  const session = useRef(0);
  const stateRef = useRef(state);
  useLayoutEffect(() => {
    stateRef.current = state;
  }, [state]);
  const pendingPages = useRef(new Set<number>());
  const pageLoadQueue = useRef<SheetPageLoad[]>([]);
  const pageLoadActive = useRef(false);
  const viewportRecordIds = useRef<string[]>([]);
  const translationRun = useRef<SheetTranslationRun | undefined>(undefined);
  const workerRecovery = useRef<SheetWorkerRecovery | undefined>(undefined);
  const gridViewGeneration = useRef<number | undefined>(undefined);
  const translationRunId = useRef(0);
  const translationRequestPending = useRef(false);
  const popupIntent = useRef<WorkspaceReaderIntent | undefined>(undefined);
  const desiredReaderSheet = useRef(desiredSheetId);
  const intentClaim = useRef<Promise<void> | undefined>(undefined);
  const fallbackIntent = useRef<WorkspaceReaderIntent | undefined>(undefined);
  const fallbackHandoff = useRef(false);
  const [fallbackOpening, setFallbackOpening] = useState(false);
  const popupIntentEpoch = useRef(0);
  const continuation = useRef<
    | {
        fileId: string;
        targetLanguage: TargetLanguage;
      }
    | undefined
  >(undefined);
  const retireTranslationIntent = useCallback(() => {
    popupIntentEpoch.current += 1;
    popupIntent.current = undefined;
    continuation.current = undefined;
    translationRun.current = undefined;
    workerRecovery.current = undefined;
  }, []);
  const sourceVersion = useRef<WorkspaceSourceVersion | undefined>(undefined);
  const contextLoadActive = useRef(false);
  const contextReloadQueued = useRef<
    | {
        sourceTabId: number;
        expectedSession: number;
        identify: boolean;
        awaitStart: boolean;
      }
    | undefined
  >(undefined);
  const disposed = useRef(false);
  const recoveredWorkerEpoch = useRef<string | undefined>(undefined);
  const recoverWorker = useRef<
    (response: WorkspaceReaderResponse, request: WorkspaceReaderRequest) => void
  >(() => undefined);
  const responseMatchesCurrent = useCallback(
    (response: WorkspaceReaderResponse, request: WorkspaceReaderRequest) => {
      const matches = responseMatches(response, request);
      if (!matches) recoverWorker.current(response, request);
      return matches;
    },
    [],
  );

  useEffect(() => {
    const sourceTabId = state.sourceTabId;
    if (sourceTabId === undefined || !browser.storage?.session) return;
    let cancelled = false;
    const acceptIntent = async () => {
      if (fallbackHandoff.current) return;
      const expectedRevision = popupIntentEpoch.current;
      const intent = await takeReaderIntent(sourceTabId).catch(() => undefined);
      if (cancelled || popupIntentEpoch.current !== expectedRevision || !intent)
        return;
      popupIntentEpoch.current += 1;
      if (stateRef.current.channelUnavailable) fallbackIntent.current = intent;
      else popupIntent.current = intent;
      preferencesDirty.current.add("targetLanguage");
      void saveReaderPreferences({
        targetLanguage: intent.targetLanguage,
      }).catch(() => undefined);
      translationRun.current = undefined;
      setSheetPresentation("translation");
      setState((value) => ({
        ...value,
        targetLanguage: intent.targetLanguage,
        translations:
          value.targetLanguage === intent.targetLanguage
            ? value.translations
            : new Map(),
        records:
          value.targetLanguage === intent.targetLanguage
            ? value.records
            : value.records.map((record) => ({
                ...record,
                translation: undefined,
                translationError: undefined,
              })),
        spreadsheetTranslation: transitionSpreadsheetTranslation(
          value.spreadsheetTranslation,
          { type: "source-change" },
        ),
        completionAnnouncement: "",
        pending: value.pending === "translate" ? undefined : value.pending,
      }));
    };
    const claimIntent = () => {
      intentClaim.current = acceptIntent();
    };
    const onStorage = (changes: Record<string, unknown>, area: string) => {
      if (area === "session" && readerIntentKey(sourceTabId) in changes)
        claimIntent();
    };
    const onAuth = (message: unknown) => {
      if ((message as { type?: string })?.type !== "AUTH_STATE_CHANGED") return;
      workerRecovery.current = undefined;
      session.current += 1;
      pendingPages.current.clear();
      pageLoadQueue.current = [];
      viewportRecordIds.current = [];
      setVisibleSheetRecordIds([]);
      popupIntentEpoch.current += 1;
      popupIntent.current = undefined;
      fallbackIntent.current = undefined;
      translationRun.current = undefined;
      continuation.current = undefined;
      setState((value) => ({
        ...value,
        grid: undefined,
        pages: new Map(),
        records: [],
        translations: new Map(),
        pending: undefined,
        error: errorMessage("auth-required"),
        spreadsheetTranslation: transitionSpreadsheetTranslation(
          value.spreadsheetTranslation,
          { type: "source-change" },
        ),
        completionAnnouncement: "",
      }));
      void browser.storage.session.remove(readerIntentKey(sourceTabId));
    };
    browser.storage.onChanged.addListener(onStorage);
    browser.runtime.onMessage.addListener(onAuth);
    claimIntent();
    return () => {
      cancelled = true;
      popupIntentEpoch.current += 1;
      browser.storage.onChanged.removeListener(onStorage);
      browser.runtime.onMessage.removeListener(onAuth);
    };
  }, [state.sourceTabId]);

  const loadSheetPage = useCallback(
    (
      sourceTabId: number,
      cursor: WorkspaceLoadCursor,
      grid: WorkspaceSheetGrid,
      version: WorkspaceSourceVersion,
      expectedSession: number,
    ) => {
      const startRow = cursor?.kind === "sheets" ? cursor.nextRow : 0;
      if (
        expectedSession !== session.current ||
        pendingPages.current.has(startRow) ||
        (stateRef.current.grid?.sheetId === grid.sheetId &&
          stateRef.current.grid.generation === grid.generation &&
          stateRef.current.pages.get(startRow)?.generation ===
            grid.generation &&
          !(
            workerRecovery.current?.session === expectedSession &&
            workerRecovery.current.pages.has(startRow)
          ))
      )
        return;
      pendingPages.current.add(startRow);
      pageLoadQueue.current.push({
        sourceTabId,
        cursor,
        grid,
        version,
        session: expectedSession,
        startRow,
      });

      async function drainPageLoads() {
        if (pageLoadActive.current) return;
        pageLoadActive.current = true;
        try {
          while (pageLoadQueue.current.length) {
            const task = pageLoadQueue.current.shift()!;
            if (task.session !== session.current) {
              pendingPages.current.delete(task.startRow);
              continue;
            }
            const request = {
              type: "WORKSPACE_READER_LOAD",
              readerInstanceId: readerInstanceId,
              requestId: ++requestId.current,
              sourceTabId: task.sourceTabId,
              version: task.version,
              cursor: task.cursor,
            } satisfies WorkspaceReaderRequest;
            setState((current) => ({
              ...current,
              pending:
                current.pending === "translate" ? current.pending : "load",
              error: undefined,
              status: task.startRow
                ? "workspace.status.loadingNextRows"
                : "workspace.status.loadingSource",
            }));
            const response = await send(request);
            pendingPages.current.delete(task.startRow);
            if (
              task.session !== session.current ||
              !responseMatchesCurrent(response, request)
            )
              continue;
            if (!response.ok) {
              retireTranslationIntent();
              setState((current) => ({
                ...current,
                pending: undefined,
                spreadsheetTranslation: transitionSpreadsheetTranslation(
                  current.spreadsheetTranslation,
                  { type: "error" },
                ),
                connection: connectionAfterError(
                  current.connection,
                  response.error,
                ),
                error: errorMessage(response.error),
                status: "",
              }));
              continue;
            }
            if (
              response.type !== "WORKSPACE_READER_LOAD" ||
              response.context.sourceTabId !== task.sourceTabId ||
              response.context.kind !== "sheets" ||
              response.context.activeId !== task.grid.sheetId ||
              response.generation !== task.grid.generation ||
              !response.page ||
              response.page.generation !== task.grid.generation ||
              response.page.sheetId !== task.grid.sheetId ||
              response.page.startRow !== task.startRow
            ) {
              retireTranslationIntent();
              setState((current) => ({
                ...current,
                pending: undefined,
                spreadsheetTranslation: transitionSpreadsheetTranslation(
                  current.spreadsheetTranslation,
                  { type: "error" },
                ),
                error: errorMessage("source-tab-changed"),
                status: "",
              }));
              continue;
            }
            const recovery = workerRecovery.current;
            const invalidated = new Set<string>();
            if (recovery?.session === task.session) {
              recovery.pages.delete(task.startRow);
              const incoming = new Map(
                pageRecords(response.page).map((record) => [
                  record.id,
                  record.sourceHash,
                ]),
              );
              for (const record of stateRef.current.pages
                .get(task.startRow)
                ?.rows.flatMap((row) => row.cells) ?? []) {
                if (incoming.get(record.id) !== record.sourceHash) {
                  invalidated.add(record.id);
                  recovery.run?.settled.delete(record.id);
                  recovery.run?.resolvedIds.delete(record.id);
                  recovery.run?.unresolvedIds.delete(record.id);
                }
              }
              if (recovery.run)
                recovery.run.translated = recovery.run.resolvedIds.size;
              if (!recovery.pages.size) {
                translationRun.current = recovery.run
                  ? {
                      ...recovery.run,
                      id: ++translationRunId.current,
                      session: task.session,
                      generation: task.grid.generation,
                      pending: false,
                    }
                  : undefined;
                workerRecovery.current = undefined;
              }
            }
            setState((current) => {
              if (
                current.pages.get(task.startRow)?.generation ===
                  task.grid.generation &&
                recovery?.session !== task.session
              )
                return current;
              const pages = residentPages(current.pages, response.page!);
              if (!pages) {
                return {
                  ...current,
                  pending: undefined,
                  spreadsheetTranslation: transitionSpreadsheetTranslation(
                    current.spreadsheetTranslation,
                    { type: "error" },
                  ),
                  error: errorMessage("content-too-large"),
                  status: "",
                };
              }
              const resident = [...pages.values()].flatMap(pageRecords);
              const residentIds = new Set(resident.map(({ id }) => id));
              const translations = new Map(current.translations);
              const unresolved = new Set(current.unresolved);
              const oversized = new Set(current.oversized);
              for (const id of invalidated) {
                translations.delete(id);
                unresolved.delete(id);
                oversized.delete(id);
              }
              const records = mergeLoadedRecords(
                current.records,
                resident,
                translations,
              ).filter((record) => residentIds.has(record.id));
              const latestStart = Math.max(-1, ...current.pages.keys());
              const recordIds = new Set(records.map(({ id }) => id));
              return {
                ...current,
                pending:
                  workerRecovery.current?.session === task.session
                    ? "load"
                    : current.pending === "load"
                      ? undefined
                      : current.pending,
                context: response.context,
                records,
                translations,
                unresolved,
                oversized,
                grid: task.grid,
                title: task.grid.title,
                pages,
                cursor:
                  task.startRow >= latestStart
                    ? response.page!.cursor
                    : current.cursor,
                tabs: [],
                generation: response.generation,
                selected: new Set(
                  [...current.selected].filter((id) => recordIds.has(id)),
                ),
                error: undefined,
                status: recordsLoaded(records.length),
              };
            });
          }
        } finally {
          pageLoadActive.current = false;
        }
      }

      void drainPageLoads();
    },
    [readerInstanceId, responseMatchesCurrent, retireTranslationIntent],
  );

  const discoverSheet = useCallback(
    async (
      sourceTabId: number,
      expectedContext: WorkspaceEditorContext,
      version: WorkspaceSourceVersion,
      expectedSession: number,
      initialCursor: WorkspaceSheetDiscoveryCursor | null = null,
    ) => {
      let cursor = initialCursor;
      setState((current) => {
        const discovery =
          current.discovery.status === "paused" && cursor
            ? ({ ...current.discovery, status: "scanning" } as const)
            : ({
                status: "scanning",
                axis: "columns",
                scanned: 0,
                total: 0,
                cursor,
              } as const);
        return {
          ...current,
          pending: "discover",
          error: undefined,
          discovery,
          status: discoveryStatus(
            discovery.axis,
            discovery.scanned,
            discovery.total,
          ),
        };
      });
      while (expectedSession === session.current) {
        const request = {
          type: "WORKSPACE_READER_DISCOVER",
          readerInstanceId: readerInstanceId,
          requestId: ++requestId.current,
          sourceTabId,
          version,
          cursor,
        } satisfies WorkspaceReaderRequest;
        const response = await send(request);
        if (
          expectedSession !== session.current ||
          !responseMatchesCurrent(response, request)
        )
          return;
        if (!response.ok) {
          if (response.error === "unsupported-file-type") {
            sourceCallbacks.current.onOpenDriveOfficeSpreadsheet(
              { sourceTabId, version, fileId: expectedContext.fileId },
              popupIntent.current,
            );
            return;
          }
          const resumeCursor =
            "discoveryCursor" in response
              ? response.discoveryCursor
              : undefined;
          if (!resumeCursor) retireTranslationIntent();
          setState((current) => ({
            ...current,
            pending: undefined,
            spreadsheetTranslation: resumeCursor
              ? current.spreadsheetTranslation
              : transitionSpreadsheetTranslation(
                  current.spreadsheetTranslation,
                  { type: "error" },
                ),
            discovery: resumeCursor
              ? {
                  status: "paused",
                  axis:
                    current.discovery.status === "idle" ||
                    current.discovery.status === "complete"
                      ? "columns"
                      : current.discovery.axis,
                  scanned:
                    current.discovery.status === "idle" ||
                    current.discovery.status === "complete"
                      ? 0
                      : current.discovery.scanned,
                  total:
                    current.discovery.status === "idle" ||
                    current.discovery.status === "complete"
                      ? 0
                      : current.discovery.total,
                  cursor: resumeCursor,
                }
              : { status: "idle" },
            connection: connectionAfterError(
              current.connection,
              response.error,
            ),
            error: errorMessage(response.error),
            status: resumeCursor
              ? "workspace.status.discoveryPaused"
              : "workspace.status.discoveryStopped",
          }));
          return;
        }
        if (response.type !== "WORKSPACE_READER_DISCOVER") return;
        const progress = response.progress;
        if (progress.status === "scanning") {
          const { axis, scanned, total, cursor: nextCursor } = progress;
          cursor = nextCursor;
          setState((current) => ({
            ...current,
            sheets: response.sheets,
            discovery: {
              status: "scanning",
              axis,
              scanned,
              total,
              cursor: nextCursor,
            },
            status: discoveryStatus(axis, scanned, total),
          }));
          continue;
        }
        const grid = progress.grid;
        if (
          expectedContext.kind !== "sheets" ||
          (expectedContext.activeId !== null &&
            grid.sheetId !== expectedContext.activeId)
        ) {
          retireTranslationIntent();
          setState((current) => ({
            ...current,
            context: { ...expectedContext, activeId: grid.sheetId },
            pending: undefined,
            spreadsheetTranslation: transitionSpreadsheetTranslation(
              current.spreadsheetTranslation,
              { type: "error" },
            ),
            error: errorMessage("source-tab-changed"),
            status: "",
          }));
          return;
        }
        if (grid.lastUsedColumn < 0) {
          popupIntentEpoch.current += 1;
          popupIntent.current = undefined;
          translationRun.current = undefined;
        }
        const recovery =
          workerRecovery.current?.session === expectedSession
            ? workerRecovery.current
            : undefined;
        if (recovery && grid.lastUsedColumn >= 0) {
          recovery.pages = new Set(
            [...recovery.pages].filter((start) => start < grid.rowCount),
          );
          if (!recovery.pages.size) recovery.pages.add(0);
        } else {
          workerRecovery.current = undefined;
          gridViewGeneration.current = grid.generation;
        }
        setState((current) => ({
          ...current,
          spreadsheetTranslation:
            grid.lastUsedColumn < 0
              ? transitionSpreadsheetTranslation(
                  current.spreadsheetTranslation,
                  { type: "empty-visible" },
                )
              : current.spreadsheetTranslation,
          context: current.context
            ? { ...current.context, activeId: grid.sheetId }
            : current.context,
          pending: recovery && grid.lastUsedColumn >= 0 ? "load" : undefined,
          grid,
          title: grid.title,
          pages:
            recovery && grid.lastUsedColumn >= 0 ? current.pages : new Map(),
          records: recovery && grid.lastUsedColumn >= 0 ? current.records : [],
          translations:
            recovery && grid.lastUsedColumn >= 0
              ? current.translations
              : new Map(),
          unresolved:
            recovery && grid.lastUsedColumn >= 0
              ? current.unresolved
              : new Set(),
          oversized:
            recovery && grid.lastUsedColumn >= 0
              ? current.oversized
              : new Set(),
          sheets: response.sheets,
          generation: grid.generation,
          discovery: { status: "complete" },
          status:
            grid.lastUsedColumn < 0
              ? recordsLoaded(0)
              : "workspace.status.discoveryComplete",
        }));
        if (grid.lastUsedColumn < 0) return;
        if (recovery) {
          for (const start of recovery.pages)
            loadSheetPage(
              sourceTabId,
              start === 0 ? null : { kind: "sheets", nextRow: start },
              grid,
              version,
              expectedSession,
            );
          return;
        }
        await loadSheetPage(sourceTabId, null, grid, version, expectedSession);
        return;
      }
    },
    [
      loadSheetPage,
      readerInstanceId,
      responseMatchesCurrent,
      retireTranslationIntent,
    ],
  );

  const loadDocs = useCallback(
    async (
      sourceTabId: number,
      cursor: WorkspaceLoadCursor,
      expectedContext: WorkspaceEditorContext,
      version: WorkspaceSourceVersion,
      expectedSession: number,
    ) => {
      const request = {
        type: "WORKSPACE_READER_LOAD",
        readerInstanceId: readerInstanceId,
        requestId: ++requestId.current,
        sourceTabId,
        version,
        cursor,
      } satisfies WorkspaceReaderRequest;
      setState((current) => ({
        ...current,
        pending: "load",
        error: undefined,
        status: "workspace.status.loadingSource",
      }));
      const response = await send(request);
      if (
        expectedSession !== session.current ||
        !responseMatchesCurrent(response, request)
      )
        return;
      if (!response.ok) {
        setState((current) => ({
          ...current,
          connection: connectionAfterError(current.connection, response.error),
          pending: undefined,
          error: errorMessage(response.error),
          status: "",
        }));
        return;
      }
      if (
        response.type !== "WORKSPACE_READER_LOAD" ||
        response.context.kind !== "docs" ||
        response.context.fileId !== expectedContext.fileId ||
        (cursor?.kind === "docs" && response.context.activeId !== cursor.tabId)
      )
        return;
      setState((current) => ({
        ...current,
        pending: undefined,
        context: response.context,
        title: response.title,
        records: response.records,
        grid: undefined,
        pages: new Map(),
        cursor: response.cursor,
        tabs: response.tabs ?? [],
        generation: response.generation,
        selected: new Set(),
        error: undefined,
        status: recordsLoaded(response.records.length),
      }));
    },
    [readerInstanceId, responseMatchesCurrent],
  );

  const startSource = useCallback(
    async (
      sourceTabId: number,
      context: WorkspaceEditorContext,
      version: WorkspaceSourceVersion,
      expectedSession: number,
    ) => {
      if (workerRecovery.current?.session === expectedSession) {
        await discoverSheet(sourceTabId, context, version, expectedSession);
        return;
      }
      pendingPages.current.clear();
      pageLoadQueue.current = [];
      viewportRecordIds.current = [];
      setVisibleSheetRecordIds([]);
      translationRun.current = undefined;
      if (context.kind === "sheets") {
        if (sheetMock) {
          gridViewGeneration.current = sheetMock.grid.generation;
          const records = sheetMock.pages.flatMap(pageRecords);
          const translations = new Map<string, AcceptedTranslation>();
          for (const record of records) {
            const text = sheetMock.translations?.get(record.id);
            if (text !== undefined)
              translations.set(record.id, {
                sourceHash: record.sourceHash,
                text,
              });
          }
          setState((current) => ({
            ...current,
            pending: undefined,
            title: sheetMock.grid.title,
            grid: sheetMock.grid,
            pages: new Map(
              sheetMock.pages.map((page) => [page.startRow, page]),
            ),
            records,
            translations,
            sheets: [
              {
                sheetId: sheetMock.grid.sheetId,
                title: sheetMock.grid.title,
                index: 0,
              },
            ],
            generation: sheetMock.grid.generation,
            cursor: sheetMock.pages.at(-1)?.cursor ?? null,
            discovery: { status: "complete" },
            status: recordsLoaded(records.length),
          }));
          return;
        }
        await discoverSheet(sourceTabId, context, version, expectedSession);
        return;
      }
      await loadDocs(sourceTabId, null, context, version, expectedSession);
    },
    [discoverSheet, loadDocs, sheetMock],
  );

  const loadFreshContext = useCallback(
    async (
      sourceTabId: number,
      expectedSession: number,
      identify: boolean,
      awaitStart: boolean,
    ) => {
      const request = {
        type: "WORKSPACE_READER_CONTEXT",
        readerInstanceId: readerInstanceId,
        requestId: ++requestId.current,
        sourceTabId,
        ...(identify || awaitStart ? { identifySource: true as const } : {}),
      } satisfies WorkspaceReaderRequest;
      let response = await send(request);
      if (
        expectedSession !== session.current ||
        !responseMatchesCurrent(response, request)
      )
        return;
      if (!response.ok) {
        const error = response.error;
        const intent = popupIntent.current ?? fallbackIntent.current;
        if (error === "reader-channel-unavailable") {
          workerRecovery.current = undefined;
          fallbackIntent.current = intent;
          popupIntent.current = undefined;
          continuation.current = undefined;
          translationRun.current = undefined;
        } else retireTranslationIntent();
        setState((current) => ({
          ...current,
          sourceTabId,
          channelUnavailable: error === "reader-channel-unavailable",
          connection:
            error === "reader-channel-unavailable"
              ? "unavailable"
              : connectionAfterError(current.connection, error),
          pending: undefined,
          spreadsheetTranslation: transitionSpreadsheetTranslation(
            current.spreadsheetTranslation,
            { type: "error" },
          ),
          error: errorMessage(error),
          localReaderGuidance: needsLocalReader(error),
          // The native Reader cannot load this source; show the notice.
          ...(needsLocalReader(error) ? { configured: false } : {}),
          status: "",
        }));
        return;
      }
      if (
        response.type !== "WORKSPACE_READER_CONTEXT" ||
        response.context.sourceTabId !== sourceTabId
      )
        return;

      const retained = stateRef.current.context;
      const recovery =
        workerRecovery.current?.session === expectedSession
          ? workerRecovery.current
          : undefined;
      if (
        recovery &&
        (response.context.kind !== "sheets" ||
          response.sourceKind === "office" ||
          response.context.fileId !== recovery.context.fileId ||
          (response.sheets &&
            recovery.context.activeId !== null &&
            !response.sheets.some(
              (sheet) => sheet.sheetId === recovery.context.activeId,
            )))
      ) {
        retireTranslationIntent();
        awaitStart = true;
        gridViewGeneration.current = undefined;
        setState((current) => ({
          ...current,
          grid: undefined,
          pages: new Map(),
          records: [],
          translations: new Map(),
          unresolved: new Set(),
          oversized: new Set(),
          spreadsheetTranslation: transitionSpreadsheetTranslation(
            current.spreadsheetTranslation,
            { type: "source-change" },
          ),
        }));
      }
      const hintedSheet = desiredReaderSheet.current;
      desiredReaderSheet.current = undefined;
      const selectedSheetId =
        retained?.kind === "sheets" &&
        retained.fileId === response.context.fileId &&
        (!response.sheets ||
          response.sheets.some((sheet) => sheet.sheetId === retained.activeId))
          ? retained.activeId
          : response.sheets?.some((sheet) => sheet.sheetId === hintedSheet)
            ? hintedSheet
            : undefined;
      if (
        response.sourceKind !== "office" &&
        response.context.kind === "sheets" &&
        selectedSheetId != null &&
        selectedSheetId !== response.context.activeId
      ) {
        const select = {
          type: "WORKSPACE_READER_SELECT_SHEET",
          readerInstanceId: readerInstanceId,
          requestId: ++requestId.current,
          sourceTabId,
          version: response.version,
          sheetId: selectedSheetId,
        } satisfies WorkspaceReaderRequest;
        const selected = await send(select);
        if (
          expectedSession !== session.current ||
          !responseMatchesCurrent(selected, select)
        )
          return;
        if (!selected.ok) {
          setState((current) => ({
            ...current,
            pending: undefined,
            error: errorMessage(selected.error),
          }));
          return;
        }
        if (selected.type !== "WORKSPACE_READER_SELECT_SHEET") return;
        response = {
          ...response,
          context: selected.context,
          version: selected.version,
          sheets: selected.sheets,
        };
      }
      sourceCallbacks.current.onSourceIdentified?.(
        response.context,
        response.version,
      );
      if (response.sourceKind === "office") {
        sourceCallbacks.current.onOpenDriveOfficeSpreadsheet(
          {
            sourceTabId,
            version: response.version,
            sourceTitle: response.sourceTitle,
            fileId: response.context.fileId,
            ...(awaitStart ? { awaitingStart: true } : {}),
          },
          popupIntent.current,
        );
        return;
      }
      setAwaitingSourceStart(awaitStart);
      const enabled = continuation.current;
      const continueTranslation =
        response.configured &&
        response.connected &&
        response.context.kind === "sheets" &&
        enabled?.fileId === response.context.fileId;
      if (!continueTranslation) continuation.current = undefined;
      if (
        !response.configured ||
        (workerRecovery.current && !response.connected)
      )
        retireTranslationIntent();
      recoveredWorkerEpoch.current = response.version.backgroundEpoch;
      sourceVersion.current = response.version;
      setState((current) => ({
        ...current,
        sourceTabId,
        configured: response.configured,
        channelUnavailable: false,
        connection: response.connected ? "connected" : "disconnected",
        context: response.context,
        title:
          response.sheets?.find(
            (sheet) => sheet.sheetId === response.context.activeId,
          )?.title ??
          response.sourceTitle ??
          (current.context?.fileId === response.context.fileId
            ? current.title
            : ""),
        sheets:
          response.sheets ??
          (current.context?.fileId === response.context.fileId
            ? current.sheets
            : []),
        version: response.version,
        spreadsheetTranslation:
          !response.configured || !response.connected
            ? transitionSpreadsheetTranslation(current.spreadsheetTranslation, {
                type: "stop",
              })
            : continueTranslation && !workerRecovery.current
              ? transitionSpreadsheetTranslation(
                  current.spreadsheetTranslation,
                  {
                    type: "start",
                  },
                )
              : current.spreadsheetTranslation,
        completionAnnouncement: "",
        pending: workerRecovery.current ? "context" : undefined,
        status: response.configured
          ? response.connected
            ? "workspace.status.connected"
            : "workspace.status.connectToLoad"
          : "",
        error: response.configured ? undefined : errorMessage("not-configured"),
        localReaderGuidance: false,
      }));
      if (response.configured && response.connected && !awaitStart)
        void startSource(
          sourceTabId,
          response.context,
          response.version,
          expectedSession,
        );
    },
    [
      readerInstanceId,
      responseMatchesCurrent,
      startSource,
      retireTranslationIntent,
    ],
  );

  const beginFreshContext = useCallback(
    (
      sourceTabId: number,
      identify = false,
      awaitStart = false,
      preserveView = false,
    ) => {
      const expectedSession = ++session.current;
      setAwaitingSourceStart(awaitStart);
      if (!preserveView) {
        workerRecovery.current = undefined;
        gridViewGeneration.current = undefined;
        setVisibleSheetRecordIds([]);
        viewportRecordIds.current = [];
      }
      translationRun.current = undefined;
      pendingPages.current.clear();
      pageLoadQueue.current = [];
      setState((current) => {
        if (preserveView)
          return {
            ...current,
            pending: "context",
            error: undefined,
            status: "workspace.status.reconnecting",
          };
        const retainSheetConnection =
          current.sourceTabId === sourceTabId &&
          current.context?.kind === "sheets";
        return {
          ...current,
          sourceTabId,
          context: retainSheetConnection ? current.context : undefined,
          version: retainSheetConnection ? current.version : undefined,
          title: retainSheetConnection ? current.title : "",
          records: [],
          grid: undefined,
          pages: new Map(),
          translations: new Map(),
          unresolved: new Set(),
          oversized: new Set(),
          cursor: null,
          tabs: [],
          sheets: retainSheetConnection ? current.sheets : [],
          generation: undefined,
          discovery: { status: "idle" },
          selected: new Set(),
          // The cleared view cannot retain completion from the previous grid.
          // loadFreshContext restarts only a retained, authorized continuation.
          spreadsheetTranslation: transitionSpreadsheetTranslation(
            current.spreadsheetTranslation,
            { type: "source-change" },
          ),
          completionAnnouncement: "",
          pending: "context",
          error: undefined,
          status: "workspace.status.loadingActiveSource",
        };
      });
      contextReloadQueued.current = {
        sourceTabId,
        expectedSession,
        identify,
        awaitStart,
      };
      if (contextLoadActive.current) return;
      contextLoadActive.current = true;
      void (async () => {
        try {
          while (contextReloadQueued.current && !disposed.current) {
            const next = contextReloadQueued.current;
            contextReloadQueued.current = undefined;
            await loadFreshContext(
              next.sourceTabId,
              next.expectedSession,
              next.identify,
              next.awaitStart,
            );
          }
        } finally {
          contextLoadActive.current = false;
        }
      })();
    },
    [loadFreshContext],
  );

  useEffect(() => {
    recoverWorker.current = (response, request) => {
      if (
        !("version" in request) ||
        !("version" in response) ||
        !response.version ||
        response.type !== request.type ||
        response.readerInstanceId !== request.readerInstanceId ||
        response.requestId !== request.requestId ||
        response.version.backgroundEpoch === request.version.backgroundEpoch ||
        recoveredWorkerEpoch.current === response.version.backgroundEpoch
      )
        return;
      recoveredWorkerEpoch.current = response.version.backgroundEpoch;
      const current = stateRef.current;
      const preserveView =
        current.context?.kind === "sheets" &&
        Boolean(current.grid) &&
        !awaitingSourceStart;
      if (preserveView && current.context) {
        const previous = workerRecovery.current;
        const pages = new Set([
          ...current.pages.keys(),
          ...(previous?.pages ?? []),
        ]);
        if (request.type === "WORKSPACE_READER_LOAD")
          pages.add(
            request.cursor?.kind === "sheets" ? request.cursor.nextRow : 0,
          );
        workerRecovery.current = {
          session: session.current + 1,
          context: current.context,
          pages,
          run: translationRun.current ?? previous?.run,
        };
      }
      beginFreshContext(
        request.sourceTabId,
        preserveView || awaitingSourceStart,
        awaitingSourceStart,
        preserveView,
      );
    };
    return () => {
      recoverWorker.current = () => undefined;
    };
  }, [beginFreshContext, awaitingSourceStart]);

  useEffect(() => {
    disposed.current = false;
    let cancelled = false;
    let cleanupListener: () => void = () => undefined;
    void (async () => {
      const queryId = boundSourceTabId ?? querySourceTabId();
      const tabs = queryId
        ? []
        : await browser.tabs.query({ active: true, currentWindow: true });
      const sourceTabId = queryId ?? tabs[0]?.id;
      if (cancelled) return;
      if (sourceTabId === undefined) {
        setState((current) => ({
          ...current,
          connection: "unavailable",
          pending: undefined,
          error: errorMessage("unsupported-url"),
          status: "",
        }));
        return;
      }
      const onSourceChanged = (message: unknown) => {
        const change = parseWorkspaceReaderSourceChanged(message);
        if (!change || change.sourceTabId !== sourceTabId) return;
        const current = sourceVersion.current;
        if (
          current?.backgroundEpoch === change.version.backgroundEpoch &&
          change.version.sourceRevision <= current.sourceRevision
        )
          return;
        sourceVersion.current = change.version;
        continuation.current = undefined;
        translationRun.current = undefined;
        setState((value) => ({
          ...value,
          spreadsheetTranslation: transitionSpreadsheetTranslation(
            value.spreadsheetTranslation,
            { type: "browser-sheet-change" },
          ),
          completionAnnouncement: "",
        }));
        popupIntentEpoch.current += 1;
        popupIntent.current = undefined;
        beginFreshContext(sourceTabId, true, true);
      };
      if (!managedSourceLifecycle)
        browser.runtime.onMessage.addListener(onSourceChanged);
      if (cancelled) {
        browser.runtime.onMessage.removeListener(onSourceChanged);
        return;
      }
      beginFreshContext(sourceTabId, true, awaitingStart);
      cleanupListener = () =>
        browser.runtime.onMessage.removeListener(onSourceChanged);
    })();
    return () => {
      cancelled = true;
      disposed.current = true;
      contextReloadQueued.current = undefined;
      cleanupListener();
      continuation.current = undefined;
      session.current += 1;
      workerRecovery.current = undefined;
    };
  }, [
    beginFreshContext,
    awaitingStart,
    managedSourceLifecycle,
    boundSourceTabId,
  ]);

  async function connect() {
    if (state.sourceTabId === undefined || !state.version || state.pending)
      return;
    // Inside the click: Chrome rejects a permission request after an await.
    const granted = requestWorkspacePermissions();
    const currentSession = ++session.current;
    const request = {
      type: "WORKSPACE_READER_CONNECT",
      readerInstanceId: readerInstanceId,
      requestId: ++requestId.current,
      sourceTabId: state.sourceTabId,
      version: state.version,
    } satisfies WorkspaceReaderRequest;
    setState((current) => ({
      ...current,
      pending: "connect",
      error: undefined,
      status: "workspace.status.waitingAuthorization",
    }));
    if (!(await granted)) {
      if (currentSession !== session.current) return;
      setState((current) => ({
        ...current,
        connection: "disconnected",
        pending: undefined,
        error: errorMessage("google-permission-denied"),
        status: "",
      }));
      return;
    }
    if (currentSession !== session.current) return;
    const response = await send(request);
    if (
      currentSession !== session.current ||
      !responseMatchesCurrent(response, request)
    )
      return;
    if (!response.ok) {
      setState((current) => ({
        ...current,
        connection: connectionAfterError(current.connection, response.error),
        pending: undefined,
        error: errorMessage(response.error),
        status: "",
      }));
      return;
    }
    if (response.type !== "WORKSPACE_READER_CONNECT" || !response.connected)
      return;
    beginFreshContext(state.sourceTabId, true, awaitingSourceStart);
  }

  async function disconnect() {
    workerRecovery.current = undefined;
    popupIntentEpoch.current += 1;
    popupIntent.current = undefined;
    const version = sourceVersion.current ?? state.version;
    if (
      state.sourceTabId === undefined ||
      !version ||
      state.pending === "disconnect"
    )
      return;
    const currentSession = ++session.current;
    translationRun.current = undefined;
    continuation.current = undefined;
    pendingPages.current.clear();
    pageLoadQueue.current = [];
    const request = {
      type: "WORKSPACE_READER_DISCONNECT",
      readerInstanceId: readerInstanceId,
      requestId: ++requestId.current,
      sourceTabId: state.sourceTabId,
      version,
    } satisfies WorkspaceReaderRequest;
    setState((current) => ({
      ...current,
      pending: "disconnect",
      error: undefined,
      status: "workspace.status.disconnecting",
    }));
    const response = await send(request);
    if (
      currentSession !== session.current ||
      !responseMatchesCurrent(response, request)
    )
      return;
    if (!response.ok) {
      setState((current) => ({
        ...current,
        pending: undefined,
        error: errorMessage(response.error),
        status: "",
      }));
      return;
    }
    setState((current) => ({
      ...initialState,
      sourceTabId: current.sourceTabId,
      configured: current.configured,
      context: current.context,
      version: response.version,
      targetLanguage: current.targetLanguage,
      connection: "disconnected",
      pending: undefined,
      status: "workspace.status.disconnected",
    }));
  }

  const drainSheetTranslation = useCallback(
    async function drain(runId: number) {
      const run = translationRun.current;
      const current = stateRef.current;
      if (
        !run ||
        workerRecovery.current ||
        run.id !== runId ||
        run.pending ||
        translationRequestPending.current ||
        run.session !== session.current ||
        current.sourceTabId !== run.sourceTabId ||
        current.generation !== run.generation ||
        current.targetLanguage !== run.targetLanguage
      )
        return;

      const records = new Map(
        current.records.map((record) => [record.id, record]),
      );
      const candidates = viewportRecordIds.current
        .map((id) => records.get(id))
        .filter((record): record is ReaderRecord =>
          Boolean(
            record?.translatable &&
            !record.translation &&
            (!run.eligible || run.eligible.has(record.id)) &&
            !run.settled.has(record.id),
          ),
        );
      const oversized = candidates.filter(
        (record) =>
          translationSource(record).length > MAX_TRANSLATION_RECORD_CHARACTERS,
      );
      for (const record of oversized) {
        run.settled.add(record.id);
        run.unresolvedIds.add(record.id);
      }
      const batch = translationBatches(candidates)[0];
      if (oversized.length) {
        const ids = new Set(oversized.map(({ id }) => id));
        setState((value) => {
          const unresolved = new Set(value.unresolved);
          const oversizedRecords = new Set(value.oversized);
          for (const id of ids) {
            unresolved.add(id);
            oversizedRecords.add(id);
          }
          return {
            ...value,
            unresolved,
            oversized: oversizedRecords,
            records: value.records.map((record) =>
              ids.has(record.id)
                ? { ...record, translationError: "too-large" }
                : record,
            ),
          };
        });
      }
      if (!batch?.length) {
        const unresolvedIds = new Set(current.unresolved);
        for (const id of run.resolvedIds) unresolvedIds.delete(id);
        for (const id of run.unresolvedIds) unresolvedIds.add(id);
        const partial = unresolvedIds.size > 0;
        const status: ReaderMessage | "" = partial
          ? {
              key: "workspace.status.partial",
              params: {
                translated: run.translated,
                unresolved: unresolvedIds.size,
              },
            }
          : "";
        const announcement: ReaderMessage = run.translated
          ? {
              key: "workspace.status.translationsCompleted",
              params: { count: run.translated },
            }
          : "workspace.status.noUntranslatedVisible";
        run.eligible = null;
        setState((value) => {
          const unresolved = new Set(value.unresolved);
          for (const id of run.resolvedIds) unresolved.delete(id);
          for (const id of run.unresolvedIds) unresolved.add(id);
          const nextTranslation = transitionSpreadsheetTranslation(
            value.spreadsheetTranslation,
            { type: partial ? "partial" : "completion" },
          );
          if (
            value.pending !== "translate" &&
            sameMessage(value.status, status) &&
            sameMessage(value.completionAnnouncement, announcement) &&
            value.spreadsheetTranslation === nextTranslation
          )
            return value;
          return {
            ...value,
            unresolved,
            spreadsheetTranslation: nextTranslation,
            pending: value.pending === "translate" ? undefined : value.pending,
            status,
            completionAnnouncement: announcement,
          };
        });
        return;
      }

      run.pending = true;
      translationRequestPending.current = true;
      const request = {
        type: "WORKSPACE_READER_TRANSLATE",
        readerInstanceId: readerInstanceId,
        requestId: ++requestId.current,
        sourceTabId: run.sourceTabId,
        version: current.version!,
        targetLanguage: run.targetLanguage,
        records: batch.map(({ id, sourceHash }) => ({ id, sourceHash })),
      } satisfies WorkspaceReaderRequest;
      setState((value) => ({
        ...value,
        pending: "translate",
        spreadsheetTranslation: transitionSpreadsheetTranslation(
          value.spreadsheetTranslation,
          { type: "request-accepted" },
        ),
        completionAnnouncement: "",
        error: undefined,
        status: "",
      }));
      const response = await send(request);
      translationRequestPending.current = false;
      const active = translationRun.current;
      if (
        !active ||
        active.id !== runId ||
        active.session !== session.current ||
        !responseMatchesCurrent(response, request)
      ) {
        // A replacement popup click waits for this physical request to settle.
        // Wake its effect without applying results from the superseded run.
        setState((value) => ({
          ...value,
        }));
        if (translationRun.current) void drain(translationRun.current.id);
        return;
      }
      active.pending = false;
      if (!response.ok) {
        translationRun.current = undefined;
        setState((value) => ({
          ...value,
          pending: undefined,
          spreadsheetTranslation: transitionSpreadsheetTranslation(
            value.spreadsheetTranslation,
            { type: "error" },
          ),
          connection: connectionAfterError(value.connection, response.error),
          error: errorMessage(response.error),
          status: "",
        }));
        return;
      }
      if (
        response.type !== "WORKSPACE_READER_TRANSLATE" ||
        response.generation !== active.generation
      ) {
        translationRun.current = undefined;
        setState((value) => ({
          ...value,
          pending: undefined,
          spreadsheetTranslation: transitionSpreadsheetTranslation(
            value.spreadsheetTranslation,
            { type: "error" },
          ),
          error: errorMessage("source-tab-changed"),
          status: "",
        }));
        return;
      }
      const expected = new Map(
        batch.map((record) => [record.id, record.sourceHash]),
      );
      const results = new Map(
        response.results
          .filter((result) => expected.get(result.id) === result.sourceHash)
          .map((result) => [result.id, result]),
      );
      for (const record of batch) {
        active.settled.add(record.id);
        const result = results.get(record.id);
        if (result && "text" in result) {
          active.translated += 1;
          active.resolvedIds.add(record.id);
          active.unresolvedIds.delete(record.id);
        } else {
          active.unresolvedIds.add(record.id);
        }
      }
      setState((value) => {
        const translations = new Map(value.translations);
        const unresolved = new Set(value.unresolved);
        const oversizedRecords = new Set(value.oversized);
        for (const record of batch) {
          const result = results.get(record.id);
          oversizedRecords.delete(record.id);
          if (result && "text" in result) unresolved.delete(record.id);
          else unresolved.add(record.id);
        }
        for (const result of results.values()) {
          if ("text" in result)
            translations.set(result.id, {
              sourceHash: result.sourceHash,
              text: result.text,
            });
        }
        return {
          ...value,
          translations,
          unresolved,
          oversized: oversizedRecords,
          records: value.records.map((record) => {
            const result = results.get(record.id);
            if (!expected.has(record.id)) return record;
            if (!result)
              return { ...record, translationError: "provider-error" };
            if (result.sourceHash !== record.sourceHash) return record;
            return "text" in result
              ? {
                  ...record,
                  translation: result.text,
                  translationError: undefined,
                }
              : { ...record, translationError: result.error };
          }),
        };
      });
      await Promise.resolve();
      void drain(runId);
    },
    [readerInstanceId, responseMatchesCurrent],
  );

  function startSheetTranslation(continuing = false) {
    if (
      state.connection !== "connected" ||
      state.sourceTabId === undefined ||
      state.generation === undefined ||
      !state.version ||
      (state.pending && state.pending !== "translate") ||
      translationRequestPending.current ||
      (translationRun.current &&
        state.spreadsheetTranslation.phase !== "partial") ||
      (!continuing &&
        (state.spreadsheetTranslation.phase === "translating" ||
          state.spreadsheetTranslation.phase === "watching"))
    )
      return;
    popupIntentEpoch.current += 1;
    popupIntent.current = undefined;
    if (state.context?.kind === "sheets") {
      continuation.current = {
        fileId: state.context.fileId,
        targetLanguage: state.targetLanguage,
      };
    }
    const run: SheetTranslationRun = {
      id: ++translationRunId.current,
      session: session.current,
      sourceTabId: state.sourceTabId,
      generation: state.generation,
      targetLanguage: state.targetLanguage,
      pending: false,
      eligible: null,
      settled: new Set(),
      resolvedIds: new Set(),
      unresolvedIds: new Set(),
      translated: 0,
    };
    translationRun.current = run;
    setState((current) => ({
      ...current,
      spreadsheetTranslation: continuing
        ? current.spreadsheetTranslation
        : transitionSpreadsheetTranslation(
            current.spreadsheetTranslation,
            current.spreadsheetTranslation.phase === "paused"
              ? { type: "resume" }
              : current.spreadsheetTranslation.phase === "partial" ||
                  current.spreadsheetTranslation.phase === "error"
                ? { type: "retry" }
                : { type: "start" },
          ),
      completionAnnouncement: "",
      unresolved:
        current.spreadsheetTranslation.phase === "idle" ||
        current.spreadsheetTranslation.phase === "error"
          ? new Set()
          : current.unresolved,
      oversized:
        current.spreadsheetTranslation.phase === "idle" ||
        current.spreadsheetTranslation.phase === "error"
          ? new Set()
          : current.oversized,
      records:
        current.spreadsheetTranslation.phase === "idle" ||
        current.spreadsheetTranslation.phase === "error"
          ? current.records.map((record) => ({
              ...record,
              translationError: undefined,
            }))
          : current.records,
      error: undefined,
      status: "",
    }));
    void drainSheetTranslation(run.id);
  }

  const continuePopupTranslation = useEffectEvent(async () => {
    const intent = popupIntent.current;
    if (!intent) return;
    if (!state.context) return;
    if (state.context.kind === "sheets" && state.context.activeId === null)
      return;
    if (!readReaderIntent(intent, intent.context.sourceTabId)) {
      popupIntent.current = undefined;
      return;
    }
    if (state.targetLanguage !== intent.targetLanguage) return;
    if (
      state.connection !== "connected" ||
      state.pending ||
      translationRequestPending.current ||
      state.error ||
      state.discovery.status !== "complete" ||
      !state.pages.size
    )
      return;
    popupIntent.current = undefined;
    const expectedEpoch = popupIntentEpoch.current;
    const rebound = await readerIntentForCurrentSource(
      intent,
      state.context,
    ).catch(() => undefined);
    if (rebound && expectedEpoch === popupIntentEpoch.current) {
      popupIntent.current = rebound;
      startSheetTranslation();
    }
  });

  useEffect(() => {
    void continuePopupTranslation();
  }, [state]);

  const continueFileTranslation = useEffectEvent(() => {
    const run = translationRun.current;
    if (run) {
      if (!state.pending && !workerRecovery.current)
        void drainSheetTranslation(run.id);
      return;
    }
    if (
      state.spreadsheetTranslation.phase !== "translating" ||
      state.connection !== "connected" ||
      state.context?.kind !== "sheets" ||
      state.pending ||
      state.error ||
      state.discovery.status !== "complete" ||
      !state.pages.size ||
      translationRun.current
    )
      return;
    startSheetTranslation(true);
  });

  useEffect(() => {
    continueFileTranslation();
  }, [state]);

  async function translate(scope: "loaded" | "selected") {
    if (state.context?.kind === "sheets") {
      startSheetTranslation();
      return;
    }
    if (
      state.sourceTabId === undefined ||
      state.generation === undefined ||
      state.pending
    )
      return;
    const candidates = state.records.filter(
      (record) =>
        record.translatable &&
        !record.translation &&
        (scope === "loaded" || state.selected.has(record.id)),
    );
    const oversized = new Set(
      candidates
        .filter(
          (record) =>
            translationSource(record).length >
            MAX_TRANSLATION_RECORD_CHARACTERS,
        )
        .map(({ id }) => id),
    );
    const batches = translationBatches(candidates);
    if (!batches.length) {
      setState((current) => ({
        ...current,
        records: current.records.map((record) =>
          oversized.has(record.id)
            ? { ...record, translationError: "too-large" }
            : record,
        ),
        status: oversized.size
          ? "workspace.status.selectedTooLarge"
          : "workspace.status.noUntranslatedAvailable",
      }));
      return;
    }

    const currentSession = session.current;
    const generation = state.generation;
    const targetLanguage = state.targetLanguage;
    let translated = 0;
    let unresolved = oversized.size;
    setState((current) => ({
      ...current,
      pending: "translate",
      error: undefined,
      records: current.records.map((record) =>
        oversized.has(record.id)
          ? { ...record, translationError: "too-large" }
          : record,
      ),
      status: "workspace.status.translating",
    }));

    for (const batch of batches) {
      const request = {
        type: "WORKSPACE_READER_TRANSLATE",
        readerInstanceId: readerInstanceId,
        requestId: ++requestId.current,
        sourceTabId: state.sourceTabId,
        version: state.version!,
        targetLanguage,
        records: batch.map(({ id, sourceHash }) => ({ id, sourceHash })),
      } satisfies WorkspaceReaderRequest;
      const response = await send(request);
      if (
        currentSession !== session.current ||
        !responseMatchesCurrent(response, request)
      )
        return;
      if (!response.ok) {
        setState((current) => ({
          ...current,
          connection: connectionAfterError(current.connection, response.error),
          pending: undefined,
          error: errorMessage(response.error),
          status: translated
            ? {
                key: "workspace.status.translationsKept",
                params: { count: translated },
              }
            : "",
        }));
        return;
      }
      if (
        response.type !== "WORKSPACE_READER_TRANSLATE" ||
        response.generation !== generation
      ) {
        setState((current) => ({
          ...current,
          pending: undefined,
          error: errorMessage("source-tab-changed"),
          status: "",
        }));
        return;
      }
      const expected = new Map(
        batch.map((record) => [record.id, record.sourceHash]),
      );
      const results = new Map(
        response.results
          .filter((result) => expected.get(result.id) === result.sourceHash)
          .map((result) => [result.id, result]),
      );
      for (const result of results.values()) {
        if ("text" in result) translated += 1;
        else unresolved += 1;
      }
      setState((current) => ({
        ...current,
        records: current.records.map((record) => {
          const result = results.get(record.id);
          if (!result || result.sourceHash !== record.sourceHash) return record;
          if ("text" in result) {
            return {
              ...record,
              translation: result.text,
              translationError: undefined,
            };
          }
          return { ...record, translationError: result.error };
        }),
      }));
    }
    if (currentSession !== session.current) return;
    setState((current) => ({
      ...current,
      pending: undefined,
      status: unresolved
        ? {
            key: "workspace.status.partial",
            params: { translated, unresolved },
          }
        : {
            key: "workspace.status.translationsCompleted",
            params: { count: translated },
          },
    }));
  }

  function stopTranslation() {
    popupIntentEpoch.current += 1;
    popupIntent.current = undefined;
    continuation.current = undefined;
    translationRun.current = undefined;
    if (workerRecovery.current) workerRecovery.current.run = undefined;
    setState((current) => ({
      ...current,
      spreadsheetTranslation: transitionSpreadsheetTranslation(
        current.spreadsheetTranslation,
        { type: "stop" },
      ),
      completionAnnouncement: "",
      pending: current.pending === "translate" ? undefined : current.pending,
      status: "",
    }));
  }

  function clearView() {
    workerRecovery.current = undefined;
    popupIntentEpoch.current += 1;
    popupIntent.current = undefined;
    session.current += 1;
    translationRun.current = undefined;
    continuation.current = undefined;
    pendingPages.current.clear();
    pageLoadQueue.current = [];
    viewportRecordIds.current = [];
    setVisibleSheetRecordIds([]);
    setState((current) => ({
      ...current,
      spreadsheetTranslation: transitionSpreadsheetTranslation(
        current.spreadsheetTranslation,
        { type: "source-change" },
      ),
      completionAnnouncement: "",
      title: "",
      records: [],
      grid: undefined,
      pages: new Map(),
      translations: new Map(),
      unresolved: new Set(),
      oversized: new Set(),
      cursor: null,
      tabs: [],
      sheets: [],
      generation: undefined,
      discovery: { status: "idle" },
      selected: new Set(),
      error: undefined,
      status: "workspace.status.viewCleared",
    }));
  }

  function changeTranslationSettings(
    update: Partial<Pick<ReaderState, "targetLanguage">>,
  ) {
    workerRecovery.current = undefined;
    if (update.targetLanguage !== undefined)
      preferencesDirty.current.add("targetLanguage");
    void saveReaderPreferences(update).catch(() => undefined);
    popupIntentEpoch.current += 1;
    popupIntent.current = undefined;
    session.current += 1;
    translationRun.current = undefined;
    continuation.current = undefined;
    pendingPages.current.clear();
    pageLoadQueue.current = [];
    setState((current) => ({
      ...current,
      ...update,
      spreadsheetTranslation: transitionSpreadsheetTranslation(
        current.spreadsheetTranslation,
        { type: "settings-change" },
      ),
      completionAnnouncement: "",
      records: current.records.map((record) => ({
        ...record,
        translation: undefined,
        translationError: undefined,
      })),
      translations: new Map(),
      unresolved: new Set(),
      oversized: new Set(),
      error: undefined,
      status: "workspace.status.settingsChanged",
    }));
  }

  function refresh() {
    popupIntentEpoch.current += 1;
    popupIntent.current = undefined;
    if (state.sourceTabId === undefined || state.pending) return;
    beginFreshContext(
      state.sourceTabId,
      awaitingSourceStart,
      awaitingSourceStart,
    );
  }

  async function openFallback() {
    if (state.sourceTabId === undefined || fallbackOpening) return;
    const tabId = state.sourceTabId;
    const expectedSession = session.current;
    let queuedIntent: WorkspaceReaderIntent | undefined;
    setFallbackOpening(true);
    fallbackHandoff.current = true;
    try {
      await saveReaderPreferences({
        targetLanguage: state.targetLanguage,
      });
      await intentClaim.current;
      const intent = fallbackIntent.current ?? popupIntent.current;
      const carryIntent = intent && (await readerIntentIsCurrent(intent));
      if (disposed.current || expectedSession !== session.current) return;
      await openReaderTabFallback(
        tabId,
        awaitingSourceStart,
        intent?.context.fileId ?? state.context?.fileId,
        () => !disposed.current && expectedSession === session.current,
        state.sheets.find((sheet) => sheet.sheetId === state.context?.activeId)
          ?.sheetId,
        carryIntent
          ? async () => {
              queuedIntent = intent;
              await browser.storage.session.set({
                [readerIntentKey(tabId)]: intent,
              });
            }
          : undefined,
      );
    } catch {
      if (queuedIntent) {
        const ownedIntent = queuedIntent;
        const key = readerIntentKey(tabId);
        const removeOwnedIntent = async () => {
          const stored = await browser.storage.session.get(key);
          const current = readReaderIntent(stored[key], tabId);
          if (
            current?.id === ownedIntent.id &&
            current.createdAt === ownedIntent.createdAt
          )
            await browser.storage.session.remove(key);
        };
        await (
          navigator.locks
            ? navigator.locks.request(key, removeOwnedIntent)
            : removeOwnedIntent()
        ).catch(() => undefined);
      }
      const tab = await browser.tabs.get(tabId).catch(() => undefined);
      const current = parseWorkspaceEditorUrl(tab?.url ?? "");
      const original = fallbackIntent.current ?? popupIntent.current;
      if (
        !disposed.current &&
        expectedSession === session.current &&
        current &&
        (!state.context || current.fileId === state.context.fileId) &&
        (!original ||
          (await readerIntentIsCurrent(original).catch(() => false)))
      )
        fallbackHandoff.current = false;
      setState((current) => ({
        ...current,
        error: "workspace.error.openTabFailed",
      }));
    } finally {
      setFallbackOpening(false);
    }
  }

  function continueDiscovery() {
    if (
      state.sourceTabId === undefined ||
      state.context?.kind !== "sheets" ||
      !state.version ||
      state.discovery.status !== "paused" ||
      state.pending
    )
      return;
    void discoverSheet(
      state.sourceTabId,
      state.context,
      state.version,
      session.current,
      state.discovery.cursor,
    );
  }

  async function changeSheet(sheetId: string) {
    if (
      state.sourceTabId === undefined ||
      state.context?.kind !== "sheets" ||
      !state.version ||
      (state.pending &&
        state.pending !== "select" &&
        state.pending !== "discover" &&
        state.pending !== "load") ||
      sheetId === state.context.activeId ||
      !state.sheets.some((sheet) => sheet.sheetId === sheetId)
    )
      return;
    popupIntentEpoch.current += 1;
    popupIntent.current = undefined;
    const shouldContinue =
      Boolean(translationRun.current ?? workerRecovery.current?.run) ||
      deriveSpreadsheetTranslationCapabilities(state.spreadsheetTranslation, {
        sourceReady: true,
        hasVisibleRecords: viewportRecordIds.current.length > 0,
        hasTranslations: state.translations.size > 0,
      }).shouldContinueOnReaderSheetChange;
    const expectedSession = ++session.current;
    translationRun.current = undefined;
    pendingPages.current.clear();
    pageLoadQueue.current = [];
    viewportRecordIds.current = [];
    setVisibleSheetRecordIds([]);
    workerRecovery.current = undefined;
    continuation.current = shouldContinue
      ? {
          fileId: state.context.fileId,
          targetLanguage: state.targetLanguage,
        }
      : undefined;
    const request = {
      type: "WORKSPACE_READER_SELECT_SHEET",
      readerInstanceId: readerInstanceId,
      requestId: ++requestId.current,
      sourceTabId: state.sourceTabId,
      version: state.version,
      sheetId,
    } satisfies WorkspaceReaderRequest;
    setState((current) => ({
      ...current,
      context: current.context
        ? { ...current.context, activeId: sheetId }
        : current.context,
      title:
        current.sheets.find((sheet) => sheet.sheetId === sheetId)?.title ??
        current.title,
      grid: undefined,
      pages: new Map(),
      records: [],
      translations: new Map(),
      unresolved: new Set(),
      oversized: new Set(),
      cursor: null,
      generation: undefined,
      discovery: { status: "idle" },
      spreadsheetTranslation: transitionSpreadsheetTranslation(
        current.spreadsheetTranslation,
        {
          type:
            shouldContinue && current.spreadsheetTranslation.phase === "partial"
              ? "start"
              : "reader-sheet-change",
        },
      ),
      completionAnnouncement: "",
      pending: "select",
      error: undefined,
      status: "workspace.status.loadingWorksheet",
    }));
    const response = await send(request);
    if (
      expectedSession !== session.current ||
      !responseMatchesCurrent(response, request)
    )
      return;
    if (!response.ok) {
      continuation.current = undefined;
      setState((current) => ({
        ...current,
        pending: undefined,
        spreadsheetTranslation: transitionSpreadsheetTranslation(
          current.spreadsheetTranslation,
          { type: "source-change" },
        ),
        connection: connectionAfterError(current.connection, response.error),
        error: errorMessage(response.error),
        status: "",
      }));
      return;
    }
    if (
      response.type !== "WORKSPACE_READER_SELECT_SHEET" ||
      response.context.kind !== "sheets" ||
      response.context.activeId !== sheetId
    )
      return;
    sourceVersion.current = response.version;
    setState((current) => ({
      ...current,
      context: response.context,
      version: response.version,
      sheets: response.sheets,
      pending: undefined,
      status: "",
    }));
    if (!awaitingSourceStart)
      await discoverSheet(
        state.sourceTabId,
        response.context,
        response.version,
        expectedSession,
      );
  }

  function changeDocsTab(tabId: string) {
    if (
      state.sourceTabId === undefined ||
      !state.context ||
      !state.version ||
      state.pending
    )
      return;
    const currentSession = ++session.current;
    translationRun.current = undefined;
    pendingPages.current.clear();
    pageLoadQueue.current = [];
    void loadDocs(
      state.sourceTabId,
      { kind: "docs", tabId },
      state.context,
      state.version,
      currentSession,
    );
  }

  const pending = state.pending !== undefined;
  const translatable = state.records.filter(({ translatable }) => translatable);
  const selectedCount = translatable.filter(({ id }) =>
    state.selected.has(id),
  ).length;
  const docsTabOptions = state.tabs.map(({ id, title, depth }) => ({
    value: id,
    label: `${"— ".repeat(depth)}${title || t.t("workspace.untitledTab")}`,
  }));
  const sheetOptions = useMemo(
    () =>
      state.sheets.map(({ sheetId, title }) => ({
        value: sheetId,
        label: title,
      })),
    [state.sheets],
  );
  const sheetPages = useMemo(() => [...state.pages.values()], [state.pages]);
  const sheetTranslations = useMemo(() => {
    return displayedSheetTranslations(state.records, state.translations);
  }, [state.records, state.translations]);
  const handleNearPageEnd = useCallback(
    (requestedStart?: number) => {
      const current = stateRef.current;
      if (
        sheetMock ||
        current.sourceTabId === undefined ||
        !current.version ||
        !current.grid ||
        current.pending === "discover" ||
        current.pending === "connect" ||
        current.pending === "disconnect"
      )
        return;
      const cursor =
        requestedStart === 0
          ? null
          : requestedStart !== undefined
            ? ({ kind: "sheets", nextRow: requestedStart } as const)
            : current.cursor?.kind === "sheets"
              ? current.cursor
              : null;
      const startRow = cursor?.kind === "sheets" ? cursor.nextRow : 0;
      if (startRow >= current.grid.rowCount) return;
      void loadSheetPage(
        current.sourceTabId,
        cursor,
        current.grid,
        current.version,
        session.current,
      );
    },
    [loadSheetPage, sheetMock],
  );
  const handleViewportRecordsChange = useCallback(
    (recordIds: string[]) => {
      viewportRecordIds.current = recordIds;
      setVisibleSheetRecordIds(recordIds);
      const run = translationRun.current;
      if (run) void drainSheetTranslation(run.id);
    },
    [drainSheetTranslation],
  );
  const showSheetGrid =
    state.context?.kind === "sheets" &&
    state.grid !== undefined &&
    state.grid.lastUsedColumn >= 0;
  const sheetSourceReady =
    state.connection === "connected" &&
    state.context?.kind === "sheets" &&
    state.discovery.status === "complete" &&
    state.grid !== undefined &&
    !state.pending;
  const visibleRecords = new Set(visibleSheetRecordIds);
  const hasVisibleTranslatableRecords = state.records.some(
    (record) =>
      record.translatable &&
      visibleRecords.has(record.id) &&
      (state.spreadsheetTranslation.phase !== "partial" ||
        (!record.translation && !state.oversized.has(record.id))),
  );
  const hasSheetTranslations = sheetTranslations.size > 0;
  const spreadsheetCapabilities = {
    ...deriveSpreadsheetTranslationCapabilities(state.spreadsheetTranslation, {
      sourceReady: sheetSourceReady,
      settingsReady: state.connection === "connected" && !pending,
      hasVisibleRecords: hasVisibleTranslatableRecords,
      hasTranslations: hasSheetTranslations,
    }),
    stopDisabled:
      !translationRun.current &&
      state.spreadsheetTranslation.phase !== "translating" &&
      state.spreadsheetTranslation.phase !== "watching",
  };
  const spreadsheetSourcePhase: SpreadsheetSourcePhase =
    state.pending === "disconnect"
      ? "disconnecting"
      : state.error
        ? "error"
        : state.pending === "context"
          ? "bootstrapping"
          : state.pending === "discover"
            ? "discovering"
            : state.pending === "select" || state.pending === "load"
              ? "loading-sheet"
              : awaitingSourceStart
                ? "awaiting-start"
                : state.grid && state.grid.lastUsedColumn < 0
                  ? "empty"
                  : "ready";
  const errorText = state.error ? t.text(state.error) : "";
  const statusText = state.status ? t.text(state.status) : "";
  const spreadsheetMessage: SpreadsheetReaderActionableMessage | undefined =
    errorText
      ? { text: errorText, tone: "error" }
      : state.spreadsheetTranslation.phase === "partial" && statusText
        ? { text: statusText, tone: "partial" }
        : state.discovery.status === "paused"
          ? {
              text: statusText || t.t("workspace.status.discoveryPaused"),
              tone: "warning",
            }
          : undefined;

  return (
    <main className="reader-shell" aria-busy={pending}>
      <ReaderHeader subtitle={t.t("workspace.subtitle")}>
        <span
          className={`connection ${state.connection === "connected" ? "connected" : ""}`}
        >
          {t.t(
            state.connection === "connected"
              ? "workspace.connection.connected"
              : state.connection === "disconnected"
                ? "workspace.connection.notConnected"
                : state.connection === "unavailable"
                  ? "workspace.connection.unavailable"
                  : "workspace.connection.checking",
          )}
        </span>
      </ReaderHeader>

      {state.channelUnavailable ? (
        <button
          type="button"
          className="primary-button"
          disabled={fallbackOpening}
          onClick={() => void openFallback()}
        >
          {t.t(
            fallbackOpening ? "workspace.openingReader" : "workspace.openInTab",
          )}
        </button>
      ) : null}

      {state.context?.kind === "sheets" &&
      state.configured &&
      state.connection === "connected" ? (
        <>
          <SpreadsheetReaderControls
            sourceLabel={t.t("workspace.activeSheet")}
            sourceTitle={state.title || t.t("workspace.notLoaded")}
            sourcePhase={spreadsheetSourcePhase}
            worksheetOptions={sheetOptions}
            worksheetPlaceholder={t.t("workspace.worksheetUnavailable")}
            worksheetDisabled={
              state.sheets.length > 0 &&
              (state.pending === "select" ||
                state.pending === "load" ||
                state.pending === "discover")
                ? false
                : undefined
            }
            worksheetValue={
              sheetOptions.some(
                (option) => option.value === state.context?.activeId,
              )
                ? state.context.activeId!
                : ""
            }
            onWorksheetChange={(value) => void changeSheet(value)}
            targetOptions={targetOptions}
            targetValue={state.targetLanguage}
            onTargetChange={(value) =>
              changeTranslationSettings({
                targetLanguage: value as TargetLanguage,
              })
            }
            translationState={state.spreadsheetTranslation}
            translationCapabilities={
              awaitingSourceStart && !pending
                ? {
                    ...spreadsheetCapabilities,
                    primaryDisabled: false,
                    primaryLabel: "reader.primary.translate",
                  }
                : spreadsheetCapabilities
            }
            onPrimaryAction={() => {
              if (
                awaitingSourceStart &&
                state.sourceTabId !== undefined &&
                state.context &&
                state.version
              ) {
                setAwaitingSourceStart(false);
                setState((current) => ({
                  ...current,
                  spreadsheetTranslation: transitionSpreadsheetTranslation(
                    current.spreadsheetTranslation,
                    { type: "start" },
                  ),
                }));
                void startSource(
                  state.sourceTabId,
                  state.context,
                  state.version,
                  session.current,
                );
              } else startSheetTranslation();
            }}
            onStop={stopTranslation}
            presentation={sheetPresentation}
            onPresentationChange={setSheetPresentation}
            refreshDisabled={
              state.pending !== undefined ||
              state.spreadsheetTranslation.phase === "translating"
            }
            onRefresh={refresh}
            clearDisabled={
              state.pending !== undefined ||
              (!state.records.length && !state.grid)
            }
            onClear={clearView}
            connection={{
              kind: "google",
              label: "Google Workspace",
              badgeLabel: t.t("workspace.connection.connected"),
              disconnecting: state.pending === "disconnect",
              onDisconnect: () => void disconnect(),
            }}
            actionableMessage={spreadsheetMessage}
            completionAnnouncement={
              state.completionAnnouncement
                ? t.text(state.completionAnnouncement)
                : ""
            }
          />
          {state.discovery.status === "paused" ? (
            <button
              type="button"
              className="secondary-button reader-discovery-resume"
              disabled={pending}
              onClick={continueDiscovery}
            >
              {t.t("workspace.continueDiscovery")}
            </button>
          ) : null}
        </>
      ) : (
        <section
          className="reader-controls"
          aria-label={t.t("workspace.controls")}
        >
          {state.context ? (
            <div className="source-context">
              <span>
                {t.t(
                  state.context.kind === "sheets"
                    ? "workspace.activeSheet"
                    : "workspace.documentTab",
                )}
              </span>
              <strong>{state.title || t.t("workspace.notLoaded")}</strong>
            </div>
          ) : null}

          {state.configured && state.connection === "connected" ? (
            <>
              <div className="reader-fields">
                <div className="reader-field">
                  <Select
                    disabled={pending}
                    label={t.t("workspace.translateTo")}
                    options={targetOptions}
                    value={state.targetLanguage}
                    variant="compact"
                    onValueChange={(value) =>
                      changeTranslationSettings({
                        targetLanguage: value as TargetLanguage,
                      })
                    }
                  />
                </div>
              </div>

              {state.context?.kind === "docs" && docsTabOptions.length ? (
                <div className="reader-field reader-docs-field">
                  <Select
                    disabled={pending}
                    label={t.t("workspace.documentTab")}
                    options={docsTabOptions}
                    value={state.context.activeId ?? docsTabOptions[0]!.value}
                    variant="compact"
                    onValueChange={changeDocsTab}
                  />
                </div>
              ) : null}

              <div className="primary-actions">
                <button
                  type="button"
                  className="primary-button"
                  disabled={pending || !translatable.length}
                  onClick={() => void translate("loaded")}
                >
                  <Languages aria-hidden="true" />
                  {t.t(
                    state.context?.kind === "sheets"
                      ? "workspace.translate"
                      : "workspace.translateLoaded",
                  )}
                </button>
                {state.context?.kind === "docs" ? (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={pending || selectedCount === 0}
                    onClick={() => void translate("selected")}
                  >
                    {t.t("workspace.translateSelected", {
                      count: selectedCount,
                    })}
                  </button>
                ) : null}
              </div>

              <div className="reader-secondary-row">
                {showSheetGrid ? (
                  <div
                    className="sheet-presentation-toggle"
                    aria-label={t.t("workspace.cellPresentation")}
                  >
                    <button
                      type="button"
                      aria-pressed={sheetPresentation === "translation"}
                      onClick={() => setSheetPresentation("translation")}
                    >
                      {t.t("workspace.presentation.translation")}
                    </button>
                    <button
                      type="button"
                      aria-pressed={sheetPresentation === "original"}
                      onClick={() => setSheetPresentation("original")}
                    >
                      {t.t("workspace.presentation.original")}
                    </button>
                  </div>
                ) : null}

                <div className="utility-actions">
                  <button
                    type="button"
                    disabled={pending || state.sourceTabId === undefined}
                    onClick={refresh}
                  >
                    <RefreshCw aria-hidden="true" />
                    {t.t("workspace.refresh")}
                  </button>
                  <button
                    type="button"
                    disabled={pending || !state.records.length}
                    onClick={clearView}
                  >
                    <Trash2 aria-hidden="true" />
                    {t.t("workspace.clearView")}
                  </button>
                  <button
                    type="button"
                    className="disconnect-button"
                    disabled={pending}
                    onClick={() => void disconnect()}
                  >
                    {t.t("workspace.disconnect")}
                  </button>
                </div>
              </div>
            </>
          ) : null}

          {state.configured &&
          !state.localReaderGuidance &&
          state.connection !== "connected" &&
          state.sourceTabId !== undefined ? (
            <button
              type="button"
              className="primary-button connect-button"
              disabled={pending}
              onClick={() => void connect()}
            >
              {t.t(
                state.connection === "unavailable" || state.error
                  ? "workspace.reconnect"
                  : "workspace.connect",
              )}
            </button>
          ) : null}

          <div
            className={
              state.error && state.localReaderGuidance
                ? "reader-status guidance"
                : state.error
                  ? "reader-status error"
                  : "reader-status"
            }
            role={state.error ? "alert" : "status"}
            aria-live="polite"
            aria-atomic="true"
          >
            {pending ? (
              <LoaderCircle
                className="spinner"
                aria-hidden="true"
                data-testid="reader-spinner"
              />
            ) : state.error && state.localReaderGuidance ? (
              <FileSpreadsheet aria-hidden="true" />
            ) : state.error ? (
              <AlertCircle aria-hidden="true" />
            ) : null}

            {state.discovery.status === "paused" ? (
              <button
                type="button"
                className="secondary-button"
                disabled={pending}
                onClick={continueDiscovery}
              >
                {t.t("workspace.continueDiscovery")}
              </button>
            ) : null}
            <span>{errorText || statusText}</span>
          </div>
          {state.error && state.localReaderGuidance ? (
            <button
              type="button"
              className="primary-button"
              onClick={() =>
                void browser.tabs
                  .create({
                    url: browser.runtime.getURL(LOCAL_READER_PATH as never),
                  })
                  .catch(() => undefined)
              }
            >
              {t.t("workspace.openLocalSpreadsheet")}
            </button>
          ) : null}
        </section>
      )}

      <section
        className={
          state.context?.kind === "sheets"
            ? "reader-results sheets-results"
            : "reader-results"
        }
        aria-label={t.t(
          showSheetGrid
            ? "workspace.results.sheet"
            : "workspace.results.records",
        )}
      >
        {showSheetGrid ? (
          <SheetsGrid
            key={`${state.grid!.sheetId}:${gridViewGeneration.current ?? state.grid!.generation}`}
            grid={state.grid!}
            pages={sheetPages}
            translations={sheetTranslations}
            presentation={sheetPresentation}
            onNearPageEnd={handleNearPageEnd}
            onViewportRecordsChange={handleViewportRecordsChange}
          />
        ) : state.records.length ? (
          <ul className="record-list">
            {state.records.map((record) => {
              const selected = state.selected.has(record.id);
              return (
                <li
                  className="record"
                  key={`${record.id}:${record.sourceHash}`}
                >
                  <label className="record-heading">
                    <input
                      type="checkbox"
                      aria-label={t.t("workspace.record.select", {
                        anchor: record.anchor,
                      })}
                      checked={selected}
                      disabled={pending || !record.translatable}
                      onChange={(event) =>
                        setState((current) => {
                          const next = new Set(current.selected);
                          if (event.target.checked) next.add(record.id);
                          else next.delete(record.id);
                          return { ...current, selected: next };
                        })
                      }
                    />
                    <strong>{record.anchor}</strong>
                    {record.kind === "formula" ? (
                      <span className="badge">
                        {t.t("workspace.record.formula")}
                      </span>
                    ) : null}
                    {record.kind === "error" ? (
                      <span className="badge error-badge">
                        {t.t("workspace.record.error")}
                      </span>
                    ) : null}
                    {!record.translatable && record.kind !== "error" ? (
                      <span className="badge muted">
                        {t.t("workspace.record.nonText")}
                      </span>
                    ) : null}
                    {record.translationError ? (
                      <span className="badge error-badge">
                        {t.t(
                          record.translationError === "too-large"
                            ? "workspace.record.tooLarge"
                            : record.translationError === "provider-error"
                              ? "workspace.record.translationFailed"
                              : "workspace.record.unresolved",
                        )}
                      </span>
                    ) : null}
                  </label>
                  <p className="record-label">
                    {t.t("workspace.record.source")}
                  </p>
                  <p className="record-text">
                    {record.source || record.display}
                  </p>
                  {record.kind === "formula" &&
                  record.display !== record.source ? (
                    <p className="formula-result">
                      {t.t("workspace.record.displayedValue", {
                        value: record.display,
                      })}
                    </p>
                  ) : null}
                  {record.translation !== undefined ? (
                    <>
                      <p className="record-label translation-label">
                        {t.t("workspace.record.translation")}
                      </p>
                      <p className="record-text translation">
                        {record.translation}
                      </p>
                    </>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : state.error && state.localReaderGuidance ? null : (
          <SpreadsheetReaderSourceState
            phase={
              spreadsheetSourcePhase === "ready"
                ? "empty"
                : spreadsheetSourcePhase
            }
            title={
              awaitingSourceStart
                ? state.title ||
                  sourceTitle ||
                  t.t("workspace.empty.readyToRead")
                : state.connection !== "connected" &&
                    !state.pending &&
                    !state.error
                  ? t.t("workspace.empty.connectToRead")
                  : undefined
            }
            description={
              awaitingSourceStart
                ? t.t("workspace.empty.clickTranslate")
                : undefined
            }
          />
        )}
      </section>
    </main>
  );
}
