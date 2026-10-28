import { NestFactory } from '@nestjs/core';
import { afterEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import {
  isIndianEquityMarketOpen,
  marketHoursPolicyFromEnvironment,
} from '../src/monitoring.js';
import type { MonitoringRunner } from '../src/monitoring.runner.js';
import { FirebaseAdminService } from '../src/firebase-admin.service.js';
import { HealthController } from '../src/health.controller.js';

function createHealthController(firebaseConfigured: boolean): HealthController {
  return new HealthController(
    { isConfigured: firebaseConfigured } as FirebaseAdminService,
    {
      getDiagnostics: () => ({
        started: false,
        running: false,
        lastCycleStartedAt: null,
        lastCycleCompletedAt: null,
        lastCycleStatus: 'never_run',
        consecutiveFailures: 0,
        lastCycleFailureAt: null,
        lastSuccessfulCycleAt: null,
        lastRecoveryAt: null,
      }),
      getMarketDataDiagnostics: () => [],
    } as MonitoringRunner,
  );
}

const keys = [
  'FIREBASE_PROJECT_ID',
  'FIREBASE_SERVICE_ACCOUNT_JSON',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'K_SERVICE',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'FOPLAYER_MARKET_OPEN',
  'FOPLAYER_MARKET_CLOSE',
  'FOPLAYER_MARKET_HOLIDAYS',
  'FOPLAYER_MARKET_SPECIAL_SESSIONS',
] as const;
const original = new Map(keys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of keys) {
    const value = original.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

it('reports Telegram configured only for a single allowlisted UID', () => {
  const original = new Map(
    ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'FIREBASE_ALLOWED_UIDS'].map(
      (key) => [key, process.env[key]],
    ),
  );
  try {
    process.env.TELEGRAM_BOT_TOKEN = 'server-token';
    process.env.TELEGRAM_CHAT_ID = 'private-chat';
    const controller = createHealthController(false);

    process.env.FIREBASE_ALLOWED_UIDS = 'user-a,user-b';
    expect(controller.getHealth().telegramConfigured).toBe(false);
    process.env.FIREBASE_ALLOWED_UIDS = 'user-a';
    expect(controller.getHealth().telegramConfigured).toBe(true);
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

it('reports invalid market-hours configuration without exposing its value', () => {
  process.env.FOPLAYER_MARKET_HOLIDAYS = '2026-02-30';
  const controller = createHealthController(false);

  const health = controller.getHealth();
  expect(health.marketHoursConfigurationValid).toBe(false);
  expect(JSON.stringify(health)).not.toContain('2026-02-30');
});

describe('AppModule runtime wiring', () => {
  it('boots health-only mode without privileged credentials and never reports secrets', async () => {
    for (const key of keys) delete process.env[key];
    const app = await NestFactory.create(AppModule, { logger: false });
    try {
      await app.init();
      expect(
        app.get(FirebaseAdminService, { strict: false }).isConfigured,
      ).toBe(false);
      expect(app.get(HealthController).getHealth()).toEqual({
        status: 'ok',
        service: 'foplayer-api',
        firebaseConfigured: false,
        marketHoursConfigurationValid: true,
        marketDataAdapter: 'yahoo-finance-prototype',
        telegramConfigured: false,
        androidPushConfigured: false,
        notificationReadiness: {
          telegram: {
            configured: false,
            readiness: 'not_configured',
          },
          androidPush: {
            transportConfigured: false,
            deviceRegistration: 'not_checked',
            delivery: 'not_checked',
            readiness: 'not_configured',
          },
        },
        monitoringReadiness: {
          marketHoursConfigurationValid: true,
          marketDataAdapter: 'yahoo-finance-prototype',
          liveProviderConnectivity: 'not_checked',
          worker: {
            started: false,
            running: false,
            lastCycleStartedAt: null,
            lastCycleCompletedAt: null,
            lastCycleStatus: 'never_run',
            consecutiveFailures: 0,
            lastCycleFailureAt: null,
            lastSuccessfulCycleAt: null,
            lastRecoveryAt: null,
          },
          marketDataFreshness: [],
        },
      });
    } finally {
      await app.close();
    }
  });
});

describe('runtime market-hours environment configuration', () => {
  it('loads valid holiday, opening/closing and special-session settings for the worker', () => {
    process.env.FOPLAYER_MARKET_OPEN = '09:00';
    process.env.FOPLAYER_MARKET_CLOSE = '15:00';
    process.env.FOPLAYER_MARKET_HOLIDAYS = '2026-11-09,2026-11-10';
    process.env.FOPLAYER_MARKET_SPECIAL_SESSIONS =
      '{"2026-11-08":{"open":"18:00","close":"19:00"}}';

    expect(marketHoursPolicyFromEnvironment()).toEqual({
      openingTime: '09:00',
      closingTime: '15:00',
      holidays: ['2026-11-09', '2026-11-10'],
      specialSessions: {
        '2026-11-08': { open: '18:00', close: '19:00' },
      },
    });
    expect(isIndianEquityMarketOpen(new Date('2026-11-08T12:30:00.000Z'))).toBe(
      true,
    );
    expect(isIndianEquityMarketOpen(new Date('2026-11-09T04:00:00.000Z'))).toBe(
      false,
    );
  });

  it('fails closed for invalid holiday, clock, or special-session configuration', () => {
    for (const [key, value] of [
      ['FOPLAYER_MARKET_HOLIDAYS', '2026-02-30'],
      ['FOPLAYER_MARKET_OPEN', '25:00'],
      ['FOPLAYER_MARKET_CLOSE', '08:00'],
      [
        'FOPLAYER_MARKET_SPECIAL_SESSIONS',
        '{"2026-02-30":{"open":"18:00","close":"19:00"}}',
      ],
      [
        'FOPLAYER_MARKET_SPECIAL_SESSIONS',
        '{"2026-11-08":{"open":"19:00","close":"18:00"}}',
      ],
    ] as const) {
      process.env.FOPLAYER_MARKET_OPEN = '';
      process.env.FOPLAYER_MARKET_CLOSE = '';
      process.env.FOPLAYER_MARKET_HOLIDAYS = '';
      process.env.FOPLAYER_MARKET_SPECIAL_SESSIONS = '';
      process.env[key] = value;
      expect(marketHoursPolicyFromEnvironment()).toBeNull();
      expect(
        isIndianEquityMarketOpen(new Date('2026-11-08T12:30:00.000Z')),
      ).toBe(false);
    }
  });
});
