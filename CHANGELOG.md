# Changelog

## Unreleased

### Added

- Opt-in CAL billing-evidence v2 for Finance Tracker: exact billed/original money,
  provider event classification and explicit unknown/part/refund boundaries. Existing
  identities and default Legacy v1 settings remain unchanged. Consumer-first rollout
  required; activation requires exact registered-stream scoping and explicit handling
  of unsupported events. Real installment coverage remains unverified.
- Freeze outgoing finance bodies before transmission and preserve them across restarts,
  lost responses and source changes. Keep sent ledger history, stop payload-conflict
  retry loops, and fail closed on corrupt ledgers.
- Distinguish accepted pending-review evidence from posted expenses in ledger/report
  data and desktop summaries. No ledger reset, provider request or automatic posting
  is part of this local preparation.

Version remains 3.0.3. Anticipated release impact: Minor; next version TBD after
coordinated compatibility verification and owner review.

### Fixed

- Forward the selected finance contract version through desktop sync orchestration;
  keep the default legacy configuration unchanged.
- Scope v2 by exact CAL source-account ID and payment-source name across settings,
  desktop sync and export. Other streams remain legacy; frozen requests retain their
  bodies after selection changes, and rejected v2 never falls back to legacy.
