import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { setupTestEnv } from './helpers/env';

setupTestEnv();

// Every committed cassette (tests/cassettes/**) is scanned on every `npm test`
// with the same guard that refuses to write one (#72).
test('committed cassettes contain no secrets and only normalised requests', async () => {
  const { CASSETTE_DIR, fingerprint, listCassetteFiles, scanForSecrets } = await import('./helpers/cassettes');
  const files = listCassetteFiles();
  assert.ok(files.length > 0, `no cassettes found under ${CASSETTE_DIR}`);
  for (const file of files) {
    const name = relative(CASSETTE_DIR, file);
    const text = readFileSync(file, 'utf8');
    assert.deepEqual(scanForSecrets(text), [], `${name} contains a secret`);
    const cassette = JSON.parse(text);
    assert.equal(cassette.version, 1, `${name}: version`);
    for (const [i, x] of cassette.interactions.entries()) {
      // The stored request is already normalised, so it re-fingerprints to itself.
      assert.equal(fingerprint(x.kind, x.request), x.fingerprint, `${name} #${i}: fingerprint does not match its request`);
      if (x.kind === 'http' && String(x.request.url).includes('newsapi.org')) {
        const articles = x.response?.articles ?? [];
        assert.ok(articles.length <= 6, `${name} #${i}: more than 6 NewsAPI articles`);
        for (const a of articles) {
          assert.ok(!('content' in a), `${name} #${i}: article body recorded`);
          assert.ok((a.title ?? '').length <= 180 && (a.description ?? '').length <= 180, `${name} #${i}: article text not trimmed`);
        }
      }
    }
  }
});
