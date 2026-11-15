# Password recovery deployment notes

The recovery service uses the MongoDB collection `passwordrecoverychallenges`, separate from registration challenges. Do not enable this feature against a shared deployment until the following additive indexes have been reviewed and created by its database operator:

- Default unique `_id` index (identity is an HMAC of portal and normalized email).
- `{ challengeHash: 1 }`, unique.
- `{ resetHash: 1 }`, unique with `partialFilterExpression: { resetHash: { $type: "string" } }`.
- `{ expiresAt: 1 }`, TTL with `expireAfterSeconds: 3600`.

The model intentionally has `autoIndex: false`; this work does not apply indexes to an existing database. Index creation must be handled as an explicit deployment migration, not by running `syncIndexes` against shared data. Verify existing collection/index names and permissions first. The password update, reset-token consumption and session revocation require MongoDB transactions on a replica set or sharded cluster. The existing `OTP_HASH_SECRET`, OTP expiry, resend and attempt settings, rate-limit configuration, and configured email transport are reused. No new secrets are required.

API (under `/api/v1/auth/{customer|professional}/password-recovery`):

- `POST /request` `{ email, previousChallenge? }` returns `{ challenge }` with the same response message for eligible and ineligible addresses. During cooldown it returns the caller’s previous challenge only if it is still active; otherwise the challenge is an empty string and the UI asks the user to wait. Delivery is asynchronous and failures are masked; the provider logs only its safe failure category.
- `POST /resend` `{ challenge }` returns the same generic message. Cooldown and rolling hourly limits are enforced per portal/address; throttled requests do not issue a new code.
- `POST /verify` `{ challenge, code }` returns `{ resetToken }` only after the code is accepted. Codes are single-use, expire according to the existing OTP setting and have bounded attempts.
- `POST /complete` `{ resetToken, newPassword }` changes the password only once, within a 10-minute reset authorization window, and revokes all sessions in the same transaction.

The frontend stores the opaque challenge and reset authorization in tab-scoped `sessionStorage`, never in the URL; it removes them after completion. During cooldown, an existing active challenge is retained after server verification. A fresh or stale tab is asked to wait and cannot navigate with an unusable challenge. Resend responses do not disclose account eligibility or delivery.

Delivery configuration and real inbox delivery were not verified in local automated tests. Test suites use a disposable in-memory replica set and a mocked email provider; no shared database or real recipient is used.

## Additive operator migration (do not run during local validation)

1. Independently confirm the target database and deployment window. Confirm a replica set or sharded deployment and sufficient privileges; inspect `db.getCollectionNames()` and, if the collection already exists, `db.passwordrecoverychallenges.getIndexes()`. If an existing index conflicts in name, key, uniqueness or options, stop and investigate; do not drop or reconcile it automatically.
2. If the collection exists and contains records, check for duplicate string values of `challengeHash` and `resetHash` and resolve any conflicts through a separately approved procedure. Verify all documents have valid `expiresAt` dates before enabling TTL deletion. The following commands are additive and require operator approval:

```javascript
db.passwordrecoverychallenges.createIndex({ challengeHash: 1 }, { name: "challengeHash_1", unique: true });
db.passwordrecoverychallenges.createIndex({ resetHash: 1 }, { name: "resetHash_1", unique: true, partialFilterExpression: { resetHash: { $type: "string" } } });
db.passwordrecoverychallenges.createIndex({ expiresAt: 1 }, { name: "expiresAt_1", expireAfterSeconds: 3600 });
```

3. Check `getIndexes()` against these exact keys and options, including the default unique `_id_` index. Do not use `syncIndexes`. Confirm application credentials can use transactions and perform the narrowly scoped recovery operations. Deploy only after the index build succeeds and operational email delivery is verified. TTL deletion is asynchronous and affects challenge documents whose expiry is more than one hour old.
