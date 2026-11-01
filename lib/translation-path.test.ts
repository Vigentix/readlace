import { describe, expect, it } from "vitest";
import {
  chooseEngineSource,
  chooseTranslationPath,
  isTranslationPath,
  onDeviceTranslatorSupported,
  translationPathNeedsNative,
  type EngineSource,
  type NativeTranslationAvailability,
  type TranslationPath,
} from "./translation-path";

const availabilities: NativeTranslationAvailability[] = [
  "available",
  "downloadable",
  "downloading",
  "unknown",
  "unavailable",
  "unsupported",
];

const nativeCapable = (availability: NativeTranslationAvailability) =>
  availability !== "unavailable" && availability !== "unsupported";

describe("chooseEngineSource (ADR 0020)", () => {
  it("uses the user's OpenAI key only while it is configured and accepted", () => {
    expect(
      chooseEngineSource({ keyConfigured: true, keyRejected: false }),
    ).toBe("byok-openai");
    expect(chooseEngineSource({ keyConfigured: true, keyRejected: true })).toBe(
      "on-device",
    );
    expect(
      chooseEngineSource({ keyConfigured: false, keyRejected: false }),
    ).toBe("on-device");
  });
});

describe("chooseTranslationPath", () => {
  it("covers the whole engine source × availability product", () => {
    const sources: EngineSource[] = ["byok-openai", "on-device"];
    for (const source of sources)
      for (const availability of availabilities) {
        const expected: TranslationPath =
          source === "byok-openai"
            ? "provider"
            : nativeCapable(availability)
              ? "native"
              : "unavailable";
        expect(chooseTranslationPath(source, availability)).toBe(expected);
      }
  });

  it("reports when native availability matters", () => {
    expect(translationPathNeedsNative("byok-openai")).toBe(false);
    expect(translationPathNeedsNative("on-device")).toBe(true);
  });

  it("validates paths and detects the Translator API", () => {
    expect(isTranslationPath("provider")).toBe(true);
    expect(isTranslationPath("native")).toBe(true);
    expect(isTranslationPath("unavailable")).toBe(true);
    expect(isTranslationPath("backend")).toBe(false);
    expect(onDeviceTranslatorSupported({})).toBe(false);
    expect(
      onDeviceTranslatorSupported({ Translator: { create: () => undefined } }),
    ).toBe(true);
  });
});
