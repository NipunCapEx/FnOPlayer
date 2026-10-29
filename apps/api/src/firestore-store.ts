import { createHash } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { ConflictException, Injectable } from '@nestjs/common';
import {
  SUPPORTED_SYMBOLS,
  type SupportedSymbol,
  type RiskAssessment,
  type RiskThresholds,
} from './risk-engine.js';
import type { MarketSnapshot } from './market-data.js';
import type {
  MonitoringRepository,
  RiskAlert,
  RiskEpisodeState,
  Strategy,
} from './monitoring.js';
import { FirebaseAdminService } from './firebase-admin.service.js';
import type { DocumentSnapshotPort, FirestorePort } from './firestore-port.js';
import type { NotificationDeliveryStateStore } from './notifications.js';

export interface CreateStrategyInput {
  symbol: SupportedSymbol;
  entryPrice: number;
  active: boolean;
  entryDate?: string;
  expiryDate?: string;
  thresholds?: RiskThresholds;
  notificationsEnabled?: boolean;
}

export interface UpdateStrategyInput {
  entryPrice?: number;
  active?: boolean;
  entryDate?: string;
  expiryDate?: string;
  thresholds?: RiskThresholds;
  notificationsEnabled?: boolean;
}

export interface StrategyRecord extends Strategy {
  ownerUid: string;
  entryDate?: string;
  expiryDate?: string;
  thresholds?: RiskThresholds;
  notificationsEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface DashboardSnapshot {
  strategyId: string;
  assessment: RiskAssessment;
  source: string;
  exchangeTimestamp: Date;
  fetchedAt: Date;
  recordedAt: Date;
  historicalCloses: number[];
}

@Injectable()
export class FirestoreStrategyStore {
  constructor(private readonly firebase: FirebaseAdminService) {}

  async listForOwner(ownerUid: string): Promise<StrategyRecord[]> {
    try {
      const result = await this.db
        .collection('strategies')
        .where('ownerUid', '==', ownerUid)
        .get();
      return result.docs
        .map((doc) => toStrategyRecord(doc))
        .filter((value): value is StrategyRecord => value !== null);
    } catch (error) {
      // Do not log the UID, authorization header, document contents, or service
      // account material. Log only the operation and sanitized SDK error fields
      // so a deployed Firestore failure can be diagnosed from runtime logs.
      const details = describeFirestoreError(error);
      console.error(
        JSON.stringify({
          event: 'firestore_operation_failed',
          operation: 'list_strategies_for_owner',
          ...details,
        }),
      );
      throw error;
    }
  }

  async createForOwner(
    ownerUid: string,
    input: CreateStrategyInput,
  ): Promise<StrategyRecord> {
    const activeForSymbol = (await this.listForOwner(ownerUid)).find(
      (strategy) => strategy.active && strategy.symbol === input.symbol,
    );
    if (activeForSymbol) {
      throw new ConflictException(
        'an active strategy already exists for this symbol',
      );
    }

    // A stable owner+symbol document ID makes concurrent create requests
    // contend on the same Firestore document rather than creating duplicates.
    const reference = this.db
      .collection('strategies')
      .doc(strategyDocumentId(ownerUid, input.symbol));
    const current = toStrategyRecord(await reference.get());
    if (current) {
      if (current.ownerUid !== ownerUid || current.symbol !== input.symbol) {
        throw new ConflictException('strategy identity collision');
      }
      if (current.active) {
        throw new ConflictException(
          'an active strategy already exists for this symbol',
        );
      }
      const updatedAt = new Date();
      await reference.update({
        entryPrice: input.entryPrice,
        active: input.active,
        ...(input.notificationsEnabled !== undefined
          ? { notificationsEnabled: input.notificationsEnabled }
          : {}),
        ...(input.thresholds !== undefined
          ? { thresholds: input.thresholds }
          : {}),
        ...(input.entryDate !== undefined
          ? { entryDate: input.entryDate }
          : {}),
        ...(input.expiryDate !== undefined
          ? { expiryDate: input.expiryDate }
          : {}),
        updatedAt,
      });
      return {
        ...current,
        entryPrice: input.entryPrice,
        active: input.active,
        notificationsEnabled:
          input.notificationsEnabled ?? current.notificationsEnabled,
        ...(input.thresholds !== undefined
          ? { thresholds: input.thresholds }
          : {}),
        ...(input.entryDate !== undefined
          ? { entryDate: input.entryDate }
          : {}),
        ...(input.expiryDate !== undefined
          ? { expiryDate: input.expiryDate }
          : {}),
        updatedAt,
      };
    }

    const now = new Date();
    const record: StrategyRecord = {
      id: reference.id,
      ownerUid,
      symbol: input.symbol,
      entryPrice: input.entryPrice,
      active: input.active,
      notificationsEnabled: input.notificationsEnabled ?? true,
      ...(input.thresholds !== undefined
        ? { thresholds: input.thresholds }
        : {}),
      ...(input.entryDate !== undefined ? { entryDate: input.entryDate } : {}),
      ...(input.expiryDate !== undefined
        ? { expiryDate: input.expiryDate }
        : {}),
      createdAt: now,
      updatedAt: now,
    };
    try {
      await reference.create(record as unknown as Record<string, unknown>);
      return record;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      // Another request won the create race. Never overwrite its active entry.
      const raced = toStrategyRecord(await reference.get());
      if (
        !raced ||
        raced.ownerUid !== ownerUid ||
        raced.symbol !== input.symbol ||
        raced.active
      ) {
        throw new ConflictException(
          'an active strategy already exists for this symbol',
        );
      }
      const updatedAt = new Date();
      await reference.update({
        entryPrice: input.entryPrice,
        active: input.active,
        ...(input.notificationsEnabled !== undefined
          ? { notificationsEnabled: input.notificationsEnabled }
          : {}),
        ...(input.thresholds !== undefined
          ? { thresholds: input.thresholds }
          : {}),
        ...(input.entryDate !== undefined
          ? { entryDate: input.entryDate }
          : {}),
        ...(input.expiryDate !== undefined
          ? { expiryDate: input.expiryDate }
          : {}),
        updatedAt,
      });
      return {
        ...raced,
        entryPrice: input.entryPrice,
        active: input.active,
        notificationsEnabled:
          input.notificationsEnabled ?? raced.notificationsEnabled,
        ...(input.thresholds !== undefined
          ? { thresholds: input.thresholds }
          : {}),
        ...(input.entryDate !== undefined
          ? { entryDate: input.entryDate }
          : {}),
        ...(input.expiryDate !== undefined
          ? { expiryDate: input.expiryDate }
          : {}),
        updatedAt,
      };
    }
  }

  async updateForOwner(
    ownerUid: string,
    strategyId: string,
    input: UpdateStrategyInput,
  ): Promise<StrategyRecord | null> {
    const reference = this.db.collection('strategies').doc(strategyId);
    const snapshot = await reference.get();
    const current = toStrategyRecord(snapshot);
    if (!current || current.ownerUid !== ownerUid) return null;

    if (input.active === true) {
      if (
        !current.active &&
        strategyId !== strategyDocumentId(ownerUid, current.symbol)
      ) {
        throw new ConflictException(
          'reactivate this symbol through the watchlist create flow',
        );
      }
      const conflictingStrategy = (await this.listForOwner(ownerUid)).find(
        (strategy) =>
          strategy.id !== strategyId &&
          strategy.active &&
          strategy.symbol === current.symbol,
      );
      if (conflictingStrategy) {
        throw new ConflictException(
          'an active strategy already exists for this symbol',
        );
      }
    }

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (input.entryPrice !== undefined) patch.entryPrice = input.entryPrice;
    if (input.active !== undefined) patch.active = input.active;
    if (input.entryDate !== undefined) patch.entryDate = input.entryDate;
    if (input.expiryDate !== undefined) patch.expiryDate = input.expiryDate;
    if (input.thresholds !== undefined) patch.thresholds = input.thresholds;
    if (input.notificationsEnabled !== undefined) {
      patch.notificationsEnabled = input.notificationsEnabled;
    }
    await reference.update(patch);
    return { ...current, ...input, updatedAt: patch.updatedAt as Date };
  }

  async getDashboard(ownerUid: string): Promise<{
    strategies: StrategyRecord[];
    snapshots: DashboardSnapshot[];
    alerts: Record<string, unknown>[];
  }> {
    const strategies = await this.listForOwner(ownerUid);
    const snapshots = (
      await Promise.all(
        strategies.map(async (strategy) => {
          const doc = await this.db
            .collection('strategySnapshots')
            .doc(strategy.id)
            .get();
          const data = doc.data();
          if (!doc.exists || !data) return null;
          return {
            strategyId: strategy.id,
            assessment: data.assessment as RiskAssessment,
            source: String(data.source ?? 'unknown'),
            exchangeTimestamp: toDate(data.exchangeTimestamp),
            fetchedAt: toDate(data.fetchedAt),
            recordedAt: toDate(data.recordedAt),
            historicalCloses: Array.isArray(data.historicalCloses)
              ? data.historicalCloses
                  .filter(
                    (value): value is number =>
                      typeof value === 'number' &&
                      Number.isFinite(value) &&
                      value > 0,
                  )
                  .slice(-30)
              : [],
          };
        }),
      )
    ).filter((value): value is DashboardSnapshot => value !== null);

    const alerts = await this.listAlertsForOwner(ownerUid);
    return { strategies, snapshots, alerts };
  }

  async listAlertsForOwner(
    ownerUid: string,
  ): Promise<Record<string, unknown>[]> {
    // Filter by owner in Firestore, then sort and cap the small result set in
    // application code. This avoids requiring a composite ownerUid+createdAt
    // index just to render the dashboard's recent-alert summary.
    const result = await this.db
      .collection('alerts')
      .where('ownerUid', '==', ownerUid)
      .get();
    return result.docs
      .map(
        (doc): Record<string, unknown> => ({
          id: doc.id,
          ...(doc.data() ?? {}),
        }),
      )
      .sort(
        (left, right) =>
          toDate(right['createdAt']).getTime() -
          toDate(left['createdAt']).getTime(),
      )
      .slice(0, 50);
  }

  async registerDeviceToken(
    ownerUid: string,
    strategyId: string,
    token: string,
  ): Promise<boolean> {
    const strategy = await this.db
      .collection('strategies')
      .doc(strategyId)
      .get();
    const data = strategy.data();
    if (!strategy.exists || data?.ownerUid !== ownerUid) return false;

    const collection = this.db.collection('deviceTokens');
    const matchingTokens = await collection.where('token', '==', token).get();
    for (const document of matchingTokens.docs) {
      const record = document.data();
      if (
        record?.token === token &&
        record.ownerUid !== ownerUid &&
        record.active === true
      ) {
        await collection.doc(document.id).update({
          active: false,
          deactivatedReason: 'device-owner-changed',
          updatedAt: new Date(),
        });
      }
    }
    const matchingStrategyTokens = matchingTokens.docs.filter((document) => {
      const record = document.data();
      return record?.ownerUid === ownerUid && record?.strategyId === strategyId;
    });
    const id =
      matchingStrategyTokens[0]?.id ??
      createHash('sha256')
        .update(ownerUid)
        .update('\\0')
        .update(strategyId)
        .update('\\0')
        .update(token)
        .digest('hex');
    await collection.doc(id).set({
      ownerUid,
      strategyId,
      token,
      active: true,
      updatedAt: new Date(),
    });
    for (const duplicate of matchingStrategyTokens.slice(1)) {
      await collection.doc(duplicate.id).update({
        active: false,
        deactivatedReason: 'duplicate-token-registration',
        updatedAt: new Date(),
      });
    }
    return true;
  }

  async deactivateDeviceToken(token: string): Promise<void> {
    const matchingTokens = await this.db
      .collection('deviceTokens')
      .where('token', '==', token)
      .get();
    const updatedAt = new Date();
    for (const document of matchingTokens.docs) {
      const data = document.data();
      if (data?.token !== token || data.active !== true) continue;
      await this.db.collection('deviceTokens').doc(document.id).update({
        active: false,
        deactivatedReason: 'fcm-unregistered',
        updatedAt,
      });
    }
  }

  async listDeviceTokensForStrategy(strategyId: string): Promise<string[]> {
    const result = await this.db
      .collection('deviceTokens')
      .where('strategyId', '==', strategyId)
      .where('active', '==', true)
      .get();
    return result.docs
      .map((doc) => doc.data()?.token)
      .filter((token): token is string => typeof token === 'string');
  }

  private get db(): FirestorePort {
    return this.firebase.firestore;
  }
}

@Injectable()
export class FirestoreMonitoringRepository
  implements MonitoringRepository, NotificationDeliveryStateStore
{
  private readonly ownerByStrategy = new Map<string, string>();

  constructor(private readonly firebase: FirebaseAdminService) {}

  async listActiveStrategies(): Promise<Strategy[]> {
    const result = await this.db
      .collection('strategies')
      .where('active', '==', true)
      .get();
    const strategies: Strategy[] = [];
    for (const doc of result.docs) {
      const record = toStrategyRecord(doc);
      if (!record) continue;
      this.ownerByStrategy.set(record.id, record.ownerUid);
      strategies.push({
        id: record.id,
        symbol: record.symbol,
        entryPrice: record.entryPrice,
        active: record.active,
        ownerUid: record.ownerUid,
        ...(record.expiryDate !== undefined
          ? { expiryDate: record.expiryDate }
          : {}),
        ...(record.thresholds !== undefined
          ? { thresholds: record.thresholds }
          : {}),
        notificationsEnabled: record.notificationsEnabled,
      });
    }
    return strategies;
  }

  async getLatestExchangeTimestamp(strategyId: string): Promise<Date | null> {
    const document = await this.db
      .collection('strategySnapshots')
      .doc(strategyId)
      .get();
    if (!document.exists) return null;
    const value = document.data()?.exchangeTimestamp;
    if (value instanceof Date && Number.isFinite(value.getTime())) {
      return value;
    }
    if (
      value &&
      typeof value === 'object' &&
      'toDate' in value &&
      typeof value.toDate === 'function'
    ) {
      const timestamp = (value.toDate as () => Date)();
      return timestamp instanceof Date && Number.isFinite(timestamp.getTime())
        ? timestamp
        : null;
    }
    return null;
  }

  async recordAssessment(
    strategyId: string,
    assessment: RiskAssessment,
    snapshot: MarketSnapshot,
  ): Promise<void> {
    const ownerUid = await this.getOwnerUid(strategyId);
    await this.db
      .collection('strategySnapshots')
      .doc(strategyId)
      .set({
        strategyId,
        ownerUid,
        assessment,
        source: snapshot.source,
        exchangeTimestamp: snapshot.exchangeTimestamp,
        fetchedAt: snapshot.fetchedAt,
        recordedAt: new Date(),
        historicalCloses: snapshot.historicalCloses.slice(-30),
      });
  }

  async getRiskEpisodeState(
    strategyId: string,
  ): Promise<RiskEpisodeState | null> {
    const doc = await this.db
      .collection('riskEpisodeStates')
      .doc(strategyId)
      .get();
    const data = doc.data();
    if (!doc.exists || !data) return null;
    if (
      typeof data.episode !== 'number' ||
      typeof data.highestSeverity !== 'number'
    ) {
      return null;
    }
    return {
      episode: data.episode,
      highestSeverity: data.highestSeverity,
    };
  }

  async saveRiskEpisodeState(
    strategyId: string,
    state: RiskEpisodeState,
  ): Promise<void> {
    await this.db
      .collection('riskEpisodeStates')
      .doc(strategyId)
      .set({
        ...state,
        updatedAt: new Date(),
      });
  }

  async recordUnavailable(
    symbol: SupportedSymbol,
    reason: string,
    checkedAt: Date,
  ): Promise<void> {
    await this.db.collection('marketDataHealth').doc(symbol).set({
      symbol,
      status: 'unavailable',
      reason,
      checkedAt,
    });
  }

  async hasDeliveredTarget(
    idempotencyKey: string,
    targetKey: string,
  ): Promise<boolean> {
    const doc = await this.db
      .collection('notificationDeliveries')
      .doc(deliveryTargetDocumentId(idempotencyKey, targetKey))
      .get();
    const data = doc.data();
    return (
      doc.exists &&
      data?.idempotencyKey === idempotencyKey &&
      data?.targetKey === targetKey
    );
  }

  async markTargetDelivered(
    idempotencyKey: string,
    targetKey: string,
    deliveredAt: Date,
  ): Promise<void> {
    await this.db
      .collection('notificationDeliveries')
      .doc(deliveryTargetDocumentId(idempotencyKey, targetKey))
      .set({
        idempotencyKey,
        targetKey,
        deliveredAt,
      });
  }

  async hasDeliveredOrQueuedAlert(idempotencyKey: string): Promise<boolean> {
    const doc = await this.db
      .collection('alerts')
      .doc(alertDocumentId(idempotencyKey))
      .get();
    return doc.exists;
  }

  async enqueueAlert(alert: RiskAlert): Promise<void> {
    const ownerUid =
      alert.ownerUid ?? (await this.getOwnerUid(alert.strategyId));
    try {
      await this.db
        .collection('alerts')
        .doc(alertDocumentId(alert.idempotencyKey))
        .create({
          ...alert,
          ownerUid,
          status: 'pending',
          attempts: 0,
          queuedAt: new Date(),
        });
    } catch (error) {
      if (isAlreadyExists(error)) return;
      throw error;
    }
  }

  async listPendingAlerts(): Promise<RiskAlert[]> {
    const result = await this.db
      .collection('alerts')
      .where('status', '==', 'pending')
      .get();
    return result.docs
      .map((doc) => doc.data())
      .filter((data): data is Record<string, unknown> => data !== undefined)
      .map((data) => ({
        idempotencyKey: String(data.idempotencyKey),
        strategyId: String(data.strategyId),
        symbol: data.symbol as SupportedSymbol,
        kind: data.kind as RiskAlert['kind'],
        message: String(data.message),
        price: Number(data.price),
        movementPercent: Number(data.movementPercent),
        createdAt: toDate(data.createdAt),
        ...(typeof data.notificationsEnabled === 'boolean'
          ? { notificationsEnabled: data.notificationsEnabled }
          : {}),
        ...(typeof data.ownerUid === 'string'
          ? { ownerUid: data.ownerUid }
          : {}),
      }));
  }

  async markAlertSuppressed(
    idempotencyKey: string,
    suppressedAt: Date,
  ): Promise<void> {
    await this.db
      .collection('alerts')
      .doc(alertDocumentId(idempotencyKey))
      .update({
        status: 'suppressed',
        suppressedAt,
        suppressionReason: 'strategy_notifications_disabled',
      });
  }

  async markAlertDelivered(
    idempotencyKey: string,
    deliveredAt: Date,
  ): Promise<void> {
    await this.db
      .collection('alerts')
      .doc(alertDocumentId(idempotencyKey))
      .update({ status: 'delivered', deliveredAt });
  }

  async recordAlertDeliveryFailure(
    idempotencyKey: string,
    reason: string,
    failedAt: Date,
  ): Promise<void> {
    await this.db
      .collection('alerts')
      .doc(alertDocumentId(idempotencyKey))
      .update({
        attempts: FieldValue.increment(1),
        lastError: reason.slice(0, 500),
        lastAttemptAt: failedAt,
      });
  }

  private async getOwnerUid(strategyId: string): Promise<string> {
    const cached = this.ownerByStrategy.get(strategyId);
    if (cached) return cached;
    const doc = await this.db.collection('strategies').doc(strategyId).get();
    const ownerUid = doc.data()?.ownerUid;
    if (!doc.exists || typeof ownerUid !== 'string' || ownerUid.length === 0) {
      throw new Error(`Strategy ${strategyId} has no valid owner`);
    }
    this.ownerByStrategy.set(strategyId, ownerUid);
    return ownerUid;
  }

  private get db(): FirestorePort {
    return this.firebase.firestore;
  }
}

function toStrategyRecord(doc: DocumentSnapshotPort): StrategyRecord | null {
  const data = doc.data();
  if (
    !doc.exists ||
    !data ||
    typeof data.ownerUid !== 'string' ||
    !SUPPORTED_SYMBOLS.includes(data.symbol as SupportedSymbol) ||
    typeof data.entryPrice !== 'number' ||
    !Number.isFinite(data.entryPrice) ||
    data.entryPrice <= 0 ||
    typeof data.active !== 'boolean'
  ) {
    return null;
  }
  return {
    id: doc.id,
    ownerUid: data.ownerUid,
    symbol: data.symbol as SupportedSymbol,
    entryPrice: data.entryPrice,
    active: data.active,
    notificationsEnabled:
      typeof data.notificationsEnabled === 'boolean'
        ? data.notificationsEnabled
        : true,
    ...(typeof data.entryDate === 'string'
      ? { entryDate: data.entryDate }
      : {}),
    ...(typeof data.expiryDate === 'string'
      ? { expiryDate: data.expiryDate }
      : {}),
    ...(isRiskThresholds(data.thresholds)
      ? { thresholds: data.thresholds }
      : {}),
    createdAt: toDate(data.createdAt),
    updatedAt: toDate(data.updatedAt),
  };
}

function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (
    value &&
    typeof value === 'object' &&
    'toDate' in value &&
    typeof value.toDate === 'function'
  ) {
    return (value.toDate as () => Date)();
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) return date;
  }
  return new Date(0);
}

function isAlreadyExists(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error ? error.code : undefined;
  return code === 6 || code === 'already-exists';
}

function isRiskThresholds(value: unknown): value is RiskThresholds {
  if (!value || typeof value !== 'object') return false;
  const thresholds = value as Partial<RiskThresholds>;
  return (
    typeof thresholds.cautionPercent === 'number' &&
    Number.isFinite(thresholds.cautionPercent) &&
    thresholds.cautionPercent > 0 &&
    typeof thresholds.criticalPercent === 'number' &&
    Number.isFinite(thresholds.criticalPercent) &&
    thresholds.criticalPercent > thresholds.cautionPercent &&
    typeof thresholds.breachedPercent === 'number' &&
    Number.isFinite(thresholds.breachedPercent) &&
    thresholds.breachedPercent > thresholds.criticalPercent &&
    thresholds.breachedPercent < 100
  );
}

function strategyDocumentId(ownerUid: string, symbol: SupportedSymbol): string {
  return createHash('sha256')
    .update(ownerUid)
    .update('\0')
    .update(symbol)
    .digest('hex');
}

function deliveryTargetDocumentId(
  idempotencyKey: string,
  targetKey: string,
): string {
  return createHash('sha256')
    .update(`${idempotencyKey}:${targetKey}`)
    .digest('hex');
}

function alertDocumentId(idempotencyKey: string): string {
  return createHash('sha256').update(idempotencyKey).digest('hex');
}

function describeFirestoreError(error: unknown): {
  errorName: string;
  errorCode: string | number | null;
  errorMessage: string;
} {
  if (!error || typeof error !== 'object') {
    return {
      errorName: 'UnknownError',
      errorCode: null,
      errorMessage: String(error).slice(0, 300),
    };
  }
  const value = error as {
    name?: unknown;
    code?: unknown;
    message?: unknown;
  };
  return {
    errorName:
      typeof value.name === 'string' ? value.name.slice(0, 80) : 'Error',
    errorCode:
      typeof value.code === 'string' || typeof value.code === 'number'
        ? value.code
        : null,
    errorMessage:
      typeof value.message === 'string'
        ? value.message.replace(/(?:Bearer\s+)\S+/gi, 'Bearer [redacted]').slice(0, 300)
        : 'No error message provided',
  };
}
