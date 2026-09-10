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
): Promise<{ vectors: number[][]; usage: EmbedUsage; dims: number }> {
  const url = `${baseURL.replace(/\/+$/, "")}/embeddings`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...extraHeaders,
    },
    body: JSON.stringify({ model, input: texts }),
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
  const dims = vectors[0].length;
  for (const v of vectors) {
    if (v.length !== dims) throw new Error("embed: ragged dims");
  }
  return {
    vectors,
    usage: {
      prompt: body.usage?.prompt_tokens ?? 0,
      total: body.usage?.total_tokens ?? 0,
    },
    dims,
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
