import {
  assessRisk,
  type RiskAssessment,
  type SupportedSymbol,
  type RiskThresholds,
} from './risk-engine.js';
import type { MarketDataProvider, MarketSnapshot } from './market-data.js';
import { validateSnapshot, DEFAULT_FRESHNESS_POLICY } from './market-data.js';

export interface Strategy {
  id: string;
  symbol: SupportedSymbol;
  entryPrice: number;
  active: boolean;
  ownerUid?: string;
  expiryDate?: string;
  thresholds?: RiskThresholds;
  notificationsEnabled?: boolean;
}

export type AlertKind =
  | 'caution'
  | 'critical'
  | 'breached'
  | 'volatility-warning'
  | 'daily-move';

export interface RiskAlert {
  idempotencyKey: string;
  ownerUid?: string;
  strategyId: string;
  symbol: SupportedSymbol;
  kind: AlertKind;
  message: string;
  price: number;
  movementPercent: number;
  createdAt: Date;
  notificationsEnabled?: boolean;
}

export interface AlertDispatcher {
  dispatch(alert: RiskAlert): Promise<void>;
}

export interface RiskEpisodeState {
  episode: number;
  highestSeverity: number;
}

export interface MonitoringRepository {
  listActiveStrategies(): Promise<Strategy[]>;
  recordAssessment(
    strategyId: string,
    assessment: RiskAssessment,
    snapshot: MarketSnapshot,
  ): Promise<void>;
  getRiskEpisodeState(strategyId: string): Promise<RiskEpisodeState | null>;
  saveRiskEpisodeState(
    strategyId: string,
    state: RiskEpisodeState,
  ): Promise<void>;
  recordUnavailable(
    symbol: SupportedSymbol,
    reason: string,
    checkedAt: Date,
  ): Promise<void>;
  hasDeliveredOrQueuedAlert(idempotencyKey: string): Promise<boolean>;
  enqueueAlert(alert: RiskAlert): Promise<void>;
  listPendingAlerts(): Promise<RiskAlert[]>;
  markAlertDelivered(idempotencyKey: string, deliveredAt: Date): Promise<void>;
  markAlertSuppressed(
    idempotencyKey: string,
    suppressedAt: Date,
  ): Promise<void>;
  recordAlertDeliveryFailure(
    idempotencyKey: string,
    reason: string,
    failedAt: Date,
  ): Promise<void>;
}

export interface MonitorOptions {
  now?: () => Date;
  maxSnapshotAgeMs?: number;
  minimumHistoryCloses?: number;
  dailyMoveThresholdPercent?: number;
}

const severity = { normal: 0, caution: 1, critical: 2, breached: 3 } as const;

export class RiskMonitor {
  private readonly riskEpisodeCache = new Map<string, RiskEpisodeState>();
  private readonly emittedNonRiskSignals = new Set<string>();
  private readonly now: () => Date;
  private readonly maxSnapshotAgeMs: number;
  private readonly minimumHistoryCloses: number;
  private readonly dailyMoveThresholdPercent: number;

  constructor(
    private readonly provider: MarketDataProvider,
    private readonly repository: MonitoringRepository,
    private readonly dispatcher: AlertDispatcher,
    options: MonitorOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.maxSnapshotAgeMs =
      options.maxSnapshotAgeMs ?? DEFAULT_FRESHNESS_POLICY.maxAgeMs;
    this.minimumHistoryCloses = options.minimumHistoryCloses ?? 6;
    this.dailyMoveThresholdPercent = options.dailyMoveThresholdPercent ?? 2.5;
  }

  async runOnce(): Promise<void> {
    const cycleStartedAt = this.now();
    const strategies = (await this.repository.listActiveStrategies()).filter(
      (strategy) =>
        strategy.active && !isExpiredStrategy(strategy, cycleStartedAt),
    );
    const symbols = [...new Set(strategies.map((s) => s.symbol))];

    for (const symbol of symbols) {
      const checkedAt = this.now();
      let snapshot: MarketSnapshot;
      try {
        snapshot = await this.provider.getSnapshot(symbol);
      } catch {
        await this.repository.recordUnavailable(
          symbol,
          'market data provider failed',
          checkedAt,
        );
        continue;
      }

      const validation = validateSnapshot(snapshot, checkedAt, {
        maxAgeMs: this.maxSnapshotAgeMs,
        maxFutureSkewMs: DEFAULT_FRESHNESS_POLICY.maxFutureSkewMs,
      });
      if (!validation.valid) {
        await this.repository.recordUnavailable(
          symbol,
          validation.reason,
          checkedAt,
        );
        continue;
      }

      const symbolStrategies = strategies.filter(
        (strategy) => strategy.symbol === symbol,
      );
      for (const strategy of symbolStrategies) {
        let assessment: RiskAssessment;
        try {
          assessment = assessRisk({
            symbol,
            entryPrice: strategy.entryPrice,
            spotPrice: snapshot.price,
            ...(strategy.thresholds !== undefined
              ? { thresholds: strategy.thresholds }
              : {}),
          });
        } catch {
          await this.repository.recordUnavailable(
            symbol,
            'strategy entry is invalid',
            checkedAt,
          );
          continue;
        }
        await this.repository.recordAssessment(
          strategy.id,
          assessment,
          snapshot,
        );
        await this.evaluateRiskAlert(strategy, assessment, checkedAt);
        await this.evaluateVolatility(
          strategy,
          snapshot,
          assessment,
          checkedAt,
        );
        await this.evaluateDailyMove(strategy, snapshot, checkedAt);
      }
    }
    await this.flushPendingAlerts();
  }

  private async flushPendingAlerts(): Promise<void> {
    const pending = await this.repository.listPendingAlerts();
    for (const alert of pending) {
      if (alert.notificationsEnabled === false) {
        await this.repository.markAlertSuppressed(
          alert.idempotencyKey,
          this.now(),
        );
        continue;
      }
      try {
        await this.dispatcher.dispatch(alert);
        await this.repository.markAlertDelivered(
          alert.idempotencyKey,
          this.now(),
        );
      } catch (error) {
        const reason =
          error instanceof Error ? error.message : 'unknown delivery error';
        await this.repository.recordAlertDeliveryFailure(
          alert.idempotencyKey,
          reason,
          this.now(),
        );
      }
    }
  }

  private async evaluateRiskAlert(
    strategy: Strategy,
    assessment: RiskAssessment,
    now: Date,
  ): Promise<void> {
    const state = await this.getRiskEpisodeState(strategy.id);
    const level = severity[assessment.level];

    if (level === 0) {
      if (state.highestSeverity > 0) {
        const recovered = {
          episode: state.episode + 1,
          highestSeverity: 0,
        };
        await this.repository.saveRiskEpisodeState(strategy.id, recovered);
        this.riskEpisodeCache.set(strategy.id, recovered);
      }
      return;
    }
    if (level <= state.highestSeverity) return;

    const kind = assessment.level as Extract<
      AlertKind,
      'caution' | 'critical' | 'breached'
    >;
    await this.queueAlert({
      idempotencyKey: `risk:${strategy.id}:episode-${state.episode}:${kind}`,
      strategyId: strategy.id,
      symbol: strategy.symbol,
      kind,
      message:
        `${strategy.symbol} ${kind}: movement ` +
        `${assessment.movementPercent.toFixed(2)}% from entry.`,
      price: assessment.spotPrice,
      movementPercent: assessment.movementPercent,
      createdAt: now,
      notificationsEnabled: strategy.notificationsEnabled !== false,
    });

    const nextState = { ...state, highestSeverity: level };
    await this.repository.saveRiskEpisodeState(strategy.id, nextState);
    this.riskEpisodeCache.set(strategy.id, nextState);
  }

  private async getRiskEpisodeState(
    strategyId: string,
  ): Promise<RiskEpisodeState> {
    const cached = this.riskEpisodeCache.get(strategyId);
    if (cached) return cached;
    const persisted = await this.repository.getRiskEpisodeState(strategyId);
    const state = persisted ?? { episode: 1, highestSeverity: 0 };
    this.riskEpisodeCache.set(strategyId, state);
    return state;
  }

  private async evaluateVolatility(
    strategy: Strategy,
    snapshot: MarketSnapshot,
    assessment: RiskAssessment,
    now: Date,
  ): Promise<void> {
    const closes = snapshot.historicalCloses;
    if (closes.length < this.minimumHistoryCloses) return;

    const returns: number[] = [];
    for (let i = 1; i < closes.length; i += 1) {
      const previous = closes[i - 1]!;
      const current = closes[i]!;
      returns.push((current - previous) / previous);
    }
    if (returns.length < this.minimumHistoryCloses - 1) return;

    const mean =
      returns.reduce((sum, value) => sum + value, 0) / returns.length;
    const variance =
      returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
      (returns.length - 1);
    const dailyStdDev = Math.sqrt(variance);
    if (!Number.isFinite(dailyStdDev) || dailyStdDev <= 0) return;

    const projectedLow = snapshot.price * (1 - dailyStdDev);
    const projectedHigh = snapshot.price * (1 + dailyStdDev);
    const intersectsBoundary =
      projectedLow <= assessment.lowerBoundary ||
      projectedHigh >= assessment.upperBoundary;
    const signalKey = `volatility:${strategy.id}:${now.toISOString().slice(0, 10)}`;
    if (!intersectsBoundary || this.emittedNonRiskSignals.has(signalKey)) {
      return;
    }
    await this.queueAlert({
      idempotencyKey: signalKey,
      strategyId: strategy.id,
      symbol: strategy.symbol,
      kind: 'volatility-warning',
      message:
        `${strategy.symbol}: historical one-standard-deviation daily move ` +
        'may intersect a ±12% boundary.',
      price: snapshot.price,
      movementPercent: assessment.movementPercent,
      createdAt: now,
      notificationsEnabled: strategy.notificationsEnabled !== false,
    });
    this.emittedNonRiskSignals.add(signalKey);
  }

  private async evaluateDailyMove(
    strategy: Strategy,
    snapshot: MarketSnapshot,
    now: Date,
  ): Promise<void> {
    const movement =
      ((snapshot.price - snapshot.previousClose) / snapshot.previousClose) *
      100;
    if (Math.abs(movement) < this.dailyMoveThresholdPercent) return;
    const direction = movement >= 0 ? 'up' : 'down';
    const signalKey = [
      'daily-move',
      strategy.id,
      now.toISOString().slice(0, 10),
      direction,
    ].join(':');
    if (this.emittedNonRiskSignals.has(signalKey)) return;
    await this.queueAlert({
      idempotencyKey: signalKey,
      strategyId: strategy.id,
      symbol: strategy.symbol,
      kind: 'daily-move',
      message:
        `${strategy.symbol}: daily move ${movement.toFixed(2)}% exceeds ` +
        `the configured ±${this.dailyMoveThresholdPercent}% signal ` +
        'threshold; ' +
        'this is not a trade recommendation.',
      price: snapshot.price,
      movementPercent: movement,
      createdAt: now,
      notificationsEnabled: strategy.notificationsEnabled !== false,
    });
    this.emittedNonRiskSignals.add(signalKey);
  }

  private async queueAlert(alert: RiskAlert): Promise<void> {
    if (await this.repository.hasDeliveredOrQueuedAlert(alert.idempotencyKey)) {
      return;
    }
    await this.repository.enqueueAlert(alert);
  }
}

export interface MarketSession {
  open: string;
  close: string;
}

export interface MarketHoursPolicy {
  openingTime?: string;
  closingTime?: string;
  holidays?: readonly string[];
  specialSessions?: Readonly<Record<string, MarketSession>>;
}

export function isIndianEquityMarketOpen(
  now: Date,
  policy?: MarketHoursPolicy,
): boolean {
  if (!Number.isFinite(now.getTime())) return false;
  // The worker uses this environment-driven policy by default. An invalid
  // holiday list fails closed so a typo cannot silently enable holiday polling.
  const effectivePolicy = policy ?? marketHoursPolicyFromEnvironment();
  if (effectivePolicy === null) return false;
  policy = effectivePolicy;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  const dateKey = `${values.year}-${values.month}-${values.day}`;
  const specialSession = policy.specialSessions?.[dateKey];
  if (!specialSession) {
    if (values.weekday === 'Sat' || values.weekday === 'Sun') return false;
    if (policy.holidays?.includes(dateKey)) return false;
  }

  const openingTime = specialSession?.open ?? policy.openingTime ?? '09:15';
  const closingTime = specialSession?.close ?? policy.closingTime ?? '15:30';
  const openingMinutes = parseMarketClock(openingTime);
  const closingMinutes = parseMarketClock(closingTime);
  if (
    openingMinutes === null ||
    closingMinutes === null ||
    openingMinutes > closingMinutes
  ) {
    return false;
  }
  const hour = Number(values.hour);
  const minute = Number(values.minute);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return false;
  const localMinutes = hour * 60 + minute;
  return localMinutes >= openingMinutes && localMinutes <= closingMinutes;
}

export function marketHoursPolicyFromEnvironment(): MarketHoursPolicy | null {
  const configuredOpening = process.env.FOPLAYER_MARKET_OPEN?.trim();
  const configuredClosing = process.env.FOPLAYER_MARKET_CLOSE?.trim();
  const openingTime = configuredOpening || undefined;
  const closingTime = configuredClosing || undefined;
  const openingMinutes = parseMarketClock(openingTime ?? '09:15');
  const closingMinutes = parseMarketClock(closingTime ?? '15:30');
  if (
    openingMinutes === null ||
    closingMinutes === null ||
    openingMinutes > closingMinutes
  ) {
    return null;
  }

  const configuredHolidays = process.env.FOPLAYER_MARKET_HOLIDAYS?.trim();
  const holidays = configuredHolidays
    ? configuredHolidays.split(',').map((date) => date.trim())
    : [];
  if (holidays.some((date) => !isIsoCalendarDate(date))) return null;

  const configuredSessions =
    process.env.FOPLAYER_MARKET_SPECIAL_SESSIONS?.trim();
  let specialSessions: Record<string, MarketSession> | undefined;
  if (configuredSessions) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(configuredSessions);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    specialSessions = {};
    for (const [date, session] of Object.entries(parsed)) {
      if (
        !isIsoCalendarDate(date) ||
        !session ||
        typeof session !== 'object' ||
        Array.isArray(session) ||
        !('open' in session) ||
        !('close' in session) ||
        typeof session.open !== 'string' ||
        typeof session.close !== 'string'
      ) {
        return null;
      }
      const open = parseMarketClock(session.open);
      const close = parseMarketClock(session.close);
      if (open === null || close === null || open > close) return null;
      specialSessions[date] = { open: session.open, close: session.close };
    }
  }

  return {
    ...(openingTime ? { openingTime } : {}),
    ...(closingTime ? { closingTime } : {}),
    ...(holidays.length > 0 ? { holidays } : {}),
    ...(specialSessions ? { specialSessions } : {}),
  };
}

function parseMarketClock(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

export interface PollingWorkerOptions {
  intervalMs?: number;
  isMonitoringWindow?: (now: Date) => boolean;
  now?: () => Date;
  onError?: (error: unknown) => void;
}

export type PollingCycleStatus =
  | 'never_run'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped_outside_market_hours';

export interface PollingWorkerDiagnostics {
  started: boolean;
  running: boolean;
  lastCycleStartedAt: string | null;
  lastCycleCompletedAt: string | null;
  lastCycleStatus: PollingCycleStatus;
  consecutiveFailures: number;
}

export class PollingWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private lastCycleStartedAt: string | null = null;
  private lastCycleCompletedAt: string | null = null;
  private lastCycleStatus: PollingCycleStatus = 'never_run';
  private consecutiveFailures = 0;

  constructor(
    private readonly monitor: RiskMonitor,
    private readonly options: PollingWorkerOptions = {},
  ) {}

  getDiagnostics(): PollingWorkerDiagnostics {
    return {
      started: this.timer !== undefined,
      running: this.running,
      lastCycleStartedAt: this.lastCycleStartedAt,
      lastCycleCompletedAt: this.lastCycleCompletedAt,
      lastCycleStatus: this.lastCycleStatus,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  start(): void {
    if (this.timer) return;
    const intervalMs = this.options.intervalMs ?? 5 * 60 * 1000;
    this.timer = setInterval(() => {
      // A transient provider, Firestore, or notification failure must not
      // become an unhandled rejection that destabilizes the NestJS process.
      void this.tick().catch((error: unknown) => {
        if (this.options.onError) {
          this.options.onError(error);
        } else {
          console.error(
            'F&O monitoring cycle failed; will retry next interval.',
            error,
          );
        }
      });
    }, intervalMs);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    const now = this.options.now?.() ?? new Date();
    const isOpen = this.options.isMonitoringWindow ?? isIndianEquityMarketOpen;
    if (!isOpen(now)) {
      this.lastCycleStatus = 'skipped_outside_market_hours';
      return;
    }
    this.running = true;
    this.lastCycleStartedAt = now.toISOString();
    this.lastCycleStatus = 'running';
    try {
      await this.monitor.runOnce();
      this.lastCycleStatus = 'succeeded';
      this.consecutiveFailures = 0;
    } catch (error) {
      this.lastCycleStatus = 'failed';
      this.consecutiveFailures += 1;
      throw error;
    } finally {
      this.lastCycleCompletedAt = (this.options.now?.() ?? new Date()).toISOString();
      this.running = false;
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

function isExpiredStrategy(strategy: Strategy, now: Date): boolean {
  const expiryDate = strategy.expiryDate;
  if (expiryDate === undefined) return false;
  if (!isIsoCalendarDate(expiryDate)) return true;

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? '';
  const today = `${value('year')}-${value('month')}-${value('day')}`;
  // Expiry remains valid through the expiry date in the Indian market timezone.
  return expiryDate < today;
}

function isIsoCalendarDate(value: string): boolean {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}
