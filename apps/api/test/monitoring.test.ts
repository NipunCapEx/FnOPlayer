import { describe, expect, it, vi } from 'vitest';
import {
  PollingWorker,
  RiskMonitor,
  isIndianEquityMarketOpen,
  type MonitoringRepository,
  type RiskAlert,
  type RiskEpisodeState,
  type Strategy,
} from '../src/monitoring.js';
import {
  validateSnapshot,
  type MarketDataProvider,
  type MarketSnapshot,
} from '../src/market-data.js';

const now = new Date('2026-10-20T10:00:00.000Z');
const strategy: Strategy = {
  id: 'strategy-1',
  symbol: 'RELIANCE',
  entryPrice: 1000,
  active: true,
};

function snapshot(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    symbol: 'RELIANCE',
    price: 1000,
    previousClose: 1000,
    exchangeTimestamp: now,
    fetchedAt: now,
    source: 'deterministic-test-provider',
    historicalCloses: [100, 100.1, 99.9, 100.05, 99.95, 100.1, 100],
    ...overrides,
  };
}

function createHarness(price = 1000, previousClose = 1000) {
  let current = snapshot({ price, previousClose });
  const provider: MarketDataProvider = {
    getSnapshot: vi.fn(async () => current),
  };
  const alerts: RiskAlert[] = [];
  const unavailable: Array<{ symbol: string; reason: string }> = [];
  const assessments: unknown[] = [];
  const queued = new Set<string>();
  const pending = new Map<string, RiskAlert>();
  const delivered = new Set<string>();
  const deliveryFailures: Array<{ key: string; reason: string }> = [];
  const riskStates = new Map<string, RiskEpisodeState>();
  const latestExchangeTimestamps = new Map<string, Date>();
  const repository: MonitoringRepository = {
    listActiveStrategies: vi.fn(async () => [
      strategy,
      { ...strategy, id: 'inactive', active: false },
    ]),
    recordAssessment: vi.fn(async (_id, assessment, marketSnapshot) => {
      assessments.push(assessment);
      latestExchangeTimestamps.set(_id, marketSnapshot.exchangeTimestamp);
    }),
    getLatestExchangeTimestamp: vi.fn(
      async (id) => latestExchangeTimestamps.get(id) ?? null,
    ),
    getRiskEpisodeState: vi.fn(
      async (strategyId) => riskStates.get(strategyId) ?? null,
    ),
    saveRiskEpisodeState: vi.fn(async (strategyId, state) => {
      riskStates.set(strategyId, state);
    }),
    recordUnavailable: vi.fn(async (symbol, reason) => {
      unavailable.push({ symbol, reason });
    }),
    hasDeliveredOrQueuedAlert: vi.fn(async (key) => queued.has(key)),
    enqueueAlert: vi.fn(async (alert) => {
      queued.add(alert.idempotencyKey);
      pending.set(alert.idempotencyKey, alert);
      alerts.push(alert);
    }),
    listPendingAlerts: vi.fn(async () => [...pending.values()]),
    markAlertDelivered: vi.fn(async (key) => {
      pending.delete(key);
      delivered.add(key);
    }),
    markAlertSuppressed: vi.fn(async (key) => {
      pending.delete(key);
      delivered.add(key);
    }),
    recordAlertDeliveryFailure: vi.fn(async (key, reason) => {
      deliveryFailures.push({ key, reason });
    }),
  };
  const dispatcher = { dispatch: vi.fn(async (_alert: RiskAlert) => {}) };
  const monitor = new RiskMonitor(provider, repository, dispatcher, {
    now: () => now,
  });

  return {
    monitor,
    provider,
    repository,
    dispatcher,
    alerts,
    unavailable,
    assessments,
    pending,
    delivered,
    deliveryFailures,
    riskStates,
    latestExchangeTimestamps,
    setSnapshot: (next: MarketSnapshot) => {
      current = next;
    },
  };
}

describe('Snapshot validation rejects stale and invalid market data', () => {
  it('accepts fresh snapshots with source and timestamps', () => {
    expect(validateSnapshot(snapshot(), now).valid).toBe(true);
  });

  it('rejects stale prices instead of recording a normal risk assessment', async () => {
    const harness = createHarness();
    harness.setSnapshot(
      snapshot({ fetchedAt: new Date(now.getTime() - 11 * 60 * 1000) }),
    );
    await harness.monitor.runOnce();

    expect(harness.unavailable[0]?.reason).toBe('snapshot is stale');
    expect(harness.assessments).toHaveLength(0);
    expect(harness.alerts).toHaveLength(0);
  });

  it("applies each strategy's configured thresholds during monitoring", async () => {
    const harness = createHarness(1080);
    vi.mocked(harness.repository.listActiveStrategies).mockResolvedValueOnce([
      {
        ...strategy,
        thresholds: {
          cautionPercent: 5,
          criticalPercent: 7,
          breachedPercent: 9,
        },
      },
    ]);

    await harness.monitor.runOnce();

    expect(harness.repository.recordAssessment).toHaveBeenCalledWith(
      strategy.id,
      expect.objectContaining({ level: 'critical' }),
      expect.anything(),
    );
    expect(harness.alerts.some((alert) => alert.kind === 'critical')).toBe(
      true,
    );
  });

  it('does not request prices or emit alerts for strategies past expiry', async () => {
    const harness = createHarness(1120);
    vi.mocked(harness.repository.listActiveStrategies).mockResolvedValueOnce([
      { ...strategy, expiryDate: '2026-10-19' },
    ]);

    await harness.monitor.runOnce();

    expect(harness.provider.getSnapshot).not.toHaveBeenCalled();
    expect(harness.repository.recordAssessment).not.toHaveBeenCalled();
    expect(harness.alerts).toHaveLength(0);
  });

  it('keeps a strategy eligible throughout its expiry date in India', async () => {
    const harness = createHarness();
    vi.mocked(harness.repository.listActiveStrategies).mockResolvedValueOnce([
      { ...strategy, expiryDate: '2026-10-20' },
    ]);

    await harness.monitor.runOnce();

    expect(harness.provider.getSnapshot).toHaveBeenCalledWith('RELIANCE');
    expect(harness.repository.recordAssessment).toHaveBeenCalledOnce();
  });

  it('fails closed for malformed configured expiry dates', async () => {
    for (const expiryDate of ['not-a-date', '2026-02-30']) {
      const harness = createHarness();
      vi.mocked(harness.repository.listActiveStrategies).mockResolvedValueOnce([
        { ...strategy, expiryDate },
      ]);

      await harness.monitor.runOnce();

      expect(harness.provider.getSnapshot).not.toHaveBeenCalled();
      expect(harness.repository.recordAssessment).not.toHaveBeenCalled();
    }
  });

  it('rejects an exchange snapshot older than the last persisted assessment', async () => {
    const harness = createHarness(1120);
    harness.latestExchangeTimestamps.set(
      strategy.id,
      new Date(now.getTime() + 60 * 1000),
    );

    await harness.monitor.runOnce();

    expect(harness.repository.recordAssessment).not.toHaveBeenCalled();
    expect(harness.alerts).toHaveLength(0);
    expect(harness.unavailable).toContainEqual({
      symbol: 'RELIANCE',
      reason: 'snapshot is out of order',
    });
    expect(harness.monitor.getMarketDataDiagnostics(now)[0]).toMatchObject({
      symbol: 'RELIANCE',
      status: 'invalid',
      reason: 'snapshot is out of order',
    });
  });

  it('records source timestamps and age for a fresh market snapshot', async () => {
    const harness = createHarness();
    await harness.monitor.runOnce();

    expect(harness.monitor.getMarketDataDiagnostics(now)).toEqual([
      {
        symbol: 'RELIANCE',
        status: 'fresh',
        source: 'deterministic-test-provider',
        fetchedAt: now.toISOString(),
        exchangeTimestamp: now.toISOString(),
        lastCheckedAt: now.toISOString(),
        ageMs: 0,
        reason: null,
      },
    ]);
  });

  it('reports stale and unavailable market data without exposing provider errors', async () => {
    const staleHarness = createHarness();
    staleHarness.setSnapshot(
      snapshot({ fetchedAt: new Date(now.getTime() - 11 * 60 * 1000) }),
    );
    await staleHarness.monitor.runOnce();
    expect(staleHarness.monitor.getMarketDataDiagnostics(now)[0]).toMatchObject(
      {
        symbol: 'RELIANCE',
        status: 'stale',
        reason: 'snapshot is stale',
        ageMs: 11 * 60 * 1000,
      },
    );

    const unavailableHarness = createHarness();
    vi.mocked(unavailableHarness.provider.getSnapshot).mockRejectedValueOnce(
      new Error('secret provider response'),
    );
    await unavailableHarness.monitor.runOnce();
    expect(
      unavailableHarness.monitor.getMarketDataDiagnostics(now)[0],
    ).toMatchObject({
      symbol: 'RELIANCE',
      status: 'unavailable',
      reason: 'market data provider failed',
      source: null,
      ageMs: null,
    });
    expect(
      JSON.stringify(unavailableHarness.monitor.getMarketDataDiagnostics(now)),
    ).not.toContain('secret provider response');
  });

  it('rejects stale exchange data even when it was just fetched', () => {
    const staleExchangeTime = new Date(now.getTime() - 11 * 60 * 1000);
    expect(
      validateSnapshot(
        snapshot({ exchangeTimestamp: staleExchangeTime, fetchedAt: now }),
        now,
      ),
    ).toEqual({ valid: false, reason: 'snapshot is stale' });
  });

  it('rejects a non-finite price', () => {
    expect(validateSnapshot(snapshot({ price: Number.NaN }), now)).toEqual({
      valid: false,
      reason: 'price must be positive and finite',
    });
  });
});
describe('RiskMonitor — business outcomes', () => {
  it('records but does not dispatch alerts for muted strategies', async () => {
    const harness = createHarness(1100);
    vi.mocked(harness.repository.listActiveStrategies).mockResolvedValue([
      { ...strategy, notificationsEnabled: false },
    ]);
    await harness.monitor.runOnce();

    expect(harness.alerts.some((alert) => alert.kind === 'critical')).toBe(
      true,
    );
    expect(harness.dispatcher.dispatch).not.toHaveBeenCalled();
    expect(harness.repository.markAlertSuppressed).toHaveBeenCalled();
  });

  it('emits caution, then critical, but not duplicates on repeated polling', async () => {
    const harness = createHarness(1080);
    await harness.monitor.runOnce();
    await harness.monitor.runOnce();
    expect(harness.alerts.filter((a) => a.kind === 'caution')).toHaveLength(1);

    harness.setSnapshot(snapshot({ price: 1100 }));
    await harness.monitor.runOnce();
    await harness.monitor.runOnce();
    expect(harness.alerts.filter((a) => a.kind === 'critical')).toHaveLength(1);
  });

  it('emits a new risk episode after price recovers to normal and crosses again', async () => {
    const harness = createHarness(1080);
    await harness.monitor.runOnce();
    harness.setSnapshot(snapshot({ price: 1000 }));
    await harness.monitor.runOnce();
    harness.setSnapshot(snapshot({ price: 1080 }));
    await harness.monitor.runOnce();

    expect(harness.alerts.filter((a) => a.kind === 'caution')).toHaveLength(2);
  });

  it('starts a new persisted risk episode after a recovery across monitor restart', async () => {
    const harness = createHarness(1080);
    await harness.monitor.runOnce();

    const restartedMonitor = new RiskMonitor(
      harness.provider,
      harness.repository,
      harness.dispatcher,
      { now: () => now },
    );
    harness.setSnapshot(snapshot({ price: 1000 }));
    await restartedMonitor.runOnce();
    harness.setSnapshot(snapshot({ price: 1080 }));
    await restartedMonitor.runOnce();

    expect(harness.alerts.filter((a) => a.kind === 'caution')).toHaveLength(2);
    expect(harness.riskStates.get(strategy.id)?.episode).toBe(2);
  });

  it('records an unavailable provider result and continues without alerting', async () => {
    const harness = createHarness();
    vi.mocked(harness.provider.getSnapshot).mockRejectedValueOnce(
      new Error('provider offline'),
    );
    await harness.monitor.runOnce();

    expect(harness.unavailable[0]?.reason).toBe('market data provider failed');
    expect(harness.alerts).toHaveLength(0);
  });

  it('signals a daily movement at the exact ±2.5% threshold', async () => {
    const harness = createHarness(1025, 1000);
    await harness.monitor.runOnce();

    expect(harness.alerts.some((a) => a.kind === 'daily-move')).toBe(true);
  });

  it('deduplicates the same daily-move signal across repeated polls', async () => {
    const harness = createHarness(1025, 1000);
    await harness.monitor.runOnce();
    await harness.monitor.runOnce();

    expect(harness.alerts.filter((a) => a.kind === 'daily-move')).toHaveLength(
      1,
    );
  });

  it('warns when historical one-standard-deviation move reaches a boundary', async () => {
    const harness = createHarness(900, 900);
    harness.setSnapshot(
      snapshot({
        price: 900,
        previousClose: 900,
        historicalCloses: [100, 110, 90, 120, 80, 130, 70],
      }),
    );
    await harness.monitor.runOnce();

    expect(harness.alerts.some((a) => a.kind === 'volatility-warning')).toBe(
      true,
    );
  });

  it('does not calculate volatility with too little history', async () => {
    const harness = createHarness(1000, 1000);
    harness.setSnapshot(snapshot({ historicalCloses: [100, 101, 102] }));
    await harness.monitor.runOnce();

    expect(harness.alerts.some((a) => a.kind === 'volatility-warning')).toBe(
      false,
    );
  });

  it('does not warn when historical returns have zero variance', async () => {
    const harness = createHarness(1000, 1000);
    harness.setSnapshot(
      snapshot({ historicalCloses: [100, 100, 100, 100, 100, 100, 100] }),
    );
    await harness.monitor.runOnce();

    expect(harness.alerts.some((a) => a.kind === 'volatility-warning')).toBe(
      false,
    );
  });

  it('signals a daily drop at the negative threshold', async () => {
    const harness = createHarness(975, 1000);
    await harness.monitor.runOnce();

    expect(
      harness.alerts.some(
        (a) => a.kind === 'daily-move' && a.movementPercent < 0,
      ),
    ).toBe(true);
  });

  it('records an invalid strategy entry without creating a risk alert', async () => {
    const harness = createHarness();
    vi.mocked(harness.repository.listActiveStrategies).mockResolvedValueOnce([
      { ...strategy, entryPrice: 0 },
    ]);
    await harness.monitor.runOnce();

    expect(harness.unavailable[0]?.reason).toBe('strategy entry is invalid');
    expect(harness.alerts).toHaveLength(0);
  });

  it('does not signal daily movement below the threshold', async () => {
    const harness = createHarness(1024.99, 1000);
    await harness.monitor.runOnce();

    expect(harness.alerts.some((a) => a.kind === 'daily-move')).toBe(false);
  });

  it('does not run strategies that are inactive', async () => {
    const harness = createHarness();
    await harness.monitor.runOnce();

    expect(harness.repository.recordAssessment).toHaveBeenCalledTimes(1);
  });

  it('retries a queued alert after a delivery failure on the next polling cycle', async () => {
    const harness = createHarness(1080, 1080);
    vi.mocked(harness.dispatcher.dispatch)
      .mockRejectedValueOnce(new Error('Telegram temporarily unavailable'))
      .mockResolvedValueOnce(undefined);

    await harness.monitor.runOnce();
    expect(harness.deliveryFailures).toHaveLength(1);
    expect(harness.pending.size).toBe(1);
    expect(harness.monitor.getNotificationDeliveryDiagnostics()).toEqual({
      lastAttemptAt: now.toISOString(),
      lastDeliveredAt: null,
      lastFailureAt: now.toISOString(),
      consecutiveFailures: 1,
      totalFailures: 1,
      lastFailureReason: 'notification delivery failed',
    });

    await harness.monitor.runOnce();
    expect(harness.dispatcher.dispatch).toHaveBeenCalledTimes(2);
    expect(harness.pending.size).toBe(0);
    expect(harness.delivered.size).toBe(1);
    expect(harness.monitor.getNotificationDeliveryDiagnostics()).toEqual({
      lastAttemptAt: now.toISOString(),
      lastDeliveredAt: now.toISOString(),
      lastFailureAt: now.toISOString(),
      consecutiveFailures: 0,
      totalFailures: 1,
      lastFailureReason: null,
    });
    expect(harness.deliveryFailures[0]?.reason).toBe(
      'notification delivery failed',
    );
  });

  it('uses the current clock when no clock is injected', async () => {
    const harness = createHarness();
    const current = new Date();
    harness.setSnapshot(
      snapshot({ fetchedAt: current, exchangeTimestamp: current }),
    );
    const monitor = new RiskMonitor(
      harness.provider,
      harness.repository,
      harness.dispatcher,
    );

    await monitor.runOnce();
    expect(harness.assessments).toHaveLength(1);
  });

  it('records assessment for a fresh snapshot even when no risk alert is needed', async () => {
    const harness = createHarness(1005);
    await harness.monitor.runOnce();

    expect(harness.assessments).toHaveLength(1);
    expect(
      harness.alerts.some(
        (a) =>
          a.kind === 'caution' ||
          a.kind === 'critical' ||
          a.kind === 'breached',
      ),
    ).toBe(false);
  });
});

describe('Indian equity market schedule', () => {
  it('opens on a weekday from 09:15 through 15:30 IST', () => {
    expect(isIndianEquityMarketOpen(new Date('2026-10-20T03:45:00.000Z'))).toBe(
      true,
    );
    expect(isIndianEquityMarketOpen(new Date('2026-10-20T10:00:00.000Z'))).toBe(
      true,
    );
    expect(isIndianEquityMarketOpen(new Date('2026-10-20T10:01:00.000Z'))).toBe(
      false,
    );
  });

  it('does not run on weekends', () => {
    expect(isIndianEquityMarketOpen(new Date('2026-10-24T04:00:00.000Z'))).toBe(
      false,
    );
  });

  it('skips configured exchange holidays', () => {
    expect(
      isIndianEquityMarketOpen(new Date('2026-10-20T04:00:00.000Z'), {
        holidays: ['2026-10-20'],
      }),
    ).toBe(false);
  });

  it('loads comma-separated exchange holidays from server configuration', () => {
    vi.stubEnv('FOPLAYER_MARKET_HOLIDAYS', '2026-10-20, 2026-10-21');
    try {
      expect(
        isIndianEquityMarketOpen(new Date('2026-10-20T04:00:00.000Z')),
      ).toBe(false);
      expect(
        isIndianEquityMarketOpen(new Date('2026-10-21T04:00:00.000Z')),
      ).toBe(false);
      expect(
        isIndianEquityMarketOpen(new Date('2026-10-22T04:00:00.000Z')),
      ).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('fails closed when the configured holiday list contains an invalid date', () => {
    vi.stubEnv('FOPLAYER_MARKET_HOLIDAYS', '2026-10-20,2026-02-30');
    try {
      expect(
        isIndianEquityMarketOpen(new Date('2026-10-22T04:00:00.000Z')),
      ).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('loads configured special sessions from server configuration', () => {
    vi.stubEnv(
      'FOPLAYER_MARKET_SPECIAL_SESSIONS',
      '{"2026-10-24":{"open":"18:00","close":"19:00"}}',
    );
    try {
      expect(
        isIndianEquityMarketOpen(new Date('2026-10-24T12:30:00.000Z')),
      ).toBe(true);
      expect(
        isIndianEquityMarketOpen(new Date('2026-10-24T12:00:00.000Z')),
      ).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('fails closed for malformed special-session JSON, dates, or times', () => {
    for (const value of [
      '{bad-json',
      '{"2026-02-30":{"open":"18:00","close":"19:00"}}',
      '{"2026-10-24":{"open":"19:00","close":"18:00"}}',
      '{"2026-10-24":{"open":"25:00","close":"26:00"}}',
    ]) {
      vi.stubEnv('FOPLAYER_MARKET_SPECIAL_SESSIONS', value);
      try {
        expect(
          isIndianEquityMarketOpen(new Date('2026-10-24T12:30:00.000Z')),
        ).toBe(false);
      } finally {
        vi.unstubAllEnvs();
      }
    }
  });

  it('supports a special session outside normal hours, including weekends', () => {
    expect(
      isIndianEquityMarketOpen(new Date('2026-10-24T12:30:00.000Z'), {
        specialSessions: {
          '2026-10-24': { open: '18:00', close: '19:00' },
        },
      }),
    ).toBe(true);
    expect(
      isIndianEquityMarketOpen(new Date('2026-10-24T12:00:00.000Z'), {
        specialSessions: {
          '2026-10-24': { open: '18:00', close: '19:00' },
        },
      }),
    ).toBe(false);
  });

  it('supports configured opening and closing times and fails closed on invalid clocks', () => {
    expect(
      isIndianEquityMarketOpen(new Date('2026-10-20T03:35:00.000Z'), {
        openingTime: '09:00',
        closingTime: '14:00',
      }),
    ).toBe(true);
    expect(
      isIndianEquityMarketOpen(new Date('2026-10-20T03:35:00.000Z'), {
        openingTime: 'bad',
      }),
    ).toBe(false);
  });
});

describe('PollingWorker', () => {
  it('does not poll outside the configured monitoring window', async () => {
    const runOnce = vi.fn(async () => {});
    const worker = new PollingWorker({ runOnce } as unknown as RiskMonitor, {
      now: () => now,
      isMonitoringWindow: () => false,
    });

    await worker.tick();
    expect(runOnce).not.toHaveBeenCalled();
    expect(worker.getDiagnostics()).toMatchObject({
      started: false,
      running: false,
      lastCycleStartedAt: null,
      lastCycleCompletedAt: null,
      lastCycleStatus: 'skipped_outside_market_hours',
      consecutiveFailures: 0,
      lastCycleFailureAt: null,
      lastSuccessfulCycleAt: null,
      lastRecoveryAt: null,
    });
  });

  it('records successful cycle timestamps and clears the failure streak', async () => {
    const runOnce = vi.fn(async () => {});
    const times = [
      new Date('2026-10-20T04:00:00.000Z'),
      new Date('2026-10-20T04:00:03.000Z'),
    ];
    const worker = new PollingWorker({ runOnce } as unknown as RiskMonitor, {
      now: () => times.shift() ?? new Date('2026-10-20T04:00:03.000Z'),
      isMonitoringWindow: () => true,
    });

    await worker.tick();

    expect(worker.getDiagnostics()).toEqual({
      started: false,
      running: false,
      lastCycleStartedAt: '2026-10-20T04:00:00.000Z',
      lastCycleCompletedAt: '2026-10-20T04:00:03.000Z',
      lastCycleStatus: 'succeeded',
      consecutiveFailures: 0,
      lastCycleFailureAt: null,
      lastSuccessfulCycleAt: '2026-10-20T04:00:03.000Z',
      lastRecoveryAt: null,
    });
  });

  it('records failed cycles without leaking the error message and resets after recovery', async () => {
    const runOnce = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('sensitive provider detail'))
      .mockResolvedValueOnce(undefined);
    const worker = new PollingWorker({ runOnce } as unknown as RiskMonitor, {
      now: () => now,
      isMonitoringWindow: () => true,
    });

    await expect(worker.tick()).rejects.toThrow('sensitive provider detail');
    expect(worker.getDiagnostics()).toMatchObject({
      running: false,
      lastCycleStatus: 'failed',
      consecutiveFailures: 1,
      lastCycleFailureAt: now.toISOString(),
      lastSuccessfulCycleAt: null,
      lastRecoveryAt: null,
    });

    await worker.tick();
    expect(worker.getDiagnostics()).toMatchObject({
      running: false,
      lastCycleStatus: 'succeeded',
      consecutiveFailures: 0,
      lastCycleFailureAt: now.toISOString(),
      lastSuccessfulCycleAt: now.toISOString(),
      lastRecoveryAt: now.toISOString(),
    });
  });

  it('prevents overlapping poll cycles', async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const runOnce = vi.fn(() => pending);
    const worker = new PollingWorker({ runOnce } as unknown as RiskMonitor, {
      now: () => now,
      isMonitoringWindow: () => true,
    });

    const first = worker.tick();
    await Promise.resolve();
    await worker.tick();
    expect(runOnce).toHaveBeenCalledOnce();
    finish();
    await first;
  });

  it('starts only one timer and stops future polls', async () => {
    vi.useFakeTimers();
    try {
      const runOnce = vi.fn(async () => {});
      const worker = new PollingWorker({ runOnce } as unknown as RiskMonitor, {
        intervalMs: 1000,
        now: () => now,
        isMonitoringWindow: () => true,
      });

      worker.start();
      worker.start();
      await vi.advanceTimersByTimeAsync(1000);
      expect(runOnce).toHaveBeenCalledOnce();

      worker.stop();
      await vi.advanceTimersByTimeAsync(2000);
      expect(runOnce).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a scheduled failure and retries on the next interval', async () => {
    vi.useFakeTimers();
    try {
      const runOnce = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(new Error('temporary provider failure'))
        .mockResolvedValue(undefined);
      const onError = vi.fn();
      const worker = new PollingWorker({ runOnce } as unknown as RiskMonitor, {
        intervalMs: 1000,
        now: () => now,
        isMonitoringWindow: () => true,
        onError,
      });

      worker.start();
      await vi.advanceTimersByTimeAsync(1000);
      expect(runOnce).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'temporary provider failure' }),
      );

      await vi.advanceTimersByTimeAsync(1000);
      expect(runOnce).toHaveBeenCalledTimes(2);
      expect(onError).toHaveBeenCalledOnce();
      worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('PollingWorker default clock', () => {
  it('uses the current clock when no clock override is provided', async () => {
    const runOnce = vi.fn(async () => {});
    const worker = new PollingWorker({ runOnce } as unknown as RiskMonitor, {
      isMonitoringWindow: () => true,
    });

    await worker.tick();
    expect(runOnce).toHaveBeenCalledOnce();
  });
});
