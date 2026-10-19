import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  Account,
  Address,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
} from '@stellar/stellar-sdk';
import { setupTestEnv } from './helpers/env';
import {
  verifyCopyTradeTx,
  confirmCopyTrade,
  CopyTradePendingError,
  CopyTradeStatus,
} from '../src/services/copy-trade.service';
import { CONTRACTS } from '../src/config/contracts';
import { setTransactionReader, TransactionReader } from '../src/services/stellar/tx-inspect';

setupTestEnv();

const FIXTURES = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'tests', 'fixtures', 'events.json'), 'utf8'),
).events;

const BASE_TRADE_EVENT = FIXTURES[0]; // market 0, is_buy: true, outcome: Yes
const TRADER_ADDR = Address.fromScVal(
  xdr.ScVal.fromXDR(BASE_TRADE_EVENT.topic[2], 'base64'),
).toString();

function makeReader(
  status: rpc.Api.GetTransactionStatus,
  events: any[] = [BASE_TRADE_EVENT],
  envelope?: xdr.TransactionEnvelope,
): TransactionReader {
  return {
    async getTransaction(hash: string) {
      return {
        status,
        txHash: hash,
        ledger: 4951600,
        resultMetaXdr: { events },
        envelopeXdr: envelope,
      } as any;
    },
  };
}

function buyEnvelope(opts: {
  trader: string;
  contract?: string;
  fn?: string;
  marketId?: bigint;
  passphrase?: string;
}) {
  const source = new Account(opts.trader, '1');
  const tx = new TransactionBuilder(source, {
    fee: '100',
    networkPassphrase: opts.passphrase ?? Networks.TESTNET,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: opts.contract ?? CONTRACTS.marketCore,
        function: opts.fn ?? 'buy',
        args: [
          new Address(opts.trader).toScVal(),
          nativeToScVal(opts.marketId ?? 0n, { type: 'u64' }),
          nativeToScVal({ Yes: [] }),
          nativeToScVal(100_000_000n, { type: 'i128' }),
          nativeToScVal(1n, { type: 'i128' }),
        ],
      }),
    )
    .setTimeout(30)
    .build();
  return tx.toEnvelope();
}

function feeBumpEnvelope(innerEnv: xdr.TransactionEnvelope, feeSource: string) {
  const innerTx = TransactionBuilder.fromXDR(innerEnv.toXDR('base64'), Networks.TESTNET);
  const feeBump = TransactionBuilder.buildFeeBumpTransaction(
    feeSource,
    '200',
    innerTx as any,
    Networks.TESTNET,
  );
  return feeBump.toEnvelope();
}

test('confirms a valid buy and records collateral, shares and fee from the event', async () => {
  const txHash = '11'.repeat(32);
  const envelope = buyEnvelope({ trader: TRADER_ADDR });
  const reader = makeReader(rpc.Api.GetTransactionStatus.SUCCESS, [BASE_TRADE_EVENT], envelope);

  const result = await verifyCopyTradeTx(
    {
      txHash,
      trader: TRADER_ADDR,
      onChainMarketId: 0n,
      outcome: 'Yes',
      maxCollateral: 200_000_000n,
    },
    reader,
  );

  assert.equal(result.txHash, txHash);
  assert.equal(result.trader, TRADER_ADDR);
  assert.equal(result.onChainMarketId, 0n);
  assert.equal(result.outcome, 'Yes');
  assert.equal(result.collateral, 100_000_000n);
  assert.equal(result.shares, 768854n);
  assert.equal(result.fee, 3874n);
});

test('returns CONFIRMING when getTransaction is NOT_FOUND', async () => {
  const txHash = '22'.repeat(32);
  const reader = makeReader(rpc.Api.GetTransactionStatus.NOT_FOUND);

  await assert.rejects(
    async () => {
      await verifyCopyTradeTx(
        {
          txHash,
          trader: TRADER_ADDR,
          onChainMarketId: 0n,
          outcome: 'Yes',
          maxCollateral: 200_000_000n,
        },
        reader,
      );
    },
    (err: any) => {
      assert.ok(err instanceof CopyTradePendingError);
      assert.equal(err.statusCode, 202);
      return true;
    },
  );
});

test('rejects a failed transaction, wrong market, wrong trader, opposite outcome and sells', async () => {
  const txHash = '33'.repeat(32);

  // 1. Transaction failed on-chain
  const failedReader = makeReader(rpc.Api.GetTransactionStatus.FAILED);
  await assert.rejects(
    async () => {
      await verifyCopyTradeTx(
        {
          txHash,
          trader: TRADER_ADDR,
          onChainMarketId: 0n,
          outcome: 'Yes',
          maxCollateral: 200_000_000n,
        },
        failedReader,
      );
    },
    (err: any) => {
      assert.equal(err.code, 'COPY_TRADE_TX_FAILED');
      return true;
    },
  );

  // 2. Wrong market
  const validReader = makeReader(rpc.Api.GetTransactionStatus.SUCCESS);
  await assert.rejects(
    async () => {
      await verifyCopyTradeTx(
        {
          txHash,
          trader: TRADER_ADDR,
          onChainMarketId: 99n, // wrong market
          outcome: 'Yes',
          maxCollateral: 200_000_000n,
        },
        validReader,
      );
    },
    (err: any) => {
      assert.equal(err.code, 'COPY_TRADE_WRONG_MARKET');
      return true;
    },
  );

  // 3. Wrong trader
  const anotherTrader = Keypair.random().publicKey();
  await assert.rejects(
    async () => {
      await verifyCopyTradeTx(
        {
          txHash,
          trader: anotherTrader,
          onChainMarketId: 0n,
          outcome: 'Yes',
          maxCollateral: 200_000_000n,
        },
        validReader,
      );
    },
    (err: any) => {
      assert.equal(err.code, 'COPY_TRADE_WRONG_TRADER');
      return true;
    },
  );

  // 4. Opposite outcome
  await assert.rejects(
    async () => {
      await verifyCopyTradeTx(
        {
          txHash,
          trader: TRADER_ADDR,
          onChainMarketId: 0n,
          outcome: 'No', // opposite outcome
          maxCollateral: 200_000_000n,
        },
        validReader,
      );
    },
    (err: any) => {
      assert.equal(err.code, 'COPY_TRADE_WRONG_SIDE');
      return true;
    },
  );

  // 5. Amount exceeded
  await assert.rejects(
    async () => {
      await verifyCopyTradeTx(
        {
          txHash,
          trader: TRADER_ADDR,
          onChainMarketId: 0n,
          outcome: 'Yes',
          maxCollateral: 50_000_000n, // less than 100_000_000
        },
        validReader,
      );
    },
    (err: any) => {
      assert.equal(err.code, 'COPY_TRADE_AMOUNT_EXCEEDED');
      return true;
    },
  );
});

test('accepts a fee-bump wrapped buy', async () => {
  const txHash = '44'.repeat(32);
  const inner = buyEnvelope({ trader: TRADER_ADDR });
  const feePayer = Keypair.random().publicKey();
  const feeBump = feeBumpEnvelope(inner, feePayer);

  const reader = makeReader(rpc.Api.GetTransactionStatus.SUCCESS, [BASE_TRADE_EVENT], feeBump);

  const result = await verifyCopyTradeTx(
    {
      txHash,
      trader: TRADER_ADDR,
      onChainMarketId: 0n,
      outcome: 'Yes',
      maxCollateral: 200_000_000n,
    },
    reader,
  );

  assert.equal(result.collateral, 100_000_000n);
});

test('accepts a smart-wallet routed buy based on the Trade event trader', async () => {
  const txHash = '55'.repeat(32);
  // Smart wallet envelope routes through a proxy contract, not directly marketCore
  const smartWalletContract = Keypair.random().publicKey();
  const smartWalletEnvelope = buyEnvelope({
    trader: TRADER_ADDR,
    contract: smartWalletContract,
    fn: 'execute',
  });

  const reader = makeReader(
    rpc.Api.GetTransactionStatus.SUCCESS,
    [BASE_TRADE_EVENT],
    smartWalletEnvelope,
  );

  const result = await verifyCopyTradeTx(
    {
      txHash,
      trader: TRADER_ADDR,
      onChainMarketId: 0n,
      outcome: 'Yes',
      maxCollateral: 200_000_000n,
    },
    reader,
  );

  assert.equal(result.collateral, 100_000_000n);
});

test('rejects reuse of a txHash across two copy trades and confirm is idempotent for the same hash', async () => {
  const txHash = '66'.repeat(32);
  const copyTradeId1 = 'ct-test-1';
  const copyTradeId2 = 'ct-test-2';
  const userId = 'u-test';

  const mockDb = {
    copyTrades: new Map<string, any>([
      [
        copyTradeId1,
        {
          id: copyTradeId1,
          userId,
          followerWallet: TRADER_ADDR,
          outcome: 'YES',
          amountRaw: '200000000',
          status: CopyTradeStatus.PENDING,
          txHash: null,
          market: { onChainMarketId: 0n },
        },
      ],
      [
        copyTradeId2,
        {
          id: copyTradeId2,
          userId,
          followerWallet: TRADER_ADDR,
          outcome: 'YES',
          amountRaw: '200000000',
          status: CopyTradeStatus.PENDING,
          txHash: null,
          market: { onChainMarketId: 0n },
        },
      ],
    ]),
  };

  const mockPrisma = {
    copyTrade: {
      findFirst: async ({ where }: any) => {
        if (where.id) return mockDb.copyTrades.get(where.id) ?? null;
        if (where.txHash) {
          for (const ct of mockDb.copyTrades.values()) {
            if (ct.txHash === where.txHash && ct.id !== where.id?.not) return ct;
          }
        }
        return null;
      },
      update: async ({ where, data }: any) => {
        const ct = mockDb.copyTrades.get(where.id);
        if (ct) Object.assign(ct, data);
        return ct;
      },
    },
  };

  const envelope = buyEnvelope({ trader: TRADER_ADDR });
  const reader = makeReader(rpc.Api.GetTransactionStatus.SUCCESS, [BASE_TRADE_EVENT], envelope);
  setTransactionReader(reader);

  // First confirmation succeeds
  const confirmed1 = await confirmCopyTrade(userId, TRADER_ADDR, copyTradeId1, txHash, mockPrisma as any);
  assert.equal(confirmed1.status, CopyTradeStatus.EXECUTED);
  assert.equal(confirmed1.txHash, txHash);

  // Idempotent retry of first trade with same hash returns existing record
  const idempotent = await confirmCopyTrade(userId, TRADER_ADDR, copyTradeId1, txHash, mockPrisma as any);
  assert.equal(idempotent.status, CopyTradeStatus.EXECUTED);

  // Attempting to use the same txHash for second copy trade is rejected (409)
  await assert.rejects(
    async () => {
      await confirmCopyTrade(userId, TRADER_ADDR, copyTradeId2, txHash, mockPrisma as any);
    },
    (err: any) => {
      assert.equal(err.code, 'COPY_TRADE_TX_ALREADY_USED');
      assert.equal(err.statusCode, 409);
      return true;
    },
  );
});
