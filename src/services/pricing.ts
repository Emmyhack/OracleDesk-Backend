// src/services/pricing.ts
import { PrismaClient } from '@prisma/client';
import { decimalToBigint, bigintToDecimalString } from '../lib/amounts';

const prisma = new PrismaClient();

/**
 * Retrieve the active price schedule based on the current time.
 * The schedule with the most recent  that is not in the future is returned.
 */
export async function getActivePriceSchedule() {
  const now = new Date();
  const schedule = await prisma.priceSchedule.findFirst({
    where: { effectiveAt: { lte: now } },
    orderBy: { effectiveAt: 'desc' },
  });
  return schedule;
}

/**
 * Get the price (in base‑unit bigint) for a given subscription type.
 * Returns  if no active schedule is found.
 */
export async function getPriceRawForType(type: 'DAILY_PASS' | 'PER_TRACE') {
  const schedule = await getActivePriceSchedule();
  if (!schedule) return null;
  const priceRawStr = type === 'DAILY_PASS' ? schedule.dailyPassPriceRaw : schedule.perTracePriceRaw;
  // Stored as a decimal string representing base‑unit integer.
  // Convert to bigint for arithmetic.
  const priceBigInt = BigInt(priceRawStr);
  return priceBigInt;
}

/**
 * Utility to format a base‑unit bigint price back to a human‑readable USDC string.
 */
export function formatPrice(priceBaseUnits: bigint): string {
  // USDC uses 7 decimal places.
  const divisor = BigInt(10_000_000);
  const whole = priceBaseUnits / divisor;
  const fraction = priceBaseUnits % divisor;
  const fractionStr = fraction.toString().padStart(7, '0').replace(/0+$/, '');
  return fractionStr ? `${whole}.${fractionStr}` : `${whole}`;
}

