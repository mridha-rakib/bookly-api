# Professional zero-factor recovery: draft manual review policy

Status: **DRAFT — Owner security approval required. No factor reset is authorized.** Prepared 7 November 2026. This is a free, manual support-review process, not a reset procedure or a new API capability.

## Scope and safe default

Applies only to Business Owners, Supervisors and Staff who report losing both authenticator access and all recovery codes. Users who still hold a recovery code should use the supported sign-in flow; the explicit replacement option also supports the last remaining code. Support must never ask to receive an authenticator secret, OTP, recovery code, password, session cookie or encryption key.

Neither a password alone, an existing session, control of one mailbox, a business role nor a Super Admin login authorizes disabling factors. Existing restrictions, Customer suspension, employment checks and financial obligations remain unchanged. There is no paid identity-verification service dependency and no automatic recovery endpoint.

## Required Owner decisions before adopting the policy

The Owner must approve the accepted independent evidence categories, secure intake/retention/deletion rules, named support reviewers, independent security approver, escalation route, notification/waiting requirements, conflicts-of-interest handling and appeal process. These assignments are not assumed to exist from repository roles.

The Owner must separately approve the actual audited reset/re-enrollment execution mechanism and its authorization boundary. No such mechanism is implemented or authorized by this sprint. An approved evidence review alone must not trigger direct database edits, a Super Admin shortcut or an improvised password-only reset.

## Intake and ownership review

1. Create a restricted case using the existing support process. Record case id, claimed account, claimed role, loss scenario and a safe return contact. Do not disclose account existence or 2FA state to an unverified requester.
2. Tell the requester that recovery is not guaranteed and that review does not authorize a reset. Offer ordinary recovery-code sign-in without collecting the code. A recent loss claim must not be used to rush past controls.
3. Independently retrieve existing account/contact records through authorized read access. Contact only channels verified before the claim; do not rely on new addresses, telephone numbers, links or documents supplied as the sole trust anchor in the request.
4. Require multiple independent evidence sources under the approved matrix. Distinguish account control, the person's professional identity and the claimed business/employment relationship. A single emailed document or knowledge of public bookings/business data is insufficient. Collect only the necessary material through the approved restricted channel; do not solicit identity documents into public tickets/chat or invent retention obligations.
5. For an Owner, independently validate business control using pre-existing records and approved independently sourced corroboration. For Supervisor/Staff, independently validate the established employment relationship through pre-existing business contacts/records. A manager's endorsement alone must not grant access to another person's account or reveal their security data. Inactive/removed staff cannot regain Business permissions through this process.
6. Check for relevant recent credential/contact changes, account restrictions, conflicting claims, active disputes and indicators of coercion/social engineering using authorized records. If evidence is inconsistent or a reviewer cannot validate it independently, pause or deny; do not lower the bar because the infrastructure is free.

## Independent review and audit

- An authorized support reviewer records the evidence categories, independent source/channel, dates and evaluation. Store sensitive supporting material only in the approved restricted location; the audit record references it instead of duplicating it broadly.
- An independent designated security approver reviews the findings and conflicts of interest. Separate requester, reviewer and approver roles under the Owner-approved policy. Business ownership or Super Admin status is not automatic authorization to approve one's own case.
- Record case id, account id in restricted records, reviewer/approver identities, timestamps, decision rationale, notifications, any waiting requirement, escalation and retention/deletion disposition. Never record proof codes, authenticator secrets, session credentials or keys.
- Preserve the record of denials and suspicious requests using existing approved tooling. Do not create a paid ticketing, auditing or identity service. Use a restricted existing file/ticket process only if it can satisfy the approved access and retention controls; otherwise record that operational blocker.

## Outcomes

**Denied / insufficient evidence:** leave all factors and sessions unchanged, give a generic response that does not disclose private security state, record the reason internally and provide the approved appeal route.

**Pending / suspicious:** freeze the review, preserve the record, notify the designated security contact through a known channel and follow the approved incident process. Do not use a recovery request to alter bookings, payments, refunds, staff membership or account role.

**Ownership review approved:** record that evidence review is complete, then stop. A reset still requires the separately approved execution policy and mechanism. Until those exist, the account remains protected and no factor is removed. Support must state that limitation candidly.

Any future execution policy must preserve account restrictions, retire old sessions/challenges/recovery material atomically as appropriate, require secure re-enrollment, notify pre-existing verified channels and create a complete audit trail. That is a requirement for a future approved implementation, not permission or instructions to perform a reset now.

## Social-engineering safeguards

Do not accept urgency, seniority, payment threats, public business knowledge, a screenshot of a logged-in page, a newly supplied contact or a request to move to an unapproved channel as proof. Never ask a user to disable protections through console commands or send a QR setup URI. Use independently retrieved contacts and separate review; escalate uncertain or conflicted cases. No secret Super Admin recovery shortcut is permitted.
