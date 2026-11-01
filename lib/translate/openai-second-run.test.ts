import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isDeterministicTranslationValue } from "./format-guards";
import {
  createOpenAIHtmlTranslator,
  type OpenAITranslationMap,
} from "./openai-html";

const captured = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "fixtures/openai-untranslated-batch.html",
  ),
  "utf8",
).trim();
const contentSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../entrypoints/content.ts"),
  "utf8",
);
const backgroundSource = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../entrypoints/background.ts",
  ),
  "utf8",
);

function translatedEntries(
  sources: OpenAITranslationMap,
): OpenAITranslationMap {
  return Object.fromEntries(
    Object.entries(sources).map(([id, source]) => [id, `vi:${source}`]),
  );
}

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    async get(key: string) {
      return data.get(key);
    },
    async set(key: string, value: string) {
      data.set(key, value);
    },
    async getMany(keys: string[]) {
      return Object.fromEntries(
        keys.flatMap((key) => {
          const value = data.get(key);
          return value === undefined ? [] : [[key, value]];
        }),
      );
    },
    async setMany(entries: Record<string, string>) {
      Object.entries(entries).forEach(([key, value]) => data.set(key, value));
    },
    async getAll() {
      return Object.fromEntries(data);
    },
    async remove(keys: string[]) {
      keys.forEach((key) => data.delete(key));
    },
  };
}

function unescapeHtml(text: string) {
  return text
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function nodesFromPiece(html: string): string[] {
  let inner = html.trim();
  if (inner.includes("<pre")) {
    inner = inner.replace(/<\/pre>\s*$/i, "");
    inner = inner.slice(inner.indexOf(">") + 1);
  }
  const matches = [
    ...inner.matchAll(/<a\s+i=([0-9]+)>((?:(?!<\/a>).)*)<\/a>/gi),
  ];
  if (!matches.length) return [unescapeHtml(inner)];
  const sorted: string[] = [];
  for (const match of matches) {
    sorted[Number.parseInt(match[1] ?? "", 10)] = unescapeHtml(match[2] ?? "");
  }
  return sorted.map((text) => text ?? "");
}

function sourcesFromCaptured(html: string): string[][] {
  const found = [...html.matchAll(/<batch\s+i=([0-9]+)>([\s\S]*?)<\/batch>/gi)];
  found.sort(
    (left, right) =>
      Number.parseInt(left[1] ?? "", 10) - Number.parseInt(right[1] ?? "", 10),
  );
  return found.map((match) => nodesFromPiece(match[2] ?? ""));
}

function applyLikeContentScript(nodes: Text[], translated: string[]) {
  const restore: {
    node: Text;
    originalText: string;
    translatedText: string;
  }[] = [];
  nodes.forEach((node, index) => {
    const text = translated[index];
    if (!text) return;
    const translatedText = text;
    restore.push({
      node,
      originalText: node.textContent ?? "",
      translatedText,
    });
    node.textContent = translatedText;
  });
  return restore;
}

function showOriginalLikeContentScript(
  restore: {
    node: Text;
    originalText: string;
    translatedText: string;
  }[],
) {
  for (const item of restore) {
    if (item.node.textContent === item.translatedText)
      item.node.textContent = item.originalText;
  }
}

describe("OpenAI second translation run after Show original", () => {
  it("consumes only translation-retaining layout outcomes", () => {
    const helperStart = contentSource.indexOf(
      "const applyTranslatedLayout = (",
    );
    const helperEnd = contentSource.indexOf(
      "const retainedTranslation =",
      helperStart,
    );
    const helperSource = contentSource.slice(helperStart, helperEnd);

    expect(helperStart).toBeGreaterThan(-1);
    expect(helperEnd).toBeGreaterThan(helperStart);
    expect(contentSource.match(/\bapplyLayoutConstraint\(/g)).toHaveLength(1);
    expect(contentSource).toContain("type LayoutApplicationResult");
    expect(contentSource).toContain("type LayoutCapacityPolicy");
    expect(helperSource).toMatch(
      /const result: LayoutApplicationResult = applyLayoutConstraint\(\s*constraint,\s*item\.translatedText,\s*1,\s*capacityPolicy,?\s*\)/,
    );
    expect(helperSource).toMatch(
      /item\.wrapper = result\.wrapper;[\s\S]*item\.lastAppliedHostRect = visibleHostRect\(constraint\.host\);[\s\S]*return result/,
    );
    expect(contentSource).not.toContain('outcome === "source"');
    expect(contentSource).not.toContain("keepLayoutSource");
    expect(helperSource).not.toMatch(
      /\b(?:async|await|sendMessage|setTimeout|setInterval)\b/,
    );
    expect(contentSource).not.toContain("installLayoutConstraint");
    expect(contentSource).not.toContain("layoutConstraintMatchesBaseline");
    expect(contentSource).not.toContain("layoutConstraintOverflows");
    expect(contentSource).toContain(
      "BASELINE_MARKER_TAG}.${BASELINE_MARKER_CLASS}",
    );
  });

  it("validates only the current write and retains raw translation after one retry", () => {
    const applyStart = contentSource.indexOf("const applyPieces = async (");
    const applyEnd = contentSource.indexOf(
      "const refreshEntry = (",
      applyStart,
    );
    const applySource = contentSource.slice(applyStart, applyEnd);

    expect(applyStart).toBeGreaterThan(-1);
    expect(applyEnd).toBeGreaterThan(applyStart);
    expect(contentSource).not.toContain("activeConstraints");
    expect(applySource).not.toMatch(
      /\b(?:sendMessage|setInterval|hostname|querySelector|closest)\b/,
    );
    expect(applySource).not.toMatch(/\b(?:repairBudget|findIndex|while)\b/);
    expect(applySource.match(/"source-only"/g)).toHaveLength(1);
    expect(applySource).toMatch(
      /applyTranslatedLayout\(restore, constraint\);[\s\S]*!layoutProtectedGeometryMatchesBaseline\(constraint, 1\)[\s\S]*applyTranslatedLayout\(restore, constraint, "source-only"\)[\s\S]*keepTranslatedRaw\(restore, constraint\)/,
    );
    expect(applySource).toMatch(
      /if \(retainedTranslation\(job\.restore\)\) \{\s*releaseDeferredResult\(job\.node\);\s*nodesToRestore\.set\(job\.node, job\.restore\);[\s\S]*piece\.nodes = residualNodesByPiece\[index\]!;[\s\S]*piece\.isTranslated =\s*committedByPiece\[index\]!\s*&&\s*piece\.nodes\.length === 0\s*&&\s*!deferredPieces\.has\(piece\)/,
    );
    expect(applySource.indexOf("piece.isTranslated =")).toBeGreaterThan(
      applySource.indexOf("retainedTranslation(job.restore)"),
    );
    expect(applySource).not.toContain("item.originalText");
  });

  it("keeps adaptive multi-record staging below the 8ms budget without painting before repair", () => {
    const chunkStart = contentSource.indexOf("const APPLY_SLICE_MS = 6;");
    const chunkEnd = contentSource.indexOf(
      "// Stage 5 — retention bookkeeping",
      chunkStart,
    );
    const chunkSource = contentSource.slice(chunkStart, chunkEnd);
    const capture = chunkSource.indexOf(
      "job.restore.constraint = captureLayoutConstraint(job.node)",
    );
    const write = chunkSource.indexOf(
      "job.node.data = job.restore.translatedText",
    );
    const validate = chunkSource.indexOf(
      "rawTranslationMatchesBaseline(constraint, 1)",
    );
    const repair = chunkSource.indexOf(
      "applyTranslatedLayout(restore, constraint);",
    );
    const yieldAfterRepair = chunkSource.indexOf("await yieldToMain()");

    expect(chunkSource).toContain("const APPLY_SLICE_MS = 6;");
    expect(chunkSource).toContain("const MAX_ADAPTIVE_CHUNK = 16;");
    expect(chunkSource).toMatch(
      /let chunkStart = 0, chunkSize = Math\.min\(4, jobs\.length\);[\s\S]*Math\.floor\(\(candidates\.length \* APPLY_SLICE_MS\) \/ chunkDuration\)/,
    );
    expect(chunkSource).toMatch(
      /const candidates = jobs\.slice\(chunkStart, chunkStart \+ chunkSize\);[\s\S]*const chunk = candidates\.filter\([\s\S]*if \(rendered\(job\.pieceIndex, job\.node\)\) return true;[\s\S]*defer\([\s\S]*return false;[\s\S]*chunkStart \+= candidates\.length;/,
    );
    expect(contentSource).not.toContain("const CHUNK_SIZE = 40;");
    expect(capture).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(capture);
    expect(validate).toBeGreaterThan(write);
    expect(repair).toBeGreaterThan(validate);
    expect(yieldAfterRepair).toBeGreaterThan(repair);
    expect(chunkSource.slice(0, yieldAfterRepair)).not.toContain("await ");
  });

  it("commits successful Text records and leaves only source-valid residual work", () => {
    const applyStart = contentSource.indexOf("const applyPieces = async (");
    const applyEnd = contentSource.indexOf(
      "const refreshEntry = (",
      applyStart,
    );
    const applySource = contentSource.slice(applyStart, applyEnd);
    const sendStart = contentSource.indexOf("const dispatchPieces = async");
    const sendEnd = contentSource.indexOf(
      "const dispatchAttributes = async",
      sendStart,
    );
    const sendSource = contentSource.slice(sendStart, sendEnd);

    expect(contentSource).toContain(
      "const nodesToRestore = new Map<Text, RestoreNode>();",
    );
    expect(contentSource).not.toContain("preserveUntranslatedSource");
    expect(applySource).toMatch(
      /requested: Text\[\]\[\][\s\S]*const requestedNodes = requested\[index\] \?\? \[\];[\s\S]*!providerText[\s\S]*node\.isConnected\s*&&\s*node\.data === source[\s\S]*residualNodesByPiece\[index\]!\.push\(node\)/,
    );
    expect(applySource).toContain("const translatedText = providerText;");
    expect(applySource).toMatch(
      /piece\.nodes = residualNodesByPiece\[index\]!;\s+sources\[index\] = residualSourcesByPiece\[index\]!;/,
    );
    expect(contentSource).toMatch(
      /const recordCanDispatch =[\s\S]*!item\.isTranslated &&[\s\S]*recordIsActive\(item\)/,
    );
    expect(sendSource).toMatch(
      /const requestedNodes = piecesNow\.map\(\(piece\) => \[\.\.\.piece\.nodes\]\);[\s\S]*await applyPieces\(\s*currentRun,\s*piecesNow,\s*requestedNodes,\s*sources,\s*primaryResults/,
    );
    expect(contentSource).toMatch(
      /new Set\([\s\S]*pieces\.flatMap\([\s\S]*nodesToRestore\.keys\(\)/,
    );
  });

  it("refreshes each stored constraint independently without source rollback", () => {
    const restoreStart = contentSource.indexOf("const restorePage = (");
    const restoreEnd = contentSource.indexOf(
      "const applyPieces = async (",
      restoreStart,
    );
    const restoreSource = contentSource.slice(restoreStart, restoreEnd);
    const refreshStart = contentSource.indexOf("const refreshEntry = (");
    const refreshEnd = contentSource.indexOf(
      "type ContentBatch =",
      refreshStart,
    );
    const refreshSource = contentSource.slice(refreshStart, refreshEnd);

    expect(refreshStart).toBeGreaterThan(-1);
    expect(refreshEnd).toBeGreaterThan(refreshStart);
    expect(contentSource).toMatch(
      /constraint: LayoutConstraint \| null;\s+lastAppliedHostRect: RectSnapshot \| null;/,
    );
    expect(refreshSource).not.toMatch(
      /\b(?:async|await|sendMessage|setTimeout|setInterval)\b/,
    );
    expect(refreshSource).toContain(
      "const ownershipChanged = !constraint.host.contains(item.node);",
    );
    expect(contentSource).toMatch(
      /style\.display === "none"[\s\S]*style\.visibility !== "visible"[\s\S]*rect\.width > 0 && rect\.height > 0/,
    );
    expect(contentSource.match(/Math\.abs\([^\n]+\) > 1/g)).toHaveLength(4);
    expect(refreshSource).toMatch(
      /const ownershipChanged = !constraint\.host\.contains\(item\.node\);[\s\S]*geometryChanged =\s*hostRectChanged\(currentRect, previousRect\) \|\|\s*!layoutProtectedGeometryMatchesBaseline\(constraint, 1\);[\s\S]*ownershipChanged \|\| geometryChanged[\s\S]*recaptureLayoutConstraint\(\s*constraint,\s*item\.translatedText/,
    );
    expect(refreshSource.match(/"source-only"/g)).toHaveLength(1);
    expect(refreshSource).toMatch(
      /applyTranslatedLayout\(item, constraint\);[\s\S]*applyTranslatedLayout\(item, constraint, "source-only"\)[\s\S]*keepTranslatedRaw\(item, constraint\)/,
    );
    expect(refreshSource).not.toContain("originalText");
    expect(refreshSource).toMatch(
      /item\.wrapper && item\.node\.parentElement !== item\.wrapper[\s\S]*item\.wrapper\.isConnected\) releaseLayoutWrapper\(item\.wrapper\);[\s\S]*item\.constraint = null;[\s\S]*return;/,
    );
    expect(restoreSource).toMatch(
      /item\.node\.parentElement !== item\.wrapper[\s\S]*item\.wrapper\.isConnected && !item\.wrapper\.hasChildNodes\(\)[\s\S]*item\.wrapper\.remove\(\);[\s\S]*item\.wrapper = null;[\s\S]*item\.node\.textContent === item\.translatedText[\s\S]*item\.node\.textContent = item\.originalText/,
    );
    expect(contentSource).toMatch(
      /const translationRoutine[\s\S]*try \{\s+refreshLayoutConstraints\(\);[\s\S]*sendVisible\(currentRun\)/,
    );
    expect(refreshSource).not.toContain("createTextNode");
  });

  it("recaptures peer-only geometry changes but ignores scroll-only movement", () => {
    const refreshStart = contentSource.indexOf("const refreshEntry = (");
    const refreshEnd = contentSource.indexOf(
      "type ContentBatch =",
      refreshStart,
    );
    const refreshSource = contentSource.slice(refreshStart, refreshEnd);

    expect(contentSource).toContain(
      "x: x + window.scrollX, y: y + window.scrollY, width, height",
    );
    expect(refreshSource).toMatch(
      /geometryChanged =\s*hostRectChanged\(currentRect, previousRect\) \|\|\s*!layoutProtectedGeometryMatchesBaseline\(constraint, 1\);[\s\S]*if \(!geometryChanged\) return;[\s\S]*recaptureLayoutConstraint/,
    );
  });

  it("marks selected records attempted and increments their bounded count", () => {
    const sendStart = contentSource.indexOf("const recordCanDispatch =");
    const sendEnd = contentSource.indexOf(
      "const registerCollected =",
      sendStart,
    );
    const sendSource = contentSource.slice(sendStart, sendEnd);

    expect(contentSource).toContain(
      "const attempted = new Set<TranslationRecord>();",
    );
    expect(sendSource).toMatch(
      /const recordCanDispatch =[\s\S]*!attempted\.has\(item\)[\s\S]*attempted\.add\(item\);[\s\S]*attemptCounts\.set\(item,[\s\S]*selected\.push\(item\)/,
    );
    expect(sendSource).toMatch(
      /reserveBatch\(currentRun\);[\s\S]*request\.finally\(\(\) => \{\s*releaseBatch\(currentRun\);/,
    );
    expect(contentSource).toMatch(
      /activeContentBatches\.clear\(\);\s+attempted\.clear\(\);\s+attemptCounts\.clear\(\);\s+retryNotBefore\.clear\(\);\s+initialCohort\.clear\(\);/,
    );
    expect(contentSource).not.toContain("await sendVisible(currentRun)");
  });

  it("pins run context without a client provider and coalesces bulk until initial collection completes", () => {
    const sendStart = contentSource.indexOf("const nextBatch =");
    const sendEnd = contentSource.indexOf(
      "const registerCollected =",
      sendStart,
    );
    const sendSource = contentSource.slice(sendStart, sendEnd);
    const start = contentSource.indexOf("const startTranslation = async");
    const startEnd = contentSource.indexOf(
      "browser.runtime.onMessage.addListener",
      start,
    );
    const startSource = contentSource.slice(start, startEnd);
    const begin = backgroundSource.indexOf(
      'if (message.type === "BEGIN_TRANSLATION_RUN")',
    );
    const beginEnd = backgroundSource.indexOf(
      'if (message.type === "TRANSLATE_HTML")',
      begin,
    );
    const beginSource = backgroundSource.slice(begin, beginEnd);

    expect(beginSource).toMatch(
      /const context = await contextForRun\(sender, message\.runId, true\);[\s\S]*ok: true,[\s\S]*sourceLanguageHint: context\.sourceLanguageHint/,
    );
    expect(beginSource).not.toContain("provider");
    expect(startSource).toMatch(
      /const started = await Promise\.race\(\[[\s\S]*browser\.runtime\.sendMessage\([\s\S]*type: "BEGIN_TRANSLATION_RUN"[\s\S]*cancelled,[\s\S]*if \(claimedStart !== startToken \|\| currentRun !== runId\) return state;[\s\S]*if \(stopForAuth\(currentRun, started\)\) return state;[\s\S]*if \(started\?\.ok !== true\) throw new Error\("Invalid translation run"\);[\s\S]*restorePage\(\);[\s\S]*translationActive = true;/,
    );
    expect(contentSource).toMatch(
      /laneQueues\.priority\.splice\(0\);\s+laneQueues\.bulk\.splice\(0\);[\s\S]*laneScanCursors\.priority = 0;[\s\S]*laneScanRemaining\.bulk = 0;[\s\S]*translationActive = false;/,
    );
    expect(sendSource).toMatch(
      /const lanes = \["priority", "bulk"\] as const;[\s\S]*let laneIndex = selectionLaneIndex[\s\S]*const maxRecords = lane === "priority" \? 24 : 128;[\s\S]*const maxCharacters = lane === "priority" \? 600 : 8_000;/,
    );
    expect(sendSource).toMatch(
      /if \(lane === "bulk" && !initialCollectionDone\) \{\s*selectionLaneIndex = 0;\s*return \{ budgetExpired: false \};\s*\}/,
    );
    expect(sendSource).toMatch(
      /const scanLimit = Math\.min\([\s\S]*laneScanRemaining\[lane\] \|\| queue\.length[\s\S]*performance\.now\(\) - selectionStartedAt >= BATCH_SELECTION_MS[\s\S]*saveLaneCursor\(lane, queue, index, dropped\)/,
    );
    expect(contentSource).toContain("const BATCH_SELECTION_MS = 6;");
    expect(sendSource).toMatch(
      /item\.isTranslated \|\| !recordIsActive\(item\)[\s\S]*dropped\.add\(item\)/,
    );
    expect(sendSource).toMatch(
      /const scheduleSelectionContinuation =[\s\S]*selectionContinuationRun === currentRun[\s\S]*await yieldToMain\(\)[\s\S]*sendVisible\(currentRun\)/,
    );
    expect(sendSource).toMatch(
      /!translationActive[\s\S]*const maxContentBatches = TRANSLATION_CONCURRENCY;[\s\S]*const fallbackOnly = runFailed;[\s\S]*\(!runFailed \|\| fallbackOnly\)[\s\S]*activeBatchCount\(currentRun\) < maxContentBatches[\s\S]*nextBatch\(selectionStartedAt, !fallbackOnly\)[\s\S]*launchBatch\(currentRun, selection\.batch, fallbackOnly\)[\s\S]*selection\.budgetExpired[\s\S]*scheduleSelectionContinuation\(currentRun\)/,
    );
    expect(contentSource).toMatch(
      /if \(drained\.done\) \{[\s\S]*if \(pending\.initial\) initialCollectionDone = true;[\s\S]*const pumpCollectors =[\s\S]*drainCollectorSlice\(currentRun\);\s*sendVisible\(currentRun\);/,
    );
    expect(contentSource).toMatch(
      /const translateTitle = async[\s\S]*reserveBatch\(currentRun\);[\s\S]*type: "TRANSLATE_SINGLE"[\s\S]*finally \{\s*releaseBatch\(currentRun\);/,
    );
    expect(startSource).not.toContain("translateTitle(currentRun)");
    expect(sendSource).toMatch(
      /titlePendingRun === currentRun[\s\S]*initialCollectionDone[\s\S]*activeBatchCount\(currentRun\) < maxContentBatches[\s\S]*titlePendingRun = undefined;\s*void translateTitle\(currentRun\)/,
    );
    expect(backgroundSource).toMatch(
      /openai\.translateHtml\([\s\S]*message\.targetLanguage,[\s\S]*context,/,
    );
    expect(backgroundSource).toMatch(
      /openai\.translateText\([\s\S]*message\.texts as string\[\],[\s\S]*message\.targetLanguage,[\s\S]*context,/,
    );
  });

  it("pins run context to one document and purges stale tab contexts", () => {
    const identityStart = backgroundSource.indexOf("interface RunSender {");
    const identityEnd = backgroundSource.indexOf(
      "const isTarget =",
      identityStart,
    );
    const identitySource = backgroundSource.slice(identityStart, identityEnd);
    const messagesStart = backgroundSource.indexOf(
      'if (message.type === "BEGIN_TRANSLATION_RUN")',
    );
    const messagesEnd = backgroundSource.indexOf(
      'if (message.type === "CLEAR_SAVED_TRANSLATIONS")',
      messagesStart,
    );
    const messagesSource = backgroundSource.slice(messagesStart, messagesEnd);
    const firstDocument = "7:0:document-a:1";
    const secondDocument = "7:0:document-b:1";
    const contexts = new Map<string, string>();

    contexts.set(firstDocument, "google:ja");
    contexts.set(secondDocument, "openai:en");
    contexts.set(secondDocument, "google:vi");

    expect(firstDocument).not.toBe(secondDocument);
    expect(contexts.get(firstDocument)).toBe("google:ja");
    expect(contexts.get(secondDocument)).toBe("google:vi");
    expect(identitySource).toMatch(
      /documentId\?: string;[\s\S]*sender\.documentId \?\? "document\?"/,
    );
    expect(identitySource).toMatch(
      /refresh = false[\s\S]*const generation = auth\.getGeneration\(\);[\s\S]*if \(!refresh && existing\?\.generation === generation\) return existing;[\s\S]*if \(!refresh && runId !== undefined\) throw new AuthRequiredError\(\);[\s\S]*assertGeneration\(generation\);[\s\S]*activeRunIdsByOwner\.get\(nativeOwnerKey\(sender\)\) !== runId[\s\S]*throw new AuthRequiredError\(\);[\s\S]*runContexts\.set\(key, context\)/,
    );
    expect(messagesSource).toMatch(
      /BEGIN_TRANSLATION_RUN[\s\S]*contextForRun\(sender, message\.runId, true\)/,
    );
    expect(messagesSource).toMatch(
      /TRANSLATE_HTML[\s\S]*contextForRun\(sender, message\.runId\)/,
    );
    expect(messagesSource).not.toMatch(
      /TRANSLATE_HTML[\s\S]*contextForRun\(sender, message\.runId, true\)/,
    );
    expect(backgroundSource).toMatch(
      /const clearRunContextsForTab =[\s\S]*key\.startsWith\(prefix\)[\s\S]*runContexts\.delete\(key\)/,
    );
    expect(backgroundSource).toMatch(
      /tabs\.onUpdated\.addListener[\s\S]*clearRunContextsForTab\(tabId\)[\s\S]*tabs\.onRemoved\.addListener[\s\S]*clearRunContextsForTab\(tabId\)/,
    );
  });

  it("budgets both providers by provider-bound nodes while retaining local-only values", () => {
    const costStart = contentSource.indexOf("const providerBoundCost =");
    const costEnd = contentSource.indexOf(
      "interface BatchSelection",
      costStart,
    );
    const batchStart = contentSource.indexOf("const nextBatch =");
    const batchEnd = contentSource.indexOf(
      "const dispatchPieces =",
      batchStart,
    );
    const costSource = contentSource.slice(costStart, costEnd);
    const batchSource = contentSource.slice(batchStart, batchEnd);
    const mixed = Array.from({ length: 43 }, (_, index) => [
      `請求${index}`,
      `¥${index + 1},000`,
    ]).flat();
    const providerBound = mixed.filter(
      (value) => !isDeterministicTranslationValue(value),
    );
    const longPriority = ["請".repeat(680), "求".repeat(680)];

    expect(mixed).toHaveLength(86);
    expect(providerBound).toHaveLength(43);
    expect(
      providerBound.length,
      "backend stage provider-bound records",
    ).toBeLessThanOrEqual(128);
    expect(providerBound.join("").length).toBeLessThan(8_000);
    expect(longPriority.every((value) => value.length > 600)).toBe(true);
    expect(costSource).toMatch(
      /"nodes" in item \? item\.nodes\.map\(\(node\) => node\.data\) : \[item\.original\]/,
    );
    expect(costSource).toMatch(
      /values\.filter\([\s\S]*!isDeterministicTranslationValue\(value\)[\s\S]*records: providerValues\.length/,
    );
    expect(costSource).not.toContain("translationActive");
    expect(contentSource).toContain("const MAX_CONTENT_ITEMS = 128;");
    expect(batchSource).toMatch(
      /cost\.records > 0[\s\S]*providerRecords \+ cost\.records > maxRecords[\s\S]*characters \+ cost\.characters > maxCharacters/,
    );
    expect(batchSource).toMatch(
      /selected\.length > 0 &&[\s\S]*characters \+ cost\.characters > maxCharacters[\s\S]*return \{[\s\S]*batch: selectedBatch/,
    );
    expect(batchSource).toMatch(
      /selected\.push\(item\);\s*providerRecords \+= cost\.records;\s*characters \+= cost\.characters;/,
    );
    expect(batchSource).not.toMatch(
      /providerRecords >= maxRecords|characters >= maxCharacters/,
    );
  });

  it("bounds application-owned retries and keeps lazy eligibility", () => {
    const sendStart = contentSource.indexOf("const recordIsVisible =");
    const sendEnd = contentSource.indexOf(
      "const registerCollected =",
      sendStart,
    );
    const sendSource = contentSource.slice(sendStart, sendEnd);

    expect(contentSource).toContain(
      "const attempted = new Set<TranslationRecord>();",
    );
    expect(sendSource).toMatch(
      /const recordCanDispatch =[\s\S]*!attempted\.has\(item\)[\s\S]*retryNotBefore\.get\(item\)[\s\S]*attempted\.add\(item\);[\s\S]*attemptCounts\.set\(item,[\s\S]*selected\.push\(item\)/,
    );
    expect(sendSource).toMatch(
      /pieceIsInViewport\([\s\S]*innerHeight,[\s\S]*innerWidth,[\s\S]*innerHeight,[\s\S]*innerWidth,/,
    );
    expect(sendSource).toMatch(
      /response\?\.failures[\s\S]*consumeFailures\(piecesNow, failures, committed\)/,
    );
    expect(contentSource).not.toContain("response?.errors");
    expect(contentSource).toMatch(
      /const consumeFailures =[\s\S]*failure\.scope === "run"[\s\S]*runFailed = true;\s*retryNotBefore\.clear\(\);[\s\S]*if \(runFailed \|\| \(failure && !failure\.retryable\)\) return;\s*retrying\[index\] = scheduleRetry\(item, failure\?\.retryAfterMs\)[\s\S]*console\.error/,
    );
    expect(contentSource).toContain("const MAX_PROVIDER_ATTEMPTS = 3");
    expect(contentSource).toContain("const RETRY_DELAYS_MS = [500, 1_500]");
    expect(contentSource).toContain("const MAX_RETRY_DELAY_MS = 30_000");
    expect(contentSource).toMatch(
      /const initialCohort = new Set<TranslationRecord>\(\);[\s\S]*activeBatchCount\(currentRun\) > 0 \|\|[\s\S]*!initialCollectionDone[\s\S]*settlePageTranslationState\(\{ accepted, unresolved \}\)/,
    );
    expect(contentSource).toMatch(
      /const visible = recordIsVisible\(item\);[\s\S]*if \(initial && visible\) initialCohort\.add\(item\);/,
    );
    expect(contentSource).toMatch(
      /translated: state === "translated" \|\| state === "partial",\s+appliedTarget,\s+hasUnresolved: hasUnresolved\(\)/,
    );
    expect(contentSource).toMatch(
      /const delay =[\s\S]*Math\.min\(300,[\s\S]*ctx\.setTimeout\([\s\S]*translationRoutine\(currentRun\)[\s\S]*delay/,
    );
    expect(contentSource).not.toContain("IntersectionObserver");
    expect(contentSource).not.toContain("addEventListener(");
  });

  it("normalizes dynamic Text and added roots without new scheduling", () => {
    const registerStart = contentSource.indexOf("const registerCollected =");
    const drainStart = contentSource.indexOf("const drainMutations =");
    const routineStart = contentSource.indexOf("const translationRoutine =");
    const mutationStart = contentSource.indexOf("const absorbMutations =");
    const mutationEnd = contentSource.indexOf(
      "const translateTitle =",
      mutationStart,
    );
    const drainSource = contentSource.slice(drainStart, routineStart);
    const registerSource = contentSource.slice(registerStart, drainStart);
    const mutationSource = contentSource.slice(mutationStart, mutationEnd);

    expect(contentSource).toContain(
      "x: x + window.scrollX, y: y + window.scrollY, width, height",
    );
    expect(contentSource).toMatch(
      /hostRectChanged\(currentRect, previousRect\)[\s\S]*layoutProtectedGeometryMatchesBaseline\(constraint, 1\)/,
    );
    expect(drainSource).toMatch(
      /node instanceof Text[\s\S]*node\.parentElement\?\.isConnected[\s\S]*node instanceof DocumentFragment/,
    );
    expect(registerSource).toMatch(
      /const existingNodes = new Set\([\s\S]*pieces\.flatMap[\s\S]*piece\.nodes\.filter[\s\S]*const lane = translationLane\(item\);[\s\S]*laneQueues\[lane\]\.push\(item\)[\s\S]*laneScanRemaining\[lane\] = 0/,
    );
    expect(registerSource).toMatch(
      /const drainCollectorSlice =[\s\S]*const started = performance\.now\(\);[\s\S]*Math\.max\(0, 8 - \(performance\.now\(\) - started\)\)[\s\S]*pending\.collector\.drain\(remaining\)/,
    );
    expect(registerSource).toMatch(
      /const pumpCollectors =[\s\S]*drainCollectorSlice\(currentRun\);[\s\S]*sendVisible\(currentRun\);[\s\S]*await yieldToMain\(\)/,
    );
    expect(contentSource).toMatch(
      /const yieldToMain =[\s\S]*scheduler\?\.yield[\s\S]*scheduler\.yield\(\)[\s\S]*window\.setTimeout\(resolve, 0\)/,
    );
    expect(drainSource).toMatch(
      /createTranslationCollector\(root, location\.hostname\)[\s\S]*if \(roots\.length\) pumpCollectors\(currentRun\);/,
    );
    expect(mutationSource).toContain("observer.observe(document.body");
    expect(mutationSource).toContain("characterData: true");
    expect(mutationSource).toMatch(
      /mutation\.type === "characterData"[\s\S]*extensionWrites\.has\(node\)[\s\S]*piece\.nodes = piece\.nodes\.filter[\s\S]*addedNodes\.push\(node\)/,
    );
    expect(contentSource).not.toContain("mutationTimer");
    expect(contentSource).not.toContain("setInterval(");
    expect(contentSource).not.toContain("2000)");
    expect(drainSource).toMatch(
      /new Set\(\[\.\.\.attempted, \.\.\.retryNotBefore\.keys\(\)\]\)[\s\S]*attempted\.delete\(item\)[\s\S]*retryNotBefore\.delete\(item\)/,
    );
    expect(contentSource).toMatch(
      /const translationRoutine =[\s\S]*drainMutations\(currentRun\);[\s\S]*sendVisible\(currentRun\);/,
    );
    expect(contentSource).toContain(
      "const extensionWrites = new WeakSet<Text>();",
    );
  });

  it("claims overlapping starts before awaits and installs one current lifecycle", () => {
    const start = contentSource.indexOf("const startTranslation = async");
    const end = contentSource.indexOf(
      "browser.runtime.onMessage.addListener",
      start,
    );
    const source = contentSource.slice(start, end);

    expect(source).toMatch(
      /const claimedStart = \+\+startToken;[\s\S]*runId \+= 1;[\s\S]*cancelPendingStart = \(\) => resolve\(undefined\);[\s\S]*const started = await Promise\.race\([\s\S]*type: "BEGIN_TRANSLATION_RUN"[\s\S]*if \(claimedStart !== startToken \|\| currentRun !== runId\) return state;/,
    );
    expect(source).not.toContain("DETECT_TAB_LANGUAGE");
    expect(source).toMatch(
      /new Promise<PageTranslationState>[\s\S]*createTranslationCollector\([\s\S]*initial: true,[\s\S]*absorbMutations\(currentRun\);[\s\S]*pumpCollectors\(currentRun\);[\s\S]*translationRoutine\(currentRun\)[\s\S]*return completion/,
    );
    expect(contentSource).toMatch(
      /message\.type === "SHOW_ORIGINAL"[\s\S]*startToken \+= 1;[\s\S]*runId \+= 1;[\s\S]*restorePage\(cancelledRun \|\| undefined\)/,
    );
    expect(contentSource.match(/new MutationObserver\(/g)).toHaveLength(1);
  });

  it("ignores obsolete async errors and surfaces current-run failures", () => {
    const sendStart = contentSource.indexOf("const dispatchPieces = async");
    const sendEnd = contentSource.indexOf("const launchBatch =", sendStart);
    const sendSource = contentSource.slice(sendStart, sendEnd);
    const listenerStart = contentSource.indexOf(
      "browser.runtime.onMessage.addListener",
    );
    const listenerSource = contentSource.slice(listenerStart);

    expect(sendSource.match(/catch \(error\) \{/g)).toHaveLength(2);
    expect(
      sendSource.match(
        /if \(currentRun !== runId\) return;\s+runFailed = true;/g,
      ),
    ).toHaveLength(2);
    expect(listenerSource).toMatch(
      /const translation = startTranslation[\s\S]*const currentStart = startToken;[\s\S]*translation\.catch\(\(error\) => \{\s*if \(currentStart !== startToken\) return;\s*console\.error\(error\);\s*state = "error";/,
    );
  });

  it("does not call OpenAI again for a piece that was translated", async () => {
    let calls = 0;
    const html = createOpenAIHtmlTranslator({
      completeHtml: async (sources) => {
        calls += 1;
        return translatedEntries(sources);
      },
      storage: memoryStorage(),
      getApiKey: async () => "sk-test",
    });
    await html.translateHtml([["Hello"]], "vi");
    await html.translateHtml([["Hello"]], "vi");
    expect(calls).toBe(1);
  });

  it("does not call OpenAI again after Show original restores the exact original DOM", async () => {
    let calls = 0;
    const html = createOpenAIHtmlTranslator({
      completeHtml: async (sources) => {
        calls += 1;
        return translatedEntries(sources);
      },
      storage: memoryStorage(),
      getApiKey: async () => "sk-test",
    });
    const node = document.createTextNode("Hello");
    const host = document.createElement("span");
    host.append(node);
    const originalDom = host.innerHTML;
    const first = await html.translateHtml([[node.textContent ?? ""]], "vi");
    const restore = applyLikeContentScript([node], first.results[0] ?? []);
    showOriginalLikeContentScript(restore);
    await html.translateHtml([[node.textContent ?? ""]], "vi");
    expect(node.textContent).toBe("Hello");
    expect(host.innerHTML).toBe(originalDom);
    expect(calls).toBe(1);
  });

  it("leaves target-incompatible copied-source output uncached", async () => {
    let calls = 0;
    const html = createOpenAIHtmlTranslator({
      completeHtml: async (sources) => {
        calls += 1;
        return { ...sources };
      },
      storage: memoryStorage(),
      getApiKey: async () => "sk-test",
    });
    const first = await html.translateHtml([["請求"]], "en");
    const second = await html.translateHtml([["請求"]], "en");
    expect(first.failures).toHaveLength(1);
    expect(second.failures).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it("caches target-compatible copied captured entries", async () => {
    let calls = 0;
    const html = createOpenAIHtmlTranslator({
      completeHtml: async (sources) => {
        calls += 1;
        return { ...sources };
      },
      storage: memoryStorage(),
      getApiKey: async () => "sk-test",
    });
    const sources = sourcesFromCaptured(captured);
    const first = await html.translateHtml(sources, "vi", {
      sourceLanguageHint: "vi",
    });
    const firstCalls = calls;
    const second = await html.translateHtml(sources, "vi", {
      sourceLanguageHint: "vi",
    });
    expect(first.failures).toEqual([]);
    expect(second.failures).toEqual([]);
    expect(firstCalls).toBeGreaterThan(0);
    expect(calls).toBe(firstCalls);
  });
});
