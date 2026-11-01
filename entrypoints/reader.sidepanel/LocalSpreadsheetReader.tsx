import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertCircle,
  FileSpreadsheet,
  LoaderCircle,
  Upload,
} from "lucide-react";

import type { SelectOption } from "@/components/Select";
import {
  readReaderPreferences,
  saveReaderPreferences,
} from "@/lib/reader-preferences";
import {
  takeReaderIntent,
  readerIntentIsCurrent,
  type WorkspaceReaderIntent,
} from "@/lib/workspace-reader-intent";
import { readerMessages, type ReaderMessage } from "@/lib/i18n/catalog/reader";
import { languageKey } from "@/lib/i18n/catalog/common";
import { useMessages } from "@/lib/i18n/react";
import {
  MAX_LOCAL_COLUMNS,
  MAX_LOCAL_FILE_BYTES,
  MAX_LOCAL_MERGES,
  MAX_LOCAL_ROWS,
  MAX_LOCAL_SHEETS,
  type LocalSpreadsheetErrorCode,
  type LocalSpreadsheetMetadata,
  type LocalSpreadsheetSelection,
  type LocalSpreadsheetWorkerRequest,
} from "@/lib/local-spreadsheet";
import {
  MAX_LOCAL_TRANSLATION_MESSAGE_UNITS,
  MAX_LOCAL_TRANSLATION_RECORDS,
  MAX_LOCAL_TRANSLATION_RECORD_UNITS,
  parseLocalSpreadsheetTranslateResponse,
  type LocalSpreadsheetTranslateRequest,
} from "@/lib/local-spreadsheet-reader";
import {
  parseWorkspaceReaderSourceChanged,
  parseWorkspaceSourceVersion,
  parseWorkspaceSheetGrid,
  parseWorkspaceSheetPage,
  type WorkspaceReaderRequest,
  type WorkspaceSheetCell,
  type WorkspaceSheetPage,
  type WorkspaceSourceVersion,
} from "@/lib/google-workspace-reader";
import {
  GOOGLE_DRIVE_OFFICE_PORT_NAME,
  GoogleDriveOfficeDownloadAssembler,
  GoogleDriveOfficeProtocolError,
  type GoogleDriveOfficeErrorCode,
  type GoogleDriveOfficeStartRequest,
} from "@/lib/google-drive-office-reader";
import { TARGET_LANGUAGES, type TargetLanguage } from "@/lib/translation";
import {
  deriveSpreadsheetTranslationCapabilities,
  INITIAL_SPREADSHEET_TRANSLATION_STATE,
  transitionSpreadsheetTranslation,
  type SpreadsheetTranslationEvent,
  type SpreadsheetTranslationState,
} from "@/lib/spreadsheet-reader-state";
import { DropThread } from "./DropThread";
import { ReaderHeader } from "./ReaderHeader";
import SheetsGrid from "./SheetsGrid";
import { openReaderTabFallback } from "./App";
import SpreadsheetReaderControls, {
  SpreadsheetReaderSourceState,
  type SpreadsheetReaderActionableMessage,
  type SpreadsheetSourcePhase,
} from "./SpreadsheetReaderControls";

const PARSE_TIMEOUT_MS = 15_000;
const DRIVE_DOWNLOAD_TIMEOUT_MS = 30_000;
const TRANSLATION_TIMEOUT_MS = 30_000;
const supportedFileName = /\.(csv|xlsx|xlsm)$/i;

export interface LocalSpreadsheetWorkerLike {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  postMessage(
    message: LocalSpreadsheetWorkerRequest,
    transfer?: Transferable[],
  ): void;
  terminate(): void;
}

export type LocalSpreadsheetReaderSource =
  | { kind: "local-file" }
  | {
      kind: "drive-office";
      fileId?: string;
      sourceTabId: number;
      version: WorkspaceSourceVersion;
    };

export interface DriveOfficePortLike {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: {
    addListener(listener: (message: unknown) => void): void;
    removeListener(listener: (message: unknown) => void): void;
  };
  onDisconnect: {
    addListener(listener: () => void): void;
    removeListener(listener: () => void): void;
  };
}

interface LocalSpreadsheetReaderProps {
  workerFactory?: () => LocalSpreadsheetWorkerLike;
  portFactory?: () => DriveOfficePortLike;
  source?: LocalSpreadsheetReaderSource;
  onExitDriveOffice?: () => void;
  awaitingStart?: boolean;
  sourceTitle?: string;
  translateIntent?: WorkspaceReaderIntent;
  managedSourceLifecycle?: boolean;
}

interface AcceptedTranslation {
  sourceHash: string;
  text: string;
}

interface ReaderState {
  metadata?: LocalSpreadsheetMetadata;
  selection?: LocalSpreadsheetSelection;
  pages: Map<number, WorkspaceSheetPage>;
  translations: Map<string, AcceptedTranslation>;
  unresolved: Set<string>;
  oversized: Set<string>;
  targetLanguage: TargetLanguage;
  presentation: "translation" | "original";
  pending:
    "file" | "sheet" | "translate" | "disconnect" | "open-reader" | undefined;
  /** Messages are kept as refs and translated when they render. */
  status?: ReaderMessage;
  error?: ReaderMessage;
  driveError?: GoogleDriveOfficeErrorCode;
}

/** The catalog key of a stored message, for checks that never read text. */
function messageKey(message: ReaderMessage | undefined) {
  return typeof message === "object" ? message.key : message;
}

interface WorkerOwner {
  kind: "parse" | "select-sheet" | "load-page" | "dispose";
  session: number;
  fileName?: string;
  sheetIndex?: number;
  startRow?: number;
}

const initialState: ReaderState = {
  pages: new Map(),
  translations: new Map(),
  unresolved: new Set(),
  oversized: new Set(),
  targetLanguage: "vi",
  presentation: "translation",
  pending: undefined,
  status: "reader.status.chooseFile",
};

function translationActive(state: SpreadsheetTranslationState) {
  return state.phase === "translating" || state.phase === "watching";
}

/** Drive channel codes → Reader message keys, translated at render. */
const driveOfficeErrors = {
  "invalid-request": "reader.drive.invalidRequest",
  "auth-required": "reader.error.authRequired",
  "auth-unavailable": "reader.error.authUnavailable",
  "google-auth-required": "reader.drive.googleAuthRequired",
  "google-access-denied": "reader.drive.accessDenied",
  "google-oauth-expired": "reader.drive.oauthExpired",
  "google-oauth-scope": "reader.drive.googleAuthRequired",
  "unsupported-file-type": "reader.drive.unsupportedFileType",
  "download-not-allowed": "reader.drive.downloadNotAllowed",
  "office-download-required": "reader.drive.officeDownloadRequired",
  "file-too-large": "reader.drive.fileTooLarge",
  "download-timeout": "reader.drive.downloadTimeout",
  "temporarily-unavailable": "reader.drive.temporarilyUnavailable",
  "reader-channel-unavailable": "reader.drive.channelUnavailable",
  "source-tab-changed": "reader.drive.sourceTabChanged",
  "invalid-response": "reader.drive.invalidResponse",
} as const satisfies Record<GoogleDriveOfficeErrorCode, ReaderMessage>;

/** Worker error codes → Reader message keys, translated at render. */
const localErrors = {
  "unsupported-file-type": "reader.local.unsupportedFileType",
  "file-too-large": "reader.local.fileTooLarge",
  "too-many-sheets": "reader.local.tooManySheets",
  "dimensions-too-large": "reader.local.dimensionsTooLarge",
  "content-too-large": "reader.local.contentTooLarge",
  "encrypted-workbook": "reader.local.encryptedWorkbook",
  "invalid-workbook": "reader.local.invalidWorkbook",
  "invalid-request": "reader.local.invalidRequest",
} as const satisfies Record<LocalSpreadsheetErrorCode, ReaderMessage>;

function exactKeys(value: object, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseMetadata(value: unknown): LocalSpreadsheetMetadata | null {
  const metadata = objectValue(value);
  if (
    !metadata ||
    !exactKeys(metadata, ["fileName", "sheets"]) ||
    typeof metadata.fileName !== "string" ||
    !metadata.fileName ||
    metadata.fileName.length > 255 ||
    !Array.isArray(metadata.sheets) ||
    metadata.sheets.length === 0 ||
    metadata.sheets.length > MAX_LOCAL_SHEETS
  )
    return null;
  const sheets: LocalSpreadsheetMetadata["sheets"] = [];
  for (const [index, candidate] of metadata.sheets.entries()) {
    const sheet = objectValue(candidate);
    if (
      !sheet ||
      !exactKeys(sheet, ["index", "name"]) ||
      sheet.index !== index ||
      typeof sheet.name !== "string" ||
      !sheet.name ||
      sheet.name.length > 255
    )
      return null;
    sheets.push({ index, name: sheet.name });
  }
  return { fileName: metadata.fileName, sheets };
}

function parseLocalSheetPage(
  input: unknown,
  grid: LocalSpreadsheetSelection["grid"],
) {
  const page = objectValue(input);
  if (!page || !Array.isArray(page.rows))
    return parseWorkspaceSheetPage(input, grid);
  const oversizedIds = new Set<string>();
  const rows = page.rows.map((rawRow) => {
    const row = objectValue(rawRow);
    if (!row || !Array.isArray(row.cells)) return rawRow;
    return {
      ...row,
      cells: row.cells.map((rawCell) => {
        const cell = objectValue(rawCell);
        const text = cell?.kind === "formula" ? cell.display : cell?.source;
        if (
          cell?.translatable !== true ||
          typeof cell.id !== "string" ||
          typeof text !== "string" ||
          text.length <= MAX_LOCAL_TRANSLATION_RECORD_UNITS
        )
          return rawCell;
        oversizedIds.add(cell.id);
        return { ...cell, translatable: false };
      }),
    };
  });
  const parsed = parseWorkspaceSheetPage({ ...page, rows }, grid);
  if (!parsed || !oversizedIds.size) return parsed;
  return {
    ...parsed,
    rows: parsed.rows.map((row) => ({
      ...row,
      cells: row.cells.map((cell) =>
        oversizedIds.has(cell.id) ? { ...cell, translatable: true } : cell,
      ),
    })),
  };
}

function parseSelection(
  value: unknown,
  metadata: LocalSpreadsheetMetadata,
): LocalSpreadsheetSelection | null {
  const selection = objectValue(value);
  if (
    !selection ||
    !exactKeys(selection, ["sheetIndex", "sheetName", "grid", "page"]) ||
    !Number.isSafeInteger(selection.sheetIndex) ||
    typeof selection.sheetName !== "string"
  )
    return null;
  const descriptor = metadata.sheets[selection.sheetIndex as number];
  if (!descriptor || descriptor.name !== selection.sheetName) return null;
  const rawGrid = objectValue(selection.grid);
  if (
    !rawGrid ||
    !Array.isArray(rawGrid.merges) ||
    rawGrid.merges.length > MAX_LOCAL_MERGES
  )
    return null;
  const grid = parseWorkspaceSheetGrid(selection.grid);
  if (
    !grid ||
    grid.sheetId !== `local:${descriptor.index}` ||
    grid.title !== descriptor.name ||
    grid.rowCount > MAX_LOCAL_ROWS ||
    grid.lastUsedColumn >= MAX_LOCAL_COLUMNS
  )
    return null;
  const page = parseLocalSheetPage(selection.page, grid);
  return page
    ? {
        sheetIndex: descriptor.index,
        sheetName: descriptor.name,
        grid,
        page,
      }
    : null;
}

function translationSource(cell: WorkspaceSheetCell) {
  return cell.kind === "formula" ? cell.display : cell.source;
}

function defaultWorkerFactory(): LocalSpreadsheetWorkerLike {
  return new Worker(new URL("./local-spreadsheet.worker.ts", import.meta.url), {
    type: "module",
  });
}

function defaultPortFactory(): DriveOfficePortLike {
  return browser.runtime.connect({
    name: GOOGLE_DRIVE_OFFICE_PORT_NAME,
  }) as unknown as DriveOfficePortLike;
}

export default function LocalSpreadsheetReader({
  workerFactory = defaultWorkerFactory,
  portFactory = defaultPortFactory,
  source = { kind: "local-file" },
  onExitDriveOffice,
  awaitingStart = false,
  sourceTitle,
  translateIntent,
  managedSourceLifecycle = false,
}: LocalSpreadsheetReaderProps = {}) {
  const driveOffice = source.kind === "drive-office";
  const t = useMessages(readerMessages);
  const targetOptions = useMemo<readonly SelectOption[]>(
    () =>
      TARGET_LANGUAGES.map(({ code }) => ({
        value: code,
        label: t.t(languageKey(code)),
      })),
    [t],
  );
  const [waitingForStart, setWaitingForStart] = useState(awaitingStart);
  const preferenceEdits = useRef(new Set<"targetLanguage">());
  const autoTranslateAfterLoad = useRef(false);
  const intentEpoch = useRef(0);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [state, setState] = useState<ReaderState>(() => ({
    ...initialState,
    status: driveOffice
      ? "reader.status.discoveringDrive"
      : initialState.status,
  }));
  const [translationState, setTranslationState] =
    useState<SpreadsheetTranslationState>(
      INITIAL_SPREADSHEET_TRANSLATION_STATE,
    );
  const [visibleRecordIds, setVisibleRecordIds] = useState<readonly string[]>(
    [],
  );
  const translationStateRef = useRef(translationState);
  const transitionTranslation = useCallback(
    (event: SpreadsheetTranslationEvent) => {
      const next = transitionSpreadsheetTranslation(
        translationStateRef.current,
        event,
      );
      if (next !== translationStateRef.current) {
        translationStateRef.current = next;
        setTranslationState(next);
      }
      return next;
    },
    [],
  );
  const stateRef = useRef(state);
  useEffect(() => {
    let cancelled = false;
    void readReaderPreferences()
      .then((preferences) => {
        if (cancelled) return;
        setState((current) => ({
          ...current,
          targetLanguage: preferenceEdits.current.has("targetLanguage")
            ? current.targetLanguage
            : preferences.targetLanguage,
        }));
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setPreferencesReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useLayoutEffect(() => {
    stateRef.current = state;
  }, [state]);
  const worker = useRef<LocalSpreadsheetWorkerLike | undefined>(undefined);
  const workerListener = useRef<
    ((event: MessageEvent<unknown>) => void) | undefined
  >(undefined);
  const workerSession = useRef(0);
  const workerRequestId = useRef(0);
  const workerOwners = useRef(new Map<string, WorkerOwner>());
  const pendingPages = useRef(new Set<number>());
  const parseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const readerInstanceId = useRef(globalThis.crypto.randomUUID());
  const translationRequestId = useRef(0);
  const translationEpoch = useRef(0);
  const translationPending = useRef(false);
  const translationOwner = useRef<
    | { readerInstanceId: string; requestId: number; generation: number }
    | undefined
  >(undefined);
  const attempted = useRef(new Set<string>());
  const retryRecordIds = useRef<Set<string> | undefined>(undefined);
  const viewportRecordIds = useRef<string[]>([]);
  const drainTranslation = useRef<() => void>(() => undefined);
  const boundDriveFileId = useRef<string | undefined>(undefined);
  const openingReaderTab = useRef(false);
  const driveRequestId = useRef(0);
  const [driveRefreshId, setDriveRefreshId] = useState(0);
  const restoreSheetName = useRef<string | undefined>(undefined);
  const driveDownload = useRef<
    | {
        assembler: GoogleDriveOfficeDownloadAssembler;
        port: DriveOfficePortLike;
        request: GoogleDriveOfficeStartRequest;
        onMessage: (message: unknown) => void;
        onDisconnect: () => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined
  >(undefined);

  const stopDriveDownload = useCallback((sendCancel = true) => {
    const active = driveDownload.current;
    if (!active) return;
    driveDownload.current = undefined;
    clearTimeout(active.timer);
    active.port.onMessage.removeListener(active.onMessage);
    active.port.onDisconnect.removeListener(active.onDisconnect);
    if (sendCancel && !active.assembler.terminal) {
      try {
        active.port.postMessage({
          ...active.request,
          type: "GOOGLE_DRIVE_OFFICE_CANCEL",
        });
      } catch {
        // The background may already have closed the port.
      }
    }
    active.assembler.abort();
    try {
      active.port.disconnect();
    } catch {
      // The port is already disconnected.
    }
  }, []);

  const stopWorker = useCallback(() => {
    if (parseTimer.current !== undefined) clearTimeout(parseTimer.current);
    parseTimer.current = undefined;
    workerSession.current += 1;
    workerOwners.current.clear();
    pendingPages.current.clear();
    if (worker.current && workerListener.current)
      worker.current.removeEventListener("message", workerListener.current);
    worker.current?.terminate();
    worker.current = undefined;
    workerListener.current = undefined;
  }, []);

  const resetTranslation = useCallback(
    (event: SpreadsheetTranslationEvent = { type: "source-change" }) => {
      translationEpoch.current += 1;
      attempted.current.clear();
      retryRecordIds.current = undefined;
      transitionTranslation(event);
    },
    [transitionTranslation],
  );

  const failWorkerResponse = useCallback(
    (message: ReaderMessage = localErrors["invalid-request"]) => {
      stopWorker();
      resetTranslation();
      setState((current) => ({
        ...current,
        metadata: undefined,
        selection: undefined,
        pages: new Map(),
        translations: new Map(),
        unresolved: new Set(),
        oversized: new Set(),
        pending: undefined,
        status: undefined,
        error: message,
      }));
    },
    [resetTranslation, stopWorker],
  );

  const requestSheet = useCallback(
    (sheetIndex: number) => {
      if (!worker.current) return;
      viewportRecordIds.current = [];
      setVisibleRecordIds([]);
      pendingPages.current.clear();
      workerSession.current += 1;
      workerOwners.current.clear();
      const requestId = `sheet:${++workerRequestId.current}`;
      workerOwners.current.set(requestId, {
        kind: "select-sheet",
        session: workerSession.current,
        sheetIndex,
      });
      if (parseTimer.current !== undefined) clearTimeout(parseTimer.current);
      parseTimer.current = setTimeout(() => {
        const owner = workerOwners.current.get(requestId);
        if (!owner || owner.session !== workerSession.current) return;
        failWorkerResponse("reader.error.sheetTimeout");
      }, PARSE_TIMEOUT_MS);
      setState((state) => ({
        ...state,
        pages: new Map(),
        translations: new Map(),
        unresolved: new Set(),
        oversized: new Set(),
        pending: "sheet",
        status: "reader.phase.loadingSheet",
        error: undefined,
      }));
      worker.current.postMessage({
        type: "select-sheet",
        requestId,
        sheetIndex,
      });
    },
    [failWorkerResponse],
  );

  const handleWorkerMessage = useCallback(
    (event: MessageEvent<unknown>) => {
      const response = objectValue(event.data);
      if (!response || typeof response.requestId !== "string") return;
      const owner = workerOwners.current.get(response.requestId);
      if (!owner || owner.session !== workerSession.current) return;
      workerOwners.current.delete(response.requestId);
      if (owner.kind === "parse" || owner.kind === "select-sheet") {
        if (parseTimer.current !== undefined) clearTimeout(parseTimer.current);
        parseTimer.current = undefined;
      }
      if (owner.kind === "load-page" && owner.startRow !== undefined)
        pendingPages.current.delete(owner.startRow);

      if (response.type === "error") {
        if (
          !exactKeys(response, ["type", "requestId", "error"]) ||
          !Object.hasOwn(localErrors, response.error as PropertyKey)
        ) {
          failWorkerResponse();
          return;
        }
        const message =
          localErrors[response.error as LocalSpreadsheetErrorCode];
        if (owner.kind === "parse") failWorkerResponse(message);
        else
          setState((current) => ({
            ...current,
            pending: undefined,
            status: undefined,
            error: message,
          }));
        return;
      }

      if (owner.kind === "parse") {
        if (
          !exactKeys(response, ["type", "requestId", "metadata", "sheet"]) ||
          response.type !== "parsed"
        ) {
          failWorkerResponse();
          return;
        }
        const metadata = parseMetadata(response.metadata);
        const selection = metadata
          ? parseSelection(response.sheet, metadata)
          : null;
        if (!metadata || metadata.fileName !== owner.fileName || !selection) {
          failWorkerResponse();
          return;
        }
        const wanted = restoreSheetName.current;
        restoreSheetName.current = undefined;
        const restoreIndex =
          wanted !== undefined && wanted !== selection.sheetName
            ? metadata.sheets.find((sheet) => sheet.name === wanted)?.index
            : undefined;
        if (restoreIndex !== undefined) {
          setState((current) => ({
            ...current,
            metadata,
            selection,
            pages: new Map(),
            translations: new Map(),
            unresolved: new Set(),
            oversized: new Set(),
            presentation: "translation",
            pending: "sheet",
            error: undefined,
            driveError: undefined,
            status: "reader.phase.loadingSheet",
          }));
          requestSheet(restoreIndex);
          return;
        }
        setState((current) => ({
          ...current,
          metadata,
          selection,
          pages: new Map([[selection.page.startRow, selection.page]]),
          translations: new Map(),
          unresolved: new Set(),
          oversized: new Set(),
          presentation: "translation",
          pending: undefined,
          error: undefined,
          driveError: undefined,
          status: {
            key: driveOffice
              ? "reader.status.loadedDrive"
              : "reader.status.loadedLocal",
            params: { sheet: selection.sheetName },
          },
        }));
        return;
      }

      const current = stateRef.current;
      if (!current.metadata || !current.selection) return;
      if (owner.kind === "select-sheet") {
        if (
          !exactKeys(response, ["type", "requestId", "sheet"]) ||
          response.type !== "sheet"
        ) {
          failWorkerResponse();
          return;
        }
        const selection = parseSelection(response.sheet, current.metadata);
        if (!selection || selection.sheetIndex !== owner.sheetIndex) {
          failWorkerResponse();
          return;
        }
        setState((value) => ({
          ...value,
          selection,
          pages: new Map([[selection.page.startRow, selection.page]]),
          translations: new Map(),
          unresolved: new Set(),
          oversized: new Set(),
          presentation: "translation",
          pending: undefined,
          error: undefined,
          status: {
            key: driveOffice
              ? "reader.status.loadedDrive"
              : "reader.status.loadedLocal",
            params: { sheet: selection.sheetName },
          },
        }));
        if (translationActive(translationStateRef.current))
          queueMicrotask(() => drainTranslation.current());
        return;
      }
      if (
        owner.kind !== "load-page" ||
        response.type !== "page" ||
        !exactKeys(response, ["type", "requestId", "page"])
      ) {
        failWorkerResponse();
        return;
      }
      const page = parseLocalSheetPage(response.page, current.selection.grid);
      if (
        !page ||
        page.startRow !== owner.startRow ||
        page.generation !== current.selection.grid.generation
      ) {
        failWorkerResponse();
        return;
      }
      setState((value) => {
        if (value.selection?.grid.generation !== page.generation) return value;
        const pages = new Map(value.pages);
        pages.set(page.startRow, page);
        return { ...value, pages, error: undefined };
      });
    },
    [driveOffice, failWorkerResponse, requestSheet],
  );

  const parseBytes = useCallback(
    (fileName: string, bytes: ArrayBuffer, session: number) => {
      if (session !== workerSession.current) return;
      const instance = workerFactory();
      worker.current = instance;
      workerListener.current = handleWorkerMessage;
      instance.addEventListener("message", handleWorkerMessage);
      const requestId = `parse:${++workerRequestId.current}`;
      workerOwners.current.set(requestId, {
        kind: "parse",
        session,
        fileName,
      });
      parseTimer.current = setTimeout(() => {
        const owner = workerOwners.current.get(requestId);
        if (!owner || owner.session !== workerSession.current) return;
        failWorkerResponse("reader.error.parseTimeout");
      }, PARSE_TIMEOUT_MS);
      setState((current) => ({
        ...current,
        pending: "file",
        status: driveOffice ? "reader.status.discoveringDrive" : current.status,
        error: undefined,
        driveError: undefined,
      }));
      instance.postMessage({ type: "parse", requestId, fileName, bytes }, [
        bytes,
      ]);
    },
    [driveOffice, failWorkerResponse, handleWorkerMessage, workerFactory],
  );

  useEffect(() => {
    if (source.kind !== "drive-office" || waitingForStart) return;

    stopDriveDownload();
    stopWorker();
    resetTranslation();
    viewportRecordIds.current = [];
    readerInstanceId.current = globalThis.crypto.randomUUID();
    const session = workerSession.current;
    boundDriveFileId.current = undefined;
    const contextRequest = {
      type: "WORKSPACE_READER_CONTEXT",
      readerInstanceId: readerInstanceId.current,
      requestId: ++driveRequestId.current,
      sourceTabId: source.sourceTabId,
    } satisfies WorkspaceReaderRequest;
    let cancelled = false;
    const failHandshake = (error: GoogleDriveOfficeErrorCode) => {
      if (cancelled || session !== workerSession.current) return;
      setState((current) => ({
        ...current,
        pending: undefined,
        status: undefined,
        error: driveOfficeErrors[error],
        driveError: error,
      }));
    };
    const handshakeTimer = setTimeout(() => {
      failHandshake("reader-channel-unavailable");
      cancelled = true;
    }, DRIVE_DOWNLOAD_TIMEOUT_MS);
    queueMicrotask(() => {
      if (cancelled || session !== workerSession.current) return;
      setState((current) => ({
        ...current,
        metadata: undefined,
        selection: undefined,
        pages: new Map(),
        translations: new Map(),
        unresolved: new Set(),
        oversized: new Set(),
        pending: "file",
        status: "reader.status.discoveringDrive",
        error: undefined,
        driveError: undefined,
      }));
    });
    void (async () => {
      let response: Record<string, unknown> | null;
      try {
        response = objectValue(
          await browser.runtime.sendMessage(contextRequest),
        );
      } catch {
        clearTimeout(handshakeTimer);
        failHandshake("reader-channel-unavailable");
        return;
      }
      clearTimeout(handshakeTimer);
      if (cancelled || session !== workerSession.current) return;
      if (
        !response ||
        response.type !== contextRequest.type ||
        response.readerInstanceId !== contextRequest.readerInstanceId ||
        response.requestId !== contextRequest.requestId
      ) {
        failHandshake("reader-channel-unavailable");
        return;
      }
      if (response.ok === false) {
        const error = response.error;
        failHandshake(
          exactKeys(response, [
            "type",
            "readerInstanceId",
            "requestId",
            "ok",
            "error",
          ]) &&
            typeof error === "string" &&
            Object.hasOwn(driveOfficeErrors, error)
            ? (error as GoogleDriveOfficeErrorCode)
            : "reader-channel-unavailable",
        );
        return;
      }
      const version = parseWorkspaceSourceVersion(response.version);
      const context = objectValue(response.context);
      const optionalKeys = ["sourceKind", "sourceTitle"].filter((key) =>
        Object.hasOwn(response!, key),
      );
      if (
        !exactKeys(response, [
          "type",
          "readerInstanceId",
          "requestId",
          "version",
          "ok",
          "configured",
          "connected",
          "context",
          "targetLanguage",
          ...optionalKeys,
        ]) ||
        response.ok !== true ||
        response.configured !== true ||
        response.connected !== true ||
        !version ||
        !context ||
        !exactKeys(context, ["sourceTabId", "kind", "fileId", "activeId"]) ||
        context.sourceTabId !== source.sourceTabId ||
        context.kind !== "sheets" ||
        typeof context.fileId !== "string" ||
        !context.fileId ||
        !(context.activeId === null || typeof context.activeId === "string") ||
        !TARGET_LANGUAGES.some(
          ({ code }) => code === response.targetLanguage,
        ) ||
        (response.sourceKind !== undefined &&
          response.sourceKind !== "office") ||
        (response.sourceTitle !== undefined &&
          (typeof response.sourceTitle !== "string" ||
            response.sourceTitle.length > 255))
      ) {
        failHandshake("reader-channel-unavailable");
        return;
      }
      const expectedFileId = source.fileId ?? boundDriveFileId.current;
      if (expectedFileId && context.fileId !== expectedFileId) {
        failHandshake("source-tab-changed");
        return;
      }
      const renewedWorker =
        version.backgroundEpoch !== source.version.backgroundEpoch;
      if (
        (!renewedWorker &&
          version.sourceRevision !== source.version.sourceRevision) ||
        (renewedWorker && !expectedFileId)
      ) {
        failHandshake("source-tab-changed");
        return;
      }
      boundDriveFileId.current = context.fileId;
      const request: GoogleDriveOfficeStartRequest = {
        type: "GOOGLE_DRIVE_OFFICE_START",
        readerInstanceId: readerInstanceId.current,
        requestId: ++driveRequestId.current,
        sourceTabId: source.sourceTabId,
        version,
      };
      const assembler = new GoogleDriveOfficeDownloadAssembler(request);
      let port: DriveOfficePortLike;
      try {
        port = portFactory();
      } catch {
        queueMicrotask(() => {
          if (cancelled || session !== workerSession.current) return;
          setState((current) => ({
            ...current,
            metadata: undefined,
            selection: undefined,
            pages: new Map(),
            translations: new Map(),
            unresolved: new Set(),
            oversized: new Set(),
            pending: undefined,
            status: undefined,
            error: driveOfficeErrors["reader-channel-unavailable"],
            driveError: "reader-channel-unavailable",
          }));
        });
        return;
      }

      const failDownload = (error: GoogleDriveOfficeErrorCode) => {
        const active = driveDownload.current;
        if (
          cancelled ||
          session !== workerSession.current ||
          !active ||
          active.request.requestId !== request.requestId
        )
          return;
        stopDriveDownload(error === "invalid-response");
        stopWorker();
        resetTranslation();
        viewportRecordIds.current = [];
        setVisibleRecordIds([]);
        setState((current) => ({
          ...current,
          metadata: undefined,
          selection: undefined,
          pages: new Map(),
          translations: new Map(),
          unresolved: new Set(),
          oversized: new Set(),
          pending: undefined,
          status: undefined,
          error: driveOfficeErrors[error],
          driveError: error,
        }));
      };
      const onMessage = (message: unknown) => {
        if (cancelled || session !== workerSession.current) return;
        try {
          const outcome = assembler.accept(message);
          if (outcome.status === "pending") {
            setState((current) => ({
              ...current,
              status: "reader.status.discoveringDrive",
            }));
            return;
          }
          if (outcome.status === "error") {
            failDownload(outcome.error);
            return;
          }
          stopDriveDownload(false);
          parseBytes(outcome.metadata.fileName, outcome.bytes, session);
        } catch (error) {
          failDownload(
            error instanceof GoogleDriveOfficeProtocolError
              ? "invalid-response"
              : "reader-channel-unavailable",
          );
        }
      };
      const onDisconnect = () => failDownload("reader-channel-unavailable");
      const timer = setTimeout(
        () => failDownload("download-timeout"),
        DRIVE_DOWNLOAD_TIMEOUT_MS,
      );
      driveDownload.current = {
        assembler,
        port,
        request,
        onMessage,
        onDisconnect,
        timer,
      };
      port.onMessage.addListener(onMessage);
      port.onDisconnect.addListener(onDisconnect);
      queueMicrotask(() => {
        if (
          cancelled ||
          driveDownload.current?.request.requestId !== request.requestId
        )
          return;
        setState((current) => ({
          ...current,
          metadata: undefined,
          selection: undefined,
          pages: new Map(),
          translations: new Map(),
          unresolved: new Set(),
          oversized: new Set(),
          pending: "file",
          status: "reader.status.discoveringDrive",
          error: undefined,
          driveError: undefined,
        }));
      });
      try {
        port.postMessage(request);
      } catch {
        failDownload("reader-channel-unavailable");
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(handshakeTimer);
      if (
        driveDownload.current?.request.readerInstanceId ===
        contextRequest.readerInstanceId
      )
        stopDriveDownload();
    };
  }, [
    driveRefreshId,
    parseBytes,
    portFactory,
    resetTranslation,
    source,
    stopDriveDownload,
    stopWorker,
    waitingForStart,
  ]);

  useEffect(
    () => () => {
      translationEpoch.current += 1;
      stopDriveDownload();
      stopWorker();
    },
    [stopDriveDownload, stopWorker],
  );

  useEffect(() => {
    const onAuthChanged = (message: unknown) => {
      if ((message as { type?: string })?.type !== "AUTH_STATE_CHANGED") return;
      intentEpoch.current += 1;
      autoTranslateAfterLoad.current = false;
      stopDriveDownload();
      stopWorker();
      resetTranslation();
      viewportRecordIds.current = [];
      setVisibleRecordIds([]);
      setState((current) => ({
        ...initialState,
        targetLanguage: current.targetLanguage,
        status: undefined,
        error: "reader.error.sessionChanged",
      }));
    };
    browser.runtime.onMessage.addListener(onAuthChanged);
    return () => browser.runtime.onMessage.removeListener(onAuthChanged);
  }, [resetTranslation, stopDriveDownload, stopWorker]);

  const openFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      stopWorker();
      const openSession = workerSession.current;
      resetTranslation();
      viewportRecordIds.current = [];
      setVisibleRecordIds([]);
      if (!supportedFileName.test(file.name)) {
        setState((current) => ({
          ...current,
          metadata: undefined,
          selection: undefined,
          pages: new Map(),
          translations: new Map(),
          unresolved: new Set(),
          oversized: new Set(),
          pending: undefined,
          status: undefined,
          error: localErrors["unsupported-file-type"],
        }));
        return;
      }
      if (file.size > MAX_LOCAL_FILE_BYTES) {
        setState((current) => ({
          ...current,
          metadata: undefined,
          selection: undefined,
          pages: new Map(),
          translations: new Map(),
          unresolved: new Set(),
          oversized: new Set(),
          pending: undefined,
          status: undefined,
          error: localErrors["file-too-large"],
        }));
        return;
      }
      setState((current) => ({
        ...current,
        metadata: undefined,
        selection: undefined,
        pages: new Map(),
        translations: new Map(),
        unresolved: new Set(),
        oversized: new Set(),
        pending: "file",
        status: {
          key: "reader.status.readingFile",
          params: { name: file.name },
        },
        error: undefined,
      }));
      let bytes: ArrayBuffer;
      try {
        bytes = await file.arrayBuffer();
      } catch {
        if (openSession !== workerSession.current) return;
        failWorkerResponse("reader.error.readFailed");
        return;
      }
      if (openSession !== workerSession.current) return;
      readerInstanceId.current = globalThis.crypto.randomUUID();
      parseBytes(file.name, bytes, openSession);
    },
    [failWorkerResponse, parseBytes, resetTranslation, stopWorker],
  );

  const selectSheet = useCallback(
    (value: string) => {
      const sheetIndex = Number(value);
      const current = stateRef.current;
      if (
        !worker.current ||
        !current.metadata?.sheets[sheetIndex] ||
        current.pending
      )
        return;
      resetTranslation({ type: "reader-sheet-change" });
      requestSheet(sheetIndex);
    },
    [requestSheet, resetTranslation],
  );

  const loadPage = useCallback((requestedStart?: number) => {
    const current = stateRef.current;
    const grid = current.selection?.grid;
    if (
      !worker.current ||
      !grid ||
      current.pending === "file" ||
      current.pending === "sheet"
    )
      return;
    const pages = [...current.pages.values()];
    const startRow =
      requestedStart ??
      pages
        .map((page) => page.cursor?.nextRow)
        .filter((value): value is number => value !== undefined)
        .sort((left, right) => left - right)[0];
    if (
      startRow === undefined ||
      startRow < 0 ||
      startRow >= grid.rowCount ||
      startRow % 100 !== 0 ||
      current.pages.has(startRow) ||
      pendingPages.current.has(startRow)
    )
      return;
    pendingPages.current.add(startRow);
    const requestId = `page:${++workerRequestId.current}`;
    workerOwners.current.set(requestId, {
      kind: "load-page",
      session: workerSession.current,
      startRow,
    });
    worker.current.postMessage({ type: "load-page", requestId, startRow });
  }, []);

  const recordsById = useMemo(() => {
    const records = new Map<string, WorkspaceSheetCell>();
    for (const page of state.pages.values())
      for (const row of page.rows)
        for (const cell of row.cells) records.set(cell.id, cell);
    return records;
  }, [state.pages]);
  const recordsRef = useRef(recordsById);
  useLayoutEffect(() => {
    recordsRef.current = recordsById;
  }, [recordsById]);

  const displayedTranslations = useMemo(
    () =>
      new Map(
        [...state.translations].map(([id, accepted]) => [id, accepted.text]),
      ),
    [state.translations],
  );

  /** Re-establishes the background binding for the already-bound Drive file. */
  const rebindDriveOffice = useCallback(async (): Promise<boolean> => {
    if (source.kind !== "drive-office") return false;
    const fileId = source.fileId ?? boundDriveFileId.current;
    if (!fileId) return false;
    const request = {
      type: "WORKSPACE_READER_CONTEXT",
      readerInstanceId: readerInstanceId.current,
      requestId: ++driveRequestId.current,
      sourceTabId: source.sourceTabId,
    } satisfies WorkspaceReaderRequest;
    try {
      const response = objectValue(await browser.runtime.sendMessage(request));
      const context = objectValue(response?.context);
      return (
        response?.type === request.type &&
        response.readerInstanceId === request.readerInstanceId &&
        response.requestId === request.requestId &&
        response.ok === true &&
        response.connected === true &&
        context?.sourceTabId === source.sourceTabId &&
        context.fileId === fileId
      );
    } catch {
      return false;
    }
  }, [source]);

  const performTranslation = useCallback(async () => {
    if (
      !translationActive(translationStateRef.current) ||
      translationPending.current
    )
      return;
    const current = stateRef.current;
    const selection = current.selection;
    if (!selection) return;
    const candidates: WorkspaceSheetCell[] = [];
    const unresolvedIds = new Set(current.unresolved);
    const oversizedIds = new Set(current.oversized);
    let units = 0;
    for (const id of retryRecordIds.current ?? viewportRecordIds.current) {
      const cell = recordsRef.current.get(id);
      if (
        !cell?.translatable ||
        current.translations.get(id)?.sourceHash === cell.sourceHash ||
        attempted.current.has(id)
      )
        continue;
      const text = translationSource(cell);
      if (!text) {
        attempted.current.add(id);
        continue;
      }
      if (text.length > MAX_LOCAL_TRANSLATION_RECORD_UNITS) {
        attempted.current.add(id);
        unresolvedIds.add(id);
        oversizedIds.add(id);
        continue;
      }
      if (
        candidates.length >= MAX_LOCAL_TRANSLATION_RECORDS ||
        units + text.length > MAX_LOCAL_TRANSLATION_MESSAGE_UNITS
      )
        break;
      candidates.push(cell);
      units += text.length;
    }
    if (
      unresolvedIds.size !== current.unresolved.size ||
      oversizedIds.size !== current.oversized.size
    ) {
      stateRef.current = {
        ...stateRef.current,
        unresolved: unresolvedIds,
        oversized: oversizedIds,
      };
      setState((value) => ({
        ...value,
        unresolved: unresolvedIds,
        oversized: oversizedIds,
      }));
    }
    if (!candidates.length) {
      retryRecordIds.current = undefined;
      transitionTranslation(
        unresolvedIds.size ? { type: "partial" } : { type: "empty-visible" },
      );
      setState((value) =>
        value.pending === "translate"
          ? { ...value, pending: undefined, status: undefined }
          : value,
      );
      return;
    }
    const epoch = translationEpoch.current;
    let requestId = ++translationRequestId.current;
    const generation = selection.grid.generation;
    const expected = new Map(
      candidates.map((cell) => [cell.id, cell.sourceHash]),
    );
    candidates.forEach((cell) => attempted.current.add(cell.id));
    const request: LocalSpreadsheetTranslateRequest = {
      type: "LOCAL_SPREADSHEET_TRANSLATE",
      readerInstanceId: readerInstanceId.current,
      requestId,
      generation,
      targetLanguage: current.targetLanguage,
      records: candidates.map((cell) => ({
        id: cell.id,
        sourceHash: cell.sourceHash,
        text: translationSource(cell),
      })),
    };
    translationPending.current = true;
    translationOwner.current = {
      readerInstanceId: request.readerInstanceId,
      requestId,
      generation,
    };
    setState((value) => ({
      ...value,
      pending: "translate",
      status: {
        key: "reader.status.translatingCells",
        params: { count: candidates.length },
      },
      error: undefined,
      driveError: undefined,
    }));
    const sendOnce = async (
      message: LocalSpreadsheetTranslateRequest,
    ): Promise<unknown> => {
      // A UI deadline is not provider cancellation. Keep the physical slot
      // occupied until sendMessage settles; Stop only retires this result owner.
      const watchdog = setTimeout(() => {
        if (epoch !== translationEpoch.current) return;
        setState((value) => ({
          ...value,
          status: "reader.status.slow",
        }));
      }, TRANSLATION_TIMEOUT_MS);
      try {
        return await browser.runtime.sendMessage(message);
      } catch {
        return null;
      } finally {
        clearTimeout(watchdog);
      }
    };
    let raw: unknown = await sendOnce(request);
    // An MV3 worker restart (or a lost port) drops the background's
    // per-document binding. Rebind once through a fresh Context handshake for
    // the same Drive file, then retry the same batch before surfacing an error.
    const channelLost =
      raw === null ||
      (parseLocalSpreadsheetTranslateResponse(raw)?.ok === false &&
        (parseLocalSpreadsheetTranslateResponse(raw) as { error?: string })
          .error === "reader-channel-unavailable");
    if (
      channelLost &&
      epoch === translationEpoch.current &&
      (await rebindDriveOffice())
    ) {
      requestId = ++translationRequestId.current;
      const retry = { ...request, requestId };
      translationOwner.current = {
        readerInstanceId: retry.readerInstanceId,
        requestId,
        generation,
      };
      raw = await sendOnce(retry);
    }
    translationPending.current = false;
    if (translationOwner.current?.requestId === requestId)
      translationOwner.current = undefined;
    if (epoch !== translationEpoch.current) {
      expected.forEach((_hash, id) => attempted.current.delete(id));
      if (translationActive(translationStateRef.current))
        drainTranslation.current();
      return;
    }
    const response = parseLocalSpreadsheetTranslateResponse(raw);
    if (
      !response ||
      response.readerInstanceId !== request.readerInstanceId ||
      response.requestId !== requestId ||
      response.generation !== generation
    ) {
      expected.forEach((_hash, id) => attempted.current.delete(id));
      retryRecordIds.current = undefined;
      transitionTranslation({ type: "error" });
      setState((value) => ({
        ...value,
        pending: undefined,
        status: undefined,
        error: "reader.error.invalidTranslation",
      }));
      return;
    }
    if (!response.ok) {
      expected.forEach((_hash, id) => attempted.current.delete(id));
      retryRecordIds.current = undefined;
      transitionTranslation({ type: "error" });
      setState((value) => ({
        ...value,
        pending: undefined,
        status: undefined,
        driveError:
          response.error === "reader-channel-unavailable"
            ? response.error
            : value.driveError,
        error:
          response.error === "reader-channel-unavailable"
            ? driveOfficeErrors[response.error]
            : response.error === "auth-required"
              ? "reader.error.authRequired"
              : response.error === "auth-unavailable"
                ? "reader.error.authUnavailable"
                : "reader.error.translateFailed",
      }));
      return;
    }
    if (
      response.results.length !== expected.size ||
      response.results.some(
        (result) => expected.get(result.id) !== result.sourceHash,
      )
    ) {
      expected.forEach((_hash, id) => attempted.current.delete(id));
      retryRecordIds.current = undefined;
      transitionTranslation({ type: "error" });
      setState((value) => ({
        ...value,
        pending: undefined,
        status: undefined,
        error: "reader.error.staleTranslation",
      }));
      return;
    }
    const translated = response.results.filter(
      (result) => "text" in result,
    ).length;
    const translations = new Map(stateRef.current.translations);
    const settledUnresolvedIds = new Set(stateRef.current.unresolved);
    const settledOversizedIds = new Set(stateRef.current.oversized);
    for (const result of response.results) {
      if ("text" in result) {
        translations.set(result.id, {
          sourceHash: result.sourceHash,
          text: result.text,
        });
        settledUnresolvedIds.delete(result.id);
        settledOversizedIds.delete(result.id);
      } else settledUnresolvedIds.add(result.id);
    }
    const hasMore = [
      ...(retryRecordIds.current ?? viewportRecordIds.current),
    ].some((id) => {
      const cell = recordsRef.current.get(id);
      return Boolean(
        cell?.translatable &&
        translations.get(id)?.sourceHash !== cell.sourceHash &&
        !attempted.current.has(id),
      );
    });
    stateRef.current = {
      ...stateRef.current,
      translations,
      unresolved: settledUnresolvedIds,
      oversized: settledOversizedIds,
      pending: undefined,
      error: undefined,
    };
    setState((value) => {
      if (value.selection?.grid.generation !== generation) return value;
      return {
        ...value,
        translations,
        unresolved: settledUnresolvedIds,
        oversized: settledOversizedIds,
        pending: undefined,
        error: undefined,
        status: translated
          ? { key: "reader.status.completed", params: { count: translated } }
          : undefined,
      };
    });
    if (hasMore && translationActive(translationStateRef.current)) {
      queueMicrotask(() => drainTranslation.current());
      return;
    }
    retryRecordIds.current = undefined;
    transitionTranslation(
      settledUnresolvedIds.size ? { type: "partial" } : { type: "completion" },
    );
  }, [rebindDriveOffice, transitionTranslation]);
  // Child grid effects publish viewport IDs after layout. Install the drain
  // before those effects so a worksheet remount cannot hit the cleanup noop.
  useLayoutEffect(() => {
    drainTranslation.current = () => void performTranslation();
    return () => {
      drainTranslation.current = () => undefined;
    };
  }, [performTranslation]);

  const startTranslation = useCallback(() => {
    if (waitingForStart && source.kind === "drive-office") {
      autoTranslateAfterLoad.current = true;
      setWaitingForStart(false);
      return;
    }
    const selection = stateRef.current.selection;
    if (!selection) return;
    const phase = translationStateRef.current.phase;
    if (translationActive(translationStateRef.current) || phase === "watching")
      return;
    if (phase === "partial") {
      // Retry visible failures and also cover records that scrolled into view
      // after the failure and were never attempted: one failed cell must not
      // lock the button until a refresh.
      const retryIds = new Set(
        viewportRecordIds.current.filter((id) => {
          const state = stateRef.current;
          if (state.unresolved.has(id)) return !state.oversized.has(id);
          const cell = recordsRef.current.get(id);
          return Boolean(
            cell?.translatable &&
            state.translations.get(id)?.sourceHash !== cell.sourceHash &&
            !attempted.current.has(id),
          );
        }),
      );
      if (!retryIds.size) return;
      retryRecordIds.current = retryIds;
      retryIds.forEach((id) => attempted.current.delete(id));
    } else if (phase === "error") {
      retryRecordIds.current = undefined;
      attempted.current.clear();
    }
    const next = transitionTranslation(
      phase === "paused"
        ? { type: "resume" }
        : phase === "partial" || phase === "error"
          ? { type: "retry" }
          : { type: "start" },
    );
    if (!translationActive(next)) return;
    const queued = translationPending.current;
    setState((current) => ({
      ...current,
      presentation: "translation",
      pending: queued ? "translate" : current.pending,
      status: queued ? "reader.status.queued" : current.status,
      error: undefined,
    }));
    if (!queued) void performTranslation();
  }, [performTranslation, source.kind, transitionTranslation, waitingForStart]);

  useEffect(() => {
    if (
      !autoTranslateAfterLoad.current ||
      !preferencesReady ||
      !state.selection ||
      state.pending ||
      !visibleRecordIds.length
    )
      return;
    autoTranslateAfterLoad.current = false;
    startTranslation();
  }, [
    preferencesReady,
    startTranslation,
    state.pending,
    state.selection,
    visibleRecordIds,
  ]);

  useEffect(() => {
    if (source.kind !== "drive-office") return;
    let cancelled = false;
    const acceptIntent = async (claimed?: WorkspaceReaderIntent) => {
      const epoch = intentEpoch.current;
      const intent =
        claimed ??
        (await takeReaderIntent(source.sourceTabId).catch(() => undefined));
      if (
        !intent ||
        cancelled ||
        epoch !== intentEpoch.current ||
        !(await readerIntentIsCurrent(intent).catch(() => false)) ||
        cancelled ||
        epoch !== intentEpoch.current
      )
        return;
      preferenceEdits.current.add("targetLanguage");
      autoTranslateAfterLoad.current = true;
      setWaitingForStart(false);
      resetTranslation();
      setState((current) => ({
        ...current,
        targetLanguage: intent.targetLanguage,
        translations: new Map(),
        unresolved: new Set(),
        oversized: new Set(),
        error: undefined,
      }));
      void saveReaderPreferences({
        targetLanguage: intent.targetLanguage,
      }).catch(() => undefined);
    };
    void acceptIntent(translateIntent);
    const onStorageChanged = (
      changes: Record<string, unknown>,
      area: string,
    ) => {
      if (
        area === "session" &&
        Object.hasOwn(changes, `workspaceReaderIntent:${source.sourceTabId}`)
      )
        void acceptIntent();
    };
    browser.storage?.onChanged.addListener(onStorageChanged);
    return () => {
      cancelled = true;
      browser.storage?.onChanged.removeListener(onStorageChanged);
    };
  }, [resetTranslation, source, translateIntent]);

  const stopTranslation = useCallback(() => {
    autoTranslateAfterLoad.current = false;
    intentEpoch.current += 1;
    translationEpoch.current += 1;
    retryRecordIds.current = undefined;
    transitionTranslation({ type: "stop" });
    setState((current) => ({
      ...current,
      pending: current.pending === "translate" ? undefined : current.pending,
      status: undefined,
    }));
  }, [transitionTranslation]);

  const clearView = useCallback(() => {
    stopDriveDownload();
    stopWorker();
    resetTranslation();
    viewportRecordIds.current = [];
    setVisibleRecordIds([]);
    autoTranslateAfterLoad.current = false;
    intentEpoch.current += 1;
    setState((current) => ({
      ...initialState,
      targetLanguage: current.targetLanguage,
      status: driveOffice
        ? "reader.status.driveCleared"
        : "reader.status.localCleared",
    }));
  }, [driveOffice, resetTranslation, stopDriveDownload, stopWorker]);

  const refreshDrive = useCallback(() => {
    restoreSheetName.current =
      stateRef.current.selection?.sheetName ?? restoreSheetName.current;
    stopDriveDownload();
    stopWorker();
    resetTranslation();
    viewportRecordIds.current = [];
    setVisibleRecordIds([]);
    setDriveRefreshId((value) => value + 1);
  }, [resetTranslation, stopDriveDownload, stopWorker]);

  useEffect(() => {
    if (source.kind !== "drive-office") return;
    let exited = false;
    const onSourceChanged = (message: unknown) => {
      const change = parseWorkspaceReaderSourceChanged(message);
      if (
        exited ||
        !change ||
        change.sourceTabId !== source.sourceTabId ||
        // Revision 0 means the background restarted and lost its record; the
        // same file is still open, so keep the view and let the next request
        // re-handshake instead of wiping Reader.
        change.version.sourceRevision === 0 ||
        (change.version.backgroundEpoch === source.version.backgroundEpoch &&
          change.version.sourceRevision <= source.version.sourceRevision)
      )
        return;
      exited = true;
      stopDriveDownload();
      stopWorker();
      resetTranslation();
      viewportRecordIds.current = [];
      setVisibleRecordIds([]);
      autoTranslateAfterLoad.current = false;
      intentEpoch.current += 1;
      setState((current) => ({
        ...initialState,
        targetLanguage: current.targetLanguage,
        status: "reader.status.sourceChanged",
      }));
      if (!managedSourceLifecycle) onExitDriveOffice?.();
    };
    browser.runtime.onMessage.addListener(onSourceChanged);
    return () => {
      exited = true;
      browser.runtime.onMessage.removeListener(onSourceChanged);
    };
  }, [
    managedSourceLifecycle,
    onExitDriveOffice,
    resetTranslation,
    source,
    stopDriveDownload,
    stopWorker,
  ]);

  const disconnectDriveOffice = useCallback(async () => {
    if (source.kind !== "drive-office") return;
    autoTranslateAfterLoad.current = false;
    intentEpoch.current += 1;
    stopDriveDownload();
    if (!stateRef.current.selection) stopWorker();
    resetTranslation();
    const request = {
      type: "WORKSPACE_READER_DISCONNECT",
      readerInstanceId: readerInstanceId.current,
      requestId: ++driveRequestId.current,
      sourceTabId: source.sourceTabId,
      version: source.version,
    } satisfies WorkspaceReaderRequest;
    setState((current) => ({
      ...current,
      pending: "disconnect",
      status: "reader.status.disconnecting",
      error: undefined,
      driveError: undefined,
    }));
    let response: Record<string, unknown> | null = null;
    try {
      response = objectValue(await browser.runtime.sendMessage(request));
    } catch {
      // The status below remains recoverable through another Disconnect attempt.
    }
    if (
      !response ||
      response.type !== request.type ||
      response.readerInstanceId !== request.readerInstanceId ||
      response.requestId !== request.requestId ||
      response.ok !== true ||
      response.connected !== false ||
      !objectValue(response.version) ||
      (response.version as Record<string, unknown>).backgroundEpoch !==
        request.version.backgroundEpoch ||
      (response.version as Record<string, unknown>).sourceRevision !==
        request.version.sourceRevision
    ) {
      setState((current) => ({
        ...current,
        pending: undefined,
        status: undefined,
        error: "reader.error.disconnectFailed",
      }));
      return;
    }
    onExitDriveOffice?.();
  }, [
    onExitDriveOffice,
    resetTranslation,
    source,
    stopDriveDownload,
    stopWorker,
  ]);

  const openReaderTab = useCallback(async () => {
    if (source.kind !== "drive-office" || openingReaderTab.current) return;
    openingReaderTab.current = true;
    const session = workerSession.current;
    setState((current) => ({ ...current, pending: "open-reader" }));
    try {
      await openReaderTabFallback(
        source.sourceTabId,
        awaitingStart,
        boundDriveFileId.current,
        () => session === workerSession.current,
      );
    } catch {
      if (session === workerSession.current)
        setState((current) => ({
          ...current,
          error: "reader.error.openTabFailed",
          driveError: "reader-channel-unavailable",
        }));
    } finally {
      openingReaderTab.current = false;
      if (session === workerSession.current)
        setState((current) => ({ ...current, pending: undefined }));
    }
  }, [awaitingStart, source]);

  const changeSettings = useCallback(
    (update: Partial<Pick<ReaderState, "targetLanguage">>) => {
      for (const key of Object.keys(update) as "targetLanguage"[])
        preferenceEdits.current.add(key);
      void saveReaderPreferences(update).catch(() => undefined);
      autoTranslateAfterLoad.current = false;
      intentEpoch.current += 1;
      resetTranslation({ type: "settings-change" });
      setState((current) => ({
        ...current,
        ...update,
        translations: new Map(),
        unresolved: new Set(),
        oversized: new Set(),
        pending: current.pending === "translate" ? undefined : current.pending,
        error: undefined,
        status: "reader.status.settingsChanged",
      }));
    },
    [resetTranslation],
  );

  const handleViewportRecordsChange = useCallback((recordIds: string[]) => {
    viewportRecordIds.current = recordIds;
    setVisibleRecordIds(recordIds);
    if (translationActive(translationStateRef.current))
      drainTranslation.current();
  }, []);

  /**
   * A drop anywhere on the Local Reader page opens the file, alongside the
   * picker. Unsupported or oversized drops are refused before the open
   * workbook is retired, so a stray file never clears the current view.
   * Bytes are read only by `openFile` and stay in the local Worker.
   */
  const [dragActive, setDragActive] = useState(false);
  const openFileRef = useRef(openFile);
  useLayoutEffect(() => {
    openFileRef.current = openFile;
  }, [openFile]);
  useEffect(() => {
    if (driveOffice) return;
    const carriesFiles = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const refuse = (message: ReaderMessage) =>
      setState((current) => ({
        ...current,
        status: undefined,
        error: message,
      }));
    const onDragOver = (event: DragEvent) => {
      // Without this the browser navigates the Reader tab to the file.
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      if (carriesFiles(event)) setDragActive(true);
    };
    const onDragLeave = (event: DragEvent) => {
      if (event.relatedTarget === null) setDragActive(false);
    };
    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      setDragActive(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (!files.length) return;
      if (files.length > 1) return refuse("reader.drop.multiple");
      const [file] = files as [File];
      if (!supportedFileName.test(file.name))
        return refuse(localErrors["unsupported-file-type"]);
      if (file.size > MAX_LOCAL_FILE_BYTES)
        return refuse(localErrors["file-too-large"]);
      void openFileRef.current(file);
    };
    window.addEventListener("dragenter", onDragOver);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragOver);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [driveOffice]);

  const pending = state.pending !== undefined;
  const hasSheet = state.selection !== undefined;
  const pages = useMemo(() => [...state.pages.values()], [state.pages]);
  const sheetOptions = useMemo(
    () =>
      (state.metadata?.sheets ?? []).map(({ index, name }) => ({
        value: String(index),
        label: name,
      })),
    [state.metadata?.sheets],
  );
  const sourcePhase: SpreadsheetSourcePhase =
    state.pending === "disconnect"
      ? "disconnecting"
      : waitingForStart
        ? "awaiting-start"
        : state.pending === "file"
          ? "discovering"
          : state.pending === "sheet"
            ? "loading-sheet"
            : hasSheet
              ? state.selection!.grid.lastUsedColumn < 0
                ? "empty"
                : "ready"
              : state.error
                ? "error"
                : "bootstrapping";
  const baseTranslationCapabilities = deriveSpreadsheetTranslationCapabilities(
    translationState,
    {
      settingsReady: state.pending === undefined,
      sourceReady:
        hasSheet &&
        state.pending !== "file" &&
        state.pending !== "sheet" &&
        state.pending !== "disconnect",
      hasVisibleRecords: visibleRecordIds.some(
        (id) => recordsById.get(id)?.translatable,
      ),
      hasTranslations: state.translations.size > 0,
    },
  );
  const retriableVisibleUnresolvedCount = visibleRecordIds.reduce(
    (count, id) =>
      count + (state.unresolved.has(id) && !state.oversized.has(id) ? 1 : 0),
    0,
  );
  const freshVisibleCount = visibleRecordIds.reduce((count, id) => {
    const cell = recordsById.get(id);
    return (
      count +
      (cell?.translatable &&
      translationSource(cell) &&
      !state.unresolved.has(id) &&
      state.translations.get(id)?.sourceHash !== cell.sourceHash
        ? 1
        : 0)
    );
  }, 0);
  const retriableUnresolvedCount = state.unresolved.size - state.oversized.size;
  const translationCapabilities = !preferencesReady
    ? { ...baseTranslationCapabilities, primaryDisabled: true }
    : translationState.phase === "partial" &&
        retriableVisibleUnresolvedCount === 0 &&
        freshVisibleCount === 0
      ? { ...baseTranslationCapabilities, primaryDisabled: true }
      : waitingForStart
        ? { ...baseTranslationCapabilities, primaryDisabled: !preferencesReady }
        : baseTranslationCapabilities;
  const actionableMessage: SpreadsheetReaderActionableMessage | undefined =
    state.error
      ? { tone: "error", text: t.text(state.error) }
      : state.status && messageKey(state.status) === "reader.status.slow"
        ? { tone: "warning", text: t.text(state.status) }
        : translationState.phase === "partial"
          ? {
              tone: "partial",
              text:
                state.oversized.size === 0
                  ? t.t("reader.partial.unresolved", {
                      count: retriableUnresolvedCount,
                    })
                  : state.oversized.size === state.unresolved.size
                    ? t.t("reader.partial.oversized", {
                        count: state.oversized.size,
                      })
                    : t.t("reader.partial.mixed", {
                        count: retriableUnresolvedCount,
                        oversized: state.oversized.size,
                      }),
            }
          : undefined;
  const completionAnnouncement =
    state.status && messageKey(state.status) === "reader.status.completed"
      ? t.text(state.status)
      : undefined;
  const changePresentation = useCallback(
    (presentation: ReaderState["presentation"]) =>
      setState((current) => ({ ...current, presentation })),
    [],
  );

  return (
    <main className="reader-shell local-reader-shell" aria-busy={pending}>
      {dragActive && hasSheet ? (
        <div className="local-drop-overlay" aria-hidden="true">
          <DropThread />
          <span className="local-dropzone-icon">
            <Upload />
          </span>
          <strong>{t.t("reader.drop.title")}</strong>
          <span>{t.t("reader.drop.hint")}</span>
        </div>
      ) : null}
      <ReaderHeader
        subtitle={
          driveOffice
            ? t.t("reader.driveSubtitle")
            : t.t("reader.localSubtitle")
        }
      >
        <span className="connection local">
          {driveOffice ? t.t("reader.badge.drive") : t.t("reader.badge.local")}
        </span>
      </ReaderHeader>

      {!hasSheet && !driveOffice && state.pending !== "file" ? (
        <section
          className="local-file-stage"
          aria-label={t.t("reader.local.selection")}
        >
          <label
            className={
              dragActive ? "local-dropzone is-drag-over" : "local-dropzone"
            }
          >
            <input
              type="file"
              aria-label={t.t("reader.local.openInput")}
              accept=".csv,.xlsx,.xlsm"
              disabled={pending}
              onChange={(event) => {
                void openFile(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
            {dragActive ? <DropThread /> : null}
            <span className="local-dropzone-icon" aria-hidden="true">
              {pending ? (
                <LoaderCircle className="spinner" aria-hidden="true" />
              ) : (
                <Upload aria-hidden="true" />
              )}
            </span>
            <strong>
              {pending
                ? t.t("reader.local.reading")
                : t.t("reader.local.choose")}
            </strong>
            <span>{t.t("reader.local.hint")}</span>
          </label>
          <div className="local-boundaries">
            <FileSpreadsheet aria-hidden="true" />
            <p>{t.t("reader.local.boundaries")}</p>
          </div>
          <div
            className={`reader-status ${state.error ? "error" : ""}`}
            role={state.error ? "alert" : "status"}
            aria-live="polite"
          >
            {state.error ? <AlertCircle aria-hidden="true" /> : null}
            <span>
              {state.error
                ? t.text(state.error)
                : state.status
                  ? t.text(state.status)
                  : ""}
            </span>
          </div>
        </section>
      ) : (
        <>
          <SpreadsheetReaderControls
            sourceLabel={
              driveOffice
                ? t.t("reader.source.driveFile")
                : t.t("reader.source.localFile")
            }
            sourceTitle={
              state.metadata?.fileName ??
              sourceTitle ??
              (driveOffice
                ? t.t("reader.source.driveWorkbook")
                : t.t("reader.source.localWorkbook"))
            }
            sourcePhase={sourcePhase}
            worksheetOptions={sheetOptions}
            worksheetPlaceholder={t.t("reader.worksheetAfterTranslate")}
            worksheetDisabled={
              !state.metadata || baseTranslationCapabilities.settingsDisabled
            }
            worksheetValue={
              state.selection ? String(state.selection.sheetIndex) : ""
            }
            onWorksheetChange={selectSheet}
            targetOptions={targetOptions}
            targetValue={state.targetLanguage}
            onTargetChange={(targetLanguage) =>
              changeSettings({
                targetLanguage: targetLanguage as TargetLanguage,
              })
            }
            translationState={translationState}
            translationCapabilities={translationCapabilities}
            onPrimaryAction={startTranslation}
            onStop={stopTranslation}
            presentation={state.presentation}
            onPresentationChange={changePresentation}
            refreshDisabled={
              !driveOffice ||
              state.pending === "disconnect" ||
              state.pending === "translate" ||
              waitingForStart
            }
            onRefresh={refreshDrive}
            clearDisabled={
              state.pending === "translate" || state.pending === "disconnect"
            }
            onClear={clearView}
            connection={
              driveOffice
                ? {
                    kind: "google",
                    label: "Google Workspace",
                    badgeLabel: t.t("reader.badge.drive"),
                    disconnecting: state.pending === "disconnect",
                    onDisconnect: () => void disconnectDriveOffice(),
                  }
                : {
                    kind: "local",
                    label: t.t("reader.source.localWorkbook"),
                    badgeLabel: t.t("reader.badge.local"),
                  }
            }
            actionableMessage={hasSheet ? actionableMessage : undefined}
            completionAnnouncement={completionAnnouncement}
          />
          {state.driveError === "reader-channel-unavailable" ? (
            <section
              className="reader-controls"
              aria-label={t.t("reader.recovery")}
            >
              <button
                type="button"
                disabled={pending}
                onClick={() => void openReaderTab()}
              >
                {t.t("reader.openInTab")}
              </button>
            </section>
          ) : null}
          <section
            className="reader-results sheets-results"
            aria-label={
              driveOffice
                ? t.t("reader.results.drive")
                : t.t("reader.results.local")
            }
          >
            {hasSheet && pages.length > 0 ? (
              <SheetsGrid
                key={`${state.selection!.grid.sheetId}:${state.selection!.grid.generation}`}
                grid={state.selection!.grid}
                pages={pages}
                translations={displayedTranslations}
                presentation={state.presentation}
                includeNextViewport={false}
                onNearPageEnd={loadPage}
                onViewportRecordsChange={handleViewportRecordsChange}
              />
            ) : (
              <>
                <SpreadsheetReaderSourceState
                  phase={sourcePhase}
                  title={state.error ? t.text(state.error) : undefined}
                  description={
                    waitingForStart
                      ? t.t("reader.desc.awaitingStart")
                      : state.error
                        ? t.t("reader.desc.refreshRetry")
                        : driveOffice
                          ? t.t("reader.desc.driveSaved")
                          : t.t("reader.desc.local")
                  }
                />
                {state.driveError === "google-auth-required" ||
                state.driveError === "google-oauth-expired" ||
                state.driveError === "google-oauth-scope" ? (
                  <button type="button" onClick={onExitDriveOffice}>
                    {t.t("reader.reconnectWorkspace")}
                  </button>
                ) : null}
              </>
            )}
          </section>
        </>
      )}
    </main>
  );
}
