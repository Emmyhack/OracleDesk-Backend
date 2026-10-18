import crypto from 'node:crypto';
import { mulberry32 } from '../seed/rng';

export { mulberry32 };

/** A uint32 derived from the parts, so a draw depends on what it is for, not on call order. */
export function hashSeed(...parts: Array<string | number>): number {
  return crypto.createHash('sha256').update(parts.join('|')).digest().readUInt32BE(0);
}

/** One standard normal draw (Box–Muller) from a seeded stream. */
export function gaussian(rand: () => number): number {
  return Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
}
