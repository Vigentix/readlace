import { describe, expect, it } from "vitest";
import {
  API_ERROR_CODES,
  MAX_PASSWORD_CHARACTERS,
  MAX_HTTP_BODY_BYTES,
  MIN_PASSWORD_CHARACTERS,
  PROVIDER_CONCURRENCY,
  PROVIDER_GLOBAL_CONCURRENCY,
  PROVIDER_GLOBAL_QUEUE_LIMIT,
  PROVIDER_QUEUE_LIMIT,
  PROVIDER_STAGE_TIMEOUT_MS,
  RequestValidationError,
  TRANSLATION_STAGE_DEADLINE_MS,
  TRANSLATION_STAGE_MAX_RECORDS,
  TRANSLATION_STAGE_MAX_SOURCE_CHARACTERS,
  TRANSLATION_STAGE_PATH,
  normalizeAccountEmail,
  parseAuthLoginRequest,
  parseCreateAccountRequest,
  parseResetAccountPasswordRequest,
  parseTranslationStageRequest,
  validateAccountPassword,
} from "./translation-api";

describe("translation API contract", () => {
  it.each([
    [() => parseAuthLoginRequest(null), "INVALID_REQUEST", "Invalid request"],
    [
      () => parseResetAccountPasswordRequest(null),
      "INVALID_REQUEST",
      "Invalid request",
    ],
    [
      () => parseCreateAccountRequest({ email: "invalid", password: "short" }),
      "INVALID_EMAIL",
      "Invalid email",
    ],
    [() => normalizeAccountEmail(42), "INVALID_EMAIL", "Invalid email"],
    [() => validateAccountPassword(42), "INVALID_PASSWORD", "Invalid password"],
    [
      () => validateAccountPassword("short"),
      "PASSWORD_LENGTH",
      "Password must be between 12 and 128 characters",
    ],
    [
      () => validateAccountPassword("🔐".repeat(129)),
      "PASSWORD_LENGTH",
      "Password must be between 12 and 128 characters",
    ],
    [
      () => parseTranslationStageRequest(null),
      "INVALID_REQUEST",
      "Invalid request",
    ],
    [
      () =>
        parseTranslationStageRequest({
          targetLanguage: "fr",
          sources: [["x".repeat(4001)]],
          sourceRoutes: [["auto"]],
        }),
      "INVALID_REQUEST",
      "Invalid request",
    ],
    [
      () =>
        parseTranslationStageRequest({
          provider: "google",
          targetLanguage: "en",
          sources: [["hello"]],
          sourceRoutes: [["en"]],
        }),
      "INVALID_REQUEST",
      "Invalid request",
    ],
    [
      () =>
        parseTranslationStageRequest({
          targetLanguage: "en",
          sources: [["x".repeat(8001)]],
          sourceRoutes: [["auto"]],
        }),
      "PROVIDER_PAYLOAD_TOO_LARGE",
      "Payload exceeds provider limits",
    ],
    [
      () =>
        parseTranslationStageRequest({
          targetLanguage: "en",
          sources: [Array(129).fill("x")],
          sourceRoutes: [Array(129).fill("auto")],
        }),
      "PROVIDER_PAYLOAD_TOO_LARGE",
      "Payload exceeds provider limits",
    ],
  ] as const)(
    "preserves typed validation code, wording and order for case %#",
    (parse, code, message) => {
      expect(parse).toThrow(RequestValidationError);
      expect(parse).toThrow(expect.objectContaining({ code, message }));
    },
  );

  it("pins the existing provider limits", () => {
    expect({
      TRANSLATION_STAGE_PATH,
      TRANSLATION_STAGE_MAX_RECORDS,
      TRANSLATION_STAGE_MAX_SOURCE_CHARACTERS,
      TRANSLATION_STAGE_DEADLINE_MS,
      MAX_HTTP_BODY_BYTES,
      PROVIDER_CONCURRENCY,
      PROVIDER_QUEUE_LIMIT,
      PROVIDER_GLOBAL_CONCURRENCY,
      PROVIDER_GLOBAL_QUEUE_LIMIT,
      PROVIDER_STAGE_TIMEOUT_MS,
      MIN_PASSWORD_CHARACTERS,
      MAX_PASSWORD_CHARACTERS,
    }).toEqual({
      TRANSLATION_STAGE_PATH: "/v1/translation-stages",
      TRANSLATION_STAGE_MAX_RECORDS: 128,
      TRANSLATION_STAGE_MAX_SOURCE_CHARACTERS: 8_000,
      TRANSLATION_STAGE_DEADLINE_MS: 60_000,
      MAX_HTTP_BODY_BYTES: 65_536,
      PROVIDER_CONCURRENCY: 2,
      PROVIDER_QUEUE_LIMIT: 2,
      PROVIDER_GLOBAL_CONCURRENCY: 4,
      PROVIDER_GLOBAL_QUEUE_LIMIT: 4,
      PROVIDER_STAGE_TIMEOUT_MS: 30_000,
      MIN_PASSWORD_CHARACTERS: 12,
      MAX_PASSWORD_CHARACTERS: 128,
    });

    expect(API_ERROR_CODES).toContain("PROVISIONING_DISABLED");
    expect(API_ERROR_CODES).toContain("PROVISIONING_FORBIDDEN");
    expect(API_ERROR_CODES).toContain("INVALID_PASSWORD");
  });

  it("normalizes managed-account login input without changing passwords", () => {
    const password = "  a long passphrase 🔐  ";
    expect(
      parseAuthLoginRequest({
        email: "  Member@Example.COM ",
        password,
      }),
    ).toEqual({ email: "member@example.com", password });
    expect(normalizeAccountEmail("OWNER@EXAMPLE.COM")).toBe(
      "owner@example.com",
    );
    expect(
      parseResetAccountPasswordRequest({
        email: " Member@Example.COM ",
        password,
      }),
    ).toEqual({
      email: "member@example.com",
      password,
    });
  });

  it("rejects malformed emails and passwords outside 12-128 characters", () => {
    expect(() =>
      parseAuthLoginRequest({ email: "invalid", password: "x".repeat(12) }),
    ).toThrow("Invalid email");
    expect(() =>
      parseAuthLoginRequest({
        email: "member@example.com",
        password: "x".repeat(11),
      }),
    ).toThrow("Password must be between 12 and 128 characters");
    expect(
      parseAuthLoginRequest({
        email: "member@example.com",
        password: "x".repeat(12),
      }).password,
    ).toHaveLength(12);
    expect(() =>
      parseResetAccountPasswordRequest({
        email: "member@example.com",
        password: "🔐".repeat(129),
      }),
    ).toThrow("Password must be between 12 and 128 characters");
  });

  it.each([undefined, null, 42, "", "invalid", "a@@example.com"])(
    "rejects an invalid reset email %s",
    (email) => {
      expect(() =>
        parseResetAccountPasswordRequest({ email, password: "x".repeat(12) }),
      ).toThrow("Invalid email");
    },
  );

  it("accepts aligned bounded stage input", () => {
    expect(
      parseTranslationStageRequest({
        targetLanguage: "en",
        sourceLanguageHint: "ja",
        sources: [["こんにちは"]],
        sourceRoutes: [["ja"]],
      }),
    ).toEqual({
      targetLanguage: "en",
      sourceLanguageHint: "ja",
      sources: [["こんにちは"]],
      sourceRoutes: [["ja"]],
    });
  });

  it("rejects oversized and malformed stage input", () => {
    expect(() =>
      parseTranslationStageRequest({
        targetLanguage: "en",
        sources: [["x".repeat(8_001)]],
        sourceRoutes: [["auto"]],
      }),
    ).toThrow("Payload exceeds provider limits");
    expect(
      parseTranslationStageRequest({
        targetLanguage: "en",
        sources: [["x".repeat(8_000)]],
        sourceRoutes: [["auto"]],
      }).sources[0]![0],
    ).toHaveLength(8_000);
    expect(() =>
      parseTranslationStageRequest({
        targetLanguage: "fr",
        sources: [["hello"]],
        sourceRoutes: [["en"]],
      }),
    ).toThrow("Invalid request");
    for (const extra of [{ provider: "openai" }, { engine: "google" }])
      expect(() =>
        parseTranslationStageRequest({
          ...extra,
          targetLanguage: "en",
          sources: [["hello"]],
          sourceRoutes: [["en"]],
        }),
      ).toThrow("Invalid request");
    expect(() => parseTranslationStageRequest([])).toThrow("Invalid request");
  });
});
