import { canonicalJson, sha256Hex } from '../../utils/hash.util';

/**
 * A versioned prompt (#66). `user` is the literal template text with
 * `{{name}}` placeholders; `render` fills them in. Because the hash covers the
 * template text and not a function body, it does not depend on
 * Function.prototype.toString().
 */
export interface PromptDef<V extends object = Record<string, never>> {
  readonly id: string;
  readonly version: number;
  readonly system: string;
  /** The user message template, with `{{name}}` placeholders. */
  readonly user: string;
  /** sha256(canonicalJson({ id, version, system, user })) */
  readonly contentHash: string;
  render(vars: V): { system: string; user: string };
}

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

export function definePrompt<V extends object = Record<string, never>>(def: {
  id: string;
  version: number;
  system: string;
  user: string;
}): PromptDef<V> {
  const { id, version, system, user } = def;
  const contentHash = sha256Hex(canonicalJson({ id, version, system, user }));
  return {
    id,
    version,
    system,
    user,
    contentHash,
    render(vars: V) {
      const values = vars as Record<string, unknown>;
      return {
        system,
        // One pass, so a value containing "{{x}}" is never re-expanded.
        user: user.replace(PLACEHOLDER, (_m, key: string) => {
          if (!(key in values)) throw new Error(`Prompt ${id}@${version}: missing variable "${key}"`);
          return String(values[key]);
        }),
      };
    },
  };
}
