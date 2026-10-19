import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTestEnv } from './helpers/env';

setupTestEnv();

import { xdr } from '@stellar/stellar-sdk';

const ROOT = join(__dirname, '..', '..');

type SpecCompat = typeof import('../src/services/stellar/spec-compat');

async function load(): Promise<SpecCompat> {
  return import('../src/services/stellar/spec-compat');
}

async function bindingEntries(contract: 'marketCore' | 'treasury' | 'resolver' | 'reasoningRegistry') {
  const { readClients } = await import('../src/services/stellar/clients');
  return readClients[contract]().spec.entries;
}

const clone = (entries: xdr.ScSpecEntry[]) => entries.map((e) => xdr.ScSpecEntry.fromXDR(e.toXDR()));

function findFn(entries: xdr.ScSpecEntry[], name: string): xdr.ScSpecFunctionV0 {
  const entry = entries.find(
    (e) => e.switch().name === 'scSpecEntryFunctionV0' && e.functionV0().name().toString() === name,
  );
  assert.ok(entry, `function ${name} not found in binding spec`);
  return entry!.functionV0();
}

function findUnion(entries: xdr.ScSpecEntry[], name: string): xdr.ScSpecUdtUnionV0 {
  const entry = entries.find(
    (e) => e.switch().name === 'scSpecEntryUdtUnionV0' && e.udtUnionV0().name().toString() === name,
  );
  assert.ok(entry, `union ${name} not found in binding spec`);
  return entry!.udtUnionV0();
}

function findEvent(entries: xdr.ScSpecEntry[], name: string): xdr.ScSpecEventV0 {
  const entry = entries.find(
    (e) => e.switch().name === 'scSpecEntryEventV0' && e.eventV0().name().toString() === name,
  );
  assert.ok(entry, `event ${name} not found in binding spec`);
  return entry!.eventV0();
}

// ─── Wasm custom section reader ──────────────────────────────────────────────

test('specEntriesFromWasm extracts contractspecv0 from a minimal hand-built wasm', async () => {
  const { specEntriesFromWasm } = await load();
  const entries = await bindingEntries('marketCore');
  const payload = Buffer.concat(entries.map((e) => e.toXDR()));

  const leb = (n: number) => {
    const out: number[] = [];
    do {
      let b = n & 0x7f;
      n >>= 7;
      if (n) b |= 0x80;
      out.push(b);
    } while (n);
    return Buffer.from(out);
  };
  const custom = (name: string, body: Buffer) => {
    const nameBuf = Buffer.from(name);
    const content = Buffer.concat([leb(nameBuf.length), nameBuf, body]);
    return Buffer.concat([Buffer.from([0]), leb(content.length), content]);
  };
  const wasm = Buffer.concat([
    Buffer.from([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]), // \0asm, version 1
    custom('other', Buffer.from([1, 2, 3])), // an unrelated custom section is skipped
    custom('contractspecv0', payload),
  ]);

  const parsed = specEntriesFromWasm(wasm);
  assert.equal(parsed.length, entries.length);
  assert.deepEqual(
    parsed.map((e) => e.toXDR('base64')).sort(),
    entries.map((e) => e.toXDR('base64')).sort(),
  );
});

// ─── Diff classification ─────────────────────────────────────────────────────

test('identical specs produce no diffs', async () => {
  const { diffSpecs, USAGE } = await load();
  for (const contract of ['marketCore', 'treasury', 'resolver', 'reasoningRegistry'] as const) {
    const entries = await bindingEntries(contract);
    assert.deepEqual(diffSpecs(contract, entries, clone(entries), USAGE[contract]), []);
  }
});

test('a doc-only change is compatible (no diff at all)', async () => {
  const { diffSpecs, USAGE } = await load();
  const binding = await bindingEntries('marketCore');
  const deployed = clone(binding);
  findFn(deployed, 'get_price').doc('completely different documentation');
  findUnion(deployed, 'Category').doc('docs changed here too');
  assert.deepEqual(diffSpecs('marketCore', binding, deployed, USAGE.marketCore), []);
});

test('a changed agent_buy argument type is breaking', async () => {
  const { diffSpecs, USAGE } = await load();
  const binding = await bindingEntries('treasury');
  const deployed = clone(binding);
  const input = findFn(deployed, 'agent_buy')
    .inputs()
    .find((i) => i.name().toString() === 'min_shares_out');
  assert.ok(input);
  input!.type(xdr.ScSpecTypeDef.scSpecTypeU128());

  const diffs = diffSpecs('treasury', binding, deployed, USAGE.treasury);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].item, 'fn agent_buy');
  assert.equal(diffs[0].change, 'arg min_shares_out type i128 → u128');
  assert.equal(diffs[0].severity, 'breaking');
});

test('a removed unused function (sweep_fees) is compatible', async () => {
  const { diffSpecs, USAGE } = await load();
  const binding = await bindingEntries('marketCore');
  assert.ok(!USAGE.marketCore.functions.includes('sweep_fees'));
  const deployed = clone(binding).filter(
    (e) => !(e.switch().name === 'scSpecEntryFunctionV0' && e.functionV0().name().toString() === 'sweep_fees'),
  );
  const diffs = diffSpecs('marketCore', binding, deployed, USAGE.marketCore);
  assert.equal(diffs.length, 1);
  assert.deepEqual(diffs[0], {
    contract: 'marketCore',
    item: 'fn sweep_fees',
    change: 'removed',
    severity: 'compatible',
  });
});

test('a removed used function (get_market) is breaking', async () => {
  const { diffSpecs, USAGE } = await load();
  const binding = await bindingEntries('marketCore');
  const deployed = clone(binding).filter(
    (e) => !(e.switch().name === 'scSpecEntryFunctionV0' && e.functionV0().name().toString() === 'get_market'),
  );
  const diffs = diffSpecs('marketCore', binding, deployed, USAGE.marketCore);
  assert.deepEqual(diffs, [
    { contract: 'marketCore', item: 'fn get_market', change: 'removed', severity: 'breaking' },
  ]);
});

const appendVoidCase = (union: xdr.ScSpecUdtUnionV0, name: string) =>
  union.cases([
    ...union.cases(),
    xdr.ScSpecUdtUnionCaseV0.scSpecUdtUnionCaseVoidV0(new xdr.ScSpecUdtUnionCaseVoidV0({ doc: '', name })),
  ]);

test('an appended Category variant is breaking: the backend writes Category', async () => {
  // Category reaches the chain through agent_create_market's inputs
  // (toContractCategoryValue), so the binding must know every case.
  const { diffSpecs, USAGE } = await load();
  const binding = await bindingEntries('treasury');
  const deployed = clone(binding);
  appendVoidCase(findUnion(deployed, 'Category'), 'Science');

  const diffs = diffSpecs('treasury', binding, deployed, USAGE.treasury);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].item, 'union Category');
  assert.equal(diffs[0].change, 'case Science appended');
  assert.equal(diffs[0].severity, 'breaking');
});

test('an appended MarketStatus variant is compatible: the backend only reads it', async () => {
  const { diffSpecs, USAGE } = await load();
  const binding = await bindingEntries('marketCore');
  const deployed = clone(binding);
  appendVoidCase(findUnion(deployed, 'MarketStatus'), 'Paused');

  const diffs = diffSpecs('marketCore', binding, deployed, USAGE.marketCore);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].item, 'union MarketStatus');
  assert.equal(diffs[0].change, 'case Paused appended');
  assert.equal(diffs[0].severity, 'compatible');
});

test('a reordered MarketStatus (not appended) is breaking for a read type', async () => {
  const { diffSpecs, USAGE } = await load();
  const binding = await bindingEntries('marketCore');
  const deployed = clone(binding);
  const union = findUnion(deployed, 'MarketStatus');
  union.cases([...union.cases()].reverse());
  const diffs = diffSpecs('marketCore', binding, deployed, USAGE.marketCore);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].severity, 'breaking');
});

test('a changed Trade event data field is breaking', async () => {
  const { diffSpecs, USAGE } = await load();
  const binding = await bindingEntries('marketCore');
  const deployed = clone(binding);
  const param = findEvent(deployed, 'Trade')
    .params()
    .find((p) => p.location().name === 'scSpecEventParamLocationData');
  assert.ok(param, 'Trade has no data-located param');
  param!.type(xdr.ScSpecTypeDef.scSpecTypeU32());

  const diffs = diffSpecs('marketCore', binding, deployed, USAGE.marketCore);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].item, 'event Trade');
  assert.equal(diffs[0].severity, 'breaking');
});

test('a changed unprojected event (Redeemed) is compatible', async () => {
  const { diffSpecs, USAGE } = await load();
  const binding = await bindingEntries('marketCore');
  const deployed = clone(binding).filter(
    (e) => !(e.switch().name === 'scSpecEntryEventV0' && e.eventV0().name().toString() === 'Redeemed'),
  );
  const diffs = diffSpecs('marketCore', binding, deployed, USAGE.marketCore);
  assert.deepEqual(diffs, [
    { contract: 'marketCore', item: 'event Redeemed', change: 'removed', severity: 'compatible' },
  ]);
});

test('a reassigned error code for an existing name is breaking; new codes are compatible', async () => {
  const { diffSpecs, USAGE } = await load();
  const binding = await bindingEntries('marketCore');
  const deployed = clone(binding);
  const errEntry = deployed.find((e) => e.switch().name === 'scSpecEntryUdtErrorEnumV0');
  assert.ok(errEntry);
  const cases = errEntry!.udtErrorEnumV0().cases();
  // Swap the codes of the first two errors: both names now mean something else.
  const [a, b] = [cases[0].value(), cases[1].value()];
  cases[0].value(b);
  cases[1].value(a);

  const diffs = diffSpecs('marketCore', binding, deployed, USAGE.marketCore);
  assert.equal(diffs.length, 2);
  for (const d of diffs) {
    assert.equal(d.item, 'errors Error');
    assert.equal(d.severity, 'breaking');
  }
});

test('an added error code is compatible', async () => {
  const { diffSpecs, USAGE } = await load();
  const binding = await bindingEntries('marketCore');
  const deployed = clone(binding);
  const errEnum = deployed.find((e) => e.switch().name === 'scSpecEntryUdtErrorEnumV0')!.udtErrorEnumV0();
  errEnum.cases([
    ...errEnum.cases(),
    new xdr.ScSpecUdtErrorEnumCaseV0({ doc: '', name: 'BrandNewError', value: 999 }),
  ]);
  const diffs = diffSpecs('marketCore', binding, deployed, USAGE.marketCore);
  assert.deepEqual(diffs, [
    { contract: 'marketCore', item: 'errors Error', change: 'code BrandNewError=999 added', severity: 'compatible' },
  ]);
});

// ─── Gate ────────────────────────────────────────────────────────────────────

type Fetch = SpecCompat['fetchDeployed'];

async function matchingFetch(): Promise<Fetch> {
  const specs = {
    marketCore: await bindingEntries('marketCore'),
    treasury: await bindingEntries('treasury'),
    resolver: await bindingEntries('resolver'),
    reasoningRegistry: await bindingEntries('reasoningRegistry'),
  } as Record<string, xdr.ScSpecEntry[]>;
  return async (contract: string, contractId: string) => {
    if (contract === 'usdc') {
      return { contract, contractId, wasmHash: null, kind: 'stellar-asset' as const, spec: null };
    }
    return { contract, contractId, wasmHash: 'ab'.repeat(32), kind: 'wasm' as const, spec: specs[contract] };
  };
}

test('checkSpecCompat: matching contracts and a stellar-asset usdc pass the gate', async () => {
  const { checkSpecCompat, gateDecision, specCompatReport } = await load();
  const report = await checkSpecCompat({ fetch: await matchingFetch() });
  assert.equal(report.ok, true);
  assert.deepEqual(report.breaking, []);
  const usdc = report.contracts.find((c) => c.contract === 'usdc')!;
  assert.equal(usdc.kind, 'stellar-asset');
  assert.equal(usdc.verified, true);
  assert.equal(gateDecision(report, 'enforce'), 'ok');
  assert.equal(specCompatReport(), report);
});

test('checkSpecCompat: a wasm usdc executable is breaking', async () => {
  const { checkSpecCompat } = await load();
  const base = await matchingFetch();
  const report = await checkSpecCompat({
    fetch: async (contract, id) =>
      contract === 'usdc'
        ? { contract, contractId: id, wasmHash: 'cd'.repeat(32), kind: 'wasm' as const, spec: null }
        : base(contract, id),
  });
  assert.equal(report.ok, false);
  assert.ok(report.breaking.some((d) => d.contract === 'usdc'));
});

test('an archived code entry cannot be verified: refused in enforce, warned in warn', async () => {
  const { checkSpecCompat, gateDecision } = await load();
  const base = await matchingFetch();
  const report = await checkSpecCompat({
    fetch: async (contract, id) =>
      contract === 'marketCore'
        ? { contract, contractId: id, wasmHash: 'ab'.repeat(32), kind: 'wasm' as const, spec: null, reason: 'code archived' }
        : base(contract, id),
  });
  assert.equal(report.ok, false);
  const diff = report.breaking.find((d) => d.contract === 'marketCore');
  assert.ok(diff && /code archived/.test(diff.change));
  // Live mode (enforce) refuses to start; dry-run (warn) logs and continues.
  assert.equal(gateDecision(report, 'enforce'), 'refuse');
  assert.equal(gateDecision(report, 'warn'), 'warn');
});

test('a breaking event diff disables that projection for the indexer', async () => {
  const { checkSpecCompat, disabledEventProjections } = await load();
  const base = await matchingFetch();
  const mutated = clone(await bindingEntries('marketCore'));
  const param = findEvent(mutated, 'Trade')
    .params()
    .find((p) => p.location().name === 'scSpecEventParamLocationData')!;
  param.type(xdr.ScSpecTypeDef.scSpecTypeU32());

  const report = await checkSpecCompat({
    fetch: async (contract, id) =>
      contract === 'marketCore'
        ? { contract, contractId: id, wasmHash: 'ab'.repeat(32), kind: 'wasm' as const, spec: mutated }
        : base(contract, id),
  });
  assert.equal(report.ok, false);
  assert.ok(disabledEventProjections().has('marketCore:Trade'));
  assert.ok(!disabledEventProjections().has('reasoningRegistry:TracePublished'));

  // Reset module state for other consumers of the last report.
  await checkSpecCompat({ fetch: base });
  assert.equal(disabledEventProjections().size, 0);
});

test('an RPC failure never fails open: the contract is reported as unverifiable', async () => {
  const { checkSpecCompat } = await load();
  const base = await matchingFetch();
  const report = await checkSpecCompat({
    fetch: async (contract, id) => {
      if (contract === 'resolver') throw new Error('rpc unreachable');
      return base(contract, id);
    },
  });
  assert.equal(report.ok, false);
  const row = report.contracts.find((c) => c.contract === 'resolver')!;
  assert.equal(row.verified, false);
  assert.ok(report.breaking.some((d) => d.contract === 'resolver' && /cannot verify/.test(d.change)));
});

// ─── Usage table stays in sync with the services ────────────────────────────

test('USAGE matches every readClients/agentClients call in src/services', async () => {
  const { USAGE } = await load();
  const { readdirSync, statSync } = await import('node:fs');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) files.push(p);
    }
  };
  walk(join(ROOT, 'src'));

  const found = new Map<string, Set<string>>();
  const pattern = /(?:readClients|agentClients)\.(\w+)\([^)]*\)\)?\.(\w+)\(/g;
  for (const file of files) {
    if (file.includes(`${join('src', 'generated')}`)) continue;
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(pattern)) {
      const [, contract, fn] = m;
      if (fn === 'spec') continue; // .spec property access, not an entrypoint
      if (!found.has(contract)) found.set(contract, new Set());
      found.get(contract)!.add(fn);
    }
  }

  for (const [contract, usage] of Object.entries(USAGE)) {
    const actual = [...(found.get(contract) ?? [])].sort();
    const table = [...usage.functions].sort();
    assert.deepEqual(table, actual, `USAGE.${contract}.functions is out of date: code uses [${actual}]`);
  }
  for (const contract of found.keys()) {
    assert.ok(contract in USAGE, `USAGE has no entry for ${contract}`);
  }
});

test('USAGE events match the projections in indexer.service.ts', async () => {
  const { USAGE } = await load();
  const text = readFileSync(join(ROOT, 'src', 'services', 'indexer.service.ts'), 'utf8');
  const found = new Map<string, Set<string>>();
  const pattern = /contractName === '(\w+)' && event\.eventName === '(\w+)'/g;
  for (const m of text.matchAll(pattern)) {
    const [, contract, eventName] = m;
    if (!found.has(contract)) found.set(contract, new Set());
    found.get(contract)!.add(eventName);
  }
  for (const [contract, usage] of Object.entries(USAGE)) {
    const actual = [...(found.get(contract) ?? [])].sort();
    assert.deepEqual([...usage.events].sort(), actual, `USAGE.${contract}.events is out of date: indexer projects [${actual}]`);
  }
});

// ─── Manifest ────────────────────────────────────────────────────────────────

test('sync-contracts --check fails when contracts-manifest.json is stale', (t) => {
  const submodule = join(ROOT, 'contracts', 'oracledesk-stellar');
  if (!existsSync(submodule)) {
    t.skip('contracts submodule not initialised');
    return;
  }
  const script = join(ROOT, 'scripts', 'sync-contracts.mjs');
  const manifestPath = join(ROOT, 'src', 'generated', 'contracts-manifest.json');
  const original = readFileSync(manifestPath, 'utf8');

  // A fresh tree passes --check with no network access.
  execFileSync(process.execPath, [script, '--check'], { cwd: ROOT });

  try {
    const mangled = JSON.parse(original);
    mangled.contracts.marketCore.specSha256 = '0'.repeat(64);
    writeFileSync(manifestPath, JSON.stringify(mangled, null, 2) + '\n');
    assert.throws(
      () => execFileSync(process.execPath, [script, '--check'], { cwd: ROOT }),
      (err: any) => err.status === 1,
    );
  } finally {
    writeFileSync(manifestPath, original);
  }
  execFileSync(process.execPath, [script, '--check'], { cwd: ROOT });
});

test('the manifest pins the bindings the backend was built against', async () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'src', 'generated', 'contracts-manifest.json'), 'utf8'));
  for (const contract of ['marketCore', 'treasury', 'resolver', 'reasoningRegistry']) {
    const pinned = manifest.contracts[contract];
    assert.ok(pinned, `manifest has no entry for ${contract}`);
    assert.match(pinned.specSha256, /^[0-9a-f]{64}$/);
    assert.ok(Array.isArray(pinned.entries) && pinned.entries.length > 0);
    // Spec hash must match what the binding actually embeds.
    const entries = await bindingEntries(contract as any);
    const { createHash } = await import('node:crypto');
    const expected = createHash('sha256')
      .update(entries.map((e) => e.toXDR('base64')).sort().join(''))
      .digest('hex');
    assert.equal(pinned.specSha256, expected, `${contract} manifest specSha256 does not match the binding`);
  }
});
