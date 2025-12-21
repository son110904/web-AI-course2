import { pipeline, env } from '@xenova/transformers';

env.allowLocalModels = false;

export class EmbeddingService {
  private extractor: any;
  private modelName: string;
  private initialized: boolean = false;

  constructor(modelName: string = 'Xenova/all-MiniLM-L6-v2') {
    this.modelName = modelName;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      console.log('⏳ Loading embedding model...');
      this.extractor = await pipeline('feature-extraction', this.modelName);
      this.initialized = true;
      console.log('✓ Embedding model loaded');
    } catch (error) {
      console.error('✗ Failed to load model:', error);
      throw error;
    }
  }

  async generateEmbedding(text: string): Promise<number[]> {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      const output = await this.extractor(text, {
        pooling: 'mean',
        normalize: true,
      });
      return Array.from(output.data);
    } catch (error) {
      console.error('✗ Embedding error:', error);
      throw error;
    }
  }

  async generateBatchEmbeddings(texts: string[]): Promise<number[][]> {
    const embeddings: number[][] = [];
    for (const text of texts) {
      const embedding = await this.generateEmbedding(text);
      embeddings.push(embedding);
    }
    return embeddings;
  }
}