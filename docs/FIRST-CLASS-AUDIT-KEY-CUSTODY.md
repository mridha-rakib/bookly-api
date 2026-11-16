# Proposed First-Class audit-key custody

This is a proposal for Owner and security approval, not an authorization to create a key or
enable checkout. The shipped host and release records are unconfigured and deny activation.

The proposed Linux key root is `/var/lib/bookly/first-class-audit-keys`, outside Git, source,
build output and environment variables. The root and each reference directory are owned by
`root`, grouped to a dedicated `bookly-audit-readers` group, and mode `0750`. Each version is
stored as `<reference>/<version>.key`, owned by `root:bookly-audit-readers`, mode `0640`, with
one link and 32–64 raw key bytes. Reference and version use only ASCII letters, digits, `_`
and `-`, begin with a letter or digit, and do not contain paths. All ancestors must be
root-owned directories without group or other write permission. The API user is an unprivileged
member of the reader group; it cannot modify directories or keys. Review ACLs, mounts and
effective permissions separately: mode-bit checks alone do not establish custody.

The resolver checks Linux, ownership, modes, path components, file type and link count; opens
without following a final symlink and rechecks the opened inode. It reads the requested version
on each use and never logs or caches the key. Access failures deny. The source-controlled
resolver also rejects `.git` markers in the checked path; operators must still verify that the
approved location is outside every repository and build tree, including bare repositories.
The source-controlled
authority registry, not a filename or a caller's purpose string, decides which version may sign
and which historical version may verify. `CURRENT`, `VERIFY_ONLY` and `REVOKED` dispositions
and the history-continuity review prevent revoked generations from being reintroduced. A
registry change requires a reviewed release; an emergency key-access revocation also causes
subsequent reads to fail. Losing a historical key makes its evidence unverifiable.

HMAC is symmetric: an API process able to verify with a historical key also possesses the
material needed to create an HMAC. This design does not provide public-key nonrepudiation or
isolation between SIGN and VERIFY at the operating-system key-file boundary; Owner/security
must explicitly accept that trust model or select a different resolver before activation.

Before provisioning, approve the actual root and group, qualified host and boot, source-control
release records, access review, key custodian, rotation and incident/revocation policy. Preserve
each retired version required to verify retained evidence in a separately administered encrypted
off-server backup, with recovery access separated from the application account and a tested
restore procedure. Do not retire a version until retention and compromise decisions are approved.
Keep the strict 30-minute consent-commit deadline unchanged. Never print keys, pass them as
command arguments, place them in `.env`, commit them, or copy them into test fixtures.

After those approvals, an operator may inspect metadata (not key contents), substituting the
approved paths and identities:

```sh
id <approved-api-user>
namei -l /var/lib/bookly/first-class-audit-keys/<approved-reference>/<approved-version>.key
stat -c '%U %G %a %F %h %n' /var/lib/bookly/first-class-audit-keys /var/lib/bookly/first-class-audit-keys/<approved-reference> /var/lib/bookly/first-class-audit-keys/<approved-reference>/<approved-version>.key
getfacl -p /var/lib/bookly/first-class-audit-keys /var/lib/bookly/first-class-audit-keys/<approved-reference> /var/lib/bookly/first-class-audit-keys/<approved-reference>/<approved-version>.key
```

These commands do not provision, deploy or activate anything. Key creation, protected backup,
host qualification and the coordinated staging release require a separately approved operator
plan; no exact activation command is authorized by this document.
