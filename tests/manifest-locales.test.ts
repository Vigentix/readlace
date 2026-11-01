// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UI_LOCALES } from "@/lib/i18n/core";

interface ManifestFactory {
  manifest: (env: {
    browser: string;
    manifestVersion: number;
    mode: string;
    command: string;
  }) => Record<string, unknown>;
}

type LocaleMessages = Record<string, { message: string; description?: string }>;

function localeMessages(locale: string): LocaleMessages {
  return JSON.parse(
    readFileSync(
      new URL(`../public/_locales/${locale}/messages.json`, import.meta.url),
      "utf8",
    ),
  ) as LocaleMessages;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("localized manifest (_locales)", () => {
  it("names every manifest message in English and Vietnamese", async () => {
    vi.resetModules();
    vi.stubEnv("WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID", "");
    vi.stubEnv("WXT_GOOGLE_WORKSPACE_CLIENT_ID", "");
    const { default: config } = (await import("@/wxt.config")) as {
      default: ManifestFactory;
    };
    for (const browser of ["chrome", "firefox"]) {
      const manifest = config.manifest({
        browser,
        manifestVersion: browser === "chrome" ? 3 : 2,
        mode: "production",
        command: "build",
      });
      expect(manifest).toMatchObject({
        name: "__MSG_extName__",
        short_name: "__MSG_extShortName__",
        description: "__MSG_extDescription__",
        default_locale: "en",
      });
      const keys = [...JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g)].map(
        (match) => match[1]!,
      );
      for (const locale of UI_LOCALES) {
        const messages = localeMessages(locale);
        for (const key of keys) expect(messages[key]?.message).toBeTruthy();
      }
    }
  });

  it("keeps the same keys, the brand name and the Store length limits", () => {
    const english = localeMessages("en");
    for (const locale of UI_LOCALES) {
      const messages = localeMessages(locale);
      expect(Object.keys(messages).sort()).toEqual(Object.keys(english).sort());
      expect(messages.extName?.message).toBe("Readlace");
      expect(messages.extShortName?.message.length).toBeLessThanOrEqual(12);
      expect(
        [...(messages.extDescription?.message ?? "")].length,
      ).toBeLessThanOrEqual(132);
    }
    expect(localeMessages("vi").extDescription?.message).toMatch(/bố cục/);
  });
});
