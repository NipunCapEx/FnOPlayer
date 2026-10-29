import 'dart:async';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:google_sign_in/google_sign_in.dart';
import 'alert_history.dart';
import 'notification_registration.dart';
import 'package:foplayer/strategy_api.dart';


Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  Object? initializationError;
  try {
    await Firebase.initializeApp();
  } catch (error) {
    initializationError = error;
  }
  runApp(FOPlayerApp(
    firebaseReady: initializationError == null,
    initializationError: initializationError?.toString(),
  ));
}

enum RiskLevel { normal, caution, critical, breached }

class Instrument {
  const Instrument({
    required this.symbol,
    required this.name,
    required this.entryPrice,
    required this.spotPrice,
    required this.lastUpdated,
    this.isStale = false,
    this.hasSpotPrice = true,
    this.dataSource,
    this.fetchedAt,
    this.entryDate,
    this.expiryDate,
    this.historicalCloses = const [],
    this.thresholds = const StrategyThresholds(),
    this.notificationsEnabled = true,
  });

  final String symbol;
  final String name;
  final double entryPrice;
  final double spotPrice;
  final DateTime lastUpdated;
  final bool isStale;
  final bool hasSpotPrice;
  final String? dataSource;
  final DateTime? fetchedAt;
  final DateTime? entryDate;
  final DateTime? expiryDate;
  final List<double> historicalCloses;
  final StrategyThresholds thresholds;
  final bool notificationsEnabled;

  bool get isExpired {
    final expiry = expiryDate;
    return expiry != null &&
        DateUtils.dateOnly(expiry).isBefore(
          DateUtils.dateOnly(DateTime.now()),
        );
  }

  bool get isCurrentlyStale {
    if (isStale || isExpired) return true;
    final fetched = fetchedAt;
    if (fetched == null) return false;
    const maxAge = Duration(minutes: 10);
    const maxFutureSkew = Duration(minutes: 1);
    final now = DateTime.now();
    final fetchAge = now.difference(fetched);
    final exchangeAge = now.difference(lastUpdated);
    return fetchAge > maxAge ||
        fetchAge < -maxFutureSkew ||
        exchangeAge > maxAge ||
        exchangeAge < -maxFutureSkew;
  }

  double get lowerBoundary =>
      entryPrice * (1 - thresholds.breachedPercent / 100);
  double get upperBoundary =>
      entryPrice * (1 + thresholds.breachedPercent / 100);
  double get movementPercent => (spotPrice - entryPrice) / entryPrice * 100;

  RiskLevel get riskLevel {
    if (isStale || isExpired) return RiskLevel.normal;
    // Use the entry-relative percentage for threshold comparisons to avoid
    // floating-point boundary rounding at exactly ±12%.
    if (movementPercent.abs() >= thresholds.breachedPercent) {
      return RiskLevel.breached;
    }
    if (movementPercent.abs() >= thresholds.criticalPercent) {
      return RiskLevel.critical;
    }
    if (movementPercent.abs() >= thresholds.cautionPercent) {
      return RiskLevel.caution;
    }
    return RiskLevel.normal;
  }

  Instrument copyWith({
    double? entryPrice,
    double? spotPrice,
    DateTime? lastUpdated,
    bool? isStale,
    bool? hasSpotPrice,
    String? dataSource,
    DateTime? fetchedAt,
    DateTime? entryDate,
    DateTime? expiryDate,
    List<double>? historicalCloses,
    StrategyThresholds? thresholds,
    bool? notificationsEnabled,
  }) =>
      Instrument(
        symbol: symbol,
        name: name,
        entryPrice: entryPrice ?? this.entryPrice,
        spotPrice: spotPrice ?? this.spotPrice,
        lastUpdated: lastUpdated ?? this.lastUpdated,
        isStale: isStale ?? this.isStale,
        hasSpotPrice: hasSpotPrice ?? this.hasSpotPrice,
        dataSource: dataSource ?? this.dataSource,
        fetchedAt: fetchedAt ?? this.fetchedAt,
        entryDate: entryDate ?? this.entryDate,
        expiryDate: expiryDate ?? this.expiryDate,
        historicalCloses: historicalCloses ?? this.historicalCloses,
        thresholds: thresholds ?? this.thresholds,
        notificationsEnabled: notificationsEnabled ?? this.notificationsEnabled,
      );
}

class FOPlayerApp extends StatelessWidget {
  const FOPlayerApp({
    super.key,
    this.firebaseReady = false,
    this.initializationError,
    this.prototypeMode = false,
  });

  final bool firebaseReady;
  final String? initializationError;
  final bool prototypeMode;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'FnO Players',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF175CD3)),
        useMaterial3: true,
        scaffoldBackgroundColor: const Color(0xFFF7F8FA),
      ),
      home: prototypeMode
          ? const DashboardScreen()
          : firebaseReady
              ? const AuthGate()
              : FirebaseSetupScreen(error: initializationError),
    );
  }
}

class AuthGate extends StatelessWidget {
  const AuthGate({super.key});

  Future<void> _signIn(BuildContext context) async {
    try {
      final googleUser = await GoogleSignIn().signIn();
      if (googleUser == null) return;
      final googleAuth = await googleUser.authentication;
      final credential = GoogleAuthProvider.credential(
        accessToken: googleAuth.accessToken,
        idToken: googleAuth.idToken,
      );
      await FirebaseAuth.instance.signInWithCredential(credential);
    } on FirebaseAuthException catch (error) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(error.message ?? 'Google sign-in failed.')),
        );
      }
    } catch (_) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
              content: Text(
                  'Unable to sign in with Google. Check Firebase OAuth setup.')),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<User?>(
      stream: FirebaseAuth.instance.authStateChanges(),
      builder: (context, snapshot) {
        if (snapshot.connectionState == ConnectionState.waiting) {
          return const Scaffold(
              body: Center(child: CircularProgressIndicator()));
        }
        final user = snapshot.data;
        if (user == null) {
          return GoogleLoginScreen(onSignIn: () => _signIn(context));
        }
        final apiClient = StrategyApiClient();
        if (!apiClient.isConfigured) {
          return const ApiSetupScreen();
        }
        return DashboardScreen(
          apiClient: apiClient,
          onSignOut: () => FirebaseAuth.instance.signOut(),
        );
      },
    );
  }
}

class GoogleLoginScreen extends StatelessWidget {
  const GoogleLoginScreen({super.key, required this.onSignIn});

  final VoidCallback onSignIn;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 420),
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Icon(Icons.show_chart, size: 64),
                  const SizedBox(height: 16),
                  Text('FnO Players',
                      textAlign: TextAlign.center,
                      style: Theme.of(context)
                          .textTheme
                          .headlineMedium
                          ?.copyWith(fontWeight: FontWeight.bold)),
                  const SizedBox(height: 8),
                  const Text(
                      'Sign in to access your personal hedging dashboard.',
                      textAlign: TextAlign.center),
                  const SizedBox(height: 24),
                  FilledButton.icon(
                    key: const Key('google-sign-in-button'),
                    onPressed: onSignIn,
                    icon: const Icon(Icons.login),
                    label: const Text('Continue with Google'),
                  ),
                  const SizedBox(height: 16),
                  const Text(
                      'Demo market values are illustrative and are not trading advice.',
                      textAlign: TextAlign.center,
                      style: TextStyle(fontSize: 12)),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class FirebaseSetupScreen extends StatelessWidget {
  const FirebaseSetupScreen({super.key, this.error});

  final String? error;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 480),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(Icons.cloud_off_outlined, size: 56),
                  const SizedBox(height: 16),
                  Text('Firebase setup required',
                      style: Theme.of(context).textTheme.headlineSmall),
                  const SizedBox(height: 8),
                  const Text(
                      'FnO Players needs its own Firebase Android app and Google sign-in configuration before you can sign in. Configure google-services.json and enable Google in Firebase Authentication.'),
                  if (error != null) ...[
                    const SizedBox(height: 12),
                    const Text(
                        'Initialization details are available in the app logs.',
                        style: TextStyle(fontSize: 12)),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class ApiSetupScreen extends StatelessWidget {
  const ApiSetupScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(Icons.settings_ethernet, size: 56),
                const SizedBox(height: 16),
                Text('Backend setup required',
                    style: Theme.of(context).textTheme.headlineSmall),
                const SizedBox(height: 8),
                const Text(
                  'Set FOPLAYER_API_BASE_URL to the deployed HTTPS backend URL when building the app. The authenticated watchlist is not stored locally as a fallback.',
                  textAlign: TextAlign.center,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

List<UserStrategy> activeStrategiesForDashboard(
  List<UserStrategy> strategies,
) =>
    strategies.where((strategy) => strategy.active).toList();

List<Instrument> defaultWatchlistItemsToSeed(
  List<Instrument> templates,
  List<UserStrategy> existingStrategies,
) {
  final templateSymbols = templates.map((item) => item.symbol).toSet();
  final existingSymbols =
      existingStrategies.map((strategy) => strategy.symbol).toSet();
  final hasExistingDefault = existingStrategies.any(
    (strategy) => templateSymbols.contains(strategy.symbol),
  );

  // A profile that already has only custom strategies is not a new user.
  // Inactive default records also count, so intentionally removed defaults
  // are not re-created on later dashboard loads.
  if (existingStrategies.isNotEmpty && !hasExistingDefault) {
    return const [];
  }

  return templates
      .where((template) => !existingSymbols.contains(template.symbol))
      .toList();
}

Instrument mapUserStrategyToInstrument(
  UserStrategy strategy,
  DashboardSnapshot? snapshot, {
  required DateTime now,
  String? name,
}) {
  final hasSnapshot = snapshot != null;
  final fresh = snapshot?.isFreshAt(now) ?? false;
  return Instrument(
    symbol: strategy.symbol,
    name: name ?? strategy.symbol,
    entryPrice: strategy.entryPrice,
    entryDate: strategy.entryDate,
    expiryDate: strategy.expiryDate,
    thresholds: strategy.thresholds,
    notificationsEnabled: strategy.notificationsEnabled,
    spotPrice: snapshot?.spotPrice ?? strategy.entryPrice,
    lastUpdated:
        snapshot?.exchangeTimestamp ?? DateTime.fromMillisecondsSinceEpoch(0),
    isStale: !fresh,
    hasSpotPrice: hasSnapshot,
    historicalCloses: snapshot?.historicalCloses ?? const [],
    dataSource: snapshot?.source,
    fetchedAt: snapshot?.fetchedAt,
  );
}

class DashboardScreen extends StatefulWidget {
  const DashboardScreen({
    super.key,
    this.onSignOut,
    this.apiClient,
    this.enablePushNotifications = true,
  });

  final VoidCallback? onSignOut;
  final StrategyApiClient? apiClient;
  final bool enablePushNotifications;

  @override
  State<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends State<DashboardScreen> {
  late List<Instrument> instruments;
  late List<Instrument> _defaultWatchlistTemplates;
  bool _hasLoadedPersistedWatchlist = false;
  bool _dashboardLoading = false;
  String? _dashboardError;
  Timer? _freshnessTimer;
  Timer? _snapshotRefreshTimer;
  NotificationRegistrationService? _notificationRegistration;

  @override
  void initState() {
    super.initState();
    // Explicitly labelled fixtures are used only in prototype mode.
    final now = DateTime(2026, 10, 20, 11, 0);
    _defaultWatchlistTemplates = [
      Instrument(
        symbol: 'RELIANCE',
        name: 'Reliance Industries',
        entryPrice: 1400,
        spotPrice: 1512,
        lastUpdated: now,
      ),
      Instrument(
        symbol: 'JSWSTEEL',
        name: 'JSW Steel',
        entryPrice: 1100,
        spotPrice: 1018,
        lastUpdated: now,
      ),
      Instrument(
        symbol: 'BHARTIARTL',
        name: 'Bharti Airtel',
        entryPrice: 1600,
        spotPrice: 1680,
        lastUpdated: now,
      ),
      Instrument(
        symbol: 'SBICARD',
        name: 'SBI Cards',
        entryPrice: 850,
        spotPrice: 850,
        lastUpdated: now,
        isStale: true,
      ),
    ];
    instruments = widget.apiClient == null
        ? List<Instrument>.of(_defaultWatchlistTemplates)
        : <Instrument>[];
    if (widget.apiClient != null) {
      if (!kIsWeb && widget.enablePushNotifications) {
        final messaging = FirebaseMessaging.instance;
        _notificationRegistration = NotificationRegistrationService(
          requestPermission: () async {
            final settings = await messaging.requestPermission(
              alert: true,
              badge: true,
              sound: true,
            );
            return settings.authorizationStatus ==
                    AuthorizationStatus.authorized ||
                settings.authorizationStatus == AuthorizationStatus.provisional;
          },
          getToken: messaging.getToken,
          tokenRefresh: messaging.onTokenRefresh,
          registerDeviceToken: widget.apiClient!.registerDeviceToken,
          onError: (error) =>
              debugPrint('FCM device registration failed: $error'),
        );
      }
      _freshnessTimer = Timer.periodic(
        const Duration(minutes: 1),
        (_) => _refreshSnapshotFreshness(),
      );
      // Re-fetch server-validated market data periodically; freshness checks
      // alone would only mark a snapshot stale without ever updating it.
      _snapshotRefreshTimer = Timer.periodic(
        const Duration(minutes: 5),
        (_) {
          if (mounted && !_dashboardLoading) {
            _loadPersistedWatchlist();
          }
        },
      );
      _loadPersistedWatchlist();
    }
  }

  @override
  void dispose() {
    _freshnessTimer?.cancel();
    _snapshotRefreshTimer?.cancel();
    unawaited(_notificationRegistration?.dispose());
    super.dispose();
  }

  void _refreshSnapshotFreshness() {
    if (!mounted || widget.apiClient == null) return;
    final refreshed = instruments
        .map((item) => item.copyWith(isStale: item.isCurrentlyStale))
        .toList();
    if (refreshed.asMap().entries.any(
          (entry) => entry.value.isStale != instruments[entry.key].isStale,
        )) {
      setState(() => instruments = refreshed);
    }
  }

  Future<void> _loadPersistedWatchlist() async {
    final apiClient = widget.apiClient;
    if (apiClient == null || _dashboardLoading) return;
    setState(() {
      _dashboardLoading = true;
      _dashboardError = null;
    });
    try {
      var dashboard = await apiClient.getDashboard();
      final existingStrategies =
          await apiClient.listStrategies(includeInactive: true);
      final missingDefaults = defaultWatchlistItemsToSeed(
        _defaultWatchlistTemplates,
        existingStrategies,
      );
      for (final item in missingDefaults) {
        try {
          await apiClient.createStrategy(
            symbol: item.symbol,
            entryPrice: item.entryPrice,
            entryDate: item.entryDate,
            expiryDate: item.expiryDate,
            thresholds: item.thresholds,
            notificationsEnabled: item.notificationsEnabled,
          );
        } catch (_) {
          // A concurrent client or a timed-out response may have saved the
          // strategy already. Only suppress the error when the server confirms
          // that this symbol now exists; otherwise keep the retryable error.
          final latestStrategies =
              await apiClient.listStrategies(includeInactive: true);
          if (!latestStrategies
              .any((strategy) => strategy.symbol == item.symbol)) {
            rethrow;
          }
        }
      }
      if (missingDefaults.isNotEmpty) {
        dashboard = await apiClient.getDashboard();
      }
      if (!mounted) return;
      final fixtures = {
        for (final item in _defaultWatchlistTemplates) item.symbol: item,
      };
      final now = DateTime.now();
      final activeStrategies =
          activeStrategiesForDashboard(dashboard.strategies);
      setState(() {
        _strategyIds
          ..clear()
          ..addEntries(activeStrategies.map(
            (item) => MapEntry(item.symbol, item.id),
          ));
        instruments = activeStrategies
            .map((item) => mapUserStrategyToInstrument(
                  item,
                  dashboard.snapshots[item.id],
                  now: now,
                  name: fixtures[item.symbol]?.name ??
                      _supportedSymbols[item.symbol] ??
                      item.symbol,
                ))
            .toList();
        _hasLoadedPersistedWatchlist = true;
        _dashboardLoading = false;
      });
      final notificationRegistration = _notificationRegistration;
      if (notificationRegistration != null) {
        unawaited(notificationRegistration.syncStrategies(activeStrategies));
      }
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _dashboardLoading = false;
        _dashboardError = error.toString();
        if (_hasLoadedPersistedWatchlist) {
          instruments =
              instruments.map((item) => item.copyWith(isStale: true)).toList();
        } else {
          // Never present local prototype fixtures as the signed-in user's data.
          instruments = [];
          _strategyIds.clear();
        }
      });
    }
  }

  final Map<String, String> _strategyIds = {};

  static const _supportedSymbols = <String, String>{
    'RELIANCE': 'Reliance Industries',
    'JSWSTEEL': 'JSW Steel',
    'BHARTIARTL': 'Bharti Airtel',
    'SBICARD': 'SBI Cards',
  };

  Future<void> _addInstrument() async {
    final available = _supportedSymbols.keys
        .where((symbol) => !instruments.any((item) => item.symbol == symbol))
        .toList();
    if (available.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('All supported demo symbols are already added.'),
        ),
      );
      return;
    }
    final result = await showDialog<Instrument>(
      context: context,
      builder: (dialogContext) => AddInstrumentDialog(
        symbols: available,
        names: _supportedSymbols,
      ),
    );
    if (result == null || !mounted) return;
    try {
      final saved = widget.apiClient == null
          ? null
          : await widget.apiClient!.createStrategy(
              symbol: result.symbol,
              entryPrice: result.entryPrice,
              entryDate: result.entryDate,
              expiryDate: result.expiryDate,
              thresholds: result.thresholds,
              notificationsEnabled: result.notificationsEnabled,
            );
      if (!mounted) return;
      setState(() {
        instruments = [...instruments, result];
        if (saved != null) _strategyIds[result.symbol] = saved.id;
      });
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Could not save symbol: $error')),
        );
      }
    }
  }

  Future<void> _removeInstrument(Instrument instrument) async {
    try {
      final id = _strategyIds[instrument.symbol];
      if (widget.apiClient != null && id != null) {
        await widget.apiClient!.updateStrategy(id, active: false);
      }
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Could not remove symbol: $error')),
        );
      }
      return;
    }
    if (!mounted) return;
    setState(() {
      instruments = instruments
          .where((item) => item.symbol != instrument.symbol)
          .toList();
    });
    _strategyIds.remove(instrument.symbol);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text('${instrument.symbol} removed from this dashboard.'),
      ),
    );
  }

  Future<void> _setNotificationsEnabled(
    Instrument instrument,
    bool enabled,
  ) async {
    final id = _strategyIds[instrument.symbol];
    try {
      if (widget.apiClient != null && id != null) {
        await widget.apiClient!.updateStrategy(
          id,
          notificationsEnabled: enabled,
        );
      }
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
              content: Text('Could not save notification preference: $error')),
        );
      }
      return;
    }
    if (!mounted) return;
    setState(() {
      instruments = [
        for (final item in instruments)
          if (item.symbol == instrument.symbol)
            item.copyWith(notificationsEnabled: enabled)
          else
            item,
      ];
    });
  }

  Future<void> _editThresholds(Instrument instrument) async {
    final thresholds = await showDialog<StrategyThresholds>(
      context: context,
      builder: (dialogContext) => ThresholdsDialog(instrument: instrument),
    );
    if (thresholds == null || !mounted) return;
    try {
      final id = _strategyIds[instrument.symbol];
      if (widget.apiClient != null && id != null) {
        await widget.apiClient!.updateStrategy(id, thresholds: thresholds);
      }
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Could not save risk thresholds: $error')),
        );
      }
      return;
    }
    if (!mounted) return;
    setState(() {
      instruments = [
        for (final item in instruments)
          if (item.symbol == instrument.symbol)
            item.copyWith(thresholds: thresholds)
          else
            item,
      ];
    });
  }

  Future<void> _editEntryDate(Instrument instrument) async {
    final newDate = await showDialog<DateTime>(
      context: context,
      builder: (dialogContext) => EntryDateDialog(instrument: instrument),
    );
    if (newDate == null || !mounted) return;
    try {
      final id = _strategyIds[instrument.symbol];
      if (widget.apiClient != null && id != null) {
        await widget.apiClient!.updateStrategy(id, entryDate: newDate);
      }
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Could not save entry date: $error')),
        );
      }
      return;
    }
    if (!mounted) return;
    setState(() {
      instruments = [
        for (final item in instruments)
          if (item.symbol == instrument.symbol)
            item.copyWith(entryDate: newDate)
          else
            item,
      ];
    });
  }

  Future<void> _editExpiry(Instrument instrument) async {
    final newExpiry = await showDialog<DateTime>(
      context: context,
      builder: (dialogContext) => ExpiryDateDialog(instrument: instrument),
    );
    if (newExpiry == null || !mounted) return;
    try {
      final id = _strategyIds[instrument.symbol];
      if (widget.apiClient != null && id != null) {
        await widget.apiClient!.updateStrategy(id, expiryDate: newExpiry);
      }
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Could not save expiry date: $error')),
        );
      }
      return;
    }
    if (!mounted) return;
    setState(() {
      instruments = [
        for (final item in instruments)
          if (item.symbol == instrument.symbol)
            item.copyWith(expiryDate: newExpiry)
          else
            item,
      ];
    });
  }

  Future<void> _editEntry(Instrument instrument) async {
    final newEntry = await showDialog<double>(
      context: context,
      builder: (dialogContext) => EntryPriceDialog(instrument: instrument),
    );
    if (newEntry == null || !mounted) return;
    try {
      final id = _strategyIds[instrument.symbol];
      if (widget.apiClient != null && id != null) {
        await widget.apiClient!.updateStrategy(id, entryPrice: newEntry);
      }
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Could not save entry price: $error')),
        );
      }
      return;
    }
    if (!mounted) return;
    setState(() {
      instruments = [
        for (final item in instruments)
          if (item.symbol == instrument.symbol)
            item.copyWith(entryPrice: newEntry)
          else
            item,
      ];
    });
  }

  @override
  Widget build(BuildContext context) {
    final activeCount = instruments.where((i) => !i.isCurrentlyStale).length;
    final breachedCount = instruments
        .where((i) => !i.isCurrentlyStale && i.riskLevel == RiskLevel.breached)
        .length;

    return Scaffold(
      appBar: AppBar(
        title: const Text('FnO Players'),
        actions: [
          if (widget.apiClient != null)
            IconButton(
              key: const Key('refresh-dashboard-button'),
              tooltip: 'Refresh market snapshots',
              onPressed: _dashboardLoading ? null : _loadPersistedWatchlist,
              icon: const Icon(Icons.refresh),
            ),
          if (widget.apiClient != null)
            IconButton(
              key: const Key('open-alert-history-button'),
              tooltip: 'Alert history',
              onPressed: () {
                Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) => AlertHistoryScreen(
                      loadAlerts: widget.apiClient!.listAlerts,
                    ),
                  ),
                );
              },
              icon: const Icon(Icons.notifications_outlined),
            ),
          if (widget.onSignOut != null)
            IconButton(
              tooltip: 'Sign out',
              onPressed: widget.onSignOut,
              icon: const Icon(Icons.logout),
            ),
          Padding(
            padding: const EdgeInsets.only(right: 16),
            child: Center(
              child: Chip(
                avatar: Icon(
                  widget.apiClient == null
                      ? Icons.science_outlined
                      : Icons.cloud_done_outlined,
                  size: 18,
                ),
                label: Text(
                  widget.apiClient == null ? 'Demo mode' : 'API configured',
                ),
              ),
            ),
          ),
        ],
      ),
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 1200),
            child: ListView(
              padding: const EdgeInsets.all(20),
              children: [
                Text(
                  'Hedging risk dashboard',
                  style: Theme.of(context).textTheme.headlineMedium?.copyWith(
                        fontWeight: FontWeight.w700,
                      ),
                ),
                const SizedBox(height: 8),
                Text(
                  'Monitor entry-relative movement and structural boundaries.',
                  style: Theme.of(context).textTheme.bodyLarge,
                ),
                const SizedBox(height: 16),
                if (widget.apiClient == null)
                  const Card(
                    child: Padding(
                      padding: EdgeInsets.all(14),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Icon(Icons.info_outline),
                          SizedBox(width: 10),
                          Expanded(
                            child: Text(
                              'DEMO DATA — prices are illustrative fixtures, not live '
                              'market data. Alerts and trading actions are not enabled.',
                            ),
                          ),
                        ],
                      ),
                    ),
                  )
                else if (_dashboardLoading)
                  const Card(
                    child: Padding(
                      padding: EdgeInsets.all(14),
                      child: Row(
                        children: [
                          SizedBox(
                            width: 20,
                            height: 20,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          ),
                          SizedBox(width: 12),
                          Expanded(
                            child: Text(
                              'Loading your saved watchlist and validated market snapshots.',
                            ),
                          ),
                        ],
                      ),
                    ),
                  )
                else if (_dashboardError != null)
                  Card(
                    child: Padding(
                      padding: const EdgeInsets.all(14),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text(
                            'Dashboard data unavailable',
                            style: TextStyle(fontWeight: FontWeight.bold),
                          ),
                          const SizedBox(height: 6),
                          Text(
                            'Could not refresh the authenticated dashboard: $_dashboardError',
                          ),
                          Align(
                            alignment: Alignment.centerRight,
                            child: TextButton.icon(
                              key: const Key('retry-dashboard-button'),
                              onPressed: _loadPersistedWatchlist,
                              icon: const Icon(Icons.refresh),
                              label: const Text('Retry'),
                            ),
                          ),
                        ],
                      ),
                    ),
                  )
                else
                  const Card(
                    child: Padding(
                      padding: EdgeInsets.all(14),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Icon(Icons.verified_outlined),
                          SizedBox(width: 10),
                          Expanded(
                            child: Text(
                              'Market prices are shown only when a validated backend snapshot is available. '
                              'Missing or older-than-10-minute snapshots are marked stale. This app does not place trades.',
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                const SizedBox(height: 16),
                Wrap(
                  spacing: 12,
                  runSpacing: 12,
                  children: [
                    _SummaryTile(
                      label: 'Tracked instruments',
                      value: '${instruments.length}',
                      icon: Icons.show_chart,
                    ),
                    _SummaryTile(
                      label: widget.apiClient == null
                          ? 'Valid demo snapshots'
                          : 'Fresh market snapshots',
                      value: '$activeCount',
                      icon: Icons.verified_outlined,
                    ),
                    _SummaryTile(
                      label: 'Boundary breaches',
                      value: '$breachedCount',
                      icon: Icons.warning_amber_rounded,
                    ),
                  ],
                ),
                const SizedBox(height: 20),
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        'Your watchlist',
                        style: Theme.of(context).textTheme.titleLarge,
                      ),
                    ),
                    FilledButton.icon(
                      key: const Key('add-instrument-button'),
                      onPressed: _addInstrument,
                      icon: const Icon(Icons.add),
                      label: const Text('Add symbol'),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                if (instruments.isEmpty &&
                    !_dashboardLoading &&
                    _dashboardError == null)
                  const Card(
                    child: Padding(
                      padding: EdgeInsets.all(20),
                      child: Text(
                        'Your watchlist is empty. Add a symbol to get started.',
                      ),
                    ),
                  ),
                LayoutBuilder(
                  builder: (context, constraints) {
                    final columns = constraints.maxWidth >= 850
                        ? 2
                        : constraints.maxWidth >= 560
                            ? 2
                            : 1;
                    final cardWidth =
                        (constraints.maxWidth - (columns - 1) * 14) / columns;
                    return Wrap(
                      spacing: 14,
                      runSpacing: 14,
                      children: [
                        for (final instrument in instruments)
                          SizedBox(
                            width: cardWidth,
                            child: InstrumentCard(
                              instrument: instrument,
                              onEditEntry: () => _editEntry(instrument),
                              onEditEntryDate: () => _editEntryDate(instrument),
                              onEditExpiry: () => _editExpiry(instrument),
                              onEditThresholds: () =>
                                  _editThresholds(instrument),
                              onNotificationsChanged: widget.apiClient == null
                                  ? null
                                  : (enabled) => _setNotificationsEnabled(
                                      instrument, enabled),
                              onRemove: () => _removeInstrument(instrument),
                              isDemo: widget.apiClient == null,
                            ),
                          ),
                      ],
                    );
                  },
                ),
                const SizedBox(height: 24),
                Text(
                  'Default risk levels (customizable per strategy)',
                  style: Theme.of(context).textTheme.titleLarge,
                ),
                const SizedBox(height: 8),
                const Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    _LegendChip(
                      label: '±8% Caution',
                      level: RiskLevel.caution,
                    ),
                    _LegendChip(
                      label: '±10% Critical',
                      level: RiskLevel.critical,
                    ),
                    _LegendChip(
                      label: '±12% Breached',
                      level: RiskLevel.breached,
                    ),
                  ],
                ),
                const SizedBox(height: 20),
                Text(
                  'Market snapshots refresh every five minutes while this dashboard is open. '
                  'Background alerts depend on the backend worker and configured notification channels.',
                  style: Theme.of(context).textTheme.bodyMedium,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class AddInstrumentDialog extends StatefulWidget {
  const AddInstrumentDialog({
    required this.symbols,
    required this.names,
    super.key,
  });

  final List<String> symbols;
  final Map<String, String> names;

  @override
  State<AddInstrumentDialog> createState() => _AddInstrumentDialogState();
}

class _AddInstrumentDialogState extends State<AddInstrumentDialog> {
  late String symbol;
  late final TextEditingController entryController;
  DateTime? entryDate;
  DateTime? expiryDate;

  @override
  void initState() {
    super.initState();
    symbol = widget.symbols.first;
    entryController = TextEditingController();
  }

  @override
  void dispose() {
    entryController.dispose();
    super.dispose();
  }

  Future<void> _selectEntryDate() async {
    final today = DateUtils.dateOnly(DateTime.now());
    final selected = await showDatePicker(
      context: context,
      initialDate: entryDate ?? today,
      firstDate: today.subtract(const Duration(days: 365 * 10)),
      lastDate: today,
    );
    if (selected != null && mounted) setState(() => entryDate = selected);
  }

  Future<void> _selectExpiry() async {
    final today = DateUtils.dateOnly(DateTime.now());
    final selected = await showDatePicker(
      context: context,
      initialDate: expiryDate ?? today.add(const Duration(days: 30)),
      firstDate: today,
      lastDate: today.add(const Duration(days: 365 * 3)),
    );
    if (selected != null && mounted) setState(() => expiryDate = selected);
  }

  void _save() {
    final entry = double.tryParse(entryController.text.trim());
    if (entry == null || !entry.isFinite || entry <= 0) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Enter a valid positive entry price.')),
      );
      return;
    }
    final now = DateTime.now();
    Navigator.of(context).pop(
      Instrument(
        symbol: symbol,
        name: widget.names[symbol]!,
        entryPrice: entry,
        // Until a live provider is configured, do not fabricate a market quote.
        spotPrice: entry,
        lastUpdated: now,
        isStale: true,
        entryDate: entryDate,
        expiryDate: expiryDate,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Add watchlist symbol'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          DropdownButtonFormField<String>(
            key: const Key('new-symbol-dropdown'),
            initialValue: symbol,
            decoration: const InputDecoration(labelText: 'Symbol'),
            items: [
              for (final item in widget.symbols)
                DropdownMenuItem(value: item, child: Text(item)),
            ],
            onChanged: (value) {
              if (value != null) setState(() => symbol = value);
            },
          ),
          const SizedBox(height: 12),
          OutlinedButton.icon(
            key: const Key('new-entry-date-button'),
            onPressed: _selectEntryDate,
            icon: const Icon(Icons.event_available),
            label: Text(entryDate == null
                ? 'Set entry date (optional)'
                : 'Entry date: ${_formatDateOnly(entryDate!)}'),
          ),
          const SizedBox(height: 12),
          OutlinedButton.icon(
            key: const Key('new-expiry-date-button'),
            onPressed: _selectExpiry,
            icon: const Icon(Icons.event),
            label: Text(expiryDate == null
                ? 'Set expiry date (optional)'
                : 'Expiry: ${_formatDateOnly(expiryDate!)}'),
          ),
          const SizedBox(height: 12),
          TextField(
            key: const Key('new-entry-price-input'),
            controller: entryController,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: const InputDecoration(
              labelText: 'Entry price (₹)',
              hintText: 'Enter your entry price',
            ),
          ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(
          key: const Key('save-new-symbol-button'),
          onPressed: _save,
          child: const Text('Add symbol'),
        ),
      ],
    );
  }
}

class ThresholdsDialog extends StatefulWidget {
  const ThresholdsDialog({required this.instrument, super.key});

  final Instrument instrument;

  @override
  State<ThresholdsDialog> createState() => _ThresholdsDialogState();
}

class _ThresholdsDialogState extends State<ThresholdsDialog> {
  late final TextEditingController cautionController;
  late final TextEditingController criticalController;
  late final TextEditingController breachedController;
  String? error;

  @override
  void initState() {
    super.initState();
    cautionController = TextEditingController(
      text: widget.instrument.thresholds.cautionPercent.toString(),
    );
    criticalController = TextEditingController(
      text: widget.instrument.thresholds.criticalPercent.toString(),
    );
    breachedController = TextEditingController(
      text: widget.instrument.thresholds.breachedPercent.toString(),
    );
  }

  @override
  void dispose() {
    cautionController.dispose();
    criticalController.dispose();
    breachedController.dispose();
    super.dispose();
  }

  void _save() {
    final caution = double.tryParse(cautionController.text.trim());
    final critical = double.tryParse(criticalController.text.trim());
    final breached = double.tryParse(breachedController.text.trim());
    final thresholds = caution == null || critical == null || breached == null
        ? null
        : StrategyThresholds(
            cautionPercent: caution,
            criticalPercent: critical,
            breachedPercent: breached,
          );
    if (thresholds == null || !thresholds.isValid) {
      setState(() {
        error = 'Use positive thresholds in increasing order, below 100%.';
      });
      return;
    }
    Navigator.pop(context, thresholds);
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text('Risk thresholds · ${widget.instrument.symbol}'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          TextField(
            key: const Key('caution-threshold-input'),
            controller: cautionController,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: const InputDecoration(labelText: 'Caution (%)'),
          ),
          TextField(
            key: const Key('critical-threshold-input'),
            controller: criticalController,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: const InputDecoration(labelText: 'Critical (%)'),
          ),
          TextField(
            key: const Key('breached-threshold-input'),
            controller: breachedController,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: const InputDecoration(labelText: 'Breach (%)'),
          ),
          if (error != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(error!, style: const TextStyle(color: Colors.red)),
            ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        FilledButton(
          key: const Key('save-thresholds-button'),
          onPressed: _save,
          child: const Text('Save thresholds'),
        ),
      ],
    );
  }
}

class EntryDateDialog extends StatefulWidget {
  const EntryDateDialog({required this.instrument, super.key});

  final Instrument instrument;

  @override
  State<EntryDateDialog> createState() => _EntryDateDialogState();
}

class _EntryDateDialogState extends State<EntryDateDialog> {
  DateTime? selectedDate;

  @override
  void initState() {
    super.initState();
    selectedDate = widget.instrument.entryDate;
  }

  Future<void> _selectDate() async {
    final today = DateUtils.dateOnly(DateTime.now());
    final selected = await showDatePicker(
      context: context,
      initialDate: selectedDate != null && !selectedDate!.isAfter(today)
          ? selectedDate!
          : today,
      firstDate: today.subtract(const Duration(days: 365 * 10)),
      lastDate: today,
    );
    if (selected != null && mounted) setState(() => selectedDate = selected);
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text('Edit ${widget.instrument.symbol} entry date'),
      content: OutlinedButton.icon(
        key: const Key('select-entry-date-button'),
        onPressed: _selectDate,
        icon: const Icon(Icons.event_available),
        label: Text(selectedDate == null
            ? 'Choose entry date'
            : _formatDateOnly(selectedDate!)),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        FilledButton(
          key: const Key('save-entry-date-button'),
          onPressed: selectedDate == null
              ? null
              : () => Navigator.pop(context, selectedDate),
          child: const Text('Save entry date'),
        ),
      ],
    );
  }
}

class ExpiryDateDialog extends StatefulWidget {
  const ExpiryDateDialog({required this.instrument, super.key});

  final Instrument instrument;

  @override
  State<ExpiryDateDialog> createState() => _ExpiryDateDialogState();
}

class _ExpiryDateDialogState extends State<ExpiryDateDialog> {
  DateTime? selectedDate;

  @override
  void initState() {
    super.initState();
    selectedDate = widget.instrument.expiryDate;
  }

  Future<void> _selectDate() async {
    final today = DateUtils.dateOnly(DateTime.now());
    final selected = await showDatePicker(
      context: context,
      initialDate: selectedDate != null && !selectedDate!.isBefore(today)
          ? selectedDate!
          : today.add(const Duration(days: 30)),
      firstDate: today,
      lastDate: today.add(const Duration(days: 365 * 3)),
    );
    if (selected != null && mounted) setState(() => selectedDate = selected);
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text('Edit ${widget.instrument.symbol} expiry'),
      content: OutlinedButton.icon(
        key: const Key('select-expiry-date-button'),
        onPressed: _selectDate,
        icon: const Icon(Icons.event),
        label: Text(selectedDate == null
            ? 'Choose expiry date'
            : _formatDateOnly(selectedDate!)),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        FilledButton(
          key: const Key('save-expiry-button'),
          onPressed: selectedDate == null
              ? null
              : () => Navigator.pop(context, selectedDate),
          child: const Text('Save expiry'),
        ),
      ],
    );
  }
}

class EntryPriceDialog extends StatefulWidget {
  const EntryPriceDialog({required this.instrument, super.key});

  final Instrument instrument;

  @override
  State<EntryPriceDialog> createState() => _EntryPriceDialogState();
}

class _EntryPriceDialogState extends State<EntryPriceDialog> {
  late final TextEditingController controller;

  @override
  void initState() {
    super.initState();
    controller = TextEditingController(
      text: widget.instrument.entryPrice.toStringAsFixed(2),
    );
  }

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text('Edit ${widget.instrument.symbol} entry'),
      content: TextField(
        key: const Key('entry-price-input'),
        controller: controller,
        keyboardType: const TextInputType.numberWithOptions(decimal: true),
        decoration: const InputDecoration(
          labelText: 'Entry price (₹)',
          hintText: 'Enter a positive price',
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        FilledButton(
          key: const Key('save-entry-button'),
          onPressed: () {
            final value = double.tryParse(controller.text.trim());
            if (value == null || !value.isFinite || value <= 0) {
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(
                  content: Text('Enter a valid positive entry price.'),
                ),
              );
              return;
            }
            Navigator.pop(context, value);
          },
          child: const Text('Save entry'),
        ),
      ],
    );
  }
}

class _SummaryTile extends StatelessWidget {
  const _SummaryTile({
    required this.label,
    required this.value,
    required this.icon,
  });

  final String label;
  final String value;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 220,
      child: Card(
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Row(
            children: [
              Icon(icon, size: 28),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(label, style: Theme.of(context).textTheme.bodySmall),
                    Text(
                      value,
                      style: Theme.of(context).textTheme.headlineSmall,
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class InstrumentCard extends StatelessWidget {
  const InstrumentCard({
    required this.instrument,
    required this.onEditEntry,
    this.onRemove,
    this.onEditEntryDate,
    this.onEditExpiry,
    this.onEditThresholds,
    this.onNotificationsChanged,
    this.isDemo = true,
    super.key,
  });

  final Instrument instrument;
  final VoidCallback onEditEntry;
  final VoidCallback? onRemove;
  final VoidCallback? onEditEntryDate;
  final VoidCallback? onEditExpiry;
  final VoidCallback? onEditThresholds;
  final ValueChanged<bool>? onNotificationsChanged;
  final bool isDemo;

  @override
  Widget build(BuildContext context) {
    final level = instrument.riskLevel;
    final snapshotTime = instrument.lastUpdated.toString().substring(0, 16);
    final levelLabel = instrument.isExpired
        ? 'EXPIRED'
        : instrument.isCurrentlyStale
            ? 'DATA STALE'
            : switch (level) {
                RiskLevel.normal => 'NORMAL',
                RiskLevel.caution => 'CAUTION',
                RiskLevel.critical => 'CRITICAL',
                RiskLevel.breached => 'BREACHED',
              };
    final color = instrument.isCurrentlyStale
        ? Colors.blueGrey
        : switch (level) {
            RiskLevel.normal => Colors.green.shade700,
            RiskLevel.caution => Colors.orange.shade800,
            RiskLevel.critical => Colors.deepOrange.shade800,
            RiskLevel.breached => Colors.red.shade800,
          };

    return Card(
      clipBehavior: Clip.antiAlias,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        instrument.symbol,
                        style: Theme.of(context).textTheme.titleLarge?.copyWith(
                              fontWeight: FontWeight.bold,
                            ),
                      ),
                      Text(instrument.name),
                    ],
                  ),
                ),
                Container(
                  key: Key('risk-${instrument.symbol}'),
                  padding: const EdgeInsets.symmetric(
                    horizontal: 10,
                    vertical: 6,
                  ),
                  decoration: BoxDecoration(
                    color: color.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(20),
                  ),
                  child: Text(
                    levelLabel,
                    style: TextStyle(
                      color: color,
                      fontWeight: FontWeight.w700,
                      fontSize: 12,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 18),
            Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        isDemo
                            ? 'Demo spot'
                            : instrument.hasSpotPrice
                                ? instrument.isCurrentlyStale
                                    ? 'Last observed spot'
                                    : 'Spot'
                                : 'Spot price',
                      ),
                      Text(
                        instrument.hasSpotPrice
                            ? '₹${instrument.spotPrice.toStringAsFixed(2)}'
                            : 'Unavailable',
                        style: Theme.of(context).textTheme.headlineSmall,
                      ),
                    ],
                  ),
                ),
                Text(
                  instrument.isCurrentlyStale
                      ? 'Movement unavailable'
                      : '${instrument.movementPercent >= 0 ? '+' : ''}'
                          '${instrument.movementPercent.toStringAsFixed(2)}%',
                  style: TextStyle(
                    color:
                        instrument.isCurrentlyStale ? Colors.blueGrey : color,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ],
            ),
            const Divider(height: 28),
            if (onNotificationsChanged != null)
              SwitchListTile.adaptive(
                key: Key('notifications-${instrument.symbol}'),
                contentPadding: EdgeInsets.zero,
                title: const Text('Risk notifications'),
                subtitle: Text(instrument.notificationsEnabled
                    ? 'Alerts are sent for this strategy'
                    : 'Alerts are saved but notifications are muted'),
                value: instrument.notificationsEnabled,
                onChanged: onNotificationsChanged,
              ),
            _PriceRow(label: 'Entry', value: instrument.entryPrice),
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 3),
              child: Row(
                children: [
                  const Expanded(child: Text('Risk thresholds')),
                  Text(
                    '${instrument.thresholds.cautionPercent}% / '
                    '${instrument.thresholds.criticalPercent}% / '
                    '${instrument.thresholds.breachedPercent}%',
                  ),
                ],
              ),
            ),
            if (instrument.historicalCloses.length >= 2)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 8),
                child: PriceHistoryChart(values: instrument.historicalCloses),
              ),
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 3),
              child: Row(
                children: [
                  const Expanded(child: Text('Entry date')),
                  Text(instrument.entryDate == null
                      ? 'Not set'
                      : _formatDateOnly(instrument.entryDate!)),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 3),
              child: Row(
                children: [
                  const Expanded(child: Text('Expiry date')),
                  Text(instrument.expiryDate == null
                      ? 'Not set'
                      : _formatDateOnly(instrument.expiryDate!)),
                ],
              ),
            ),
            _PriceRow(
              label: 'Lower boundary (−12%)',
              value: instrument.lowerBoundary,
            ),
            _PriceRow(
              label: 'Upper boundary (+12%)',
              value: instrument.upperBoundary,
            ),
            const SizedBox(height: 10),
            if (instrument.isCurrentlyStale)
              Text(
                instrument.isExpired
                    ? 'Strategy expired. No actionable risk state is shown.'
                    : isDemo
                        ? 'Snapshot is stale. No actionable risk state is shown.'
                        : instrument.hasSpotPrice
                            ? 'Snapshot is stale. Last observed at $snapshotTime from ${instrument.dataSource ?? 'unknown'}. No actionable risk state is shown.'
                            : 'No validated market snapshot is available. No actionable risk state is shown.',
                key: const Key('stale-message'),
              )
            else
              Text(
                isDemo
                    ? 'Snapshot time: $snapshotTime'
                    : 'Source: ${instrument.dataSource ?? 'unknown'} · Exchange time: $snapshotTime',
                style: Theme.of(context).textTheme.bodySmall,
              ),
            Wrap(
              alignment: WrapAlignment.end,
              spacing: 8,
              runSpacing: 4,
              children: [
                if (onRemove != null)
                  IconButton(
                    key: Key('remove-${instrument.symbol}'),
                    tooltip: 'Remove ${instrument.symbol}',
                    onPressed: onRemove,
                    icon: const Icon(Icons.remove_circle_outline),
                  ),
                if (onEditEntryDate != null)
                  TextButton.icon(
                    onPressed: onEditEntryDate,
                    icon: const Icon(Icons.event_available, size: 18),
                    label: const Text('Edit entry date'),
                  ),
                if (onEditThresholds != null)
                  TextButton.icon(
                    onPressed: onEditThresholds,
                    icon: const Icon(Icons.tune, size: 18),
                    label: const Text('Risk thresholds'),
                  ),
                if (onEditExpiry != null)
                  TextButton.icon(
                    onPressed: onEditExpiry,
                    icon: const Icon(Icons.event_outlined, size: 18),
                    label: const Text('Edit expiry'),
                  ),
                TextButton.icon(
                  onPressed: onEditEntry,
                  icon: const Icon(Icons.edit_outlined, size: 18),
                  label: const Text('Edit entry'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class PriceHistoryChart extends StatefulWidget {
  const PriceHistoryChart({required this.values, super.key});

  final List<double> values;

  @override
  State<PriceHistoryChart> createState() => _PriceHistoryChartState();
}

class _PriceHistoryChartState extends State<PriceHistoryChart> {
  int? selectedIndex;

  @override
  Widget build(BuildContext context) {
    final values = widget.values.length > 30
        ? widget.values.skip(widget.values.length - 30).toList()
        : widget.values;
    final index = selectedIndex?.clamp(0, values.length - 1).toInt();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text('Daily close trend'),
        const SizedBox(height: 4),
        SizedBox(
          height: 90,
          width: double.infinity,
          child: LayoutBuilder(
            builder: (context, constraints) => GestureDetector(
              key: const Key('price-history-chart'),
              behavior: HitTestBehavior.opaque,
              onTapDown: (details) {
                if (values.length < 2 || constraints.maxWidth <= 0) return;
                final ratio = (details.localPosition.dx / constraints.maxWidth)
                    .clamp(0.0, 1.0);
                setState(() {
                  selectedIndex = (ratio * (values.length - 1)).round();
                });
              },
              child: CustomPaint(
                size: Size(constraints.maxWidth, 90),
                painter: _PriceHistoryPainter(
                  values: values,
                  selectedIndex: index,
                ),
              ),
            ),
          ),
        ),
        Text(
          index == null
              ? 'Tap chart to inspect a daily close'
              : 'Point ${index + 1}: ₹${values[index].toStringAsFixed(2)}',
        ),
      ],
    );
  }
}

class _PriceHistoryPainter extends CustomPainter {
  const _PriceHistoryPainter(
      {required this.values, required this.selectedIndex});

  final List<double> values;
  final int? selectedIndex;

  @override
  void paint(Canvas canvas, Size size) {
    if (values.length < 2 || size.width <= 0 || size.height <= 0) return;
    final minimum = values.reduce((a, b) => a < b ? a : b);
    final maximum = values.reduce((a, b) => a > b ? a : b);
    final range = maximum - minimum;
    final points = <Offset>[
      for (var i = 0; i < values.length; i++)
        Offset(
          i * size.width / (values.length - 1),
          size.height -
              8 -
              (range == 0 ? 0.5 : (values[i] - minimum) / range) *
                  (size.height - 16),
        ),
    ];
    final path = Path()..moveTo(points.first.dx, points.first.dy);
    for (final point in points.skip(1)) {
      path.lineTo(point.dx, point.dy);
    }
    canvas.drawPath(
      path,
      Paint()
        ..color = Colors.teal
        ..strokeWidth = 2
        ..strokeCap = StrokeCap.round
        ..style = PaintingStyle.stroke,
    );
    final selected = selectedIndex;
    if (selected != null && selected >= 0 && selected < points.length) {
      canvas.drawCircle(
        points[selected],
        4,
        Paint()..color = Colors.orange,
      );
    }
  }

  @override
  bool shouldRepaint(covariant _PriceHistoryPainter oldDelegate) =>
      oldDelegate.values != values ||
      oldDelegate.selectedIndex != selectedIndex;
}

class _PriceRow extends StatelessWidget {
  const _PriceRow({required this.label, required this.value});

  final String label;
  final double value;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        children: [
          Expanded(child: Text(label)),
          Text('₹${value.toStringAsFixed(2)}'),
        ],
      ),
    );
  }
}

class _LegendChip extends StatelessWidget {
  const _LegendChip({required this.label, required this.level});

  final String label;
  final RiskLevel level;

  @override
  Widget build(BuildContext context) {
    final color = switch (level) {
      RiskLevel.normal => Colors.green,
      RiskLevel.caution => Colors.orange,
      RiskLevel.critical => Colors.deepOrange,
      RiskLevel.breached => Colors.red,
    };
    return Chip(
      avatar: CircleAvatar(backgroundColor: color, radius: 6),
      label: Text(label),
    );
  }
}

String _formatDateOnly(DateTime value) {
  final year = value.year.toString().padLeft(4, '0');
  final month = value.month.toString().padLeft(2, '0');
  final day = value.day.toString().padLeft(2, '0');
  return '$year-$month-$day';
}
