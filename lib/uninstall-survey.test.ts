import { describe, expect, it, vi } from "vitest";
import {
  installUninstallSurvey,
  parseUninstallSurveyUrl,
} from "./uninstall-survey";

describe("parseUninstallSurveyUrl (ADR 0020)", () => {
  it("accepts a plain HTTPS page", () => {
    expect(parseUninstallSurveyUrl(" https://readlace.com/uninstall ")).toBe(
      "https://readlace.com/uninstall",
    );
  });

  it("refuses anything that could carry or invite an identifier", () => {
    for (const value of [
      undefined,
      "",
      "http://readlace.com/uninstall",
      "https://readlace.com/uninstall?id=123",
      "https://readlace.com/uninstall#user",
      "https://user:pass@readlace.com/uninstall",
      "javascript:alert(1)",
      "not a url",
    ])
      expect(parseUninstallSurveyUrl(value), String(value)).toBeUndefined();
  });
});

describe("installUninstallSurvey", () => {
  it("sets the survey URL exactly as configured", async () => {
    const setUninstallURL = vi.fn(async () => undefined);
    await installUninstallSurvey(
      { setUninstallURL },
      "https://readlace.com/uninstall",
    );
    expect(setUninstallURL).toHaveBeenCalledExactlyOnceWith(
      "https://readlace.com/uninstall",
    );
  });

  it("does nothing without a valid URL and never throws", async () => {
    const setUninstallURL = vi.fn(async () => {
      throw new Error("unsupported");
    });
    await installUninstallSurvey({ setUninstallURL }, undefined);
    expect(setUninstallURL).not.toHaveBeenCalled();
    await expect(
      installUninstallSurvey({ setUninstallURL }, "https://readlace.com/bye"),
    ).resolves.toBeUndefined();
  });
});
