import { afterEach, describe, expect, it, vi } from 'vitest';
import { HealthController } from '../src/health.controller.js';
import type { FirebaseAdminService } from '../src/firebase-admin.service.js';
import type { MonitoringRunner } from '../src/monitoring.runner.js';

function controller(firebaseConfigured: boolean): HealthController {
  return new HealthController(
    { isConfigured: firebaseConfigured } as FirebaseAdminService,
    {
      getDiagnostics: () => ({
        started: firebaseConfigured,
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
      getNotificationDeliveryDiagnostics: () => ({
        lastAttemptAt: null,
        lastDeliveredAt: null,
        lastFailureAt: null,
        consecutiveFailures: 0,
        totalFailures: 0,
        lastFailureReason: null,
      }),
    } as MonitoringRunner,
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('HealthController', () => {
  it('keeps liveness healthy when notification delivery is unverified', () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'configured-token');
    vi.stubEnv('TELEGRAM_CHAT_ID', 'configured-chat');
    vi.stubEnv('FIREBASE_ALLOWED_UIDS', 'allowed-user');

    const health = controller(true).getHealth();

    expect(health.status).toBe('ok');
    expect(health.firebaseConfigured).toBe(true);
    expect(health.telegramConfigured).toBe(true);
    expect(health.androidPushConfigured).toBe(true);
    expect(health.notificationReadiness).toEqual({
      telegram: {
        configured: true,
        readiness: 'transport_configured',
      },
      androidPush: {
        transportConfigured: true,
        deviceRegistration: 'not_checked',
        delivery: 'not_checked',
        readiness: 'transport_configured_delivery_unverified',
      },
    });
    expect(health.monitoringReadiness).toEqual({
      marketHoursConfigurationValid: true,
      marketDataAdapter: 'yahoo-finance-prototype',
      liveProviderConnectivity: 'not_checked',
      worker: {
        started: true,
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
      notificationDelivery: {
        lastAttemptAt: null,
        lastDeliveredAt: null,
        lastFailureAt: null,
        consecutiveFailures: 0,
        totalFailures: 0,
        lastFailureReason: null,
      },
    });
  });

  it('does not claim push readiness when Firebase is not configured', () => {
    const health = controller(false).getHealth();

    expect(health.status).toBe('ok');
    expect(health.androidPushConfigured).toBe(false);
    expect(health.notificationReadiness.androidPush).toEqual({
      transportConfigured: false,
      deviceRegistration: 'not_checked',
      delivery: 'not_checked',
      readiness: 'not_configured',
    });
  });

  it('reports invalid market-hours config without failing liveness', () => {
    vi.stubEnv('FOPLAYER_MARKET_OPEN', '25:90');

    const health = controller(false).getHealth();

    expect(health.status).toBe('ok');
    expect(health.marketHoursConfigurationValid).toBe(false);
    expect(health.monitoringReadiness.marketHoursConfigurationValid).toBe(
      false,
    );
  });
});
