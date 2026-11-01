import { describe, expect, it } from "vitest";
import {
  assessProviderTranslation,
  isDeterministicTranslationValue,
  preserveUntranslatedSource,
} from "./format-guards";

describe("isDeterministicTranslationValue", () => {
  it.each([
    ["email", "hello@example.com"],
    ["HTTPS URL", "https://example.com/a?q=1"],
    ["www URL", "www.example.com/path"],
    ["formatted currency", "−¥5,919,802"],
    ["Unicode currency and digits", "₹١٬٢٣٤٫٥٠"],
    ["full-width number", "￥１２３，４５６"],
    ["date-like number", "2026/08/25"],
    ["slash separator", "/"],
    ["middle-dot separator", "·"],
    ["bullet separator", "•"],
    ["symbol sequence", "¥−,."],
    ["uppercase ID", "INV-2048"],
    ["underscore ID", "A_1"],
    ["HTML token", '<span aria-label="x">'],
    ["arrow expression", "value => value"],
    ["strict operator token", "left === right"],
    ["logical-and token", "ready && valid"],
    ["logical-or token", "primary || fallback"],
    ["nullish token", "cached ?? fallback"],
    ["namespace token", "module::value"],
  ])("accepts %s", (_label, value) => {
    expect(isDeterministicTranslationValue(value)).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["whitespace", "   "],
    ["currency with a Latin word", "USD 1,000"],
    ["currency with a Japanese word", "1,000円"],
    ["ordinary source text", "Invoice 2048"],
    ["uppercase token without a digit", "INV-CODE"],
    ["plain Japanese label", "請求"],
    ["relative URL", "/invoices/2026"],
    ["incomplete email", "hello@example"],
    ["comparison prose", "left = right"],
    ["strict operator prose", "Use left === right to compare"],
    ["logical-and prose", "Save when ready && valid please"],
    ["logical-or prose", "Choose primary || fallback now"],
    ["nullish prose", "Use cached ?? fallback value"],
    ["namespace prose", "Read module::value before continuing"],
    ["Japanese operator prose", "請求 && 支払"],
  ])("rejects %s", (_label, value) => {
    expect(isDeterministicTranslationValue(value)).toBe(false);
  });
});

describe("preserveUntranslatedSource", () => {
  it("keeps the source when the provider only appended a colon", () => {
    expect(
      preserveUntranslatedSource("OFFICE SHEETS MAN", "OFFICE SHEETS MAN:"),
    ).toBe("OFFICE SHEETS MAN");
  });

  it("keeps the source for full-width punctuation and spacing", () => {
    expect(preserveUntranslatedSource("配達日", "配達日：")).toBe("配達日");
    expect(preserveUntranslatedSource("BRAND", "BRAND :")).toBe("BRAND");
  });

  it("keeps the source's original surrounding whitespace", () => {
    expect(preserveUntranslatedSource("  BRAND  ", "BRAND:")).toBe("  BRAND  ");
  });

  it("returns real translations unchanged", () => {
    expect(preserveUntranslatedSource("配達日", "Delivery date")).toBe(
      "Delivery date",
    );
    expect(
      preserveUntranslatedSource("OFFICE SHEETS MAN", "OFFICE SHEETS MAN"),
    ).toBe("OFFICE SHEETS MAN");
  });

  it("returns translations that extend the source with words unchanged", () => {
    expect(
      preserveUntranslatedSource("OFFICE SHEETS MAN", "OFFICE SHEETS MANAGER"),
    ).toBe("OFFICE SHEETS MANAGER");
    expect(preserveUntranslatedSource("Check", "Check the summary PDF.")).toBe(
      "Check the summary PDF.",
    );
  });

  it("ignores empty or shorter results", () => {
    expect(preserveUntranslatedSource("", "text:")).toBe("text:");
    expect(preserveUntranslatedSource("longer source", "long")).toBe("long");
  });
});

describe("assessProviderTranslation", () => {
  it("accepts target-compatible text from a mixed trusted-source page", () => {
    expect(assessProviderTranslation("Invoice", "Invoice", "en", "ja")).toEqual(
      {
        status: "accepted",
        text: "Invoice",
      },
    );
  });

  it("rejects exact Japanese source for English and Vietnamese", () => {
    expect(assessProviderTranslation("請求", "請求", "en", "ja")).toEqual({
      status: "quality-miss",
      reason: "source-identical",
    });
    expect(
      assessProviderTranslation("当月請求額", "当月請求額：", "vi", "ja"),
    ).toEqual({
      status: "quality-miss",
      reason: "source-identical",
    });
    expect(assessProviderTranslation("請求月", "請求月", "en", "ja")).toEqual({
      status: "quality-miss",
      reason: "source-identical",
    });
    expect(assessProviderTranslation("過入金", "過入金", "en", "ja")).toEqual({
      status: "quality-miss",
      reason: "source-identical",
    });
  });

  it("accepts Japanese-script source for Japanese and real translations", () => {
    expect(assessProviderTranslation("請求月", "請求月", "ja", "ja")).toEqual({
      status: "accepted",
      text: "請求月",
    });
    expect(assessProviderTranslation("請求月", "Billing month", "en")).toEqual({
      status: "accepted",
      text: "Billing month",
    });
  });

  it("accepts Latin and deterministic unchanged values", () => {
    expect(assessProviderTranslation("Invoice", "Invoice", "en", "en")).toEqual(
      {
        status: "accepted",
        text: "Invoice",
      },
    );
    expect(
      assessProviderTranslation("hello@example.com", "hello@example.com", "vi"),
    ).toEqual({
      status: "accepted",
      text: "hello@example.com",
    });
    expect(assessProviderTranslation("INV-2048", "INV-2048", "ja")).toEqual({
      status: "accepted",
      text: "INV-2048",
    });
    expect(
      assessProviderTranslation("value => value", "value => value", "vi"),
    ).toEqual({
      status: "accepted",
      text: "value => value",
    });
  });

  it.each([
    ["English to Vietnamese", "Invoice", "vi", "en"],
    ["Vietnamese to English", "Hóa đơn", "en", "vi"],
    ["English to Japanese", "Invoice", "ja", "en"],
  ] as const)("rejects copied %s source", (_label, source, target, pinned) => {
    expect(assessProviderTranslation(source, source, target, pinned)).toEqual({
      status: "quality-miss",
      reason: "source-identical",
    });
    expect(assessProviderTranslation(source, source, target)).toEqual({
      status: "quality-miss",
      reason: "source-identical",
    });
  });

  it("rejects unknown copied source including whitespace-only values", () => {
    expect(
      assessProviderTranslation("Invoice 請求", "Invoice 請求", "en"),
    ).toEqual({
      status: "quality-miss",
      reason: "source-identical",
    });
    expect(assessProviderTranslation("Привет", "Привет", "ja")).toEqual({
      status: "quality-miss",
      reason: "source-identical",
    });
    expect(assessProviderTranslation("  ", "  ", "en")).toEqual({
      status: "quality-miss",
      reason: "source-identical",
    });
  });
});
