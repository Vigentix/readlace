import { describe, expect, it } from "vitest";
import {
  createTranslator,
  defineMessages,
  formatMessage,
  interpolate,
} from "@/lib/i18n/core";

const english = {
  plain: "Translate",
  greeting: "Hello {name}",
  days: { one: "{count} day left", other: "{count} days left" },
  usage: "{used} of {limit} characters",
} as const;
const bundle = defineMessages(english, {
  plain: "Dịch",
  greeting: "Chào {name}",
  days: { other: "Còn {count} ngày" },
  usage: "{used} / {limit} ký tự",
});

describe("i18n core", () => {
  it("interpolates placeholders and leaves unknown ones visible", () => {
    expect(interpolate("Hi {a} {b}", { a: "x" }, "en")).toBe("Hi x {b}");
    expect(bundle.translator("en").t("greeting", { name: "Ana" })).toBe(
      "Hello Ana",
    );
    expect(bundle.translator("vi").t("greeting", { name: "An" })).toBe(
      "Chào An",
    );
  });

  it("chooses plural forms with the locale's rules", () => {
    const en = bundle.translator("en");
    const vi = bundle.translator("vi");
    expect(en.t("days", { count: 1 })).toBe("1 day left");
    expect(en.t("days", { count: 3 })).toBe("3 days left");
    // Vietnamese has a single (`other`) form.
    expect(vi.t("days", { count: 1 })).toBe("Còn 1 ngày");
    expect(vi.t("days", { count: 3 })).toBe("Còn 3 ngày");
    expect(formatMessage({ other: "{count} x" }, { count: 1 }, "en")).toBe(
      "1 x",
    );
  });

  it("formats numbers in placeholders and helpers per locale", () => {
    expect(
      bundle.translator("en").t("usage", { used: 1234, limit: 5000 }),
    ).toBe("1,234 of 5,000 characters");
    expect(
      bundle.translator("vi").t("usage", { used: 1234, limit: 5000 }),
    ).toBe("1.234 / 5.000 ký tự");
    const en = createTranslator("en", english, bundle.vi);
    const vi = createTranslator("vi", english, bundle.vi);
    expect(en.number(1234567)).toBe("1,234,567");
    expect(vi.number(1234567)).toBe("1.234.567");
    expect(en.chars(9_999)).toBe("9,999");
    expect(en.chars(1_200_000)).toBe("1.2M");
    // Intl separates the compact unit with a no-break space.
    expect(vi.chars(1_200_000)).toBe("1,2\u00a0Tr");
  });

  it("formats dates per locale", () => {
    const date = new Date(2026, 10, 1, 12);
    expect(bundle.translator("en").date(date)).toBe("Nov 1, 2026");
    expect(bundle.translator("vi").date(date)).toBe("1 thg 11, 2026");
  });

  it("translates stored message references", () => {
    const vi = bundle.translator("vi");
    expect(vi.text("plain")).toBe("Dịch");
    expect(vi.text({ key: "plain" })).toBe("Dịch");
    expect(vi.text({ key: "greeting", params: { name: "An" } })).toBe(
      "Chào An",
    );
  });

  it("caches one translator per locale", () => {
    expect(bundle.translator("vi")).toBe(bundle.translator("vi"));
    expect(bundle.translator("en").locale).toBe("en");
  });
});
