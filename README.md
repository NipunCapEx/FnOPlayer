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

## Market-hours configuration

The monitoring worker defaults to weekdays, 09:15–15:30 Asia/Kolkata. Configure an exchange holiday list with `FOPLAYER_MARKET_HOLIDAYS=YYYY-MM-DD,YYYY-MM-DD`, adjust the regular session with `FOPLAYER_MARKET_OPEN=09:15` and `FOPLAYER_MARKET_CLOSE=15:30`, and define one-off sessions with `FOPLAYER_MARKET_SPECIAL_SESSIONS='{"2026-11-08":{"open":"18:00","close":"19:00"}}'`. Special sessions override the normal weekday/holiday gate for that date; keep the holiday list aligned with official exchange circulars. Invalid session times fail closed. These settings configure the polling window but do not make the upstream market-data provider official or guarantee its availability.

## Specification

See [F&O Hedging Dashboard implementation plan](docs/architecture/fno-hedging-dashboard.md) for architecture, risk formulas, dependencies and licensing constraints, implementation PRs, acceptance criteria, CI gates, and release checklist.

## Runtime health diagnostics

`GET /health` is a liveness endpoint and can return `status: "ok"` while optional integrations are not configured. Inspect `notificationReadiness` and `monitoringReadiness` before treating the deployment as ready for live alerts. A configured Telegram/FCM transport does not prove that a recipient/device is registered or that a real message was delivered; the endpoint explicitly reports those checks as unverified. Provider connectivity and worker-running state are not probed by this endpoint. Use real-device and live-provider smoke tests from the release runbook before relying on alerts.

## Important limitations

Free market-data sources can be unofficial, delayed, rate-limited, incomplete, or unavailable. Prices must show their source and timestamps; stale or missing prices must never be represented as current. Validate applicable data-use and redistribution terms before any public deployment. Alerts are decision support, not investment advice or a guarantee of trade profitability.
