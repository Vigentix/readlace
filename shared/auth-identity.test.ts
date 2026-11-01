import { createHash, createPublicKey } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CHROMIUM_EXTENSION_ID,
  CHROMIUM_EXTENSION_PUBLIC_KEY,
} from "./auth-identity";

describe("stable Chromium identity", () => {
  it("derives the pinned extension ID from the public SPKI key", () => {
    const spki = createPublicKey({
      key: Buffer.from(CHROMIUM_EXTENSION_PUBLIC_KEY, "base64"),
      format: "der",
      type: "spki",
    }).export({ format: "der", type: "spki" });
    const extensionId = createHash("sha256")
      .update(spki)
      .digest()
      .subarray(0, 16)
      .toString("hex")
      .replace(/[0-9a-f]/g, (nibble) =>
        "abcdefghijklmnop".charAt(Number.parseInt(nibble, 16)),
      );
    expect(extensionId).toBe(CHROMIUM_EXTENSION_ID);
  });
});
