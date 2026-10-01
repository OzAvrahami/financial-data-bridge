# Financial Data Bridge v3.1.0 candidate

Prepared **2026-10-01; unpublished and undeployed** from
`3f9ebcbe33fcd6243569d23338b551e934b5b77b` on `feat/finance-contract-v2-84`.
Previous source version is 3.0.3 at `d8f8580d36e68727d9eecbbf767c41a9b81d8597`.
No GitHub Releases or v3.1.0 tag were found; previous local installer artifacts do
not establish GitHub publication. This is version/document preparation, not a built
or signed installer. Package and both lockfile root versions are 3.1.0, with the
dependency tree unchanged.

The committed lockfile still carried 3.0.0 in its two root version fields despite
package.json being 3.0.3. Preparation corrects that pre-existing metadata drift to
3.1.0; every other manifest/lockfile value is unchanged.

## Release notes

- Opt-in exact CAL stream selection replaces a global contract switch. Select
  provider, source-account ID and full payment-source name; no last4 matching or
  name merging. Unselected streams keep legacy delivery.
- Versioned billing evidence preserves exact billed ILS, separate original amount
  and currency, provider event semantics and existing purchase/charge dates.
- Frozen outgoing bodies persist before transmission and survive lost responses,
  restarts and selection changes. Sent entries and occurrence IDs remain intact.
  Rejected v2 requests never downgrade to legacy; payload conflicts require review.
- Reports distinguish durable pending-review acceptance from financial posting.
  Missing registration and unsupported events remain failed, not falsely sent.
- Desktop settings, IPC, sync and file export consistently carry stream selection.
  Malformed selections and ambiguous consumer registration names fail explicitly.

Compatibility requires the Finance Tracker v1.6.0 consumer, pending migrations
045/046/047 and exact, unambiguous registration before selecting v2. The default
selection is empty. Updating the app does not authorize activation or reset ledgers.
See [configuration and recovery](RUNBOOK.md#10-opt-in-cal-billing-evidence-v2-unreleased).

Limitations: real installment/refund handling is not accepted; unknown/part events
are explicit failures. The historical ILS 60 `עמלת פירעון` on card 5746 is already
sent and remains untouched; it is not evidence of a real installment failure on 2755.
No inferred exchange rates, timestamps, installment identities or merchant aliases.

## Verification and rollout

Release-focused checks: **4/4** mixed-stream, missing-registration/rejection,
selection-change retry and file-export cases passed. Finance Tracker's previously
blocked actual-exporter → disposable PostgreSQL persistence/replay check passed
**1/1**. Reuse prior 69 focused Bridge tests, 9 sync regressions and 17 consumer tests.

Interactive stream selection, persistence and reload remain unverified: automatic
approval review blocked the isolated Electron launch command without a specific
reason. No normal settings, credentials, ledger or provider connection was used.
Automated settings/handoff evidence remains valid but does not claim visual acceptance.

1. Commit reviewed candidate preparation; do not publish an installer automatically.
2. Deploy the consumer and pending migrations first using the existing Finance Tracker
   workflow, without enabling native ingestion or registering CAL as a side effect.
3. Inspect the Bridge settings UI with separate userData, disabled finance export and
   no provider credentials; verify add/save/reload/remove of synthetic stream entries.
4. Before any production activation, back up current Bridge settings/ledger; verify
   each exact consumer registration and resolve unsupported-event policy. If two
   source accounts share a registration name, stop rather than guessing a mapping.
5. Only under separate activation authorization, save matching v2 stream selections
   with no sync in flight. Preserve frozen requests and sent history. Review rejected
   or pending outcomes without clearing the ledger or generating replacement IDs.

Recovery: retain ledger/provenance and forward-fix. Removing a selection does not
downgrade its frozen requests or remove the consumer's registration guard. No live
importer, production delivery or phone retry occurred during preparation.

## Release / Version gate

- Release impact: Yes; SemVer: Minor, additive opt-in contract and durable delivery.
- Candidate: v3.1.0 prepared/unpublished; own release coordinated with Finance Tracker #84/v1.6.0.
- CHANGELOG: moved to prepared 3.1.0; Unreleased retained.
- Version bump: three fields synchronized locally; dependencies unchanged.
- Publication: pending owner integration, installer preparation and separate authorization.
- Owner acceptance: pending visual/activation review; automated evidence is not production acceptance.
