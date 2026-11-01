# Dependency security backport

`node-forge@1.4.0.patch` backports the nested DigestAlgorithm element-count guard proposed in [upstream PR #1152](https://github.com/digitalbazaar/forge/pull/1152/files), commit `ceba344`. The PR remains open and npm has no patched release as of 2026-10-03; package version is deliberately unchanged.

The patch rejects extra ASN.1 children while keeping SHA-256 signatures with and without optional NULL parameters valid. `scripts/node-forge-patch.test.ts` exercises the actual installed `web-ext → @devicefarmer/adbkit → node-forge` copy and synthetic local signatures. `pnpm install` applies the lockfile-pinned patch automatically.

`pnpm audit` may still report GHSA-86w9-cpqp-85rv because it matches package versions rather than this patch. Do not suppress that advisory or claim an official fixed release. Replace this backport with a supported patched npm release and rerun the regression when one becomes available.
