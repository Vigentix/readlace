import { describe, expect, it } from "vitest";
import * as translation from "./translation";
import { TRANSLATION_CONCURRENCY, preferenceKey } from "./translation";

describe("translation domain helpers", () => {
  it("keeps always-translate preferences in their own namespace", () => {
    expect(preferenceKey("example.com")).toBe("alwaysTranslate:example.com");
  });

  it("exposes no client provider choice", () => {
    expect(Object.keys(translation)).not.toEqual(
      expect.arrayContaining(["TRANSLATION_PROVIDERS"]),
    );
    expect(Object.keys(translation).some((key) => /provider/i.test(key))).toBe(
      false,
    );
  });

  it("keeps backend stage concurrency fixed at two", () => {
    expect(TRANSLATION_CONCURRENCY).toBe(2);
  });
});
