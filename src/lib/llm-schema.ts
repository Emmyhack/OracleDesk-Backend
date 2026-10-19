/**
 * Single registry of the shapes we ask LLMs to produce (#65).
 *
 * Each shape is written once in zod. From it we derive:
 *   - `jsonSchema`   → Anthropic tool `input_schema` (forced tool use);
 *   - `geminiSchema` → Gemini `responseSchema` (an OpenAPI-subset dialect).
 *
 * Zod features that have no JSON Schema form (`.catch`, `.default`,
 * transforms) stay out of the *wire* schemas; the lenient domain schemas that
 * apply defaults live next to them. Rules JSON Schema cannot express portably
 * (the confidence interval must contain the probability, expiry must be in the
 * future) are `postValidate` functions whose message is fed back to the model
 * in the repair turn.
 */
import { nowMs } from './clock';
import { SchemaType } from '@google/generative-ai';
import { z } from 'zod';

export type JsonSchema = Record<string, any>;
export type GeminiSchema = Record<string, any>;

export interface StructuredSpec<T> {
  /** Tool name for Anthropic; also used in logs. */
  name: string;
  description: string;
  zod: z.ZodType<T>;
  jsonSchema: JsonSchema;
  geminiSchema: GeminiSchema;
  /** Cross-field rules. Returns an error message for the repair turn, or null. */
  postValidate?: (value: T) => string | null;
}

export function defineStructured<T>(
  name: string,
  description: string,
  schema: z.ZodType<T>,
  postValidate?: (value: T) => string | null,
): StructuredSpec<T> {
  // Throws on unrepresentable types (the default), so a `.catch`/transform
  // slipped into a wire schema fails at module load, not at the provider.
  const jsonSchema = z.toJSONSchema(schema, { target: 'draft-7', io: 'input' }) as JsonSchema;
  delete jsonSchema.$schema;
  return { name, description, zod: schema, jsonSchema, geminiSchema: toGeminiSchema(jsonSchema), postValidate };
}

const GEMINI_TYPES: Record<string, SchemaType> = {
  object: SchemaType.OBJECT,
  string: SchemaType.STRING,
  number: SchemaType.NUMBER,
  integer: SchemaType.INTEGER,
  boolean: SchemaType.BOOLEAN,
  array: SchemaType.ARRAY,
};

/**
 * Converts a draft-7 JSON Schema to Gemini's response-schema dialect.
 *
 * Kept: type (mapped to SchemaType), enum, required, properties, items,
 * description, minimum/maximum, minItems/maxItems, nullable. Added:
 * propertyOrdering. Dropped (Gemini answers 400 on them): additionalProperties,
 * $schema, minLength/maxLength, pattern, format, default, exclusive bounds.
 * `const` becomes a single-value enum. Everything dropped is still enforced by
 * zod after the call.
 */
export function toGeminiSchema(input: JsonSchema): GeminiSchema {
  let schema = input;

  // anyOf [X, null] → X with nullable.
  let nullable = false;
  if (Array.isArray(schema.anyOf)) {
    const nonNull = schema.anyOf.filter((s: JsonSchema) => s.type !== 'null');
    nullable = nonNull.length !== schema.anyOf.length;
    if (nonNull.length === 1) schema = { ...nonNull[0], description: schema.description ?? nonNull[0].description };
    else throw new Error('Gemini response schemas cannot express a union of several non-null types');
  }
  if (Array.isArray(schema.type)) {
    const types = schema.type.filter((t: string) => t !== 'null');
    nullable = nullable || types.length !== schema.type.length;
    if (types.length !== 1) throw new Error('Gemini response schemas cannot express multi-type unions');
    schema = { ...schema, type: types[0] };
  }

  const out: GeminiSchema = {};
  const type = GEMINI_TYPES[schema.type as string];
  if (!type) throw new Error(`Unsupported JSON Schema type for Gemini: ${String(schema.type)}`);
  out.type = type;
  if (schema.description) out.description = schema.description;
  if (nullable) out.nullable = true;

  if (schema.const !== undefined) {
    out.enum = [String(schema.const)];
    out.format = 'enum';
  } else if (Array.isArray(schema.enum)) {
    out.enum = schema.enum.map(String);
    out.format = 'enum';
  }

  if (type === SchemaType.NUMBER || type === SchemaType.INTEGER) {
    if (typeof schema.minimum === 'number') out.minimum = schema.minimum;
    if (typeof schema.maximum === 'number') out.maximum = schema.maximum;
  }

  if (type === SchemaType.ARRAY) {
    out.items = toGeminiSchema(schema.items ?? { type: 'string' });
    if (typeof schema.minItems === 'number') out.minItems = schema.minItems;
    if (typeof schema.maxItems === 'number') out.maxItems = schema.maxItems;
  }

  if (type === SchemaType.OBJECT) {
    const props: Record<string, JsonSchema> = schema.properties ?? {};
    out.properties = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, toGeminiSchema(v)]));
    out.propertyOrdering = Object.keys(props);
    if (Array.isArray(schema.required) && schema.required.length > 0) out.required = [...schema.required];
  }

  return out;
}

/** Formats zod issues for a repair turn. Never includes the model's raw output. */
export function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 12)
    .map((i) => `- ${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`)
    .join('\n');
}

// ─── Market proposal ──────────────────────────────────────────────────────────

export const MARKET_CATEGORIES = [
  'FED', 'ECB', 'ELECTION', 'GEOPOLITICAL', 'CRYPTO', 'MACRO', 'SPORTS', 'ENTERTAINMENT', 'POLITICS',
] as const;

/** What the model must produce. Strict: a bad currency is an error, not masked. */
export const marketProposalWireSchema = z.object({
  market_question: z.string().min(10),
  initial_yes_probability: z.number().min(0.01).max(0.99),
  resolution_oracle: z.string().min(1),
  expiry_timestamp: z.number().int().positive(),
  settlement_currency: z.literal('USDC'),
  minimum_liquidity_usdc: z.number().positive(),
  category: z.enum(MARKET_CATEGORIES),
  confidence_interval: z.object({ lower: z.number(), upper: z.number() }),
  reasoning: z.string().min(1),
  /** Ids of the untrusted signals the question is grounded in (#70). */
  grounding_signal_ids: z.array(z.string()).min(1).max(5),
  /**
   * Optional structured price fields (#90). Present only when the model chose a
   * Reflector-priced CRYPTO market; the backend renders the question from them
   * so text and the committed price spec cannot disagree.
   */
  price_asset: z.string().min(1).optional(),
  price_threshold: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  price_direction: z.enum(['Above', 'AtOrAbove', 'Below', 'AtOrBelow']).optional(),
  price_close_timestamp: z.number().int().positive().optional(),
});

/**
 * Domain parse, lenient where intended: the currency is always USDC and the
 * minimum liquidity defaults to 100 when an older producer omitted them.
 */
export const marketProposalSchema = marketProposalWireSchema.extend({
  settlement_currency: z.literal('USDC').catch('USDC'),
  minimum_liquidity_usdc: z.number().positive().default(100),
});

export type MarketProposalWire = z.infer<typeof marketProposalWireSchema>;

/** The probability must lie inside a non-empty confidence interval. */
export function confidenceIntervalError(
  p: Pick<MarketProposalWire, 'initial_yes_probability' | 'confidence_interval'>,
): string | null {
  const { initial_yes_probability: prob, confidence_interval: ci } = p;
  if (ci.lower >= ci.upper || prob < ci.lower || prob > ci.upper) {
    return `confidence_interval must satisfy lower < initial_yes_probability (${prob}) < upper, with lower < upper; got lower=${ci.lower}, upper=${ci.upper}.`;
  }
  return null;
}

/**
 * Cross-field rules JSON Schema cannot state. The 1–90 day window is a policy
 * check in the guard (it must reject, not repair); here the expiry only has to
 * be in the future.
 */
export function marketProposalPostValidate(p: MarketProposalWire, nowSeconds = Math.floor(nowMs() / 1000)): string | null {
  const ci = confidenceIntervalError(p);
  if (ci) return ci;
  if (p.expiry_timestamp <= nowSeconds) {
    return `expiry_timestamp must be a unix time in seconds in the future (now is ${nowSeconds}); got ${p.expiry_timestamp}.`;
  }
  return null;
}

export const marketProposalSpec = defineStructured(
  'submit_market_proposal',
  'Submit exactly one binary prediction market proposal derived from the provided signals.',
  marketProposalWireSchema,
  (p) => marketProposalPostValidate(p),
);

// ─── Trace reasoning ──────────────────────────────────────────────────────────

export const traceReasoningSchema = z.object({
  hedge_conditions: z.array(z.string()),
  reasoning_summary: z.string().min(10),
  key_signals: z.array(z.string()),
  risk_factors: z.array(z.string()),
});

export const traceReasoningSpec = defineStructured(
  'submit_trade_reasoning',
  'Submit hedge conditions and a reasoning summary for a trading position.',
  traceReasoningSchema,
);
