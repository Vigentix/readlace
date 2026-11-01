import { describe, expect, it } from "vitest";
import { CHROMIUM_EXTENSION_ID } from "./auth-identity";
import {
  GOOGLE_WORKSPACE_SCOPES,
  workspaceReaderBuildConfig,
} from "./google-workspace-config";

const CLIENT_ID = "123456789012-readlacereader.apps.googleusercontent.com";
const WEB_CLIENT_ID = "987654321098-readlaceweb.apps.googleusercontent.com";

describe("workspaceReaderBuildConfig", () => {
  it("keeps Reader manifest additions absent when the client ID is missing", () => {
    expect(workspaceReaderBuildConfig({}, "chrome")).toEqual({
      enabled: false,
      mode: "disabled",
      permissions: [],
      optionalPermissions: [],
      optionalHostPermissions: [],
    });
    expect(
      workspaceReaderBuildConfig(
        {
          WXT_GOOGLE_WORKSPACE_CLIENT_ID: "  ",
          WXT_GOOGLE_WORKSPACE_CLIENT_SECRET: "must-not-be-consumed",
          WXT_GOOGLE_WORKSPACE_API_KEY: "must-not-be-consumed",
        },
        "chrome",
      ),
    ).toEqual({
      enabled: false,
      mode: "disabled",
      permissions: [],
      optionalPermissions: [],
      optionalHostPermissions: [],
    });
  });

  it("returns the exact portable Chromium Reader permissions with optional Google access", () => {
    expect(
      workspaceReaderBuildConfig(
        {
          WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID: WEB_CLIENT_ID,
          WXT_GOOGLE_WORKSPACE_CLIENT_SECRET: "must-not-be-consumed",
          WXT_GOOGLE_WORKSPACE_API_KEY: "must-not-be-consumed",
          WXT_GOOGLE_WORKSPACE_SCOPES: "https://www.googleapis.com/auth/drive",
        },
        "chrome",
      ),
    ).toEqual({
      enabled: true,
      mode: "web",
      clientId: WEB_CLIENT_ID,
      permissions: ["sidePanel", "storage"],
      optionalPermissions: ["identity"],
      optionalHostPermissions: ["https://sheets.googleapis.com/*"],
    });
    // ADR 0015: no documents.readonly and no restricted drive.readonly.
    expect(GOOGLE_WORKSPACE_SCOPES).toEqual([
      "https://www.googleapis.com/auth/spreadsheets.readonly",
    ]);
  });

  it("keeps Firefox disabled even with a valid portable client ID", () => {
    expect(
      workspaceReaderBuildConfig(
        { WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID: WEB_CLIENT_ID },
        "firefox",
      ),
    ).toEqual({
      enabled: false,
      mode: "disabled",
      permissions: [],
      optionalPermissions: [],
      optionalHostPermissions: [],
    });
  });

  it("fails early for malformed portable client IDs", () => {
    for (const clientId of [
      "client-secret",
      "AIza" + "a".repeat(35),
      ` ${CLIENT_ID}`,
      "123.apps.googleusercontent.com",
      "abc123def4567-readlaceweb.apps.googleusercontent.com",
    ]) {
      expect(() =>
        workspaceReaderBuildConfig(
          { WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID: clientId },
          "chrome",
        ),
      ).toThrow(/WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID/);
    }
    expect(() =>
      workspaceReaderBuildConfig(
        { WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID: "client-secret" },
        "chrome",
      ),
    ).toThrow(/WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID/);
  });

  it("rejects the legacy native-only OAuth setting with migration guidance", () => {
    expect(() =>
      workspaceReaderBuildConfig(
        { WXT_GOOGLE_WORKSPACE_CLIENT_ID: CLIENT_ID },
        "chrome",
      ),
    ).toThrow(/no longer supported.*WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID/);
    expect(() =>
      workspaceReaderBuildConfig(
        {
          WXT_GOOGLE_WORKSPACE_CLIENT_ID: CLIENT_ID,
          WXT_GOOGLE_WORKSPACE_WEB_CLIENT_ID: WEB_CLIENT_ID,
        },
        "chrome",
      ),
    ).toThrow(/no longer supported.*portable Chromium Reader/);
  });

  it("documents the Google Chrome-extension OAuth registration identity", () => {
    expect(CHROMIUM_EXTENSION_ID).toBe("imlhpiikjakgljngkdalbfgdpkniejdb");
  });
});
