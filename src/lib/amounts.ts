/** USDC on Stellar (the SAC in deployments/testnet.json) has 7 decimals. */
export const USDC_DECIMALS = 7;
export const USDC_UNIT = 10n ** BigInt(USDC_DECIMALS);

/**
 * Decimal USDC string → base units. Rejects exponents, signs other than a
 * leading "-", and more than 7 decimal places. Never goes through a float.
 */
export function parseUsdc(input: string): bigint {
  const trimmed = input.trim();
  const match = /^(-)?(\d+)(?:\.(\d{1,7}))?$/.exec(trimmed);
  if (!match) throw new Error(`Invalid USDC amount: "${input}"`);
  const [, sign, whole, frac = ''] = match;
  const value = BigInt(whole) * USDC_UNIT + BigInt(frac.padEnd(USDC_DECIMALS, '0'));
  return sign ? -value : value;
}

/** Base units → decimal string with trailing zeros trimmed ("1.5", "0.0000001"). */
export function formatUsdc(raw: bigint): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const whole = abs / USDC_UNIT;
  const frac = (abs % USDC_UNIT).toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/**
 * Display float → base units, for legacy float fields only (e.g. the LLM's
 * minimum_liquidity_usdc). Rounds to 7 decimals via its string form.
 */
export function usdcFromNumber(value: number): bigint {
  if (!Number.isFinite(value)) throw new Error(`Invalid USDC amount: ${value}`);
  return parseUsdc(value.toFixed(USDC_DECIMALS));
}

export function toDisplayUsdc(raw: bigint): number {
  return Number(formatUsdc(raw));
}

/** Parses a decimal u64 string such as an on-chain market id. */
export function parseU64(input: string): bigint | null {
  if (!/^\d{1,20}$/.test(input)) return null;
  const value = BigInt(input);
  return value <= 0xffff_ffff_ffff_ffffn ? value : null;
}

/**
 * Prisma `Decimal` (NUMERIC(39,0)) or its string form → bigint, without ever
 * going through a JS number. Rejects non-integers and exponent forms.
 */
export function decimalToBigint(value: { toFixed(): string } | string | bigint): bigint {
  if (typeof value === 'bigint') return value;
  const text = typeof value === 'string' ? value.trim() : value.toFixed();
  if (!/^-?\d+(?:\.0+)?$/.test(text)) throw new Error(`Not an integer decimal: "${text}"`);
  return BigInt(text.replace(/\.0+$/, ''));
}

/** bigint → the decimal string Prisma accepts for a Decimal column. */
export function bigintToDecimalString(value: bigint): string {
  return value.toString();
}

/** ceil(a × b / c) for non-negative bigints; mirrors market-core's fee rounding. */
export function mulDivCeil(a: bigint, b: bigint, c: bigint): bigint {
  if (a < 0n || b < 0n || c <= 0n) throw new Error('mulDivCeil: invalid input');
  const product = a * b;
  const quotient = product / c;
  return product % c !== 0n ? quotient + 1n : quotient;
}
