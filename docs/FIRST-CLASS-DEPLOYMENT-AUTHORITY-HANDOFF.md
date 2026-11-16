# Hetzner handoff: First-Class deployment authority

Audience: the Hetzner operator and the Owner. This describes what must exist on the Linux host
before First-Class Checkout can open. It authorizes nothing by itself. Do not generate production
keys, write approvals or fabricate qualification evidence without the separate Owner approvals
listed in step 0.

The published code is fail-closed: with no `/etc/bookly/first-class-authority` directory, or any
invalid file in it, every First-Class gate denies with HTTP 503/404.

## 0. Approvals required first (Owner)

- Owner Ed25519 release-approval key: custody, rotation and revocation process.
- Deployment-authority Ed25519 key: generated **on the host** by root, never leaves it.
- Numerical clock policy (five limits) and the qualified host/boot evidence.
- Audit-key custody (`FIRST-CLASS-AUDIT-KEY-CUSTODY.md`).
- Acceptance of the residual assumptions in `FIRST-CLASS-APPROVED-RELEASE.md`.

## 1. Test the published code on Linux (before any provisioning)

```sh
git fetch && git checkout <published sha>   # confirm the SHA matches the GitHub main commit
pnpm install --frozen-lockfile
pnpm typecheck
pnpm exec vitest run tests/unit/first-class-deployment-authority.test.ts \
  tests/unit/artifact-digest.test.ts tests/unit/protected-authority-files.test.ts \
  tests/unit/file-audit-key-resolver.test.ts tests/unit/phase4-activation-boundary.test.ts
pnpm exec vitest run tests/integration/database/first-class-release-composition.integration.test.ts \
  tests/integration/database/phase4-shipped-activation-denial.integration.test.ts \
  --pool=forks --fileParallelism=false
```

Also confirm on Linux that, with no authority directory, `GET` on a package consent route returns
`PACKAGE_CONSENT_DISABLED` and catalogue readiness reports unavailable.

## 2. Running artifact verification

- Build from the exact approved commit. Deploy `dist/`, `package.json`, `pnpm-lock.yaml` and
  `node_modules` root-owned, with no group/other write (`chown -R root:root`, `chmod -R go-w`).
  The API refuses to measure an artifact that is writable by group/other or not owned by root.
- The deployment authority computes the artifact digest in the API root:

  ```sh
  { find dist -type f; printf '%s\n' package.json pnpm-lock.yaml; } | LC_ALL=C sort |
    while IFS= read -r f; do printf '%s\0%s\n' "$f" "$(sha256sum < "$f" | cut -d' ' -f1)"; done |
    sha256sum
  ```

  It must also check that `dist` holds no symlinks or special files. Only the compiled
  `node dist/app/server.js` start path can authorize; running from source never does.

## 3. Protected authority directory

`/etc/bookly/first-class-authority`, plus `/`, `/etc` and `/etc/bookly`, must be owned by root
with no group/other write. Each file is a root-owned regular file with a single link, no
group/other write, size ≤ 256 KiB:

| File | Content |
| --- | --- |
| `deployment-authority.pub` | Ed25519 SPKI PEM of the deployment authority |
| `release-approval.pub` | Ed25519 SPKI PEM of the Owner approval key |
| `release-record.json` / `.sig` | canonical JSON record / raw 64-byte Ed25519 signature |
| `attestation.json` / `.sig` | canonical JSON attestation / raw 64-byte Ed25519 signature |

The two public keys must differ. The API process must run as a non-root user that cannot write
to any of these paths. Verify ownership and permissions with:

```sh
namei -l /etc/bookly/first-class-authority/attestation.json
stat -c '%U %G %a %h %F %n' /etc/bookly/first-class-authority /etc/bookly/first-class-authority/*
getfacl -p /etc/bookly/first-class-authority /etc/bookly/first-class-authority/*
sudo -u <api-user> test -w /etc/bookly/first-class-authority && echo "UNSAFE: writable"
```

## 4. Attestation contents (deployment authority, root)

Canonical JSON (compact `JSON.stringify` key order as below, UTF-8, no whitespace):
`version`=1, `attestationId`, `sequence` (strictly increasing, never reused), `issuedAtMs`,
`expiresAtMs`, `release` {`gitSha`, `artifactSha256`, `recordSha256` = sha256 of the exact
`release-record.json` bytes}, `host` {`authorityId`, `hostId`, `configurationHash`, `bootId` from
`/proc/sys/kernel/random/boot_id`}, `trustedTime` {`earliestMs`, `latestMs`, `evidenceSha256` of the
retained raw clock evidence}, `clockPolicySha256` (sha256 of the approved policy JSON with keys
sorted), `trustAnchor` {`approvalKeySha256` = sha256 of the approval key's SPKI DER, i.e.
`openssl pkey -pubin -in release-approval.pub -outform DER | sha256sum`,
`revokedApprovalKeySha256`}, and `registry` {`previousEntries`, the last authenticated registry
snapshot}. Sign `bookly:first-class-deployment-attestation:v1\0` followed by the payload bytes.

Rules enforced by the API: `earliestMs ≤ issuedAtMs ≤ latestMs`;
`latestMs − earliestMs ≤ 2 × maxErrorMs`; `expiresAtMs ≤` the record's `validUntilMs`; and the
current time must stay within `[earliestMs, expiresAtMs)`. The expiry window is chosen by the
deployment authority under the approved policy; the application hardcodes none.

## 5. Approved clock policy and qualified host/boot

- Provision the Owner-approved five-limit policy to the deployment authority out of band; the
  same object goes, unchanged, into the signed release record's `policy`.
- Qualify the host and the **current boot**. Every reboot needs a new registry entry with a new
  `authorityId` and a new release record and attestation. A reboot without them closes all
  gates.

## 6. Historical registry continuity

The deployment authority keeps the append-only history of released registries. `previousEntries`
must be the snapshot of the last authenticated release. The API refuses removal of an entry,
resurrection of a `REVOKED` generation, promotion of `VERIFY_ONLY` back to `CURRENT`, and reuse of
a revoked key reference. Changing the registry requires a new release record and an API restart.

## 7. Activation and rollback

Activate only when every approval in step 0 exists and the step 1 tests pass on the host.
Provision the directory and restart the API. Readiness is true only if all four gates agree.

- **Renewal**: write a new attestation (higher `sequence`) atomically (`rename` within the
  directory). No restart is needed.
- **Immediate stop**: remove or invalidate `attestation.json`. Gates close on the next check;
  historical verification of already-sealed evidence continues.
- **Revoke an approval key**: add its fingerprint to `revokedApprovalKeySha256` in a new
  attestation.
- **Roll back the application**: deploy the previous artifact. Its digest no longer matches the
  attestation, so the gates stay closed until a matching approved release and attestation exist.
