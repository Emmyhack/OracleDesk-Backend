/**
 * Stellar chain access for the backend.
 *
 * Reads go through read-only binding clients (simulation, no signer).
 * Writes always go through the treasury (`agent_create_market`, `agent_buy`,
 * `agent_sell`) so its on-chain risk caps apply, plus
 * `reasoning_registry.publish_trace`. The backend never calls
 * `market_core.buy` with the agent key.
 *
 * CHAIN_EXECUTION_MODE=dry-run (the default) builds and simulates every
 * write, logs the simulated result and returns it without signing.
 *
 * Why not reuse agents/stellar/adapter.ts from the contracts repo: its
 * dry-run mode returns the arguments without simulating, it imports the
 * bindings by npm package name (not installed here), and it has no
 * agent_sell. This service keeps the same method names and mode semantics
 * so the two can converge (see docs/contract-requests.md).
 */
import type { AssembledTransaction } from '@stellar/stellar-sdk/contract';
import type { rpc } from '@stellar/stellar-sdk';
import { config } from '../config';
import { logger } from '../lib/logger';
import { agentClients, agentSigner, readClients } from './stellar/clients';
import { ChainError, ChainPendingError, TransactionError, contractErrorName, ArchivedEntryError } from './stellar/errors';
import {
  parseReturnValue,
  prismaOutboxStore,
  runCompletionHandler,
  type ChainTransactionRow,
  type OutboxStore,
} from './stellar/outbox';
import { SequenceLockLost, rebuildWithSequence, withSourceAccount } from './stellar/sequence';
import {
  ChainWriteFailure,
  classifyFailure,
  retryDecision,
  type ClassifiedFailure,
  type RetryOptions,
} from './stellar/failures';
import { withTimeout, TimeoutError, sleep } from '../lib/resilience';
import type { Category, Config as MarketCoreConfig, Market as OnChainMarket, Outcome, Position } from '../generated/market-core';
import type { Trace } from '../generated/reasoning-registry';
import type { DailyUsage, RiskConfig } from '../generated/treasury';
import type { PriceConfig, ResolutionState, SignerConfig } from '../generated/resolver';
import { agentScopeForTraceAction } from '../lib/trace-actions';
import {
  AgentPausedError,
  assertAgentActive,
  assertAgentActiveLocked,
  recordChainWriteOutcome,
  type AgentScope,
} from './agent-controls.service';

import { Keypair, scValToNative } from '@stellar/stellar-sdk';
import { prisma } from '../lib/prisma';
import { getFeeOracle, type OperationClass } from './stellar/fees';
import { timeoutFor, decideExpiry, ExpiredError, type ExpiryDecision, authExpirationLedger } from './stellar/timebounds';
import {
  getTransactionReader,
  getTransactionSender,
  type TransactionReader,
  type TransactionSender,
} from './stellar/tx-inspect';
import {
  getChannelPool,
  channelSigner,
  verifyChannelAuthEntries,
  type LeasedChannel,
  type Signer,
} from './stellar/channels';

export { ExpiredError, ArchivedEntryError };

type ContractKey = 'marketCore' | 'treasury' | 'resolver' | 'reasoningRegistry';

export interface FeeDetails {
  opClass: OperationClass;
  inclusionFee: bigint;
  resourceFee: bigint;
  totalFee: bigint;
  feeCharged?: bigint;
}

/**
 * Domain correlation for the transactional outbox (#35): which completion
 * handler owns the write and which domain row it updates.
 */
export interface WriteRef {
  kind: string;
  refId: string;
}

export { ChainPendingError };
export type { OnChainMarket };

export type WriteResult<T> =
  | { mode: 'dry-run'; method: string; value: T; txHash: null; fee?: FeeDetails; outboxId?: string }
  | { mode: 'live'; method: string; value: T; txHash: string | null; fee?: FeeDetails; outboxId?: string };

export const Outcomes = {
  Yes: { tag: 'Yes', values: undefined } as Outcome,
  No: { tag: 'No', values: undefined } as Outcome,
};

/** Value from a simulated call, unwrapping contract `Result`s into ChainErrors. */
export function simulatedValue<T>(contract: ContractKey, method: string, tx: AssembledTransaction<unknown>): T {
  const sim = tx.simulation as { error?: string } | undefined;
  const hostError = typeof sim?.error === 'string' ? sim.error : undefined;
  if (hostError && /archived|restore/i.test(hostError)) {
    throw new ArchivedEntryError(`Simulation failed due to archived state: ${hostError}`, { method });
  }

  let raw: unknown;
  try {
    raw = tx.result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/archived|restore/i.test(msg)) {
      throw new ArchivedEntryError(`Simulation failed due to archived state: ${msg}`, { method });
    }
    throw new ChainError(`${method} simulation failed`, contractErrorName(contract, err, hostError), { method });
  }

  if (raw && typeof raw === 'object' && 'isOk' in raw && typeof (raw as { isOk: unknown }).isOk === 'function') {
    const result = raw as { isOk(): boolean; unwrap(): T };
    if (!result.isOk()) {
      const name = contractErrorName(contract, raw, hostError);
      if (name && /archived|restore/i.test(name)) {
        throw new ArchivedEntryError(`Contract entry is archived: ${name}`, { method, contractError: name });
      }
      throw new ChainError(`${method} failed: ${name ?? 'contract error'}`, name, { method });
    }
    return result.unwrap();
  }
  return raw as T;
}

async function readTx<T>(
  contract: ContractKey,
  method: string,
  call: () => Promise<AssembledTransaction<unknown>>,
  signal?: AbortSignal,
): Promise<{ value: T; tx: AssembledTransaction<unknown> }> {
  return withTimeout(
    'rpc-read',
    async () => {
      let tx: AssembledTransaction<unknown>;
      try {
        tx = await call();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/archived|restore/i.test(msg)) {
          throw new ArchivedEntryError(`Simulation failed due to archived state: ${msg}`, { method });
        }
        throw new ChainError(`${method} read failed`, contractErrorName(contract, err), {
          method,
          cause: msg,
        });
      }
      return { value: simulatedValue<T>(contract, method, tx), tx };
    },
    { signal },
  );
}

async function read<T>(
  contract: ContractKey,
  method: string,
  call: () => Promise<AssembledTransaction<unknown>>,
  signal?: AbortSignal,
): Promise<T> {
  return (await readTx<T>(contract, method, call, signal)).value;
}

const retryOptions = (): RetryOptions => ({
  maxAttempts: config.CHAIN_RETRY_MAX_ATTEMPTS,
  baseDelayMs: config.CHAIN_RETRY_BASE_MS,
  maxDelayMs: config.CHAIN_RETRY_MAX_MS,
  deadlineMs: config.CHAIN_RETRY_DEADLINE_MS,
});

/** Pull a structured send response off an SDK error, when the SDK attached one. */
function extractSendResponse(err: unknown): rpc.Api.SendTransactionResponse | undefined {
  const anyErr = err as {
    status?: string;
    sendTransactionResponse?: rpc.Api.SendTransactionResponse;
    response?: rpc.Api.SendTransactionResponse;
    errorResult?: unknown;
    errorResultXdr?: string;
  };
  for (const candidate of [anyErr?.sendTransactionResponse, anyErr?.response]) {
    if (candidate && typeof (candidate as { status?: unknown }).status === 'string') return candidate;
  }
  if (typeof anyErr?.status === 'string' && (anyErr.errorResult || anyErr.errorResultXdr)) {
    return anyErr as unknown as rpc.Api.SendTransactionResponse;
  }
  return undefined;
}

/**
 * Every chain write goes through here (#79): the agent's control state is
 * checked before the transaction is built, re-checked under a share lock after
 * simulation (right before signing), and the outcome feeds the failure breaker.
 *
 * Routing:
 * - dry-run, and live writes through a leased channel account (#37), go
 *   through `submitWrite`: fee from the oracle (#39), explicit timebounds and
 *   expiry tracking (#42).
 * - live writes from the agent account go through the sequence-locked
 *   attempt (#36) with classified retries (#40), using the same fee and
 *   timeout choice.
 */
async function write<T>(
  scope: AgentScope,
  opClass: OperationClass,
  contract: WriteContract,
  method: string,
  args: Record<string, unknown>,
  call: WriteCall,
  signal?: AbortSignal,
  ref?: WriteRef,
): Promise<WriteResult<T>> {
  const seenVersion = await assertAgentActive(scope);
  try {
    const viaAgentAccount = config.CHAIN_EXECUTION_MODE === 'live' && getChannelPool().size === 0;
    const result = viaAgentAccount
      ? await liveWriteWithRetry<T>(scope, seenVersion, opClass, contract, method, args, call, signal, ref)
      : await submitWrite<T>(scope, seenVersion, opClass, contract, method, args, call, signal, ref);
    await recordChainWriteOutcome(scope, true, null);
    return result;
  } catch (err) {
    // A refused write never reached the chain; it is not a chain failure.
    if (!(err instanceof AgentPausedError)) {
      await recordChainWriteOutcome(scope, false, err instanceof ChainError ? err.contractError : null);
    }
    throw err;
  }
}

type WriteContract = 'treasury' | 'reasoningRegistry' | 'resolver';
type WriteCall = (options?: { fee?: bigint; timeoutInSeconds?: number }, signer?: Signer) => Promise<AssembledTransaction<unknown>>;

async function submitWrite<T>(
  scope: AgentScope,
  seenVersion: number,
  opClass: OperationClass,
  contract: WriteContract,
  method: string,
  args: Record<string, unknown>,
  call: WriteCall,
  signal?: AbortSignal,
  ref?: WriteRef,
): Promise<WriteResult<T>> {
  const oracle = getFeeOracle();
  const policy = oracle.getPolicies()[opClass];
  const inclusionFee = await oracle.pickInclusionFee(opClass);
  const timeoutInSeconds = timeoutFor(opClass);

  let leasedChannel: LeasedChannel | null = null;
  let signer: Signer | undefined = undefined;

  if (config.CHAIN_EXECUTION_MODE === 'live') {
    const pool = getChannelPool();
    if (pool.size > 0) {
      leasedChannel = await pool.acquire();
      const agentKeypair = Keypair.fromSecret(config.AGENT_SECRET_KEY);
      signer = channelSigner(leasedChannel.channel.keypair, agentKeypair);
    }
  }

  try {
    let tx: AssembledTransaction<unknown>;
    try {
      tx = await call({ fee: inclusionFee, timeoutInSeconds }, signer);
    } catch (err) {
      throw new ChainError(`${method} could not be built`, contractErrorName(contract, err), {
        method,
        cause: err instanceof Error ? err.message : String(err),
      });
    }
    const simulated = simulatedValue<T>(contract, method, tx);

    // A pause that landed while the transaction was being built stops here.
    await assertAgentActiveLocked(scope, seenVersion);

    const minResourceFee = BigInt((tx.simulation as any)?.minResourceFee ?? '0');
    const expectedTotal = inclusionFee + minResourceFee;

    if (minResourceFee > policy.budget) {
      if (config.CHAIN_EXECUTION_MODE === 'dry-run') {
        logger.warn(
          { opClass, minResourceFee: minResourceFee.toString(), budget: policy.budget.toString() },
          'Fee budget exceeded (dry-run)',
        );
      } else {
        throw new ChainError(
          `Resource fee ${minResourceFee.toString()} exceeds budget ${policy.budget.toString()} for ${opClass}`,
          'FEE_BUDGET_EXCEEDED',
          {
            opClass,
            minResourceFee: minResourceFee.toString(),
            budget: policy.budget.toString(),
            simulatedResources: tx.simulation,
          },
          'FEE_BUDGET_EXCEEDED',
        );
      }
    }

    const rawBuiltFee = (tx as any)?.built?.fee;
    if (rawBuiltFee !== undefined && rawBuiltFee !== null) {
      const builtFee = BigInt(rawBuiltFee);
      if (builtFee !== expectedTotal) {
        logger.warn(
          { opClass, builtFee: builtFee.toString(), expectedTotal: expectedTotal.toString() },
          'Built fee differs from inclusion fee + minResourceFee',
        );
      }
    }

    const rawMaxTime = (tx as any)?.built?.timeBounds?.maxTime;
    // #35: once RPC retention has passed, a submitted transaction can only be
    // resolved by its timebounds; a live write without a maxTime is refused.
    if (config.CHAIN_EXECUTION_MODE !== 'dry-run' && (rawMaxTime === undefined || rawMaxTime === null || BigInt(rawMaxTime) === 0n)) {
      throw new ChainError(`${method} was built without timebounds; refusing to submit`, null, { method });
    }
    const maxTime = rawMaxTime !== undefined && rawMaxTime !== null
      ? BigInt(rawMaxTime)
      : BigInt(Math.floor(Date.now() / 1000) + timeoutInSeconds);
    const minTime = 0n;

    let authExpLedger: number | null = null;
    if (leasedChannel) {
      const agentPub = Keypair.fromSecret(config.AGENT_SECRET_KEY).publicKey();
      verifyChannelAuthEntries(tx, agentPub, method);

      const simLatestLedger = Number((tx.simulation as any)?.latestLedger ?? 0);
      const simCloseTime = Number((tx.simulation as any)?.latestLedgerCloseTime ?? Math.floor(Date.now() / 1000));
      authExpLedger = authExpirationLedger({
        latestLedger: simLatestLedger,
        latestLedgerCloseTime: simCloseTime,
        maxTime: Number(maxTime),
      });

      if (typeof (tx as any).signAuthEntries === 'function') {
        await (tx as any).signAuthEntries({ expirationLedger: authExpLedger });
      }

      // Re-simulate after signing auth entries (#37)
      if (typeof (tx as any).simulate === 'function') {
        await (tx as any).simulate();
      }
    }

    const feeDetails: FeeDetails = {
      opClass,
      inclusionFee,
      resourceFee: minResourceFee,
      totalFee: expectedTotal,
    };

    if (config.CHAIN_EXECUTION_MODE === 'dry-run') {
      logger.info(
        {
          method,
          args: printable(args),
          simulated: printable(simulated),
          timeoutInSeconds,
          minTime: minTime.toString(),
          maxTime: maxTime.toString(),
        },
        'dry-run: simulated, not submitted',
      );
      return { mode: 'dry-run', method, value: simulated, txHash: null, fee: feeDetails };
    }

  // #35: the write exists in the outbox before anything irreversible happens.
  // The row moves BUILT -> SIGNED -> SUBMITTED around the steps below; a crash
  // at any point leaves a row the recovery worker can resolve by hash.
  const store = prismaOutboxStore();
  let outboxRow: ChainTransactionRow = await store.create({
    kind: ref?.kind ?? `${contract}.${method}`,
    refId: ref?.refId ?? null,
    contract,
    method,
    args: printable(args) as object,
    simulated: printable(simulated) as object,
    source: (signer?.publicKey as string | undefined) ?? (agentSigner().publicKey as string),
    minTime,
    maxTime,
    innerFee: inclusionFee.toString(),
    resourceFee: minResourceFee.toString(),
  });

    if (typeof (tx as any).sign === 'function') {
      await (tx as any).sign();
    }

  let txHash: string | null = null;
  try {
    const rawTx = tx as any;
    if (typeof rawTx?.built?.hash === 'function') {
      txHash = rawTx.built.hash().toString('hex');
    }
  } catch {}

  // The signed envelope and hash are durable before sendTransaction, so
  // recovery can resubmit this exact envelope (same hash, same sequence).
  {
    const rawTx = tx as any;
    const signedRow = await store.transition(outboxRow.id, ['BUILT'], 'SIGNED', {
      envelopeXdr: typeof rawTx?.built?.toXDR === 'function' ? rawTx.built.toXDR() : null,
      hash: txHash,
      sequence: rawTx?.built?.sequence != null ? String(rawTx.built.sequence) : null,
    });
    if (signedRow) outboxRow = signedRow;
  }

  const sender = getTransactionSender();
  const reader = getTransactionReader();

  let sendRes: any;
  try {
    sendRes = await withTimeout(
      'rpc-write',
      async () => {
        if (typeof sender.sendTransaction === 'function') {
          return sender.sendTransaction((tx as any).built ?? tx);
        }
        return (tx as any).send?.() ?? (tx as any).signAndSend?.();
      },
      { signal },
    );
  } catch (err: any) {
    if (err instanceof TimeoutError || err?.code === 'UPSTREAM_TIMEOUT') {
      throw new ChainError(
        `${method} submission timed out`,
        null,
        { outcome: 'unknown', txHash },
        'CHAIN_SUBMISSION_TIMEOUT',
      );
    }
    throw new ChainError(`${method} submission failed`, contractErrorName(contract, err), {
      method,
      cause: err instanceof Error ? err.message : String(err),
    });
  }

  outboxRow = await acceptSend(store, outboxRow, contract, txHash, sendRes);

  const finalHash = sendRes?.sendTransactionResponse?.hash ?? sendRes?.hash ?? txHash;
  if (!finalHash) {
    throw new ChainError(`${method} no transaction hash returned from send`, null, { method });
  }

  const submittedLedger = sendRes?.latestLedger ?? (tx.simulation as any)?.latestLedger;
  const submittedAtCloseTime = sendRes?.latestLedgerCloseTime !== undefined
    ? BigInt(sendRes.latestLedgerCloseTime)
    : undefined;

  if (sendRes?.latestLedgerCloseTime) {
    const hostSec = Math.floor(Date.now() / 1000);
    if (Math.abs(hostSec - Number(sendRes.latestLedgerCloseTime)) > 30) {
      logger.warn(
        { hostTime: hostSec, ledgerCloseTime: Number(sendRes.latestLedgerCloseTime) },
        'Host clock differs from ledger close time by > 30s',
      );
    }
  }

  return await confirmSubmitted<T>({
    store,
    outboxRow,
    contract,
    method,
    opClass,
    args,
    tx,
    reader,
    sendRes,
    simulated,
    minTime,
    maxTime,
    timeoutInSeconds,
    feeDetails,
    expectedTotal,
    inclusionFee,
    minResourceFee,
    finalHash,
    submittedLedger,
    submittedAtCloseTime,
    signal,
  });
  } finally {
    if (leasedChannel) {
      await leasedChannel.release();
    }
  }
}

/** Retry loop for live writes (#40): only provably-not-applied failures retry. */
async function liveWriteWithRetry<T>(
  scope: AgentScope,
  seenVersion: number,
  opClass: OperationClass,
  contract: WriteContract,
  method: string,
  args: Record<string, unknown>,
  call: WriteCall,
  signal?: AbortSignal,
  ref?: WriteRef,
): Promise<WriteResult<T>> {
  const opts = retryOptions();
  const startedAt = Date.now();
  let attempt = 0;
  for (;;) {
    try {
      return await attemptWrite<T>(scope, seenVersion, opClass, contract, method, args, call, signal, ref);
    } catch (err) {
      if (err instanceof AgentPausedError) throw err;
      // Expiry has its own recovery (#42) and a pending submission belongs to
      // the outbox worker (#35): neither is retried blindly here.
      if (err instanceof ExpiredError) throw err;
      if (err instanceof ChainPendingError) throw err;
      const failure: ClassifiedFailure =
        err instanceof ChainWriteFailure ? err.failure : classifyFailure({ contract, err });
      const { retry, delayMs } = retryDecision(failure, attempt, opts, Date.now() - startedAt);
      if (!retry) {
        throw new TransactionError(`${method} failed (${failure.class})`, failure, attempt + 1);
      }
      logger.warn(
        {
          method,
          failureClass: failure.class,
          txCode: failure.txCode,
          opCode: failure.opCode,
          attempt: attempt + 1,
          delayMs,
        },
        'chain write retrying',
      );
      await sleep(delayMs, signal);
      attempt++;
    }
  }
}

async function attemptWrite<T>(
  scope: AgentScope,
  seenVersion: number,
  opClass: OperationClass,
  contract: WriteContract,
  method: string,
  args: Record<string, unknown>,
  call: WriteCall,
  signal?: AbortSignal,
  ref?: WriteRef,
): Promise<WriteResult<T>> {
  // Live, agent-sourced: build, simulate, sign and send inside the
  // per-source-account critical section so the sequence number is
  // collision-free across writers (#36). The lock is released as soon as
  // sendTransaction returns; confirmation polling happens after release.
  // The signed envelope is persisted before the send (#35) and the path never
  // uses signAndSend: signing and submission are explicit, separate steps.
  const oracle = getFeeOracle();
  const inclusionFee = await oracle.pickInclusionFee(opClass);
  const timeoutInSeconds = timeoutFor(opClass);
  const store = prismaOutboxStore();
  const account = agentSigner().publicKey as string;
  let outboxRow: ChainTransactionRow | null = null;

  try {
    const sent = await withSourceAccount(
      account,
      async (ctx) => {
        let tx: AssembledTransaction<unknown>;
        try {
          tx = await call({ fee: inclusionFee, timeoutInSeconds });
        } catch (err) {
          throw new ChainError(`${method} could not be built`, contractErrorName(contract, err), {
            method,
            cause: err instanceof Error ? err.message : String(err),
          });
        }
        const simulated = simulatedValue<T>(contract, method, tx);

        // A pause that landed while the transaction was being built stops here.
        await assertAgentActiveLocked(scope, seenVersion);

        const rawMaxTime = (tx as any)?.built?.timeBounds?.maxTime;
        // #35: past RPC retention only timebounds can resolve a row.
        if (rawMaxTime === undefined || rawMaxTime === null || BigInt(rawMaxTime) === 0n) {
          throw new ChainError(`${method} was built without timebounds; refusing to submit`, null, { method });
        }
        const maxTime = BigInt(rawMaxTime);
        const minTime = 0n;
        const minResourceFee = BigInt((tx.simulation as any)?.minResourceFee ?? '0');

        // #35: the write exists in the outbox before anything irreversible happens.
        outboxRow = await store.create({
          kind: ref?.kind ?? `${contract}.${method}`,
          refId: ref?.refId ?? null,
          contract,
          method,
          args: printable(args) as object,
          simulated: printable(simulated) as object,
          source: account,
          minTime,
          maxTime,
          innerFee: inclusionFee.toString(),
          resourceFee: minResourceFee.toString(),
        });

        // The binding built and simulated against the RPC's account; rewrite the
        // built transaction with the sequence allocated from the cached counter.
        const rawTx = tx as unknown as { built?: any };
        if (rawTx?.built) {
          try {
            rawTx.built = rebuildWithSequence(rawTx.built, ctx.account, config.STELLAR_NETWORK_PASSPHRASE);
          } catch (err) {
            throw new ChainError(`${method} could not apply the allocated sequence`, null, {
              method,
              cause: err instanceof Error ? err.message : String(err),
            });
          }
        }

        if (typeof (tx as any).sign === 'function') {
          await (tx as any).sign();
        }
        let txHash: string | null = null;
        try {
          if (typeof rawTx?.built?.hash === 'function') txHash = rawTx.built.hash().toString('hex');
        } catch {}

        // The signed envelope and hash are durable before sendTransaction, so
        // recovery can resubmit this exact envelope (same hash, same sequence).
        const signedRow = await store.transition(outboxRow.id, ['BUILT'], 'SIGNED', {
          envelopeXdr: typeof rawTx?.built?.toXDR === 'function' ? rawTx.built.toXDR() : null,
          hash: txHash,
          sequence: rawTx?.built?.sequence != null ? String(rawTx.built.sequence) : null,
        });
        if (signedRow) outboxRow = signedRow;

        const sender = getTransactionSender();
        try {
          // Fence: a holder that lost its lock must never submit.
          ctx.assertHeld();
          const sendRes: any = await withTimeout(
            'rpc-write',
            async () => {
              if (typeof sender.sendTransaction === 'function') {
                return sender.sendTransaction((tx as any).built ?? tx);
              }
              return (tx as any).send?.();
            },
            { signal },
          );
          outboxRow = await acceptSend(store, outboxRow, contract, txHash, sendRes);
          // The network accepted the envelope: reserve the sequence.
          await ctx.advanceSequence();
          return { tx, simulated, txHash, sendRes, maxTime, minTime, minResourceFee };
        } catch (err: any) {
          if (err instanceof SequenceLockLost) {
            // Aborted before send: safe to retry on a fresh sequence.
            await ctx.resync().catch(() => undefined);
            throw new ChainWriteFailure(
              { class: 'TRANSIENT_RPC', txCode: null, opCode: null, contractError: null, txHash, submitted: false },
              err,
            );
          }
          if (err instanceof TimeoutError || err?.code === 'UPSTREAM_TIMEOUT') {
            // The submission may have been applied: re-read and never rebuild it.
            await ctx.resync().catch(() => undefined);
            throw new ChainWriteFailure(
              { class: 'UNKNOWN_OUTCOME', txCode: null, opCode: null, contractError: null, txHash, submitted: true },
              err,
            );
          }
          if (err instanceof ChainWriteFailure) {
            if (err.failure.class === 'BAD_SEQUENCE' || err.failure.class === 'UNKNOWN_OUTCOME') {
              await ctx.resync().catch(() => undefined);
            }
            throw err;
          }
          if (err instanceof ChainError) throw err;
          const failure = classifyFailure({ contract, err, send: extractSendResponse(err) });
          if (failure.class === 'BAD_SEQUENCE' || failure.class === 'UNKNOWN_OUTCOME') {
            await ctx.resync().catch(() => undefined);
          }
          throw new ChainWriteFailure({ ...failure, txHash: failure.txHash ?? txHash }, err);
        }
      },
      { waitMs: config.SEQ_LOCK_WAIT_MS, signal },
    );

    // Confirmation runs outside the sequence lock.
    const oraclePolicy = oracle.getPolicies()[opClass];
    void oraclePolicy;
    const expectedTotal = inclusionFee + sent.minResourceFee;
    const finalHash = sent.sendRes?.sendTransactionResponse?.hash ?? sent.sendRes?.hash ?? sent.txHash;
    if (!finalHash) {
      throw new ChainError(`${method} no transaction hash returned from send`, null, { method });
    }
    return await confirmSubmitted<T>({
      store,
      outboxRow: outboxRow!,
      contract,
      method,
      opClass,
      args,
      tx: sent.tx,
      reader: getTransactionReader(),
      sendRes: sent.sendRes,
      simulated: sent.simulated,
      minTime: sent.minTime,
      maxTime: sent.maxTime,
      timeoutInSeconds,
      feeDetails: { opClass, inclusionFee, resourceFee: sent.minResourceFee, totalFee: expectedTotal },
      expectedTotal,
      inclusionFee,
      minResourceFee: sent.minResourceFee,
      finalHash,
      submittedLedger: sent.sendRes?.latestLedger ?? (sent.tx.simulation as any)?.latestLedger,
      submittedAtCloseTime:
        sent.sendRes?.latestLedgerCloseTime !== undefined ? BigInt(sent.sendRes.latestLedgerCloseTime) : undefined,
      signal,
    });
  } catch (err: any) {
    // #35: an attempt that provably never reached the network is terminal for
    // its row (a retry builds a fresh envelope and a fresh row), and the live
    // caller's error path stands in for the completion handler. Ambiguous
    // outcomes leave the row for the recovery worker.
    const ambiguous =
      (err instanceof ChainWriteFailure && err.failure.submitted) || err instanceof ChainPendingError || err instanceof ExpiredError;
    if (!ambiguous && outboxRow) {
      await store
        .transition((outboxRow as ChainTransactionRow).id, ['BUILT', 'SIGNED'], 'FAILED', {
          error: err instanceof Error ? err.message : String(err),
          handledAt: new Date(),
        })
        .catch(() => undefined);
    }
    throw err;
  }
}



/**
 * Maps a sendTransaction response onto the outbox state machine (#35):
 * PENDING and DUPLICATE both mean the network has this exact envelope
 * (SUBMITTED); ERROR (e.g. txBadSeq) means it can never land (terminal
 * FAILED — a retry builds a fresh envelope and a fresh row); TRY_AGAIN_LATER
 * stays SIGNED and throws retryable without consuming the row's hash.
 */
async function acceptSend(
  store: OutboxStore,
  row: ChainTransactionRow,
  contract: WriteContract,
  txHash: string | null,
  sendRes: any,
): Promise<ChainTransactionRow> {
  const status = sendRes?.status ?? sendRes?.sendTransactionResponse?.status;
  if (status === 'ERROR') {
    const failure = classifyFailure({ contract, send: sendRes });
    await store
      .transition(row.id, ['SIGNED'], 'FAILED', {
        error: failure.txCode ?? failure.class,
        handledAt: new Date(),
      })
      .catch(() => undefined);
    throw new ChainWriteFailure(
      { ...failure, txHash: failure.txHash ?? txHash },
      new Error(`sendTransaction returned ERROR (${failure.txCode ?? failure.class})`),
    );
  }
  if (status === 'TRY_AGAIN_LATER') {
    throw new ChainWriteFailure(
      { class: 'TRANSIENT_RPC', txCode: null, opCode: null, contractError: null, txHash, submitted: false },
      new Error('sendTransaction returned TRY_AGAIN_LATER'),
    );
  }
  const moved = await store.transition(row.id, ['SIGNED'], 'SUBMITTED', {
    submitLedger: typeof sendRes?.latestLedger === 'number' ? sendRes.latestLedger : null,
  });
  return moved ?? row;
}

interface ConfirmInput<T> {
  store: OutboxStore;
  outboxRow: ChainTransactionRow;
  contract: WriteContract;
  method: string;
  opClass: OperationClass;
  args: Record<string, unknown>;
  tx: AssembledTransaction<unknown>;
  reader: TransactionReader;
  sendRes: any;
  simulated: T;
  minTime: bigint;
  maxTime: bigint;
  timeoutInSeconds: number;
  feeDetails: FeeDetails;
  expectedTotal: bigint;
  inclusionFee: bigint;
  minResourceFee: bigint;
  finalHash: string;
  submittedLedger: number | undefined;
  submittedAtCloseTime: bigint | undefined;
  signal?: AbortSignal;
}

/**
 * Polls a submitted transaction to a decision and finishes the outbox row
 * (#35): LANDED runs the completion handler inline and returns; FAILED and
 * EXPIRED transition the row (handled: the live caller's error path owns
 * them); an inline wait past OUTBOX_INLINE_WAIT_MS moves the row to PENDING
 * and throws CHAIN_PENDING, leaving resolution to the recovery worker.
 */
async function confirmSubmitted<T>(c: ConfirmInput<T>): Promise<WriteResult<T>> {
  const { store, contract, method, opClass, args, tx, reader, sendRes, minTime, maxTime, timeoutInSeconds, finalHash } = c;
  let outboxRow = c.outboxRow;

  if (sendRes?.latestLedgerCloseTime) {
    const hostSec = Math.floor(Date.now() / 1000);
    if (Math.abs(hostSec - Number(sendRes.latestLedgerCloseTime)) > 30) {
      logger.warn(
        { hostTime: hostSec, ledgerCloseTime: Number(sendRes.latestLedgerCloseTime) },
        'Host clock differs from ledger close time by > 30s',
      );
    }
  }

  const attemptId = (args as any)?.attemptId ?? null;
  const submissionRecord = (decision: string) =>
    prisma.chainSubmission
      .upsert({
        where: { txHash: finalHash },
        create: {
          txHash: finalHash,
          opClass,
          minTime,
          maxTime,
          authExpirationLedger: (tx as any).authExpirationLedger ?? null,
          submittedLedger: c.submittedLedger ? Number(c.submittedLedger) : null,
          submittedAtCloseTime: c.submittedAtCloseTime,
          decision,
          attemptId,
        },
        update: { decision },
      })
      .catch(() => undefined);

  const pollIntervalMs = 2000;
  // #35: the inline wait is bounded; past it the write returns CHAIN_PENDING
  // and the outbox worker owns resolution.
  const maxPollTimeoutMs = Math.min((timeoutInSeconds + 30) * 1000, config.OUTBOX_INLINE_WAIT_MS);
  const pollStart = Date.now();
  let confirmedTx: any = null;
  let decision: ExpiryDecision = 'PENDING';

  while (Date.now() - pollStart < maxPollTimeoutMs) {
    if (c.signal?.aborted) {
      throw new ChainError(
        `${method} poll aborted`,
        null,
        { outcome: 'unknown', txHash: finalHash },
        'CHAIN_SUBMISSION_TIMEOUT',
      );
    }

    let txStatusRes: any;
    try {
      txStatusRes = await reader.getTransaction(finalHash);
    } catch (err: any) {
      logger.warn({ err: err?.message, txHash: finalHash }, 'getTransaction poll error; retrying');
    }

    if (txStatusRes) {
      const latestLedgerCloseTime = Number(txStatusRes.latestLedgerCloseTime ?? Math.floor(Date.now() / 1000));
      const oldestLedgerCloseTime = txStatusRes.oldestLedgerCloseTime !== undefined ? Number(txStatusRes.oldestLedgerCloseTime) : undefined;

      decision = decideExpiry({
        status: txStatusRes.status,
        latestLedgerCloseTime,
        maxTime: Number(maxTime),
        submittedAtCloseTime: c.submittedAtCloseTime !== undefined ? Number(c.submittedAtCloseTime) : undefined,
        oldestLedgerCloseTime,
      });

      if (decision === 'LANDED' || decision === 'FAILED') {
        confirmedTx = txStatusRes;
        break;
      }

      if (decision === 'EXPIRED') {
        await submissionRecord('EXPIRED');
        // The live caller's expiry handling (#42 rebuild) stands in for the
        // completion handler, so the row is marked handled.
        await store
          .transition(outboxRow.id, ['SUBMITTED'], 'EXPIRED', {
            error: 'expired without inclusion',
            handledAt: new Date(),
          })
          .catch(() => undefined);
        throw new ExpiredError(`Transaction ${finalHash} expired without inclusion`, attemptId, finalHash);
      }

      if (decision === 'UNKNOWN') {
        await submissionRecord('UNKNOWN');
        throw new ChainError(
          `Transaction ${finalHash} outcome is unknown (beyond RPC retention window)`,
          null,
          { outcome: 'unknown', txHash: finalHash },
          'CHAIN_TX_UNKNOWN',
        );
      }
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  if (decision === 'PENDING') {
    await submissionRecord('PENDING');
    // #35: submitted but unconfirmed within the inline wait. The recovery
    // worker resolves it; the caller records an intermediate state.
    const pendingRow = await store.transition(outboxRow.id, ['SUBMITTED'], 'PENDING', {}).catch(() => null);
    throw new ChainPendingError(
      `${method} submitted; outcome pending (tx ${finalHash})`,
      (pendingRow ?? outboxRow).id,
      finalHash,
    );
  }

  if (decision === 'FAILED') {
    await submissionRecord('FAILED');
    const errName = contractErrorName(contract, confirmedTx);
    // The live caller's error path stands in for the completion handler.
    await store
      .transition(outboxRow.id, ['SUBMITTED'], 'FAILED', {
        landedHash: finalHash,
        ledger: (confirmedTx as any)?.ledger ?? null,
        error: errName ?? 'failed on-chain',
        handledAt: new Date(),
      })
      .catch(() => undefined);
    throw new ChainError(`${method} failed on-chain: ${errName ?? 'Unknown error'}`, errName, { method, txHash: finalHash });
  }

  await submissionRecord('LANDED');

  const feeChargedRaw = (confirmedTx as any)?.feeCharged ?? (sendRes as any)?.feeCharged;
  const feeCharged = feeChargedRaw !== undefined ? BigInt(feeChargedRaw) : c.expectedTotal;
  const liveFeeDetails: FeeDetails = { ...c.feeDetails, feeCharged };

  await prisma.chainFee
    .upsert({
      where: { txHash: finalHash },
      create: {
        txHash: finalHash,
        opClass,
        inclusionFee: c.inclusionFee,
        resourceFee: c.minResourceFee,
        totalFee: c.expectedTotal,
        feeCharged,
      },
      update: { feeCharged },
    })
    .catch((err: any) => logger.warn({ err: err?.message, txHash: finalHash }, 'Failed to record chain fee'));

  // The on-chain return value decoded with the binding's spec is the source
  // of truth; the simulation result is the fallback (#35).
  const chainValue = parseReturnValue({ contract, method }, (confirmedTx as any)?.returnValue);
  const value = (chainValue ?? simulatedValueFromSent<T>(contract, method, c.simulated)) as T;

  const successRow = await store
    .transition(outboxRow.id, ['SUBMITTED', 'PENDING'], 'SUCCESS', {
      landedHash: finalHash,
      ledger: (confirmedTx as any)?.ledger ?? null,
      returnValue: printable(value) as object,
    })
    .catch(() => null);
  if (successRow) {
    outboxRow = successRow;
    // The completion handler has run by the time write() resolves, so callers
    // read success state back instead of writing it (#35). Idempotent: a crash
    // here is re-run by the recovery worker.
    await runCompletionHandler(successRow, { status: 'SUCCESS', value, txHash: finalHash }).catch((err) =>
      logger.error({ err, outboxId: successRow.id, kind: successRow.kind }, 'completion handler failed; recovery will retry'),
    );
  }

  logger.info({ method, txHash: finalHash, outboxId: outboxRow.id }, 'submitted and confirmed');
  return { mode: 'live', method, value, txHash: finalHash, fee: liveFeeDetails, outboxId: outboxRow.id };
}

function simulatedValueFromSent<T>(contract: ContractKey, method: string, result: unknown): T {
  if (result && typeof result === 'object' && 'isOk' in result) {
    const r = result as { isOk(): boolean; unwrap(): T };
    if (!r.isOk()) throw new ChainError(`${method} failed`, contractErrorName(contract, result), { method });
    return r.unwrap();
  }
  return result as T;
}

/** JSON-safe view (bigint → string, Buffer → hex) for logs and API output. */
export function printable(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value)) return value.toString('hex');
  if (Array.isArray(value)) return value.map(printable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, printable(v)]));
  }
  return value;
}

// ─── Reads ────────────────────────────────────────────────────────────────

const marketCountImpl = (signal?: AbortSignal) =>
  read<bigint>('marketCore', 'market_count', async () => (await readClients.marketCore()).market_count(), signal);

const getOnChainMarketImpl = (marketId: bigint, signal?: AbortSignal) =>
  read<OnChainMarket>('marketCore', 'get_market', async () => readClients.marketCore().get_market({ market_id: marketId }), signal);

/**
 * get_market plus the ledger the simulation ran against (`latestLedger`), so a
 * caller can tell how fresh the observation is (#83).
 */
export async function getOnChainMarketWithLedger(
  marketId: bigint,
  signal?: AbortSignal,
): Promise<{ market: OnChainMarket; ledger: number }> {
  const { value, tx } = await readTx<OnChainMarket>(
    'marketCore',
    'get_market',
    async () => readClients.marketCore().get_market({ market_id: marketId }),
    signal,
  );
  const ledger = Number((tx.simulation as { latestLedger?: number | string } | undefined)?.latestLedger);
  if (!Number.isFinite(ledger)) throw new ChainError('get_market simulation returned no ledger', null, { method: 'get_market' });
  return { market: value, ledger };
}

const getPriceImpl = (marketId: bigint, outcome: Outcome, signal?: AbortSignal) =>
  read<number>('marketCore', 'get_price', async () => readClients.marketCore().get_price({ market_id: marketId, outcome }), signal);

const quoteBuyImpl = (marketId: bigint, outcome: Outcome, collateralIn: bigint, signal?: AbortSignal) =>
  read<bigint>('marketCore', 'quote_buy', async () =>
    readClients.marketCore().quote_buy({ market_id: marketId, outcome, collateral_in: collateralIn }), signal,
  );

const quoteSellImpl = (marketId: bigint, outcome: Outcome, collateralOut: bigint, signal?: AbortSignal) =>
  read<bigint>('marketCore', 'quote_sell', async () =>
    readClients.marketCore().quote_sell({ market_id: marketId, outcome, collateral_out: collateralOut }), signal,
  );

const getPositionImpl = (marketId: bigint, holder: string, signal?: AbortSignal) =>
  read<Position>('marketCore', 'get_position', async () =>
    readClients.marketCore().get_position({ market_id: marketId, holder }), signal,
  );

export const getOnChainTrace = (traceId: bigint, signal?: AbortSignal) =>
  read<Trace>('reasoningRegistry', 'get_trace', async () => readClients.reasoningRegistry().get_trace({ trace_id: traceId }), signal);

export const getOnChainTraceOrNull = async (traceId: bigint, signal?: AbortSignal): Promise<Trace | null> => {
  try {
    return await getOnChainTrace(traceId, signal);
  } catch (err: any) {
    if (
      err instanceof ChainError &&
      (err.contractError === 'TraceNotFound' ||
        err.message.includes('TraceNotFound') ||
        err.message.includes('#5'))
    ) {
      return null;
    }
    throw err;
  }
};

export const traceCount = (signal?: AbortSignal) =>
  read<bigint>('reasoningRegistry', 'trace_count', async () => readClients.reasoningRegistry().trace_count(), signal);

export const marketTraceCount = (marketId: bigint, signal?: AbortSignal) =>
  read<bigint>('reasoningRegistry', 'market_trace_count', async () =>
    readClients.reasoningRegistry().market_trace_count({ market_id: marketId }), signal);

export const marketTraceAt = (marketId: bigint, index: bigint, signal?: AbortSignal) =>
  read<bigint>('reasoningRegistry', 'market_trace_at', async () =>
    readClients.reasoningRegistry().market_trace_at({ market_id: marketId, index }), signal);

export const resolverState = (marketId: bigint, signal?: AbortSignal) =>
  read<ResolutionState>('resolver', 'state', async () => readClients.resolver().state({ market_id: marketId }), signal);

const treasuryAvailableCapitalImpl = (signal?: AbortSignal) =>
  read<bigint>('treasury', 'available_capital', async () => readClients.treasury().available_capital(), signal);

const treasuryRiskConfigImpl = (signal?: AbortSignal) =>
  read<RiskConfig>('treasury', 'get_config', async () => readClients.treasury().get_config(), signal);

/** @deprecated use treasuryRiskConfig */
export const treasuryConfig = (signal?: AbortSignal) => treasuryRiskConfig(signal);

/** The view already applies the contract's rolling-window rollover (rolled_daily_usage). */
const treasuryDailyUsageImpl = (signal?: AbortSignal) =>
  read<DailyUsage>('treasury', 'daily_usage', async () => readClients.treasury().daily_usage(), signal);

const marketCoreConfigImpl = () =>
  read<MarketCoreConfig>('marketCore', 'get_config', async () => readClients.marketCore().get_config());

// ─── Writes (through the treasury) ───────────────────────────────────────────

export interface CreateMarketArgs {
  question_hash: Buffer;
  resolution_hash: Buffer;
  meta_uri: string;
  category: Category;
  close_time: bigint;
  seed_amount: bigint;
  initial_yes_bps: number;
}

const agentCreateMarketImpl = (args: CreateMarketArgs, signal?: AbortSignal, ref?: WriteRef) =>
  write<bigint>('MARKET_MAKER', 'market_create', 'treasury', 'agent_create_market', { ...args }, async (opts, signer) =>
    agentClients.treasury(signer).agent_create_market(args, opts as any), signal, ref,
  );

export type AgentBuyArgs = { market_id: bigint; outcome: Outcome; collateral_in: bigint; min_shares_out: bigint };

/**
 * Buys through the treasury. The argument source may be a thunk so a retried
 * attempt (#40) re-quotes `min_shares_out` against the live price instead of
 * reusing the first attempt's stale bound.
 */
const agentBuyImpl = (
  args: AgentBuyArgs | (() => Promise<AgentBuyArgs>),
  signal?: AbortSignal,
  /** Logged with the write and keyed into chain_submissions (#42); the
   *  trade.buy completion handler reads collateral_in/feeRaw from it (#35). */
  meta: Record<string, unknown> = {},
  ref?: WriteRef,
) => {
  const resolver = typeof args === 'function' ? args : async () => args;
  return write<bigint>('TRADER', 'trade', 'treasury', 'agent_buy', { ...(typeof args === 'function' ? {} : args), ...meta }, async (opts, signer) =>
    agentClients.treasury(signer).agent_buy(await resolver(), opts as any), signal, ref);
};

const agentSellImpl = (
  args: { market_id: bigint; outcome: Outcome; collateral_out: bigint; max_shares_in: bigint },
  signal?: AbortSignal,
  ref?: WriteRef,
) =>
  write<bigint>('TRADER', 'trade', 'treasury', 'agent_sell', args, async (opts, signer) =>
    agentClients.treasury(signer).agent_sell(args, opts as any), signal, ref,
  );

const publishTraceImpl = (args: {
  agent: string;
  market_id: bigint;
  action: string;
  trace_hash: Buffer;
  ipfs_cid: string;
}, signal?: AbortSignal, scope: AgentScope = agentScopeForTraceAction(args.action), ref?: WriteRef) =>
  write<bigint>(scope, 'trace_publish', 'reasoningRegistry', 'publish_trace', args, async (opts, signer) =>
    agentClients.reasoningRegistry(signer).publish_trace(args, opts as any), signal, ref,
  );

// ─── Resolver writes (#90) ───────────────────────────────────────────────────
// Both calls are permissionless; the agent only pays the fee and provides the
// source account. Reveal commits the price spec; resolve reads the feed at
// close_time and finalises market-core.

export const registerPriceSpec = (marketId: bigint, spec: PriceConfig, signal?: AbortSignal) =>
  write<void>('MARKET_MAKER', 'maintenance', 'resolver', 'register_price_spec', { market_id: marketId, spec }, async (opts) =>
    agentClients.resolver().register_price_spec({ market_id: marketId, spec }, opts as any), signal,
  );

export const resolvePrice = (marketId: bigint, signal?: AbortSignal) =>
  write<Outcome>('MARKET_MAKER', 'maintenance', 'resolver', 'resolve_price', { market_id: marketId }, async (opts) =>
    agentClients.resolver().resolve_price({ market_id: marketId }, opts as any), signal,
  );

const registerSignerSpecImpl = (marketId: bigint, spec: SignerConfig, signal?: AbortSignal) =>
  write<void>('MARKET_MAKER', 'maintenance', 'resolver', 'register_signer_spec', { market_id: marketId, spec }, async (opts) =>
    agentClients.resolver().register_signer_spec({ market_id: marketId, spec }, opts as any), signal,
  );

const attestImpl = (marketId: bigint, signerPublicKey: string, outcome: 'YES' | 'NO', signal?: AbortSignal) =>
  write<void>('MARKET_MAKER', 'maintenance', 'resolver', 'attest', { market_id: marketId, signer: signerPublicKey, outcome }, async (opts, signer) =>
    agentClients.resolver(signer).attest({
      market_id: marketId,
      signer: signerPublicKey,
      outcome: outcome === 'YES' ? { tag: 'Yes', values: undefined } : { tag: 'No', values: undefined },
    }, opts as any), signal,
  );

const finalizeSignersImpl = (marketId: bigint, signal?: AbortSignal) =>
  write<Outcome>('MARKET_MAKER', 'maintenance', 'resolver', 'finalize_signers', { market_id: marketId }, async (opts, signer) =>
    agentClients.resolver(signer).finalize_signers({ market_id: marketId }, opts as any), signal,
  );

// ─── Test seam (#72) ─────────────────────────────────────────────────────────
// Agent-cycle tests replace chain calls at this level instead of faking the
// RPC (a fake RPC server is a separate piece of work). Production never sets
// an override.

const IMPLS = {
  getPosition: getPositionImpl,
  marketCoreConfig: marketCoreConfigImpl,
  marketCount: marketCountImpl,
  getOnChainMarket: getOnChainMarketImpl,
  getPrice: getPriceImpl,
  quoteBuy: quoteBuyImpl,
  quoteSell: quoteSellImpl,
  treasuryAvailableCapital: treasuryAvailableCapitalImpl,
  treasuryRiskConfig: treasuryRiskConfigImpl,
  treasuryDailyUsage: treasuryDailyUsageImpl,
  agentCreateMarket: agentCreateMarketImpl,
  agentBuy: agentBuyImpl,
  agentSell: agentSellImpl,
  publishTrace: publishTraceImpl,
  registerSignerSpec: registerSignerSpecImpl,
  attest: attestImpl,
  finalizeSigners: finalizeSignersImpl,
};

export type ChainOverrides = Partial<typeof IMPLS>;

let overrides: ChainOverrides = {};

/** Replaces the named chain functions until reset. Pass null to clear all. Returns the previous overrides. */
export function setChainOverrides(next: ChainOverrides | null): ChainOverrides {
  const prev = overrides;
  overrides = next ?? {};
  return prev;
}

function overridable<K extends keyof typeof IMPLS>(name: K): (typeof IMPLS)[K] {
  return ((...args: unknown[]) => ((overrides[name] ?? IMPLS[name]) as (...a: unknown[]) => unknown)(...args)) as (typeof IMPLS)[K];
}

export const marketCount = overridable('marketCount');
export const getOnChainMarket = overridable('getOnChainMarket');
export const getPrice = overridable('getPrice');
export const quoteBuy = overridable('quoteBuy');
export const quoteSell = overridable('quoteSell');
export const treasuryAvailableCapital = overridable('treasuryAvailableCapital');
export const treasuryRiskConfig = overridable('treasuryRiskConfig');
export const treasuryDailyUsage = overridable('treasuryDailyUsage');
export const agentCreateMarket = overridable('agentCreateMarket');
export const agentBuy = overridable('agentBuy');
export const agentSell = overridable('agentSell');
export const publishTrace = overridable('publishTrace');
export const marketCoreConfig = overridable('marketCoreConfig');
export const getPosition = overridable('getPosition');
export const registerSignerSpec = overridable('registerSignerSpec');
export const attest = overridable('attest');
export const finalizeSigners = overridable('finalizeSigners');
