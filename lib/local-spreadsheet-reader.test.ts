import { describe, expect, it } from "vitest";

import {
  MAX_LOCAL_TRANSLATION_MESSAGE_UNITS,
  MAX_LOCAL_TRANSLATION_RECORDS,
  MAX_LOCAL_TRANSLATION_RECORD_UNITS,
  MAX_LOCAL_TRANSLATION_RESPONSE_UNITS,
  MAX_LOCAL_TRANSLATION_RESULT_UNITS,
  parseLocalSpreadsheetTranslateRequest,
  parseLocalSpreadsheetTranslateResponse,
} from "./local-spreadsheet-reader";

const HASH = "a".repeat(40);
const request = (overrides: Record<string, unknown> = {}) => ({
  type: "LOCAL_SPREADSHEET_TRANSLATE",
  readerInstanceId: "local-reader-1",
  requestId: 1,
  generation: 2,
  targetLanguage: "vi",
  records: [{ id: "A1", sourceHash: HASH, text: "こんにちは" }],
  ...overrides,
});

describe("local spreadsheet translation protocol", () => {
  it("accepts only the exact Reader-channel recovery terminal response", () => {
    const error = {
      type: "LOCAL_SPREADSHEET_TRANSLATE",
      readerInstanceId: "local-reader-1",
      requestId: 1,
      generation: 2,
      ok: false,
      error: "reader-channel-unavailable",
    };
    expect(parseLocalSpreadsheetTranslateResponse(error)).toEqual(error);
    expect(
      parseLocalSpreadsheetTranslateResponse({ ...error, cause: "offline" }),
    ).toBeNull();
  });
  it("rejects removed and unknown terminal codes (ADR 0020)", () => {
    const error = {
      type: "LOCAL_SPREADSHEET_TRANSLATE",
      readerInstanceId: "local-reader-1",
      requestId: 1,
      generation: 2,
      ok: false,
      error: "plan-required",
    };
    expect(parseLocalSpreadsheetTranslateResponse(error)).toBeNull();
    expect(
      parseLocalSpreadsheetTranslateResponse({
        ...error,
        error: "ENTITLEMENT_REQUIRED",
      }),
    ).toBeNull();
  });
  it("accepts only the strict bounded request shape", () => {
    expect(parseLocalSpreadsheetTranslateRequest(request())).toEqual(request());
    expect(
      parseLocalSpreadsheetTranslateRequest(request({ workbook: {} })),
    ).toBeNull();
    expect(
      parseLocalSpreadsheetTranslateRequest(request({ fileBytes: [1, 2, 3] })),
    ).toBeNull();
    expect(
      parseLocalSpreadsheetTranslateRequest(request({ provider: "openai" })),
    ).toBeNull();
    expect(
      parseLocalSpreadsheetTranslateRequest(request({ targetLanguage: "fr" })),
    ).toBeNull();
    expect(
      parseLocalSpreadsheetTranslateRequest(
        request({ records: [{ id: "../A1", sourceHash: HASH, text: "x" }] }),
      ),
    ).toBeNull();
    expect(
      parseLocalSpreadsheetTranslateRequest(
        request({
          records: [{ id: "A1", sourceHash: "A".repeat(40), text: "x" }],
        }),
      ),
    ).toBeNull();
  });

  it("enforces uniqueness and every record/message limit", () => {
    expect(
      parseLocalSpreadsheetTranslateRequest(
        request({
          records: [
            { id: "A1", sourceHash: HASH, text: "x" },
            { id: "A1", sourceHash: "b".repeat(40), text: "y" },
          ],
        }),
      ),
    ).toBeNull();
    expect(
      parseLocalSpreadsheetTranslateRequest(
        request({
          records: Array.from(
            { length: MAX_LOCAL_TRANSLATION_RECORDS + 1 },
            (_, index) => ({
              id: `A${index}`,
              sourceHash: HASH,
              text: "x",
            }),
          ),
        }),
      ),
    ).toBeNull();
    expect(
      parseLocalSpreadsheetTranslateRequest(
        request({
          records: [
            {
              id: "A1",
              sourceHash: HASH,
              text: "x".repeat(MAX_LOCAL_TRANSLATION_RECORD_UNITS + 1),
            },
          ],
        }),
      ),
    ).toBeNull();
    expect(
      parseLocalSpreadsheetTranslateRequest(
        request({
          records: [
            {
              id: "A1",
              sourceHash: HASH,
              text: "x".repeat(MAX_LOCAL_TRANSLATION_RECORD_UNITS),
            },
            {
              id: "A2",
              sourceHash: HASH,
              text: "y".repeat(
                MAX_LOCAL_TRANSLATION_MESSAGE_UNITS -
                  MAX_LOCAL_TRANSLATION_RECORD_UNITS +
                  1,
              ),
            },
          ],
        }),
      ),
    ).toBeNull();
  });

  it("parses only source-free response shapes", () => {
    const success = {
      type: "LOCAL_SPREADSHEET_TRANSLATE",
      readerInstanceId: "local-reader-1",
      requestId: 1,
      generation: 2,
      ok: true,
      results: [
        { id: "A1", sourceHash: HASH, text: "Xin chào" },
        { id: "A2", sourceHash: HASH, error: "provider-error" },
      ],
    };
    expect(parseLocalSpreadsheetTranslateResponse(success)).toEqual(success);
    expect(
      parseLocalSpreadsheetTranslateResponse({ ...success, source: "secret" }),
    ).toBeNull();
    expect(
      parseLocalSpreadsheetTranslateResponse({
        ...success,
        results: [{ ...success.results[0], sourceText: "secret" }],
      }),
    ).toBeNull();
    expect(
      parseLocalSpreadsheetTranslateResponse({
        type: "LOCAL_SPREADSHEET_TRANSLATE",
        readerInstanceId: "local-reader-1",
        requestId: 1,
        generation: 2,
        ok: false,
        error: "auth-required",
      }),
    ).not.toBeNull();
  });

  it("rejects oversized individual and aggregate translated output", () => {
    const response = (texts: string[]) => ({
      type: "LOCAL_SPREADSHEET_TRANSLATE",
      readerInstanceId: "local-reader-1",
      requestId: 1,
      generation: 2,
      ok: true,
      results: texts.map((text, index) => ({
        id: `A${index + 1}`,
        sourceHash: HASH,
        text,
      })),
    });
    expect(
      parseLocalSpreadsheetTranslateResponse(
        response(["x".repeat(MAX_LOCAL_TRANSLATION_RESULT_UNITS + 1)]),
      ),
    ).toBeNull();
    expect(
      parseLocalSpreadsheetTranslateResponse(
        response([
          "x".repeat(MAX_LOCAL_TRANSLATION_RESULT_UNITS),
          "y".repeat(
            MAX_LOCAL_TRANSLATION_RESPONSE_UNITS -
              MAX_LOCAL_TRANSLATION_RESULT_UNITS +
              1,
          ),
        ]),
      ),
    ).toBeNull();
  });
});
