import {
  parseWorkspaceEditorUrl,
  sameWorkspaceSourceIdentity,
  type WorkspaceEditorContext,
  workspaceSourceIdentity,
} from "./google-workspace-reader";
import { TARGET_LANGUAGES, type TargetLanguage } from "./translation";

export interface WorkspaceReaderIntent {
  id: string;
  createdAt: number;
  context: WorkspaceEditorContext;
  targetLanguage: TargetLanguage;
  account: string;
}

export const readerIntentKey = (tabId: number) =>
  `workspaceReaderIntent:${tabId}`;

export function sameReaderSource(
  a: WorkspaceEditorContext,
  b: WorkspaceEditorContext,
) {
  return sameWorkspaceSourceIdentity(
    workspaceSourceIdentity(a),
    workspaceSourceIdentity(b),
  );
}

function sameReaderFile(a: WorkspaceEditorContext, b: WorkspaceEditorContext) {
  return (
    a.sourceTabId === b.sourceTabId &&
    a.kind === b.kind &&
    a.fileId === b.fileId
  );
}

export function readReaderIntent(
  value: unknown,
  tabId: number,
): WorkspaceReaderIntent | undefined {
  if (!value || typeof value !== "object") return;
  const intent = value as WorkspaceReaderIntent;
  const context = intent.context;
  if (
    typeof intent.id !== "string" ||
    !/^[\w-]{1,80}$/.test(intent.id) ||
    !Number.isFinite(intent.createdAt) ||
    intent.createdAt > Date.now() ||
    Date.now() - intent.createdAt > 300_000 ||
    !context ||
    context.sourceTabId !== tabId ||
    context.kind !== "sheets" ||
    typeof context.fileId !== "string" ||
    !/^[\w-]{1,200}$/.test(context.fileId) ||
    (context.activeId !== null &&
      (typeof context.activeId !== "string" ||
        !/^\d{1,10}$/.test(context.activeId) ||
        Number(context.activeId) > 2_147_483_647)) ||
    !TARGET_LANGUAGES.some(({ code }) => code === intent.targetLanguage) ||
    typeof intent.account !== "string" ||
    !intent.account ||
    intent.account.length > 320
  )
    return;
  return intent;
}

// A panel and fallback tab must never both claim the same click.
export async function takeReaderIntent(tabId: number) {
  if (!navigator.locks || !browser.storage?.session) return;
  const key = readerIntentKey(tabId);
  return navigator.locks.request(key, async () => {
    const stored = await browser.storage.session.get(key);
    const intent = readReaderIntent(stored[key], tabId);
    if (stored[key] !== undefined) await browser.storage.session.remove(key);
    if (!intent) return;
    const current = await currentReaderIntentSource(intent);
    return current && sameReaderFile(intent.context, current)
      ? intent
      : undefined;
  });
}

async function currentReaderIntentSource(intent: WorkspaceReaderIntent) {
  if (!readReaderIntent(intent, intent.context.sourceTabId)) return;
  const [tab, auth] = await Promise.all([
    browser.tabs.get(intent.context.sourceTabId),
    browser.runtime.sendMessage({ type: "AUTH_STATUS" }),
  ]);
  const current = parseWorkspaceEditorUrl(tab.url ?? "");
  if (!current) return;
  if (
    !auth?.authenticated ||
    auth.unavailable ||
    auth.user?.email !== intent.account
  )
    return;
  return { ...current, sourceTabId: intent.context.sourceTabId };
}

export async function readerIntentIsCurrent(intent: WorkspaceReaderIntent) {
  const current = await currentReaderIntentSource(intent);
  return Boolean(current && sameReaderSource(intent.context, current));
}

/**
 * Rebinds a claimed click only after Reader has obtained a fresh authoritative
 * context. A raw no-gid URL may resolve to that context, but never matches an
 * arbitrary existing grid.
 */
export async function readerIntentForCurrentSource(
  intent: WorkspaceReaderIntent,
  authoritativeContext: WorkspaceEditorContext,
) {
  const current = await currentReaderIntentSource(intent);
  if (
    !current ||
    !sameReaderFile(intent.context, current) ||
    !sameReaderFile(current, authoritativeContext) ||
    authoritativeContext.kind !== "sheets" ||
    authoritativeContext.activeId === null ||
    (current.activeId !== null &&
      current.activeId !== authoritativeContext.activeId)
  )
    return;
  return { ...intent, context: authoritativeContext };
}
