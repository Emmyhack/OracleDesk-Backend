#!/usr/bin/env ts-node
import { Keypair, Networks, Operation, TransactionBuilder, rpc, StrKey } from '@stellar/stellar-sdk';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config';

export function assertTestnet(networkPassphrase = config.STELLAR_NETWORK_PASSPHRASE): void {
  if (networkPassphrase !== Networks.TESTNET) {
    throw new Error(`Refusing to run channel script outside of Stellar testnet. Passphrase was: ${networkPassphrase}`);
  }
}

export interface CreateResult {
  publicKeys: string[];
  outputFile?: string;
}

export function createChannels(count: number, outputFile?: string, networkPassphrase = config.STELLAR_NETWORK_PASSPHRASE): CreateResult {
  assertTestnet(networkPassphrase);
  if (count <= 0) throw new Error('Count must be greater than 0');

  const keypairs: Keypair[] = [];
  for (let i = 0; i < count; i++) {
    keypairs.push(Keypair.random());
  }

  const publicKeys = keypairs.map((k) => k.publicKey());

  if (outputFile) {
    const resolved = path.resolve(outputFile);
    const content = keypairs.map((k) => k.secret()).join('\n') + '\n';
    fs.writeFileSync(resolved, content, { mode: 0o600, encoding: 'utf-8' });
  }

  return { publicKeys, outputFile };
}

export async function fundChannels(
  funderSecret: string,
  amountXlmPerAccount: string,
  targetPublicKeys: string[],
  server: runderServerType = new rpc.Server(config.STELLAR_RPC_URL) as any,
  networkPassphrase = config.STELLAR_NETWORK_PASSPHRASE,
): Promise<{ funded: string[]; txHash: string | null }> {
  assertTestnet(networkPassphrase);
  if (!StrKey.isValidEd25519SecretSeed(funderSecret)) {
    throw new Error('Invalid funder secret seed');
  }

  const funderKeypair = Keypair.fromSecret(funderSecret);
  const funderAccount = await (server as any).getAccount(funderKeypair.publicKey());
  if (!funderAccount) throw new Error('Funder account not found on network');

  // Batch create_account operations in groups of 50
  const batch = targetPublicKeys.slice(0, 50);
  const txBuilder = new TransactionBuilder(funderAccount as any, {
    fee: '1000000',
    networkPassphrase,
  });

  for (const pub of batch) {
    txBuilder.addOperation(
      Operation.createAccount({
        destination: pub,
        startingBalance: amountXlmPerAccount,
      }),
    );
  }

  txBuilder.setTimeout(30);
  const tx = txBuilder.build();
  tx.sign(funderKeypair);

  const res = await (server as any).sendTransaction(tx);
  const txHash = res?.sendTransactionResponse?.hash ?? res?.hash ?? null;

  return {
    funded: batch,
    txHash,
  };
}

export interface ChannelStatus {
  publicKey: string;
  balanceXlm: number;
  status: 'HEALTHY' | 'LOW_BALANCE' | 'UNINITIALIZED';
}

export async function getChannelsStatus(
  publicKeys: string[],
  server: runderServerType = new rpc.Server(config.STELLAR_RPC_URL) as any,
  minBalanceXlm = config.CHANNEL_MIN_BALANCE_XLM,
  networkPassphrase = config.STELLAR_NETWORK_PASSPHRASE,
): Promise<ChannelStatus[]> {
  assertTestnet(networkPassphrase);
  const results: ChannelStatus[] = [];

  for (const pub of publicKeys) {
    try {
      const acc = await (server as any).getAccount(pub);
      const native = acc?.balances?.find((b: any) => b.asset_type === 'native');
      const bal = native ? parseFloat(native.balance) : 0;
      results.push({
        publicKey: pub,
        balanceXlm: bal,
        status: bal >= minBalanceXlm ? 'HEALTHY' : 'LOW_BALANCE',
      });
    } catch {
      results.push({
        publicKey: pub,
        balanceXlm: 0,
        status: 'UNINITIALIZED',
      });
    }
  }

  return results;
}

export async function mergeChannels(
  channelSecrets: string[],
  destinationPublicKey: string,
  server: runderServerType = new rpc.Server(config.STELLAR_RPC_URL) as any,
  networkPassphrase = config.STELLAR_NETWORK_PASSPHRASE,
): Promise<{ merged: string[] }> {
  assertTestnet(networkPassphrase);
  if (!StrKey.isValidEd25519PublicKey(destinationPublicKey)) {
    throw new Error('Invalid destination public key');
  }

  const merged: string[] = [];
  for (const secret of channelSecrets) {
    if (!StrKey.isValidEd25519SecretSeed(secret)) continue;
    const kp = Keypair.fromSecret(secret);
    try {
      const acc = await (server as any).getAccount(kp.publicKey());
      const tx = new TransactionBuilder(acc as any, {
        fee: '100000',
        networkPassphrase,
      })
        .addOperation(Operation.accountMerge({ destination: destinationPublicKey }))
        .setTimeout(30)
        .build();
      tx.sign(kp);
      await (server as any).sendTransaction(tx);
      merged.push(kp.publicKey());
    } catch (err: any) {
      // Continue merging remaining
    }
  }

  return { merged };
}

type runderServerType = rpc.Server | { getAccount: (pub: string) => Promise<any>; sendTransaction: (tx: any) => Promise<any> };

// CLI runner
if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];

  try {
    assertTestnet();
    if (command === 'create') {
      const count = parseInt(args[1] || '1', 10);
      const outputFile = args[2];
      const result = createChannels(count, outputFile);
      console.log(`Generated ${result.publicKeys.length} channel accounts:`);
      result.publicKeys.forEach((k) => console.log(`  ${k}`));
      if (result.outputFile) {
        console.log(`Secrets written to ${result.outputFile} with mode 0600.`);
      }
    } else if (command === 'status') {
      const pool = config.CHANNEL_SECRET_KEYS
        ? config.CHANNEL_SECRET_KEYS.split(',').map((s) => Keypair.fromSecret(s.trim()).publicKey())
        : [];
      getChannelsStatus(pool).then((statuses) => {
        console.table(statuses);
      });
    } else {
      console.log('Usage: ts-node scripts/channels.ts <create|status|fund|merge> [options]');
    }
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
