import axios from 'axios';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { secret } from '../config/secrets';
import { logger } from '../lib/logger';
import { AppError } from '../middlewares/error.middleware';
import { assertPlainJson, canonicalBytes, NonPlainJsonError, sha256Hex } from '../utils/hash.util';
import { getContentStore } from './content-store.service';
import { bulkheads, deadline, sleep, TimeoutError } from '../lib/resilience';

const PINATA_BASE = 'https://api.pinata.cloud';

/** RFC 4648 base32 (lowercase, no padding) used by CIDv1 multibase 'b'. */
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

/**
 * CIDv1(raw, sha2-256). This is the real value Pinata returns for a file
 * pinned with `cidVersion: 1`; no dependency needed.
 */
export function cidForBytes(bytes: Buffer): string {
  const digest = crypto.createHash('sha256').update(bytes).digest();
  const multihash = Buffer.concat([Buffer.from([0x12, 0x20]), digest]);
  const cidBytes = Buffer.concat([Buffer.from([0x01, 0x55]), multihash]);
  return `b${base32Encode(cidBytes)}`;
}

/**
 * Where JSON documents are pinned. The default talks to Pinata; tests inject
 * an in-memory implementation with `setIpfsTransport`.
 */
export interface IpfsTransport {
  /** Pins `bytes` exactly as given and returns the CID. */
  pin(bytes: Buffer, name: string, signal?: AbortSignal): Promise<string>;
  /** Returns the exact bytes stored under `cid`. */
  fetch(cid: string, signal?: AbortSignal): Promise<Buffer>;
}

export const pinataTransport: IpfsTransport = {
  async pin(bytes, name, signal) {
    const apiKey = secret('PINATA_API_KEY');
    const secretKey = secret('PINATA_SECRET_API_KEY');
    if (!apiKey || !secretKey) {
      throw new AppError(503, 'IPFS_NOT_CONFIGURED', 'PINATA_API_KEY and PINATA_SECRET_API_KEY are not set');
    }
    // pinFileToIPFS stores the file's bytes verbatim. pinJSONToIPFS would
    // re-serialise the object, so its bytes could differ from what we hashed.
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)], { type: 'application/json' }), `${name}.json`);
    form.append('pinataMetadata', JSON.stringify({ name }));
    form.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));
    const { data } = await axios.post<{ IpfsHash: string }>(`${PINATA_BASE}/pinning/pinFileToIPFS`, form, {
      headers: {
        pinata_api_key: apiKey,
        pinata_secret_api_key: secretKey,
      },
      timeout: config.TIMEOUT_IPFS_PIN_MS,
      signal,
    });
    return data.IpfsHash;
  },

  async fetch(cid, signal) {
    const gateways = [config.IPFS_GATEWAY_URL, 'https://ipfs.io/ipfs'];
    const handle = deadline('ipfs-fetch', signal);

    try {
      for (const gateway of gateways) {
        if (handle.signal.aborted) break;
        const url = `${gateway.replace(/\/$/, '')}/${encodeURIComponent(cid)}`;
        const perGatewayBudget = Math.max(1000, Math.floor(handle.remaining() / gateways.length));
        const gwHandle = deadline('ipfs-fetch', handle.signal, perGatewayBudget);

        try {
          // arraybuffer: we need the bytes, not a parsed-and-reserialised object.
          const { data } = await axios.get<ArrayBuffer>(url, {
            responseType: 'arraybuffer',
            timeout: perGatewayBudget,
            signal: gwHandle.signal,
            maxContentLength: config.IPFS_MAX_BYTES,
            maxBodyLength: config.IPFS_MAX_BYTES,
          });
          return Buffer.from(data);
        } catch {
          logger.warn({ url }, 'IPFS gateway failed, trying next');
        } finally {
          gwHandle.cleanup?.();
        }
      }
    } finally {
      handle.cleanup?.();
    }

    throw new AppError(502, 'IPFS_RETRIEVAL_FAILED', 'Could not retrieve content from any IPFS gateway', { cid });
  },
};

/** Development-only transport: stores bytes on disk under `<dir>/<cid>`. */
export function localIpfsTransport(dir: string): IpfsTransport {
  return {
    async pin(bytes) {
      const cid = cidForBytes(bytes);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, cid), bytes);
      return cid;
    },
    async fetch(cid) {
      try {
        return fs.readFileSync(path.join(dir, cid));
      } catch {
        throw new AppError(404, 'IPFS_NOT_FOUND', 'Content is not in the local IPFS store', { cid });
      }
    },
  };
}

let transport: IpfsTransport =
  config.IPFS_TRANSPORT === 'local' ? localIpfsTransport(config.IPFS_LOCAL_DIR) : pinataTransport;

/** Test seam. Returns the previous transport. */
export function setIpfsTransport(next: IpfsTransport): IpfsTransport {
  const prev = transport;
  transport = next;
  return prev;
}

export interface PinnedDocument {
  cid: string;
  /** sha256 hex of the exact bytes pinned. */
  hash: string;
  bytes: Buffer;
}

/** Canonicalises `document`, pins those bytes and returns their hash. Retries once. */
export async function pinJson(
  document: unknown,
  name: string,
  opts?: { signal?: AbortSignal },
): Promise<PinnedDocument> {
  try {
    assertPlainJson(document);
  } catch (err) {
    if (err instanceof NonPlainJsonError) {
      throw new AppError(422, 'IPFS_NON_PLAIN_DOCUMENT', err.message, { name, path: err.path });
    }
    throw err;
  }
  const bytes = canonicalBytes(document);
  const hash = sha256Hex(bytes);
  let lastError: unknown;

  const handle = deadline('ipfs-pin', opts?.signal);

  try {
    return await bulkheads['ipfs-pin'].run(async () => {
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (handle.signal.aborted) {
          throw handle.signal.reason;
        }

        try {
          const cid = await transport.pin(bytes, name, handle.signal);
          // Write-through: the pin succeeded, so a cache failure must not fail
          // the caller (the CID/hash are still returned and persisted).
          await getContentStore()
            .put({ cid, sha256: hash, bytes, origin: 'PINNED', verifiedBy: 'pin' })
            .catch((err: unknown) => {
              logger.warn({ err, cid, name }, 'IPFS content store write failed; continuing');
            });
          logger.info({ name, cid, hash }, 'Pinned to IPFS');
          return { cid, hash, bytes };
        } catch (err) {
          lastError = err;
          if (opts?.signal?.aborted || handle.signal.aborted) {
            throw (opts?.signal?.reason ?? handle.signal.reason);
          }
          if (err instanceof AppError && err.code === 'IPFS_NOT_CONFIGURED') break;
          if (attempt === 1) {
            logger.warn({ name }, 'IPFS pin failed, retrying in 3s');
            await sleep(3000, handle.signal);
          }
        }
      }

      if (lastError instanceof AppError) throw lastError;
      logger.error({ err: lastError, name }, 'IPFS pin failed after retry');
      throw new AppError(502, 'IPFS_UPLOAD_FAILED', 'Failed to pin document to IPFS', { name });
    }, opts?.signal);
  } finally {
    handle.cleanup?.();
  }
}

export function fetchIpfsBytes(cid: string, signal?: AbortSignal): Promise<Buffer> {
  return bulkheads['ipfs-fetch'].run(async () => {
    try {
      return await transport.fetch(cid, signal);
    } catch (err) {
      if (err instanceof AppError && err.code === 'IPFS_RETRIEVAL_FAILED') {
        throw err;
      }
      if (err instanceof TimeoutError || (err as any)?.code === 'UPSTREAM_TIMEOUT') {
        throw new AppError(502, 'IPFS_RETRIEVAL_FAILED', 'Could not retrieve content from any IPFS gateway', { cid });
      }
      throw err;
    }
  }, signal);
}

/**
 * Returns bytes for `cid` only if they match `expectedSha256` (the on-chain
 * hash or the hash computed at pin time). Cache hits are re-hashed on read;
 * a cached row with a different hash is ignored and never served. Gateway
 * bytes are stored only after they verify. Bytes that fail verification are
 * still returned (so callers can report `verified: false`) but never cached.
 */
export async function fetchVerifiedBytes(
  cid: string,
  expectedSha256: string,
  verifiedBy: string,
): Promise<{ bytes: Buffer; source: 'cache' | 'gateway' }> {
  const expected = expectedSha256.toLowerCase().replace(/^0x/, '');
  const store = getContentStore();

  const cached = await store.get(cid);
  if (cached) {
    const storedHash = cached.sha256.toLowerCase().replace(/^0x/, '');
    if (storedHash === expected && sha256Hex(cached.bytes) === expected) {
      await store.touch(cid).catch(() => undefined);
      return { bytes: cached.bytes, source: 'cache' };
    }
    logger.warn(
      { cid, expected, stored: cached.sha256 },
      'Cached IPFS content hash does not match expected hash; consulting gateway',
    );
  }

  const bytes = await transport.fetch(cid);
  const matches = sha256Hex(bytes) === expected;
  if (matches && bytes.length <= config.IPFS_CACHE_MAX_OBJECT_BYTES) {
    await store
      .put({ cid, sha256: expected, bytes, origin: 'GATEWAY_VERIFIED', verifiedBy })
      .catch((err) => logger.warn({ err, cid }, 'Failed to cache verified gateway bytes'));
  } else if (!matches) {
    logger.warn({ cid, expected, computed: sha256Hex(bytes) }, 'Gateway bytes failed hash verification; not cached');
  }
  return { bytes, source: 'gateway' };
}
