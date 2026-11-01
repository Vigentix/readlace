import {
  parseWorkspaceReaderOwner,
  parseWorkspaceSourceVersion,
  type WorkspaceReaderOwner,
  type WorkspaceSourceVersion,
} from "./google-workspace-reader";
import { MAX_LOCAL_FILE_BYTES } from "./local-spreadsheet";

export const GOOGLE_DRIVE_OFFICE_PORT_NAME = "google-drive-office-reader-v1";
export const MAX_GOOGLE_DRIVE_OFFICE_BYTES = MAX_LOCAL_FILE_BYTES;
export const MAX_GOOGLE_DRIVE_OFFICE_CHUNK_BYTES = 256 * 1024;

export const GOOGLE_DRIVE_OFFICE_XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const GOOGLE_DRIVE_OFFICE_XLSM_MIME =
  "application/vnd.ms-excel.sheet.macroenabled.12";

export type GoogleDriveOfficeErrorCode =
  | "reader-channel-unavailable"
  | "invalid-request"
  | "auth-required"
  | "auth-unavailable"
  | "google-auth-required"
  | "google-access-denied"
  | "google-oauth-expired"
  | "google-oauth-scope"
  | "unsupported-file-type"
  | "download-not-allowed"
  // ADR 0015: no Drive scope at launch; download the file instead.
  | "office-download-required"
  | "file-too-large"
  | "download-timeout"
  | "temporarily-unavailable"
  | "source-tab-changed"
  | "invalid-response";

type GoogleDriveOfficeEnvelope = WorkspaceReaderOwner & {
  sourceTabId: number;
  version: WorkspaceSourceVersion;
};

export type GoogleDriveOfficeStartRequest = GoogleDriveOfficeEnvelope & {
  type: "GOOGLE_DRIVE_OFFICE_START";
};

export type GoogleDriveOfficeCancelRequest = GoogleDriveOfficeEnvelope & {
  type: "GOOGLE_DRIVE_OFFICE_CANCEL";
};

export type GoogleDriveOfficeMetadataMessage = GoogleDriveOfficeEnvelope & {
  type: "GOOGLE_DRIVE_OFFICE_METADATA";
  fileName: string;
  mimeType: string;
  byteLength: number;
  modifiedTime: string;
  md5Checksum: string | null;
};

export type GoogleDriveOfficeChunkMessage = GoogleDriveOfficeEnvelope & {
  type: "GOOGLE_DRIVE_OFFICE_CHUNK";
  sequence: number;
  data: string;
};

export type GoogleDriveOfficeCompleteMessage = GoogleDriveOfficeEnvelope & {
  type: "GOOGLE_DRIVE_OFFICE_COMPLETE";
  chunkCount: number;
  byteLength: number;
};

export type GoogleDriveOfficeErrorMessage = GoogleDriveOfficeEnvelope & {
  type: "GOOGLE_DRIVE_OFFICE_ERROR";
  error: GoogleDriveOfficeErrorCode;
};

export type GoogleDriveOfficePortMessage =
  | GoogleDriveOfficeStartRequest
  | GoogleDriveOfficeCancelRequest
  | GoogleDriveOfficeMetadataMessage
  | GoogleDriveOfficeChunkMessage
  | GoogleDriveOfficeCompleteMessage
  | GoogleDriveOfficeErrorMessage;

export type GoogleDriveOfficeDownloadOutcome =
  | { status: "pending" }
  | {
      status: "complete";
      metadata: GoogleDriveOfficeMetadataMessage;
      bytes: ArrayBuffer;
    }
  | { status: "error"; error: GoogleDriveOfficeErrorCode };

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

const ERROR_CODES = new Set<GoogleDriveOfficeErrorCode>([
  "reader-channel-unavailable",
  "invalid-request",
  "auth-required",
  "auth-unavailable",
  "google-auth-required",
  "google-access-denied",
  "google-oauth-expired",
  "google-oauth-scope",
  "unsupported-file-type",
  "download-not-allowed",
  "office-download-required",
  "file-too-large",
  "download-timeout",
  "temporarily-unavailable",
  "source-tab-changed",
  "invalid-response",
]);

function parseEnvelope(message: ObjectValue): GoogleDriveOfficeEnvelope | null {
  const owner = parseWorkspaceReaderOwner({
    readerInstanceId: message.readerInstanceId,
    requestId: message.requestId,
  });
  const version = parseWorkspaceSourceVersion(message.version);
  return owner && version && safeInteger(message.sourceTabId)
    ? { ...owner, sourceTabId: message.sourceTabId, version }
    : null;
}

function modifiedTime(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 20 || value.length > 35)
    return false;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/.exec(
      value,
    );
  if (!match) return false;
  const [, year, month, day, hour, minute, second] = match;
  const instant = Date.parse(
    `${year}-${month}-${day}T${hour}:${minute}:${second}Z`,
  );
  if (!Number.isFinite(instant)) return false;
  const canonical = new Date(instant).toISOString().slice(0, 19);
  return canonical === `${year}-${month}-${day}T${hour}:${minute}:${second}`;
}

const md5Checksum = (value: unknown): value is string | null =>
  value === null || (typeof value === "string" && /^[a-f0-9]{32}$/.test(value));

export function isGoogleDriveOfficeFile(
  fileName: unknown,
  mimeType: unknown,
): boolean {
  if (
    typeof fileName !== "string" ||
    fileName.length === 0 ||
    fileName.length > 1024 ||
    /[\0\r\n]/.test(fileName) ||
    typeof mimeType !== "string"
  )
    return false;

  const lowerName = fileName.toLowerCase();
  const lowerMimeType = mimeType.toLowerCase();
  return (
    (lowerName.endsWith(".xlsx") &&
      lowerMimeType === GOOGLE_DRIVE_OFFICE_XLSX_MIME) ||
    (lowerName.endsWith(".xlsm") &&
      lowerMimeType === GOOGLE_DRIVE_OFFICE_XLSM_MIME)
  );
}

export function parseGoogleDriveOfficeStartRequest(
  value: unknown,
): GoogleDriveOfficeStartRequest | null {
  const message = objectValue(value);
  if (
    !message ||
    !exactKeys(message, [
      "type",
      "readerInstanceId",
      "requestId",
      "sourceTabId",
      "version",
    ]) ||
    message.type !== "GOOGLE_DRIVE_OFFICE_START"
  )
    return null;
  const envelope = parseEnvelope(message);
  return envelope ? { type: message.type, ...envelope } : null;
}

export function parseGoogleDriveOfficePortMessage(
  value: unknown,
): GoogleDriveOfficePortMessage | null {
  const message = objectValue(value);
  if (!message || typeof message.type !== "string") return null;

  const commonKeys = [
    "type",
    "readerInstanceId",
    "requestId",
    "sourceTabId",
    "version",
  ] as const;
  const envelope = parseEnvelope(message);
  if (!envelope) return null;

  switch (message.type) {
    case "GOOGLE_DRIVE_OFFICE_START":
      return exactKeys(message, commonKeys)
        ? { type: message.type, ...envelope }
        : null;
    case "GOOGLE_DRIVE_OFFICE_CANCEL":
      return exactKeys(message, commonKeys)
        ? { type: message.type, ...envelope }
        : null;
    case "GOOGLE_DRIVE_OFFICE_METADATA":
      return exactKeys(message, [
        ...commonKeys,
        "fileName",
        "mimeType",
        "byteLength",
        "modifiedTime",
        "md5Checksum",
      ]) &&
        isGoogleDriveOfficeFile(message.fileName, message.mimeType) &&
        safeInteger(message.byteLength) &&
        message.byteLength > 0 &&
        message.byteLength <= MAX_GOOGLE_DRIVE_OFFICE_BYTES &&
        modifiedTime(message.modifiedTime) &&
        md5Checksum(message.md5Checksum)
        ? {
            type: message.type,
            ...envelope,
            fileName: message.fileName as string,
            mimeType: message.mimeType as string,
            byteLength: message.byteLength,
            modifiedTime: message.modifiedTime,
            md5Checksum: message.md5Checksum,
          }
        : null;
    case "GOOGLE_DRIVE_OFFICE_CHUNK":
      if (
        !exactKeys(message, [...commonKeys, "sequence", "data"]) ||
        !safeInteger(message.sequence) ||
        typeof message.data !== "string"
      )
        return null;
      try {
        decodeGoogleDriveOfficeChunk(message.data);
      } catch {
        return null;
      }
      return {
        type: message.type,
        ...envelope,
        sequence: message.sequence,
        data: message.data,
      };
    case "GOOGLE_DRIVE_OFFICE_COMPLETE":
      return exactKeys(message, [...commonKeys, "chunkCount", "byteLength"]) &&
        safeInteger(message.chunkCount) &&
        safeInteger(message.byteLength) &&
        message.byteLength > 0 &&
        message.byteLength <= MAX_GOOGLE_DRIVE_OFFICE_BYTES
        ? {
            type: message.type,
            ...envelope,
            chunkCount: message.chunkCount,
            byteLength: message.byteLength,
          }
        : null;
    case "GOOGLE_DRIVE_OFFICE_ERROR":
      return exactKeys(message, [...commonKeys, "error"]) &&
        ERROR_CODES.has(message.error as GoogleDriveOfficeErrorCode)
        ? {
            type: message.type,
            ...envelope,
            error: message.error as GoogleDriveOfficeErrorCode,
          }
        : null;
    default:
      return null;
  }
}

export function encodeGoogleDriveOfficeChunk(bytes: Uint8Array): string {
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_GOOGLE_DRIVE_OFFICE_CHUNK_BYTES
  )
    throw new RangeError("invalid Office chunk size");

  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function decodeGoogleDriveOfficeChunk(value: string): Uint8Array {
  if (
    value.length === 0 ||
    value.length > Math.ceil(MAX_GOOGLE_DRIVE_OFFICE_CHUNK_BYTES / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    throw new TypeError("invalid Office chunk base64");

  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_GOOGLE_DRIVE_OFFICE_CHUNK_BYTES ||
    btoa(binary) !== value
  )
    throw new RangeError("invalid Office chunk size");
  return bytes;
}

function sameEnvelope(
  expected: GoogleDriveOfficeEnvelope,
  actual: GoogleDriveOfficeEnvelope,
) {
  return (
    expected.readerInstanceId === actual.readerInstanceId &&
    expected.requestId === actual.requestId &&
    expected.sourceTabId === actual.sourceTabId &&
    expected.version.backgroundEpoch === actual.version.backgroundEpoch &&
    expected.version.sourceRevision === actual.version.sourceRevision
  );
}

export class GoogleDriveOfficeProtocolError extends Error {
  constructor() {
    super("invalid Google Drive Office download stream");
    this.name = "GoogleDriveOfficeProtocolError";
  }
}

export class GoogleDriveOfficeDownloadAssembler {
  readonly #expected: GoogleDriveOfficeStartRequest;
  #metadata: GoogleDriveOfficeMetadataMessage | null = null;
  #chunks: Uint8Array[] = [];
  #nextSequence = 0;
  #byteLength = 0;
  #terminal = false;

  constructor(expected: GoogleDriveOfficeStartRequest) {
    const parsed = parseGoogleDriveOfficeStartRequest(expected);
    if (!parsed) throw new GoogleDriveOfficeProtocolError();
    this.#expected = parsed;
  }

  get bufferedByteLength() {
    return this.#byteLength;
  }

  get terminal() {
    return this.#terminal;
  }

  accept(value: unknown): GoogleDriveOfficeDownloadOutcome {
    try {
      const message = parseGoogleDriveOfficePortMessage(value);
      if (
        !message ||
        this.#terminal ||
        !sameEnvelope(this.#expected, message) ||
        message.type === "GOOGLE_DRIVE_OFFICE_START" ||
        message.type === "GOOGLE_DRIVE_OFFICE_CANCEL"
      )
        throw new GoogleDriveOfficeProtocolError();

      if (message.type === "GOOGLE_DRIVE_OFFICE_ERROR") {
        this.#clear();
        this.#terminal = true;
        return { status: "error", error: message.error };
      }

      if (message.type === "GOOGLE_DRIVE_OFFICE_METADATA") {
        if (this.#metadata) throw new GoogleDriveOfficeProtocolError();
        this.#metadata = message;
        return { status: "pending" };
      }

      if (!this.#metadata) throw new GoogleDriveOfficeProtocolError();

      if (message.type === "GOOGLE_DRIVE_OFFICE_CHUNK") {
        if (message.sequence !== this.#nextSequence)
          throw new GoogleDriveOfficeProtocolError();
        const bytes = decodeGoogleDriveOfficeChunk(message.data);
        if (
          this.#byteLength + bytes.byteLength > this.#metadata.byteLength ||
          this.#byteLength + bytes.byteLength > MAX_GOOGLE_DRIVE_OFFICE_BYTES
        )
          throw new GoogleDriveOfficeProtocolError();
        this.#chunks.push(bytes);
        this.#byteLength += bytes.byteLength;
        this.#nextSequence += 1;
        return { status: "pending" };
      }

      if (
        message.chunkCount !== this.#nextSequence ||
        message.byteLength !== this.#byteLength ||
        message.byteLength !== this.#metadata.byteLength
      )
        throw new GoogleDriveOfficeProtocolError();

      const bytes = new Uint8Array(this.#byteLength);
      let offset = 0;
      for (const chunk of this.#chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const metadata = this.#metadata;
      this.#clear();
      this.#terminal = true;
      return { status: "complete", metadata, bytes: bytes.buffer };
    } catch (error) {
      this.#clear();
      this.#terminal = true;
      if (error instanceof GoogleDriveOfficeProtocolError) throw error;
      throw new GoogleDriveOfficeProtocolError();
    }
  }

  abort() {
    this.#clear();
    this.#terminal = true;
  }

  #clear() {
    this.#metadata = null;
    this.#chunks = [];
    this.#nextSequence = 0;
    this.#byteLength = 0;
  }
}
