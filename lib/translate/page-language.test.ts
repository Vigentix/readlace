import { describe, expect, it } from "vitest";
import {
  displayPageLanguage,
  hasNativeJapaneseSourceScript,
  readHtmlLang,
  hasTrustedSourceScript,
  resolvePageLanguage,
  resolveRecordSourceLanguage,
  resolveTrustedSourceLanguage,
  settlePageTranslationState,
  shouldEnableTranslate,
  shouldStartAlwaysTranslate,
} from "./page-language";

describe("page language display", () => {
  it("shows Unknown when the tab detector is inconclusive", () => {
    expect(displayPageLanguage("und")).toBe("Unknown");
    expect(displayPageLanguage("")).toBe("Unknown");
    expect(displayPageLanguage(undefined)).toBe("Unknown");
  });

  it("keeps a detected language code for the popup label", () => {
    expect(displayPageLanguage("en")).toBe("en");
  });
});

describe("settlePageTranslationState", () => {
  it.each([
    { accepted: true, unresolved: false, expected: "translated" },
    { accepted: true, unresolved: true, expected: "partial" },
    { accepted: false, unresolved: true, expected: "error" },
    { accepted: false, unresolved: false, expected: "error" },
  ] as const)("settles $expected", ({ expected, ...outcome }) => {
    expect(settlePageTranslationState(outcome)).toBe(expected);
  });
});

describe("resolvePageLanguage", () => {
  it.each([
    {
      name: "en-US and en agree on autoSkipTarget en",
      detected: "en-US",
      htmlLang: "en",
      label: "en",
      autoSkipTarget: "en",
    },
    {
      name: "en_US underscore normalizes with en",
      detected: "en_US",
      htmlLang: "en",
      label: "en",
      autoSkipTarget: "en",
    },
    {
      name: "html en and detected vi conflict",
      detected: "vi",
      htmlLang: "en",
      label: "Unknown",
      autoSkipTarget: null,
    },
    {
      name: "missing html does not skip and keeps detected",
      detected: "en",
      htmlLang: undefined,
      label: "en",
      autoSkipTarget: null,
    },
    {
      name: "missing html keeps a non-target CLD code",
      detected: "fr",
      htmlLang: undefined,
      label: "fr",
      autoSkipTarget: null,
    },
    {
      name: "empty html is not a vote",
      detected: "ja",
      htmlLang: "",
      label: "ja",
      autoSkipTarget: null,
    },
    {
      name: "und html is not a vote",
      detected: "en",
      htmlLang: "und",
      label: "en",
      autoSkipTarget: null,
    },
    {
      name: "unknown html is not a vote",
      detected: "vi",
      htmlLang: "unknown",
      label: "vi",
      autoSkipTarget: null,
    },
    {
      name: "invalid detected tag never skips",
      detected: "en-",
      htmlLang: "en",
      label: "en-",
      autoSkipTarget: null,
    },
    {
      name: "invalid html tag never skips",
      detected: "ja",
      htmlLang: "ja--JP",
      label: "ja",
      autoSkipTarget: null,
    },
    {
      name: "und detected never skips",
      detected: "und",
      htmlLang: "en",
      label: "Unknown",
      autoSkipTarget: null,
    },
    {
      name: "empty detected never skips",
      detected: "",
      htmlLang: "en",
      label: "Unknown",
      autoSkipTarget: null,
    },
    {
      name: "unknown detected never skips",
      detected: "unknown",
      htmlLang: "ja",
      label: "Unknown",
      autoSkipTarget: null,
    },
    {
      name: "uppercase and region tags agree on ja",
      detected: "JA",
      htmlLang: "ja-JP",
      label: "ja",
      autoSkipTarget: "ja",
    },
    {
      name: "vi agreement",
      detected: "vi-VN",
      htmlLang: "vi",
      label: "vi",
      autoSkipTarget: "vi",
    },
  ])("$name", ({ detected, htmlLang, label, autoSkipTarget }) => {
    expect(resolvePageLanguage({ detected, htmlLang })).toEqual({
      label,
      autoSkipTarget,
    });
  });
});

describe("trusted source language", () => {
  it("requires detector and root primary-subtag agreement", () => {
    expect(
      resolveTrustedSourceLanguage({ detected: "ja-JP", htmlLang: "ja" }),
    ).toBe("ja");
    expect(
      resolveTrustedSourceLanguage({ detected: "ja", htmlLang: "en" }),
    ).toBeNull();
    expect(
      resolveTrustedSourceLanguage({ detected: "und", htmlLang: "ja" }),
    ).toBeNull();
  });

  it("requires record script compatibility before a source hint is used", () => {
    expect(hasTrustedSourceScript("請求", "ja")).toBe(true);
    expect(hasTrustedSourceScript("スーパー", "ja")).toBe(true);
    expect(hasTrustedSourceScript("請求 PDF", "ja")).toBe(false);
    expect(hasTrustedSourceScript("Invoice", "ja")).toBe(false);
    expect(hasTrustedSourceScript("Xin chào", "vi")).toBe(true);
    expect(hasTrustedSourceScript("請求", "en")).toBe(false);
    expect(hasTrustedSourceScript("Invoice 請求", "en")).toBe(false);
  });

  it.each([
    ["Japanese on an English page", "請求 PDF 2026", "en", "ja"],
    ["Japanese without a page hint", "スーパー 24", undefined, "ja"],
    ["compatible English hint", "Invoice 2026", "en", "en"],
    ["compatible Vietnamese hint", "Xin chào 2026", "vi", "vi"],
    ["incompatible Japanese hint", "Invoice 2026", "ja", "auto"],
    ["conflicting script and hint", "مرحبا", "en", "auto"],
    ["numbers without letters", "2026-08-27", "en", "auto"],
  ] as const)("routes %s", (_name, source, hint, expected) => {
    expect(resolveRecordSourceLanguage(source, hint)).toBe(expected);
  });

  it("allows a Latin suffix only for native Japanese recovery", () => {
    expect(hasNativeJapaneseSourceScript("請求 PDF")).toBe(true);
    expect(hasNativeJapaneseSourceScript("Invoice")).toBe(false);
    expect(hasNativeJapaneseSourceScript("請求 العربية")).toBe(false);
  });
});

describe("readHtmlLang", () => {
  it("reads documentElement.lang and trims it", () => {
    document.documentElement.lang = "  en-US  ";
    document.documentElement.removeAttribute("xml:lang");
    expect(readHtmlLang(document)).toBe("en-US");
  });

  it("ignores standalone xml:lang when lang is empty", () => {
    document.documentElement.lang = "";
    document.documentElement.setAttribute("xml:lang", "  vi  ");
    expect(readHtmlLang(document)).toBe("");
  });

  it("returns empty string when neither lang nor xml:lang is set", () => {
    document.documentElement.lang = "";
    document.documentElement.removeAttribute("xml:lang");
    expect(readHtmlLang(document)).toBe("");
  });
});

describe("shouldStartAlwaysTranslate", () => {
  it.each([
    {
      name: "starts when enabled, not blocked, and autoSkipTarget is null",
      input: {
        enabled: true,
        targetLanguage: "en" as const,
        autoSkipTarget: null,
        openAiBlocked: false,
      },
      expected: true,
    },
    {
      name: "starts when autoSkipTarget differs from the preference target",
      input: {
        enabled: true,
        targetLanguage: "vi" as const,
        autoSkipTarget: "en" as const,
        openAiBlocked: false,
      },
      expected: true,
    },
    {
      name: "does not start when preference is off",
      input: {
        enabled: false,
        targetLanguage: "en" as const,
        autoSkipTarget: null,
        openAiBlocked: false,
      },
      expected: false,
    },
    {
      name: "does not start when OpenAI is blocked",
      input: {
        enabled: true,
        targetLanguage: "en" as const,
        autoSkipTarget: null,
        openAiBlocked: true,
      },
      expected: false,
    },
    {
      name: "does not start when autoSkipTarget equals the preference target",
      input: {
        enabled: true,
        targetLanguage: "en" as const,
        autoSkipTarget: "en" as const,
        openAiBlocked: false,
      },
      expected: false,
    },
  ])("$name", ({ input, expected }) => {
    expect(shouldStartAlwaysTranslate(input)).toBe(expected);
  });
});

describe("shouldEnableTranslate", () => {
  it.each([
    {
      name: "enables original state despite matching language evidence",
      input: {
        state: "original" as const,
        targetLanguage: "ja" as const,
        busy: false,
        openAiBlocked: false,
      },
      expected: true,
    },
    {
      name: "disables when translated and appliedTarget equals target en",
      input: {
        state: "translated" as const,
        targetLanguage: "en" as const,
        appliedTarget: "en" as const,
        busy: false,
        openAiBlocked: false,
      },
      expected: false,
    },
    {
      name: "enables when translated appliedTarget en differs from target vi",
      input: {
        state: "translated" as const,
        targetLanguage: "vi" as const,
        appliedTarget: "en" as const,
        busy: false,
        openAiBlocked: false,
      },
      expected: true,
    },
    {
      name: "enables a later explicit Translate run from partial state",
      input: {
        state: "partial" as const,
        targetLanguage: "en" as const,
        appliedTarget: "en" as const,
        busy: false,
        openAiBlocked: false,
      },
      expected: true,
    },
    {
      name: "enables a later explicit Translate run from error state",
      input: {
        state: "error" as const,
        targetLanguage: "en" as const,
        appliedTarget: "en" as const,
        busy: false,
        openAiBlocked: false,
      },
      expected: true,
    },
    {
      name: "disables when busy",
      input: {
        state: "translating" as const,
        targetLanguage: "ja" as const,
        busy: true,
        openAiBlocked: false,
      },
      expected: false,
    },
    {
      name: "disables while native language support is preparing",
      input: {
        state: "preparing" as const,
        targetLanguage: "en" as const,
        busy: false,
        openAiBlocked: false,
      },
      expected: false,
    },
    {
      name: "disables while provider translation is active",
      input: {
        state: "translating" as const,
        targetLanguage: "en" as const,
        busy: false,
        openAiBlocked: false,
      },
      expected: false,
    },
    {
      name: "disables when OpenAI is blocked",
      input: {
        state: "original" as const,
        targetLanguage: "ja" as const,
        busy: false,
        openAiBlocked: true,
      },
      expected: false,
    },
  ])("$name", ({ input, expected }) => {
    expect(shouldEnableTranslate(input)).toBe(expected);
  });
});
