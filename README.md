# FOPlayer — F&O Hedging Decision Dashboard

A decision-support dashboard for monitoring entry-relative risk boundaries for four Indian equities: RELIANCE, JSWSTEEL, BHARTIARTL, and SBICARD.

The product provides price monitoring, risk calculations, and Telegram/Android notifications. It does **not** execute trades or guarantee profitability.

## Planned technology

- Flutter for Android and responsive web
- NestJS + TypeScript backend
- Dedicated Firebase project: Authentication, Firestore, and Firebase Cloud Messaging
- Replaceable market-data adapter; begin with free data for a prototype
- Five-minute polling, subject to data-source limits and freshness
- Telegram Bot API and FCM notifications

Python, Redis, PostgreSQL/Prisma, and microservices are not required for the MVP absent a demonstrated need.

## Implementation status

The Flutter prototype mode uses clearly labelled demo market-price fixtures. The authenticated dashboard persists each user's watchlist through the NestJS API, includes owner-scoped alert history, and reads the latest validated backend market snapshots with source/timestamps and a 10-minute freshness gate. Missing or stale snapshots are never shown as current prices. The repository contains the NestJS/Firebase runtime, token verification, Firestore persistence, monitoring and notification core; deployed HTTPS/Firebase configuration, an always-on worker deployment, and real Firebase/FCM smoke tests remain to be verified. Do not use demo prices for trading decisions or treat this repository state as a production alerting service.

## Firebase / Firestore configuration

The API uses the project's default Firestore database unless `FIRESTORE_DATABASE_ID` is set. If the project's data lives in a named Firestore database, set this Render environment variable to the exact database ID shown in Firebase Console → Firestore. Keep `FIREBASE_PROJECT_ID` pointed at the same Firebase project. Do not set a guessed database ID: an incorrect or nonexistent database can cause Firestore gRPC `5 NOT_FOUND` errors. Changing this setting selects a database; it does not migrate or copy existing data.

## Market-data provider configuration

The API's Yahoo Finance chart adapter defaults to `https://query1.finance.yahoo.com/v8/finance/chart`. On the Render API service, optionally set `FOPLAYER_YAHOO_CHART_BASE_URL` to an HTTPS chart endpoint base URL (without a symbol or query string); the adapter appends the encoded NSE ticker and `range`/`interval` parameters. Keep the default unless intentionally using a compatible endpoint. `FOPLAYER_MARKET_DATA_TIMEOUT_MS` optionally sets the per-request timeout in milliseconds (100–60000); the default is 10000 ms. These settings require a redeploy to take effect. The Yahoo adapter is unofficial and may be blocked, rate-limited, or return incomplete data; a successful HTTP response alone does not establish that a usable quote was returned. Never add credentials to the URL or commit provider secrets.

## Market-hours configuration

The monitoring worker defaults to weekdays, 09:15–15:30 Asia/Kolkata. Configure an exchange holiday list with `FOPLAYER_MARKET_HOLIDAYS=YYYY-MM-DD,YYYY-MM-DD`, adjust the regular session with `FOPLAYER_MARKET_OPEN=09:15` and `FOPLAYER_MARKET_CLOSE=15:30`, and define one-off sessions with `FOPLAYER_MARKET_SPECIAL_SESSIONS='{"2026-11-08":{"open":"18:00","close":"19:00"}}'`. Special sessions override the normal weekday/holiday gate for that date; keep the holiday list aligned with official exchange circulars. Invalid session times fail closed. These settings configure the polling window but do not make the upstream market-data provider official or guarantee its availability.

## Specification

See [F&O Hedging Dashboard implementation plan](docs/architecture/fno-hedging-dashboard.md) for architecture, risk formulas, dependencies and licensing constraints, implementation PRs, acceptance criteria, CI gates, and release checklist.

## Runtime health diagnostics

`GET /health` is a liveness endpoint and can return `status: "ok"` while optional integrations are not configured. Inspect `notificationReadiness` and `monitoringReadiness` before treating the deployment as ready for live alerts. A configured Telegram/FCM transport does not prove that a recipient/device is registered or that a real message was delivered; the endpoint explicitly reports those checks as unverified. Provider connectivity is not probed by this endpoint. The worker section reports only this API instance's local timer/cycle state and does not prove that a separate deployment is running. The `monitoringReadiness.marketDataFreshness` list reports per-symbol fetch/exchange timestamps, source, age and a fresh/stale/invalid/unavailable state for symbols the worker has checked. It is runtime evidence from this process, not proof of live-provider uptime; provider error details are intentionally not exposed. The `monitoringReadiness.notificationDelivery` object reports process-local last-attempt, last-delivery and last-failure timestamps, consecutive and total delivery failures, and a sanitized failure category; a successful delivery resets the consecutive-failure count. These diagnostics reset when the API process restarts and do not replace durable outbox records or prove end-to-end delivery. Review the last cycle status and failure streak, and use real-device and live-provider smoke tests from the release runbook before relying on alerts.

## Important limitations

Free market-data sources can be unofficial, delayed, rate-limited, incomplete, or unavailable. Prices must show their source and timestamps; stale or missing prices must never be represented as current. Validate applicable data-use and redistribution terms before any public deployment. Alerts are decision support, not investment advice or a guarantee of trade profitability.
