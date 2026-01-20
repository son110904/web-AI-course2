import { pipeline, env } from '@xenova/transformers';

env.allowLocalModels = false;

export class EmbeddingService {
  private extractor: any;
  private initialized = false;

  constructor(
    private modelName: string = 'Xenova/paraphrase-multilingual-mpnet-base-v2'
  ) { }

  /* =========================
     INIT
  ========================== */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    console.log('⏳ Loading embedding model:', this.modelName);
    this.extractor = await pipeline('feature-extraction', this.modelName);
    this.initialized = true;
    console.log('✓ Embedding model loaded');
  }

  /* =========================
     SINGLE EMBEDDING
  ========================== */
  async generateEmbedding(text: string): Promise<number[]> {
    if (!this.initialized) {
      await this.initialize();
    }

    const clean = this.preprocess(text);

    const output = await this.extractor(clean, {
      pooling: 'mean',
      normalize: false, // ❗ QUAN TRỌNG
      truncation: true,
      max_length: 512,
    });

    return Array.from(output.data as Float32Array);
  }

  /* =========================
     BATCH
  ========================== */
  async generateBatchEmbeddings(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (const t of texts) {
      results.push(await this.generateEmbedding(t));
    }
    return results;
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
