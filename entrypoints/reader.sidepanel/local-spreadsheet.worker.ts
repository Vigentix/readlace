import {
  localSpreadsheetError,
  LocalSpreadsheetError,
  parseLocalSpreadsheet,
  type LocalSpreadsheetWorkbook,
  type LocalSpreadsheetWorkerRequest,
  type LocalSpreadsheetWorkerResponse,
} from "@/lib/local-spreadsheet";

const workerScope = self as unknown as {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  postMessage(message: LocalSpreadsheetWorkerResponse): void;
  close(): void;
};
let workbook: LocalSpreadsheetWorkbook | null = null;

const exactKeys = (value: object, keys: readonly string[]) => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
};

function request(value: unknown): LocalSpreadsheetWorkerRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (
    typeof input.requestId !== "string" ||
    input.requestId.length < 1 ||
    input.requestId.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/.test(input.requestId)
  ) {
    return null;
  }
  if (
    input.type === "parse" &&
    exactKeys(input, ["type", "requestId", "fileName", "bytes"]) &&
    typeof input.fileName === "string" &&
    input.fileName.length > 0 &&
    input.fileName.length <= 255 &&
    Object.prototype.toString.call(input.bytes) === "[object ArrayBuffer]"
  ) {
    return input as unknown as LocalSpreadsheetWorkerRequest;
  }
  if (
    input.type === "select-sheet" &&
    exactKeys(input, ["type", "requestId", "sheetIndex"]) &&
    Number.isSafeInteger(input.sheetIndex)
  ) {
    return input as unknown as LocalSpreadsheetWorkerRequest;
  }
  if (
    input.type === "load-page" &&
    exactKeys(input, ["type", "requestId", "startRow"]) &&
    Number.isSafeInteger(input.startRow)
  ) {
    return input as unknown as LocalSpreadsheetWorkerRequest;
  }
  return input.type === "dispose" && exactKeys(input, ["type", "requestId"])
    ? (input as unknown as LocalSpreadsheetWorkerRequest)
    : null;
}

function post(response: LocalSpreadsheetWorkerResponse) {
  workerScope.postMessage(response);
}

workerScope.addEventListener("message", (event: MessageEvent<unknown>) => {
  void (async () => {
    const input = request(event.data);
    const requestId =
      event.data &&
      typeof event.data === "object" &&
      "requestId" in event.data &&
      typeof event.data.requestId === "string"
        ? event.data.requestId
        : "invalid";
    if (!input) {
      post({ type: "error", requestId, error: "invalid-request" });
      return;
    }
    try {
      if (input.type === "parse") {
        const parsed = await parseLocalSpreadsheet(input.bytes, input.fileName);
        workbook = parsed;
        const sheet = await parsed.selectSheet(0);
        post({
          type: "parsed",
          requestId: input.requestId,
          metadata: parsed.metadata,
          sheet,
        });
      } else if (input.type === "select-sheet") {
        if (!workbook) throw new LocalSpreadsheetError("invalid-request");
        const selected = workbook;
        post({
          type: "sheet",
          requestId: input.requestId,
          sheet: await selected.selectSheet(input.sheetIndex),
        });
      } else if (input.type === "load-page") {
        if (!workbook) throw new LocalSpreadsheetError("invalid-request");
        post({
          type: "page",
          requestId: input.requestId,
          page: workbook.loadPage(input.startRow),
        });
      } else {
        workbook = null;
        post({ type: "disposed", requestId: input.requestId });
        workerScope.close();
      }
    } catch (error) {
      post({
        type: "error",
        requestId: input.requestId,
        error: localSpreadsheetError(error),
      });
    }
  })();
});
