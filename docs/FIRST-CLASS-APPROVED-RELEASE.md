# First-Class approved release and deployment authority

Production First-Class Checkout stays **disabled** until a root-controlled deployment authority
on the qualified Linux host provisions a valid, fresh handoff. Without it every gate denies.
No approval, key, host, policy or attestation is shipped in this repository.

## Trust chain

1. **Owner release approval.** An Ed25519 signature over `bookly:first-class-release:v1\0`
   followed by the canonical JSON release record (`authenticated-release-record.ts`). The
   record names the release Git SHA, validity window, strict 30-minute lifetime, approved clock
   policy, the host-authority registry entries, the audit-key root and the reader group.
2. **Deployment attestation.** A separate Ed25519 signature, by a different root-only key,
   over `bookly:first-class-deployment-attestation:v1\0` followed by canonical JSON
   (`deployment-attestation.ts`). The deployment authority independently establishes and
   signs:
   - the running Git SHA and the artifact digest of the deployed tree;
   - the host identity (`authorityId`, `hostId`, `configurationHash`) and current `bootId`;
   - a trusted-time interval from the qualified clock, plus an evidence digest;
   - the digest of the approved clock policy;
   - the approval trust-anchor fingerprint and the revoked approval-key fingerprints;
   - the authenticated previous registry snapshot;
   - the SHA-256 of the exact release record it vouches for;
   - a strictly monotonic `sequence`, `issuedAtMs` and `expiresAtMs`.
3. **Application checks** (`first-class-deployment-authority.ts`). The API process:
   - refuses to run the authority as root, and reads inputs only from the fixed directory
     `/etc/bookly/first-class-authority`, whose every component must be root-owned and not
     group/other-writable (`protected-authority-files.ts`);
   - recomputes boot id and the artifact digest itself, and requires the artifact tree to be
     root-owned and not writable by the API user;
   - verifies the attestation, then verifies the release record **only** with the attested
     trust anchor, using the attested release SHA, host, boot, time and prior registry, never
     values taken from the record itself;
   - requires the clock-policy digest to match, the trusted-time interval to fit within
     `2 × maxErrorMs` of the approved policy, and the attestation not to outlive the release;
   - re-reads the attestation and deployment key on every authority check, so expiry,
     tampering, an older sequence, an equivocating same-sequence attestation or a substituted
     release record denies immediately; a renewed valid attestation is accepted without
     restart.

Startup pins the release record, host composition and observation. Missing or invalid input at
startup leaves the process without authority until restart. Historical verification keeps the
startup-authenticated registry; issuing new evidence (SIGN) requires a fresh attestation.

## The four gates

`readApprovedFirstClassRelease()` (batch authority, consent HTTP, checkout readiness) and
`readApprovedHostConfiguration()` (qualified host, historical verification) both read the same
authority. Consent HTTP is enabled only when the release exists at startup, and the mounted
route re-checks checkout readiness on every request. All four gates therefore open and close
together.

## Residual trust assumptions (require Owner/security acceptance)

- Root on the host is trusted: root can rewrite the authority directory, replay an older
  still-valid attestation after a restart, or alter the system clock. Expiry, boot binding and
  in-process sequence monotonicity bound but do not remove this.
- `node_modules` is outside the artifact digest; the deployment authority must install it from
  the attested lockfile (`pnpm install --frozen-lockfile`) and protect it like `dist`.
- The deployment authority runs outside the API process, as root. Its source is in
  `ops/first-class-authority/`, and installation and operation are described in
  `FIRST-CLASS-DEPLOYMENT-AUTHORITY-TOOL-HANDOFF.md`.
- The audit-key custody trade-offs in `FIRST-CLASS-AUDIT-KEY-CUSTODY.md` still apply.
