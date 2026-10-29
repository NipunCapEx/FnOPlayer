import { describe, expect, it, vi } from 'vitest';
import {
  RiskMonitor,
  type MonitoringRepository,
  type RiskAlert,
  type RiskEpisodeState,
  type Strategy,
} from '../src/monitoring.js';
import type { MarketDataProvider, MarketSnapshot } from '../src/market-data.js';
import {
  MultiChannelDispatcher,
  type NotificationDeliveryStateStore,
  type NotificationTransport,
} from '../src/notifications.js';

const now = new Date('2026-10-20T10:00:00.000Z');
const strategy: Strategy = {
  id: 'strategy-owner-reliance',
  ownerUid: 'owner-1',
  symbol: 'RELIANCE',
  entryPrice: 1000,
  active: true,
  notificationsEnabled: true,
};

function createSnapshot(price = 1080): MarketSnapshot {
  return {
    symbol: 'RELIANCE',
    price,
    previousClose: price,
    exchangeTimestamp: now,
    fetchedAt: now,
    source: 'deterministic-integration-fixture',
    historicalCloses: [100, 100.1, 99.9, 100.05, 99.95, 100.1, 100],
  };
}

type StoredAlert = {
  alert: RiskAlert;
  status: 'pending' | 'delivered' | 'suppressed';
  attempts: number;
};

class PersistentMonitoringHarness
  implements MonitoringRepository, NotificationDeliveryStateStore
{
  readonly strategies = [strategy];
  readonly alerts = new Map<string, StoredAlert>();
  readonly riskStates = new Map<string, RiskEpisodeState>();
  readonly deliveryTargets = new Set<string>();
  readonly assessments: unknown[] = [];
  readonly unavailable: string[] = [];

  async listActiveStrategies(): Promise<Strategy[]> {
    return this.strategies.filter((item) => item.active);
  }

  async recordAssessment(
    _strategyId: string,
    assessment: unknown,
    _snapshot: MarketSnapshot,
  ): Promise<void> {
    this.assessments.push(assessment);
  }

  async getRiskEpisodeState(strategyId: string): Promise<RiskEpisodeState | null> {
    return this.riskStates.get(strategyId) ?? null;
  }

  async saveRiskEpisodeState(
    strategyId: string,
    state: RiskEpisodeState,
  ): Promise<void> {
    this.riskStates.set(strategyId, { ...state });
  }

  async recordUnavailable(
    symbol: string,
    reason: string,
    _checkedAt: Date,
  ): Promise<void> {
    this.unavailable.push(`${symbol}: ${reason}`);
  }

  async hasDeliveredOrQueuedAlert(idempotencyKey: string): Promise<boolean> {
    return this.alerts.has(idempotencyKey);
  }

  async enqueueAlert(alert: RiskAlert): Promise<void> {
    if (!this.alerts.has(alert.idempotencyKey)) {
      this.alerts.set(alert.idempotencyKey, {
        alert,
        status: 'pending',
        attempts: 0,
      });
    }
  }

  async listPendingAlerts(): Promise<RiskAlert[]> {
    return [...this.alerts.values()]
      .filter((item) => item.status === 'pending')
      .map((item) => item.alert);
  }

  async markAlertDelivered(idempotencyKey: string, _deliveredAt: Date): Promise<void> {
    const stored = this.alerts.get(idempotencyKey);
    if (stored) stored.status = 'delivered';
  }

  async markAlertSuppressed(idempotencyKey: string, _suppressedAt: Date): Promise<void> {
    const stored = this.alerts.get(idempotencyKey);
    if (stored) stored.status = 'suppressed';
  }

  async recordAlertDeliveryFailure(
    idempotencyKey: string,
    _reason: string,
    _failedAt: Date,
  ): Promise<void> {
    const stored = this.alerts.get(idempotencyKey);
    if (stored) stored.attempts += 1;
  }

  async hasDeliveredTarget(
    idempotencyKey: string,
    targetKey: string,
  ): Promise<boolean> {
    return this.deliveryTargets.has(`${idempotencyKey}|${targetKey}`);
  }

  async markTargetDelivered(
    idempotencyKey: string,
    targetKey: string,
    _deliveredAt: Date,
  ): Promise<void> {
    this.deliveryTargets.add(`${idempotencyKey}|${targetKey}`);
  }
}

function createMonitor(
  repository: PersistentMonitoringHarness,
  dispatcher: MultiChannelDispatcher,
  provider: MarketDataProvider,
): RiskMonitor {
  return new RiskMonitor(provider, repository, dispatcher, { now: () => now });
}

describe('monitoring-to-notification outbox integration', () => {
  it('persists a risk alert and delivers it once across monitor restarts', async () => {
    const repository = new PersistentMonitoringHarness();
    const provider: MarketDataProvider = {
      getSnapshot: vi.fn(async () => createSnapshot()),
    };
    const send = vi.fn(async (_alert: RiskAlert) => {});
    const transport: NotificationTransport = {
      deliveryKey: 'test-push',
      send,
    };
    const dispatcher = new MultiChannelDispatcher([transport], repository);

    await createMonitor(repository, dispatcher, provider).runOnce();

    const stored = [...repository.alerts.values()];
    expect(stored).toHaveLength(1);
    expect(stored[0]?.alert.kind).toBe('caution');
    expect(stored[0]?.status).toBe('delivered');
    expect(repository.assessments).toHaveLength(1);
    expect(send).toHaveBeenCalledOnce();

    await createMonitor(
      repository,
      new MultiChannelDispatcher([transport], repository),
      provider,
    ).runOnce();

    expect(repository.alerts).toHaveLength(1);
    expect(send).toHaveBeenCalledOnce();
  });

  it('retries only the failed channel after restart and preserves delivery checkpoints', async () => {
    const repository = new PersistentMonitoringHarness();
    const provider: MarketDataProvider = {
      getSnapshot: vi.fn(async () => createSnapshot()),
    };
    const healthySend = vi.fn(async (_alert: RiskAlert) => {});
    const failingSend = vi
      .fn(async (_alert: RiskAlert) => {})
      .mockRejectedValueOnce(new Error('temporary notification outage'));
    const healthy: NotificationTransport = {
      deliveryKey: 'healthy-channel',
      send: healthySend,
    };
    const flaky: NotificationTransport = {
      deliveryKey: 'flaky-channel',
      send: failingSend,
    };

    await createMonitor(
      repository,
      new MultiChannelDispatcher([healthy, flaky], repository),
      provider,
    ).runOnce();

    const pending = [...repository.alerts.values()][0];
    expect(pending?.status).toBe('pending');
    expect(pending?.attempts).toBe(1);
    expect(healthySend).toHaveBeenCalledOnce();
    expect(failingSend).toHaveBeenCalledOnce();

    await createMonitor(
      repository,
      new MultiChannelDispatcher([healthy, flaky], repository),
      provider,
    ).runOnce();

    expect([...repository.alerts.values()][0]?.status).toBe('delivered');
    expect(healthySend).toHaveBeenCalledOnce();
    expect(failingSend).toHaveBeenCalledTimes(2);
  });
});
