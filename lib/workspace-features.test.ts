import { describe, expect, it, vi } from "vitest";
import {
  driveOfficeReaderEnabled,
  sheetsReaderEnabled,
} from "./workspace-features";

describe("sheetsReaderEnabled (ADR 0020)", () => {
  it("is on only when the build sets WXT_SHEETS_READER=true", () => {
    expect(sheetsReaderEnabled("true")).toBe(true);
    expect(sheetsReaderEnabled(" true ")).toBe(true);
    expect(sheetsReaderEnabled(undefined)).toBe(false);
    expect(sheetsReaderEnabled("")).toBe(false);
    expect(sheetsReaderEnabled("1")).toBe(false);
    expect(sheetsReaderEnabled("false")).toBe(false);
  });

  it("keeps the Drive Office workbook path off at launch", () => {
    expect(driveOfficeReaderEnabled()).toBe(false);
  });
});

describe("readSheetsReaderFlag", () => {
  it("asks the background and treats anything but true as off", async () => {
    const { readSheetsReaderFlag } = await import("./workspace-features");
    const send = vi.spyOn(browser.runtime, "sendMessage");
    send.mockResolvedValueOnce({ workspaceSheetsReader: true } as never);
    await expect(readSheetsReaderFlag()).resolves.toBe(true);
    expect(send).toHaveBeenCalledWith({ type: "WORKSPACE_FEATURES" });
    send.mockResolvedValueOnce(undefined as never);
    await expect(readSheetsReaderFlag()).resolves.toBe(false);
    send.mockRejectedValueOnce(new Error("no receiver"));
    await expect(readSheetsReaderFlag()).resolves.toBe(false);
    send.mockRestore();
  });
});
