export class EmbeddingService {
  private openaiBaseUrl!: string;
  private openaiTimeoutMs!: number;

  constructor(
    private openaiApiKey: string,
    private openaiEmbeddingModel: string = 'text-embedding-3-small',
    private openaiBaseUrlOverride?: string,
    private openaiTimeoutMsOverride?: number
  ) { }

  /* =========================
     INIT
  ========================== */
  async initialize(): Promise<void> {
    this.openaiBaseUrl = (this.openaiBaseUrlOverride || 'https://api.openai.com').replace(/\/+$/, '');
    this.openaiTimeoutMs = this.openaiTimeoutMsOverride ?? 60_000;
    console.log('✓ Embedding provider: OpenAI');
    console.log('✓ Embedding model:', this.openaiEmbeddingModel);
  }

  /* =========================
     SINGLE EMBEDDING
  ========================== */
  async generateEmbedding(text: string): Promise<number[]> {
    const [embedding] = await this.generateBatchEmbeddings([text]);
    return embedding;
  }

  /* =========================
     BATCH
  ========================== */
  async generateBatchEmbeddings(texts: string[]): Promise<number[][]> {
    if (!this.openaiBaseUrl || !this.openaiTimeoutMs) {
      await this.initialize();
    }

    const inputs = texts.map(t => this.preprocess(String(t || '')));

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.openaiTimeoutMs);

    try {
      const res = await fetch(`${this.openaiBaseUrl}/v1/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.openaiApiKey}`
        },
        body: JSON.stringify({
          model: this.openaiEmbeddingModel,
          input: inputs
        }),
        signal: controller.signal
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`OpenAI embeddings error (${res.status}): ${text || res.statusText}`);
      }

      const data: any = await res.json();
      const items: any[] = Array.isArray(data?.data) ? data.data : [];

      // OpenAI returns embeddings with an index, but order matches input. Be defensive anyway.
      const byIndex = new Map<number, number[]>();
      for (const item of items) {
        if (typeof item?.index === 'number' && Array.isArray(item?.embedding)) {
          byIndex.set(item.index, item.embedding);
        }
      }

      const results: number[][] = [];
      for (let i = 0; i < inputs.length; i++) {
        const embedding = byIndex.get(i);
        if (!embedding) {
          throw new Error(`Missing embedding for input index ${i}`);
        }
        results.push(embedding);
      }

      return results;
    } finally {
      clearTimeout(timeout);
    }
  }

  /* =========================
     PREPROCESS
  ========================== */
  private preprocess(text: string): string {
    return text
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[•▪●–—]/g, '-')
      .replace(/[ ]{2,}/g, ' ')
      .trim()
      .slice(0, 3000); // safety
  }
}
