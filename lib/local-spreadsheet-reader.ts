import { TARGET_LANGUAGES, type TargetLanguage } from "./translation";

export const MAX_LOCAL_TRANSLATION_RECORDS = 128;
export const MAX_LOCAL_TRANSLATION_RECORD_UNITS = 4_000;
export const MAX_LOCAL_TRANSLATION_MESSAGE_UNITS = 8_000;
export const MAX_LOCAL_TRANSLATION_RESULT_UNITS = 4_000;
export const MAX_LOCAL_TRANSLATION_RESPONSE_UNITS = 8_000;

export type LocalSpreadsheetTranslationErrorCode =
  | "invalid-request"
  | "auth-required"
  | "auth-unavailable"
  | "reader-channel-unavailable";

export interface LocalSpreadsheetTranslateRequest {
  type: "LOCAL_SPREADSHEET_TRANSLATE";
  readerInstanceId: string;
  requestId: number;
  generation: number;
  targetLanguage: TargetLanguage;
  records: { id: string; sourceHash: string; text: string }[];
}

export type LocalSpreadsheetTranslateResult =
  | { id: string; sourceHash: string; text: string }
  | {
      id: string;
      sourceHash: string;
      error: "unresolved" | "provider-error";
    };

export type LocalSpreadsheetTranslateResponse =
  | {
      type: "LOCAL_SPREADSHEET_TRANSLATE";
      readerInstanceId: string;
      requestId: number;
      generation: number;
      ok: true;
      results: LocalSpreadsheetTranslateResult[];
    }
  | {
      type: "LOCAL_SPREADSHEET_TRANSLATE";
      readerInstanceId: string;
      requestId: number;
      generation: number;
      ok: false;
      error: LocalSpreadsheetTranslationErrorCode;
    };

type ObjectValue = Record<string, unknown>;

const objectValue = (value: unknown): ObjectValue | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : null;

const exactKeys = (value: ObjectValue, keys: readonly string[]) => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
};

const safeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

const safeId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 128 &&
  /^[A-Za-z0-9._:-]+$/.test(value);

const sourceHash = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{40}$/.test(value);

const targetLanguage = (value: unknown): value is TargetLanguage =>
  TARGET_LANGUAGES.some((target) => target.code === value);

export function parseLocalSpreadsheetTranslateRequest(
  value: unknown,
): LocalSpreadsheetTranslateRequest | null {
  const request = objectValue(value);
  if (
    !request ||
    !exactKeys(request, [
      "type",
      "readerInstanceId",
      "requestId",
      "generation",
      "targetLanguage",
      "records",
    ]) ||
    request.type !== "LOCAL_SPREADSHEET_TRANSLATE" ||
    !safeId(request.readerInstanceId) ||
    !safeInteger(request.requestId) ||
    !safeInteger(request.generation) ||
    !targetLanguage(request.targetLanguage) ||
    !Array.isArray(request.records) ||
    request.records.length === 0 ||
    request.records.length > MAX_LOCAL_TRANSLATION_RECORDS
  )
    return null;

  const ids = new Set<string>();
  let totalUnits = 0;
  for (const candidate of request.records) {
    const record = objectValue(candidate);
    if (
      !record ||
      !exactKeys(record, ["id", "sourceHash", "text"]) ||
      !safeId(record.id) ||
      ids.has(record.id) ||
      !sourceHash(record.sourceHash) ||
      typeof record.text !== "string" ||
      record.text.length === 0 ||
      record.text.length > MAX_LOCAL_TRANSLATION_RECORD_UNITS
    )
      return null;
    ids.add(record.id);
    totalUnits += record.text.length;
    if (totalUnits > MAX_LOCAL_TRANSLATION_MESSAGE_UNITS) return null;
  }

  return request as unknown as LocalSpreadsheetTranslateRequest;
}

export function parseLocalSpreadsheetTranslateResponse(
  value: unknown,
): LocalSpreadsheetTranslateResponse | null {
  const response = objectValue(value);
  if (
    !response ||
    response.type !== "LOCAL_SPREADSHEET_TRANSLATE" ||
    !safeId(response.readerInstanceId) ||
    !safeInteger(response.requestId) ||
    !safeInteger(response.generation) ||
    typeof response.ok !== "boolean"
  )
    return null;

  if (!response.ok)
    return exactKeys(response, [
      "type",
      "readerInstanceId",
      "requestId",
      "generation",
      "ok",
      "error",
    ]) &&
      [
        "invalid-request",
        "auth-required",
        "auth-unavailable",
        "reader-channel-unavailable",
      ].includes(response.error as string)
      ? (response as unknown as LocalSpreadsheetTranslateResponse)
      : null;

  if (
    !exactKeys(response, [
      "type",
      "readerInstanceId",
      "requestId",
      "generation",
      "ok",
      "results",
    ]) ||
    !Array.isArray(response.results) ||
    response.results.length === 0 ||
    response.results.length > MAX_LOCAL_TRANSLATION_RECORDS
  )
    return null;

  const ids = new Set<string>();
  let totalUnits = 0;
  for (const candidate of response.results) {
    const result = objectValue(candidate);
    if (
      !result ||
      !safeId(result.id) ||
      ids.has(result.id) ||
      !sourceHash(result.sourceHash)
    )
      return null;
    ids.add(result.id);
    if (
      exactKeys(result, ["id", "sourceHash", "text"]) &&
      typeof result.text === "string" &&
      result.text.length > 0 &&
      result.text.length <= MAX_LOCAL_TRANSLATION_RESULT_UNITS
    ) {
      totalUnits += result.text.length;
      if (totalUnits > MAX_LOCAL_TRANSLATION_RESPONSE_UNITS) return null;
      continue;
    }
    if (
      exactKeys(result, ["id", "sourceHash", "error"]) &&
      (result.error === "unresolved" || result.error === "provider-error")
    )
      continue;
    return null;
  }
  return response as unknown as LocalSpreadsheetTranslateResponse;
}
