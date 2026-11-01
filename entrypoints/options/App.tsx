import { useEffect, useId, useState, type FormEvent } from "react";
import { Mark } from "@/components/Mark";
import {
  OPENAI_MODELS,
  parseProviderSettingsView,
  type OpenAIModel,
  type ProviderSettingsView,
} from "@/shared/provider-settings";
import {
  PROVIDER_KEY_REMOVE,
  PROVIDER_KEY_TEST,
  PROVIDER_SETTINGS_GET,
  PROVIDER_SETTINGS_SAVE,
} from "@/lib/provider-settings-host";
import { KEY_TEST_RESULTS, type KeyTestResult } from "@/lib/provider-key-test";
import { DIAGNOSTICS_GET } from "@/lib/diagnostics-report";
import { UiLocaleProvider, useMessages } from "@/lib/i18n/react";
import {
  settingsMessages,
  type SettingsMessage,
} from "@/lib/i18n/catalog/settings";
import {
  card,
  inputField,
  primaryButton,
  secondaryButton,
} from "@/entrypoints/popup/ui";

type ErrorCode =
  "forbidden" | "invalid-key" | "invalid-model" | "storage-failed" | "no-key";

const ERROR_MESSAGES = {
  forbidden: "providerSettings.error.forbidden",
  "invalid-key": "providerSettings.error.invalid-key",
  "invalid-model": "providerSettings.error.invalid-model",
  "storage-failed": "providerSettings.error.storage-failed",
  "no-key": "providerSettings.error.no-key",
} as const satisfies Record<ErrorCode, SettingsMessage>;

const TEST_MESSAGES = {
  valid: "providerSettings.test.valid",
  "invalid-key": "providerSettings.test.invalid-key",
  "model-unavailable": "providerSettings.test.model-unavailable",
  "rate-limited": "providerSettings.test.rate-limited",
  unreachable: "providerSettings.test.unreachable",
} as const satisfies Record<KeyTestResult, SettingsMessage>;

interface Loaded {
  settings: ProviderSettingsView;
  keyRejected: boolean;
}

type NoticeMessage =
  | (typeof ERROR_MESSAGES)[ErrorCode]
  | (typeof TEST_MESSAGES)[KeyTestResult]
  | "providerSettings.saved"
  | "providerSettings.removed"
  | "providerSettings.diagnosticsCopied"
  | "providerSettings.diagnosticsFailed";

type Notice = { tone: "ok" | "error"; message: NoticeMessage } | undefined;

function errorOf(value: unknown): ErrorCode {
  const code = (value as { error?: unknown } | undefined)?.error;
  return typeof code === "string" && code in ERROR_MESSAGES
    ? (code as ErrorCode)
    : "storage-failed";
}

function loadedOf(value: unknown): Loaded | undefined {
  const response = value as
    { ok?: unknown; settings?: unknown; keyRejected?: unknown } | undefined;
  if (response?.ok !== true) return undefined;
  const settings = parseProviderSettingsView(response.settings);
  return settings
    ? { settings, keyRejected: response.keyRejected === true }
    : undefined;
}

async function send(message: Record<string, unknown>) {
  return browser.runtime.sendMessage(message).catch(() => undefined);
}

function SettingsPage() {
  const t = useMessages(settingsMessages);
  const ids = { model: useId(), key: useId(), provider: useId() };
  const [loaded, setLoaded] = useState<Loaded | "failed">();
  const [model, setModel] = useState<OpenAIModel>("gpt-5-nano");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<
    "save" | "test" | "remove" | "diagnostics"
  >();
  const [notice, setNotice] = useState<Notice>();

  useEffect(() => {
    let active = true;
    void send({ type: PROVIDER_SETTINGS_GET }).then((value) => {
      if (!active) return;
      const next = loadedOf(value);
      setLoaded(next ?? "failed");
      if (next) setModel(next.settings.providers.openai.model);
    });
    return () => {
      active = false;
    };
  }, []);

  if (!loaded)
    return (
      <p className="text-muted text-sm">{t.t("providerSettings.loading")}</p>
    );
  if (loaded === "failed")
    return (
      <p role="alert" className="text-warn text-sm">
        {t.t("providerSettings.loadFailed")}
      </p>
    );

  const openai = loaded.settings.providers.openai;
  const typedKey = apiKey.trim();

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy("save");
    setNotice(undefined);
    const response = await send({
      type: PROVIDER_SETTINGS_SAVE,
      model,
      ...(typedKey ? { apiKey: typedKey } : {}),
    });
    const next = loadedOf(response);
    if (next) {
      setLoaded(next);
      setApiKey("");
      setNotice({ tone: "ok", message: "providerSettings.saved" });
    } else
      setNotice({ tone: "error", message: ERROR_MESSAGES[errorOf(response)] });
    setBusy(undefined);
  }

  async function test() {
    setBusy("test");
    setNotice(undefined);
    const response = (await send({
      type: PROVIDER_KEY_TEST,
      model,
      ...(typedKey ? { apiKey: typedKey } : {}),
    })) as { ok?: unknown; result?: unknown } | undefined;
    const result = response?.result;
    if (
      response?.ok === true &&
      (KEY_TEST_RESULTS as readonly unknown[]).includes(result)
    ) {
      setNotice({
        tone: result === "valid" ? "ok" : "error",
        message: TEST_MESSAGES[result as KeyTestResult],
      });
      // A test of the saved key can mark it rejected or clear that state.
      if (!typedKey) {
        const refreshed = loadedOf(await send({ type: PROVIDER_SETTINGS_GET }));
        if (refreshed) setLoaded(refreshed);
      }
    } else
      setNotice({ tone: "error", message: ERROR_MESSAGES[errorOf(response)] });
    setBusy(undefined);
  }

  async function copyDiagnostics() {
    setBusy("diagnostics");
    setNotice(undefined);
    const response = (await send({ type: DIAGNOSTICS_GET })) as
      { ok?: unknown; report?: unknown } | undefined;
    try {
      if (response?.ok !== true || !response.report)
        throw new Error("No diagnostics");
      await navigator.clipboard.writeText(
        JSON.stringify(response.report, null, 2),
      );
      setNotice({ tone: "ok", message: "providerSettings.diagnosticsCopied" });
    } catch {
      setNotice({
        tone: "error",
        message: "providerSettings.diagnosticsFailed",
      });
    }
    setBusy(undefined);
  }

  async function remove() {
    setBusy("remove");
    setNotice(undefined);
    const response = await send({ type: PROVIDER_KEY_REMOVE });
    const next = loadedOf(response);
    if (next) {
      setLoaded(next);
      setNotice({ tone: "ok", message: "providerSettings.removed" });
    } else
      setNotice({ tone: "error", message: ERROR_MESSAGES[errorOf(response)] });
    setBusy(undefined);
  }

  return (
    <form className={`${card} mx-0 flex flex-col gap-4`} onSubmit={save}>
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold">
          {t.t("providerSettings.section")}
        </h2>
        <p className="text-muted text-sm leading-5">
          {t.t("providerSettings.intro")}
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium" htmlFor={ids.provider}>
          {t.t("providerSettings.provider")}
        </label>
        <select
          id={ids.provider}
          className={inputField}
          value="openai"
          aria-describedby={`${ids.provider}-hint`}
          disabled
        >
          <option value="openai">
            {t.t("providerSettings.providerOpenAI")}
          </option>
        </select>
        <span id={`${ids.provider}-hint`} className="text-muted text-xs">
          {t.t("providerSettings.providerMore")}
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium" htmlFor={ids.model}>
          {t.t("providerSettings.model")}
        </label>
        <select
          id={ids.model}
          className={inputField}
          value={model}
          disabled={busy !== undefined}
          onChange={(event) => setModel(event.target.value as OpenAIModel)}
        >
          {OPENAI_MODELS.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium" htmlFor={ids.key}>
          {t.t("providerSettings.apiKey")}
        </label>
        <input
          id={ids.key}
          type="password"
          className={inputField}
          value={apiKey}
          placeholder={t.t("providerSettings.apiKeyPlaceholder")}
          autoComplete="off"
          spellCheck={false}
          aria-describedby={`${ids.key}-hint`}
          disabled={busy !== undefined}
          onChange={(event) => setApiKey(event.target.value)}
        />
        <span
          id={`${ids.key}-hint`}
          className={`text-xs ${loaded.keyRejected ? "text-warn" : "text-muted"}`}
        >
          {loaded.keyRejected
            ? t.t("providerSettings.keyRejected")
            : openai.configured && openai.maskedKey
              ? t.t("providerSettings.savedKey", { key: openai.maskedKey })
              : t.t("providerSettings.noKey")}
        </span>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          className={`${primaryButton} h-9`}
          disabled={busy !== undefined}
        >
          {t.t(
            busy === "save"
              ? "providerSettings.saving"
              : "providerSettings.save",
          )}
        </button>
        <button
          type="button"
          className={`${secondaryButton} h-9`}
          disabled={busy !== undefined || (!typedKey && !openai.configured)}
          onClick={() => void test()}
        >
          {t.t(
            busy === "test"
              ? "providerSettings.testing"
              : "providerSettings.test",
          )}
        </button>
        {openai.configured ? (
          <button
            type="button"
            className={`${secondaryButton} h-9`}
            disabled={busy !== undefined}
            onClick={() => void remove()}
          >
            {t.t("providerSettings.remove")}
          </button>
        ) : null}
      </div>

      <p
        role="status"
        aria-live="polite"
        className={`min-h-4 text-xs leading-4 ${notice?.tone === "error" ? "text-warn" : "text-muted"}`}
      >
        {notice ? t.t(notice.message) : ""}
      </p>

      <div className="border-line text-muted flex flex-col gap-2 border-t pt-3 text-xs leading-5">
        <p>{t.t("providerSettings.storageNote")}</p>
        <p>{t.t("providerSettings.privacyNote")}</p>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            type="button"
            className={`${secondaryButton} h-8 text-xs`}
            disabled={busy !== undefined}
            onClick={() => void copyDiagnostics()}
          >
            {t.t("providerSettings.diagnostics")}
          </button>
          <span>{t.t("providerSettings.diagnosticsHint")}</span>
        </div>
      </div>
    </form>
  );
}

function SettingsShell() {
  const t = useMessages(settingsMessages);
  return (
    <main className="bg-paper text-ink mx-auto flex min-h-screen max-w-xl flex-col gap-5 px-4 py-8 font-sans">
      <header className="flex items-center gap-2.5">
        <Mark className="size-8" />
        <h1 className="text-lg font-semibold tracking-[-0.01em]">
          Readlace · {t.t("providerSettings.title")}
        </h1>
      </header>
      <SettingsPage />
    </main>
  );
}

export default function App() {
  return (
    <UiLocaleProvider>
      <SettingsShell />
    </UiLocaleProvider>
  );
}
