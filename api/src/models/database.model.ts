import { Pool } from 'pg';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface SearchResult {
  chunk_id: string;
  document_id: string;
  content: string;
  similarity: number;
}

const VECTOR_DIM = 384; 

export class DatabaseModel {
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');

      await client.query(`
        CREATE TABLE IF NOT EXISTS documents (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          filename TEXT NOT NULL,
          file_path TEXT NOT NULL,
          file_size INTEGER,
          content_type TEXT,
          uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS chunks (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
          content TEXT NOT NULL,
          chunk_index INTEGER,
          embedding VECTOR(${VECTOR_DIM}),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS chunks_embedding_idx
        ON chunks USING ivfflat (embedding vector_cosine_ops)
        WITH (lists = 100)
      `);

      console.log('✓ Database initialized');
    } finally {
      client.release();
    }
  }

  async insertChunk(params: {
    document_id: string;
    content: string;
    chunk_index: number;
    embedding: number[];
  }): Promise<void> {
    if (params.embedding.length !== VECTOR_DIM) {
      throw new Error(`Embedding dimension mismatch: ${params.embedding.length}`);
    }

    const embeddingStr = `[${params.embedding.join(',')}]`;

    await this.pool.query(
      `INSERT INTO chunks (document_id, content, chunk_index, embedding)
       VALUES ($1, $2, $3, $4::vector)`,
      [params.document_id, params.content, params.chunk_index, embeddingStr]
    );
  }

  async searchSimilarChunks(
    queryEmbedding: number[],
    limit = 5
  ): Promise<SearchResult[]> {
    if (queryEmbedding.length !== VECTOR_DIM) {
      throw new Error(`Query embedding dimension mismatch: ${queryEmbedding.length}`);
    }

    const embeddingStr = `[${queryEmbedding.join(',')}]`;

    const result = await this.pool.query(
      `
      SELECT
        c.id AS chunk_id,
        c.document_id,
        c.content,
        1 - (c.embedding <=> $1::vector) AS similarity
      FROM chunks c
      ORDER BY c.embedding <=> $1::vector
      LIMIT $2
      `,
      [embeddingStr, limit]
    );

    return result.rows;
  }
}
