// OpenAI-compatible /embeddings client (0013). Same base URL + key as the
// chat path; model comes from LLM_EMBED_MODEL. Returns one float array per
// input text. Callers treat every failure as non-blocking: recall degrades
// to zero memories, never to a failed turn.

export interface EmbedUsage {
  prompt: number;
  total: number;
}

export async function embedTexts(
  baseURL: string,
  apiKey: string,
  model: string,
  texts: string[],
  extraHeaders: Record<string, string> = {},
  dims?: number,
): Promise<{ vectors: number[][]; usage: EmbedUsage; dims: number }> {
  const url = `${baseURL.replace(/\/+$/, "")}/embeddings`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...extraHeaders,
    },
    body: JSON.stringify({
      model,
      input: texts,
      ...(dims !== undefined && Number.isInteger(dims) && dims > 0 ? { dimensions: dims } : {}),
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`embed: HTTP ${res.status}`);
  const body = (await res.json()) as {
    data?: Array<{ embedding?: unknown }>;
    usage?: { prompt_tokens?: number; total_tokens?: number };
  };
  if (!Array.isArray(body.data) || body.data.length !== texts.length) {
    throw new Error("embed: bad response shape");
  }
  const vectors = body.data.map((d, i) => {
    if (!Array.isArray(d.embedding) || d.embedding.length === 0) {
      throw new Error(`embed: bad vector at index ${i}`);
    }
    return d.embedding as number[];
  });
  const gotDims = vectors[0].length;
  for (const v of vectors) {
    if (v.length !== gotDims) throw new Error("embed: ragged dims");
  }
  return {
    vectors,
    usage: {
      prompt: body.usage?.prompt_tokens ?? 0,
      total: body.usage?.total_tokens ?? 0,
    },
    dims: gotDims,
  };
}

/** Cosine similarity. Mismatched lengths score 0 (never throw in recall). */
export function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Default recall dims (Matryoshka prefix of 3-small). Env override: LLM_EMBED_DIMS. */
export const DEFAULT_EMBED_DIMS = 256;

export function embedDims(raw: string | undefined): number {
  const n = Number((raw ?? "").trim());
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_EMBED_DIMS;
}

/**
 * Truncates to dims + L2-normalizes. Works whether the gateway honored
 * `dimensions` or returned full width: same shape either way.
 */
export function toUnitVec(v: number[], dims: number): Float32Array {
  const s = v.slice(0, dims);
  let n = 0;
  for (const x of s) n += x * x;
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s[i] / n;
  return out;
}

/** Dot product on unit vectors (= cosine). Length mismatch scores 0. */
export function dot(a: Float32Array, b: Float32Array): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
}

export function f32ToBytes(f: Float32Array): ArrayBuffer {
  return f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength) as ArrayBuffer;
}

export function bytesToF32(b: ArrayBuffer | null | undefined): Float32Array | null {
  if (!b || b.byteLength === 0 || b.byteLength % 4 !== 0) return null;
  return new Float32Array(b);
}
