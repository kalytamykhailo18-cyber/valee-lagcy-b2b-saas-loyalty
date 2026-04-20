/**
 * Exchange Rate Service — Venezuelan Bolívar multi-rate handling.
 *
 * Pulls daily rates from a public source (ve.dolarapi.com) and stores them
 * in the exchange_rates table. Rates are append-only — never updated, so
 * historical accuracy is preserved for retroactive calculations.
 *
 * Each invoice paid in Bs is normalized to a reference currency (USD/EUR)
 * using the rate that was effective at the invoice's transaction date.
 */

import prisma from '../db/client.js';
import type { ExchangeSource, ReferenceCurrency } from '@prisma/client';

const API_BASE = 'https://ve.dolarapi.com/v1';

interface ApiRate {
  moneda: 'USD' | 'EUR';
  fuente: 'oficial' | 'paralelo';
  promedio: number;
  fechaActualizacion: string;
}

/**
 * Pull all current rates from the public API and insert them into exchange_rates.
 * Each call creates new rows — never updates existing ones (history-preserving).
 *
 * Returns the count of rates inserted.
 */
export async function fetchAllRates(): Promise<number> {
  let inserted = 0;

  try {
    // USD rates: BCV (oficial) and Promedio (paralelo)
    const usdRes = await fetch(`${API_BASE}/dolares`);
    if (usdRes.ok) {
      const usdRates = (await usdRes.json()) as ApiRate[];
      for (const r of usdRates) {
        const source: ExchangeSource | null =
          r.fuente === 'oficial' ? 'bcv' :
          r.fuente === 'paralelo' ? 'promedio' :
          null;
        if (!source || !r.promedio) continue;
        await prisma.exchangeRate.create({
          data: {
            source,
            currency: 'usd',
            rateBs: r.promedio.toFixed(4),
            reportedAt: new Date(r.fechaActualizacion),
          },
        });
        inserted++;
      }
    }

    // EUR rates: only the BCV oficial
    const eurRes = await fetch(`${API_BASE}/euros`);
    if (eurRes.ok) {
      const eurRates = (await eurRes.json()) as ApiRate[];
      for (const r of eurRates) {
        if (r.fuente !== 'oficial' || !r.promedio) continue;
        await prisma.exchangeRate.create({
          data: {
            source: 'euro_bcv',
            currency: 'eur',
            rateBs: r.promedio.toFixed(4),
            reportedAt: new Date(r.fechaActualizacion),
          },
        });
        inserted++;
      }
    }

    console.log(`[ExchangeRates] Fetched and inserted ${inserted} rates`);
    return inserted;
  } catch (err) {
    console.error('[ExchangeRates] Fetch error:', err);
    return inserted;
  }
}

/**
 * Get the most recent rate for a given source/currency combination.
 * Returns null if no rate exists yet.
 */
export async function getCurrentRate(
  source: ExchangeSource,
  currency: ReferenceCurrency
): Promise<{ rateBs: number; reportedAt: Date } | null> {
  const rate = await prisma.exchangeRate.findFirst({
    where: { source, currency },
    orderBy: { fetchedAt: 'desc' },
  });
  if (!rate) return null;
  return { rateBs: Number(rate.rateBs), reportedAt: rate.reportedAt };
}

/**
 * Get the rate that was effective at a specific date.
 * Used for retroactive claims — when a consumer claims a 3-day-old invoice,
 * we use the rate that was active 3 days ago, not today's rate.
 */
export async function getRateAtDate(
  source: ExchangeSource,
  currency: ReferenceCurrency,
  date: Date
): Promise<{ rateBs: number; reportedAt: Date } | null> {
  const rate = await prisma.exchangeRate.findFirst({
    where: {
      source,
      currency,
      reportedAt: { lte: date },
    },
    orderBy: { reportedAt: 'desc' },
  });
  if (!rate) {
    // Fall back to the earliest available rate if the date is before any record
    return getCurrentRate(source, currency);
  }
  return { rateBs: Number(rate.rateBs), reportedAt: rate.reportedAt };
}

/**
 * Convert a Bolívar amount to a reference currency (USD or EUR) using the
 * specified exchange source. The date parameter selects the rate effective
 * at that moment (defaults to "now" for new transactions).
 *
 * Returns null if no rate is available — caller should fall back to using
 * the BS amount as-is.
 */
export async function convertBsToReference(
  bsAmount: number,
  source: ExchangeSource,
  currency: ReferenceCurrency,
  date?: Date
): Promise<number | null> {
  const rate = date
    ? await getRateAtDate(source, currency, date)
    : await getCurrentRate(source, currency);
  if (!rate || rate.rateBs <= 0) return null;
  return bsAmount / rate.rateBs;
}

/**
 * Sensible default exchange source for a given reference currency when the
 * tenant hasn't picked one. Used by the invoice pipeline so a freshly
 * onboarded tenant can't accidentally end up multiplying raw Bs by the
 * points rate (Eric hit this on Kozmo2: preferred_exchange_source was null,
 * so 8,616 Bs × 20 became 172,327 pts instead of ~15 EUR × 20 = 303 pts).
 */
export function defaultExchangeSource(currency: ReferenceCurrency | string | null | undefined): ExchangeSource | null {
  switch (currency) {
    case 'usd': return 'bcv';
    case 'eur': return 'euro_bcv';
    default:    return null;
  }
}
