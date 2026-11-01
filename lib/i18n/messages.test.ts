import { describe, expect, it } from "vitest";
import {
  placeholdersOf,
  type MessageCatalog,
  type MessageValue,
} from "@/lib/i18n/core";
import { en, type Namespace } from "@/lib/i18n/messages.en";
import { vi } from "@/lib/i18n/messages.vi";

const namespaces = Object.keys(en) as Namespace[];
const forms = (value: MessageValue) =>
  typeof value === "string" ? [value] : Object.values(value);

describe("UI message catalogs", () => {
  it("translate exactly the English keys in every namespace", () => {
    expect(Object.keys(vi).sort()).toEqual([...namespaces].sort());
    for (const namespace of namespaces)
      expect(Object.keys(vi[namespace]).sort(), namespace).toEqual(
        Object.keys(en[namespace]).sort(),
      );
  });

  it("have no empty or untrimmed messages", () => {
    for (const catalogs of [en, vi] as Record<Namespace, MessageCatalog>[])
      for (const namespace of namespaces)
        for (const [key, value] of Object.entries(catalogs[namespace]))
          for (const form of forms(value)) {
            expect(form.trim(), `${namespace}:${key}`).not.toBe("");
            expect(form, `${namespace}:${key}`).toBe(form.trim());
          }
  });

  it("keep the same placeholders in both languages", () => {
    for (const namespace of namespaces) {
      const english: MessageCatalog = en[namespace];
      const vietnamese: MessageCatalog = vi[namespace];
      for (const [key, value] of Object.entries(english)) {
        const translated = vietnamese[key]!;
        expect(
          [...placeholdersOf(translated)].sort(),
          `${namespace}:${key}`,
        ).toEqual([...placeholdersOf(value)].sort());
        // Every form of a plural message names the same placeholders.
        for (const form of forms(translated))
          expect(
            [...placeholdersOf(form)].sort(),
            `${namespace}:${key}`,
          ).toEqual([...placeholdersOf(translated)].sort());
        expect(typeof translated, `${namespace}:${key}`).toBe(typeof value);
        if (typeof value !== "string")
          expect(placeholdersOf(value).has("count")).toBe(true);
      }
    }
  });

  it("use keys that are unique across namespaces (surfaces merge them)", () => {
    const seen = new Map<string, Namespace>();
    for (const namespace of namespaces)
      for (const key of Object.keys(en[namespace])) {
        expect(seen.get(key), key).toBeUndefined();
        seen.set(key, namespace);
      }
  });

  it("keep the brand name untranslated", () => {
    for (const namespace of namespaces)
      for (const [key, value] of Object.entries(
        en[namespace] as MessageCatalog,
      ))
        if (forms(value).some((form) => form.includes("Readlace")))
          expect(
            forms((vi[namespace] as MessageCatalog)[key]!).some((form) =>
              form.includes("Readlace"),
            ),
            `${namespace}:${key}`,
          ).toBe(true);
  });

  it("use the agreed Vietnamese product terms", () => {
    expect(vi.popup["translate.button"]).toBe("Dịch trang");
    expect(vi.popup["translate.translation"]).toBe("Bản dịch");
    expect(vi.popup["translate.original"]).toBe("Bản gốc");
    expect(vi.popup["page.always"]).toBe("Luôn dịch trang này");
    expect(vi.popup["tools.open"]).toBe("Mở file bảng tính");
    expect(vi.common["language.vi"]).toBe("Tiếng Việt");
  });
});
