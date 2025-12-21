import { Pool } from 'pg';

export interface Document {
  id: string;
  filename: string;
  file_path: string;
  file_size: number;
  content_type: string;
  uploaded_at: Date;
}

export interface Chunk {
  id: string;
  document_id: string;
  content: string;
  chunk_index: number;
  embedding?: number[];
  created_at: Date;
}

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
          filename VARCHAR(255) NOT NULL,
          file_path VARCHAR(500) NOT NULL,
          file_size INTEGER,
          content_type VARCHAR(100),
          uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS chunks (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
          content TEXT NOT NULL,
          chunk_index INTEGER,
          embedding vector(384),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS chunks_embedding_idx 
        ON chunks USING ivfflat (embedding vector_cosine_ops)
        WITH (lists = 100)
      `);

      console.log('✓ Database initialized');
    } catch (error) {
      console.error('✗ Database error:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  async insertDocument(doc: Omit<Document, 'id' | 'uploaded_at'>): Promise<string> {
    const result = await this.pool.query(
      `INSERT INTO documents (filename, file_path, file_size, content_type) 
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [doc.filename, doc.file_path, doc.file_size, doc.content_type]
    );
    return result.rows[0].id;
  }

  async insertChunk(chunk: Omit<Chunk, 'id' | 'created_at'>): Promise<string> {
    const embeddingArray = chunk.embedding ? `[${chunk.embedding.join(',')}]` : null;
    const result = await this.pool.query(
      `INSERT INTO chunks (document_id, content, chunk_index, embedding) 
       VALUES ($1, $2, $3, $4::vector) RETURNING id`,
      [chunk.document_id, chunk.content, chunk.chunk_index, embeddingArray]
    );
    return result.rows[0].id;
  }

  async searchSimilarChunks(queryEmbedding: number[], limit: number = 5): Promise<SearchResult[]> {
    const embeddingStr = `[${queryEmbedding.join(',')}]`;
    const result = await this.pool.query(
      `SELECT 
        c.id as chunk_id,
        c.document_id,
        c.content,
        1 - (c.embedding <=> $1::vector) as similarity
      FROM chunks c
      WHERE c.embedding IS NOT NULL
      ORDER BY c.embedding <=> $1::vector
      LIMIT $2`,
      [embeddingStr, limit]
    );
    return result.rows;
  }

  async getDocuments(): Promise<Document[]> {
    const result = await this.pool.query('SELECT * FROM documents ORDER BY uploaded_at DESC');
    return result.rows;
  }

  async deleteDocument(id: string): Promise<void> {
    await this.pool.query('DELETE FROM documents WHERE id = $1', [id]);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}