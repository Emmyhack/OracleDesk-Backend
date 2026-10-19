import { Keypair, rpc } from '@stellar/stellar-sdk';
import { basicNodeSigner } from '@stellar/stellar-sdk/contract';
import type { ClientOptions } from '@stellar/stellar-sdk/contract';
import { Client as MarketCoreClient } from '../../generated/market-core';
import { Client as TreasuryClient } from '../../generated/treasury';
import { Client as ResolverClient } from '../../generated/resolver';
import { Client as ReasoningRegistryClient } from '../../generated/reasoning-registry';
import { config } from '../../config';
import { CONTRACTS, DEPLOYED_AGENT } from '../../config/contracts';

export { MarketCoreClient, TreasuryClient, ResolverClient, ReasoningRegistryClient };

export const rpcServer = new rpc.Server(config.STELLAR_RPC_URL, {
  allowHttp: config.STELLAR_RPC_URL.startsWith('http://'),
});

type Signer = Pick<ClientOptions, 'publicKey' | 'signTransaction' | 'signAuthEntry'>;

export function baseOptions(contractId: string, signer: Signer = {}): ClientOptions {
  return {
    contractId,
    rpcUrl: config.STELLAR_RPC_URL,
    networkPassphrase: config.STELLAR_NETWORK_PASSPHRASE,
    allowHttp: config.STELLAR_RPC_URL.startsWith('http://'),
    ...({ timeoutInSeconds: Math.ceil(config.TIMEOUT_RPC_WRITE_MS / 1000) } as object),
    ...signer,
  };
}

/** Read-only clients: simulation only, no source account needed. */
export const readClients = {
  marketCore: () => new MarketCoreClient(baseOptions(CONTRACTS.marketCore)),
  treasury: () => new TreasuryClient(baseOptions(CONTRACTS.treasury)),
  resolver: () => new ResolverClient(baseOptions(CONTRACTS.resolver)),
  reasoningRegistry: () => new ReasoningRegistryClient(baseOptions(CONTRACTS.reasoningRegistry)),
};

/**
 * The agent identity used for writes.
 *
 * live: the key in AGENT_SECRET_KEY signs.
 * dry-run: transactions are simulated with the agent's public key as the
 * source (from AGENT_SECRET_KEY if set, otherwise the agent recorded in the
 * deployments file) and no signer is attached, so nothing can be signed.
 */
export function agentSigner(): Signer {
  if (config.CHAIN_EXECUTION_MODE === 'live') {
    const keypair = Keypair.fromSecret(config.AGENT_SECRET_KEY);
    const { signTransaction, signAuthEntry } = basicNodeSigner(keypair, config.STELLAR_NETWORK_PASSPHRASE);
    return { publicKey: keypair.publicKey(), signTransaction, signAuthEntry };
  }
  const publicKey = config.AGENT_SECRET_KEY
    ? Keypair.fromSecret(config.AGENT_SECRET_KEY).publicKey()
    : DEPLOYED_AGENT;
  return { publicKey };
}

export const agentClients = {
  // The agent is only the fee source for the resolver: both calls are
  // permissionless (#90).
  resolver: (signer: Signer = agentSigner()) => new ResolverClient(baseOptions(CONTRACTS.resolver, signer)),
  treasury: (signer: Signer = agentSigner()) => new TreasuryClient(baseOptions(CONTRACTS.treasury, signer)),
  reasoningRegistry: (signer: Signer = agentSigner()) =>
    new ReasoningRegistryClient(baseOptions(CONTRACTS.reasoningRegistry, signer)),
};
