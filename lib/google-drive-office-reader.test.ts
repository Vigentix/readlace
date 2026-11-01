import { describe, expect, it } from "vitest";

import {
  GOOGLE_DRIVE_OFFICE_XLSM_MIME,
  GOOGLE_DRIVE_OFFICE_XLSX_MIME,
  GoogleDriveOfficeDownloadAssembler,
  GoogleDriveOfficeProtocolError,
  MAX_GOOGLE_DRIVE_OFFICE_CHUNK_BYTES,
  decodeGoogleDriveOfficeChunk,
  encodeGoogleDriveOfficeChunk,
  isGoogleDriveOfficeFile,
  parseGoogleDriveOfficePortMessage,
  parseGoogleDriveOfficeStartRequest,
  type GoogleDriveOfficeStartRequest,
} from "./google-drive-office-reader";

const start: GoogleDriveOfficeStartRequest = {
  type: "GOOGLE_DRIVE_OFFICE_START",
  readerInstanceId: "reader-1",
  requestId: 3,
  sourceTabId: 7,
  version: { backgroundEpoch: "epoch-1", sourceRevision: 2 },
};
const message = (type: string, extra: Record<string, unknown> = {}) => ({
  ...start,
  type,
  ...extra,
});
const metadata = (extension: "xlsx" | "xlsm", byteLength: number) =>
  message("GOOGLE_DRIVE_OFFICE_METADATA", {
    fileName: `book.${extension}`,
    mimeType:
      extension === "xlsx"
        ? GOOGLE_DRIVE_OFFICE_XLSX_MIME
        : GOOGLE_DRIVE_OFFICE_XLSM_MIME,
    byteLength,
    modifiedTime: "2026-09-28T02:30:45.123Z",
    md5Checksum: "a".repeat(32),
  });
const chunk = (sequence: number, bytes: number[]) =>
  message("GOOGLE_DRIVE_OFFICE_CHUNK", {
    sequence,
    data: encodeGoogleDriveOfficeChunk(Uint8Array.from(bytes)),
  });
const complete = (chunkCount: number, byteLength: number) =>
  message("GOOGLE_DRIVE_OFFICE_COMPLETE", { chunkCount, byteLength });

describe("Google Drive Office download protocol", () => {
  it("distinguishes a Reader channel failure using the exact structured error envelope", () => {
    const error = message("GOOGLE_DRIVE_OFFICE_ERROR", {
      error: "reader-channel-unavailable",
    });
    expect(parseGoogleDriveOfficePortMessage(error)).toEqual(error);
    expect(
      parseGoogleDriveOfficePortMessage({ ...error, cause: "Google down" }),
    ).toBeNull();
    expect(
      parseGoogleDriveOfficePortMessage({ ...error, error: "arbitrary-error" }),
    ).toBeNull();
  });
  it("accepts exact start identity without any file-controlled request fields", () => {
    expect(parseGoogleDriveOfficeStartRequest(start)).toEqual(start);
    for (const invalid of [
      { ...start, fileId: "attacker-controlled" },
      { ...start, url: "https://example.test" },
      { ...start, requestId: -1 },
      { ...start, readerInstanceId: "../reader" },
      { ...start, version: { ...start.version, sourceRevision: -1 } },
      { ...start, version: { ...start.version, extra: true } },
    ]) {
      expect(parseGoogleDriveOfficeStartRequest(invalid)).toBeNull();
    }
  });

  it("requires matching Office extensions and MIME types", () => {
    expect(
      isGoogleDriveOfficeFile("BOOK.XLSX", GOOGLE_DRIVE_OFFICE_XLSX_MIME),
    ).toBe(true);
    expect(
      isGoogleDriveOfficeFile("book.xlsm", GOOGLE_DRIVE_OFFICE_XLSM_MIME),
    ).toBe(true);
    expect(
      isGoogleDriveOfficeFile(
        "book.xlsm",
        "application/vnd.ms-excel.sheet.macroEnabled.12",
      ),
    ).toBe(true);
    expect(
      isGoogleDriveOfficeFile(
        "book.xlsx",
        GOOGLE_DRIVE_OFFICE_XLSX_MIME.toUpperCase(),
      ),
    ).toBe(true);
    expect(
      isGoogleDriveOfficeFile("book.xlsm", GOOGLE_DRIVE_OFFICE_XLSX_MIME),
    ).toBe(false);
    expect(
      isGoogleDriveOfficeFile("book.xlsx", GOOGLE_DRIVE_OFFICE_XLSM_MIME),
    ).toBe(false);
    expect(isGoogleDriveOfficeFile("book.csv", "text/csv")).toBe(false);
    expect(
      isGoogleDriveOfficeFile("book.xlsm", "application/octet-stream"),
    ).toBe(false);
    expect(
      isGoogleDriveOfficeFile(
        "book.xlsm",
        "application/vnd.google-apps.spreadsheet",
      ),
    ).toBe(false);
    expect(
      isGoogleDriveOfficeFile(
        "book.xlsm",
        `${GOOGLE_DRIVE_OFFICE_XLSM_MIME}; charset=binary`,
      ),
    ).toBe(false);
    const mixedCaseMime = "application/vnd.ms-excel.sheet.macroEnabled.12";
    expect(
      parseGoogleDriveOfficePortMessage({
        ...metadata("xlsm", 1),
        mimeType: mixedCaseMime,
      }),
    ).toMatchObject({ mimeType: mixedCaseMime });
    expect(
      parseGoogleDriveOfficePortMessage(metadata("xlsx", 1)),
    ).not.toBeNull();
    expect(
      parseGoogleDriveOfficePortMessage({
        ...metadata("xlsx", 1),
        debug: true,
      }),
    ).toBeNull();
    expect(
      parseGoogleDriveOfficePortMessage({
        ...metadata("xlsx", 1),
        modifiedTime: "not-a-timestamp",
      }),
    ).toBeNull();
    expect(
      parseGoogleDriveOfficePortMessage({
        ...metadata("xlsx", 1),
        modifiedTime: "2026-02-31T02:30:45Z",
      }),
    ).toBeNull();
    expect(
      parseGoogleDriveOfficePortMessage({
        ...metadata("xlsx", 1),
        md5Checksum: "A".repeat(32),
      }),
    ).toBeNull();
    expect(
      parseGoogleDriveOfficePortMessage({
        ...metadata("xlsx", 1),
        md5Checksum: null,
      }),
    ).not.toBeNull();
  });

  it("round-trips browser-native base64 and rejects malformed or oversized chunks", () => {
    const bytes = Uint8Array.from([0, 1, 127, 128, 254, 255]);
    expect(
      decodeGoogleDriveOfficeChunk(encodeGoogleDriveOfficeChunk(bytes)),
    ).toEqual(bytes);
    for (const invalid of ["", "%%%", "YQ", "YR==", "YQ==\n"]) {
      expect(() => decodeGoogleDriveOfficeChunk(invalid)).toThrow();
    }
    expect(() =>
      encodeGoogleDriveOfficeChunk(
        new Uint8Array(MAX_GOOGLE_DRIVE_OFFICE_CHUNK_BYTES + 1),
      ),
    ).toThrow();
    expect(
      parseGoogleDriveOfficePortMessage(
        message("GOOGLE_DRIVE_OFFICE_CHUNK", { sequence: 0, data: "%%%" }),
      ),
    ).toBeNull();
  });

  it.each(["xlsx", "xlsm"] as const)(
    "assembles one complete ordered %s stream",
    (extension) => {
      const assembler = new GoogleDriveOfficeDownloadAssembler(start);
      expect(assembler.accept(metadata(extension, 5))).toEqual({
        status: "pending",
      });
      expect(assembler.accept(chunk(0, [1, 2]))).toEqual({ status: "pending" });
      expect(assembler.accept(chunk(1, [3, 4, 5]))).toEqual({
        status: "pending",
      });
      const result = assembler.accept(complete(2, 5));
      expect(result.status).toBe("complete");
      if (result.status === "complete") {
        expect(Array.from(new Uint8Array(result.bytes))).toEqual([
          1, 2, 3, 4, 5,
        ]);
        expect(result.metadata.fileName).toBe(`book.${extension}`);
        expect(result.metadata.modifiedTime).toBe("2026-09-28T02:30:45.123Z");
        expect(result.metadata.md5Checksum).toBe("a".repeat(32));
      }
      expect(assembler.terminal).toBe(true);
      expect(assembler.bufferedByteLength).toBe(0);
    },
  );

  it.each([
    ["chunk before metadata", [chunk(0, [1])]],
    ["sequence gap", [metadata("xlsx", 1), chunk(1, [1])]],
    ["duplicate sequence", [metadata("xlsx", 2), chunk(0, [1]), chunk(0, [2])]],
    ["decoded overflow", [metadata("xlsx", 1), chunk(0, [1, 2])]],
    ["missing chunk", [metadata("xlsx", 2), chunk(0, [1]), complete(1, 2)]],
    [
      "owner mismatch",
      [metadata("xlsx", 1), { ...chunk(0, [1]), readerInstanceId: "reader-2" }],
    ],
    [
      "version mismatch",
      [
        metadata("xlsx", 1),
        { ...chunk(0, [1]), version: { ...start.version, sourceRevision: 3 } },
      ],
    ],
  ])("aborts and clears on %s", (_name, messages) => {
    const assembler = new GoogleDriveOfficeDownloadAssembler(start);
    expect(() => {
      for (const value of messages) assembler.accept(value);
    }).toThrow(GoogleDriveOfficeProtocolError);
    expect(assembler.terminal).toBe(true);
    expect(assembler.bufferedByteLength).toBe(0);
  });

  it("accepts only supported terminal errors and clears buffered bytes", () => {
    const assembler = new GoogleDriveOfficeDownloadAssembler(start);
    assembler.accept(metadata("xlsx", 2));
    assembler.accept(chunk(0, [1]));
    expect(
      assembler.accept(
        message("GOOGLE_DRIVE_OFFICE_ERROR", { error: "download-timeout" }),
      ),
    ).toEqual({ status: "error", error: "download-timeout" });
    expect(assembler.bufferedByteLength).toBe(0);
    expect(
      parseGoogleDriveOfficePortMessage(
        message("GOOGLE_DRIVE_OFFICE_ERROR", { error: "arbitrary" }),
      ),
    ).toBeNull();
    for (const error of [
      "auth-required",
      "auth-unavailable",
      "google-oauth-scope",
    ]) {
      expect(
        parseGoogleDriveOfficePortMessage(
          message("GOOGLE_DRIVE_OFFICE_ERROR", { error }),
        ),
      ).not.toBeNull();
    }
  });
});
