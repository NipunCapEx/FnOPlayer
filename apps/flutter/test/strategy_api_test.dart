import 'dart:convert';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:foplayer/strategy_api.dart';

void main() {
  group('StrategyApiClient strategy workflows', () {
    test('creates a strategy with dates, thresholds and notification preference',
        () async {
      late http.Request captured;
      final client = StrategyApiClient(
        auth: _FakeFirebaseAuth(_FakeUser()),
        baseUrl: 'https://api.example.test/',
        client: MockClient((request) async {
          captured = request as http.Request;
          return http.Response(
            jsonEncode(_strategyJson(
              id: 'strategy-1',
              entryDate: '2026-10-15',
              expiryDate: '2026-11-26',
              notificationsEnabled: false,
              thresholds: {
                'cautionPercent': 5,
                'criticalPercent': 7,
                'breachedPercent': 9,
              },
            )),
            201,
            headers: {'content-type': 'application/json'},
          );
        }),
      );

      final saved = await client.createStrategy(
        symbol: 'RELIANCE',
        entryPrice: 1250,
        entryDate: DateTime(2026, 10, 15),
        expiryDate: DateTime(2026, 11, 26),
        thresholds: const StrategyThresholds(
          cautionPercent: 5,
          criticalPercent: 7,
          breachedPercent: 9,
        ),
        notificationsEnabled: false,
      );

      expect(captured.method, 'POST');
      expect(captured.url.path, '/api/strategies');
      expect(captured.headers['authorization'], 'Bearer test-token');
      expect(captured.headers['content-type'], 'application/json');
      expect(jsonDecode(captured.body), {
        'symbol': 'RELIANCE',
        'entryPrice': 1250,
        'entryDate': '2026-10-15',
        'expiryDate': '2026-11-26',
        'thresholds': {
          'cautionPercent': 5,
          'criticalPercent': 7,
          'breachedPercent': 9,
        },
        'notificationsEnabled': false,
      });
      expect(saved.id, 'strategy-1');
      expect(saved.entryDate, DateTime(2026, 10, 15));
      expect(saved.expiryDate, DateTime(2026, 11, 26));
      expect(saved.notificationsEnabled, isFalse);
      expect(saved.thresholds.breachedPercent, 9);
    });

    test('updates only supplied fields and safely encodes strategy ID', () async {
      late http.Request captured;
      final client = StrategyApiClient(
        auth: _FakeFirebaseAuth(_FakeUser()),
        baseUrl: 'https://api.example.test',
        client: MockClient((request) async {
          captured = request as http.Request;
          return http.Response(
            jsonEncode(_strategyJson(
              id: 'id/with space',
              active: false,
              entryPrice: 1300,
              notificationsEnabled: false,
            )),
            200,
          );
        }),
      );

      final updated = await client.updateStrategy(
        'id/with space',
        entryPrice: 1300,
        active: false,
        notificationsEnabled: false,
      );

      expect(captured.method, 'PATCH');
      expect(captured.url.toString(), contains('/api/strategies/id%2Fwith%20space'));
      expect(jsonDecode(captured.body), {
        'entryPrice': 1300,
        'active': false,
        'notificationsEnabled': false,
      });
      expect(updated.active, isFalse);
      expect(updated.entryPrice, 1300);
    });

    test('lists active strategies by default and includes inactive on request',
        () async {
      final client = StrategyApiClient(
        auth: _FakeFirebaseAuth(_FakeUser()),
        baseUrl: 'https://api.example.test',
        client: MockClient((_) async => http.Response(
              jsonEncode([
                _strategyJson(id: 'active', active: true),
                _strategyJson(id: 'inactive', active: false),
              ]),
              200,
            )),
      );

      expect(
        (await client.listStrategies()).map((item) => item.id),
        ['active'],
      );
      expect(
        (await client.listStrategies(includeInactive: true))
            .map((item) => item.id),
        ['active', 'inactive'],
      );
    });

    test('rejects unauthenticated, unconfigured and failed HTTP requests',
        () async {
      final unauthenticated = StrategyApiClient(
        auth: _FakeFirebaseAuth(null),
        baseUrl: 'https://api.example.test',
        client: MockClient((_) async => http.Response('{}', 200)),
      );
      await expectLater(
        unauthenticated.listStrategies(),
        throwsA(isA<StrategyApiException>()
            .having((error) => error.message, 'message', contains('Sign in'))),
      );

      final unconfigured = StrategyApiClient(
        auth: _FakeFirebaseAuth(_FakeUser()),
        baseUrl: 'http://api.example.test',
        client: MockClient((_) async => http.Response('{}', 200)),
      );
      await expectLater(
        unconfigured.listStrategies(),
        throwsA(isA<StrategyApiException>().having(
          (error) => error.message,
          'message',
          contains('HTTPS'),
        )),
      );

      final failed = StrategyApiClient(
        auth: _FakeFirebaseAuth(_FakeUser()),
        baseUrl: 'https://api.example.test',
        client: MockClient((_) async => http.Response('not allowed', 403)),
      );
      await expectLater(
        failed.listStrategies(),
        throwsA(isA<StrategyApiException>()
            .having((error) => error.message, 'message', contains('403'))),
      );
    });

    test('rejects malformed strategy responses instead of silently accepting',
        () async {
      final client = StrategyApiClient(
        auth: _FakeFirebaseAuth(_FakeUser()),
        baseUrl: 'https://api.example.test',
        client: MockClient((_) async => http.Response(
              jsonEncode([
                {'id': 'missing-required-fields'},
              ]),
              200,
            )),
      );

      await expectLater(
        client.listStrategies(),
        throwsA(isA<FormatException>()),
      );
    });
  });
}

Map<String, Object?> _strategyJson({
  String id = 'strategy-1',
  String symbol = 'RELIANCE',
  double entryPrice = 1250,
  bool active = true,
  String? entryDate,
  String? expiryDate,
  bool notificationsEnabled = true,
  Map<String, Object?> thresholds = const {
    'cautionPercent': 8,
    'criticalPercent': 10,
    'breachedPercent': 12,
  },
}) =>
    {
      'id': id,
      'ownerUid': 'owner-1',
      'symbol': symbol,
      'entryPrice': entryPrice,
      'active': active,
      'entryDate': entryDate,
      'expiryDate': expiryDate,
      'thresholds': thresholds,
      'notificationsEnabled': notificationsEnabled,
      'createdAt': '2026-10-20T10:00:00.000Z',
      'updatedAt': '2026-10-20T10:00:00.000Z',
    };

class _FakeFirebaseAuth implements FirebaseAuth {
  _FakeFirebaseAuth(this.currentUser);

  @override
  final User? currentUser;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _FakeUser implements User {
  @override
  Future<String?> getIdToken([bool forceRefresh = false]) async =>
      'test-token';

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
