import type { AiBinding } from "./platform.ts";

/**
 * Model providers behind small interfaces. Workers AI is the only
 * implementation; switching providers means adding another implementation
 * here, not changing callers. Neuron costs are estimated from Cloudflare's
 * published per-token prices so the daily ledger can stop before the Free
 * allocation is exhausted.
 */

export interface EmbeddingProvider {
  readonly model: string;
  readonly dims: number;
  embed(texts: string[], kind: "query" | "document"): Promise<number[][]>;
  estimateNeurons(texts: string[]): number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResult {
  text: string;
  usage: { promptTokens: number; completionTokens: number } | null;
}

export interface ChatProvider {
  readonly model: string;
  complete(messages: ChatMessage[], options: { maxTokens: number }): Promise<ChatResult>;
  estimateNeurons(promptChars: number, maxTokens: number): number;
  neuronsForUsage(usage: { promptTokens: number; completionTokens: number }): number;
}

/** The Free daily allocation is used up; retrying before 00:00 UTC is pointless. */
export class AiQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiQuotaError";
  }
}

/** A transient capacity or rate problem; retry shortly. */
export class AiBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiBusyError";
  }
}

/** Neurons per million tokens, from developers.cloudflare.com/workers-ai/platform/pricing/ (2026-10-09). */
const PRICES: Record<string, { input: number; output: number }> = {
  "@cf/qwen/qwen3-embedding-0.6b": { input: 1_075, output: 0 },
  "@cf/baai/bge-m3": { input: 1_075, output: 0 },
  "@cf/baai/bge-small-en-v1.5": { input: 1_841, output: 0 },
  "@cf/google/gemma-4-26b-a4b-it": { input: 9_091, output: 27_273 },
  "@cf/openai/gpt-oss-20b": { input: 18_182, output: 27_273 },
  "@cf/openai/gpt-oss-120b": { input: 31_818, output: 68_182 },
  "@cf/meta/llama-4-scout-17b-16e-instruct": { input: 24_545, output: 77_273 },
  "@cf/qwen/qwen3-30b-a3b-fp8": { input: 4_625, output: 30_475 },
};
// Unknown models are priced pessimistically so the ledger errs on the safe side.
const UNKNOWN_PRICE = { input: 60_000, output: 300_000 };
const CHARS_PER_TOKEN = 3; // conservative: over-estimates tokens for code

const priceOf = (model: string) => PRICES[model] ?? UNKNOWN_PRICE;
const tokensFor = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN);

const QUERY_INSTRUCTION =
  "Given a question about a software repository, retrieve the source code or documentation passages that answer it";

export function createWorkersAiEmbedder(ai: AiBinding, model: string, dims: number): EmbeddingProvider {
  return {
    model,
    dims,
    async embed(texts, kind) {
      const inputs = kind === "query" ? { queries: texts, instruction: QUERY_INSTRUCTION } : { documents: texts };
      const output = (await runModel(ai, model, inputs)) as { data?: unknown };
      if (!Array.isArray(output.data) || output.data.length !== texts.length) {
        throw new Error("The embedding model returned an unexpected response.");
      }
      return (output.data as unknown[]).map((vector) => {
        if (!Array.isArray(vector) || vector.length < dims) throw new Error("The embedding model returned too few dimensions.");
        return truncateAndNormalize(vector as number[], dims);
      });
    },
    estimateNeurons(texts) {
      const chars = texts.reduce((sum, text) => sum + text.length, 0);
      return Math.ceil((tokensFor(chars) * priceOf(model).input) / 1_000_000);
    },
  };
}

/**
 * Matryoshka truncation: Qwen3-Embedding is trained so a prefix of the vector
 * is itself a usable embedding. Re-normalising keeps cosine scores meaningful.
 */
export function truncateAndNormalize(vector: number[], dims: number): number[] {
  const head = vector.slice(0, dims);
  const norm = Math.sqrt(head.reduce((sum, value) => sum + value * value, 0)) || 1;
  return head.map((value) => value / norm);
}

/**
 * Reasoning ("thinking") models can spend the whole token budget on hidden
 * reasoning and return empty content (observed live with Gemma 4). Grounded
 * answers need no long reasoning, so it is switched off where supported.
 */
function modelOptions(model: string): Record<string, unknown> {
  if (/gemma-4|qwen3|glm-4/.test(model)) return { chat_template_kwargs: { enable_thinking: false } };
  if (/gpt-oss/.test(model)) return { reasoning_effort: "low" };
  return {};
}

export function createWorkersAiChat(ai: AiBinding, model: string): ChatProvider {
  return {
    model,
    async complete(messages, options) {
      const output = await runModel(ai, model, { messages, max_tokens: options.maxTokens, temperature: 0.1, ...modelOptions(model) });
      return { text: extractText(output), usage: extractUsage(output) };
    },
    estimateNeurons(promptChars, maxTokens) {
      const price = priceOf(model);
      return Math.ceil((tokensFor(promptChars) * price.input + maxTokens * price.output) / 1_000_000);
    },
    neuronsForUsage(usage) {
      const price = priceOf(model);
      return Math.ceil((usage.promptTokens * price.input + usage.completionTokens * price.output) / 1_000_000);
    },
  };
}

async function runModel(ai: AiBinding, model: string, inputs: Record<string, unknown>): Promise<unknown> {
  try {
    return await ai.run(model, inputs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/neuron|allocation|quota|daily|4006/i.test(message)) {
      throw new AiQuotaError("The free daily Workers AI allowance has been used up.");
    }
    if (/429|capacity|overloaded|too many|rate/i.test(message)) {
      throw new AiBusyError("The AI service is busy. Try again shortly.");
    }
    throw new Error(`Workers AI request failed (${model}).`);
  }
}

/** Accepts the response shapes Workers AI text models use. */
export function extractText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object") {
    const record = output as Record<string, unknown>;
    if (typeof record.response === "string") return record.response;
    if (Array.isArray(record.choices)) {
      const message = (record.choices[0] as { message?: { content?: unknown } } | undefined)?.message;
      if (typeof message?.content === "string") return message.content;
    }
    if (typeof record.output_text === "string") return record.output_text;
  }
  throw new Error("The language model returned an unexpected response.");
}

function extractUsage(output: unknown): ChatResult["usage"] {
  const usage = (output as { usage?: Record<string, unknown> } | null)?.usage;
  if (!usage) return null;
  const prompt = Number(usage.prompt_tokens ?? usage.input_tokens);
  const completion = Number(usage.completion_tokens ?? usage.output_tokens);
  return Number.isFinite(prompt) && Number.isFinite(completion) ? { promptTokens: prompt, completionTokens: completion } : null;
}
