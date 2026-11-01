// @vitest-environment node
import {
  constants,
  createHash,
  generateKeyPairSync,
  privateEncrypt,
  sign,
} from "node:crypto";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

// Exercise the installed transitive copy used by web-ext, not a direct test copy.
const require = createRequire(import.meta.url);
const webExtRequire = createRequire(require.resolve("web-ext"));
const adbkitRequire = createRequire(
  webExtRequire.resolve("@devicefarmer/adbkit"),
);
const forge = adbkitRequire("node-forge") as {
  pki: {
    publicKeyFromPem(pem: string): {
      verify(digest: string, signature: string): boolean;
    };
  };
};

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicExponent: 3,
});
const verifier = forge.pki.publicKeyFromPem(
  publicKey.export({ type: "spki", format: "pem" }) as string,
);
const message = Buffer.from("Readlace RSA verification regression");
const digest = createHash("sha256").update(message).digest();
const binaryDigest = digest.toString("latin1");

// Short DER values only; synthesize a signed DigestInfo locally with valid
// PKCS#1 padding to isolate ASN.1 validation from padding/signature failures.
function digestInfoSignature(includeNull: boolean, garbage = false): string {
  const algorithm = Buffer.concat([
    Buffer.from("0609608648016503040201", "hex"), // SHA-256 OID
    includeNull ? Buffer.from("0500", "hex") : Buffer.alloc(0),
    garbage ? Buffer.from("040188", "hex") : Buffer.alloc(0),
  ]);
  const body = Buffer.concat([
    Buffer.from([0x30, algorithm.length]),
    algorithm,
    Buffer.from([0x04, digest.length]),
    digest,
  ]);
  return privateEncrypt(
    { key: privateKey, padding: constants.RSA_PKCS1_PADDING },
    Buffer.concat([Buffer.from([0x30, body.length]), body]),
  ).toString("latin1");
}

describe("node-forge RSA DigestAlgorithm security backport", () => {
  it("accepts standard RSA signatures and SHA-256 with or without NULL parameters", () => {
    expect(
      verifier.verify(
        binaryDigest,
        sign("sha256", message, privateKey).toString("latin1"),
      ),
    ).toBe(true);
    for (const includeNull of [true, false]) {
      const signature = digestInfoSignature(includeNull);
      expect(verifier.verify(binaryDigest, signature)).toBe(true);
      expect(verifier.verify("wrong digest", signature)).toBe(false);
    }
  });

  it("rejects unconsumed children inside DigestAlgorithm with and without NULL", () => {
    // Regression for https://github.com/digitalbazaar/forge/pull/1152:
    // unpatched 1.4.0 incorrectly accepts both of these malformed structures.
    for (const includeNull of [true, false]) {
      expect(() =>
        verifier.verify(binaryDigest, digestInfoSignature(includeNull, true)),
      ).toThrow("DigestInfo value");
    }
  });
});
