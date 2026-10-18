/**
 * Recorded model outputs for deterministic replay (#67).
 *
 *   tests/eval/recordings/<model>/<caseId>.json         proposal generation
 *   tests/eval/recordings/<model>/<caseId>.judge.json   judge verdict
 *
 * Each file stores the raw output keyed by sha256(system + user) of the prompt
 * that produced it. A prompt change changes the key, so replay fails loudly
 * ("recording missing") instead of silently grading stale output.
 */
import fs from 'node:fs';
import path from 'node:path';
import { sha256Hex } from '../../src/utils/hash.util';

export interface Recording {
  caseId: string;
  kind: 'proposal' | 'judge';
  /** sha256(system + user) of the prompt that produced `output`. */
  promptKey: string;
  provider: string;
  model: string;
  output: string;
}

export const promptKey = (system: string, user: string) => sha256Hex(system + user);

export class RecordingMissingError extends Error {
  constructor(public readonly caseId: string, public readonly kind: string, reason: string) {
    super(`recording missing for ${caseId} (${kind}): ${reason}; re-run with --live --record`);
    this.name = 'RecordingMissingError';
  }
}

/** Refuses key-looking strings so a recording can never carry a credential. */
const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/,
  /AIza[0-9A-Za-z_-]{20,}/,
  /\bS[A-Z2-7]{55}\b/,
  /Bearer\s+[A-Za-z0-9._~+/-]{20,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:api[_-]?key|secret|token|password)\b["']?\s*[:=]\s*["']?[A-Za-z0-9._-]{12,}/i,
];

export function assertNoKeys(text: string): void {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) throw new Error('refusing to write a recording that contains a key-looking string');
  }
}

const file = (dir: string, model: string, caseId: string, kind: Recording['kind']) =>
  path.join(dir, model, `${caseId}${kind === 'judge' ? '.judge' : ''}.json`);

export function loadRecording(dir: string, model: string, caseId: string, kind: Recording['kind'], key: string): Recording {
  const p = file(dir, model, caseId, kind);
  if (!fs.existsSync(p)) throw new RecordingMissingError(caseId, kind, `no file ${path.relative(process.cwd(), p)}`);
  const rec = JSON.parse(fs.readFileSync(p, 'utf8')) as Recording;
  if (rec.promptKey !== key) throw new RecordingMissingError(caseId, kind, 'the prompt changed since it was recorded');
  return rec;
}

export function saveRecording(dir: string, model: string, rec: Recording): string {
  const text = `${JSON.stringify(rec, null, 2)}\n`;
  assertNoKeys(text);
  const p = file(dir, model, rec.caseId, rec.kind);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
}
