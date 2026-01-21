import { Pool } from 'pg';


export const ChunkSchema = {
  id: String,
  docId: String,
  order: Number,
  content: String,
  metadata: Object
};


export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface SearchResult {
  chunk_id: string;
  document_id: string;
  content: string;
  similarity: number;
  document_type: string;
  entity: string;
  major: string;
  source_file: string;
  chunk_index: number;
}

const VECTOR_DIM = 768;

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
          document_type TEXT,
          entity TEXT,
          major TEXT,
          source_file TEXT,
          uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS chunks (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
          content TEXT NOT NULL,
          chunk_index INTEGER,
          document_type TEXT,
          entity TEXT,
          major TEXT,
          source_file TEXT,
          embedding VECTOR(${VECTOR_DIM}),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await client.query(`
        ALTER TABLE documents
        ADD COLUMN IF NOT EXISTS document_type TEXT,
        ADD COLUMN IF NOT EXISTS entity TEXT,
        ADD COLUMN IF NOT EXISTS major TEXT,
        ADD COLUMN IF NOT EXISTS source_file TEXT
      `);

      await client.query(`
        ALTER TABLE chunks
        ADD COLUMN IF NOT EXISTS document_type TEXT,
        ADD COLUMN IF NOT EXISTS entity TEXT,
        ADD COLUMN IF NOT EXISTS major TEXT,
        ADD COLUMN IF NOT EXISTS source_file TEXT
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
  async insertDocument(params: {
    filename: string;
    file_path: string;
    file_size: number;
    content_type: string;
    document_type?: string;
    entity?: string;
    major?: string;
    source_file?: string;
  }): Promise<string> {
    const result = await this.pool.query(
      `
    INSERT INTO documents (filename, file_path, file_size, content_type, document_type, entity, major, source_file)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING id
    `,
      [
        params.filename,
        params.file_path,
        params.file_size,
        params.content_type,
        params.document_type || null,
        params.entity || null,
        params.major || null,
        params.source_file || null,
      ]
    );

    return result.rows[0].id;
  }


  async insertChunk(params: {
    document_id: string;
    content: string;
    chunk_index: number;
    embedding: number[];
    document_type?: string;
    entity?: string;
    major?: string;
    source_file?: string;
  }): Promise<void> {
    if (params.embedding.length !== VECTOR_DIM) {
      throw new Error(`Embedding dimension mismatch: ${params.embedding.length}`);
    }

    const embeddingStr = `[${params.embedding.join(',')}]`;

    await this.pool.query(
      `INSERT INTO chunks (document_id, content, chunk_index, document_type, entity, major, source_file, embedding)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector)`,
      [
        params.document_id,
        params.content,
        params.chunk_index,
        params.document_type || null,
        params.entity || null,
        params.major || null,
        params.source_file || null,
        embeddingStr,
      ]
    );
  }

  async searchSimilarChunks(
    queryEmbedding: number[],
    limit = 5,
    filters?: {
      document_type?: string;
      entity?: string;
      major?: string;
    }
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
        1 - (c.embedding <=> $1::vector) AS similarity,
        c.document_type,
        c.entity,
        c.major,
        c.source_file,
        c.chunk_index
      FROM chunks c
      WHERE ($2::text IS NULL OR c.document_type = $2)
        AND ($3::text IS NULL OR c.entity = $3)
        AND ($4::text IS NULL OR c.major = $4)
      ORDER BY c.embedding <=> $1::vector
      LIMIT $5
      `,
      [
        embeddingStr,
        filters?.document_type || null,
        filters?.entity || null,
        filters?.major || null,
        limit,
      ]
    );

    return result.rows;
  }
  async getIngestStats() {
    const totalChunksResult = await this.pool.query(
      'SELECT COUNT(*) as count FROM chunks'
    );

    const totalDocsResult = await this.pool.query(
      'SELECT COUNT(DISTINCT document_id) as count FROM chunks'
    );

    const documentsResult = await this.pool.query(`
    SELECT 
      document_id,
      COUNT(*) as num_chunks,
      MIN(chunk_index) as min_index,
      MAX(chunk_index) as max_index
    FROM chunks
    GROUP BY document_id
    ORDER BY document_id
  `);

    return {
      totalDocuments: parseInt(totalDocsResult.rows[0]?.count || '0'),
      totalChunks: parseInt(totalChunksResult.rows[0]?.count || '0'),
      documents: documentsResult.rows
    };
  }
  async getAllDocumentPaths(): Promise<string[]> {
    const result = await this.pool.query(
      'SELECT file_path FROM documents'
    );
    return result.rows.map(row => row.file_path);
  }
}
