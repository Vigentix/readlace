import {
  CACHE_PREFIX,
  PREF_PREFIX,
  TARGET_LANGUAGES,
  hostnameFromUrl,
  preferenceKey,
  type TargetLanguage,
} from "@/lib/translation";
import { AuthRequiredError } from "@/lib/run-errors";
import {
  driveOfficeReaderEnabled,
  sheetsReaderEnabled,
} from "@/lib/workspace-features";
import {
  chooseEngineSource,
  chooseTranslationPath,
  onDeviceTranslatorSupported,
  type TranslationPath,
} from "@/lib/translation-path";
import { createByokStage } from "@/lib/byok-stage";
import { testOpenAIKey } from "@/lib/provider-key-test";
import { createProviderSettingsHost } from "@/lib/provider-settings-host";
import {
  DIAGNOSTICS_GET,
  buildDiagnosticsReport,
} from "@/lib/diagnostics-report";
import { installUninstallSurvey } from "@/lib/uninstall-survey";
import {
  GOOGLE_WORKSPACE_SCOPES,
  isGoogleWorkspaceWebClientId,
} from "@/shared/google-workspace-config";
import {
  MAX_GOOGLE_RESPONSE_BYTES,
  MAX_LOADED_RECORDS,
  MAX_LOADED_SOURCE_CHARACTERS,
  MAX_TRANSLATION_MESSAGE_CHARACTERS,
  MAX_TRANSLATION_MESSAGE_RECORDS,
  MAX_TRANSLATION_RECORD_CHARACTERS,
  SHEETS_PAGE_ROWS,
  mergeWorkspaceSheetDiscoveryFragments,
  mergeWorkspaceSheetPageFragments,
  parseDocsTabs,
  parseSheetsPage,
  defaultWorkspaceSheetCellStyle,
  WORKSPACE_SHEET_DEFAULT_COLUMN_PIXEL_SIZE,
  WORKSPACE_SHEET_DEFAULT_ROW_PIXEL_SIZE,
  parseWorkspaceEditorUrl,
  parseWorkspaceReaderOwner,
  parseWorkspaceReaderOpen,
  parseWorkspaceReaderSheetCatalog,
  parseWorkspaceSheetGrid,
  parseWorkspaceSourceVersion,
  sameWorkspaceSourceIdentity,
  workspaceSourceIdentity,
  workspaceRecordTranslationSource,
  type WorkspaceEditorContext,
  type WorkspaceLoadCursor,
  type WorkspaceReaderErrorCode,
  type WorkspaceReaderRequest,
  type WorkspaceReaderResponse,
  type WorkspaceReaderSheetDescriptor,
  type WorkspaceSourceIdentity,
  type WorkspaceSourceVersion,
  type WorkspaceReaderTab,
  type WorkspaceRecord,
  type WorkspaceSheetDiscoveryAxis,
  type WorkspaceSheetDiscoveryFragment,
  type WorkspaceSheetDiscoveryProgress,
  type WorkspaceSheetGrid,
  type WorkspaceSheetPage,
  type WorkspaceSheetPageFragment,
  type WorkspaceSheetRow,
} from "@/lib/google-workspace-reader";
import {
  parseGoogleSheetsTheme,
  resolveGoogleCellFormat,
  resolveGoogleDefaultStyle,
} from "@/lib/google-sheets-cell-format";
import { extensionStorage } from "@/lib/indexeddb-storage";
import {
  browserUiLanguage,
  parseUiLocale,
  resolveUiLocale,
  UI_LOCALE_KEY,
  type UiLocaleChangedEvent,
  type UiLocaleResponse,
} from "@/lib/i18n/locale";
import { readReaderPreferences } from "@/lib/reader-preferences";
import {
  MAX_LOCAL_TRANSLATION_RESPONSE_UNITS,
  MAX_LOCAL_TRANSLATION_RESULT_UNITS,
  parseLocalSpreadsheetTranslateRequest,
  type LocalSpreadsheetTranslateRequest,
  type LocalSpreadsheetTranslateResponse,
  type LocalSpreadsheetTranslationErrorCode,
} from "@/lib/local-spreadsheet-reader";
import {
  GOOGLE_DRIVE_OFFICE_PORT_NAME,
  MAX_GOOGLE_DRIVE_OFFICE_BYTES,
  MAX_GOOGLE_DRIVE_OFFICE_CHUNK_BYTES,
  encodeGoogleDriveOfficeChunk,
  isGoogleDriveOfficeFile,
  parseGoogleDriveOfficePortMessage,
  parseGoogleDriveOfficeStartRequest,
  type GoogleDriveOfficeErrorCode,
  type GoogleDriveOfficePortMessage,
  type GoogleDriveOfficeStartRequest,
} from "@/lib/google-drive-office-reader";
import type {
  SelectionTranslationRequest,
  SelectionTranslationResponse,
  SelectionTranslationUiLoadResponse,
} from "@/lib/selection-translation";
import {
  type CancelNativeTranslationMessage,
  createNativeTranslatorHost,
  type PrepareNativeTranslatorMessage,
  type QueryNativeTranslatorProgressMessage,
  type TranslateNativeTextMessage,
} from "@/lib/translate/browser-native";
import {
  createOpenAIHtmlTranslator,
  type OpenAIFallbackProvenance,
} from "@/lib/translate/openai-html";
import {
  resolvePageLanguage,
  resolveRecordSourceLanguage,
  resolveTrustedSourceLanguage,
  shouldStartAlwaysTranslate,
} from "@/lib/translate/page-language";
import {
  canonicalPreferenceKey,
  readAlwaysTranslatePreference,
} from "@/lib/translate/site-scope";
import {
  clearRuns,
  listRuns,
  recordRun,
  type TranslationRunSummary,
} from "@/lib/translate/translation-diagnostics";

/** The UI locale preference (`CONTEXT.md` **UI locale**). */
async function readUiLocale(): Promise<UiLocaleResponse> {
  const stored = parseUiLocale(
    await extensionStorage.get(UI_LOCALE_KEY).catch(() => undefined),
  );
  return {
    locale: resolveUiLocale(stored, browserUiLanguage()),
    stored: stored ?? null,
  };
}

export default defineBackground(() => {
  let abortGoogleDriveOfficeDownload: (
    error?: GoogleDriveOfficeErrorCode,
  ) => void = () => undefined;
  const storage = {
    async get(key: string) {
      const value = await extensionStorage.get(key);
      return typeof value === "string" ? value : undefined;
    },
    async set(key: string, value: string) {
      await extensionStorage.set(key, value);
    },
    async getMany(keys: string[]) {
      const stored = await extensionStorage.getMany(keys);
      return Object.fromEntries(
        Object.entries(stored).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
    },
    async setMany(entries: Record<string, string>) {
      await extensionStorage.setMany(entries);
    },
    async getAll() {
      const all = await extensionStorage.getByPrefix(CACHE_PREFIX);
      const strings: Record<string, string> = {};
      for (const [key, value] of Object.entries(all)) {
        if (typeof value === "string") strings[key] = value;
      }
      return strings;
    },
    async remove(keys: string[]) {
      if (keys.length) await extensionStorage.remove(keys);
    },
  };
  // ADR 0020: no accounts. One local identity; its generation changes only
  // when local work must retire, so run, Reader and cache ownership checks
  // keep their meaning.
  const localGeneration = 0;
  const auth = { getGeneration: () => localGeneration };
  const LOCAL_USER = {
    authenticated: true as const,
    user: { id: "local", email: "" },
  };
  // ADR 0020: the user's own provider key, held only by this worker. Every
  // stage reads it fresh, so a removed or replaced key applies at once.
  const providerSettings = createProviderSettingsHost({
    storage: extensionStorage,
    testKey: (apiKey, model) => testOpenAIKey(apiKey, model),
  });
  void providerSettings.ready();
  // ADR 0020: an optional static survey after uninstall; no identifiers.
  void installUninstallSurvey(
    browser.runtime,
    import.meta.env.WXT_UNINSTALL_SURVEY_URL,
  );
  // One local translation stage per batch: OpenAI with its retries, no
  // Google fallback; unresolved records continue to the on-device stage.
  const completeProviderStage = createByokStage({
    readCredentials: () => providerSettings.credentials(),
    onKeyRejected: () => providerSettings.markKeyRejected(),
  });
  const openai = createOpenAIHtmlTranslator({
    completeHtml: completeProviderStage,
    storage,
    // Only whether a key is saved; the key itself never enters the pipeline.
    // A key rejected mid-run still reaches the stage, which then leaves the
    // records unresolved for the on-device stage instead of failing the run.
    getApiKey: async () => {
      await providerSettings.ready();
      return providerSettings.engineState().keyConfigured ? "configured" : "";
    },
    model: () => providerSettings.view().settings.providers.openai.model,
  });
  // First-use language-pack progress goes to extension pages (the popup);
  // it carries no page text.
  const nativeTranslator = createNativeTranslatorHost({
    onProgress: (sourceLanguage, targetLanguage, progress) =>
      void browser.runtime
        .sendMessage({
          type: "NATIVE_TRANSLATOR_PROGRESS",
          sourceLanguage,
          targetLanguage,
          progress,
        })
        .catch(() => undefined),
  });
  /** The client path selector over the provider settings (ADR 0020). */
  const translationPath = (): TranslationPath =>
    chooseTranslationPath(
      chooseEngineSource(providerSettings.engineState()),
      onDeviceTranslatorSupported() ? "unknown" : "unsupported",
    );
  const pathOptions = (path: TranslationPath) =>
    path === "provider" ? {} : { cacheOnly: true };
  /**
   * On-device translation of plain texts that have no result yet, for
   * surfaces without the page pipeline's own native stage (the Reader). One
   * attempt per text, grouped per language pair, accepted results saved to
   * the chain cache as `browser-native`. Returns the merged results; texts
   * on-device cannot translate stay empty (unresolved).
   */
  const translateTextsOnDevice = async (
    texts: readonly string[],
    results: readonly string[],
    targetLanguage: TargetLanguage,
    ownerKey: string,
    requestId: number,
  ) => {
    const merged = texts.map((_, index) => results[index] ?? "");
    if (translationPath() !== "native") return merged;
    const byRoute = new Map<TargetLanguage, number[]>();
    texts.forEach((text, index) => {
      if (merged[index] || !text.trim()) return;
      const route = resolveRecordSourceLanguage(text);
      if (route === "auto" || route === targetLanguage) return;
      byRoute.set(route, [...(byRoute.get(route) ?? []), index]);
    });
    for (const [sourceLanguage, indexes] of byRoute) {
      const status = await nativeTranslator.prepare({
        type: "PREPARE_NATIVE_TRANSLATOR",
        sourceLanguage,
        targetLanguage,
      });
      if (!status.ready) continue;
      const owner = `${ownerKey}:${sourceLanguage}`;
      const native = await nativeTranslator.translate(
        `${owner}:${requestId}`,
        owner,
        {
          type: "TRANSLATE_NATIVE_TEXT",
          runId: requestId,
          sourceLanguage,
          targetLanguage,
          texts: indexes.map((index) => texts[index]!),
        },
      );
      const accepted: number[] = [];
      native.results.forEach((result, position) => {
        const index = indexes[position];
        if (index === undefined || result?.status !== "accepted") return;
        merged[index] = result.text;
        accepted.push(index);
      });
      if (accepted.length)
        await openai
          .cacheFallbackTranslations(
            accepted.map((index) => [texts[index]!]),
            accepted.map((index) => [merged[index]!]),
            targetLanguage,
            {},
            "browser-native",
          )
          .catch(() => 0);
    }
    return merged;
  };
  interface WorkspaceIdentity {
    getRedirectURL?(path?: string): string;
    launchWebAuthFlow?(details: {
      url: string;
      interactive: boolean;
    }): Promise<string | undefined>;
  }
  interface WorkspaceSessionStorage {
    get(key: string): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
    remove(key: string): Promise<void>;
    setAccessLevel?(options: {
      accessLevel: "TRUSTED_CONTEXTS";
    }): Promise<void>;
  }
  interface WorkspaceLoadedState {
    readerInstanceId: string;
    generation: number;
    authGeneration: number;
    sourceVersion: WorkspaceSourceVersion;
    sourceContext: WorkspaceEditorContext;
    context: WorkspaceEditorContext;
    title: string;
    records: Map<string, WorkspaceRecord>;
    cursor: WorkspaceLoadCursor;
    grid?: WorkspaceSheetGrid;
    sheetMetadata?: SheetMetadata;
    pages?: Map<number, WorkspaceSheetPage>;
    pendingPage?: string;
    tabs?: WorkspaceReaderTab[];
  }
  interface SheetMetadata {
    context: WorkspaceEditorContext;
    sheets: WorkspaceReaderSheetDescriptor[];
    title: string;
    rowCount: number;
    columnCount: number;
    frozenRowCount: number;
    frozenColumnCount: number;
    rightToLeft: boolean;
    hideGridlines: boolean;
  }
  interface SheetRectangle {
    startRow: number;
    rowCount: number;
    startColumn: number;
    columnCount: number;
  }
  interface WorkspaceDiscoveryState {
    readerInstanceId: string;
    token: string;
    generation: number;
    authGeneration: number;
    sourceVersion: WorkspaceSourceVersion;
    sourceContext: WorkspaceEditorContext;
    metadata: SheetMetadata;
    chunkStart: number;
    chunkCount: number;
    chunkWasSplit: boolean;
    scanned: number;
    pending: SheetRectangle[];
    fragments: WorkspaceSheetDiscoveryFragment[];
    rightmost: number | null;
    provisionalLastUsedRow: number | null;
    lastUsedRow: number | null;
    columnCoverageStart: number;
    axis: WorkspaceSheetDiscoveryAxis;
    phase: WorkspaceSheetDiscoveryAxis | "grid";
    busy: boolean;
  }
  interface WorkspaceLoadExecution {
    state: WorkspaceLoadedState;
    records: WorkspaceRecord[];
    cursor: WorkspaceLoadCursor;
    page?: WorkspaceSheetPage;
    tabs?: WorkspaceReaderTab[];
  }
  class WorkspaceReaderFailure extends Error {
    constructor(
      readonly code: WorkspaceReaderErrorCode,
      readonly splitRange = false,
    ) {
      super(code);
    }
  }
  const readerTypes = new Set<WorkspaceReaderRequest["type"]>([
    "WORKSPACE_READER_CONTEXT",
    "WORKSPACE_READER_CONNECT",
    "WORKSPACE_READER_DISCONNECT",
    "WORKSPACE_READER_SELECT_SHEET",
    "WORKSPACE_READER_DISCOVER",
    "WORKSPACE_READER_LOAD",
    "WORKSPACE_READER_TRANSLATE",
  ]);
  const workspaceStates = new Map<string, WorkspaceLoadedState>();
  const workspaceDiscoveries = new Map<string, WorkspaceDiscoveryState>();
  const workspaceDiscoveryStarts = new Map<string, string>();
  const workspaceSheetSelections = new Map<
    string,
    {
      authGeneration: number;
      sourceVersion: WorkspaceSourceVersion;
      sourceContext: WorkspaceEditorContext;
      context: WorkspaceEditorContext;
      sheets: WorkspaceReaderSheetDescriptor[];
    }
  >();
  const readerRequestIds = new Map<string, number>();
  interface ReaderDocumentBinding {
    documentId: string;
    windowId: number;
    sourceContext: WorkspaceEditorContext;
    sourceVersion: WorkspaceSourceVersion;
    authGeneration: number;
    accountId: string;
  }
  const readerDocumentBindings = new Map<string, ReaderDocumentBinding>();
  const localReaderRequests = new Map<
    string,
    {
      requestId: number;
      generation: number;
      request: LocalSpreadsheetTranslateRequest;
      sourceTabId?: number;
    }
  >();
  const MAX_LOCAL_READER_OWNERS = 256;
  const workspaceSources = new Map<
    number,
    { identity: WorkspaceSourceIdentity | null; sourceRevision: number }
  >();
  const workspaceSourceWindows = new Map<number, number>();
  const workspaceSourceNotificationTimers = new Map<
    number,
    ReturnType<typeof setTimeout>
  >();
  const backgroundEpoch = crypto.randomUUID();
  let workspaceGeneration = 0;
  const WORKSPACE_TOKEN_KEY = "workspaceReaderGoogleToken:v1";
  const WORKSPACE_TOKEN_VERSION = 2;
  const WORKSPACE_TOKEN_EXPIRY_SKEW_MS = 60_000;
  const workspaceStateKey = (
    context: WorkspaceEditorContext,
    readerInstanceId: string,
  ) =>
    `${workspaceSelectionKey(readerInstanceId, context.sourceTabId)}:${context.kind}:${context.fileId}:${context.activeId ?? ""}`;
  const workspaceSelectionKey = (
    readerInstanceId: string,
    sourceTabId: number,
  ) => `${readerInstanceId}:${sourceTabId}`;
  const clearWorkspaceWorkForTab = (sourceTabId: number) => {
    for (const [key, state] of workspaceStates)
      if (state.sourceContext.sourceTabId === sourceTabId)
        workspaceStates.delete(key);
    for (const [token, state] of workspaceDiscoveries)
      if (state.sourceContext.sourceTabId === sourceTabId)
        workspaceDiscoveries.delete(token);
    for (const key of workspaceDiscoveryStarts.keys())
      if (key.endsWith(`:${sourceTabId}`)) workspaceDiscoveryStarts.delete(key);
  };
  const clearWorkspaceWorkForReader = (
    readerInstanceId: string,
    sourceTabId: number,
  ) => {
    for (const [key, state] of workspaceStates)
      if (
        state.readerInstanceId === readerInstanceId &&
        state.sourceContext.sourceTabId === sourceTabId
      )
        workspaceStates.delete(key);
    for (const [token, state] of workspaceDiscoveries)
      if (
        state.readerInstanceId === readerInstanceId &&
        state.sourceContext.sourceTabId === sourceTabId
      )
        workspaceDiscoveries.delete(token);
    workspaceDiscoveryStarts.delete(
      workspaceSelectionKey(readerInstanceId, sourceTabId),
    );
  };
  const clearWorkspaceStatesForTab = (sourceTabId: number) => {
    clearWorkspaceWorkForTab(sourceTabId);
    for (const [owner, binding] of readerDocumentBindings)
      if (binding.sourceContext.sourceTabId === sourceTabId)
        readerDocumentBindings.delete(owner);
    for (const [key, selection] of workspaceSheetSelections)
      if (selection.sourceContext.sourceTabId === sourceTabId)
        workspaceSheetSelections.delete(key);
    for (const [key, request] of localReaderRequests)
      if (request.sourceTabId === sourceTabId) localReaderRequests.delete(key);
  };
  const clearAllWorkspaceStates = () => {
    workspaceStates.clear();
    workspaceDiscoveries.clear();
    workspaceDiscoveryStarts.clear();
    workspaceSheetSelections.clear();
    readerDocumentBindings.clear();
  };
  const exactKeys = (value: Record<string, unknown>, keys: string[]) => {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return (
      actual.length === expected.length &&
      actual.every((key, index) => key === expected[index])
    );
  };
  const isSafeId = (value: unknown): value is number =>
    Number.isSafeInteger(value) && (value as number) >= 0;
  const parseCursor = (value: unknown): WorkspaceLoadCursor | undefined => {
    if (value === null) return null;
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return undefined;
    const cursor = value as Record<string, unknown>;
    if (
      cursor.kind === "sheets" &&
      exactKeys(cursor, ["kind", "nextRow"]) &&
      Number.isSafeInteger(cursor.nextRow) &&
      (cursor.nextRow as number) >= 1
    )
      return { kind: "sheets", nextRow: cursor.nextRow as number };
    if (
      cursor.kind === "docs" &&
      exactKeys(cursor, ["kind", "tabId"]) &&
      typeof cursor.tabId === "string" &&
      /^[A-Za-z0-9._-]{1,200}$/.test(cursor.tabId)
    )
      return { kind: "docs", tabId: cursor.tabId };
    return undefined;
  };
  const parseWorkspaceRequest = (
    value: unknown,
  ): WorkspaceReaderRequest | null => {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return null;
    const request = value as Record<string, unknown>;
    if (
      typeof request.type !== "string" ||
      !readerTypes.has(request.type as WorkspaceReaderRequest["type"]) ||
      !isSafeId(request.sourceTabId)
    )
      return null;
    const owner = parseWorkspaceReaderOwner({
      readerInstanceId: request.readerInstanceId,
      requestId: request.requestId,
    });
    if (!owner) return null;
    if (request.type === "WORKSPACE_READER_CONTEXT")
      return exactKeys(request, [
        "type",
        "readerInstanceId",
        "requestId",
        "sourceTabId",
        ...(request.identifySource === true ? ["identifySource"] : []),
      ])
        ? (request as unknown as WorkspaceReaderRequest)
        : null;
    const version = parseWorkspaceSourceVersion(request.version);
    if (!version) return null;
    if (
      request.type === "WORKSPACE_READER_CONNECT" ||
      request.type === "WORKSPACE_READER_DISCONNECT"
    )
      return exactKeys(request, [
        "type",
        "readerInstanceId",
        "requestId",
        "sourceTabId",
        "version",
      ])
        ? (request as unknown as WorkspaceReaderRequest)
        : null;
    if (request.type === "WORKSPACE_READER_SELECT_SHEET")
      return exactKeys(request, [
        "type",
        "readerInstanceId",
        "requestId",
        "sourceTabId",
        "version",
        "sheetId",
      ]) &&
        typeof request.sheetId === "string" &&
        /^(0|[1-9]\d{0,9})$/.test(request.sheetId) &&
        Number(request.sheetId) <= 2_147_483_647
        ? (request as unknown as WorkspaceReaderRequest)
        : null;
    if (request.type === "WORKSPACE_READER_DISCOVER") {
      const cursor = request.cursor;
      const validCursor =
        cursor === null ||
        (cursor !== null &&
          typeof cursor === "object" &&
          !Array.isArray(cursor) &&
          exactKeys(cursor as Record<string, unknown>, ["kind", "token"]) &&
          (cursor as { kind?: unknown }).kind === "sheets-discovery" &&
          typeof (cursor as { token?: unknown }).token === "string" &&
          (cursor as { token: string }).token.length > 0 &&
          (cursor as { token: string }).token.length <= 512);
      return validCursor &&
        exactKeys(request, [
          "type",
          "readerInstanceId",
          "requestId",
          "sourceTabId",
          "version",
          "cursor",
        ])
        ? (request as unknown as WorkspaceReaderRequest)
        : null;
    }
    if (request.type === "WORKSPACE_READER_LOAD") {
      const cursor = parseCursor(request.cursor);
      return cursor !== undefined &&
        exactKeys(request, [
          "type",
          "readerInstanceId",
          "requestId",
          "sourceTabId",
          "version",
          "cursor",
        ])
        ? ({ ...request, cursor } as unknown as WorkspaceReaderRequest)
        : null;
    }
    if (
      request.type !== "WORKSPACE_READER_TRANSLATE" ||
      !exactKeys(request, [
        "type",
        "readerInstanceId",
        "requestId",
        "sourceTabId",
        "version",
        "targetLanguage",
        "records",
      ]) ||
      !isTarget(request.targetLanguage) ||
      !Array.isArray(request.records)
    )
      return null;
    const ids = new Set<string>();
    for (const entry of request.records) {
      if (
        entry === null ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        !exactKeys(entry as Record<string, unknown>, ["id", "sourceHash"]) ||
        typeof (entry as { id?: unknown }).id !== "string" ||
        typeof (entry as { sourceHash?: unknown }).sourceHash !== "string" ||
        !/^[a-f0-9]{40}$/.test((entry as { sourceHash: string }).sourceHash) ||
        ids.has((entry as { id: string }).id)
      )
        return null;
      ids.add((entry as { id: string }).id);
    }
    return request as unknown as WorkspaceReaderRequest;
  };
  const identityApi = () =>
    (browser as unknown as { identity?: WorkspaceIdentity }).identity;
  const workspaceSessionStorage = () =>
    (
      browser as unknown as {
        storage?: { session?: WorkspaceSessionStorage };
      }
    ).storage?.session;
  const webClientIdValue =
    import.meta.env.BROWSER === "firefox"
      ? undefined
      : import.meta.env.WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID?.trim();
  const workspaceWebClientId =
    webClientIdValue && isGoogleWorkspaceWebClientId(webClientIdValue)
      ? webClientIdValue
      : undefined;
  const workspaceAuthMode = () =>
    workspaceWebClientId ? ("web" as const) : undefined;
  // `identity` is an optional permission granted at Connect (ADR 0015), so
  // `browser.identity` is absent until then; it is checked only for Connect.
  const workspaceConfigured =
    import.meta.env.BROWSER === "firefox"
      ? () => false
      : () => Boolean(workspaceAuthMode() && workspaceSessionStorage());
  // Build-time flag for the native Sheets Reader (ADR 0020, replacing the
  // ADR 0015 remote flag): off unless the build sets WXT_SHEETS_READER.
  const workspaceReaderEnabled = () =>
    workspaceConfigured() && sheetsReaderEnabled();
  const randomOauthState = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
  };
  const exactStringArray = (value: unknown, expected: readonly string[]) =>
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index]);
  const clearWorkspaceToken = async (required = false) => {
    const session = workspaceSessionStorage();
    if (!session) {
      if (required) throw new WorkspaceReaderFailure("unsupported-browser");
      return;
    }
    try {
      await session.remove(WORKSPACE_TOKEN_KEY);
    } catch {
      if (required) throw new WorkspaceReaderFailure("google-oauth-failed");
    }
  };
  let workspaceSessionConfigured: Promise<WorkspaceSessionStorage> | undefined;
  const configureWorkspaceSessionStorage = async () => {
    const session = workspaceSessionStorage();
    if (!session) throw new WorkspaceReaderFailure("unsupported-browser");
    workspaceSessionConfigured ??= (async () => {
      await session.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" });
      return session;
    })().catch(() => {
      workspaceSessionConfigured = undefined;
      throw new WorkspaceReaderFailure("unsupported-browser");
    });
    return workspaceSessionConfigured;
  };
  const readWorkspaceToken = async (managedAccountId: string) => {
    const session = await configureWorkspaceSessionStorage();
    let stored: unknown;
    try {
      stored = (await session.get(WORKSPACE_TOKEN_KEY))[WORKSPACE_TOKEN_KEY];
    } catch {
      throw new WorkspaceReaderFailure("google-oauth-failed");
    }
    if (stored === undefined) return undefined;
    const record =
      stored !== null && typeof stored === "object" && !Array.isArray(stored)
        ? (stored as Record<string, unknown>)
        : undefined;
    const valid =
      record !== undefined &&
      exactKeys(record, [
        "version",
        "accessToken",
        "issuedAt",
        "expiresAt",
        "clientId",
        "extensionId",
        "scopes",
        "managedAccountId",
      ]) &&
      record.version === WORKSPACE_TOKEN_VERSION &&
      typeof record.accessToken === "string" &&
      record.accessToken === record.accessToken.trim() &&
      record.accessToken.length > 0 &&
      record.accessToken.length <= 4_096 &&
      Number.isSafeInteger(record.issuedAt) &&
      Number.isSafeInteger(record.expiresAt) &&
      (record.issuedAt as number) <= Date.now() &&
      (record.expiresAt as number) >
        (record.issuedAt as number) + WORKSPACE_TOKEN_EXPIRY_SKEW_MS &&
      (record.expiresAt as number) <=
        (record.issuedAt as number) + 86_400_000 &&
      record.clientId === workspaceWebClientId &&
      record.extensionId === browser.runtime.id &&
      exactStringArray(record.scopes, GOOGLE_WORKSPACE_SCOPES) &&
      record.managedAccountId === managedAccountId;
    if (!valid) {
      await clearWorkspaceToken(true);
      return undefined;
    }
    if (
      Date.now() >=
      (record.expiresAt as number) - WORKSPACE_TOKEN_EXPIRY_SKEW_MS
    ) {
      await clearWorkspaceToken(true);
      throw new WorkspaceReaderFailure("google-oauth-expired");
    }
    return record.accessToken as string;
  };
  const storeWorkspaceToken = async (
    token: string,
    expiresAt: number,
    managedAccountId: string,
  ) => {
    const session = await configureWorkspaceSessionStorage();
    const issuedAt = Date.now();
    try {
      await session.set({
        [WORKSPACE_TOKEN_KEY]: {
          version: WORKSPACE_TOKEN_VERSION,
          accessToken: token,
          issuedAt,
          expiresAt,
          clientId: workspaceWebClientId,
          extensionId: browser.runtime.id,
          scopes: [...GOOGLE_WORKSPACE_SCOPES],
          managedAccountId,
        },
      });
    } catch {
      throw new WorkspaceReaderFailure("google-oauth-failed");
    }
  };
  const launchFailureCode = (error: unknown): WorkspaceReaderErrorCode => {
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (/cancel|closed|denied|did not approve/.test(message))
      return "google-access-denied";
    if (
      /redirect|client|oauth|invalid_request|unauthorized_client/.test(message)
    )
      return "google-oauth-configuration";
    if (
      /network|offline|failed to fetch|service unavailable|timed? ?out/.test(
        message,
      )
    )
      return "google-oauth-network";
    return "google-oauth-failed";
  };
  const webGoogleAuth =
    import.meta.env.BROWSER !== "firefox" && workspaceWebClientId
      ? async (identity: WorkspaceIdentity, managedAccountId: string) => {
          const redirectUri = identity.getRedirectURL!("google-workspace");
          let expectedRedirect: URL;
          try {
            expectedRedirect = new URL(redirectUri);
          } catch {
            throw new WorkspaceReaderFailure("google-oauth-configuration");
          }
          const state = randomOauthState();
          const authorization = new URL(
            "https://accounts.google.com/o/oauth2/v2/auth",
          );
          authorization.searchParams.set("client_id", workspaceWebClientId);
          authorization.searchParams.set("redirect_uri", redirectUri);
          authorization.searchParams.set("response_type", "token");
          authorization.searchParams.set(
            "scope",
            GOOGLE_WORKSPACE_SCOPES.join(" "),
          );
          authorization.searchParams.set("state", state);
          authorization.searchParams.set("include_granted_scopes", "false");
          authorization.searchParams.set("prompt", "select_account");
          let returned: string | undefined;
          try {
            returned = await identity.launchWebAuthFlow!({
              url: authorization.href,
              interactive: true,
            });
          } catch (error) {
            throw new WorkspaceReaderFailure(launchFailureCode(error));
          }
          if (!returned)
            throw new WorkspaceReaderFailure("google-access-denied");
          let actual: URL;
          try {
            actual = new URL(returned);
          } catch {
            throw new WorkspaceReaderFailure("google-oauth-response");
          }
          if (
            actual.origin !== expectedRedirect.origin ||
            actual.pathname !== expectedRedirect.pathname ||
            actual.search !== expectedRedirect.search ||
            actual.username ||
            actual.password
          )
            throw new WorkspaceReaderFailure("google-oauth-configuration");
          const result = new URLSearchParams(actual.hash.slice(1));
          for (const key of [
            "access_token",
            "token_type",
            "expires_in",
            "scope",
            "state",
            "error",
            "error_description",
          ])
            if (result.getAll(key).length > 1)
              throw new WorkspaceReaderFailure("google-oauth-response");
          if (result.get("state") !== state)
            throw new WorkspaceReaderFailure("google-oauth-response");
          if (result.has("error")) {
            const oauthError = result.get("error");
            if (oauthError === "access_denied")
              throw new WorkspaceReaderFailure("google-access-denied");
            if (
              oauthError === "invalid_request" ||
              oauthError === "unauthorized_client"
            )
              throw new WorkspaceReaderFailure("google-oauth-configuration");
            throw new WorkspaceReaderFailure("google-oauth-response");
          }
          const token = result.get("access_token") ?? "";
          const expiresText = result.get("expires_in") ?? "";
          const expiresIn = /^\d+$/.test(expiresText) ? Number(expiresText) : 0;
          const scopes = (result.get("scope") ?? "")
            .split(/\s+/)
            .filter(Boolean);
          if (
            result.get("token_type") !== "Bearer" ||
            token !== token.trim() ||
            token.length === 0 ||
            token.length > 4_096
          )
            throw new WorkspaceReaderFailure("google-oauth-response");
          if (
            !Number.isSafeInteger(expiresIn) ||
            expiresIn * 1_000 <= WORKSPACE_TOKEN_EXPIRY_SKEW_MS ||
            expiresIn > 86_400
          )
            throw new WorkspaceReaderFailure("google-oauth-expired");
          if (
            scopes.length !== GOOGLE_WORKSPACE_SCOPES.length ||
            new Set(scopes).size !== GOOGLE_WORKSPACE_SCOPES.length ||
            GOOGLE_WORKSPACE_SCOPES.some((scope) => !scopes.includes(scope))
          )
            throw new WorkspaceReaderFailure("google-oauth-scope");
          await storeWorkspaceToken(
            token,
            Date.now() + expiresIn * 1_000,
            managedAccountId,
          );
          return token;
        }
      : undefined;
  const googleToken = async (
    interactive: boolean,
    managedAccountId: string,
  ) => {
    if (!workspaceAuthMode())
      throw new WorkspaceReaderFailure("not-configured");
    if (!workspaceConfigured())
      throw new WorkspaceReaderFailure("unsupported-browser");
    const restored = await readWorkspaceToken(managedAccountId);
    if (restored) return restored;
    if (!interactive) throw new WorkspaceReaderFailure("google-auth-required");
    if (!webGoogleAuth) throw new WorkspaceReaderFailure("unsupported-browser");
    // Reader requests the optional permission in the Connect click.
    const identity = identityApi();
    if (!identity?.getRedirectURL || !identity.launchWebAuthFlow)
      throw new WorkspaceReaderFailure("google-permission-denied");
    return webGoogleAuth(identity, managedAccountId);
  };
  const evictGoogleToken = async (token: string) => {
    const session = workspaceSessionStorage();
    if (!session) return;
    try {
      const stored = (await session.get(WORKSPACE_TOKEN_KEY))[
        WORKSPACE_TOKEN_KEY
      ];
      if (
        stored !== null &&
        typeof stored === "object" &&
        !Array.isArray(stored) &&
        (stored as { accessToken?: unknown }).accessToken === token
      )
        await session.remove(WORKSPACE_TOKEN_KEY);
    } catch {
      // A best-effort eviction must not expose or persist the token.
    }
  };
  const disconnectGoogleToken = async () => {
    if (!workspaceAuthMode())
      throw new WorkspaceReaderFailure("not-configured");
    if (!workspaceConfigured())
      throw new WorkspaceReaderFailure("unsupported-browser");
    await clearWorkspaceToken(true);
  };
  const workspaceSourceVersion = (
    sourceTabId: number,
  ): WorkspaceSourceVersion => ({
    backgroundEpoch,
    sourceRevision: workspaceSources.get(sourceTabId)?.sourceRevision ?? 0,
  });
  const sameWorkspaceSourceVersion = (
    left: WorkspaceSourceVersion,
    right: WorkspaceSourceVersion,
  ) =>
    left.backgroundEpoch === right.backgroundEpoch &&
    left.sourceRevision === right.sourceRevision;
  const emitWorkspaceSourceChanged = (
    sourceTabId: number,
    version: WorkspaceSourceVersion,
  ) =>
    void browser.runtime
      .sendMessage({
        type: "WORKSPACE_READER_SOURCE_CHANGED",
        sourceTabId,
        version,
      })
      .catch(() => undefined);
  const scheduleWorkspaceSourceChanged = (sourceTabId: number) => {
    const pending = workspaceSourceNotificationTimers.get(sourceTabId);
    if (pending) clearTimeout(pending);
    workspaceSourceNotificationTimers.set(
      sourceTabId,
      setTimeout(() => {
        workspaceSourceNotificationTimers.delete(sourceTabId);
        emitWorkspaceSourceChanged(
          sourceTabId,
          workspaceSourceVersion(sourceTabId),
        );
      }, 200),
    );
  };
  const synchronizeWorkspaceSource = (
    sourceTabId: number,
    identity: WorkspaceSourceIdentity | null,
    notify = true,
  ) => {
    const current = workspaceSources.get(sourceTabId);
    if (!current) {
      workspaceSources.set(sourceTabId, { identity, sourceRevision: 0 });
      // After a service-worker restart the previous identity is unknown, so a
      // navigation cannot be proven unchanged. Tell the Reader to re-identify;
      // it ignores the notification when the file is the one it already shows.
      if (notify && identity !== null)
        scheduleWorkspaceSourceChanged(sourceTabId);
      return workspaceSourceVersion(sourceTabId);
    }
    const unchanged =
      current.identity === null || identity === null
        ? current.identity === identity
        : sameWorkspaceSourceIdentity(current.identity, identity);
    if (unchanged) return workspaceSourceVersion(sourceTabId);
    workspaceSources.set(sourceTabId, {
      identity,
      sourceRevision: current.sourceRevision + 1,
    });
    clearWorkspaceStatesForTab(sourceTabId);
    if (notify) scheduleWorkspaceSourceChanged(sourceTabId);
    return workspaceSourceVersion(sourceTabId);
  };
  const currentWorkspaceContext = async (sourceTabId: number) => {
    try {
      const tab = await browser.tabs.get(sourceTabId);
      if (typeof tab.windowId === "number")
        workspaceSourceWindows.set(sourceTabId, tab.windowId);
      const parsed = tab.url ? parseWorkspaceEditorUrl(tab.url) : null;
      if (!parsed || parsed.kind === "docs") {
        synchronizeWorkspaceSource(sourceTabId, null);
        throw new WorkspaceReaderFailure("unsupported-url");
      }
      const context = {
        sourceTabId,
        ...parsed,
      } satisfies WorkspaceEditorContext;
      synchronizeWorkspaceSource(sourceTabId, workspaceSourceIdentity(context));
      return context;
    } catch (error) {
      if (error instanceof WorkspaceReaderFailure) throw error;
      synchronizeWorkspaceSource(sourceTabId, null);
      throw new WorkspaceReaderFailure("source-tab-changed");
    }
  };
  const sameWorkspaceContext = (
    left: WorkspaceEditorContext,
    right: WorkspaceEditorContext,
  ) =>
    left.sourceTabId === right.sourceTabId &&
    left.kind === right.kind &&
    left.fileId === right.fileId &&
    (left.kind === "sheets" || left.activeId === right.activeId);
  const findWorkspaceStateBySource = (
    context: WorkspaceEditorContext,
    readerInstanceId: string,
  ) =>
    [...workspaceStates.values()].find(
      (state) =>
        state.readerInstanceId === readerInstanceId &&
        sameWorkspaceContext(state.sourceContext, context),
    );
  const GOOGLE_REQUEST_TIMEOUT_MS = 10_000;
  const googleJson = async (url: URL, token: string, splitTimeout = false) => {
    if (
      url.protocol !== "https:" ||
      (url.origin !== "https://docs.googleapis.com" &&
        url.origin !== "https://sheets.googleapis.com")
    )
      throw new WorkspaceReaderFailure("invalid-request");
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      GOOGLE_REQUEST_TIMEOUT_MS,
    );
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
        },
        signal: controller.signal,
      });
      if (response.status === 401) {
        await evictGoogleToken(token);
        throw new WorkspaceReaderFailure("google-auth-required");
      }
      if (response.status === 400 || response.status === 404)
        throw new WorkspaceReaderFailure("unsupported-file-type");
      if (response.status === 403)
        throw new WorkspaceReaderFailure("google-access-denied");
      if (response.status === 429)
        throw new WorkspaceReaderFailure("rate-limited");
      if (response.status >= 500)
        throw new WorkspaceReaderFailure("temporarily-unavailable");
      if (!response.ok) throw new WorkspaceReaderFailure("invalid-request");
      const declaredLength = Number(response.headers.get("content-length"));
      if (
        Number.isFinite(declaredLength) &&
        declaredLength > MAX_GOOGLE_RESPONSE_BYTES
      )
        throw new WorkspaceReaderFailure("response-too-large", true);
      if (!response.body) throw new WorkspaceReaderFailure("invalid-request");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_GOOGLE_RESPONSE_BYTES) {
          await reader.cancel();
          throw new WorkspaceReaderFailure("response-too-large", true);
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      try {
        return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      } catch {
        throw new WorkspaceReaderFailure("invalid-request");
      }
    } catch (error) {
      if (error instanceof WorkspaceReaderFailure) throw error;
      if (
        splitTimeout &&
        error instanceof DOMException &&
        error.name === "AbortError"
      )
        throw new WorkspaceReaderFailure("temporarily-unavailable", true);
      throw new WorkspaceReaderFailure("temporarily-unavailable");
    } finally {
      clearTimeout(timeout);
    }
  };
  const sheetsMetadataUrl = (fileId: string) => {
    const url = new URL(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(fileId)}`,
    );
    url.searchParams.set("includeGridData", "false");
    url.searchParams.set(
      "fields",
      "spreadsheetId,sheets(properties(sheetId,title,sheetType,rightToLeft,gridProperties(rowCount,columnCount,frozenRowCount,frozenColumnCount,hideGridlines)))",
    );
    return url;
  };
  // One bounded CellFormat mask shared by the spreadsheet default and cells.
  const sheetsCellFormatFields =
    "backgroundColor,backgroundColorStyle,textFormat(foregroundColor,foregroundColorStyle,bold,italic,underline,strikethrough,fontFamily,fontSize),horizontalAlignment,verticalAlignment,wrapStrategy,borders,padding,textDirection,textRotation";
  const sheetsThemeFields = "spreadsheetTheme(primaryFontFamily,themeColors)";
  const sheetsGridMetadataUrl = (fileId: string, range: string) => {
    const url = sheetsMetadataUrl(fileId);
    url.searchParams.set("ranges", range);
    url.searchParams.set(
      "fields",
      `spreadsheetId,properties(defaultFormat(${sheetsCellFormatFields}),${sheetsThemeFields}),sheets(properties(sheetId,title,sheetType,rightToLeft,gridProperties(rowCount,columnCount,frozenRowCount,frozenColumnCount,hideGridlines)),merges,data(startColumn,columnMetadata(pixelSize,hiddenByUser)))`,
    );
    return url;
  };
  const sheetsPageUrl = (fileId: string, range: string) => {
    const url = sheetsMetadataUrl(fileId);
    url.searchParams.set("includeGridData", "true");
    url.searchParams.set("ranges", range);
    url.searchParams.set(
      "fields",
      `spreadsheetId,properties(${sheetsThemeFields}),sheets(properties(sheetId,title,sheetType,gridProperties(rowCount,columnCount)),merges,data(startRow,startColumn,rowMetadata(pixelSize,hiddenByUser),rowData(values(userEnteredValue,effectiveValue,formattedValue,effectiveFormat(${sheetsCellFormatFields})))))`,
    );
    return url;
  };
  const sheetsValuesUrl = (
    fileId: string,
    range: string,
    axis: WorkspaceSheetDiscoveryAxis,
  ) => {
    const url = new URL(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(fileId)}/values/${encodeURIComponent(range)}`,
    );
    url.searchParams.set(
      "majorDimension",
      axis === "columns" ? "COLUMNS" : "ROWS",
    );
    url.searchParams.set("valueRenderOption", "FORMULA");
    url.searchParams.set("dateTimeRenderOption", "SERIAL_NUMBER");
    url.searchParams.set("fields", "majorDimension,range,values");
    return url;
  };
  const docsContentFields =
    "startIndex,paragraph(elements(textRun(content),equation(suggestedInsertionIds),inlineObjectElement(inlineObjectId),pageBreak(suggestedInsertionIds),columnBreak(suggestedInsertionIds),footnoteReference(footnoteId),horizontalRule(suggestedInsertionIds),autoText(type),person(personId),richLink(richLinkId),dateElement(dateId))),table(tableRows(tableCells(content))),tableOfContents(suggestedInsertionIds)";
  const docsTabFields = `tabProperties(tabId,title,parentTabId),documentTab(body(content(${docsContentFields})))`;
  const docsFields = `documentId,tabs(${docsTabFields},childTabs(${docsTabFields},childTabs(${docsTabFields})))`;
  const docsUrl = (fileId: string) => {
    const url = new URL(
      `https://docs.googleapis.com/v1/documents/${encodeURIComponent(fileId)}`,
    );
    url.searchParams.set("includeTabsContent", "true");
    url.searchParams.set("fields", docsFields);
    return url;
  };
  let pageCacheEpoch = 0;
  const runContexts = new Map<
    string,
    {
      cacheEpoch: number;
      sourceLanguageHint?: TargetLanguage;
      generation: number;
    }
  >();
  const activeRunIdsByOwner = new Map<string, number>();
  interface RunSender {
    tab?: { id?: number };
    frameId?: number;
    documentId?: string;
  }
  const nativeOwnerKey = (sender: RunSender) =>
    sender.tab?.id === undefined
      ? "extension"
      : `${sender.tab.id}:${sender.frameId ?? 0}:${sender.documentId ?? "document?"}`;
  const nativeRunKey = (sender: RunSender, runId: unknown) =>
    `${nativeOwnerKey(sender)}:${typeof runId === "number" ? runId : "?"}`;
  const nativeOwnersByTab = new Map<number, Set<string>>();
  // ADR 0020: no sign-in, so supported editors always route to the Reader.
  const toolbarAuthenticated = true;
  interface ReaderPanelApi {
    setOptions(options: {
      tabId?: number;
      enabled: boolean;
      path?: string;
    }): Promise<void>;
    open(options: { windowId: number }): Promise<void>;
    close?(options: { windowId: number }): Promise<void>;
    onOpened?: {
      addListener(
        callback: (info: { windowId: number; tabId?: number }) => void,
      ): void;
    };
    onClosed?: {
      addListener(callback: (info: { windowId: number }) => void): void;
    };
  }
  const readerPanelApi = () =>
    (browser as unknown as { sidePanel?: ReaderPanelApi }).sidePanel;
  const toolbarRoutes = new Map<number, object>();
  const toolbarRouteWrites = new Map<number, Promise<void>>();
  const appliedToolbarRoutes = new Map<number, string>();
  const openReaderWindows = new Map<number, number>();
  const readerDocumentWindows = new Map<string, number>();
  const READER_DOCUMENT_WINDOWS_KEY = "workspaceReaderDocumentWindows:v1";
  let readerDocumentRegistryRevision = 0;
  let readerDocumentRegistryWrite = Promise.resolve();
  const persistReaderDocumentWindows = () => {
    readerDocumentRegistryWrite = readerDocumentRegistryWrite
      .catch(() => undefined)
      .then(async () => {
        const session = workspaceSessionStorage();
        if (!session) return;
        await session.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" });
        await session.set({
          [READER_DOCUMENT_WINDOWS_KEY]: {
            version: 1,
            extensionId: browser.runtime.id,
            documents: [...readerDocumentWindows].map(
              ([documentId, windowId]) => ({ documentId, windowId }),
            ),
          },
        });
      })
      .catch(() => undefined);
    return readerDocumentRegistryWrite;
  };
  const pendingReaderOpenBindings = new Map<number, Promise<void>>();
  const unresolvedReaderOpenWindows = new Map<
    number,
    ReturnType<typeof readerPanelContexts>
  >();
  const readerPanelContexts = async () => {
    if (typeof browser.runtime.getContexts !== "function") return [];
    const contexts = await browser.runtime.getContexts({
      contextTypes: ["SIDE_PANEL"],
    });
    return contexts.filter(
      (context) =>
        context.contextType === "SIDE_PANEL" &&
        typeof context.documentId === "string" &&
        (trustedReaderSender(context.documentUrl, 0) ||
          trustedGoogleDriveOfficeSender(context.documentUrl) !== null),
    );
  };
  const restoreReaderDocumentWindows = async () => {
    const initialRevision = readerDocumentRegistryRevision;
    try {
      const session = workspaceSessionStorage();
      if (!session) return;
      await session.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" });
      const stored = await session.get(READER_DOCUMENT_WINDOWS_KEY);
      const record = objectValue(stored[READER_DOCUMENT_WINDOWS_KEY]);
      if (
        !record ||
        !exactKeys(record, ["version", "extensionId", "documents"]) ||
        record.version !== 1 ||
        record.extensionId !== browser.runtime.id ||
        !Array.isArray(record.documents) ||
        record.documents.length > MAX_LOCAL_READER_OWNERS
      ) {
        if (readerDocumentRegistryRevision === initialRevision)
          await persistReaderDocumentWindows();
        return;
      }
      const entries = record.documents.map((value) => objectValue(value));
      const ids = new Set<string>();
      for (const entry of entries) {
        if (
          !entry ||
          !exactKeys(entry, ["documentId", "windowId"]) ||
          typeof entry.documentId !== "string" ||
          !/^[A-Za-z0-9._:-]{1,128}$/.test(entry.documentId) ||
          !isSafeId(entry.windowId) ||
          ids.has(entry.documentId)
        ) {
          if (readerDocumentRegistryRevision === initialRevision)
            await persistReaderDocumentWindows();
          return;
        }
        ids.add(entry.documentId);
      }
      const liveContexts = new Map(
        (await readerPanelContexts()).map((context) => [
          context.documentId,
          context,
        ]),
      );
      const restored = await Promise.all(
        entries.map(async (entry) => {
          if (!entry) return null;
          const context = liveContexts.get(entry.documentId as string);
          if (
            !context ||
            !Number.isSafeInteger(context.windowId) ||
            context.windowId < -1 ||
            (context.windowId >= 0 && context.windowId !== entry.windowId)
          )
            return null;
          const windowId = entry.windowId as number;
          const actual = await browser.windows
            .get(windowId)
            .catch(() => undefined);
          return actual?.id === windowId
            ? { documentId: entry.documentId as string, windowId }
            : null;
        }),
      );
      if (readerDocumentRegistryRevision !== initialRevision) return;
      for (const entry of restored)
        if (entry && !readerDocumentWindows.has(entry.documentId))
          readerDocumentWindows.set(entry.documentId, entry.windowId);
      readerDocumentRegistryRevision += 1;
      await persistReaderDocumentWindows();
    } catch {
      // Browser-session metadata is optional; unavailable identity stays fail-closed.
    }
  };
  const readerDocumentWindowsReady = restoreReaderDocumentWindows();
  const READER_SOURCE_CLAIMS_KEY = "workspaceReaderSourceClaims:v1";
  interface ReaderSourceClaim {
    documentId: string;
    windowId: number;
    sourceTabId: number;
    fileId: string;
    accountId: string;
  }
  let readerSourceClaimWrites = Promise.resolve();
  const readReaderSourceClaims = async (): Promise<ReaderSourceClaim[]> => {
    try {
      const session = workspaceSessionStorage();
      if (!session) return [];
      const record = objectValue(
        (await session.get(READER_SOURCE_CLAIMS_KEY))[READER_SOURCE_CLAIMS_KEY],
      );
      if (
        !record ||
        !exactKeys(record, ["version", "extensionId", "claims"]) ||
        record.version !== 1 ||
        record.extensionId !== browser.runtime.id ||
        !Array.isArray(record.claims) ||
        record.claims.length > MAX_LOCAL_READER_OWNERS
      )
        return [];
      const claims: ReaderSourceClaim[] = [];
      for (const value of record.claims) {
        const claim = objectValue(value);
        if (
          !claim ||
          !exactKeys(claim, [
            "documentId",
            "windowId",
            "sourceTabId",
            "fileId",
            "accountId",
          ]) ||
          typeof claim.documentId !== "string" ||
          !/^[A-Za-z0-9._:-]{1,128}$/.test(claim.documentId) ||
          !isSafeId(claim.windowId) ||
          !isSafeId(claim.sourceTabId) ||
          typeof claim.fileId !== "string" ||
          !/^[A-Za-z0-9_-]{1,512}$/.test(claim.fileId) ||
          typeof claim.accountId !== "string" ||
          !claim.accountId ||
          claim.accountId.length > 256
        )
          return [];
        claims.push(claim as unknown as ReaderSourceClaim);
      }
      return claims;
    } catch {
      return [];
    }
  };
  const updateReaderSourceClaims = (
    update: (claims: ReaderSourceClaim[]) => ReaderSourceClaim[],
  ) => {
    readerSourceClaimWrites = readerSourceClaimWrites
      .catch(() => undefined)
      .then(async () => {
        const session = workspaceSessionStorage();
        if (!session) return;
        const claims = update(await readReaderSourceClaims()).slice(
          -MAX_LOCAL_READER_OWNERS,
        );
        if (!claims.length) await session.remove(READER_SOURCE_CLAIMS_KEY);
        else
          await session.set({
            [READER_SOURCE_CLAIMS_KEY]: {
              version: 1,
              extensionId: browser.runtime.id,
              claims,
            },
          });
      })
      .catch(() => undefined);
    return readerSourceClaimWrites;
  };
  const bindOpenedReaderDocument = async (
    windowId: number,
    before: ReturnType<typeof readerPanelContexts>,
  ) => {
    await readerDocumentWindowsReady;
    if (
      !unresolvedReaderOpenWindows.has(windowId) &&
      unresolvedReaderOpenWindows.size < MAX_LOCAL_READER_OWNERS
    )
      unresolvedReaderOpenWindows.set(windowId, before);
    try {
      const previous = new Set(
        (await before).map((context) => context.documentId),
      );
      const current = await readerPanelContexts();
      lastReaderPanelSnapshot = Promise.resolve(current);
      const currentIds = new Set(current.map((context) => context.documentId));
      let pruned = false;
      for (const id of readerDocumentWindows.keys())
        if (!currentIds.has(id)) {
          readerDocumentWindows.delete(id);
          pruned = true;
        }
      if (pruned) {
        readerDocumentRegistryRevision += 1;
        await persistReaderDocumentWindows();
      }
      const created = current.filter(
        (context) => !previous.has(context.documentId),
      );
      if (created.length !== 1) return;
      const documentId = created[0]!.documentId!;
      if (readerDocumentWindows.has(documentId)) {
        if (readerDocumentWindows.get(documentId) === windowId)
          unresolvedReaderOpenWindows.delete(windowId);
        return;
      }
      if (readerDocumentWindows.size >= MAX_LOCAL_READER_OWNERS) return;
      if (unresolvedReaderOpenWindows.size !== 1) return;
      readerDocumentWindows.set(documentId, windowId);
      readerDocumentRegistryRevision += 1;
      await persistReaderDocumentWindows();
      unresolvedReaderOpenWindows.delete(windowId);
    } catch {
      // Missing or ambiguous browser identity fails closed at Context binding.
    }
  };
  let lastReaderPanelSnapshot = readerPanelContexts().catch(() => []);
  const readerWindowActivations = new Map<number, object>();
  let globalReaderOptions: Promise<void> | undefined;
  let desiredGlobalReaderEnabled: boolean | undefined;
  const configureGlobalReader = (enabled: boolean) => {
    if (desiredGlobalReaderEnabled === enabled)
      return globalReaderOptions ?? Promise.resolve();
    desiredGlobalReaderEnabled = enabled;
    const panel = readerPanelApi();
    if (!panel?.setOptions) return Promise.resolve();
    const pending = (globalReaderOptions ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => panel.setOptions({ path: "reader.html", enabled }))
      .catch((error) => {
        if (globalReaderOptions === pending)
          desiredGlobalReaderEnabled = undefined;
        throw error;
      })
      .finally(() => {
        if (globalReaderOptions === pending) globalReaderOptions = undefined;
      });
    globalReaderOptions = pending;
    return pending;
  };
  const closeReaderWindow = async (windowId: number) => {
    await updateReaderSourceClaims((claims) =>
      claims.filter((claim) => claim.windowId !== windowId),
    );
    readerDocumentRegistryRevision += 1;
    unresolvedReaderOpenWindows.delete(windowId);
    for (const [owner, binding] of readerDocumentBindings)
      if (binding.windowId === windowId) readerDocumentBindings.delete(owner);
    for (const [id, actualWindow] of readerDocumentWindows)
      if (actualWindow === windowId) readerDocumentWindows.delete(id);
    await persistReaderDocumentWindows();
    const wasOpen = openReaderWindows.delete(windowId);
    const panel = readerPanelApi();
    if (panel?.close) {
      await panel.close({ windowId }).catch(() => undefined);
    } else if (
      wasOpen ||
      [...workspaceSourceWindows.values()].includes(windowId)
    ) {
      // ponytail: legacy Chromium lacks window close; disabling the global panel closes all Reader windows.
      await configureGlobalReader(false);
      openReaderWindows.clear();
    }
  };
  const prepareReaderToolbar = (tabId: number, url?: string) => {
    const route = {};
    toolbarRoutes.set(tabId, route);
    const pending = (toolbarRouteWrites.get(tabId) ?? Promise.resolve())
      .then(async () => {
        if (toolbarRoutes.get(tabId) !== route) return;
        const parsed = url ? parseWorkspaceEditorUrl(url) : null;
        const panel = readerPanelApi();
        // Flag off: Sheets keeps the popup, which shows the launch notice.
        const supported = parsed?.kind === "sheets" && workspaceReaderEnabled();
        const direct =
          supported &&
          toolbarAuthenticated &&
          Boolean(panel?.open && panel.setOptions);
        const routeKey = `${Boolean(supported)}:${Boolean(direct)}:${Boolean(panel)}`;
        try {
          if (supported) await configureGlobalReader(true);
          if (appliedToolbarRoutes.get(tabId) === routeKey) return;
          await browser.action.setPopup({
            tabId,
            popup: direct ? "" : "popup.html",
          });
          appliedToolbarRoutes.set(tabId, routeKey);
        } catch {
          await Promise.resolve()
            .then(() => browser.action.setPopup({ tabId, popup: "popup.html" }))
            .catch(() => undefined);
        }
      })
      .finally(() => {
        if (toolbarRouteWrites.get(tabId) === pending)
          toolbarRouteWrites.delete(tabId);
      });
    toolbarRouteWrites.set(tabId, pending);
    return pending;
  };
  const refreshReaderToolbar = () =>
    void browser.tabs
      .query({})
      .then((tabs) =>
        Promise.all(
          tabs.map((tab) =>
            tab.id === undefined
              ? undefined
              : prepareReaderToolbar(tab.id, tab.url),
          ),
        ),
      )
      .catch(() => undefined);
  const assertGeneration = (generation: number) => {
    if (generation !== auth.getGeneration()) throw new AuthRequiredError();
  };
  /** ADR 0020: no session to verify; protected work runs as the local user. */
  const authorize = async () => {
    // Path decisions read the provider settings, which a restarted worker
    // loads from IndexedDB first.
    await providerSettings.ready();
    return { user: LOCAL_USER, generation: auth.getGeneration() };
  };
  /**
   * Engine the next translation starts from (ADR 0020), for the popup. Never
   * carries the key.
   */
  const engineStatus = () => {
    const state = providerSettings.engineState();
    return {
      engineSource: chooseEngineSource(state),
      providerKeyRejected: state.keyRejected,
    };
  };
  /** Feature detection where on-device translation runs (this worker). */
  const onDeviceTranslation = () => ({
    onDeviceTranslation: onDeviceTranslatorSupported()
      ? ("supported" as const)
      : ("unsupported" as const),
  });
  const authError = (error: unknown) => {
    const code = (error as { code?: string } | null)?.code;
    return code === "AUTH_REQUIRED"
      ? ("auth-required" as const)
      : code === "AUTH_UNAVAILABLE"
        ? ("auth-unavailable" as const)
        : undefined;
  };
  const rememberNativeOwner = (sender: RunSender, ownerKey: string) => {
    const tabId = sender.tab?.id;
    if (tabId === undefined) return;
    const owners = nativeOwnersByTab.get(tabId) ?? new Set<string>();
    owners.add(ownerKey);
    nativeOwnersByTab.set(tabId, owners);
  };
  const clearNativeOwnersForTab = (tabId: number) => {
    for (const ownerKey of nativeOwnersByTab.get(tabId) ?? [])
      nativeTranslator.clearOwner(ownerKey);
    nativeOwnersByTab.delete(tabId);
  };
  const runKey = (sender: RunSender, runId: unknown) =>
    `${sender.tab?.id ?? "none"}:${sender.frameId ?? 0}:${sender.documentId ?? "document?"}:${typeof runId === "number" ? runId : "?"}`;
  const assertRunContext = (
    sender: RunSender,
    runId: unknown,
    generation: number,
  ) => {
    assertGeneration(generation);
    if (activeRunIdsByOwner.get(nativeOwnerKey(sender)) !== runId)
      throw new AuthRequiredError();
  };
  const contextForRun = async (
    sender: RunSender,
    runId: unknown,
    refresh = false,
  ) => {
    const generation = auth.getGeneration();
    const key = runKey(sender, runId);
    const existing = runContexts.get(key);
    if (!refresh && existing?.generation === generation) return existing;
    if (!refresh && runId !== undefined) throw new AuthRequiredError();
    const tabId = sender.tab?.id;
    const sourceLanguageHint = resolveTrustedSourceLanguage({
      detected: await detectTabLanguage(tabId),
      htmlLang: tabId === undefined ? undefined : storedHtmlLang(tabId),
    });
    const context = {
      cacheEpoch: pageCacheEpoch,
      generation,
      ...(sourceLanguageHint ? { sourceLanguageHint } : {}),
    };
    assertGeneration(generation);
    if (
      typeof runId === "number" &&
      activeRunIdsByOwner.get(nativeOwnerKey(sender)) !== runId
    )
      throw new AuthRequiredError();
    if (typeof runId === "number") runContexts.set(key, context);
    return context;
  };
  const activeRunContext = (sender: RunSender, runId: unknown) => {
    if (
      !Number.isInteger(runId) ||
      activeRunIdsByOwner.get(nativeOwnerKey(sender)) !== runId
    )
      return undefined;
    return runContexts.get(runKey(sender, runId));
  };
  const clearRunContextsForTab = (tabId: number) => {
    const prefix = `${tabId}:`;
    for (const key of runContexts.keys())
      if (key.startsWith(prefix)) runContexts.delete(key);
    for (const key of activeRunIdsByOwner.keys())
      if (key.startsWith(prefix)) activeRunIdsByOwner.delete(key);
  };
  const isTarget = (value: unknown): value is TargetLanguage =>
    TARGET_LANGUAGES.some((language) => language.code === value);
  const isStringMatrix = (value: unknown): value is string[][] =>
    Array.isArray(value) &&
    value.every(
      (row) =>
        Array.isArray(row) && row.every((item) => typeof item === "string"),
    );
  const objectValue = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const integer = (value: unknown) =>
    Number.isSafeInteger(value) && (value as number) >= 0
      ? (value as number)
      : null;
  const positiveInteger = (value: unknown) => {
    const parsed = integer(value);
    return parsed !== null && parsed > 0 ? parsed : null;
  };
  const columnName = (index: number) => {
    let name = "";
    for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26))
      name = String.fromCharCode(65 + ((value - 1) % 26)) + name;
    return name;
  };
  const escapedSheetTitle = (title: string) => title.replaceAll("'", "''");
  const sheetRange = (title: string, rectangle: SheetRectangle) =>
    `'${escapedSheetTitle(title)}'!${columnName(rectangle.startColumn)}${rectangle.startRow + 1}:${columnName(rectangle.startColumn + rectangle.columnCount - 1)}${rectangle.startRow + rectangle.rowCount}`;
  const sheetColumnRange = (title: string, lastColumn: number) =>
    `'${escapedSheetTitle(title)}'!A:${columnName(lastColumn)}`;
  const sheetFromResponse = (
    input: unknown,
    context: WorkspaceEditorContext,
  ) => {
    const root = objectValue(input);
    if (
      !root ||
      !Array.isArray(root.sheets) ||
      (root.spreadsheetId !== undefined &&
        root.spreadsheetId !== context.fileId)
    )
      throw new WorkspaceReaderFailure("invalid-request");
    const activeSheetId =
      context.activeId === null ? null : Number(context.activeId);
    const sheets = root.sheets.map(objectValue);
    const matches = sheets.filter((sheet) => {
      const sheetId = integer(objectValue(sheet?.properties)?.sheetId);
      return activeSheetId === null || sheetId === activeSheetId;
    });
    if ((activeSheetId !== null && matches.length !== 1) || !matches[0])
      throw new WorkspaceReaderFailure("source-tab-changed");
    return matches[0];
  };
  const parseSheetMetadata = (
    input: unknown,
    sourceContext: WorkspaceEditorContext,
    knownSheets?: WorkspaceReaderSheetDescriptor[],
  ): SheetMetadata => {
    const sheets =
      knownSheets ??
      parseWorkspaceReaderSheetCatalog(input, sourceContext.fileId);
    if (!sheets) throw new WorkspaceReaderFailure("invalid-request");
    const requestedContext =
      sourceContext.activeId === null
        ? { ...sourceContext, activeId: sheets[0]!.sheetId }
        : sourceContext;
    const sheet = sheetFromResponse(input, requestedContext);
    const properties = objectValue(sheet.properties);
    const grid = objectValue(properties?.gridProperties);
    const sheetId = integer(properties?.sheetId);
    const rowCount = positiveInteger(grid?.rowCount);
    const columnCount = positiveInteger(grid?.columnCount);
    const frozenRowCount = integer(grid?.frozenRowCount ?? 0);
    const frozenColumnCount = integer(grid?.frozenColumnCount ?? 0);
    if (properties?.sheetType !== "GRID")
      throw new WorkspaceReaderFailure("unsupported-file-type");
    if (
      sheetId === null ||
      typeof properties.title !== "string" ||
      !properties.title ||
      rowCount === null ||
      columnCount === null ||
      frozenRowCount === null ||
      frozenRowCount > rowCount ||
      frozenColumnCount === null ||
      frozenColumnCount > columnCount ||
      (properties.rightToLeft !== undefined &&
        typeof properties.rightToLeft !== "boolean") ||
      (grid?.hideGridlines !== undefined &&
        typeof grid?.hideGridlines !== "boolean")
    )
      throw new WorkspaceReaderFailure("invalid-request");
    if (!sheets.some((candidate) => candidate.sheetId === String(sheetId)))
      throw new WorkspaceReaderFailure("source-tab-changed");
    return {
      context: { ...requestedContext, activeId: String(sheetId) },
      sheets,
      title: properties.title,
      rowCount,
      columnCount,
      frozenRowCount,
      frozenColumnCount,
      rightToLeft: properties.rightToLeft === true,
      hideGridlines: grid?.hideGridlines === true,
    };
  };
  const sameSheetMetadata = (left: SheetMetadata, right: SheetMetadata) =>
    sameWorkspaceContext(left.context, right.context) &&
    left.title === right.title &&
    left.rowCount === right.rowCount &&
    left.columnCount === right.columnCount &&
    left.frozenRowCount === right.frozenRowCount &&
    left.frozenColumnCount === right.frozenColumnCount &&
    left.rightToLeft === right.rightToLeft &&
    left.hideGridlines === right.hideGridlines;
  const splitRectangle = (range: SheetRectangle) => {
    const byRows = range.rowCount > 1;
    const size = byRows ? range.rowCount : range.columnCount;
    if (size <= 1) return null;
    const first = Math.floor(size / 2);
    return byRows
      ? [
          { ...range, rowCount: first },
          {
            ...range,
            startRow: range.startRow + first,
            rowCount: range.rowCount - first,
          },
        ]
      : [
          { ...range, columnCount: first },
          {
            ...range,
            startColumn: range.startColumn + first,
            columnCount: range.columnCount - first,
          },
        ];
  };
  const splitRowDiscoveryRectangle = (range: SheetRectangle) => {
    if (range.rowCount <= 1) return splitRectangle(range);
    const upperCount = Math.floor(range.rowCount / 2);
    return [
      {
        ...range,
        startRow: range.startRow + upperCount,
        rowCount: range.rowCount - upperCount,
      },
      { ...range, rowCount: upperCount },
    ];
  };
  const discoveryFragment = (
    input: unknown,
    generation: number,
    range: SheetRectangle,
    axis: WorkspaceSheetDiscoveryAxis,
  ): WorkspaceSheetDiscoveryFragment => {
    const response = objectValue(input);
    const majorDimension = axis === "columns" ? "COLUMNS" : "ROWS";
    if (
      !response ||
      !Object.keys(response).every((key) =>
        ["majorDimension", "range", "values"].includes(key),
      ) ||
      (response.majorDimension !== undefined &&
        response.majorDimension !== majorDimension) ||
      (response.range !== undefined && typeof response.range !== "string") ||
      (response.values !== undefined && !Array.isArray(response.values))
    )
      throw new WorkspaceReaderFailure("invalid-request");
    const values = (response.values ?? []) as unknown[];
    if (
      values.length > (axis === "columns" ? range.columnCount : range.rowCount)
    )
      throw new WorkspaceReaderFailure("invalid-request");
    let lastUsedColumn: number | null = null;
    let lastUsedRow: number | null = null;
    values.forEach((line, outerOffset) => {
      if (
        !Array.isArray(line) ||
        line.length >
          (axis === "columns" ? range.rowCount : range.columnCount) ||
        line.some(
          (value) =>
            (typeof value !== "string" &&
              typeof value !== "number" &&
              typeof value !== "boolean") ||
            (typeof value === "number" && !Number.isFinite(value)),
        )
      )
        throw new WorkspaceReaderFailure("invalid-request");
      line.forEach((value, innerOffset) => {
        if (value === "") return;
        const column =
          range.startColumn + (axis === "columns" ? outerOffset : innerOffset);
        const row =
          range.startRow + (axis === "columns" ? innerOffset : outerOffset);
        lastUsedColumn = Math.max(lastUsedColumn ?? -1, column);
        lastUsedRow = Math.max(lastUsedRow ?? -1, row);
      });
    });
    return { generation, ...range, lastUsedColumn, lastUsedRow };
  };
  const emptySheetGrid = (
    state: WorkspaceDiscoveryState,
  ): WorkspaceSheetGrid => ({
    sheetId: state.metadata.context.activeId!,
    title: state.metadata.title,
    generation: state.generation,
    rowCount: state.metadata.rowCount,
    lastUsedColumn: -1,
    columns: [],
    frozenRowCount: state.metadata.frozenRowCount,
    frozenColumnCount: 0,
    rightToLeft: state.metadata.rightToLeft,
    hideGridlines: state.metadata.hideGridlines,
    merges: [],
    defaultStyle: defaultWorkspaceSheetCellStyle(),
    defaultRowPixelSize: WORKSPACE_SHEET_DEFAULT_ROW_PIXEL_SIZE,
    defaultColumnPixelSize: WORKSPACE_SHEET_DEFAULT_COLUMN_PIXEL_SIZE,
  });
  const parseGridMetadata = (
    input: unknown,
    state: WorkspaceDiscoveryState,
  ): WorkspaceSheetGrid => {
    const metadata = parseSheetMetadata(
      input,
      state.metadata.context,
      state.metadata.sheets,
    );
    if (!sameSheetMetadata(metadata, state.metadata))
      throw new WorkspaceReaderFailure("source-tab-changed");
    const sheet = sheetFromResponse(input, metadata.context);
    const properties = objectValue(sheet.properties)!;
    const gridProperties = objectValue(properties.gridProperties)!;
    if (
      (sheet.merges !== undefined && !Array.isArray(sheet.merges)) ||
      (sheet.data !== undefined && !Array.isArray(sheet.data))
    )
      throw new WorkspaceReaderFailure("invalid-request");
    const mergedColumns = mergeWorkspaceSheetDiscoveryFragments(
      state.generation,
      state.fragments,
    );
    if (!mergedColumns) throw new WorkspaceReaderFailure("invalid-request");
    const lastUsedColumn = Math.max(0, state.rightmost ?? -1);
    if (state.lastUsedRow === null)
      throw new WorkspaceReaderFailure("invalid-request");
    const rowCount = state.lastUsedRow + 1;
    const columns = new Map(
      mergedColumns.map((column) => [column.index, column]),
    );
    for (const blockInput of (sheet.data ?? []) as unknown[]) {
      const block = objectValue(blockInput);
      const startColumn = integer(block?.startColumn ?? 0);
      if (
        !block ||
        startColumn === null ||
        (block.columnMetadata !== undefined &&
          !Array.isArray(block.columnMetadata))
      )
        throw new WorkspaceReaderFailure("invalid-request");
      for (const [offset, inputColumn] of (
        (block.columnMetadata ?? []) as unknown[]
      ).entries()) {
        const index = startColumn + offset;
        if (index > lastUsedColumn) continue;
        const column = objectValue(inputColumn);
        const pixelSize =
          column?.pixelSize === undefined
            ? 100
            : positiveInteger(column.pixelSize);
        if (
          !column ||
          pixelSize === null ||
          (column.hiddenByUser !== undefined &&
            typeof column.hiddenByUser !== "boolean")
        )
          throw new WorkspaceReaderFailure("invalid-request");
        columns.set(index, {
          index,
          pixelSize,
          hidden: column.hiddenByUser === true,
        });
      }
    }
    const merges = ((sheet.merges ?? []) as unknown[]).flatMap((inputMerge) => {
      const merge = objectValue(inputMerge);
      const startRow = integer(merge?.startRowIndex);
      const endRow = positiveInteger(merge?.endRowIndex);
      const startColumn = integer(merge?.startColumnIndex);
      const endColumn = positiveInteger(merge?.endColumnIndex);
      if (
        !merge ||
        startRow === null ||
        endRow === null ||
        startColumn === null ||
        endColumn === null
      )
        throw new WorkspaceReaderFailure("invalid-request");
      if (startRow >= rowCount || startColumn > lastUsedColumn) return [];
      return [
        {
          startRow,
          endRow: Math.min(endRow, rowCount),
          startColumn,
          endColumn: Math.min(endColumn, lastUsedColumn + 1),
        },
      ];
    });
    const root = objectValue(input);
    const rootProperties = objectValue(root?.properties);
    if (
      root?.properties !== undefined &&
      (!rootProperties ||
        !Object.keys(rootProperties).every((key) =>
          ["defaultFormat", "spreadsheetTheme"].includes(key),
        ))
    )
      throw new WorkspaceReaderFailure("invalid-request");
    const theme = parseGoogleSheetsTheme(rootProperties?.spreadsheetTheme);
    const defaultStyle = theme
      ? resolveGoogleDefaultStyle(rootProperties?.defaultFormat, theme)
      : null;
    if (!defaultStyle) throw new WorkspaceReaderFailure("invalid-request");
    const grid = parseWorkspaceSheetGrid({
      sheetId: metadata.context.activeId,
      title: metadata.title,
      generation: state.generation,
      rowCount,
      lastUsedColumn,
      columns: [...columns.values()],
      frozenRowCount: Math.min(
        integer(gridProperties.frozenRowCount ?? 0) ?? 0,
        rowCount,
      ),
      frozenColumnCount: Math.min(
        integer(gridProperties.frozenColumnCount ?? 0) ?? 0,
        lastUsedColumn + 1,
      ),
      rightToLeft: properties.rightToLeft ?? false,
      hideGridlines: gridProperties.hideGridlines ?? false,
      merges,
      defaultStyle,
      defaultRowPixelSize: WORKSPACE_SHEET_DEFAULT_ROW_PIXEL_SIZE,
      defaultColumnPixelSize: WORKSPACE_SHEET_DEFAULT_COLUMN_PIXEL_SIZE,
    });
    if (!grid) throw new WorkspaceReaderFailure("invalid-request");
    return grid;
  };
  const scanningProgress = (
    state: WorkspaceDiscoveryState,
  ): WorkspaceSheetDiscoveryProgress => ({
    status: "scanning",
    axis: state.axis,
    scanned: state.scanned,
    total:
      state.axis === "columns"
        ? state.metadata.columnCount
        : state.metadata.rowCount,
    cursor: { kind: "sheets-discovery", token: state.token },
  });
  const startRowDiscovery = (state: WorkspaceDiscoveryState) => {
    state.phase = "rows";
    state.axis = "rows";
    state.scanned = 0;
    state.lastUsedRow = null;
    state.chunkCount = Math.min(100, state.metadata.rowCount);
    state.chunkStart = state.metadata.rowCount - state.chunkCount;
    state.chunkWasSplit = false;
    state.pending.push({
      startRow: state.chunkStart,
      rowCount: state.chunkCount,
      startColumn: 0,
      columnCount: state.rightmost! + 1,
    });
  };
  const nextDiscoveryChunk = (state: WorkspaceDiscoveryState) => {
    if (state.pending.length) return;
    state.scanned += state.chunkCount;
    if (state.phase === "rows") {
      if (state.lastUsedRow !== null) {
        state.phase = "grid";
        return;
      }
      if (state.scanned >= state.metadata.rowCount)
        throw new WorkspaceReaderFailure("source-tab-changed");
      const end = state.chunkStart;
      const nextCount = Math.min(end, state.chunkCount * 2);
      state.chunkStart = end - nextCount;
      state.chunkCount = nextCount;
      state.chunkWasSplit = false;
      state.pending.push({
        startRow: state.chunkStart,
        rowCount: state.chunkCount,
        startColumn: 0,
        columnCount: state.rightmost! + 1,
      });
      return;
    }
    state.columnCoverageStart = Math.min(
      state.columnCoverageStart,
      state.chunkStart,
    );
    if (
      state.rightmost !== null ||
      state.scanned >= state.metadata.columnCount
    ) {
      if (state.rightmost === null) state.phase = "grid";
      else if (state.columnCoverageStart === 0) {
        state.lastUsedRow = state.provisionalLastUsedRow;
        if (state.lastUsedRow === null)
          throw new WorkspaceReaderFailure("invalid-request");
        state.phase = "grid";
      } else startRowDiscovery(state);
      return;
    }
    const end = state.chunkStart;
    // Grow only after the entire previous chunk was confirmed empty.
    const nextCount = state.chunkWasSplit
      ? 32
      : Math.min(512, state.chunkCount * 2);
    state.chunkStart = Math.max(0, end - nextCount);
    state.chunkCount = end - state.chunkStart;
    state.chunkWasSplit = false;
    state.pending.push({
      startRow: 0,
      rowCount: state.metadata.rowCount,
      startColumn: state.chunkStart,
      columnCount: state.chunkCount,
    });
  };
  const pageFragment = async (
    input: unknown,
    state: WorkspaceLoadedState,
    range: SheetRectangle,
  ): Promise<WorkspaceSheetPageFragment> => {
    const grid = state.grid;
    if (!grid) throw new WorkspaceReaderFailure("invalid-request");
    const parsed = await parseSheetsPage(
      input,
      state.context,
      range.startRow + 1,
    );
    if (!parsed.ok) throw new WorkspaceReaderFailure(parsed.error);
    if (!sameWorkspaceContext(parsed.context, state.context))
      throw new WorkspaceReaderFailure("source-tab-changed");
    const records = new Map(
      parsed.records.map((record) => [record.anchor, record]),
    );
    const sheet = sheetFromResponse(input, state.context);
    if (sheet.data !== undefined && !Array.isArray(sheet.data))
      throw new WorkspaceReaderFailure("invalid-request");
    const theme = parseGoogleSheetsTheme(
      objectValue(objectValue(input)?.properties)?.spreadsheetTheme,
    );
    if (!theme) throw new WorkspaceReaderFailure("invalid-request");
    const rows = new Map<number, WorkspaceSheetRow>();
    for (const blockInput of (sheet.data ?? []) as unknown[]) {
      const block = objectValue(blockInput);
      const startRow = integer(block?.startRow ?? range.startRow);
      const startColumn = integer(block?.startColumn ?? range.startColumn);
      if (
        !block ||
        startRow === null ||
        startColumn === null ||
        !Array.isArray(block.rowData ?? []) ||
        !Array.isArray(block.rowMetadata ?? [])
      )
        throw new WorkspaceReaderFailure("invalid-request");
      const rowData = (block.rowData ?? []) as unknown[];
      const rowMetadata = (block.rowMetadata ?? []) as unknown[];
      if (
        startRow < range.startRow ||
        startColumn < range.startColumn ||
        startRow + Math.max(rowData.length, rowMetadata.length) >
          range.startRow + range.rowCount
      )
        throw new WorkspaceReaderFailure("invalid-request");
      for (
        let offset = 0;
        offset < Math.max(rowData.length, rowMetadata.length);
        offset += 1
      ) {
        const index = startRow + offset;
        const inputRow = objectValue(rowData[offset] ?? {});
        const metadata = objectValue(rowMetadata[offset] ?? {});
        if (
          !inputRow ||
          !metadata ||
          !Array.isArray(inputRow.values ?? []) ||
          (metadata.pixelSize !== undefined &&
            positiveInteger(metadata.pixelSize) === null) ||
          (metadata.hiddenByUser !== undefined &&
            typeof metadata.hiddenByUser !== "boolean")
        )
          throw new WorkspaceReaderFailure("invalid-request");
        const previous = rows.get(index);
        const pixelSize =
          (metadata.pixelSize as number | undefined) ??
          grid.defaultRowPixelSize;
        const hidden = metadata.hiddenByUser === true;
        if (
          previous &&
          (previous.pixelSize !== pixelSize || previous.hidden !== hidden)
        )
          throw new WorkspaceReaderFailure("invalid-request");
        const row: WorkspaceSheetRow = previous ?? {
          index,
          pixelSize,
          hidden,
          cells: [],
        };
        const occupied = new Set(row.cells.map((cell) => cell.columnIndex));
        for (const [columnOffset, cellInput] of (
          (inputRow.values ?? []) as unknown[]
        ).entries()) {
          const columnIndex = startColumn + columnOffset;
          if (
            columnIndex < range.startColumn ||
            columnIndex >= range.startColumn + range.columnCount ||
            occupied.has(columnIndex)
          )
            throw new WorkspaceReaderFailure("invalid-request");
          const cell = objectValue(cellInput);
          const anchor = `${columnName(columnIndex)}${index + 1}`;
          const record = records.get(anchor);
          const merge = grid.merges.find(
            (candidate) =>
              index >= candidate.startRow &&
              index < candidate.endRow &&
              columnIndex >= candidate.startColumn &&
              columnIndex < candidate.endColumn,
          );
          if (
            !cell ||
            !record ||
            (merge &&
              (index !== merge.startRow || columnIndex !== merge.startColumn))
          )
            continue;
          // An omitted effectiveFormat means "the spreadsheet default".
          const style = resolveGoogleCellFormat(
            cell.effectiveFormat,
            grid.defaultStyle,
            theme,
          );
          if (!style) throw new WorkspaceReaderFailure("invalid-request");
          if (
            record.kind === "blank" &&
            Object.keys(cell).length === 0 &&
            !merge
          )
            continue;
          row.cells.push({
            ...record,
            rowIndex: index,
            columnIndex,
            rowSpan: merge ? merge.endRow - merge.startRow : 1,
            columnSpan: merge ? merge.endColumn - merge.startColumn : 1,
            style,
          });
          occupied.add(columnIndex);
        }
        row.cells.sort((left, right) => left.columnIndex - right.columnIndex);
        rows.set(index, row);
      }
    }
    return {
      sheetId: grid.sheetId,
      generation: grid.generation,
      ...range,
      rows: [...rows.values()].sort((left, right) => left.index - right.index),
    };
  };
  const loadSheetPage = async (
    state: WorkspaceLoadedState,
    startRow: number,
    token: string,
  ) => {
    const grid = state.grid;
    if (!grid) throw new WorkspaceReaderFailure("invalid-request");
    if (grid.lastUsedColumn === -1) {
      if (startRow !== 0) throw new WorkspaceReaderFailure("invalid-request");
      return {
        sheetId: grid.sheetId,
        generation: grid.generation,
        startRow: 0,
        rowCount: Math.min(SHEETS_PAGE_ROWS, grid.rowCount),
        rows: [],
        cursor: null,
      } satisfies WorkspaceSheetPage;
    }
    const rowCount = Math.min(SHEETS_PAGE_ROWS, grid.rowCount - startRow);
    const pending: SheetRectangle[] = [
      {
        startRow,
        rowCount,
        startColumn: 0,
        columnCount: grid.lastUsedColumn + 1,
      },
    ];
    const fragments: WorkspaceSheetPageFragment[] = [];
    while (pending.length) {
      const range = pending[0]!;
      try {
        const response = await googleJson(
          sheetsPageUrl(state.context.fileId, sheetRange(grid.title, range)),
          token,
        );
        fragments.push(await pageFragment(response, state, range));
        pending.shift();
      } catch (error) {
        if (!(error instanceof WorkspaceReaderFailure) || !error.splitRange)
          throw error;
        const split = splitRectangle(range);
        if (!split) throw error;
        pending.splice(0, 1, ...split);
      }
    }
    const count = fragments.reduce(
      (total, fragment) =>
        total + fragment.rows.reduce((sum, row) => sum + row.cells.length, 0),
      0,
    );
    const sourceCharacters = fragments.reduce(
      (total, fragment) =>
        total +
        fragment.rows.reduce(
          (sum, row) =>
            sum +
            row.cells.reduce(
              (cellTotal, cell) =>
                cellTotal + workspaceRecordTranslationSource(cell).length,
              0,
            ),
          0,
        ),
      0,
    );
    if (
      count > MAX_LOADED_RECORDS ||
      sourceCharacters > MAX_LOADED_SOURCE_CHARACTERS
    )
      throw new WorkspaceReaderFailure("content-too-large");
    const page = mergeWorkspaceSheetPageFragments(grid, startRow, fragments);
    if (!page) throw new WorkspaceReaderFailure("invalid-request");
    return page;
  };
  const pageRecords = (page: WorkspaceSheetPage) =>
    page.rows.flatMap((row) => row.cells);
  const commitResidentPage = (
    state: WorkspaceLoadedState,
    page: WorkspaceSheetPage,
    advanceCursor = true,
  ) => {
    const pages = new Map(state.pages);
    if (pages.has(page.startRow))
      throw new WorkspaceReaderFailure("invalid-request");
    pages.set(page.startRow, page);
    const resident = () => [...pages.values()].flatMap(pageRecords);
    while (
      resident().length > MAX_LOADED_RECORDS ||
      resident().reduce(
        (total, record) =>
          total + workspaceRecordTranslationSource(record).length,
        0,
      ) > MAX_LOADED_SOURCE_CHARACTERS
    ) {
      const candidates = [...pages.keys()].filter(
        (start) => start !== page.startRow,
      );
      if (!candidates.length)
        throw new WorkspaceReaderFailure("content-too-large");
      candidates.sort(
        (left, right) =>
          Math.abs(right - page.startRow) - Math.abs(left - page.startRow),
      );
      pages.delete(candidates[0]!);
    }
    state.pages = pages;
    state.records = new Map(
      resident().map((record) => [record.id, record as WorkspaceRecord]),
    );
    if (advanceCursor) state.cursor = page.cursor;
  };
  const sameCursor = (left: WorkspaceLoadCursor, right: WorkspaceLoadCursor) =>
    left === null || right === null
      ? left === right
      : left.kind === right.kind &&
        (left.kind === "sheets" && right.kind === "sheets"
          ? left.nextRow === right.nextRow
          : left.kind === "docs" && right.kind === "docs"
            ? left.tabId === right.tabId
            : false);
  const assertWorkspaceStillCurrent = async (
    expected: WorkspaceEditorContext,
    authGeneration: number,
    expectedVersion: WorkspaceSourceVersion,
    document?: { documentId: string; windowId: number },
  ) => {
    assertGeneration(authGeneration);
    const current = await currentWorkspaceContext(expected.sourceTabId);
    if (
      !sameWorkspaceContext(expected, current) ||
      !sameWorkspaceSourceVersion(
        expectedVersion,
        workspaceSourceVersion(expected.sourceTabId),
      )
    )
      throw new WorkspaceReaderFailure("source-tab-changed");
    if (
      document &&
      !(await readerDocumentWindow(
        {
          url: browser.runtime.getURL("/reader.html" as never),
          documentId: document.documentId,
        },
        expected.sourceTabId,
      ))
    )
      throw new WorkspaceReaderFailure("source-tab-changed");
  };
  const startSheetDiscovery = async (
    sourceContext: WorkspaceEditorContext,
    selectedContext: WorkspaceEditorContext,
    authGeneration: number,
    sourceVersion: WorkspaceSourceVersion,
    token: string,
    discoveryToken: string,
    readerInstanceId: string,
  ) => {
    if (sourceContext.kind !== "sheets")
      throw new WorkspaceReaderFailure("unsupported-file-type");
    const input = await googleJson(
      sheetsMetadataUrl(sourceContext.fileId),
      token,
    );
    const metadata = parseSheetMetadata(input, selectedContext);
    const chunkStart = Math.max(0, metadata.columnCount - 32);
    const state: WorkspaceDiscoveryState = {
      readerInstanceId,
      token: discoveryToken,
      generation: ++workspaceGeneration,
      authGeneration,
      sourceVersion,
      sourceContext,
      metadata,
      chunkStart,
      chunkCount: metadata.columnCount - chunkStart,
      chunkWasSplit: false,
      scanned: 0,
      pending: [
        {
          startRow: 0,
          rowCount: metadata.rowCount,
          startColumn: chunkStart,
          columnCount: metadata.columnCount - chunkStart,
        },
      ],
      fragments: [],
      rightmost: null,
      provisionalLastUsedRow: null,
      lastUsedRow: null,
      columnCoverageStart: metadata.columnCount,
      axis: "columns",
      phase: "columns",
      busy: false,
    };
    return { state, progress: scanningProgress(state) };
  };
  const completeSheetDiscovery = async (
    state: WorkspaceDiscoveryState,
    token: string,
  ) => {
    const grid =
      state.rightmost === null
        ? emptySheetGrid(state)
        : parseGridMetadata(
            await googleJson(
              sheetsGridMetadataUrl(
                state.metadata.context.fileId,
                sheetColumnRange(state.metadata.title, state.rightmost),
              ),
              token,
            ),
            state,
          );
    return {
      state,
      progress: {
        status: "complete",
        grid,
      } satisfies WorkspaceSheetDiscoveryProgress,
    };
  };
  const continueSheetDiscovery = async (
    state: WorkspaceDiscoveryState,
    token: string,
  ) => {
    if (state.busy) throw new WorkspaceReaderFailure("invalid-request");
    state.busy = true;
    try {
      if (state.phase === "grid")
        return await completeSheetDiscovery(state, token);
      const range = state.pending[0];
      if (!range) throw new WorkspaceReaderFailure("invalid-request");
      try {
        const input = await googleJson(
          sheetsValuesUrl(
            state.metadata.context.fileId,
            sheetRange(state.metadata.title, range),
            state.phase,
          ),
          token,
          state.phase === "rows",
        );
        const axis = state.phase;
        const fragment = discoveryFragment(
          input,
          state.generation,
          range,
          axis,
        );
        state.fragments.push(fragment);
        if (axis === "columns") {
          if (fragment.lastUsedColumn !== null)
            state.rightmost = Math.max(
              state.rightmost ?? -1,
              fragment.lastUsedColumn,
            );
          if (fragment.lastUsedRow !== null)
            state.provisionalLastUsedRow = Math.max(
              state.provisionalLastUsedRow ?? -1,
              fragment.lastUsedRow,
            );
        } else if (fragment.lastUsedRow !== null) {
          state.lastUsedRow = Math.max(
            state.lastUsedRow ?? -1,
            fragment.lastUsedRow,
          );
        }
        state.pending.shift();
        if (axis === "rows" && state.lastUsedRow !== null)
          state.pending.length = 0;
        nextDiscoveryChunk(state);
      } catch (error) {
        if (!(error instanceof WorkspaceReaderFailure) || !error.splitRange)
          throw error;
        const split =
          state.phase === "rows"
            ? splitRowDiscoveryRectangle(range)
            : splitRectangle(range);
        if (!split) throw error;
        state.chunkWasSplit = true;
        state.pending.splice(0, 1, ...split);
      }
      if (state.pending.length === 0)
        return await completeSheetDiscovery(state, token);
      return { state, progress: scanningProgress(state) };
    } finally {
      state.busy = false;
    }
  };
  const loadWorkspace = async (
    request: Extract<WorkspaceReaderRequest, { type: "WORKSPACE_READER_LOAD" }>,
    sourceContext: WorkspaceEditorContext,
    authGeneration: number,
    token: string,
  ): Promise<WorkspaceLoadExecution> => {
    if (sourceContext.kind === "sheets") {
      if (request.cursor?.kind === "docs")
        throw new WorkspaceReaderFailure("invalid-request");
      const existing = findWorkspaceStateBySource(
        sourceContext,
        request.readerInstanceId,
      );
      if (
        !existing ||
        !existing.grid ||
        !existing.sheetMetadata ||
        !existing.pages
      )
        throw new WorkspaceReaderFailure("source-tab-changed");
      const startRow = request.cursor?.nextRow ?? 0;
      const advancesCursor =
        request.cursor === null
          ? existing.pages.size === 0
          : sameCursor(existing.cursor, request.cursor);
      if (
        existing.authGeneration !== authGeneration ||
        existing.pendingPage ||
        existing.pages.has(startRow) ||
        startRow % SHEETS_PAGE_ROWS !== 0 ||
        startRow >= existing.grid.rowCount
      )
        throw new WorkspaceReaderFailure("invalid-request");
      const pendingPage = `${existing.generation}:${startRow}`;
      existing.pendingPage = pendingPage;
      try {
        const metadata = parseSheetMetadata(
          await googleJson(sheetsMetadataUrl(sourceContext.fileId), token),
          existing.sheetMetadata.context,
          existing.sheetMetadata.sheets,
        );
        if (!sameSheetMetadata(metadata, existing.sheetMetadata))
          throw new WorkspaceReaderFailure("source-tab-changed");
        const page = await loadSheetPage(existing, startRow, token);
        if (
          !sameWorkspaceSourceVersion(
            existing.sourceVersion,
            workspaceSourceVersion(sourceContext.sourceTabId),
          )
        )
          throw new WorkspaceReaderFailure("source-tab-changed");
        if (
          workspaceStates.get(
            workspaceStateKey(existing.context, existing.readerInstanceId),
          ) !== existing ||
          existing.pendingPage !== pendingPage
        )
          throw new WorkspaceReaderFailure("invalid-request");
        commitResidentPage(existing, page, advancesCursor);
        return {
          state: existing,
          records: pageRecords(page),
          cursor: page.cursor,
          page,
        };
      } finally {
        if (existing.pendingPage === pendingPage)
          existing.pendingPage = undefined;
      }
    }

    if (request.cursor?.kind === "sheets")
      throw new WorkspaceReaderFailure("invalid-request");
    let docsContext = sourceContext;
    const docsCursor = request.cursor?.kind === "docs" ? request.cursor : null;
    if (docsCursor) {
      const existing = findWorkspaceStateBySource(
        sourceContext,
        request.readerInstanceId,
      );
      if (!existing) throw new WorkspaceReaderFailure("source-tab-changed");
      if (
        !existing.tabs?.some((tab) => tab.id === docsCursor.tabId) ||
        existing.authGeneration !== authGeneration
      )
        throw new WorkspaceReaderFailure("invalid-request");
      docsContext = { ...sourceContext, activeId: docsCursor.tabId };
    }
    const document = await googleJson(docsUrl(sourceContext.fileId), token);
    const parsed = await parseDocsTabs(document, docsContext);
    if (!parsed.ok) throw new WorkspaceReaderFailure(parsed.error);
    return {
      state: {
        readerInstanceId: request.readerInstanceId,
        generation: ++workspaceGeneration,
        authGeneration,
        sourceVersion: request.version,
        sourceContext,
        context: parsed.context,
        title: parsed.title,
        records: new Map(parsed.records.map((record) => [record.id, record])),
        cursor: parsed.cursor,
        tabs: parsed.tabs,
      } satisfies WorkspaceLoadedState,
      records: parsed.records,
      cursor: parsed.cursor,
      tabs: parsed.tabs,
    };
  };
  const readerError = (
    type: WorkspaceReaderRequest["type"],
    owner: { readerInstanceId: string; requestId: number },
    error: WorkspaceReaderErrorCode,
    version?: WorkspaceSourceVersion,
  ): WorkspaceReaderResponse =>
    ({
      type,
      readerInstanceId: owner.readerInstanceId,
      requestId: owner.requestId,
      ...(type === "WORKSPACE_READER_CONTEXT" ? {} : { version }),
      ok: false,
      error,
    }) as WorkspaceReaderResponse;
  const trustedReaderSender = (
    senderUrl: string | undefined,
    sourceTabId: number,
  ) => {
    if (!senderUrl) return false;
    try {
      const expected = new URL(browser.runtime.getURL("/reader.html" as never));
      const actual = new URL(senderUrl);
      if (
        actual.protocol !== expected.protocol ||
        actual.host !== expected.host ||
        actual.pathname !== expected.pathname ||
        actual.hash ||
        actual.username ||
        actual.password
      )
        return false;
      return (
        actual.search === "" ||
        trustedGoogleDriveOfficeSender(senderUrl) === sourceTabId
      );
    } catch {
      return false;
    }
  };
  /**
   * The extension-owned Reader page (side panel or extension tab) by exact
   * origin and path. It authenticates the surface only; data access still
   * needs the mode-specific checks below.
   */
  const extensionReaderPageSender = (senderUrl: string | undefined) => {
    if (!senderUrl) return false;
    try {
      const expected = new URL(browser.runtime.getURL("/reader.html" as never));
      const actual = new URL(senderUrl);
      return (
        actual.protocol === expected.protocol &&
        actual.host === expected.host &&
        actual.pathname === expected.pathname &&
        !actual.hash &&
        !actual.username &&
        !actual.password
      );
    } catch {
      return false;
    }
  };
  const trustedLocalReaderSender = (senderUrl: string | undefined) => {
    if (!senderUrl || !extensionReaderPageSender(senderUrl)) return false;
    if (new URL(senderUrl).search === "?local=1") return true;
    return trustedGoogleDriveOfficeSender(senderUrl) !== null;
  };
  interface GoogleDriveOfficePort {
    name: string;
    sender?: {
      id?: string;
      url?: string;
      documentId?: string;
      tab?: { id?: number; windowId?: number };
    };
    postMessage(message: GoogleDriveOfficePortMessage): void;
    disconnect(): void;
    onMessage: { addListener(listener: (message: unknown) => void): void };
    onDisconnect: { addListener(listener: () => void): void };
  }
  interface GoogleDriveOfficeDownload {
    request: GoogleDriveOfficeStartRequest;
    port: GoogleDriveOfficePort;
    controller: AbortController;
    timeout?: ReturnType<typeof setTimeout>;
    binding?: ReaderDocumentBinding;
  }
  interface GoogleDriveOfficeMetadata {
    fileName: string;
    mimeType: string;
    byteLength: number;
    modifiedTime: string;
    md5Checksum: string | null;
  }
  class GoogleDriveOfficeFailure extends Error {
    constructor(readonly code: GoogleDriveOfficeErrorCode) {
      super(code);
    }
  }
  const googleDriveOfficeDownloads = new Map<
    string,
    GoogleDriveOfficeDownload
  >();
  const runningGoogleDriveOfficeDownloads =
    new Set<GoogleDriveOfficeDownload>();
  const officeDownloadOwner = (
    request: Pick<
      GoogleDriveOfficeStartRequest,
      "readerInstanceId" | "sourceTabId"
    >,
  ) => `${request.readerInstanceId}:${request.sourceTabId}`;
  const isCurrentOfficeDownload = (state: GoogleDriveOfficeDownload) =>
    googleDriveOfficeDownloads.get(officeDownloadOwner(state.request)) ===
    state;
  const googleDriveOfficeRequestIds = new Map<string, number>();
  const GOOGLE_DRIVE_OFFICE_TIMEOUT_MS = 30_000;
  const GOOGLE_DRIVE_METADATA_MAX_BYTES = 32 * 1024;
  const sameGoogleDriveOfficeRequest = (
    left: GoogleDriveOfficeStartRequest,
    right: Pick<
      GoogleDriveOfficeStartRequest,
      "readerInstanceId" | "requestId" | "sourceTabId" | "version"
    >,
  ) =>
    left.readerInstanceId === right.readerInstanceId &&
    left.requestId === right.requestId &&
    left.sourceTabId === right.sourceTabId &&
    sameWorkspaceSourceVersion(left.version, right.version);
  type GoogleDriveOfficeMessageBody =
    GoogleDriveOfficePortMessage extends infer Message
      ? Message extends GoogleDriveOfficePortMessage
        ? Omit<
            Message,
            "readerInstanceId" | "requestId" | "sourceTabId" | "version"
          >
        : never
      : never;
  const googleDriveOfficeMessage = (
    request: GoogleDriveOfficeStartRequest,
    message: GoogleDriveOfficeMessageBody,
  ) =>
    ({
      ...message,
      readerInstanceId: request.readerInstanceId,
      requestId: request.requestId,
      sourceTabId: request.sourceTabId,
      version: request.version,
    }) as GoogleDriveOfficePortMessage;
  const terminateGoogleDriveOfficeDownload = (
    state: GoogleDriveOfficeDownload,
    error?: GoogleDriveOfficeErrorCode,
  ) => {
    if (!isCurrentOfficeDownload(state)) return;
    googleDriveOfficeDownloads.delete(officeDownloadOwner(state.request));
    clearTimeout(state.timeout);
    if (error) {
      try {
        state.port.postMessage(
          googleDriveOfficeMessage(state.request, {
            type: "GOOGLE_DRIVE_OFFICE_ERROR",
            error,
          }),
        );
      } catch {
        // The trusted Reader may already have disconnected.
      }
    }
    state.controller.abort();
  };
  abortGoogleDriveOfficeDownload = (error) => {
    for (const state of googleDriveOfficeDownloads.values())
      terminateGoogleDriveOfficeDownload(state, error);
  };
  const trustedGoogleDriveOfficeSender = (
    senderUrl: string | undefined,
  ): number | null => {
    if (!senderUrl) return null;
    try {
      const expected = new URL(browser.runtime.getURL("/reader.html" as never));
      const actual = new URL(senderUrl);
      const sourceTabId = actual.searchParams.get("sourceTabId") ?? "";
      const awaitStart = actual.searchParams.get("awaitStart");
      const readerSheetId = actual.searchParams.get("readerSheetId");
      const canonical = `?sourceTabId=${sourceTabId}${awaitStart === "1" ? "&awaitStart=1" : ""}${readerSheetId !== null ? `&readerSheetId=${readerSheetId}` : ""}`;
      if (
        actual.protocol !== expected.protocol ||
        actual.host !== expected.host ||
        actual.pathname !== expected.pathname ||
        (actual.search !== canonical &&
          actual.search !== `?office=1&sourceTabId=${sourceTabId}`) ||
        (readerSheetId !== null &&
          (!/^(?:0|[1-9]\d*)$/.test(readerSheetId) ||
            !Number.isSafeInteger(Number(readerSheetId)))) ||
        !/^[1-9]\d*$/.test(sourceTabId) ||
        actual.hash ||
        actual.username ||
        actual.password
      )
        return null;
      const parsed = Number(sourceTabId);
      return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
    } catch {
      return null;
    }
  };
  const readerDocumentWindow = async (
    sender: { url?: string; documentId?: string; tab?: unknown },
    sourceTabId: number,
  ): Promise<{ documentId: string; windowId: number } | null> => {
    if (
      !trustedReaderSender(sender.url, sourceTabId) ||
      (!sender.documentId && sender.tab)
    )
      return null;
    if (typeof browser.runtime.getContexts !== "function") return null;
    try {
      const reported = await browser.runtime.getContexts(
        sender.documentId
          ? {
              documentIds: [sender.documentId],
              contextTypes: ["SIDE_PANEL"],
            }
          : {},
      );
      if (!Array.isArray(reported)) return null;
      const contexts = sender.documentId
        ? reported
        : reported.filter((context) => {
            try {
              const expected = new URL(
                browser.runtime.getURL("/reader.html" as never),
              );
              const actual = new URL(context.documentUrl ?? "");
              return (
                actual.origin === expected.origin &&
                actual.pathname === expected.pathname
              );
            } catch {
              return false;
            }
          });
      if (!Array.isArray(contexts) || contexts.length !== 1) return null;
      const context = contexts[0];
      if (
        !context ||
        !context.documentId ||
        (sender.documentId !== undefined &&
          context.documentId !== sender.documentId) ||
        context.contextType !== "SIDE_PANEL" ||
        !Number.isSafeInteger(context.windowId) ||
        !trustedReaderSender(context.documentUrl, sourceTabId)
      )
        return null;
      const source = await browser.tabs.get(sourceTabId);
      if (typeof source.windowId !== "number") return null;
      // A first claim must come from the window's active tab. A pane whose
      // tab was already bound by this same document keeps working after the
      // user switches to another tab; window membership is checked below.
      let alreadyBound = [...readerDocumentBindings.values()].some(
        (binding) =>
          binding.sourceContext.sourceTabId === sourceTabId &&
          binding.documentId === context.documentId &&
          binding.windowId === source.windowId,
      );
      if (!alreadyBound) {
        await readerSourceClaimWrites;
        const parsed = parseWorkspaceEditorUrl(source.url ?? "");
        const claim = (await readReaderSourceClaims()).find(
          (candidate) =>
            candidate.documentId === context.documentId &&
            candidate.sourceTabId === sourceTabId &&
            candidate.windowId === source.windowId &&
            parsed?.kind === "sheets" &&
            candidate.fileId === parsed.fileId,
        );
        if (claim) {
          const auth = await authorize();
          alreadyBound = auth.user.user.id === claim.accountId;
        }
      }
      if (!alreadyBound) {
        const activeTabs = await browser.tabs.query({
          active: true,
          windowId: source.windowId,
        });
        if (activeTabs.length !== 1 || activeTabs[0]?.id !== sourceTabId)
          return null;
      }
      await pendingReaderOpenBindings.get(source.windowId);
      await readerDocumentWindowsReady;
      let windowId =
        context.windowId >= 0
          ? context.windowId
          : readerDocumentWindows.get(context.documentId);
      if (windowId === undefined && unresolvedReaderOpenWindows.size === 1) {
        const [openedWindow, before] = [...unresolvedReaderOpenWindows][0]!;
        await bindOpenedReaderDocument(openedWindow, before);
        windowId = readerDocumentWindows.get(context.documentId);
      }
      return source.id === sourceTabId && source.windowId === windowId
        ? { documentId: context.documentId, windowId }
        : null;
    } catch (error) {
      if (authError(error)) throw error;
      return null;
    }
  };
  const trustedReaderTabWindow = async (
    sender: { url?: string; tab?: { id?: number } },
    sourceTabId: number,
  ) => {
    if (
      sender.tab?.id === undefined ||
      trustedGoogleDriveOfficeSender(sender.url) !== sourceTabId
    )
      return false;
    try {
      const [host, source] = await Promise.all([
        browser.tabs.get(sender.tab.id),
        browser.tabs.get(sourceTabId),
      ]);
      return (
        host.id === sender.tab.id &&
        source.id === sourceTabId &&
        typeof source.windowId === "number" &&
        host.windowId === source.windowId &&
        trustedGoogleDriveOfficeSender(host.url) === sourceTabId
      );
    } catch {
      return false;
    }
  };
  const resolveReaderDocumentBinding = async (
    sender: { url?: string; documentId?: string; tab?: unknown },
    readerInstanceId: string,
    sourceTabId?: number,
  ) => {
    const matches = [...readerDocumentBindings].filter(
      ([key, binding]) =>
        key ===
          workspaceSelectionKey(
            readerInstanceId,
            binding.sourceContext.sourceTabId,
          ) &&
        (sender.documentId === undefined ||
          binding.documentId === sender.documentId) &&
        (sourceTabId === undefined ||
          binding.sourceContext.sourceTabId === sourceTabId),
    );
    if (matches.length !== 1) return null;
    const [owner, binding] = matches[0]!;
    const document = await readerDocumentWindow(
      sender,
      binding.sourceContext.sourceTabId,
    );
    if (
      !document ||
      document.documentId !== binding.documentId ||
      document.windowId !== binding.windowId ||
      readerDocumentBindings.get(owner) !== binding ||
      !sameWorkspaceSourceVersion(
        binding.sourceVersion,
        workspaceSourceVersion(binding.sourceContext.sourceTabId),
      )
    )
      return null;
    return binding;
  };
  const googleDriveOfficeMetadataUrl = (fileId: string) => {
    const url = new URL(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`,
    );
    url.searchParams.set(
      "fields",
      "id,name,mimeType,size,modifiedTime,md5Checksum,capabilities(canDownload)",
    );
    url.searchParams.set("supportsAllDrives", "true");
    return url;
  };
  const googleDriveOfficeMediaUrl = (fileId: string) => {
    const url = new URL(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`,
    );
    url.searchParams.set("alt", "media");
    url.searchParams.set("supportsAllDrives", "true");
    return url;
  };
  const fetchGoogleDriveOffice = async (
    url: URL,
    token: string,
    signal: AbortSignal,
  ) => {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new GoogleDriveOfficeFailure("temporarily-unavailable");
    }
    let finalUrl: URL;
    try {
      finalUrl = new URL(response.url);
    } catch {
      throw new GoogleDriveOfficeFailure("invalid-response");
    }
    if (
      finalUrl.protocol !== "https:" ||
      (finalUrl.hostname !== "www.googleapis.com" &&
        !finalUrl.hostname.endsWith(".googleusercontent.com")) ||
      finalUrl.port ||
      finalUrl.username ||
      finalUrl.password
    )
      throw new GoogleDriveOfficeFailure("invalid-response");
    if (response.status === 401) {
      await evictGoogleToken(token);
      throw new GoogleDriveOfficeFailure("google-auth-required");
    }
    if (response.status === 403 || response.status === 404)
      throw new GoogleDriveOfficeFailure("google-access-denied");
    if (
      response.status === 408 ||
      response.status === 429 ||
      response.status >= 500
    )
      throw new GoogleDriveOfficeFailure("temporarily-unavailable");
    if (!response.ok || response.status !== 200)
      throw new GoogleDriveOfficeFailure("invalid-response");
    return response;
  };
  const readGoogleDriveMetadata = async (response: Response) => {
    const declaredLength = response.headers.get("content-length");
    if (
      declaredLength !== null &&
      (!/^\d+$/.test(declaredLength) ||
        Number(declaredLength) > GOOGLE_DRIVE_METADATA_MAX_BYTES)
    )
      throw new GoogleDriveOfficeFailure("invalid-response");
    if (!response.body) throw new GoogleDriveOfficeFailure("invalid-response");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > GOOGLE_DRIVE_METADATA_MAX_BYTES) {
        await reader.cancel();
        throw new GoogleDriveOfficeFailure("invalid-response");
      }
      chunks.push(value);
    }
    if (size === 0) throw new GoogleDriveOfficeFailure("invalid-response");
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let input: unknown;
    try {
      input = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch {
      throw new GoogleDriveOfficeFailure("invalid-response");
    }
    if (input === null || typeof input !== "object" || Array.isArray(input))
      throw new GoogleDriveOfficeFailure("invalid-response");
    return input as Record<string, unknown>;
  };
  /**
   * Launch identification with only the `spreadsheets.readonly` Sheets API
   * (ADR 0015). The Sheets API refuses a Drive-stored Office workbook opened
   * in the Sheets editor, which then needs the download guidance.
   */
  const identifySheetsSource = async (
    context: WorkspaceEditorContext,
    token: string,
  ) => {
    const url = new URL(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(context.fileId)}`,
    );
    url.searchParams.set("includeGridData", "false");
    url.searchParams.set("fields", "spreadsheetId,properties(title)");
    let metadata: unknown;
    try {
      metadata = await googleJson(url, token);
    } catch (error) {
      if (
        error instanceof WorkspaceReaderFailure &&
        error.code === "unsupported-file-type"
      )
        throw new WorkspaceReaderFailure("office-download-required");
      throw error;
    }
    const record =
      metadata !== null &&
      typeof metadata === "object" &&
      !Array.isArray(metadata)
        ? (metadata as {
            spreadsheetId?: unknown;
            properties?: { title?: unknown } | null;
          })
        : undefined;
    const title = record?.properties?.title;
    if (
      record?.spreadsheetId !== context.fileId ||
      typeof title !== "string" ||
      !title ||
      title.length > 1000
    )
      throw new WorkspaceReaderFailure("invalid-request");
    return { sourceKind: "native" as const, sourceTitle: title };
  };
  const identifyWorkspaceSource = async (
    context: WorkspaceEditorContext,
    token: string,
  ) => {
    if (context.kind !== "sheets") return {};
    if (!driveOfficeReaderEnabled())
      return identifySheetsSource(context, token);
    const url = googleDriveOfficeMetadataUrl(context.fileId);
    url.searchParams.set("fields", "id,name,mimeType");
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      GOOGLE_REQUEST_TIMEOUT_MS,
    );
    try {
      const response = await fetchGoogleDriveOffice(
        url,
        token,
        controller.signal,
      );
      const metadata = await readGoogleDriveMetadata(response);
      if (
        metadata.id !== context.fileId ||
        typeof metadata.name !== "string" ||
        !metadata.name ||
        metadata.name.length > 1000 ||
        typeof metadata.mimeType !== "string"
      )
        throw new WorkspaceReaderFailure("invalid-request");
      const sourceKind =
        metadata.mimeType === "application/vnd.google-apps.spreadsheet"
          ? ("native" as const)
          : isGoogleDriveOfficeFile(metadata.name, metadata.mimeType)
            ? ("office" as const)
            : null;
      if (!sourceKind)
        throw new WorkspaceReaderFailure("unsupported-file-type");
      return { sourceKind, sourceTitle: metadata.name };
    } catch (error) {
      if (error instanceof GoogleDriveOfficeFailure)
        throw new WorkspaceReaderFailure(
          error.code === "invalid-response"
            ? "invalid-request"
            : error.code === "temporarily-unavailable"
              ? "temporarily-unavailable"
              : error.code === "google-auth-required"
                ? "google-auth-required"
                : "google-access-denied",
        );
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };
  const parseGoogleDriveOfficeMetadata = async (
    response: Response,
    expectedFileId: string,
  ): Promise<GoogleDriveOfficeMetadata> => {
    const metadata = await readGoogleDriveMetadata(response);
    if (
      metadata.id !== expectedFileId ||
      typeof metadata.name !== "string" ||
      typeof metadata.mimeType !== "string" ||
      typeof metadata.size !== "string" ||
      !/^(?:0|[1-9]\d*)$/.test(metadata.size) ||
      typeof metadata.modifiedTime !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(
        metadata.modifiedTime,
      ) ||
      !Number.isFinite(Date.parse(metadata.modifiedTime)) ||
      metadata.capabilities === null ||
      typeof metadata.capabilities !== "object" ||
      Array.isArray(metadata.capabilities) ||
      typeof (metadata.capabilities as { canDownload?: unknown })
        .canDownload !== "boolean" ||
      (metadata.md5Checksum !== undefined &&
        (typeof metadata.md5Checksum !== "string" ||
          !/^[a-f0-9]{32}$/.test(metadata.md5Checksum)))
    )
      throw new GoogleDriveOfficeFailure("invalid-response");
    if (!isGoogleDriveOfficeFile(metadata.name, metadata.mimeType))
      throw new GoogleDriveOfficeFailure("unsupported-file-type");
    if (!(metadata.capabilities as { canDownload: boolean }).canDownload)
      throw new GoogleDriveOfficeFailure("download-not-allowed");
    const byteLength = Number(metadata.size);
    if (!Number.isSafeInteger(byteLength) || byteLength <= 0)
      throw new GoogleDriveOfficeFailure("invalid-response");
    if (byteLength > MAX_GOOGLE_DRIVE_OFFICE_BYTES)
      throw new GoogleDriveOfficeFailure("file-too-large");
    return {
      fileName: metadata.name,
      mimeType: metadata.mimeType,
      byteLength,
      modifiedTime: metadata.modifiedTime,
      md5Checksum: (metadata.md5Checksum as string | undefined) ?? null,
    };
  };
  const mapGoogleDriveOfficeError = (
    error: unknown,
  ): GoogleDriveOfficeErrorCode => {
    if (error instanceof GoogleDriveOfficeFailure) return error.code;
    const managed = authError(error);
    if (managed) return managed;
    if (error instanceof WorkspaceReaderFailure) {
      if (
        error.code === "source-tab-changed" ||
        error.code === "unsupported-url"
      )
        return "source-tab-changed";
      if (error.code === "google-auth-required") return "google-auth-required";
      if (error.code === "google-access-denied") return "google-access-denied";
      if (error.code === "google-oauth-expired") return "google-oauth-expired";
      if (error.code === "google-oauth-scope") return "google-oauth-scope";
      if (
        error.code === "temporarily-unavailable" ||
        error.code === "rate-limited" ||
        error.code === "google-oauth-network"
      )
        return "temporarily-unavailable";
    }
    return "invalid-response";
  };
  const runGoogleDriveOfficeDownload = async (
    state: GoogleDriveOfficeDownload,
  ) => {
    let managedGeneration: number | undefined;
    try {
      const initialAuth = await authorize();
      managedGeneration = initialAuth.generation;
      if (
        state.binding &&
        (state.binding.authGeneration !== managedGeneration ||
          state.binding.accountId !== initialAuth.user.user.id ||
          readerDocumentBindings.get(
            workspaceSelectionKey(
              state.request.readerInstanceId,
              state.request.sourceTabId,
            ),
          ) !== state.binding)
      )
        throw new GoogleDriveOfficeFailure("reader-channel-unavailable");
      const sourceContext = await currentWorkspaceContext(
        state.request.sourceTabId,
      );
      if (
        sourceContext.kind !== "sheets" ||
        !sameWorkspaceSourceVersion(
          state.request.version,
          workspaceSourceVersion(state.request.sourceTabId),
        )
      )
        throw new WorkspaceReaderFailure("source-tab-changed");
      await assertWorkspaceStillCurrent(
        sourceContext,
        managedGeneration,
        state.request.version,
        state.binding,
      );
      const token = await googleToken(false, initialAuth.user.user.id);
      const metadataResponse = await fetchGoogleDriveOffice(
        googleDriveOfficeMetadataUrl(sourceContext.fileId),
        token,
        state.controller.signal,
      );
      const metadata = await parseGoogleDriveOfficeMetadata(
        metadataResponse,
        sourceContext.fileId,
      );
      if (!isCurrentOfficeDownload(state))
        throw new WorkspaceReaderFailure("source-tab-changed");
      await assertWorkspaceStillCurrent(
        sourceContext,
        managedGeneration,
        state.request.version,
        state.binding,
      );
      state.port.postMessage(
        googleDriveOfficeMessage(state.request, {
          type: "GOOGLE_DRIVE_OFFICE_METADATA",
          ...metadata,
        }),
      );

      const mediaResponse = await fetchGoogleDriveOffice(
        googleDriveOfficeMediaUrl(sourceContext.fileId),
        token,
        state.controller.signal,
      );
      const declaredLength = mediaResponse.headers.get("content-length");
      if (
        declaredLength !== null &&
        (!/^\d+$/.test(declaredLength) ||
          Number(declaredLength) !== metadata.byteLength)
      )
        throw new GoogleDriveOfficeFailure("invalid-response");
      if (!mediaResponse.body)
        throw new GoogleDriveOfficeFailure("invalid-response");
      const reader = mediaResponse.body.getReader();
      let byteLength = 0;
      let sequence = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.byteLength === 0) {
          await reader.cancel();
          throw new GoogleDriveOfficeFailure("invalid-response");
        }
        for (
          let offset = 0;
          offset < value.byteLength;
          offset += MAX_GOOGLE_DRIVE_OFFICE_CHUNK_BYTES
        ) {
          const chunk = value.subarray(
            offset,
            Math.min(
              offset + MAX_GOOGLE_DRIVE_OFFICE_CHUNK_BYTES,
              value.byteLength,
            ),
          );
          byteLength += chunk.byteLength;
          if (byteLength > MAX_GOOGLE_DRIVE_OFFICE_BYTES) {
            await reader.cancel();
            throw new GoogleDriveOfficeFailure("file-too-large");
          }
          if (byteLength > metadata.byteLength) {
            await reader.cancel();
            throw new GoogleDriveOfficeFailure("invalid-response");
          }
          if (!isCurrentOfficeDownload(state)) {
            await reader.cancel();
            return;
          }
          state.port.postMessage(
            googleDriveOfficeMessage(state.request, {
              type: "GOOGLE_DRIVE_OFFICE_CHUNK",
              sequence,
              data: encodeGoogleDriveOfficeChunk(chunk),
            }),
          );
          sequence += 1;
        }
      }
      if (byteLength !== metadata.byteLength)
        throw new GoogleDriveOfficeFailure("invalid-response");
      const currentAuth = await authorize();
      if (
        currentAuth.generation !== managedGeneration ||
        currentAuth.user.user.id !== initialAuth.user.user.id
      )
        throw new AuthRequiredError();
      await assertWorkspaceStillCurrent(
        sourceContext,
        managedGeneration,
        state.request.version,
        state.binding,
      );
      if (!isCurrentOfficeDownload(state)) return;
      state.port.postMessage(
        googleDriveOfficeMessage(state.request, {
          type: "GOOGLE_DRIVE_OFFICE_COMPLETE",
          chunkCount: sequence,
          byteLength,
        }),
      );
      googleDriveOfficeDownloads.delete(officeDownloadOwner(state.request));
      clearTimeout(state.timeout);
    } catch (error) {
      if (!isCurrentOfficeDownload(state)) return;
      let responseError = error;
      if (managedGeneration !== undefined) {
        try {
          assertGeneration(managedGeneration);
        } catch (generationError) {
          responseError = generationError;
        }
      }
      terminateGoogleDriveOfficeDownload(
        state,
        mapGoogleDriveOfficeError(responseError),
      );
    } finally {
      runningGoogleDriveOfficeDownloads.delete(state);
      drainGoogleDriveOfficeDownloads();
    }
  };
  const drainGoogleDriveOfficeDownloads = () => {
    for (const state of googleDriveOfficeDownloads.values()) {
      if (runningGoogleDriveOfficeDownloads.size >= 2) break;
      if (runningGoogleDriveOfficeDownloads.has(state)) continue;
      runningGoogleDriveOfficeDownloads.add(state);
      state.timeout = setTimeout(() => {
        terminateGoogleDriveOfficeDownload(state, "download-timeout");
      }, GOOGLE_DRIVE_OFFICE_TIMEOUT_MS);
      void runGoogleDriveOfficeDownload(state);
    }
  };
  const startGoogleDriveOfficeDownload = (
    port: GoogleDriveOfficePort,
    request: GoogleDriveOfficeStartRequest,
    binding?: ReaderDocumentBinding,
  ) => {
    // ADR 0015: no Drive scope at launch; Reader shows download guidance.
    if (!driveOfficeReaderEnabled()) {
      port.postMessage(
        googleDriveOfficeMessage(request, {
          type: "GOOGLE_DRIVE_OFFICE_ERROR",
          error: "office-download-required",
        }),
      );
      return;
    }
    const requestOwner = officeDownloadOwner(request);
    const previousRequestId = googleDriveOfficeRequestIds.get(requestOwner);
    if (
      previousRequestId !== undefined &&
      request.requestId <= previousRequestId
    ) {
      port.postMessage(
        googleDriveOfficeMessage(request, {
          type: "GOOGLE_DRIVE_OFFICE_ERROR",
          error: "invalid-request",
        }),
      );
      return;
    }
    if (
      previousRequestId === undefined &&
      googleDriveOfficeRequestIds.size >= 256
    ) {
      const oldest = googleDriveOfficeRequestIds.keys().next().value;
      if (oldest !== undefined) googleDriveOfficeRequestIds.delete(oldest);
    }
    const previous = googleDriveOfficeDownloads.get(requestOwner);
    if (previous)
      terminateGoogleDriveOfficeDownload(previous, "source-tab-changed");
    if (googleDriveOfficeDownloads.size >= 256) {
      port.postMessage(
        googleDriveOfficeMessage(request, {
          type: "GOOGLE_DRIVE_OFFICE_ERROR",
          error: "invalid-request",
        }),
      );
      return;
    }
    googleDriveOfficeRequestIds.set(requestOwner, request.requestId);
    const controller = new AbortController();
    const state: GoogleDriveOfficeDownload = {
      request,
      port,
      controller,
      binding,
    };
    googleDriveOfficeDownloads.set(requestOwner, state);
    drainGoogleDriveOfficeDownloads();
  };
  const handleGoogleDriveOfficePort = (rawPort: unknown) => {
    const port = rawPort as GoogleDriveOfficePort;
    if (port.name !== GOOGLE_DRIVE_OFFICE_PORT_NAME) return;
    const sourceTabId = trustedGoogleDriveOfficeSender(port.sender?.url);
    const globalReader =
      port.sender?.url === browser.runtime.getURL("/reader.html" as never);
    if (
      port.sender?.id !== browser.runtime.id ||
      (sourceTabId === null && !globalReader)
    ) {
      port.disconnect();
      return;
    }
    port.onDisconnect.addListener(() => {
      for (const state of googleDriveOfficeDownloads.values())
        if (state.port === port) terminateGoogleDriveOfficeDownload(state);
    });
    let disconnected = false;
    port.onDisconnect.addListener(() => {
      disconnected = true;
    });
    port.onMessage.addListener((input) => {
      const start = parseGoogleDriveOfficeStartRequest(input);
      if (start) {
        if (sourceTabId !== null && start.sourceTabId !== sourceTabId) {
          port.postMessage(
            googleDriveOfficeMessage(start, {
              type: "GOOGLE_DRIVE_OFFICE_ERROR",
              error: "invalid-request",
            }),
          );
          return;
        }
        if (!globalReader) {
          void trustedReaderTabWindow(
            port.sender ?? {},
            start.sourceTabId,
          ).then((trusted) => {
            if (disconnected) return;
            if (trusted) startGoogleDriveOfficeDownload(port, start);
            else
              port.postMessage(
                googleDriveOfficeMessage(start, {
                  type: "GOOGLE_DRIVE_OFFICE_ERROR",
                  error: "reader-channel-unavailable",
                }),
              );
          });
          return;
        }
        void (async () => {
          const owner = workspaceSelectionKey(
            start.readerInstanceId,
            start.sourceTabId,
          );
          const binding = await resolveReaderDocumentBinding(
            port.sender ?? {},
            start.readerInstanceId,
            start.sourceTabId,
          );
          if (disconnected) return;
          if (
            !binding ||
            !sameWorkspaceSourceVersion(binding.sourceVersion, start.version) ||
            !sameWorkspaceSourceVersion(
              start.version,
              workspaceSourceVersion(start.sourceTabId),
            ) ||
            readerDocumentBindings.get(owner) !== binding
          ) {
            port.postMessage(
              googleDriveOfficeMessage(start, {
                type: "GOOGLE_DRIVE_OFFICE_ERROR",
                error: "reader-channel-unavailable",
              }),
            );
            return;
          }
          startGoogleDriveOfficeDownload(port, start, binding);
        })();
        return;
      }
      const message = parseGoogleDriveOfficePortMessage(input);
      const active = message
        ? googleDriveOfficeDownloads.get(officeDownloadOwner(message))
        : [...googleDriveOfficeDownloads.values()].find(
            (state) => state.port === port,
          );
      if (
        message?.type === "GOOGLE_DRIVE_OFFICE_CANCEL" &&
        active?.port === port &&
        sameGoogleDriveOfficeRequest(active.request, message)
      ) {
        terminateGoogleDriveOfficeDownload(active);
        return;
      }
      if (active?.port === port)
        terminateGoogleDriveOfficeDownload(active, "invalid-request");
      else port.disconnect();
    });
  };
  try {
    browser.runtime.onConnect.addListener(handleGoogleDriveOfficePort);
  } catch {
    // The WXT fake browser used by message-only tests does not implement Ports.
  }
  const localReaderError = (
    owner: {
      readerInstanceId: string;
      requestId: number;
      generation: number;
    },
    error: LocalSpreadsheetTranslationErrorCode,
  ): LocalSpreadsheetTranslateResponse => ({
    type: "LOCAL_SPREADSHEET_TRANSLATE",
    readerInstanceId: owner.readerInstanceId,
    requestId: owner.requestId,
    generation: owner.generation,
    ok: false,
    error,
  });
  const handleLocalSpreadsheetTranslate = async (
    request: LocalSpreadsheetTranslateRequest,
    binding?: ReaderDocumentBinding,
  ): Promise<LocalSpreadsheetTranslateResponse> => {
    let managedGeneration: number | undefined;
    try {
      const initialAuth = await authorize();
      managedGeneration = initialAuth.generation;
      if (binding) {
        if (
          binding.authGeneration !== managedGeneration ||
          binding.accountId !== initialAuth.user.user.id
        )
          throw new AuthRequiredError();
        await assertWorkspaceStillCurrent(
          binding.sourceContext,
          managedGeneration,
          binding.sourceVersion,
          binding,
        );
        if (
          readerDocumentBindings.get(
            workspaceSelectionKey(
              request.readerInstanceId,
              binding.sourceContext.sourceTabId,
            ),
          ) !== binding
        )
          return localReaderError(request, "invalid-request");
      }
      const texts = request.records.map(({ text }) => text);
      let translated;
      try {
        // Without a usable provider key (ADR 0020) only saved translations
        // apply; the misses continue on-device below.
        const onDevice = translationPath() !== "provider";
        translated = onDevice
          ? await openai.translateText(texts, request.targetLanguage, {
              cacheOnly: true,
            })
          : await openai.translateText(texts, request.targetLanguage);
      } catch (error) {
        if (authError(error)) throw error;
        translated = {
          results: request.records.map(() => ""),
          failures: request.records.map((_, index) => ({ index })),
        };
      }
      // No usable key before or during this request (a rejected key): the
      // sheet keeps its translated cells and continues on-device; without
      // on-device support the misses stay unresolved and the Reader ends in
      // `partial`.
      if (translationPath() !== "provider") {
        const results = await translateTextsOnDevice(
          texts,
          translated.results,
          request.targetLanguage,
          `local-reader:${request.readerInstanceId}`,
          request.requestId,
        );
        assertGeneration(managedGeneration);
        translated = {
          results,
          failures: translated.failures.filter(({ index }) => !results[index]),
        };
      }

      const currentAuth = await authorize();
      if (
        currentAuth.generation !== managedGeneration ||
        currentAuth.user.user.id !== initialAuth.user.user.id
      )
        throw new AuthRequiredError();
      if (binding) {
        await assertWorkspaceStillCurrent(
          binding.sourceContext,
          managedGeneration,
          binding.sourceVersion,
          binding,
        );
        if (
          readerDocumentBindings.get(
            workspaceSelectionKey(
              request.readerInstanceId,
              binding.sourceContext.sourceTabId,
            ),
          ) !== binding
        )
          return localReaderError(request, "invalid-request");
      }
      const latest = localReaderRequests.get(request.readerInstanceId);
      if (
        !latest ||
        latest.requestId !== request.requestId ||
        latest.generation !== request.generation ||
        latest.request !== request
      )
        return localReaderError(request, "invalid-request");

      const failed = new Set(translated.failures.map(({ index }) => index));
      let responseUnits = 0;
      return {
        type: request.type,
        readerInstanceId: request.readerInstanceId,
        requestId: request.requestId,
        generation: request.generation,
        ok: true,
        results: request.records.map(({ id, sourceHash }, index) => {
          const text = translated.results[index];
          if (
            typeof text === "string" &&
            text.length > 0 &&
            text.length <= MAX_LOCAL_TRANSLATION_RESULT_UNITS &&
            responseUnits + text.length <= MAX_LOCAL_TRANSLATION_RESPONSE_UNITS
          ) {
            responseUnits += text.length;
            return { id, sourceHash, text };
          }
          return {
            id,
            sourceHash,
            error:
              failed.has(index) || (typeof text === "string" && text.length > 0)
                ? ("provider-error" as const)
                : ("unresolved" as const),
          };
        }),
      };
    } catch (error) {
      let responseError = error;
      if (managedGeneration !== undefined) {
        try {
          assertGeneration(managedGeneration);
        } catch (generationError) {
          responseError = generationError;
        }
      }
      return localReaderError(
        request,
        authError(responseError) ?? "invalid-request",
      );
    }
  };
  const handleWorkspaceRequest = async (
    request: WorkspaceReaderRequest,
    document?: { documentId: string; windowId: number },
  ): Promise<WorkspaceReaderResponse> => {
    const assertRequestStillCurrent = (
      context: WorkspaceEditorContext,
      generation: number,
      version: WorkspaceSourceVersion,
    ) => assertWorkspaceStillCurrent(context, generation, version, document);
    let managedGeneration: number | undefined;
    let responseVersion: WorkspaceSourceVersion;
    try {
      const initialAuth = await authorize();
      managedGeneration = initialAuth.generation;
      const managedAccountId = initialAuth.user.user.id;

      if (request.type === "WORKSPACE_READER_DISCONNECT") {
        abortGoogleDriveOfficeDownload("google-auth-required");
        clearAllWorkspaceStates();
        await disconnectGoogleToken();
        const currentAuth = await authorize();
        if (
          currentAuth.generation !== managedGeneration ||
          currentAuth.user.user.id !== initialAuth.user.user.id
        )
          throw new AuthRequiredError();
        return {
          type: request.type,
          readerInstanceId: request.readerInstanceId,
          requestId: request.requestId,
          version: request.version,
          ok: true,
          connected: false,
        };
      }

      let sourceContext: WorkspaceEditorContext;
      try {
        sourceContext = await currentWorkspaceContext(request.sourceTabId);
        responseVersion = workspaceSourceVersion(request.sourceTabId);
      } catch (error) {
        if (
          error instanceof WorkspaceReaderFailure &&
          error.code === "unsupported-url" &&
          (request.type === "WORKSPACE_READER_TRANSLATE" ||
            (request.type === "WORKSPACE_READER_DISCOVER" &&
              request.cursor !== null) ||
            (request.type === "WORKSPACE_READER_LOAD" &&
              request.cursor !== null))
        )
          throw new WorkspaceReaderFailure("source-tab-changed");
        throw error;
      }
      // The build flag gates every native Sheets Reader request (ADR 0020).
      if (!sheetsReaderEnabled())
        throw new WorkspaceReaderFailure("sheets-reader-unavailable");

      if (request.type === "WORKSPACE_READER_CONTEXT") {
        if (workspaceAuthMode() && !workspaceConfigured())
          throw new WorkspaceReaderFailure("unsupported-browser");
        const configured = workspaceConfigured();
        let connected = false;
        if (configured) {
          try {
            connected = Boolean(await googleToken(false, managedAccountId));
          } catch {
            connected = false;
          }
        }
        const { targetLanguage } = await readReaderPreferences();
        const identified =
          request.identifySource && connected
            ? await identifyWorkspaceSource(
                sourceContext,
                await googleToken(false, managedAccountId),
              )
            : {};
        const selection = workspaceSheetSelections.get(
          workspaceSelectionKey(request.readerInstanceId, request.sourceTabId),
        );
        let readerContext =
          selection?.authGeneration === managedGeneration &&
          sameWorkspaceSourceVersion(selection.sourceVersion, responseVersion)
            ? selection.context
            : sourceContext;
        let sheets: WorkspaceReaderSheetDescriptor[] | undefined;
        if (identified.sourceKind === "native") {
          const url = sheetsMetadataUrl(sourceContext.fileId);
          url.searchParams.set(
            "fields",
            "spreadsheetId,sheets(properties(sheetId,title,sheetType))",
          );
          sheets =
            parseWorkspaceReaderSheetCatalog(
              await googleJson(url, await googleToken(false, managedAccountId)),
              sourceContext.fileId,
            ) ?? undefined;
          if (!sheets) throw new WorkspaceReaderFailure("invalid-request");
          if (!sheets.some((sheet) => sheet.sheetId === readerContext.activeId))
            readerContext = { ...readerContext, activeId: sheets[0]!.sheetId };
        }
        const currentAuth = await authorize();
        if (
          currentAuth.generation !== managedGeneration ||
          currentAuth.user.user.id !== initialAuth.user.user.id
        )
          throw new AuthRequiredError();
        await assertRequestStillCurrent(
          sourceContext,
          managedGeneration,
          responseVersion,
        );
        if (sheets) {
          const owner = workspaceSelectionKey(
            request.readerInstanceId,
            request.sourceTabId,
          );
          if (readerRequestIds.get(owner) !== request.requestId)
            throw new WorkspaceReaderFailure("invalid-request");
          if (
            !workspaceSheetSelections.has(owner) &&
            workspaceSheetSelections.size >= MAX_LOCAL_READER_OWNERS
          ) {
            const oldest = workspaceSheetSelections.keys().next().value;
            if (oldest !== undefined) workspaceSheetSelections.delete(oldest);
          }
          workspaceSheetSelections.set(owner, {
            authGeneration: managedGeneration,
            sourceVersion: responseVersion,
            sourceContext,
            context: readerContext,
            sheets,
          });
        }
        if (document && connected) {
          const owner = workspaceSelectionKey(
            request.readerInstanceId,
            request.sourceTabId,
          );
          if (readerRequestIds.get(owner) !== request.requestId)
            throw new WorkspaceReaderFailure("invalid-request");
          if (
            !readerDocumentBindings.has(owner) &&
            readerDocumentBindings.size >= MAX_LOCAL_READER_OWNERS
          ) {
            const oldest = readerDocumentBindings.keys().next().value;
            if (oldest !== undefined) readerDocumentBindings.delete(oldest);
          }
          readerDocumentBindings.set(owner, {
            ...document,
            sourceContext,
            sourceVersion: responseVersion,
            authGeneration: managedGeneration,
            accountId: managedAccountId,
          });
          await updateReaderSourceClaims((claims) => [
            ...claims.filter(
              (claim) =>
                claim.documentId !== document.documentId ||
                claim.sourceTabId !== request.sourceTabId,
            ),
            {
              documentId: document.documentId,
              windowId: document.windowId,
              sourceTabId: request.sourceTabId,
              fileId: sourceContext.fileId,
              accountId: managedAccountId,
            },
          ]);
          assertGeneration(managedGeneration);
        }
        return {
          type: request.type,
          readerInstanceId: request.readerInstanceId,
          requestId: request.requestId,
          version: responseVersion,
          ok: true,
          configured,
          connected,
          context: readerContext,
          targetLanguage,
          ...identified,
          ...(sheets ? { sheets } : {}),
        };
      }

      if (!sameWorkspaceSourceVersion(request.version, responseVersion))
        throw new WorkspaceReaderFailure("source-tab-changed");

      if (request.type === "WORKSPACE_READER_CONNECT") {
        await googleToken(true, managedAccountId);
        const currentAuth = await authorize();
        if (
          currentAuth.generation !== managedGeneration ||
          currentAuth.user.user.id !== initialAuth.user.user.id
        )
          throw new AuthRequiredError();
        await assertRequestStillCurrent(
          sourceContext,
          managedGeneration,
          request.version,
        );
        return {
          type: request.type,
          readerInstanceId: request.readerInstanceId,
          requestId: request.requestId,
          version: request.version,
          ok: true,
          connected: true,
        };
      }

      if (request.type === "WORKSPACE_READER_SELECT_SHEET") {
        if (sourceContext.kind !== "sheets")
          throw new WorkspaceReaderFailure("unsupported-file-type");
        const token = await googleToken(false, managedAccountId);
        const input = await googleJson(
          sheetsMetadataUrl(sourceContext.fileId),
          token,
        );
        const sheets = parseWorkspaceReaderSheetCatalog(
          input,
          sourceContext.fileId,
        );
        if (!sheets) throw new WorkspaceReaderFailure("invalid-request");
        const selected = sheets.find(
          (sheet) => sheet.sheetId === request.sheetId,
        );
        if (!selected) throw new WorkspaceReaderFailure("invalid-request");
        const selectedContext = {
          ...sourceContext,
          activeId: selected.sheetId,
        };
        parseSheetMetadata(input, selectedContext, sheets);
        const currentAuth = await authorize();
        if (
          currentAuth.generation !== managedGeneration ||
          currentAuth.user.user.id !== initialAuth.user.user.id
        )
          throw new AuthRequiredError();
        await assertRequestStillCurrent(
          sourceContext,
          managedGeneration,
          request.version,
        );
        if (
          readerRequestIds.get(
            workspaceSelectionKey(
              request.readerInstanceId,
              request.sourceTabId,
            ),
          ) !== request.requestId
        )
          throw new WorkspaceReaderFailure("invalid-request");
        clearWorkspaceWorkForReader(
          request.readerInstanceId,
          request.sourceTabId,
        );
        workspaceSheetSelections.set(
          workspaceSelectionKey(request.readerInstanceId, request.sourceTabId),
          {
            authGeneration: managedGeneration,
            sourceVersion: request.version,
            sourceContext,
            context: selectedContext,
            sheets,
          },
        );
        return {
          type: request.type,
          readerInstanceId: request.readerInstanceId,
          requestId: request.requestId,
          version: request.version,
          ok: true,
          context: selectedContext,
          sheets,
        };
      }

      if (request.type === "WORKSPACE_READER_DISCOVER") {
        const token = await googleToken(false, managedAccountId);
        let discovery;
        if (request.cursor === null) {
          if (sourceContext.kind !== "sheets")
            throw new WorkspaceReaderFailure("unsupported-file-type");
          const selection = workspaceSheetSelections.get(
            workspaceSelectionKey(
              request.readerInstanceId,
              request.sourceTabId,
            ),
          );
          const selectedContext =
            selection &&
            selection.authGeneration === managedGeneration &&
            sameWorkspaceContext(selection.sourceContext, sourceContext) &&
            sameWorkspaceSourceVersion(selection.sourceVersion, request.version)
              ? selection.context
              : sourceContext;
          clearWorkspaceWorkForReader(
            request.readerInstanceId,
            request.sourceTabId,
          );
          const discoveryToken = randomOauthState();
          workspaceDiscoveryStarts.set(
            workspaceSelectionKey(
              request.readerInstanceId,
              request.sourceTabId,
            ),
            discoveryToken,
          );
          discovery = await startSheetDiscovery(
            sourceContext,
            selectedContext,
            managedGeneration,
            request.version,
            token,
            discoveryToken,
            request.readerInstanceId,
          );
          if (
            !sameWorkspaceSourceVersion(
              request.version,
              workspaceSourceVersion(request.sourceTabId),
            )
          )
            throw new WorkspaceReaderFailure("source-tab-changed");
          if (
            workspaceDiscoveryStarts.get(
              workspaceSelectionKey(
                request.readerInstanceId,
                request.sourceTabId,
              ),
            ) !== discovery.state.token
          )
            throw new WorkspaceReaderFailure("invalid-request");
        } else {
          const state = workspaceDiscoveries.get(request.cursor.token);
          if (
            !state ||
            state.readerInstanceId !== request.readerInstanceId ||
            state.authGeneration !== managedGeneration ||
            !sameWorkspaceSourceVersion(state.sourceVersion, request.version) ||
            !sameWorkspaceContext(state.sourceContext, sourceContext)
          )
            throw new WorkspaceReaderFailure("invalid-request");
          discovery = { state, progress: scanningProgress(state) };
        }
        let discoveryError: WorkspaceReaderErrorCode | undefined;
        try {
          discovery = await continueSheetDiscovery(discovery.state, token);
        } catch (error) {
          if (
            !(error instanceof WorkspaceReaderFailure) ||
            !["rate-limited", "temporarily-unavailable"].includes(error.code)
          )
            throw error;
          discoveryError = error.code;
        }
        const currentAuth = await authorize();
        if (
          currentAuth.generation !== managedGeneration ||
          currentAuth.user.user.id !== initialAuth.user.user.id
        )
          throw new AuthRequiredError();
        await assertRequestStillCurrent(
          discovery.state.sourceContext,
          managedGeneration,
          discovery.state.sourceVersion,
        );
        if (
          request.cursor === null
            ? workspaceDiscoveryStarts.get(
                workspaceSelectionKey(
                  request.readerInstanceId,
                  request.sourceTabId,
                ),
              ) !== discovery.state.token
            : workspaceDiscoveries.get(discovery.state.token) !==
              discovery.state
        )
          throw new WorkspaceReaderFailure("invalid-request");
        if (discovery.progress.status === "complete") {
          const grid = discovery.progress.grid;
          clearWorkspaceWorkForReader(
            request.readerInstanceId,
            request.sourceTabId,
          );
          workspaceSheetSelections.set(
            workspaceSelectionKey(
              request.readerInstanceId,
              request.sourceTabId,
            ),
            {
              authGeneration: managedGeneration,
              sourceVersion: discovery.state.sourceVersion,
              sourceContext: discovery.state.sourceContext,
              context: discovery.state.metadata.context,
              sheets: discovery.state.metadata.sheets,
            },
          );
          workspaceStates.set(
            workspaceStateKey(
              discovery.state.metadata.context,
              request.readerInstanceId,
            ),
            {
              readerInstanceId: request.readerInstanceId,
              generation: grid.generation,
              authGeneration: managedGeneration,
              sourceVersion: discovery.state.sourceVersion,
              sourceContext: discovery.state.sourceContext,
              context: discovery.state.metadata.context,
              title: grid.title,
              records: new Map(),
              cursor: null,
              grid,
              sheetMetadata: discovery.state.metadata,
              pages: new Map(),
            },
          );
        } else if (request.cursor === null) {
          workspaceDiscoveryStarts.delete(
            workspaceSelectionKey(
              request.readerInstanceId,
              request.sourceTabId,
            ),
          );
          workspaceDiscoveries.set(discovery.state.token, discovery.state);
        }
        if (discoveryError)
          return {
            type: request.type,
            readerInstanceId: request.readerInstanceId,
            requestId: request.requestId,
            version: request.version,
            ok: false,
            error: discoveryError,
            discoveryCursor: {
              kind: "sheets-discovery",
              token: discovery.state.token,
            },
          };
        return {
          type: request.type,
          readerInstanceId: request.readerInstanceId,
          requestId: request.requestId,
          version: request.version,
          ok: true,
          sheets: discovery.state.metadata.sheets,
          progress: discovery.progress,
        };
      }

      if (request.type === "WORKSPACE_READER_LOAD") {
        const token = await googleToken(false, managedAccountId);
        const loaded = await loadWorkspace(
          request,
          sourceContext,
          managedGeneration,
          token,
        );
        const currentAuth = await authorize();
        if (
          currentAuth.generation !== managedGeneration ||
          currentAuth.user.user.id !== initialAuth.user.user.id
        )
          throw new AuthRequiredError();
        await assertRequestStillCurrent(
          loaded.state.sourceContext,
          managedGeneration,
          loaded.state.sourceVersion,
        );
        if (loaded.state.context.kind === "docs") {
          clearWorkspaceStatesForTab(request.sourceTabId);
          workspaceStates.set(
            workspaceStateKey(loaded.state.context, request.readerInstanceId),
            loaded.state,
          );
        }
        return {
          type: request.type,
          readerInstanceId: request.readerInstanceId,
          requestId: request.requestId,
          version: request.version,
          ok: true,
          generation: loaded.state.generation,
          context: loaded.state.context,
          title: loaded.state.title,
          records: loaded.records,
          cursor: loaded.cursor,
          ...(loaded.page ? { page: loaded.page } : {}),
          ...(loaded.tabs ? { tabs: loaded.tabs } : {}),
        };
      }

      if (
        request.records.length === 0 ||
        request.records.length > MAX_TRANSLATION_MESSAGE_RECORDS
      )
        throw new WorkspaceReaderFailure("invalid-request");
      const state = findWorkspaceStateBySource(
        sourceContext,
        request.readerInstanceId,
      );
      if (
        !state ||
        state.authGeneration !== managedGeneration ||
        !sameWorkspaceSourceVersion(state.sourceVersion, request.version) ||
        workspaceStates.get(
          workspaceStateKey(state.context, state.readerInstanceId),
        ) !== state
      )
        throw new WorkspaceReaderFailure("source-tab-changed");
      const selected = request.records.map(({ id, sourceHash }) => {
        const record = state.records.get(id);
        if (!record || !record.translatable || record.sourceHash !== sourceHash)
          throw new WorkspaceReaderFailure("invalid-request");
        const source = workspaceRecordTranslationSource(record);
        if (
          source.length === 0 ||
          source.length > MAX_TRANSLATION_RECORD_CHARACTERS
        )
          throw new WorkspaceReaderFailure("content-too-large");
        return { record, source };
      });
      if (
        selected.reduce((total, item) => total + item.source.length, 0) >
        MAX_TRANSLATION_MESSAGE_CHARACTERS
      )
        throw new WorkspaceReaderFailure("content-too-large");
      let translated;
      try {
        translated = await openai.translateText(
          selected.map(({ source }) => source),
          request.targetLanguage,
        );
      } catch (error) {
        const authCode = authError(error);
        if (authCode) throw error;
        translated = {
          results: selected.map(() => ""),
          failures: selected.map((_, index) => ({ index })),
        };
      }
      const currentAuth = await authorize();
      if (
        currentAuth.generation !== managedGeneration ||
        currentAuth.user.user.id !== initialAuth.user.user.id
      )
        throw new AuthRequiredError();
      await assertRequestStillCurrent(
        state.sourceContext,
        managedGeneration,
        state.sourceVersion,
      );
      if (
        workspaceStates.get(
          workspaceStateKey(state.context, state.readerInstanceId),
        ) !== state
      )
        throw new WorkspaceReaderFailure("source-tab-changed");
      const failed = new Set(translated.failures.map(({ index }) => index));
      return {
        type: request.type,
        readerInstanceId: request.readerInstanceId,
        requestId: request.requestId,
        version: request.version,
        ok: true,
        generation: state.generation,
        results: selected.map(({ record }, index) => {
          const text = translated.results[index];
          return text
            ? { id: record.id, sourceHash: record.sourceHash, text }
            : {
                id: record.id,
                sourceHash: record.sourceHash,
                error: failed.has(index)
                  ? ("provider-error" as const)
                  : ("unresolved" as const),
              };
        }),
      };
    } catch (error) {
      let responseError = error;
      if (managedGeneration !== undefined) {
        try {
          assertGeneration(managedGeneration);
        } catch (generationError) {
          responseError = generationError;
        }
      }
      if (
        responseError instanceof WorkspaceReaderFailure &&
        (responseError.code === "google-auth-required" ||
          responseError.code === "google-access-denied")
      )
        clearWorkspaceStatesForTab(request.sourceTabId);
      return readerError(
        request.type,
        request,
        authError(responseError) ??
          (responseError instanceof WorkspaceReaderFailure
            ? responseError.code
            : "invalid-request"),
        request.type === "WORKSPACE_READER_CONTEXT"
          ? undefined
          : workspaceSourceVersion(request.sourceTabId),
      );
    }
  };
  const topHtmlLangByTab = new Map<
    number,
    { url: string | undefined; htmlLang: string }
  >();
  const pendingFramesByTab = new Map<number, Set<number>>();
  const pendingSelectionUiLoads = new Map<string, Promise<boolean>>();
  /** Returns stored htmlLang for the tab's current top-level document, if any. */
  const storedHtmlLang = (tabId: number) =>
    topHtmlLangByTab.get(tabId)?.htmlLang;
  /** Returns the CLD code for a tab, or `und` when detection fails. */
  const detectTabLanguage = async (tabId?: number) => {
    if (tabId === undefined) return "und";
    try {
      const detected = await browser.tabs.detectLanguage(tabId);
      return detected || "und";
    } catch {
      return "und";
    }
  };
  /** Sends START_TRANSLATION to one frame; gone-frame rejections are swallowed. */
  const sendStartTranslation = (
    tabId: number,
    frameId: number,
    targetLanguage: TargetLanguage,
  ) =>
    browser.tabs
      .sendMessage(
        tabId,
        { type: "START_TRANSLATION", targetLanguage },
        { frameId },
      )
      .catch(() => undefined);
  /** Starts always-translate on the given frames when preference, auto skip, and OpenAI allow it. */
  const startAlwaysTranslate = async (
    tabId: number,
    tabUrl: string | undefined,
    frameIds: number[],
  ) => {
    if (tabUrl && parseWorkspaceEditorUrl(tabUrl)) return;
    const hostname = hostnameFromUrl(tabUrl);
    const stored = await extensionStorage.getMany([
      canonicalPreferenceKey(hostname),
      preferenceKey(hostname),
    ]);
    const preference =
      readAlwaysTranslatePreference(hostname, stored) ??
      readAlwaysTranslatePreference(
        hostname,
        await extensionStorage.getByPrefix(PREF_PREFIX),
      );
    if (!preference?.enabled) return;
    const detected = await detectTabLanguage(tabId);
    const { autoSkipTarget } = resolvePageLanguage({
      detected,
      htmlLang: storedHtmlLang(tabId),
    });
    const openAiBlocked = false;
    if (
      !shouldStartAlwaysTranslate({
        enabled: preference.enabled,
        targetLanguage: preference.targetLanguage,
        autoSkipTarget,
        openAiBlocked,
      })
    )
      return;
    await Promise.all(
      frameIds.map((frameId) =>
        sendStartTranslation(tabId, frameId, preference.targetLanguage),
      ),
    );
  };
  browser.runtime.onMessage.addListener(async (message, sender) => {
    if (!message || typeof message.type !== "string") return undefined;
    // ADR 0020: only this extension's Settings page may read or change the
    // provider settings; every other sender gets `forbidden`.
    const settingsUrl = browser.runtime.getURL("/options.html" as never);
    const settingsPage =
      sender.id === browser.runtime.id &&
      typeof sender.url === "string" &&
      (sender.url === settingsUrl ||
        sender.url.startsWith(`${settingsUrl}?`) ||
        sender.url.startsWith(`${settingsUrl}#`));
    const settingsResponse = await providerSettings.handle(message, {
      settingsPage,
    });
    if (settingsResponse) return settingsResponse;
    if (message.type === DIAGNOSTICS_GET) {
      // ADR 0020: **Copy diagnostics** in Settings. Counts and settings only;
      // the report builder copies allowlisted fields, never the key.
      if (!settingsPage) return { ok: false, error: "forbidden" };
      await providerSettings.ready();
      const view = providerSettings.view();
      const state = providerSettings.engineState();
      const [runs, locale] = await Promise.all([
        listRuns(storage).catch(() => []),
        readUiLocale().catch(() => ({ locale: "en" })),
      ]);
      return {
        ok: true,
        report: buildDiagnosticsReport({
          extensionVersion: browser.runtime.getManifest().version,
          userAgent: globalThis.navigator?.userAgent ?? "",
          uiLocale: locale.locale,
          engine: {
            source: chooseEngineSource(state),
            provider: view.settings.activeProvider,
            model: view.settings.providers.openai.model,
            keyConfigured: state.keyConfigured,
            keyRejected: state.keyRejected,
          },
          onDeviceTranslation: onDeviceTranslatorSupported()
            ? "supported"
            : "unsupported",
          sheetsReader: sheetsReaderEnabled(),
          workspaceReader: workspaceConfigured(),
          runs,
        }),
      };
    }
    const readerOpen = parseWorkspaceReaderOpen(message);
    if (readerOpen) {
      if (
        sender.id !== browser.runtime.id ||
        sender.tab ||
        (sender.url &&
          !sender.url.startsWith(browser.runtime.getURL("/" as never)))
      )
        return undefined;
      const tab = await browser.tabs
        .get(readerOpen.sourceTabId)
        .catch(() => undefined);
      if (
        !tab ||
        typeof tab.windowId !== "number" ||
        (readerOpen.sourceWindowId !== undefined &&
          readerOpen.sourceWindowId !== tab.windowId) ||
        parseWorkspaceEditorUrl(tab.url ?? "")?.kind !== "sheets"
      )
        return undefined;
      openReaderWindows.set(tab.windowId, readerOpen.sourceTabId);
      return undefined;
    }
    if (message.type === "LOCAL_SPREADSHEET_TRANSLATE") {
      const request = parseLocalSpreadsheetTranslateRequest(message);
      const owner = {
        readerInstanceId:
          typeof message.readerInstanceId === "string" &&
          /^[A-Za-z0-9._:-]{1,128}$/.test(message.readerInstanceId)
            ? message.readerInstanceId
            : "invalid",
        requestId: isSafeId(message.requestId) ? message.requestId : 0,
        generation: isSafeId(message.generation) ? message.generation : 0,
      };
      if (sender.id !== browser.runtime.id || !request)
        return localReaderError(owner, "invalid-request");
      const globalReader =
        sender.url === browser.runtime.getURL("/reader.html" as never);
      const binding = globalReader
        ? await resolveReaderDocumentBinding(sender, request.readerInstanceId)
        : undefined;
      if (globalReader ? !binding : !trustedLocalReaderSender(sender.url))
        return localReaderError(
          owner,
          globalReader ? "reader-channel-unavailable" : "invalid-request",
        );
      const boundSourceTabId = trustedGoogleDriveOfficeSender(sender.url);
      if (
        !globalReader &&
        boundSourceTabId !== null &&
        !(await trustedReaderTabWindow(sender, boundSourceTabId))
      )
        return localReaderError(owner, "invalid-request");
      const previous = localReaderRequests.get(request.readerInstanceId);
      if (
        previous &&
        (request.requestId <= previous.requestId ||
          request.generation < previous.generation)
      )
        return localReaderError(request, "invalid-request");
      if (!previous && localReaderRequests.size >= MAX_LOCAL_READER_OWNERS) {
        const oldest = localReaderRequests.keys().next().value;
        if (oldest !== undefined) localReaderRequests.delete(oldest);
      }
      localReaderRequests.set(request.readerInstanceId, {
        requestId: request.requestId,
        generation: request.generation,
        request,
        ...(binding
          ? { sourceTabId: binding.sourceContext.sourceTabId }
          : trustedGoogleDriveOfficeSender(sender.url) === null
            ? {}
            : { sourceTabId: trustedGoogleDriveOfficeSender(sender.url)! }),
      });
      return handleLocalSpreadsheetTranslate(request, binding ?? undefined);
    }
    if (readerTypes.has(message.type as WorkspaceReaderRequest["type"])) {
      const type = message.type as WorkspaceReaderRequest["type"];
      const requestId = isSafeId(message.requestId) ? message.requestId : 0;
      const owner = parseWorkspaceReaderOwner({
        readerInstanceId: message.readerInstanceId,
        requestId,
      }) ?? { readerInstanceId: "invalid", requestId };
      const request = parseWorkspaceRequest(message);
      if (
        sender.id !== browser.runtime.id ||
        !request ||
        !trustedReaderSender(sender.url, request.sourceTabId)
      )
        return readerError(
          type,
          owner,
          "invalid-request",
          type === "WORKSPACE_READER_CONTEXT" || !isSafeId(message.sourceTabId)
            ? undefined
            : workspaceSourceVersion(message.sourceTabId),
        );
      const requestOwner = `${request.readerInstanceId}:${request.sourceTabId}`;
      const previousRequestId = readerRequestIds.get(requestOwner);
      if (
        previousRequestId !== undefined &&
        request.requestId <= previousRequestId
      )
        return readerError(
          type,
          request,
          "invalid-request",
          request.type === "WORKSPACE_READER_CONTEXT"
            ? undefined
            : workspaceSourceVersion(request.sourceTabId),
        );
      readerRequestIds.set(requestOwner, request.requestId);
      let document: { documentId: string; windowId: number } | undefined;
      try {
        if (request.type !== "WORKSPACE_READER_DISCONNECT") {
          const resolved = await readerDocumentWindow(
            sender,
            request.sourceTabId,
          );
          if (
            !resolved &&
            !(await trustedReaderTabWindow(sender, request.sourceTabId))
          )
            return readerError(type, owner, "reader-channel-unavailable");
          document = resolved ?? undefined;
        }
      } catch (error) {
        const code = authError(error);
        if (!code) throw error;
        return readerError(
          type,
          owner,
          code,
          request.type === "WORKSPACE_READER_CONTEXT"
            ? undefined
            : workspaceSourceVersion(request.sourceTabId),
        );
      }
      return handleWorkspaceRequest(request, document);
    }
    const protectedOperation = new Set([
      "BEGIN_TRANSLATION_RUN",
      "AUTHORIZE_TRANSLATION_COMMIT",
      "TRANSLATE_HTML",
      "TRANSLATE_TEXT",
      "TRANSLATE_SINGLE",
      "CACHE_ACCEPTED_OPENAI_FALLBACK",
      "CACHE_ACCEPTED_OPENAI_HTML",
      "TRANSLATE_NATIVE_TEXT",
      "PREPARE_NATIVE_TRANSLATOR",
      "QUERY_NATIVE_TRANSLATOR_PROGRESS",
    ]).has(message.type);
    const needsRun =
      protectedOperation &&
      (message.runId !== undefined ||
        (message.type !== "PREPARE_NATIVE_TRANSLATOR" &&
          message.type !== "QUERY_NATIVE_TRANSLATOR_PROGRESS"));
    if (
      protectedOperation &&
      (sender.id !== browser.runtime.id ||
        (needsRun &&
          (sender.tab?.id === undefined || !Number.isInteger(message.runId))) ||
        (sender.frameId !== undefined &&
          (!Number.isInteger(sender.frameId) || sender.frameId < 0)) ||
        (message.type !== "BEGIN_TRANSLATION_RUN" &&
          !isTarget(message.targetLanguage)) ||
        (message.type === "TRANSLATE_HTML" &&
          (!isStringMatrix(message.pieces) ||
            (message.deferCache !== undefined &&
              typeof message.deferCache !== "boolean"))) ||
        (["TRANSLATE_TEXT", "TRANSLATE_NATIVE_TEXT"].includes(message.type) &&
          (!Array.isArray(message.texts) ||
            !message.texts.every(
              (text: unknown) => typeof text === "string",
            ))) ||
        (message.type === "TRANSLATE_SINGLE" &&
          typeof message.text !== "string") ||
        (message.type.includes("NATIVE") &&
          !isTarget(message.sourceLanguage)) ||
        (message.type.startsWith("CACHE_ACCEPTED_") &&
          (!isStringMatrix(message.sources) ||
            !isStringMatrix(message.results))))
    )
      return {
        error: "invalid-request",
        ...(Number.isInteger(message.runId) ? { runId: message.runId } : {}),
      };
    const dispatch = async () => {
      if (message.type === "AUTHORIZE_TRANSLATION_COMMIT") {
        const context = await contextForRun(sender, message.runId);
        assertRunContext(sender, message.runId, context.generation);
        return { ok: true, runId: message.runId };
      }

      if (message.type === "LOAD_SELECTION_TRANSLATION_UI") {
        if (
          sender.id !== browser.runtime.id ||
          sender.tab?.id === undefined ||
          Object.keys(message).some((key) => key !== "type")
        )
          return undefined;
        const frameId = sender.frameId ?? 0;
        if (!Number.isInteger(frameId) || frameId < 0) return undefined;
        const key = `${sender.tab.id}:${frameId}:${sender.documentId ?? "document?"}`;
        const target = sender.documentId
          ? { tabId: sender.tab.id, documentIds: [sender.documentId] }
          : { tabId: sender.tab.id, frameIds: [frameId] };
        let load = pendingSelectionUiLoads.get(key);
        if (!load) {
          load = browser.scripting
            .executeScript({
              target,
              // WXT's generated path type includes a leading slash; Chrome's API expects a relative path.
              files: ["content-scripts/selection-ui.js" as never],
            })
            .then(
              () => true,
              () => false,
            )
            .finally(() => pendingSelectionUiLoads.delete(key));
          pendingSelectionUiLoads.set(key, load);
        }
        return {
          loaded: await load,
        } satisfies SelectionTranslationUiLoadResponse;
      }
      if (message.type === "TRANSLATE_SELECTION") {
        const request = message as Partial<SelectionTranslationRequest>;
        const requestId =
          Number.isInteger(request.requestId) && request.requestId! >= 0
            ? request.requestId!
            : 0;
        const error = (
          value: Exclude<
            SelectionTranslationResponse,
            { text: string }
          >["error"],
        ): SelectionTranslationResponse => ({ requestId, error: value });
        if (
          sender.id !== browser.runtime.id ||
          sender.tab?.id === undefined ||
          requestId !== request.requestId ||
          typeof request.text !== "string" ||
          !isTarget(request.targetLanguage) ||
          // The backend routes engines; a client provider choice is invalid.
          Object.hasOwn(request, "provider")
        )
          return error("invalid-request");
        if (request.text.length > 4_000) return error("too-long");
        if (!request.text.trim()) return error("invalid-request");

        let result;
        try {
          const { user, generation } = await authorize();
          const context = await contextForRun(sender, undefined, false);
          assertGeneration(generation);
          let text = "";
          if (translationPath() === "provider") {
            result = await openai.translateText(
              [request.text],
              request.targetLanguage,
              context,
            );
            assertGeneration(generation);
            if (
              result.failures.some(
                (failure) =>
                  failure.index === 0 &&
                  failure.scope === "record" &&
                  failure.message.includes("exceeds"),
              )
            )
              return error("too-long");
            text = result.results[0] ?? "";
          }
          // No usable key, or a key rejected during this request: on-device
          // after the saved translations, with the same chain cache semantics.
          const path = text ? "provider" : translationPath();
          if (!text && path !== "provider") {
            const saved = await openai.translateText(
              [request.text],
              request.targetLanguage,
              { ...context, cacheOnly: true },
            );
            assertGeneration(generation);
            text = saved.results[0] ?? "";
            if (!text && path === "unavailable")
              return error("on-device-unavailable");
            const sourceLanguage = resolveRecordSourceLanguage(
              request.text,
              context.sourceLanguageHint,
            );
            if (
              !text &&
              sourceLanguage !== "auto" &&
              sourceLanguage !== request.targetLanguage
            ) {
              const status = await nativeTranslator.prepare({
                type: "PREPARE_NATIVE_TRANSLATOR",
                sourceLanguage,
                targetLanguage: request.targetLanguage,
              });
              assertGeneration(generation);
              const ownerKey = `selection:${nativeOwnerKey(sender)}`;
              rememberNativeOwner(sender, ownerKey);
              const native = status.ready
                ? await nativeTranslator.translate(
                    `${ownerKey}:${requestId}`,
                    ownerKey,
                    {
                      type: "TRANSLATE_NATIVE_TEXT",
                      runId: requestId,
                      sourceLanguage,
                      targetLanguage: request.targetLanguage,
                      texts: [request.text],
                    },
                  )
                : undefined;
              assertGeneration(generation);
              const accepted = native?.results[0];
              if (accepted?.status === "accepted") {
                text = accepted.text;
                await openai
                  .cacheFallbackTranslations(
                    [[request.text]],
                    [[text]],
                    request.targetLanguage,
                    context,
                    "browser-native",
                  )
                  .catch(() => 0);
              }
            }
          }
          if (!text) return error("translation-failed");

          const { user: currentUser } = await authorize();
          assertGeneration(generation);
          if (currentUser.user.id !== user.user.id)
            return error("auth-required");
          return { requestId, text } satisfies SelectionTranslationResponse;
        } catch (cause) {
          return error(authError(cause) ?? "translation-failed");
        }
      }
      if (message.type === "UI_LOCALE_GET") {
        // Any context of this extension: extension pages, and the selection
        // panel's content script, which never opens IndexedDB itself.
        if (sender.id !== browser.runtime.id) return undefined;
        return readUiLocale();
      }
      if (message.type === "UI_LOCALE_SET") {
        // Extension pages only (the popup's language switch).
        const locale = parseUiLocale(message.locale);
        if (
          sender.id !== browser.runtime.id ||
          sender.tab ||
          (sender.url &&
            !sender.url.startsWith(browser.runtime.getURL("/" as never))) ||
          !locale ||
          Object.keys(message).some((key) => key !== "type" && key !== "locale")
        )
          return undefined;
        await extensionStorage.set(UI_LOCALE_KEY, locale);
        // Open extension pages switch now; the selection panel asks again
        // the next time it opens.
        void browser.runtime
          .sendMessage({
            type: "UI_LOCALE_CHANGED",
            locale,
          } satisfies UiLocaleChangedEvent)
          .catch(() => undefined);
        return { locale, stored: locale } satisfies UiLocaleResponse;
      }
      if (message.type === "WORKSPACE_FEATURES") {
        // Extension pages only (the popup on a native Sheet); ADR 0015.
        if (
          sender.id !== browser.runtime.id ||
          sender.tab ||
          (sender.url &&
            !sender.url.startsWith(browser.runtime.getURL("/" as never)))
        )
          return undefined;
        return { workspaceSheetsReader: sheetsReaderEnabled() };
      }
      if (message.type === "AUTH_STATUS") {
        // ADR 0020: no accounts. Extension pages learn the engine and
        // on-device support; the local user is always "signed in".
        await providerSettings.ready();
        return {
          authenticated: true,
          user: LOCAL_USER.user,
          ...onDeviceTranslation(),
          ...engineStatus(),
        };
      }
      if (message.type === "RECORD_TRANSLATION_DIAGNOSTICS") {
        if (!Number.isInteger(message.runId)) return { saved: false };
        const context = runContexts.get(runKey(sender, message.runId));
        if (!context || context.generation !== auth.getGeneration())
          return { saved: false };
        const summary = message.summary as TranslationRunSummary;
        if (summary?.provider !== "openai") return { saved: false };
        try {
          await recordRun(storage, summary);
          return { saved: true };
        } catch {
          return { saved: false };
        }
      }
      if (message.type === "PREPARE_NATIVE_TRANSLATOR") {
        if (
          !isTarget(message.sourceLanguage) ||
          !isTarget(message.targetLanguage)
        ) {
          return {
            availability: "unavailable",
            ready: false,
            progress: { phase: "checking" },
          };
        }
        return nativeTranslator.prepare(
          message as PrepareNativeTranslatorMessage,
        );
      }
      if (message.type === "TRANSLATE_NATIVE_TEXT") {
        const texts: unknown[] = Array.isArray(message.texts)
          ? message.texts
          : [];
        if (
          !Number.isInteger(message.runId) ||
          !isTarget(message.sourceLanguage) ||
          !isTarget(message.targetLanguage) ||
          !texts.every((text) => typeof text === "string")
        ) {
          return {
            runId: message.runId,
            results: texts.map(() => ({
              status: "error" as const,
              reason: "invalid-request",
            })),
          };
        }
        const ownerKey = nativeOwnerKey(sender);
        rememberNativeOwner(sender, ownerKey);
        return nativeTranslator.translate(
          nativeRunKey(sender, message.runId),
          ownerKey,
          message as TranslateNativeTextMessage,
        );
      }
      if (message.type === "QUERY_NATIVE_TRANSLATOR_PROGRESS") {
        if (
          !isTarget(message.sourceLanguage) ||
          !isTarget(message.targetLanguage)
        ) {
          return {
            availability: "unavailable",
            ready: false,
            progress: { phase: "checking" },
          };
        }
        return nativeTranslator.query(
          message as QueryNativeTranslatorProgressMessage,
        );
      }
      if (message.type === "CANCEL_NATIVE_TRANSLATION") {
        const { runId } = message as Partial<CancelNativeTranslationMessage>;
        return {
          runId,
          cancelled:
            Number.isInteger(runId) &&
            nativeTranslator.cancel(nativeRunKey(sender, runId)),
        };
      }
      if (message.type === "DETECT_TAB_LANGUAGE") {
        const tabId =
          typeof message.tabId === "number" ? message.tabId : sender.tab?.id;
        const detected = await detectTabLanguage(tabId);
        const htmlLang =
          tabId === undefined ? undefined : storedHtmlLang(tabId);
        const resolved = resolvePageLanguage({ detected, htmlLang });
        return {
          pageLanguage: resolved.label,
          autoSkipTarget: resolved.autoSkipTarget,
          sourceLanguage: resolved.autoSkipTarget ?? undefined,
        };
      }
      if (message.type === "BEGIN_TRANSLATION_RUN") {
        if (!Number.isInteger(message.runId)) return { ok: false };
        const ownerKey = nativeOwnerKey(sender);
        rememberNativeOwner(sender, ownerKey);
        nativeTranslator.clearOwner(ownerKey);
        activeRunIdsByOwner.set(ownerKey, message.runId);
        const context = await contextForRun(sender, message.runId, true);
        return {
          ok: true,
          sourceLanguageHint: context.sourceLanguageHint,
          // The verified session above refreshed the plan snapshot.
          path: translationPath(),
        };
      }
      if (message.type === "CACHE_ACCEPTED_OPENAI_FALLBACK") {
        if (
          !isTarget(message.targetLanguage) ||
          !isStringMatrix(message.sources) ||
          !isStringMatrix(message.results) ||
          message.sources.length !== message.results.length ||
          message.sources.some(
            (row: string[], index: number) =>
              row.length !== message.results[index]?.length,
          ) ||
          (message.provenance !== "google" &&
            message.provenance !== "browser-native")
        )
          return { saved: 0 };
        const context = activeRunContext(sender, message.runId);
        if (!context || context.cacheEpoch !== pageCacheEpoch)
          return { saved: 0 };
        return {
          saved: await openai.cacheFallbackTranslations(
            message.sources,
            message.results,
            message.targetLanguage,
            context,
            message.provenance as OpenAIFallbackProvenance,
          ),
        };
      }
      if (message.type === "CACHE_ACCEPTED_OPENAI_HTML") {
        if (
          !Number.isInteger(message.runId) ||
          !isTarget(message.targetLanguage) ||
          !isStringMatrix(message.sources) ||
          !isStringMatrix(message.results) ||
          message.sources.length !== message.results.length ||
          message.sources.some(
            (row: string[], index: number) =>
              row.length !== message.results[index]?.length,
          )
        )
          return { saved: 0 };
        const context = await contextForRun(sender, message.runId);
        assertRunContext(sender, message.runId, context.generation);
        if (context.cacheEpoch !== pageCacheEpoch) return { saved: 0 };
        const diagnostics = { storageWriteCalls: 0, storageWriteMs: 0 };
        const saved = await openai.cacheAcceptedHtml(
          message.sources,
          message.results,
          message.targetLanguage,
          context,
          diagnostics,
        );
        return { saved, diagnostics };
      }

      if (message.type === "TRANSLATE_HTML") {
        if (
          !isTarget(message.targetLanguage) ||
          !Array.isArray(message.pieces)
        ) {
          const pieces: unknown[] = Array.isArray(message.pieces)
            ? message.pieces
            : [];
          return {
            runId: message.runId,
            results: pieces.map(() => []),
            failures: pieces.map((_, index) => ({
              index,
              scope: "run" as const,
              message: "Invalid request",
              retryable: false,
            })),
          };
        }
        const context = await contextForRun(sender, message.runId);
        assertRunContext(sender, message.runId, context.generation);
        const result = await openai.translateHtml(
          message.pieces as string[][],
          message.targetLanguage,
          {
            ...context,
            deferCache: message.deferCache === true,
            ...pathOptions(translationPath()),
          },
        );
        // Re-evaluated after the stage: a backend refusal switches later work.
        return { runId: message.runId, ...result, path: translationPath() };
      }
      if (message.type === "TRANSLATE_TEXT") {
        if (
          !isTarget(message.targetLanguage) ||
          !Array.isArray(message.texts)
        ) {
          const texts: unknown[] = Array.isArray(message.texts)
            ? message.texts
            : [];
          return {
            runId: message.runId,
            results: texts.map(() => ""),
            failures: texts.map((_, index) => ({
              index,
              scope: "run" as const,
              message: "Invalid request",
              retryable: false,
            })),
          };
        }
        const context = await contextForRun(sender, message.runId);
        assertRunContext(sender, message.runId, context.generation);
        const result = await openai.translateText(
          message.texts as string[],
          message.targetLanguage,
          { ...context, ...pathOptions(translationPath()) },
        );
        return { runId: message.runId, ...result, path: translationPath() };
      }
      if (message.type === "TRANSLATE_SINGLE") {
        if (
          !isTarget(message.targetLanguage) ||
          typeof message.text !== "string"
        )
          return { text: "" };
        const context = await contextForRun(sender, message.runId);
        assertRunContext(sender, message.runId, context.generation);
        const result = await openai.translateText(
          [message.text],
          message.targetLanguage,
          { ...context, ...pathOptions(translationPath()) },
        );
        return {
          text: result.results[0] ?? "",
          diagnostics: result.diagnostics,
          path: translationPath(),
        };
      }
      if (message.type === "CLEAR_SAVED_TRANSLATIONS") {
        pageCacheEpoch += 1;
        const [cleared] = await Promise.all([
          openai.clearSavedTranslations(),
          clearRuns(storage),
        ]);
        return { removed: cleared.removed, bytes: cleared.bytes };
      }
      if (message.type === "CONTENT_READY" && sender.tab?.id !== undefined) {
        const tabId = sender.tab.id;
        const frameId = sender.frameId ?? 0;
        const tabUrl = sender.tab.url;
        if (frameId === 0) {
          topHtmlLangByTab.set(tabId, {
            url: tabUrl,
            htmlLang:
              typeof message.htmlLang === "string" ? message.htmlLang : "",
          });
          const queued = [...(pendingFramesByTab.get(tabId) ?? [])];
          pendingFramesByTab.delete(tabId);
          await startAlwaysTranslate(tabId, tabUrl, [0, ...queued]);
        } else {
          const stored = topHtmlLangByTab.get(tabId);
          if (!stored || stored.url !== tabUrl) {
            const pending = pendingFramesByTab.get(tabId) ?? new Set<number>();
            pending.add(frameId);
            pendingFramesByTab.set(tabId, pending);
          } else {
            await startAlwaysTranslate(tabId, tabUrl, [frameId]);
          }
        }
        return { ok: true };
      }
      return undefined;
    };
    if (!protectedOperation) return dispatch();
    try {
      const { generation } = await authorize();
      assertGeneration(generation);
      if (needsRun && message.type !== "BEGIN_TRANSLATION_RUN") {
        const context = runContexts.get(runKey(sender, message.runId));
        if (
          context?.generation !== generation ||
          activeRunIdsByOwner.get(nativeOwnerKey(sender)) !== message.runId
        )
          throw new AuthRequiredError();
      }
      const response = await dispatch();
      assertGeneration(generation);
      if (
        needsRun &&
        activeRunIdsByOwner.get(nativeOwnerKey(sender)) !== message.runId
      )
        throw new AuthRequiredError();
      return response;
    } catch (cause) {
      const error = authError(cause);
      if (!error) throw cause;
      return {
        error,
        ...(Number.isInteger(message.runId) ? { runId: message.runId } : {}),
      };
    }
  });
  const readerActivationSource = async (
    tab: { url?: string; windowId?: number },
    windowId: number,
  ) => {
    const sourceTabId = trustedGoogleDriveOfficeSender(tab.url);
    if (sourceTabId === null || tab.windowId !== windowId) return null;
    const source = await browser.tabs.get(sourceTabId).catch(() => undefined);
    return source?.windowId === windowId &&
      parseWorkspaceEditorUrl(source.url ?? "")?.kind === "sheets"
      ? sourceTabId
      : null;
  };
  /** A top-level URL change retires Reader state only when its canonical source changes. */
  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url === undefined) return;
    void prepareReaderToolbar(tabId, changeInfo.url);
    const parsed = parseWorkspaceEditorUrl(changeInfo.url);
    const sourceWindowId = tab.windowId ?? workspaceSourceWindows.get(tabId);
    if (
      parsed?.kind !== "sheets" &&
      sourceWindowId !== undefined &&
      (tab.active || openReaderWindows.get(sourceWindowId) === tabId)
    ) {
      const route = toolbarRoutes.get(tabId);
      void readerActivationSource(
        { url: changeInfo.url, windowId: tab.windowId },
        sourceWindowId,
      )
        .then((sourceTabId) => {
          if (sourceTabId === null && toolbarRoutes.get(tabId) === route)
            return closeReaderWindow(sourceWindowId);
        })
        .catch(() => undefined);
    }
    const sourceVersion = synchronizeWorkspaceSource(
      tabId,
      parsed
        ? workspaceSourceIdentity({ sourceTabId: tabId, ...parsed })
        : null,
    );
    for (const state of googleDriveOfficeDownloads.values())
      if (
        state.request.sourceTabId === tabId &&
        !sameWorkspaceSourceVersion(state.request.version, sourceVersion)
      )
        terminateGoogleDriveOfficeDownload(state, "source-tab-changed");
    topHtmlLangByTab.delete(tabId);
    pendingFramesByTab.delete(tabId);
    clearRunContextsForTab(tabId);
    clearNativeOwnersForTab(tabId);
  });
  browser.tabs.onActivated.addListener(({ tabId, windowId }) => {
    const activation = {};
    readerWindowActivations.set(windowId, activation);
    void browser.tabs
      .get(tabId)
      .then(async (initialTab) => {
        // New tabs activate at about:blank before their extension URL commits.
        // Resolve that transition once, then apply the same source/window checks.
        let tab = initialTab;
        if (tab.url === "about:blank" || !tab.url) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          tab = await browser.tabs.get(tabId);
        }
        if (
          readerWindowActivations.get(windowId) !== activation ||
          (tab.windowId !== undefined && tab.windowId !== windowId)
        )
          return;
        const boundSourceTabId = await readerActivationSource(tab, windowId);
        if (readerWindowActivations.get(windowId) !== activation) return;
        const sourceTabId =
          parseWorkspaceEditorUrl(tab.url ?? "")?.kind === "sheets"
            ? tabId
            : boundSourceTabId;
        if (sourceTabId === null) {
          void closeReaderWindow(windowId).catch(() => undefined);
          for (const [id, sourceWindowId] of workspaceSourceWindows) {
            if (sourceWindowId !== windowId) continue;
            clearWorkspaceStatesForTab(id);
            for (const state of googleDriveOfficeDownloads.values())
              if (state.request.sourceTabId === id)
                terminateGoogleDriveOfficeDownload(state, "source-tab-changed");
          }
        } else if (openReaderWindows.has(windowId)) {
          openReaderWindows.set(windowId, sourceTabId);
        }
        return prepareReaderToolbar(tabId, tab.url);
      })
      .catch(() => undefined);
  });
  browser.action.onClicked.addListener((tab) => {
    if (tab.id === undefined) return;
    const parsed = tab.url ? parseWorkspaceEditorUrl(tab.url) : null;
    const panel = readerPanelApi();
    if (
      toolbarAuthenticated &&
      parsed?.kind === "sheets" &&
      workspaceReaderEnabled() &&
      typeof tab.windowId === "number" &&
      panel?.open
    ) {
      // This call must remain synchronous with the toolbar gesture; protected work authorizes later.
      const before = readerPanelContexts();
      if (
        !unresolvedReaderOpenWindows.has(tab.windowId!) &&
        unresolvedReaderOpenWindows.size < MAX_LOCAL_READER_OWNERS
      )
        unresolvedReaderOpenWindows.set(tab.windowId!, before);
      const opening = panel
        .open({ windowId: tab.windowId! })
        .then(async () => {
          await bindOpenedReaderDocument(tab.windowId!, before);
          openReaderWindows.set(tab.windowId!, tab.id!);
          return browser.runtime
            .sendMessage({
              type: "WORKSPACE_READER_OPEN",
              sourceTabId: tab.id!,
              sourceWindowId: tab.windowId!,
            })
            .catch(() => undefined);
        })
        .catch(() => {
          unresolvedReaderOpenWindows.delete(tab.windowId!);
          return browser.action
            .setPopup({ tabId: tab.id!, popup: "popup.html" })
            .catch(() => undefined);
        });
      pendingReaderOpenBindings.set(tab.windowId!, opening);
      void opening.finally(() => {
        if (pendingReaderOpenBindings.get(tab.windowId!) === opening)
          pendingReaderOpenBindings.delete(tab.windowId!);
      });
    } else {
      void browser.action
        .setPopup({ tabId: tab.id, popup: "popup.html" })
        .catch(() => undefined);
    }
  });
  try {
    readerPanelApi()?.onOpened?.addListener(({ windowId, tabId }) => {
      const before = lastReaderPanelSnapshot;
      const binding = Promise.resolve(
        pendingReaderOpenBindings.get(windowId),
      ).then(() => bindOpenedReaderDocument(windowId, before));
      pendingReaderOpenBindings.set(windowId, binding);
      void binding.finally(() => {
        if (pendingReaderOpenBindings.get(windowId) === binding)
          pendingReaderOpenBindings.delete(windowId);
      });
      const active =
        tabId === undefined
          ? browser.tabs
              .query({ active: true, windowId })
              .then((tabs) => tabs[0])
          : browser.tabs.get(tabId);
      void active
        .then((tab) => {
          if (
            tab?.id === undefined ||
            parseWorkspaceEditorUrl(tab.url ?? "")?.kind !== "sheets"
          ) {
            return closeReaderWindow(windowId);
          }
          openReaderWindows.set(windowId, tab.id);
          return browser.runtime
            .sendMessage({
              type: "WORKSPACE_READER_OPEN",
              sourceTabId: tab.id,
              sourceWindowId: windowId,
            })
            .catch(() => undefined);
        })
        .catch(() => undefined);
    });
    readerPanelApi()?.onClosed?.addListener(({ windowId }) => {
      void updateReaderSourceClaims((claims) =>
        claims.filter((claim) => claim.windowId !== windowId),
      );
      readerDocumentRegistryRevision += 1;
      unresolvedReaderOpenWindows.delete(windowId);
      for (const [owner, binding] of readerDocumentBindings)
        if (binding.windowId === windowId) readerDocumentBindings.delete(owner);
      openReaderWindows.delete(windowId);
      for (const [id, actualWindow] of readerDocumentWindows)
        if (actualWindow === windowId) readerDocumentWindows.delete(id);
      void persistReaderDocumentWindows();
    });
  } catch {
    // Older Chromium omits panel lifecycle events; explicit action/popup opens still register their window.
  }
  refreshReaderToolbar();
  browser.tabs.onRemoved.addListener((tabId) => {
    toolbarRoutes.delete(tabId);
    appliedToolbarRoutes.delete(tabId);
    workspaceSourceWindows.delete(tabId);
    for (const state of googleDriveOfficeDownloads.values())
      if (state.request.sourceTabId === tabId)
        terminateGoogleDriveOfficeDownload(state, "source-tab-changed");
    topHtmlLangByTab.delete(tabId);
    pendingFramesByTab.delete(tabId);
    clearRunContextsForTab(tabId);
    clearNativeOwnersForTab(tabId);
    const notification = workspaceSourceNotificationTimers.get(tabId);
    if (notification) clearTimeout(notification);
    workspaceSourceNotificationTimers.delete(tabId);
    if (workspaceSources.has(tabId)) {
      const version = synchronizeWorkspaceSource(tabId, null, false);
      emitWorkspaceSourceChanged(tabId, version);
    } else {
      clearWorkspaceStatesForTab(tabId);
    }
    const suffix = `:${tabId}`;
    for (const owner of readerRequestIds.keys())
      if (owner.endsWith(suffix)) readerRequestIds.delete(owner);
  });
});
