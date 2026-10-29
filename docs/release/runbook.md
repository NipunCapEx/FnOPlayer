# FOPlayer Release and Operations Runbook

## Release principles
- All code changes go through a PR from a dedicated branch; never commit directly to `master`.
- Required CI checks must pass on the exact PR head before merge.
- After merge, verify the default-branch CI run and record the commit and run URL in the QA checkpoint.
- A successful push to `master` automatically triggers a signed Android release build and uploads the resulting AAB to the Google Play **internal testing** track after the exact commit receives the successful `Required CI summary` status.
- Pull requests and feature branches do not publish to Google Play. Manual Android Release runs retain a `publish` opt-in.
- Do not release a market-data or alerting change solely because the build passes; verify data freshness and risk behaviour.
- Do not claim real-time data unless the selected provider's timestamp and service terms substantiate that claim.

## Pre-merge checklist
1. Review business outcome and acceptance criteria.
2. Inspect the complete diff for accidental changes, secrets, debug artefacts and unreviewed dependencies.
3. Run formatting, type checks, tests/coverage and build locally where tooling is available.
4. Confirm tests cover normal, boundary, invalid, stale, dependency-failure and safe-retry behaviour as relevant.
5. Verify PR-head CI, review failed job logs and fix root causes.
6. Confirm architecture, QA inventory, issue and this runbook are consistent.

## Environment and secrets
- Keep development and production Firebase projects separate.
- Configure Firebase project/database identifiers and credentials using environment-specific settings.
- Store Telegram bot token, Firebase service-account credentials and deployment credentials only in approved secret stores.
- Configure `FOPLAYER_MARKET_HOLIDAYS` on the backend as a comma-separated list of ISO dates (`YYYY-MM-DD`) from the current official exchange holiday calendar. If any configured date is malformed, monitoring fails closed until the value is corrected.
- Configure `FOPLAYER_MARKET_SPECIAL_SESSIONS` as a JSON object keyed by ISO date, with each value containing `open` and `close` in 24-hour `HH:MM` IST time (for example, `{"2026-10-24":{"open":"18:00","close":"19:00"}}`). This supports official special sessions such as Muhurat trading. Invalid JSON, dates, or times fail closed; keep this list current from official exchange notices.
- Never embed privileged credentials in Flutter web/mobile assets or commit them to source control.
- Apply least privilege and review Firebase rules before enabling production traffic.

## Automated Android internal testing release
Every push to `master` starts the Android Release workflow. It waits for the `Required CI summary` commit status for that exact SHA, refuses to publish when the status fails or times out, validates release configuration, signs APK/AAB with the configured upload key, verifies fingerprints/artifacts, and uploads the AAB to the internal testing track. The workflow is serialized to reduce overlapping uploads.

Required GitHub repository configuration:
- Secrets: `FIREBASE_GOOGLE_SERVICES_JSON`, `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`, `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`.
- Variables: `ANDROID_APPLICATION_ID` (normally `com.nipun.finance.fno`) and `FOPLAYER_API_BASE_URL` (HTTPS).

The Play service account must have access to the app in Play Console and permission to manage releases on the internal testing track. GitHub Actions cannot configure Google Play permissions or create the credentials; verify these once in the respective consoles. If configuration is missing/invalid, the workflow must fail visibly and the AAB will not be published.

## Release validation
When the relevant capabilities exist:
1. Check backend health/readiness and error logs.
2. Sign in and verify server-side authorization.
3. Verify source timestamp, fetch timestamp and freshness state for each supported ticker.
4. Test deterministic risk fixtures around ±8%, ±10% and ±12%; verify severity precedence.
5. Confirm stale/invalid prices do not create actionable fresh-price alerts.
6. Verify Telegram and Android push independently using a controlled test strategy.
7. Verify alert deduplication and recorded delivery failure/retry.
8. Verify Android and responsive web critical journeys.
9. Confirm provider limits, market-data terms and public redistribution permissions.
10. Record commit, CI run, smoke-test results, known limitations and release owner.

## Deployment smoke check

Run the repository smoke script against the deployed API after a deployment and again after rollback:

```bash
FOPLAYER_SMOKE_BASE_URL=https://<your-api-host> bash scripts/release-smoke.sh
```

The script checks that `GET /health` returns the expected service identity, valid market-hours configuration and diagnostic sections, and that anonymous `GET /api/dashboard` is rejected with HTTP 401. To also check a signed-in dashboard, supply a short-lived Firebase ID token through the secret environment variable `FOPLAYER_SMOKE_BEARER_TOKEN`; never put tokens on the command line or print them in CI logs. Use a protected CI secret or run the authenticated check locally. The authenticated check also requests `GET /api/strategies` and requires a JSON array, so a persistent watchlist HTTP 500 fails the deployment smoke test. CI validates script syntax, but cannot run this authenticated check unless a protected, short-lived `FOPLAYER_SMOKE_BEARER_TOKEN` and deployed API URL are configured. The script does not send test Telegram/FCM messages and does not prove market data is fresh. Those require a controlled, explicitly authorized live smoke test.

## Rollback
- Identify the last known-good deployment and commit before release.
- If risk calculations, freshness indicators, authorization or alert deduplication are wrong, disable alert delivery/monitoring first if safe to do so, then roll back to the last known-good version.
- Do not hide a faulty signal by suppressing tests or changing thresholds without an approved decision.
- Verify health and the affected critical journey after rollback; document impact and root cause.

## Current release state
The MVP is not yet release-ready. Do not deploy for real trading use until the backend, authentication, data quality controls, client, notification adapters, CI tests and operational checks are implemented and verified.

## Firebase Google Sign-In SHA diagnostics

The Android Release workflow prints these non-secret identifiers in its logs:
- `FOPLAYER_UPLOAD_KEY_SHA1` and `FOPLAYER_UPLOAD_KEY_SHA256`: certificate used by CI to sign the release before Play processing.
- `FOPLAYER_RELEASE_APK_SHA1` and `FOPLAYER_RELEASE_APK_SHA256`: certificate on the generated APK; the workflow verifies it matches the CI upload key.
- `FOPLAYER_FIREBASE_ANDROID_OAUTH_CERTIFICATE_HASHES`: Android certificate hashes currently embedded in `FIREBASE_GOOGLE_SERVICES_JSON`.
- `FOPLAYER_FIREBASE_PROJECT_ID`, `FOPLAYER_ANDROID_PACKAGE`, and `FOPLAYER_WEB_OAUTH_CLIENT_IDS`: helps catch a Firebase project, package, or OAuth client mismatch.

The app also logs `FOPLAYER_AUTH_DIAGNOSTICS` when Google sign-in is attempted. For an APK installed directly, its runtime signer should match the CI upload certificate. For an app installed from Google Play, the runtime signer is the **Play App Signing certificate**, which may differ from the upload key and is the fingerprint that must be registered in Firebase. Capture it using Android Studio Logcat filtered to `FOPLAYER_AUTH_DIAGNOSTICS`, or run `adb logcat -s FOPLAYER_AUTH_DIAGNOSTICS:I` while opening the login screen.

If fingerprints are missing or mismatched, open Google Play Console → App integrity → App signing, copy the **App signing key certificate** SHA-1 and SHA-256 (not only the upload key), then add them to Firebase Console → Project settings → Your apps → Android app for package `com.nipun.finance.fno`. Ensure Google is enabled under Firebase Authentication → Sign-in method, download the refreshed `google-services.json`, and update the GitHub Actions secret `FIREBASE_GOOGLE_SERVICES_JSON`. Do not put keystore passwords, private keys, or service-account credentials in logs. SHA fingerprints and OAuth client IDs are identifiers, not credentials.
