import { describe, expect, it } from "vitest";

import {
  deriveSpreadsheetTranslationCapabilities,
  INITIAL_SPREADSHEET_TRANSLATION_STATE,
  transitionSpreadsheetTranslation,
  type SpreadsheetTranslationEvent,
  type SpreadsheetTranslationPhase,
  type SpreadsheetTranslationState,
} from "./spreadsheet-reader-state";

const state = (
  phase: SpreadsheetTranslationPhase,
): SpreadsheetTranslationState => ({
  phase,
});

describe("spreadsheet translation transitions", () => {
  it.each<{
    from: SpreadsheetTranslationPhase;
    event: SpreadsheetTranslationEvent;
    to: SpreadsheetTranslationPhase;
  }>([
    { from: "idle", event: { type: "start" }, to: "translating" },
    {
      from: "translating",
      event: { type: "request-accepted" },
      to: "translating",
    },
    {
      from: "translating",
      event: { type: "completion" },
      to: "watching",
    },
    {
      from: "translating",
      event: { type: "empty-visible" },
      to: "watching",
    },
    { from: "translating", event: { type: "stop" }, to: "paused" },
    { from: "watching", event: { type: "stop" }, to: "paused" },
    { from: "partial", event: { type: "stop" }, to: "paused" },
    { from: "partial", event: { type: "request-accepted" }, to: "translating" },
    {
      from: "watching",
      event: { type: "request-accepted" },
      to: "translating",
    },
    { from: "paused", event: { type: "resume" }, to: "translating" },
    { from: "translating", event: { type: "partial" }, to: "partial" },
    { from: "partial", event: { type: "retry" }, to: "translating" },
    { from: "error", event: { type: "retry" }, to: "translating" },
    { from: "watching", event: { type: "error" }, to: "error" },
    {
      from: "watching",
      event: { type: "settings-change" },
      to: "idle",
    },
    {
      from: "watching",
      event: { type: "source-change" },
      to: "idle",
    },
    {
      from: "watching",
      event: { type: "browser-sheet-change" },
      to: "idle",
    },
    {
      from: "watching",
      event: { type: "reader-sheet-change" },
      to: "translating",
    },
    {
      from: "idle",
      event: { type: "reader-sheet-change" },
      to: "idle",
    },
    {
      from: "paused",
      event: { type: "reader-sheet-change" },
      to: "idle",
    },
  ])("moves $from through $event.type to $to", ({ from, event, to }) => {
    expect(transitionSpreadsheetTranslation(state(from), event).phase).toBe(to);
  });

  it("rejects duplicate active Translate generations", () => {
    for (const phase of ["translating", "watching"] as const) {
      const current = state(phase);
      expect(transitionSpreadsheetTranslation(current, { type: "start" })).toBe(
        current,
      );
    }
  });

  it("settles an already-empty visible viewport idempotently", () => {
    const watching = state("watching");
    expect(
      transitionSpreadsheetTranslation(watching, { type: "empty-visible" }),
    ).toBe(watching);
  });

  it("keeps no-op events referentially stable", () => {
    expect(
      transitionSpreadsheetTranslation(INITIAL_SPREADSHEET_TRANSLATION_STATE, {
        type: "reader-sheet-change",
      }),
    ).toBe(INITIAL_SPREADSHEET_TRANSLATION_STATE);
  });
});

describe("spreadsheet translation capabilities", () => {
  const ready = {
    sourceReady: true,
    hasVisibleRecords: true,
    hasTranslations: true,
  };

  it.each([
    ["idle", "reader.primary.translate", true, false],
    ["translating", "reader.primary.translating", false, true],
    ["watching", "reader.primary.translationOn", false, true],
    ["paused", "reader.primary.resume", true, false],
    ["partial", "reader.primary.retryUnresolved", true, false],
    ["error", "reader.primary.retry", true, false],
  ] as const)(
    "derives the %s action matrix",
    (phase, primaryLabel, primaryEnabled, stopEnabled) => {
      const result = deriveSpreadsheetTranslationCapabilities(
        state(phase),
        ready,
      );

      expect(result.primaryLabel).toBe(primaryLabel);
      expect(result.primaryDisabled).toBe(!primaryEnabled);
      expect(result.stopDisabled).toBe(!stopEnabled);
      expect(result.shouldContinueOnReaderSheetChange).toBe(stopEnabled);
    },
  );

  it("disables source-dependent controls until the source is ready", () => {
    const result = deriveSpreadsheetTranslationCapabilities(state("idle"), {
      sourceReady: false,
      hasVisibleRecords: true,
      hasTranslations: false,
    });

    expect(result).toMatchObject({
      primaryDisabled: true,
      settingsDisabled: true,
      presentationDisabled: true,
    });
  });

  it("disables Translate without visible records but allows a ready session to resume", () => {
    const context = {
      sourceReady: true,
      hasVisibleRecords: false,
      hasTranslations: false,
    };

    expect(
      deriveSpreadsheetTranslationCapabilities(state("idle"), context)
        .primaryDisabled,
    ).toBe(true);
    expect(
      deriveSpreadsheetTranslationCapabilities(state("paused"), context)
        .primaryDisabled,
    ).toBe(false);
  });

  it("allows pre-start settings without permitting content actions", () => {
    expect(
      deriveSpreadsheetTranslationCapabilities(state("idle"), {
        sourceReady: false,
        settingsReady: true,
        hasVisibleRecords: false,
        hasTranslations: false,
      }),
    ).toMatchObject({
      primaryDisabled: true,
      settingsDisabled: false,
      stopDisabled: true,
      presentationDisabled: true,
    });
  });

  it("keeps explicit settings readiness separate from content readiness and active requests", () => {
    expect(
      deriveSpreadsheetTranslationCapabilities(state("idle"), {
        ...ready,
        settingsReady: false,
      }),
    ).toMatchObject({ primaryDisabled: false, settingsDisabled: true });
    expect(
      deriveSpreadsheetTranslationCapabilities(state("translating"), {
        sourceReady: false,
        settingsReady: true,
        hasVisibleRecords: false,
        hasTranslations: false,
      }).settingsDisabled,
    ).toBe(true);
  });

  it("keeps watching settings available while locking them during a request", () => {
    expect(
      deriveSpreadsheetTranslationCapabilities(state("translating"), ready)
        .settingsDisabled,
    ).toBe(true);
    expect(
      deriveSpreadsheetTranslationCapabilities(state("watching"), ready)
        .settingsDisabled,
    ).toBe(false);
  });
});
