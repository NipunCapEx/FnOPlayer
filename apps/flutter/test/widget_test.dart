import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:foplayer/main.dart';
import 'package:foplayer/strategy_api.dart';

void main() {
  test('maps a saved notification preference into the dashboard instrument',
      () {
    const strategy = UserStrategy(
      id: 'strategy-1',
      symbol: 'RELIANCE',
      entryPrice: 1000,
      active: true,
      notificationsEnabled: false,
    );

    final instrument = mapUserStrategyToInstrument(
      strategy,
      null,
      now: DateTime(2026, 10, 21, 12),
      name: 'Reliance Industries',
    );

    expect(instrument.notificationsEnabled, isFalse);
    expect(instrument.name, 'Reliance Industries');
    expect(instrument.entryPrice, 1000);
    expect(instrument.hasSpotPrice, isFalse);
    expect(instrument.isStale, isTrue);
  });

  testWidgets('shows Google login entry point', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: GoogleLoginScreen(onSignIn: () {}),
      ),
    );
    expect(find.text('FnO Players'), findsOneWidget);
    expect(find.text('Continue with Google'), findsOneWidget);
  });

  testWidgets('explains Firebase setup when configuration is missing',
      (tester) async {
    await tester.pumpWidget(const FOPlayerApp());
    expect(find.text('Firebase setup required'), findsOneWidget);
    expect(find.textContaining('google-services.json'), findsOneWidget);
  });

  testWidgets('labels demo and configured API dashboard modes accurately',
      (tester) async {
    await tester.pumpWidget(
      const MaterialApp(home: DashboardScreen()),
    );
    expect(find.text('Demo mode'), findsOneWidget);
    expect(find.text('Prototype'), findsNothing);

    await tester.pumpWidget(
      MaterialApp(
        home: DashboardScreen(
          apiClient: StrategyApiClient(
            auth: _UnusedFirebaseAuth(),
            baseUrl: 'https://api.example.test',
          ),
          enablePushNotifications: false,
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('API configured'), findsOneWidget);
    expect(find.text('Demo mode'), findsNothing);
  });

  test('only active strategies are shown on the dashboard', () {
    final strategies = [
      const UserStrategy(
        id: 'active',
        symbol: 'RELIANCE',
        entryPrice: 1000,
        active: true,
      ),
      const UserStrategy(
        id: 'inactive',
        symbol: 'SBICARD',
        entryPrice: 800,
        active: false,
      ),
    ];

    expect(
      activeStrategiesForDashboard(strategies).map((strategy) => strategy.id),
      ['active'],
    );
  });

  group('default watchlist seeding', () {
    final templates = [
      for (final symbol in ['RELIANCE', 'JSWSTEEL', 'BHARTIARTL', 'SBICARD'])
        Instrument(
          symbol: symbol,
          name: symbol,
          entryPrice: 1000,
          spotPrice: 1000,
          lastUpdated: DateTime(2026, 10, 20),
        ),
    ];

    test('seeds all four defaults for a brand-new user', () {
      expect(
        defaultWatchlistItemsToSeed(templates, const [])
            .map((item) => item.symbol),
        ['RELIANCE', 'JSWSTEEL', 'BHARTIARTL', 'SBICARD'],
      );
    });

    test('resumes a partial seed by creating only missing symbols', () {
      final existing = [
        const UserStrategy(
          id: 'strategy-1',
          symbol: 'RELIANCE',
          entryPrice: 1000,
          active: true,
        ),
      ];

      expect(
        defaultWatchlistItemsToSeed(templates, existing)
            .map((item) => item.symbol),
        ['JSWSTEEL', 'BHARTIARTL', 'SBICARD'],
      );
    });

    test('does not re-create inactive defaults or seed custom-only profiles',
        () {
      final allDefaultsIncludingRemoved = [
        for (final symbol in ['RELIANCE', 'JSWSTEEL', 'BHARTIARTL', 'SBICARD'])
          UserStrategy(
            id: 'strategy-$symbol',
            symbol: symbol,
            entryPrice: 1000,
            active: symbol != 'RELIANCE',
          ),
      ];
      final customOnly = [
        const UserStrategy(
          id: 'strategy-custom',
          symbol: 'CUSTOM',
          entryPrice: 1000,
          active: true,
        ),
      ];

      expect(
        defaultWatchlistItemsToSeed(templates, allDefaultsIncludingRemoved),
        isEmpty,
      );
      expect(defaultWatchlistItemsToSeed(templates, customOnly), isEmpty);
    });
  });

  group('FOPlayer dashboard business outcomes', () {
    testWidgets(
        'does not show prototype fixtures when authenticated data fails',
        (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: DashboardScreen(
            apiClient: StrategyApiClient(
              auth: _UnusedFirebaseAuth(),
              baseUrl: 'http://invalid.example',
            ),
            enablePushNotifications: false,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Dashboard data unavailable'), findsOneWidget);
      expect(find.byKey(const Key('retry-dashboard-button')), findsOneWidget);
      expect(find.text('RELIANCE'), findsNothing);
      expect(find.text('Demo spot'), findsNothing);
      expect(
        find.text('Your watchlist is empty. Add a symbol to get started.'),
        findsNothing,
      );
    });

    testWidgets('shows all four configured instruments and demo-data warning',
        (tester) async {
      await tester.pumpWidget(const FOPlayerApp(prototypeMode: true));

      expect(find.text('RELIANCE'), findsOneWidget);
      expect(find.text('JSWSTEEL'), findsOneWidget);
      expect(find.text('BHARTIARTL'), findsOneWidget);
      expect(find.text('SBICARD'), findsOneWidget);
      expect(find.textContaining('DEMO DATA'), findsOneWidget);
      expect(
        find.textContaining('Alerts and trading actions are not enabled.'),
        findsOneWidget,
      );
    });

    testWidgets('labels both ±12% boundaries as breached', (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SingleChildScrollView(
              child: Column(
                children: [
                  InstrumentCard(
                    instrument: Instrument(
                      symbol: 'CAUTION',
                      name: 'Threshold fixture',
                      entryPrice: 100,
                      spotPrice: 108,
                      lastUpdated: DateTime(2026, 10, 20),
                    ),
                    onEditEntry: _noop,
                  ),
                  InstrumentCard(
                    instrument: Instrument(
                      symbol: 'UPPER-BREACH',
                      name: 'Upper boundary fixture',
                      entryPrice: 100,
                      spotPrice: 112,
                      lastUpdated: DateTime(2026, 10, 20),
                    ),
                    onEditEntry: _noop,
                  ),
                  InstrumentCard(
                    instrument: Instrument(
                      symbol: 'LOWER-BREACH',
                      name: 'Lower boundary fixture',
                      entryPrice: 100,
                      spotPrice: 88,
                      lastUpdated: DateTime(2026, 10, 20),
                    ),
                    onEditEntry: _noop,
                  ),
                ],
              ),
            ),
          ),
        ),
      );

      expect(find.text('CAUTION'), findsWidgets);
      expect(find.text('BREACHED'), findsNWidgets(2));
    });

    testWidgets('makes stale data explicit and suppresses movement display',
        (tester) async {
      await tester.pumpWidget(const FOPlayerApp(prototypeMode: true));

      expect(find.text('DATA STALE'), findsOneWidget);
      expect(
        find.text('Snapshot is stale. No actionable risk state is shown.'),
        findsOneWidget,
      );
      expect(find.text('Movement unavailable'), findsOneWidget);
    });

    testWidgets('entry edit recalculates boundaries for the selected ticker',
        (tester) async {
      await tester.pumpWidget(const FOPlayerApp(prototypeMode: true));
      final editButton = find.widgetWithText(TextButton, 'Edit entry').first;
      await tester.ensureVisible(editButton);
      await tester.pumpAndSettle();
      await tester.tap(editButton);
      await tester.pumpAndSettle();

      final entryField = find.byKey(const Key('entry-price-input'));
      expect(entryField, findsOneWidget);
      await tester.enterText(entryField, '1000');
      await tester.tap(find.byKey(const Key('save-entry-button')));
      await tester.pumpAndSettle();

      expect(find.text('₹1000.00'), findsOneWidget);
      expect(find.text('₹880.00'), findsOneWidget);
      expect(find.text('₹1120.00'), findsOneWidget);
    });

    test('ages out an old validated snapshot', () {
      final observedAt = DateTime.now().subtract(const Duration(minutes: 11));
      final instrument = Instrument(
        symbol: 'RELIANCE',
        name: 'Reliance Industries',
        entryPrice: 1000,
        spotPrice: 1080,
        lastUpdated: observedAt,
        fetchedAt: observedAt,
      );

      expect(instrument.isCurrentlyStale, isTrue);
    });

    test('uses the critical level at exactly 10% in either direction', () {
      for (final spot in [110.0, 90.0]) {
        final instrument = Instrument(
          symbol: 'TEST',
          name: 'Threshold fixture',
          entryPrice: 100,
          spotPrice: spot,
          lastUpdated: DateTime(2026, 10, 20),
        );
        expect(instrument.riskLevel, RiskLevel.critical);
      }
    });

    testWidgets('rejects non-positive entry values at the dialog boundary',
        (tester) async {
      await tester.pumpWidget(const FOPlayerApp(prototypeMode: true));
      final editButton = find.widgetWithText(TextButton, 'Edit entry').first;
      await tester.ensureVisible(editButton);
      await tester.pumpAndSettle();
      await tester.tap(editButton);
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const Key('entry-price-input')), '0');
      await tester.tap(find.byKey(const Key('save-entry-button')));
      await tester.pumpAndSettle();

      expect(find.text('Enter a valid positive entry price.'), findsOneWidget);
      expect(find.text('₹1400.00'), findsOneWidget);
    });

    testWidgets('adds a supported symbol with a positive entry price',
        (tester) async {
      await tester.pumpWidget(const FOPlayerApp(prototypeMode: true));
      final removeButton = find.byKey(const Key('remove-RELIANCE'));
      await tester.scrollUntilVisible(
        removeButton,
        250,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.pumpAndSettle();
      await tester.tap(removeButton);
      await tester.pumpAndSettle();

      await tester.drag(find.byType(ListView).first, const Offset(0, 1200));
      await tester.pumpAndSettle();
      final addButton = find.byKey(const Key('add-instrument-button'));
      expect(addButton, findsOneWidget);
      await tester.tap(addButton);
      await tester.pumpAndSettle();
      expect(find.text('RELIANCE'), findsWidgets);

      await tester.enterText(
        find.byKey(const Key('new-entry-price-input')),
        '1234.5',
      );
      await tester.tap(find.byKey(const Key('save-new-symbol-button')));
      await tester.pumpAndSettle();

      expect(find.text('RELIANCE'), findsWidgets);
      expect(find.textContaining('DEMO DATA'), findsOneWidget);
    });

    testWidgets('rejects invalid entry when adding a symbol', (tester) async {
      await tester.pumpWidget(const FOPlayerApp(prototypeMode: true));
      final removeButton = find.byKey(const Key('remove-RELIANCE'));
      await tester.scrollUntilVisible(
        removeButton,
        250,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.pumpAndSettle();
      await tester.tap(removeButton);
      await tester.pumpAndSettle();

      await tester.drag(find.byType(ListView).first, const Offset(0, 1200));
      await tester.pumpAndSettle();
      final addButton = find.byKey(const Key('add-instrument-button'));
      expect(addButton, findsOneWidget);
      await tester.tap(addButton);
      await tester.pumpAndSettle();

      await tester.enterText(
          find.byKey(const Key('new-entry-price-input')), '0');
      await tester.tap(find.byKey(const Key('save-new-symbol-button')));
      await tester.pumpAndSettle();

      // Invalid input must leave the add dialog open instead of creating a symbol.
      expect(find.text('Add watchlist symbol'), findsOneWidget);
      expect(find.byKey(const Key('new-entry-price-input')), findsOneWidget);
      expect(find.byKey(const Key('save-new-symbol-button')), findsOneWidget);
    });

    testWidgets('lets the user inspect a historical daily close',
        (tester) async {
      await tester.pumpWidget(
        const MaterialApp(
          home: Scaffold(
            body: PriceHistoryChart(values: [100, 110, 105]),
          ),
        ),
      );

      expect(find.text('Daily close trend'), findsOneWidget);
      expect(find.text('Tap chart to inspect a daily close'), findsOneWidget);
      await tester.tap(find.byKey(const Key('price-history-chart')));
      await tester.pump();

      expect(find.text('Point 2: ₹110.00'), findsOneWidget);
    });

    testWidgets('marks expired strategies and suppresses movement display',
        (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: InstrumentCard(
              instrument: Instrument(
                symbol: 'RELIANCE',
                name: 'Reliance Industries',
                entryPrice: 1000,
                spotPrice: 1120,
                lastUpdated: DateTime(2026, 10, 20),
                expiryDate: DateTime(2026, 10, 19),
              ),
              onEditEntry: _noop,
            ),
          ),
        ),
      );

      expect(find.text('EXPIRED'), findsOneWidget);
      expect(
        find.text('Strategy expired. No actionable risk state is shown.'),
        findsOneWidget,
      );
      expect(find.text('Movement unavailable'), findsOneWidget);
    });

    testWidgets('exposes the per-strategy notification mute control',
        (tester) async {
      var enabled = true;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: InstrumentCard(
              instrument: Instrument(
                symbol: 'RELIANCE',
                name: 'Reliance Industries',
                entryPrice: 1000,
                spotPrice: 1000,
                lastUpdated: DateTime.now(),
              ),
              onEditEntry: () {},
              onNotificationsChanged: (value) => enabled = value,
              isDemo: false,
            ),
          ),
        ),
      );

      expect(find.text('Risk notifications'), findsOneWidget);
      expect(find.text('Alerts are sent for this strategy'), findsOneWidget);
      await tester.tap(find.byKey(const Key('notifications-RELIANCE')));
      await tester.pump();

      expect(enabled, isFalse);
    });

    testWidgets('validates and saves custom risk thresholds', (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) => Scaffold(
              body: TextButton(
                onPressed: () => showDialog<StrategyThresholds>(
                  context: context,
                  builder: (_) => ThresholdsDialog(
                    instrument: Instrument(
                      symbol: 'RELIANCE',
                      name: 'Reliance Industries',
                      entryPrice: 1000,
                      spotPrice: 1000,
                      lastUpdated: DateTime(2026, 10, 20),
                    ),
                  ),
                ),
                child: const Text('Configure thresholds'),
              ),
            ),
          ),
        ),
      );

      await tester.tap(find.text('Configure thresholds'));
      await tester.pumpAndSettle();
      await tester.enterText(
          find.byKey(const Key('caution-threshold-input')), '10');
      await tester.enterText(
          find.byKey(const Key('critical-threshold-input')), '8');
      await tester.enterText(
          find.byKey(const Key('breached-threshold-input')), '12');
      await tester.tap(find.byKey(const Key('save-thresholds-button')));
      await tester.pump();

      expect(
        find.text('Use positive thresholds in increasing order, below 100%.'),
        findsOneWidget,
      );

      await tester.enterText(
          find.byKey(const Key('caution-threshold-input')), '5');
      await tester.enterText(
          find.byKey(const Key('critical-threshold-input')), '7');
      await tester.enterText(
          find.byKey(const Key('breached-threshold-input')), '9');
      await tester.tap(find.byKey(const Key('save-thresholds-button')));
      await tester.pumpAndSettle();

      expect(find.text('Save thresholds'), findsNothing);
      expect(find.text('Configure thresholds'), findsOneWidget);
    });

    testWidgets('shows expiry configuration on the instrument card',
        (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: InstrumentCard(
              instrument: Instrument(
                symbol: 'RELIANCE',
                name: 'Reliance Industries',
                entryPrice: 1000,
                spotPrice: 1000,
                lastUpdated: DateTime(2026, 10, 20),
                entryDate: DateTime(2026, 10, 15),
                expiryDate: DateTime(2026, 11, 26),
                thresholds: const StrategyThresholds(
                  cautionPercent: 5,
                  criticalPercent: 7,
                  breachedPercent: 9,
                ),
              ),
              onEditEntry: _noop,
              onEditEntryDate: _noop,
              onEditExpiry: _noop,
              onEditThresholds: _noop,
            ),
          ),
        ),
      );

      expect(find.text('Entry date'), findsOneWidget);
      expect(find.text('2026-10-15'), findsOneWidget);
      expect(find.text('Edit entry date'), findsOneWidget);
      expect(find.text('Risk thresholds'), findsNWidgets(2));
      expect(find.text('5.0% / 7.0% / 9.0%'), findsOneWidget);
      expect(find.text('Expiry date'), findsOneWidget);
      expect(find.text('2026-11-26'), findsOneWidget);
      expect(find.text('Edit expiry'), findsOneWidget);
    });

    testWidgets('does not display a placeholder as a live market price',
        (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: InstrumentCard(
              instrument: Instrument(
                symbol: 'RELIANCE',
                name: 'Reliance Industries',
                entryPrice: 1000,
                spotPrice: 1000,
                lastUpdated: DateTime.fromMillisecondsSinceEpoch(0),
                isStale: true,
                hasSpotPrice: false,
              ),
              onEditEntry: _noop,
              isDemo: false,
            ),
          ),
        ),
      );

      expect(find.text('Spot price'), findsOneWidget);
      expect(find.text('Unavailable'), findsOneWidget);
      expect(
        find.text(
          'No validated market snapshot is available. '
          'No actionable risk state is shown.',
        ),
        findsOneWidget,
      );
      expect(find.text('Demo spot'), findsNothing);
    });

    testWidgets('removes a symbol from the active watchlist', (tester) async {
      await tester.pumpWidget(const FOPlayerApp(prototypeMode: true));
      final removeButton = find.byKey(const Key('remove-RELIANCE'));
      await tester.scrollUntilVisible(
        removeButton,
        250,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.pumpAndSettle();
      await tester.tap(removeButton);
      await tester.pumpAndSettle();

      expect(find.text('RELIANCE'), findsNothing);
      expect(
        find.text('RELIANCE removed from this dashboard.'),
        findsOneWidget,
      );
    });
  });
}

void _noop() {}

class _UnusedFirebaseAuth implements FirebaseAuth {
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
