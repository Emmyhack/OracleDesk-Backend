/**
 * The evaluation imports application modules, and `config` validates the
 * environment on import. Replay needs no database, Redis or provider key, so
 * fill any missing required setting with an inert placeholder first. Real
 * values are never overwritten.
 */
import { Keypair } from '@stellar/stellar-sdk';

export function ensureEvalEnv(): void {
  const set = (k: string, v: string) => { if (!process.env[k]) process.env[k] = v; };
  set('NODE_ENV', 'test');
  set('DATABASE_URL', 'postgresql://eval:eval@127.0.0.1:1/eval');
  set('REDIS_URL', 'redis://127.0.0.1:1');
  set('JWT_SECRET', 'eval-placeholder-0123456789abcdef');
  set('AUTH_SIGNING_SECRET', Keypair.random().secret());
  set('AUTH_HOME_DOMAIN', 'localhost');
  process.env.CHAIN_EXECUTION_MODE = 'dry-run';
  process.env.INDEXER_ENABLED = 'false';
}
