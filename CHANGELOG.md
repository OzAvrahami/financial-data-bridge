# Changelog

## Unreleased

## [3.1.0] - Prepared (unpublished)

Prepared on 2026-10-01 from `3f9ebcbe33fcd6243569d23338b551e934b5b77b`. See [release notes](docs/RELEASE_3_1_0.md).

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

Candidate metadata is 3.1.0; dependency versions are unchanged. Publication and production activation remain pending.

### Fixed

- Display the running application version beside the desktop header using Electron
  environment info, without hardcoding the release number or changing settings.
- Forward the selected finance contract version through desktop sync orchestration;
  keep the default legacy configuration unchanged.
- Scope v2 by exact CAL source-account ID and payment-source name across settings,
  desktop sync and export. Other streams remain legacy; frozen requests retain their
  bodies after selection changes, and rejected v2 never falls back to legacy.
