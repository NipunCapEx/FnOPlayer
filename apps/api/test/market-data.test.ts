import { describe, expect, it, vi } from 'vitest';
import { validateSnapshot, YahooChartProvider } from '../src/market-data.js';

const now = new Date('2026-10-20T10:00:00.000Z');

function chartResponse(input: {
  price: number;
  previousClose: number;
  timestamp: number;
  closes: Array<number | null>;
}): Response {
  return new Response(
    JSON.stringify({
      chart: {
        result: [
          {
            meta: {
              regularMarketPrice: input.price,
              chartPreviousClose: input.previousClose,
            },
            timestamp: [input.timestamp],
            indicators: { quote: [{ close: input.closes }] },
          },
        ],
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('YahooChartProvider — provider contract', () => {
  it('uses a configurable HTTPS Yahoo chart base URL and request timeout', async () => {
    const request = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBeDefined();
      return chartResponse({
        price: 100,
        previousClose: 98,
        timestamp: Math.floor(now.getTime() / 1000),
        closes: String(url).includes('interval=5m') ? [99, 100] : [97, 98, 99, 100],
      });
    });
    const provider = new YahooChartProvider(request as typeof fetch, () => now, {
      baseUrl: 'https://example.test/custom/chart/',
      timeoutMs: 2500,
    });

    await provider.getSnapshot('RELIANCE');

    expect(String(request.mock.calls[0]?.[0])).toContain(
      'https://example.test/custom/chart/RELIANCE.NS?range=1d&interval=5m',
    );
  });

  it('rejects an insecure configured market-data endpoint', () => {
    expect(
      () =>
        new YahooChartProvider(fetch, () => now, {
          baseUrl: 'http://example.test/chart',
        }),
    ).toThrow('must be an HTTPS URL');
  });

  it('maps the Indian ticker, spot quote, exchange timestamp and daily history', async () => {
    const request = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes('interval=5m')) {
        return chartResponse({
          price: 100,
          previousClose: 98,
          timestamp: Math.floor(now.getTime() / 1000),
          closes: [99, 100],
        });
      }
      return chartResponse({
        price: 100,
        previousClose: 98,
        timestamp: Math.floor(now.getTime() / 1000),
        closes: [97, 98, 99, 100, null],
      });
    });
    const provider = new YahooChartProvider(request as typeof fetch, () => now);

    const result = await provider.getSnapshot('RELIANCE');

    expect(String(request.mock.calls[0]?.[0])).toContain('RELIANCE.NS');
    expect(result).toMatchObject({
      symbol: 'RELIANCE',
      price: 100,
      previousClose: 98,
      source: 'Yahoo Finance unofficial prototype adapter',
      historicalCloses: [97, 98, 99, 100],
    });
    expect(result.exchangeTimestamp).toEqual(now);
    expect(result.fetchedAt).toEqual(now);
  });

  it('caches daily history for the same day but requests a fresh intraday quote', async () => {
    const request = vi.fn(async (url: RequestInfo | URL) => {
      const isIntraday = String(url).includes('interval=5m');
      return chartResponse({
        price: 100,
        previousClose: 98,
        timestamp: Math.floor(now.getTime() / 1000),
        closes: isIntraday ? [99, 100] : [97, 98, 99, 100],
      });
    });
    const provider = new YahooChartProvider(request as typeof fetch, () => now);

    await provider.getSnapshot('RELIANCE');
    await provider.getSnapshot('RELIANCE');

    expect(request).toHaveBeenCalledTimes(3);
  });

  it('fails closed when the quote provider returns an HTTP error', async () => {
    const request = vi.fn(
      async () => new Response('rate limited', { status: 429 }),
    );
    const provider = new YahooChartProvider(request as typeof fetch, () => now);

    await expect(provider.getSnapshot('RELIANCE')).rejects.toThrow('HTTP 429');
  });
  it('uses the provider error description when no chart result is returned', async () => {
    const request = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            chart: {
              result: null,
              error: { description: 'No quote available' },
            },
          }),
          { status: 200 },
        ),
    );
    const provider = new YahooChartProvider(request as typeof fetch, () => now);

    await expect(provider.getSnapshot('RELIANCE')).rejects.toThrow(
      'No quote available',
    );
  });

  it('continues without optional volatility history if the daily-history request fails', async () => {
    const request = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes('interval=5m')) {
        return chartResponse({
          price: 100,
          previousClose: 98,
          timestamp: Math.floor(now.getTime() / 1000),
          closes: [99, 100],
        });
      }
      return new Response('rate limited', { status: 429 });
    });
    const provider = new YahooChartProvider(request as typeof fetch, () => now);

    const result = await provider.getSnapshot('RELIANCE');
    expect(result.historicalCloses).toEqual([]);
  });

  it('uses cached history if a later daily-history refresh fails', async () => {
    let currentNow = now;
    let dailyCalls = 0;
    const request = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes('interval=5m')) {
        return chartResponse({
          price: 100,
          previousClose: 98,
          timestamp: Math.floor(currentNow.getTime() / 1000),
          closes: [99, 100],
        });
      }
      dailyCalls += 1;
      if (dailyCalls > 1) return new Response('rate limited', { status: 429 });
      return chartResponse({
        price: 100,
        previousClose: 98,
        timestamp: Math.floor(currentNow.getTime() / 1000),
        closes: [97, 98, 99, 100],
      });
    });
    const provider = new YahooChartProvider(
      request as typeof fetch,
      () => currentNow,
    );

    const first = await provider.getSnapshot('RELIANCE');
    currentNow = new Date('2026-10-21T10:00:00.000Z');
    const second = await provider.getSnapshot('RELIANCE');

    expect(first.historicalCloses).toEqual([97, 98, 99, 100]);
    expect(second.historicalCloses).toEqual(first.historicalCloses);
  });

  it('uses the default clock when no clock function is injected', async () => {
    const request = vi.fn(async (url: RequestInfo | URL) => {
      const timestamp = Math.floor(Date.now() / 1000);
      return chartResponse({
        price: 100,
        previousClose: 98,
        timestamp,
        closes: String(url).includes('interval=5m')
          ? [99, 100]
          : [97, 98, 99, 100],
      });
    });
    const provider = new YahooChartProvider(request as typeof fetch);

    const result = await provider.getSnapshot('RELIANCE');
    expect(result.fetchedAt).toBeInstanceOf(Date);
    expect(result.exchangeTimestamp).toBeInstanceOf(Date);
  });

  it('rejects an incomplete quote instead of manufacturing a price', async () => {
    const request = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            chart: {
              result: [
                {
                  meta: { regularMarketPrice: 0, chartPreviousClose: 98 },
                  timestamp: [],
                  indicators: { quote: [{ close: [] }] },
                },
              ],
            },
          }),
          { status: 200 },
        ),
    );
    const provider = new YahooChartProvider(request as typeof fetch, () => now);

    await expect(provider.getSnapshot('RELIANCE')).rejects.toThrow(
      'incomplete quote data',
    );
  });

  it('uses a fallback message when the chart response has no error description', async () => {
    const request = vi.fn(
      async () =>
        new Response(JSON.stringify({ chart: { result: null, error: null } }), {
          status: 200,
        }),
    );
    const provider = new YahooChartProvider(request as typeof fetch, () => now);

    await expect(provider.getSnapshot('RELIANCE')).rejects.toThrow(
      'Yahoo Finance returned no chart data',
    );
  });
});

describe('validateSnapshot — rejection cases', () => {
  it('rejects a missing snapshot object', () => {
    expect(validateSnapshot(null, now)).toEqual({
      valid: false,
      reason: 'snapshot must be an object',
    });
  });

  const base = {
    symbol: 'RELIANCE',
    price: 100,
    previousClose: 99,
    exchangeTimestamp: now,
    fetchedAt: now,
    source: 'fixture',
    historicalCloses: [97, 98, 99, 100],
  };

  it('rejects unsupported symbols and non-positive previous closes', () => {
    expect(validateSnapshot({ ...base, symbol: 'UNKNOWN' }, now).valid).toBe(
      false,
    );
    expect(validateSnapshot({ ...base, previousClose: 0 }, now)).toMatchObject({
      valid: false,
      reason: 'previous close must be positive and finite',
    });
  });

  it('rejects invalid timestamps, empty source and invalid history', () => {
    expect(
      validateSnapshot(
        { ...base, exchangeTimestamp: new Date('invalid') },
        now,
      ),
    ).toMatchObject({ valid: false, reason: 'exchange timestamp is invalid' });
    expect(
      validateSnapshot({ ...base, fetchedAt: new Date('invalid') }, now),
    ).toMatchObject({ valid: false, reason: 'fetch timestamp is invalid' });
    expect(validateSnapshot({ ...base, source: '  ' }, now)).toMatchObject({
      valid: false,
      reason: 'source is required',
    });
    expect(
      validateSnapshot({ ...base, historicalCloses: [100, Number.NaN] }, now),
    ).toMatchObject({
      valid: false,
      reason: 'historical closes must be positive finite values',
    });
  });

  it('rejects fetch and exchange timestamps too far in the future', () => {
    const future = new Date(now.getTime() + 2 * 60 * 1000);
    expect(validateSnapshot({ ...base, fetchedAt: future }, now)).toMatchObject(
      { valid: false, reason: 'fetch timestamp is in the future' },
    );
    expect(
      validateSnapshot({ ...base, exchangeTimestamp: future }, now),
    ).toMatchObject({
      valid: false,
      reason: 'exchange timestamp is in the future',
    });
  });
});
