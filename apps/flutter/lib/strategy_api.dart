import 'dart:convert';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:http/http.dart' as http;

class StrategyThresholds {
  const StrategyThresholds({
    this.cautionPercent = 8,
    this.criticalPercent = 10,
    this.breachedPercent = 12,
  });

  final double cautionPercent;
  final double criticalPercent;
  final double breachedPercent;

  factory StrategyThresholds.fromJson(Object? value) {
    if (value is! Map<String, dynamic>) return const StrategyThresholds();
    final caution = value['cautionPercent'];
    final critical = value['criticalPercent'];
    final breached = value['breachedPercent'];
    if (caution is! num || critical is! num || breached is! num) {
      return const StrategyThresholds();
    }
    return StrategyThresholds(
      cautionPercent: caution.toDouble(),
      criticalPercent: critical.toDouble(),
      breachedPercent: breached.toDouble(),
    );
  }

  Map<String, double> toJson() => {
        'cautionPercent': cautionPercent,
        'criticalPercent': criticalPercent,
        'breachedPercent': breachedPercent,
      };

  bool get isValid =>
      cautionPercent > 0 &&
      cautionPercent < criticalPercent &&
      criticalPercent < breachedPercent &&
      breachedPercent < 100;
}

class UserStrategy {
  const UserStrategy({
    required this.id,
    required this.symbol,
    required this.entryPrice,
    required this.active,
    this.entryDate,
    this.expiryDate,
    this.thresholds = const StrategyThresholds(),
    this.notificationsEnabled = true,
  });

  final String id;
  final String symbol;
  final double entryPrice;
  final bool active;
  final DateTime? entryDate;
  final DateTime? expiryDate;
  final StrategyThresholds thresholds;
  final bool notificationsEnabled;

  factory UserStrategy.fromJson(Map<String, dynamic> json) {
    final id = json['id'];
    final symbol = json['symbol'];
    final entryPrice = json['entryPrice'];
    final active = json['active'];
    final entryDate = json['entryDate'];
    final expiryDate = json['expiryDate'];
    if (id is! String ||
        symbol is! String ||
        entryPrice is! num ||
        active is! bool ||
        (entryDate != null && entryDate is! String) ||
        (expiryDate != null && expiryDate is! String)) {
      throw const FormatException('Invalid strategy returned by the API.');
    }
    final parsedThresholds = StrategyThresholds.fromJson(json['thresholds']);
    return UserStrategy(
      id: id,
      symbol: symbol,
      entryPrice: entryPrice.toDouble(),
      active: active,
      entryDate: entryDate is String ? DateTime.tryParse(entryDate) : null,
      expiryDate: expiryDate is String ? DateTime.tryParse(expiryDate) : null,
      thresholds: parsedThresholds.isValid
          ? parsedThresholds
          : const StrategyThresholds(),
      notificationsEnabled: json['notificationsEnabled'] is bool
          ? json['notificationsEnabled'] as bool
          : true,
    );
  }
}

class UserAlert {
  const UserAlert({
    required this.id,
    required this.symbol,
    required this.kind,
    required this.message,
    required this.price,
    required this.movementPercent,
    required this.createdAt,
    required this.status,
  });

  final String id;
  final String symbol;
  final String kind;
  final String message;
  final double price;
  final double movementPercent;
  final DateTime? createdAt;
  final String status;

  factory UserAlert.fromJson(Map<String, dynamic> json) {
    final id = json['id'];
    final symbol = json['symbol'];
    final kind = json['kind'];
    final message = json['message'];
    final price = json['price'];
    final movementPercent = json['movementPercent'];
    final status = json['status'];
    if (id is! String ||
        symbol is! String ||
        kind is! String ||
        message is! String ||
        price is! num ||
        movementPercent is! num ||
        status is! String) {
      throw const FormatException('Invalid alert returned by the API.');
    }
    return UserAlert(
      id: id,
      symbol: symbol,
      kind: kind,
      message: message,
      price: price.toDouble(),
      movementPercent: movementPercent.toDouble(),
      createdAt: _parseAlertDate(json['createdAt']),
      status: status,
    );
  }
}

DateTime? _parseAlertDate(dynamic value) {
  if (value is String) {
    return DateTime.tryParse(value)?.toLocal();
  }
  if (value is num) {
    return DateTime.fromMillisecondsSinceEpoch(value.toInt()).toLocal();
  }
  if (value is Map<String, dynamic>) {
    final seconds = value['seconds'] ?? value['_seconds'];
    if (seconds is num) {
      final milliseconds = seconds.toInt() * 1000;
      return DateTime.fromMillisecondsSinceEpoch(milliseconds).toLocal();
    }
  }
  return null;
}

class DashboardSnapshot {
  const DashboardSnapshot({
    required this.strategyId,
    required this.symbol,
    required this.entryPrice,
    required this.spotPrice,
    required this.movementPercent,
    required this.level,
    required this.source,
    required this.exchangeTimestamp,
    required this.fetchedAt,
    required this.recordedAt,
    this.historicalCloses = const [],
  });

  final String strategyId;
  final String symbol;
  final double entryPrice;
  final double spotPrice;
  final double movementPercent;
  final String level;
  final String source;
  final DateTime exchangeTimestamp;
  final DateTime fetchedAt;
  final DateTime recordedAt;
  final List<double> historicalCloses;

  bool isFreshAt(DateTime now) {
    const maxAge = Duration(minutes: 10);
    const maxFutureSkew = Duration(minutes: 1);
    final fetchAge = now.difference(fetchedAt);
    final exchangeAge = now.difference(exchangeTimestamp);
    return fetchAge <= maxAge &&
        fetchAge >= -maxFutureSkew &&
        exchangeAge <= maxAge &&
        exchangeAge >= -maxFutureSkew;
  }

  factory DashboardSnapshot.fromJson(Map<String, dynamic> json) {
    final strategyId = json['strategyId'];
    final source = json['source'];
    final assessment = json['assessment'];
    if (strategyId is! String ||
        source is! String ||
        assessment is! Map<String, dynamic>) {
      throw const FormatException('Invalid dashboard snapshot.');
    }
    final symbol = assessment['symbol'];
    final entryPrice = assessment['entryPrice'];
    final spotPrice = assessment['spotPrice'];
    final movementPercent = assessment['movementPercent'];
    final level = assessment['level'];
    final exchangeTimestamp = _parseAlertDate(json['exchangeTimestamp']);
    final fetchedAt = _parseAlertDate(json['fetchedAt']);
    final recordedAt = _parseAlertDate(json['recordedAt']);
    final rawHistory = json['historicalCloses'];
    final historicalCloses = rawHistory is List
        ? rawHistory
            .whereType<num>()
            .map((value) => value.toDouble())
            .where((value) => value.isFinite && value > 0)
            .toList()
        : <double>[];
    if (symbol is! String ||
        entryPrice is! num ||
        spotPrice is! num ||
        movementPercent is! num ||
        level is! String ||
        exchangeTimestamp == null ||
        fetchedAt == null ||
        recordedAt == null ||
        !entryPrice.toDouble().isFinite ||
        entryPrice <= 0 ||
        !spotPrice.toDouble().isFinite ||
        spotPrice <= 0 ||
        !movementPercent.toDouble().isFinite) {
      throw const FormatException('Invalid dashboard snapshot values.');
    }
    return DashboardSnapshot(
      strategyId: strategyId,
      symbol: symbol,
      entryPrice: entryPrice.toDouble(),
      spotPrice: spotPrice.toDouble(),
      movementPercent: movementPercent.toDouble(),
      level: level,
      source: source,
      exchangeTimestamp: exchangeTimestamp,
      fetchedAt: fetchedAt,
      recordedAt: recordedAt,
      historicalCloses: historicalCloses,
    );
  }
}

class UserDashboard {
  const UserDashboard({
    required this.strategies,
    required this.snapshots,
    required this.hasAnyStrategies,
  });

  final List<UserStrategy> strategies;
  final Map<String, DashboardSnapshot> snapshots;
  final bool hasAnyStrategies;

  factory UserDashboard.fromJson(Map<String, dynamic> json) {
    final rawStrategies = json['strategies'];
    final rawSnapshots = json['snapshots'];
    if (rawStrategies is! List || rawSnapshots is! List) {
      throw const FormatException('Invalid dashboard response.');
    }
    final hasAnyStrategies = rawStrategies.isNotEmpty;
    final strategies = rawStrategies
        .map((value) {
          if (value is! Map<String, dynamic>) {
            throw const FormatException('Invalid dashboard strategy.');
          }
          return UserStrategy.fromJson(value);
        })
        .where((strategy) => strategy.active)
        .toList();
    final snapshots = <String, DashboardSnapshot>{};
    for (final value in rawSnapshots) {
      if (value is! Map<String, dynamic>) {
        throw const FormatException('Invalid dashboard snapshot item.');
      }
      final snapshot = DashboardSnapshot.fromJson(value);
      snapshots[snapshot.strategyId] = snapshot;
    }
    return UserDashboard(
      strategies: strategies,
      snapshots: snapshots,
      hasAnyStrategies: hasAnyStrategies,
    );
  }
}

class StrategyApiException implements Exception {
  const StrategyApiException(this.message);

  final String message;

  @override
  String toString() => message;
}

class StrategyApiClient {
  StrategyApiClient({
    FirebaseAuth? auth,
    http.Client? client,
    String? baseUrl,
  })  : _auth = auth ?? FirebaseAuth.instance,
        _client = client ?? http.Client(),
        _baseUrl =
            (baseUrl ?? const String.fromEnvironment('FOPLAYER_API_BASE_URL'))
                .trim();

  final FirebaseAuth _auth;
  final http.Client _client;
  final String _baseUrl;

  bool get isConfigured => _baseUrl.startsWith('https://');

  /// Public, sanitized runtime diagnostics; never includes credentials or raw provider payloads.
  Future<Map<String, dynamic>> getHealth() async {
    final base = Uri.parse(_baseUrl.endsWith('/') ? _baseUrl : '$_baseUrl/');
    final response = await http.get(base.resolve('health')).timeout(
          const Duration(seconds: 8),
        );
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw FormatException('Health check failed (${response.statusCode}).');
    }
    final decoded = jsonDecode(response.body);
    if (decoded is! Map<String, dynamic>) {
      throw const FormatException('Invalid health response.');
    }
    return decoded;
  }

  Future<UserDashboard> getDashboard() async {
    final response = await _request('GET', '/api/dashboard');
    if (response is! Map<String, dynamic>) {
      throw const StrategyApiException('Unexpected dashboard response.');
    }
    return UserDashboard.fromJson(response);
  }

  Future<List<UserStrategy>> listStrategies({
    bool includeInactive = false,
  }) async {
    final response = await _request('GET', '/api/strategies');
    if (response is! List) {
      throw const StrategyApiException('Unexpected strategies response.');
    }
    final strategies = response.map((value) {
      if (value is! Map<String, dynamic>) {
        throw const FormatException('Invalid strategy response item.');
      }
      return UserStrategy.fromJson(value);
    }).toList();
    return includeInactive
        ? strategies
        : strategies.where((strategy) => strategy.active).toList();
  }

  Future<List<UserAlert>> listAlerts() async {
    final response = await _request('GET', '/api/alerts');
    if (response is! List) {
      throw const StrategyApiException('Unexpected alerts response.');
    }
    return response.map((value) {
      if (value is! Map<String, dynamic>) {
        throw const FormatException('Invalid alert response item.');
      }
      return UserAlert.fromJson(value);
    }).toList();
  }

  Future<UserStrategy> createStrategy({
    required String symbol,
    required double entryPrice,
    DateTime? entryDate,
    DateTime? expiryDate,
    StrategyThresholds? thresholds,
    bool? notificationsEnabled,
  }) async {
    final response = await _request(
      'POST',
      '/api/strategies',
      body: {
        'symbol': symbol,
        'entryPrice': entryPrice,
        if (entryDate != null) 'entryDate': _formatDateOnly(entryDate),
        if (expiryDate != null) 'expiryDate': _formatDateOnly(expiryDate),
        if (thresholds != null) 'thresholds': thresholds.toJson(),
        if (notificationsEnabled != null)
          'notificationsEnabled': notificationsEnabled,
      },
    );
    if (response is! Map<String, dynamic>) {
      throw const StrategyApiException('Unexpected create response.');
    }
    return UserStrategy.fromJson(response);
  }

  Future<UserStrategy> updateStrategy(
    String id, {
    double? entryPrice,
    bool? active,
    DateTime? entryDate,
    DateTime? expiryDate,
    StrategyThresholds? thresholds,
    bool? notificationsEnabled,
  }) async {
    final body = <String, dynamic>{};
    if (entryPrice != null) body['entryPrice'] = entryPrice;
    if (active != null) body['active'] = active;
    if (entryDate != null) body['entryDate'] = _formatDateOnly(entryDate);
    if (expiryDate != null) body['expiryDate'] = _formatDateOnly(expiryDate);
    if (thresholds != null) body['thresholds'] = thresholds.toJson();
    if (notificationsEnabled != null) {
      body['notificationsEnabled'] = notificationsEnabled;
    }
    final response = await _request(
      'PATCH',
      '/api/strategies/${Uri.encodeComponent(id)}',
      body: body,
    );
    if (response is! Map<String, dynamic>) {
      throw const StrategyApiException('Unexpected update response.');
    }
    return UserStrategy.fromJson(response);
  }

  Future<void> registerDeviceToken(String strategyId, String token) async {
    final response = await _request(
      'POST',
      '/api/device-tokens',
      body: {'strategyId': strategyId, 'token': token},
    );
    if (response is! Map<String, dynamic> || response['registered'] != true) {
      throw const StrategyApiException(
        'The backend did not confirm device-token registration.',
      );
    }
  }

  Future<dynamic> _request(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async {
    if (!isConfigured) {
      throw const StrategyApiException(
        'Configure FOPLAYER_API_BASE_URL with the deployed HTTPS API URL.',
      );
    }
    final user = _auth.currentUser;
    if (user == null) {
      throw const StrategyApiException(
        'Sign in before managing your watchlist.',
      );
    }
    final token = await user.getIdToken();
    if (token == null || token.isEmpty) {
      throw const StrategyApiException(
        'Could not obtain a Firebase ID token.',
      );
    }
    final base = Uri.parse(_baseUrl.endsWith('/') ? _baseUrl : '$_baseUrl/');
    final uri = base.resolve(path.startsWith('/') ? path.substring(1) : path);
    final headers = <String, String>{
      'Accept': 'application/json',
      'Authorization': 'Bearer $token',
    };
    if (body != null) headers['Content-Type'] = 'application/json';

    late http.Response response;
    if (method == 'GET') {
      response = await _client.get(uri, headers: headers);
    } else if (method == 'POST') {
      response = await _client.post(
        uri,
        headers: headers,
        body: jsonEncode(body),
      );
    } else if (method == 'PATCH') {
      response = await _client.patch(
        uri,
        headers: headers,
        body: jsonEncode(body),
      );
    } else {
      throw ArgumentError.value(method, 'method', 'Unsupported HTTP method');
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      final message = response.body.length > 300
          ? response.body.substring(0, 300)
          : response.body;
      throw StrategyApiException(
        'Watchlist request failed (${response.statusCode}): $message',
      );
    }
    if (response.body.isEmpty) {
      return null;
    }
    return jsonDecode(response.body);
  }
}

String _formatDateOnly(DateTime value) {
  final year = value.year.toString().padLeft(4, '0');
  final month = value.month.toString().padLeft(2, '0');
  final day = value.day.toString().padLeft(2, '0');
  return '$year-$month-$day';
}
