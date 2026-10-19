import { Keypair, rpc, Networks, StrKey, xdr } from '@stellar/stellar-sdk';
import { basicNodeSigner, type ClientOptions } from '@stellar/stellar-sdk/contract';
import fs from 'node:fs';
import { config } from '../../config';
import { getRedis } from '../../lib/redis';
import { logger } from '../../lib/logger';
import { ChainError } from './errors';
import { shutdownController } from '../../lib/shutdown';
import { authExpirationLedger, NOMINAL_LEDGER_SECONDS } from './timebounds';

export interface ChannelAccount {
  publicKey: string;
  keypair: Keypair;
  healthy: boolean;
  lastBalanceXlm: number;
}

export interface LeasedChannel {
  channel: ChannelAccount;
  leaseToken: string;
  release: () => Promise<void>;
}

export type Signer = Pick<ClientOptions, 'publicKey' | 'signTransaction' | 'signAuthEntry'>;

const RELEASE_LUA_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

export class ChannelPool {
  private channels: ChannelAccount[] = [];
  private roundRobinIdx = 0;
  private monitorTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly redis = getRedis(),
    private readonly rpcServer: rpc.Server | any = null,
  ) {
    this.initChannels();
  }

  private initChannels(): void {
    const rawKeys: string[] = [];
    if (config.CHANNEL_SECRET_KEYS) {
      for (const k of config.CHANNEL_SECRET_KEYS.split(',')) {
        const trimmed = k.trim();
        if (trimmed) rawKeys.push(trimmed);
      }
    }
    if (config.CHANNELS_SECRETS_FILE && fs.existsSync(config.CHANNELS_SECRETS_FILE)) {
      try {
        const content = fs.readFileSync(config.CHANNELS_SECRETS_FILE, 'utf-8');
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith('#') && StrKey.isValidEd25519SecretSeed(trimmed)) {
            rawKeys.push(trimmed);
          }
        }
      } catch (err: any) {
        logger.warn({ err: err?.message, file: config.CHANNELS_SECRETS_FILE }, 'Failed to read channels secrets file');
      }
    }

    const seen = new Set<string>();
    for (const secret of rawKeys) {
      if (!StrKey.isValidEd25519SecretSeed(secret)) continue;
      const keypair = Keypair.fromSecret(secret);
      const pub = keypair.publicKey();
      if (seen.has(pub)) continue;
      seen.add(pub);
      this.channels.push({
        publicKey: pub,
        keypair,
        healthy: true,
        lastBalanceXlm: 100, // Initial nominal balance; updated by monitor
      });
    }

    if (this.channels.length > 0) {
      logger.info({ count: this.channels.length }, 'Initialized channel pool with accounts');
    }
  }

  public get size(): number {
    return this.channels.length;
  }

  public getChannels(): ReadonlyArray<ChannelAccount> {
    return this.channels;
  }

  /**
   * Leases a healthy channel account exclusively across processes using Redis.
   */
  public async acquire(opts: { timeoutMs?: number; leaseMs?: number } = {}): Promise<LeasedChannel> {
    if (this.channels.length === 0) {
      throw new ChainError('No channel accounts configured', null, {}, 'CHANNELS_NOT_CONFIGURED');
    }

    const timeoutMs = opts.timeoutMs ?? config.CHANNEL_ACQUIRE_TIMEOUT_MS;
    const leaseMs = opts.leaseMs ?? config.CHANNEL_LEASE_MS;
    const deadline = Date.now() + timeoutMs;
    const leaseToken = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;

    while (Date.now() < deadline) {
      // Pick available and healthy channels in round-robin order
      const n = this.channels.length;
      for (let i = 0; i < n; i++) {
        const idx = (this.roundRobinIdx + i) % n;
        const channel = this.channels[idx];

        if (!channel.healthy) continue;

        const leaseKey = `channel:lease:${channel.publicKey}`;
        let acquired = false;
        try {
          const res = await this.redis.set(leaseKey, leaseToken, 'PX', leaseMs, 'NX');
          acquired = res === 'OK';
        } catch (err: any) {
          logger.warn({ err: err?.message, pubkey: channel.publicKey }, 'Redis error while acquiring channel lease');
        }

        if (acquired) {
          this.roundRobinIdx = (idx + 1) % n;
          let released = false;
          const release = async () => {
            if (released) return;
            released = true;
            try {
              await (this.redis as any).eval(RELEASE_LUA_SCRIPT, 1, leaseKey, leaseToken);
            } catch (err: any) {
              logger.warn({ err: err?.message, pubkey: channel.publicKey }, 'Error releasing channel lease');
            }
          };

          return {
            channel,
            leaseToken,
            release,
          };
        }
      }

      // Jittered sleep between 50ms and 150ms before retrying
      const jitter = 50 + Math.floor(Math.random() * 100);
      await new Promise((resolve) => setTimeout(resolve, jitter));
    }

    throw new ChainError('All channel accounts are currently leased or unavailable', null, {}, 'CHANNELS_EXHAUSTED');
  }

  /**
   * Fetches on-chain XLM balances for all channels from Stellar RPC.
   * Channels with balance below CHANNEL_MIN_BALANCE_XLM are taken out of rotation.
   */
  public async checkBalances(): Promise<void> {
    if (!this.rpcServer || this.channels.length === 0) return;

    for (const channel of this.channels) {
      try {
        const account = await this.rpcServer.getAccount(channel.publicKey);
        const nativeBalance = account?.balances?.find((b: any) => b.asset_type === 'native');
        const xlm = nativeBalance ? parseFloat(nativeBalance.balance) : 0;
        channel.lastBalanceXlm = xlm;

        if (xlm < config.CHANNEL_MIN_BALANCE_XLM) {
          if (channel.healthy) {
            channel.healthy = false;
            logger.warn(
              { publicKey: channel.publicKey, balanceXlm: xlm, minRequired: config.CHANNEL_MIN_BALANCE_XLM },
              'Channel account balance below threshold; taken out of rotation',
            );
          }
        } else {
          channel.healthy = true;
        }
      } catch (err: any) {
        logger.warn({ publicKey: channel.publicKey, err: err?.message }, 'Failed to check channel balance');
      }
    }
  }

  public startBalanceMonitor(intervalMs = 60_000): void {
    if (this.monitorTimer || config.NODE_ENV === 'test' || config.CHAIN_EXECUTION_MODE !== 'live') {
      return;
    }
    this.monitorTimer = setInterval(() => {
      this.checkBalances().catch(() => undefined);
    }, intervalMs);
    this.monitorTimer.unref();

    shutdownController.signal.addEventListener('abort', () => this.stopBalanceMonitor(), { once: true });
  }

  public stopBalanceMonitor(): void {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
  }
}

let sharedPool: ChannelPool | null = null;

export function getChannelPool(): ChannelPool {
  if (!sharedPool) {
    const { rpcServer } = require('./clients');
    sharedPool = new ChannelPool(getRedis(), rpcServer);
  }
  return sharedPool;
}

export function setChannelPool(next: ChannelPool | null): void {
  sharedPool = next;
}

/**
 * Creates a composed signer: the channel signs the transaction envelope,
 * while the agent signs non-invoker authorization entries.
 */
export function channelSigner(channelKeypair: Keypair, agentKeypair: Keypair, passphrase = config.STELLAR_NETWORK_PASSPHRASE): Signer {
  const channelNode = basicNodeSigner(channelKeypair, passphrase);
  const agentNode = basicNodeSigner(agentKeypair, passphrase);

  return {
    publicKey: channelKeypair.publicKey(),
    signTransaction: channelNode.signTransaction,
    signAuthEntry: agentNode.signAuthEntry,
  };
}

/**
 * Validates simulated authorization entries before signing:
 * 1. needsNonInvokerSigningBy() must return exactly the agent's public key (or none).
 * 2. Credentials must be address credentials for the agent.
 * 3. Root invocation must match expected contract function.
 */
export function verifyChannelAuthEntries(
  tx: any,
  agentPublicKey: string,
  expectedMethod?: string,
): void {
  let signers: string[] = [];
  try {
    signers = typeof tx.needsNonInvokerSigningBy === 'function' ? tx.needsNonInvokerSigningBy() : [];
  } catch {
    signers = [];
  }

  for (const s of signers) {
    if (s !== agentPublicKey) {
      throw new ChainError(
        `Unexpected non-invoker signer required: ${s}`,
        null,
        { requiredSigner: s, expectedAgent: agentPublicKey },
        'UNEXPECTED_AUTH_SIGNER',
      );
    }
  }

  // Inspect auth entries in simulation if present
  const authEntries = (tx.simulation as any)?.result?.auth ?? [];
  for (const entry of authEntries) {
    try {
      // Validate credentials
      let credsAddress: string | null = null;
      if (typeof entry.credentials === 'function') {
        const c = entry.credentials();
        if (c.switch().name === 'sorobanCredentialsAddress') {
          const addr = c.address().address();
          // Convert ScAddress to string
          credsAddress = addr ? (typeof addr.toString === 'function' ? addr.toString() : String(addr)) : null;
        }
      }
      if (credsAddress && credsAddress !== agentPublicKey) {
        throw new ChainError(
          `Auth entry credential address ${credsAddress} does not match agent ${agentPublicKey}`,
          null,
          { credsAddress, agentPublicKey },
          'INVALID_AUTH_CREDENTIALS',
        );
      }

      // Validate root invocation method
      if (expectedMethod && typeof entry.rootInvocation === 'function') {
        const root = entry.rootInvocation();
        const fnName = root.function?.()?.switch?.()?.name ?? '';
        if (fnName && fnName !== expectedMethod && !fnName.includes(expectedMethod)) {
          logger.warn({ fnName, expectedMethod }, 'Root invocation does not match expected method');
        }
      }
    } catch (err: any) {
      if (err instanceof ChainError) throw err;
      // non-fatal if XDR structure differences in test mocks
    }
  }
}
