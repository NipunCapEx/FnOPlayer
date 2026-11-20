# FnO Players Flutter app

This Flutter application provides the FnO Players hedging decision dashboard.

## Android emulator E2E

The **Android Emulator E2E - FnO Players** workflow generates the Android project scaffolding used by CI, builds and installs a debug APK, launches it on an Android emulator, and runs the Flutter integration test against the real application startup path.

The workflow deliberately does not restore `google-services.json` or any Firebase credentials. The current test verifies the safe, fail-closed Firebase setup screen and confirms that an unconfigured build does not silently expose demo watchlist data or attempt authentication. It performs no Firebase Auth, Firestore, market-data API or payment writes.

This is a configuration-negative-path smoke test, not yet the authenticated dashboard journey. A later phase should run against a dedicated Firebase Auth emulator and disposable API/Firestore fixtures, then validate user-owned watchlist persistence, alert history and stale/unavailable market-data states.
