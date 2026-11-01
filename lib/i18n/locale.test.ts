import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import {
  parseUiLocaleChanged,
  parseUiLocaleResponse,
  requestUiLocale,
  resolveUiLocale,
  saveUiLocale,
} from "@/lib/i18n/locale";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("UI locale", () => {
  it("prefers a stored choice, else follows a vi* browser language", () => {
    expect(resolveUiLocale("vi", "en-US")).toBe("vi");
    expect(resolveUiLocale("en", "vi-VN")).toBe("en");
    expect(resolveUiLocale(undefined, "vi")).toBe("vi");
    expect(resolveUiLocale(null, "vi-VN")).toBe("vi");
    expect(resolveUiLocale(undefined, "VI_vn")).toBe("vi");
    expect(resolveUiLocale(undefined, "en-GB")).toBe("en");
    expect(resolveUiLocale(undefined, "ja")).toBe("en");
    expect(resolveUiLocale(undefined, "vietnamese")).toBe("en");
    expect(resolveUiLocale(undefined, undefined)).toBe("en");
    expect(resolveUiLocale("fr", "vi-VN")).toBe("vi");
    expect(resolveUiLocale("fr", "fr-FR")).toBe("en");
  });

  it("validates background answers and broadcasts", () => {
    expect(parseUiLocaleResponse({ locale: "vi", stored: null })).toEqual({
      locale: "vi",
      stored: null,
    });
    expect(parseUiLocaleResponse({ locale: "de" })).toBeUndefined();
    expect(parseUiLocaleResponse(undefined)).toBeUndefined();
    expect(
      parseUiLocaleChanged({ type: "UI_LOCALE_CHANGED", locale: "vi" }),
    ).toBe("vi");
    expect(
      parseUiLocaleChanged({ type: "UI_LOCALE_CHANGED", locale: "xx" }),
    ).toBeUndefined();
    expect(parseUiLocaleChanged({ type: "OTHER", locale: "vi" })).toBe(
      undefined,
    );
  });

  it("asks the background and falls back to the browser language", async () => {
    const send = vi
      .spyOn(fakeBrowser.runtime, "sendMessage")
      .mockResolvedValueOnce({ locale: "vi", stored: "vi" } as never)
      .mockRejectedValueOnce(new Error("no receiver"));
    await expect(requestUiLocale()).resolves.toBe("vi");
    expect(send).toHaveBeenCalledWith({ type: "UI_LOCALE_GET" });
    // jsdom's navigator.language is en-US.
    await expect(requestUiLocale()).resolves.toBe("en");
  });

  it("saves an explicit choice through the background", async () => {
    const send = vi
      .spyOn(fakeBrowser.runtime, "sendMessage")
      .mockResolvedValueOnce({ locale: "vi", stored: "vi" } as never)
      .mockResolvedValueOnce(undefined as never);
    await expect(saveUiLocale("vi")).resolves.toBe("vi");
    expect(send).toHaveBeenCalledWith({ type: "UI_LOCALE_SET", locale: "vi" });
    await expect(saveUiLocale("en")).rejects.toThrow();
  });
});
