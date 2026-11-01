import { describe, expect, it } from "vitest";
import {
  canonicalPreferenceKey,
  readAlwaysTranslatePreference,
  siteScopeFromHostname,
} from "./site-scope";

describe("siteScopeFromHostname", () => {
  it.each([
    {
      name: "news.yahoo.co.jp shares yahoo.co.jp",
      hostname: "news.yahoo.co.jp",
      scope: "yahoo.co.jp",
    },
    {
      name: "www.yahoo.co.jp shares yahoo.co.jp",
      hostname: "www.yahoo.co.jp",
      scope: "yahoo.co.jp",
    },
    {
      name: "www.example.com shares example.com",
      hostname: "www.example.com",
      scope: "example.com",
    },
    {
      name: "example.com is already eTLD+1",
      hostname: "example.com",
      scope: "example.com",
    },
    {
      name: "foo.google.co.uk is google.co.uk",
      hostname: "foo.google.co.uk",
      scope: "google.co.uk",
    },
    {
      name: "localhost stays exact",
      hostname: "localhost",
      scope: "localhost",
    },
    {
      name: "127.0.0.1 stays exact",
      hostname: "127.0.0.1",
      scope: "127.0.0.1",
    },
    {
      name: "alice.github.io stays private-suffix scoped",
      hostname: "alice.github.io",
      scope: "alice.github.io",
    },
    {
      name: "bob.github.io stays private-suffix scoped",
      hostname: "bob.github.io",
      scope: "bob.github.io",
    },
    {
      name: "empty hostname stays empty",
      hostname: "",
      scope: "",
    },
  ])("$name", ({ hostname, scope }) => {
    expect(siteScopeFromHostname(hostname)).toBe(scope);
  });

  it("keeps github.io private suffixes distinct", () => {
    expect(siteScopeFromHostname("alice.github.io")).not.toBe(
      siteScopeFromHostname("bob.github.io"),
    );
  });
});

describe("canonicalPreferenceKey", () => {
  it("prefixes the site scope", () => {
    expect(canonicalPreferenceKey("news.yahoo.co.jp")).toBe(
      "alwaysTranslate:yahoo.co.jp",
    );
  });
});

describe("readAlwaysTranslatePreference", () => {
  it("resolves a legacy www key for a sibling host", () => {
    const storage = {
      "alwaysTranslate:www.yahoo.co.jp": {
        enabled: true,
        targetLanguage: "en",
      },
    };
    expect(readAlwaysTranslatePreference("news.yahoo.co.jp", storage)).toEqual({
      enabled: true,
      targetLanguage: "en",
    });
  });

  it("prefers canonical over an exact sibling key", () => {
    const storage = {
      "alwaysTranslate:yahoo.co.jp": {
        enabled: true,
        targetLanguage: "vi",
      },
      "alwaysTranslate:www.yahoo.co.jp": {
        enabled: false,
        targetLanguage: "en",
      },
    };
    expect(readAlwaysTranslatePreference("news.yahoo.co.jp", storage)).toEqual({
      enabled: true,
      targetLanguage: "vi",
    });
  });

  it("uses the exact hostname key when canonical is missing", () => {
    const storage = {
      "alwaysTranslate:news.yahoo.co.jp": {
        enabled: true,
        targetLanguage: "ja",
      },
    };
    expect(readAlwaysTranslatePreference("news.yahoo.co.jp", storage)).toEqual({
      enabled: true,
      targetLanguage: "ja",
    });
  });

  it("ignores unrelated keys and invalid preference values", () => {
    const storage = {
      "translationCache:example.com": { enabled: true, targetLanguage: "en" },
      "alwaysTranslate:example.com": { enabled: "yes", targetLanguage: "en" },
      "alwaysTranslate:other.com": { enabled: true, targetLanguage: "en" },
    };
    expect(
      readAlwaysTranslatePreference("www.example.com", storage),
    ).toBeUndefined();
  });
});
