import { SUPPORTED_SYMBOLS, type SupportedSymbol } from './risk-engine.js';

export interface MarketSnapshot {
  symbol: SupportedSymbol;
  price: number;
  previousClose: number;
  exchangeTimestamp: Date;
  fetchedAt: Date;
  source: string;
  historicalCloses: number[];
}

export type SnapshotValidation =
  | { valid: true; snapshot: MarketSnapshot }
  | { valid: false; reason: string };

export interface MarketDataProvider {
  getSnapshot(symbol: SupportedSymbol): Promise<MarketSnapshot>;
}

export interface MarketDataReader {
  getSnapshot(symbol: SupportedSymbol): Promise<SnapshotValidation>;
}

export interface FreshnessPolicy {
  maxAgeMs: number;
  maxFutureSkewMs: number;
}

export const DEFAULT_FRESHNESS_POLICY: FreshnessPolicy = {
  maxAgeMs: 10 * 60 * 1000,
  maxFutureSkewMs: 60 * 1000,
};

export function validateSnapshot(
  value: unknown,
  now: Date,
  policy: FreshnessPolicy = DEFAULT_FRESHNESS_POLICY,
): SnapshotValidation {
  if (!value || typeof value !== 'object') {
    return { valid: false, reason: 'snapshot must be an object' };
  }

  const snapshot = value as Partial<MarketSnapshot>;
  if (!SUPPORTED_SYMBOLS.includes(snapshot.symbol as SupportedSymbol)) {
    return { valid: false, reason: 'unsupported symbol' };
  }
  if (!isPositiveFinite(snapshot.price)) {
    return { valid: false, reason: 'price must be positive and finite' };
  }
  if (!isPositiveFinite(snapshot.previousClose)) {
    return {
      valid: false,
      reason: 'previous close must be positive and finite',
    };
  }
  if (
    !(snapshot.exchangeTimestamp instanceof Date) ||
    !Number.isFinite(snapshot.exchangeTimestamp.getTime())
  ) {
    return { valid: false, reason: 'exchange timestamp is invalid' };
  }
  if (
    !(snapshot.fetchedAt instanceof Date) ||
    !Number.isFinite(snapshot.fetchedAt.getTime())
  ) {
    return { valid: false, reason: 'fetch timestamp is invalid' };
  }
  if (
    typeof snapshot.source !== 'string' ||
    snapshot.source.trim().length === 0
  ) {
    return { valid: false, reason: 'source is required' };
  }
  if (
    !Array.isArray(snapshot.historicalCloses) ||
    snapshot.historicalCloses.some((close) => !isPositiveFinite(close))
  ) {
    return {
      valid: false,
      reason: 'historical closes must be positive finite values',
    };
  }

  const age = now.getTime() - snapshot.fetchedAt.getTime();
  if (
    age > policy.maxAgeMs ||
    now.getTime() - snapshot.exchangeTimestamp.getTime() > policy.maxAgeMs
  ) {
    return { valid: false, reason: 'snapshot is stale' };
  }
  if (age < -policy.maxFutureSkewMs) {
    return { valid: false, reason: 'fetch timestamp is in the future' };
  }
  if (
    snapshot.exchangeTimestamp.getTime() >
    now.getTime() + policy.maxFutureSkewMs
  ) {
    return { valid: false, reason: 'exchange timestamp is in the future' };
  }

  return { valid: true, snapshot: snapshot as MarketSnapshot };
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

interface YahooChartResponse {
  chart?: {
    result?: YahooChartResult[] | null;
    error?: { description?: string } | null;
  };
}

interface YahooChartResult {
  meta?: {
    regularMarketPrice?: number;
    chartPreviousClose?: number;
  };
  timestamp?: number[];
  indicators?: {
    quote?: Array<{ close?: Array<number | null> }>;
  };
}

export const DEFAULT_YAHOO_CHART_BASE_URL =
  'https://query1.finance.yahoo.com/v8/finance/chart';

export class YahooChartProvider implements MarketDataProvider {
  private readonly dailyHistory = new Map<
    SupportedSymbol,
    { date: string; closes: number[] }
  >();

  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly request: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
    options: { baseUrl?: string; timeoutMs?: number } = {},
  ) {
    this.baseUrl = normalizeYahooChartBaseUrl(
      options.baseUrl ?? process.env.FOPLAYER_YAHOO_CHART_BASE_URL,
    );
    this.timeoutMs = positiveIntegerFromEnvironment(
      options.timeoutMs ?? Number(process.env.FOPLAYER_MARKET_DATA_TIMEOUT_MS),
      10_000,
    );
  }

  async getSnapshot(symbol: SupportedSymbol): Promise<MarketSnapshot> {
    const intraday = await this.fetchChart(symbol, '1d', '5m');
    const timestamps = intraday.timestamp ?? [];
    const lastTimestamp = timestamps[timestamps.length - 1];
    const intradayCloses = intraday.indicators?.quote?.[0]?.close ?? [];
    const lastClose = intradayCloses[intradayCloses.length - 1];
    const price = intraday.meta?.regularMarketPrice ?? lastClose;
    const previousClose = intraday.meta?.chartPreviousClose;

    if (
      lastTimestamp === undefined ||
      !Number.isFinite(lastTimestamp) ||
      !isPositiveFinite(price) ||
      !isPositiveFinite(previousClose)
    ) {
      throw new Error(
        `Yahoo Finance returned incomplete quote data for ${symbol}`,
      );
    }

    const fetchedAt = this.now();
    const history = await this.getDailyHistory(symbol, fetchedAt);
    return {
      symbol,
      price,
      previousClose,
      exchangeTimestamp: new Date(lastTimestamp * 1000),
      fetchedAt,
      source: 'Yahoo Finance unofficial prototype adapter',
      historicalCloses: history,
    };
  }

  private async getDailyHistory(
    symbol: SupportedSymbol,
    fetchedAt: Date,
  ): Promise<number[]> {
    const date = fetchedAt.toISOString().slice(0, 10);
    const cached = this.dailyHistory.get(symbol);
    if (cached?.date === date) return cached.closes;

    try {
      const result = await this.fetchChart(symbol, '1mo', '1d');
      const closes = (result.indicators?.quote?.[0]?.close ?? []).filter(
        isPositiveFinite,
      );
      this.dailyHistory.set(symbol, { date, closes });
      return closes;
    } catch {
      return cached?.closes ?? [];
    }
  }

  private async fetchChart(
    symbol: SupportedSymbol,
    range: '1d' | '1mo',
    interval: '5m' | '1d',
  ): Promise<YahooChartResult> {
    const ticker = encodeURIComponent(`${symbol}.NS`);
    const url =
      `${this.baseUrl}/${ticker}?range=${range}&interval=${interval}`;
    let response: Response;
    try {
      response = await this.request(url, {
        headers: {
          accept: 'application/json',
          'user-agent': 'FnOPlayer/0.1 market-data prototype',
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new Error('Yahoo Finance request timed out');
      }
      throw new Error('Yahoo Finance request could not be completed');
    }
    if (!response.ok) {
      throw new Error(
        `Yahoo Finance request failed with HTTP ${response.status}`,
      );
    }

    const body = (await response.json()) as YahooChartResponse;
    const result = body.chart?.result?.[0];
    if (!result) {
      throw new Error(
        body.chart?.error?.description ??
          'Yahoo Finance returned no chart data',
      );
    }
    return result;
  }
}

function normalizeYahooChartBaseUrl(value?: string): string {
  const candidate = value?.trim() || DEFAULT_YAHOO_CHART_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('FOPLAYER_YAHOO_CHART_BASE_URL must be a valid HTTPS URL');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('FOPLAYER_YAHOO_CHART_BASE_URL must be an HTTPS URL without credentials');
  }
  return parsed.toString().replace(/\/$/, '');
}

function positiveIntegerFromEnvironment(value: number, fallback: number): number {
  return Number.isInteger(value) && value >= 100 && value <= 60_000
    ? value
    : fallback;
}
