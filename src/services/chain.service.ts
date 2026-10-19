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
import { ChainError, TransactionError, contractErrorName, ArchivedEntryError } from './stellar/errors';
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
import type { PriceConfig, ResolutionState } from '../generated/resolver';
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
export type { OnChainMarket };

type ContractKey = 'marketCore' | 'treasury' | 'resolver' | 'reasoningRegistry';

export interface FeeDetails {
  opClass: OperationClass;
  inclusionFee: bigint;
  resourceFee: bigint;
  totalFee: bigint;
  feeCharged?: bigint;
}

export type WriteResult<T> =
  | { mode: 'dry-run'; method: string; value: T; txHash: null; fee?: FeeDetails }
  | { mode: 'live'; method: string; value: T; txHash: string | null; fee?: FeeDetails };

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
 * Live failures are classified and retried by policy (#40); dry-run never
 * retries and never touches the network.
 */
async function write<T>(
  scope: AgentScope,
  opClass: OperationClass,
  contract: 'treasury' | 'reasoningRegistry' | 'resolver',
  method: string,
  args: Record<string, unknown>,
  call: (options?: { fee?: bigint; timeoutInSeconds?: number }, signer?: Signer) => Promise<AssembledTransaction<unknown>>,
  signal?: AbortSignal,
): Promise<WriteResult<T>> {
  const seenVersion = await assertAgentActive(scope);
  try {
    const result =
      config.CHAIN_EXECUTION_MODE === 'dry-run'
        ? await dryRunWrite<T>(scope, seenVersion, opClass, contract, method, args, call)
        : await liveWriteWithRetry<T>(scope, seenVersion, opClass, contract, method, args, call, signal);
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

async function dryRunWrite<T>(
  scope: AgentScope,
  seenVersion: number,
  opClass: OperationClass,
  contract: ContractKey,
  method: string,
  args: Record<string, unknown>,
  call: (options?: { fee?: bigint; timeoutInSeconds?: number }, signer?: Signer) => Promise<AssembledTransaction<unknown>>,
): Promise<WriteResult<T>> {
  // The fee policy applies in dry-run too, so a simulation reports the same
  // inclusion fee and timebounds a live submission would use (#39, #42).
  const oracle = getFeeOracle();
  const policy = oracle.getPolicies()[opClass];
  const inclusionFee = await oracle.pickInclusionFee(opClass);
  const timeoutInSeconds = timeoutFor(opClass);

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
  await assertAgentActiveLocked(scope, seenVersion);

  const minResourceFee = BigInt((tx.simulation as any)?.minResourceFee ?? '0');
  if (minResourceFee > policy.budget) {
    logger.warn(
      { opClass, minResourceFee: minResourceFee.toString(), budget: policy.budget.toString() },
      'Fee budget exceeded (dry-run)',
    );
  }
  logger.info(
    { method, args: printable(args), simulated: printable(simulated), timeoutInSeconds },
    'dry-run: simulated, not submitted',
  );
  return {
    mode: 'dry-run',
    method,
    value: simulated,
    txHash: null,
    fee: { opClass, inclusionFee, resourceFee: minResourceFee, totalFee: inclusionFee + minResourceFee },
  };
}

/** Retry loop for live writes (#40): only provably-not-applied failures retry. */
async function liveWriteWithRetry<T>(
  scope: AgentScope,
  seenVersion: number,
  opClass: OperationClass,
  contract: ContractKey,
  method: string,
  args: Record<string, unknown>,
  call: (options?: { fee?: bigint; timeoutInSeconds?: number }, signer?: Signer) => Promise<AssembledTransaction<unknown>>,
  signal?: AbortSignal,
): Promise<WriteResult<T>> {
  const opts = retryOptions();
  const startedAt = Date.now();
  let attempt = 0;
  for (;;) {
    try {
      return await attemptWrite<T>(scope, seenVersion, opClass, contract, method, args, call, signal);
    } catch (err) {
      if (err instanceof AgentPausedError) throw err;
      // Expiry has its own recovery (#42): the caller re-checks the edge and
      // resubmits a fresh build, so it is never retried blindly here.
      if (err instanceof ExpiredError) throw err;
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

/**
 * One live submission attempt: pick the inclusion fee (#39), lease a channel
 * account when a pool is configured (#37), build and simulate, enforce the
 * fee budget, apply explicit timebounds (#42), sign and send, then poll the
 * transaction to a LANDED / FAILED / EXPIRED / UNKNOWN decision. Without a
 * channel pool the agent account is the transaction source, so the
 * rebuild-to-send window runs inside its per-source-account sequence lock
 * (#36), released as soon as the network accepts the envelope.
 */
async function attemptWrite<T>(
  scope: AgentScope,
  seenVersion: number,
  opClass: OperationClass,
  contract: ContractKey,
  method: string,
  args: Record<string, unknown>,
  call: (options?: { fee?: bigint; timeoutInSeconds?: number }, signer?: Signer) => Promise<AssembledTransaction<unknown>>,
  signal?: AbortSignal,
): Promise<WriteResult<T>> {
  const oracle = getFeeOracle();
  const policy = oracle.getPolicies()[opClass];
  const inclusionFee = await oracle.pickInclusionFee(opClass);
  const timeoutInSeconds = timeoutFor(opClass);

  let leasedChannel: LeasedChannel | null = null;
  let signer: Signer | undefined = undefined;

  const pool = getChannelPool();
  if (pool.size > 0) {
    leasedChannel = await pool.acquire();
    const agentKeypair = Keypair.fromSecret(config.AGENT_SECRET_KEY);
    signer = channelSigner(leasedChannel.channel.keypair, agentKeypair);
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
    const maxTime = rawMaxTime !== undefined
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

  let txHash: string | null = null;
  const sender = getTransactionSender();
  const reader = getTransactionReader();

  const signAndHash = async () => {
    if (typeof (tx as any).sign === 'function') {
      await (tx as any).sign();
    }
    try {
      const rawTx = tx as any;
      if (typeof rawTx?.built?.hash === 'function') {
        txHash = rawTx.built.hash().toString('hex');
      }
    } catch {}
  };

  const send = () =>
    withTimeout(
      'rpc-write',
      async () => {
        if (typeof sender.sendTransaction === 'function') {
          return sender.sendTransaction((tx as any).built ?? tx);
        }
        return (tx as any).send?.() ?? (tx as any).signAndSend?.();
      },
      { signal },
    );

  let sendRes: any;
  try {
    if (leasedChannel) {
      // The leased channel is the transaction source, so its sequence is
      // contention-free for the duration of the lease.
      await signAndHash();
      sendRes = await send();
    } else {
      // #36: agent-sourced writes serialize on the agent account's sequence.
      // The lock spans rebuild → send and is released as soon as the network
      // accepts the envelope, never held through confirmation polling.
      const account = agentSigner().publicKey as string;
      sendRes = await withSourceAccount(
        account,
        async (ctx) => {
          // The binding built and simulated against the RPC's account; rewrite
          // the built transaction with the sequence from the cached counter.
          const rawTx = tx as unknown as { built?: unknown };
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
          await signAndHash();
          try {
            // Fence: a holder that lost its lock must never submit.
            ctx.assertHeld();
            const res = await send();
            // The network accepted the envelope: reserve the sequence.
            await ctx.advanceSequence();
            return res;
          } catch (err: any) {
            if (
              err instanceof SequenceLockLost ||
              err instanceof TimeoutError ||
              err?.code === 'UPSTREAM_TIMEOUT'
            ) {
              await ctx.resync().catch(() => undefined);
              throw err;
            }
            const failure = classifyFailure({ contract, err, send: extractSendResponse(err) });
            if (failure.class === 'BAD_SEQUENCE' || failure.class === 'UNKNOWN_OUTCOME') {
              await ctx.resync().catch(() => undefined);
            }
            throw new ChainWriteFailure({ ...failure, txHash: failure.txHash ?? txHash }, err);
          }
        },
        { waitMs: config.SEQ_LOCK_WAIT_MS, signal },
      );
    }
  } catch (err: any) {
    if (err instanceof ChainWriteFailure) throw err;
    if (err instanceof SequenceLockLost) {
      // Aborted before send: safe to retry on a fresh sequence.
      throw new ChainWriteFailure(
        { class: 'TRANSIENT_RPC', txCode: null, opCode: null, contractError: null, txHash, submitted: false },
        err,
      );
    }
    if (err instanceof TimeoutError || err?.code === 'UPSTREAM_TIMEOUT') {
      // The submission may have been applied: ambiguous, never rebuilt (#40).
      throw new ChainWriteFailure(
        { class: 'UNKNOWN_OUTCOME', txCode: null, opCode: null, contractError: null, txHash, submitted: true },
        err,
      );
    }
    if (err instanceof ChainError) throw err;
    const failure = classifyFailure({ contract, err, send: extractSendResponse(err) });
    throw new ChainWriteFailure({ ...failure, txHash: failure.txHash ?? txHash }, err);
  }

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

  const attemptId = (args as any)?.attemptId ?? null;
  const pollIntervalMs = 2000;
  const maxPollTimeoutMs = (timeoutInSeconds + 30) * 1000;
  const pollStart = Date.now();
  let confirmedTx: any = null;
  let decision: ExpiryDecision = 'PENDING';

  while (Date.now() - pollStart < maxPollTimeoutMs) {
    if (signal?.aborted) {
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
        submittedAtCloseTime: submittedAtCloseTime !== undefined ? Number(submittedAtCloseTime) : undefined,
        oldestLedgerCloseTime,
      });

      if (decision === 'LANDED' || decision === 'FAILED') {
        confirmedTx = txStatusRes;
        break;
      }

      if (decision === 'EXPIRED') {
        await prisma.chainSubmission.upsert({
          where: { txHash: finalHash },
          create: {
            txHash: finalHash,
            opClass,
            minTime,
            maxTime,
            authExpirationLedger: (tx as any).authExpirationLedger ?? null,
            submittedLedger: submittedLedger ? Number(submittedLedger) : null,
            submittedAtCloseTime,
            decision: 'EXPIRED',
            attemptId,
          },
          update: { decision: 'EXPIRED' },
        }).catch(() => undefined);

        throw new ExpiredError(`Transaction ${finalHash} expired without inclusion`, attemptId, finalHash);
      }

      if (decision === 'UNKNOWN') {
        await prisma.chainSubmission.upsert({
          where: { txHash: finalHash },
          create: {
            txHash: finalHash,
            opClass,
            minTime,
            maxTime,
            authExpirationLedger: (tx as any).authExpirationLedger ?? null,
            submittedLedger: submittedLedger ? Number(submittedLedger) : null,
            submittedAtCloseTime,
            decision: 'UNKNOWN',
            attemptId,
          },
          update: { decision: 'UNKNOWN' },
        }).catch(() => undefined);

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
    await prisma.chainSubmission.upsert({
      where: { txHash: finalHash },
      create: {
        txHash: finalHash,
        opClass,
        minTime,
        maxTime,
        authExpirationLedger: (tx as any).authExpirationLedger ?? null,
        submittedLedger: submittedLedger ? Number(submittedLedger) : null,
        submittedAtCloseTime,
        decision: 'PENDING',
        attemptId,
      },
      update: { decision: 'PENDING' },
    }).catch(() => undefined);

    throw new ChainError(
      `${method} submission timed out while still PENDING`,
      null,
      { outcome: 'unknown', txHash: finalHash },
      'CHAIN_SUBMISSION_TIMEOUT',
    );
  }

  if (decision === 'FAILED') {
    await prisma.chainSubmission.upsert({
      where: { txHash: finalHash },
      create: {
        txHash: finalHash,
        opClass,
        minTime,
        maxTime,
        authExpirationLedger: (tx as any).authExpirationLedger ?? null,
        submittedLedger: submittedLedger ? Number(submittedLedger) : null,
        submittedAtCloseTime,
        decision: 'FAILED',
        attemptId,
      },
      update: { decision: 'FAILED' },
    }).catch(() => undefined);

    const errName = contractErrorName(contract, confirmedTx);
    throw new ChainError(`${method} failed on-chain: ${errName ?? 'Unknown error'}`, errName, { method, txHash: finalHash });
  }

  // Record LANDED submission
  await prisma.chainSubmission.upsert({
    where: { txHash: finalHash },
    create: {
      txHash: finalHash,
      opClass,
      minTime,
      maxTime,
      authExpirationLedger: (tx as any).authExpirationLedger ?? null,
      submittedLedger: submittedLedger ? Number(submittedLedger) : null,
      submittedAtCloseTime,
      decision: 'LANDED',
      attemptId,
    },
    update: { decision: 'LANDED' },
  }).catch(() => undefined);

  const feeChargedRaw = (confirmedTx as any)?.feeCharged ?? (sendRes as any)?.feeCharged;
  const feeCharged = feeChargedRaw !== undefined ? BigInt(feeChargedRaw) : expectedTotal;
  const liveFeeDetails: FeeDetails = {
    ...feeDetails,
    feeCharged,
  };

  await prisma.chainFee.upsert({
    where: { txHash: finalHash },
    create: {
      txHash: finalHash,
      opClass,
      inclusionFee,
      resourceFee: minResourceFee,
      totalFee: expectedTotal,
      feeCharged,
    },
    update: {
      feeCharged,
    },
  }).catch((err: any) => logger.warn({ err: err?.message, txHash: finalHash }, 'Failed to record chain fee'));

  const value = simulatedValueFromSent<T>(contract, method, (confirmedTx as any)?.returnValue ?? simulated);
  logger.info({ method, txHash: finalHash }, 'submitted and confirmed');
  return { mode: 'live', method, value, txHash: finalHash, fee: liveFeeDetails };
  } finally {
    if (leasedChannel) {
      await leasedChannel.release();
    }
  }
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

export const marketCount = (signal?: AbortSignal) =>
  read<bigint>('marketCore', 'market_count', async () => (await readClients.marketCore()).market_count(), signal);

export const getOnChainMarket = (marketId: bigint, signal?: AbortSignal) =>
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

export const getPrice = (marketId: bigint, outcome: Outcome, signal?: AbortSignal) =>
  read<number>('marketCore', 'get_price', async () => readClients.marketCore().get_price({ market_id: marketId, outcome }), signal);

export const quoteBuy = (marketId: bigint, outcome: Outcome, collateralIn: bigint, signal?: AbortSignal) =>
  read<bigint>('marketCore', 'quote_buy', async () =>
    readClients.marketCore().quote_buy({ market_id: marketId, outcome, collateral_in: collateralIn }), signal,
  );

export const quoteSell = (marketId: bigint, outcome: Outcome, collateralOut: bigint, signal?: AbortSignal) =>
  read<bigint>('marketCore', 'quote_sell', async () =>
    readClients.marketCore().quote_sell({ market_id: marketId, outcome, collateral_out: collateralOut }), signal,
  );

export const getPosition = (marketId: bigint, holder: string, signal?: AbortSignal) =>
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

export const treasuryAvailableCapital = (signal?: AbortSignal) =>
  read<bigint>('treasury', 'available_capital', async () => readClients.treasury().available_capital(), signal);

export const treasuryConfig = () =>
  read<RiskConfig>('treasury', 'get_config', async () => readClients.treasury().get_config());

export const treasuryDailyUsage = () =>
  read<DailyUsage>('treasury', 'daily_usage', async () => readClients.treasury().daily_usage());

export const marketCoreConfig = () =>
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

export const agentCreateMarket = (args: CreateMarketArgs, signal?: AbortSignal) =>
  write<bigint>('MARKET_MAKER', 'market_create', 'treasury', 'agent_create_market', { ...args }, async (opts, signer) =>
    agentClients.treasury(signer).agent_create_market(args, opts as any), signal,
  );

export type AgentBuyArgs = { market_id: bigint; outcome: Outcome; collateral_in: bigint; min_shares_out: bigint };

/**
 * Buys through the treasury. The argument source may be a thunk so a retried
 * attempt (#40) re-quotes `min_shares_out` against the live price instead of
 * reusing the first attempt's stale bound. `meta` carries submission tracking
 * (attemptId, rebuildCount; #41/#42) into the write log and chain_submissions.
 */
export const agentBuy = (
  args: AgentBuyArgs | (() => Promise<AgentBuyArgs>),
  signal?: AbortSignal,
  meta: Record<string, unknown> = {},
) => {
  const resolveArgs = typeof args === 'function' ? args : async () => args;
  return write<bigint>(
    'TRADER',
    'trade',
    'treasury',
    'agent_buy',
    { ...(typeof args === 'function' ? {} : args), ...meta },
    async (opts, signer) => agentClients.treasury(signer).agent_buy(await resolveArgs(), opts as any),
    signal,
  );
};

export const agentSell = (args: { market_id: bigint; outcome: Outcome; collateral_out: bigint; max_shares_in: bigint }, signal?: AbortSignal) =>
  write<bigint>('TRADER', 'trade', 'treasury', 'agent_sell', args, async (opts, signer) =>
    agentClients.treasury(signer).agent_sell(args, opts as any), signal,
  );

export const publishTrace = (args: {
  agent: string;
  market_id: bigint;
  action: string;
  trace_hash: Buffer;
  ipfs_cid: string;
}, signal?: AbortSignal, scope: AgentScope = agentScopeForTraceAction(args.action)) =>
  write<bigint>(scope, 'trace_publish', 'reasoningRegistry', 'publish_trace', args, async (opts, signer) =>
    agentClients.reasoningRegistry(signer).publish_trace(args, opts as any), signal,
  );

// ─── Resolver writes (#90) ───────────────────────────────────────────────────
// Both calls are permissionless; the agent only pays the fee and provides the
// source account. Reveal commits the price spec; resolve reads the feed at
// close_time and finalises market-core.

export const registerPriceSpec = (marketId: bigint, spec: PriceConfig, signal?: AbortSignal) =>
  write<void>('MARKET_MAKER', 'maintenance', 'resolver', 'register_price_spec', { market_id: marketId, spec }, async (opts, signer) =>
    agentClients.resolver(signer).register_price_spec({ market_id: marketId, spec }, opts as any), signal,
  );

export const resolvePrice = (marketId: bigint, signal?: AbortSignal) =>
  write<Outcome>('MARKET_MAKER', 'maintenance', 'resolver', 'resolve_price', { market_id: marketId }, async (opts, signer) =>
    agentClients.resolver(signer).resolve_price({ market_id: marketId }, opts as any), signal,
  );
