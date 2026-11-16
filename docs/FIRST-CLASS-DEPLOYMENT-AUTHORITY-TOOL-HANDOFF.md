# Hetzner handoff: First-Class deployment authority tool

Audience: the Hetzner operator and the Owner. This covers installing and running the root-only
tool in `ops/first-class-authority/` that produces what `/etc/bookly/first-class-authority`
must contain (see `FIRST-CLASS-DEPLOYMENT-AUTHORITY-HANDOFF.md` for the API-side contract).

**Test-only vs. approved.** Sections 1–4 and 6 can be done now; they create no key, approval
or attestation. Everything in sections 5, 7 and 8 needs the Owner approvals listed in section 9 first.
The tests use generated in-memory keys, simulated hosts and fake chrony output. They prove
nothing about this host and their outputs must never be copied into `/etc`.

Not received: the operator's `/srv/bookly/ops/phase4.7/FIRST-CLASS-DEPLOYMENT-AUTHORITY-TOOL-SPEC.md`
was not available to the developer. Compare it against section 10 below and report any difference
before activation.

## 1. Minimum Linux requirements

- Debian/Ubuntu layout, systemd, `/usr/bin/git`, `/usr/bin/systemctl`, Node.js 24 at `/usr/bin/node`, pnpm.
- **Qualified clock = chrony.** The API's consent clock reads `chronyc tracking`. The tool
  measures `chronyc` (approved path), `/usr/sbin/chronyd`, `/etc/chrony/chrony.conf` and every
  file in `/etc/chrony/conf.d` and `/etc/chrony/sources.d`. `systemd-timesyncd` is **not** a
  qualified source: with no chrony installed the tool refuses (`CLOCK_SOURCE_NOT_INSTALLED`).
  It also refuses while timesyncd is active (`CLOCK_SOURCE_CONFLICT`). Replacing timesyncd with
  chrony, and choosing the time sources and their reference IDs, is an Owner-approved host
  change. It is not done by this tool.
- chrony's command socket (for example `/run/chrony/chronyd.sock`) must be reachable by root (the tool)
  and by the API user (the API's own consent clock).

## 2. Install the tool (root-owned, from the published commit)

```sh
# As an unprivileged build user: scripts never run as root.
git clone <github api repo> /home/build/bookly-api && cd /home/build/bookly-api
git checkout <published sha> && git rev-parse HEAD          # must equal the GitHub main SHA
pnpm install --frozen-lockfile
pnpm typecheck && pnpm build && pnpm build:authority-tool

# As root: freeze the verified tree. It is both the tool install and the release source checkout.
install -d -o root -g root -m 0755 /opt/bookly-first-class-authority
cp -a /home/build/bookly-api /opt/bookly-first-class-authority/<sha>
chown -R root:root /opt/bookly-first-class-authority/<sha>
chmod -R go-w /opt/bookly-first-class-authority/<sha>
ln -sfn /opt/bookly-first-class-authority/<sha> /opt/bookly-first-class-authority/current
install -o root -g root -m 0755 /opt/bookly-first-class-authority/current/ops/first-class-authority/bin/bookly-first-class-authority /usr/local/sbin/
git -c safe.directory='*' -C /opt/bookly-first-class-authority/<sha> status --porcelain   # must be empty
```

## 3. Root-owned API artifact and dependencies

The deployed API root (for example `/srv/bookly/api`, written into `deployment.json`) must hold
exactly the build from step 2, owned by root and not group/other-writable, with every ancestor
directory the same:

```sh
rsync -a --delete /opt/bookly-first-class-authority/<sha>/dist/ /srv/bookly/api/dist/
cp /opt/bookly-first-class-authority/<sha>/{package.json,pnpm-lock.yaml} /srv/bookly/api/
# node_modules: frozen install as the unprivileged build user, then copied in as root.
(cd /home/build/deploy && cp /srv/bookly/api/{package.json,pnpm-lock.yaml} . && pnpm install --frozen-lockfile --prod)
rsync -a --delete /home/build/deploy/node_modules/ /srv/bookly/api/node_modules/
chown -R root:root /srv/bookly/api && chmod -R go-w /srv/bookly/api
```

The tool refuses (`ARTIFACT_NOT_ROOT_OWNED`, `ARTIFACT_MISMATCH`) unless the deployed `dist`,
`package.json` and `pnpm-lock.yaml` produce the same artifact digest v1 as the clean checkout at
the signed `releaseSha`. It also requires `node_modules/.modules.yaml` and pins a separate
`node_modules` digest at adoption. Any later change to the artifact or dependencies stops renewal
(`ARTIFACT_CHANGED`). The API itself still measures only `dist` + `package.json` + `pnpm-lock.yaml`.

## 4. Protected directories

```sh
install -d -o root -g root -m 0755 /etc/bookly /etc/bookly/first-class-authority
install -d -o root -g root -m 0755 /etc/bookly-first-class-authority-tool
install -d -o root -g root -m 0700 /var/lib/bookly-first-class-authority
namei -l /etc/bookly/first-class-authority /var/lib/bookly-first-class-authority
getfacl -p /etc/bookly/first-class-authority /etc/bookly-first-class-authority-tool /var/lib/bookly-first-class-authority
sudo -u <api-user> test -r /var/lib/bookly-first-class-authority/. && echo "UNSAFE: API can read tool state"
```

The tool checks owner and mode on every path component. ACLs and mounts must be reviewed with
`getfacl`/`findmnt`, because the tool does not read them. The deployment signing key exists only as
`/var/lib/bookly-first-class-authority/deployment-signing.key` (root, 0600, in a 0700 directory).
It is never published and never readable by the API.

Tool configuration (root, 0644, regular files, provisioned out of band, **no defaults**):

| File | Content | Approval |
| --- | --- | --- |
| `release-approval.pub` | Owner Ed25519 SPKI PEM (trust anchor) | Owner |
| `clock-policy.json` | the five-limit policy, byte-for-byte the object signed in the record's `policy` | Owner |
| `attestation-policy.json` | `{"version":1,"approvalReference":"…","maxValidityMs":<n>}` | Owner |
| `deployment.json` | `{"version":1,"apiRoot":"/srv/bookly/api","apiUid":<api uid>}` | operator |

## 5. Service ordering

Install `ops/first-class-authority/systemd/*` to `/etc/systemd/system/`. Install
`bookly-api-first-class.conf` as a drop-in for the API unit. The API starts **after** a
renewal attempt and pins the release at startup. Replace `APPROVED_RENEWAL_INTERVAL` in the
timer with an Owner-approved value strictly shorter than `maxValidityMs`. Left unreplaced, the
timer is rejected and nothing renews (closed). The renew service does not run while
`stopped.json` exists.

## 6. Synthetic acceptance on the host (before any provisioning)

```sh
cd /home/build/bookly-api   # unprivileged
pnpm exec vitest run tests/unit/first-class-authority-tool.test.ts \
  tests/unit/first-class-deployment-authority.test.ts tests/unit/artifact-digest.test.ts \
  tests/unit/protected-authority-files.test.ts tests/unit/phase4-activation-boundary.test.ts
sudo bookly-first-class-authority status         # expect refusal: nothing provisioned yet
bookly-first-class-authority status               # expect ROOT_REQUIRED
```

Expected: all tests pass. With nothing provisioned, every API gate denies.

## 7. Approved qualification, signing and activation (Owner authorization required)

1. `bookly-first-class-authority init-signing-key`: generates the deployment key on the host.
   Its public fingerprint goes to the Owner.
2. Write a draft profile (`chronycPath`, `chronycSocketPath`, `referenceIds`, `maxAcquireMs`),
   then run `bookly-first-class-authority measure-host --profile <draft.json>`. It outputs
   `hostId` (machine id), current `bootId`, `configurationHash` (contract v1), the chrony
   hashes and the version output.
3. `bookly-first-class-authority measure-release --source /opt/bookly-first-class-authority/<sha> --release-sha <sha>`.
4. The Owner signs, **offline**, a canonical release record using exactly these measured values
   (CURRENT entry, approved policy, `keyRoot`, `readerGroupId`). It is delivered as
   `release-record.json` + `release-record.sig`.
5. Run `adopt-release --record … --signature … --source /opt/bookly-first-class-authority/<sha> --genesis`.
   Use `--genesis` only for the very first release. Then restart the API and check that
   `status` reports `verification.valid: true`. Finally, enable the timer.

## 8. Renewal, stop, revocation, reboot and rollback

- **Renew:** `renew` re-measures release, host, boot and clock. It durably reserves a higher
  sequence before signing, self-verifies with the API's own verifier, then atomically replaces
  `attestation.sig` and then `attestation.json`. An interrupted publish leaves a mismatched pair,
  which closes the gates. The next renewal repairs it.
- **Emergency stop:** `stop --reason "<text>"`. It writes `stopped.json` first, then archives and
  removes the attestation. The gates close on the next request. It is never blocked by the
  operation lock. `resume` only clears the marker; checkout reopens after the next successful
  `renew`.
- **Approval-key revocation:** `revoke-approval-key <sha256> --reference <decision>` appends to the
  list in the next attestation. Revoking the active anchor stops at once and blocks renewal
  until a record signed by a new, provisioned anchor is adopted.
- **Deployment-key rotation:** `init-signing-key --rotate`, then `renew`. No API restart is
  needed, and the old key is kept in `retired-keys/`.
- **Reboot:** the boot id changes, so renewal refuses (`HOST_BOOT_NOT_QUALIFIED`) and the gates
  close at expiry. Requalify by repeating steps 2–5 with a new `authorityId`. Leave out
  `--genesis`, and mark the previous entry `VERIFY_ONLY`.
- **Rollback of the application:** the artifact no longer matches, so renewal refuses and the
  gates close. An older record cannot be re-adopted (`RELEASE_REPLAYED`).
- **Interrupted operation:** a leftover `operation.lock` blocks mutation (`OPERATION_LOCKED`)
  until an operator inspects the state and removes it.

## 9. Owner approvals still required

Approval-key custody, rotation and revocation process. Generating the deployment key on the
host. The five clock limits. `maxValidityMs` and the renewal interval. Installing chrony in place
of timesyncd, with its sources and reference IDs. Host/boot qualification. Audit-key custody
(`FIRST-CLASS-AUDIT-KEY-CUSTODY.md`). Retention of evidence and archives: the tool deletes nothing
until a period is approved. Acceptance of the residual assumptions in
`FIRST-CLASS-APPROVED-RELEASE.md`.

## 10. Contracts closed by the tool

| Gap | Contract |
| --- | --- |
| `configurationHash` | v1 in `ops/first-class-authority/src/contract.ts`: machine id, kernel release, chronyc path/hash/socket/version, chronyd hash, chrony config file hashes, reference IDs, clock-policy digest. `hostId` = machine id. |
| Sequence persistence | `sequence.json` durably reserved before signing; never lower than the published attestation; crashes skip numbers, never reuse them. |
| Registry history and revocation | Append-only `registry-history.json`. `previousEntries` = the entries of the last adopted record. Replay and genesis are refused once history exists. Revocations are kept in append-only `revoked-approval-keys.json`. |
| Clock evidence | `evidence/<sha256>.json` (chrony outputs, acquisition timing, host and artifact measurement). Its SHA-256 is `trustedTime.evidenceSha256`. Retained indefinitely. |
| Startup ordering | systemd units in section 5. An API restart is required after every adoption. |
| Root-owned release | Section 3. The tool checks every ancestor and every entry, including `node_modules`. |
| Expiry, renewal, stop | `expiresAtMs = min(earliestMs + maxValidityMs, record.validUntilMs)`. Renewal, stop and resume as in section 8. |
| Frozen dependencies | Unprivileged `pnpm install --frozen-lockfile --prod`, then a root copy. The `node_modules` digest is pinned at adoption. |
