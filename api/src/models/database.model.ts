import { Pool } from 'pg';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface SearchResult {
  chunk_id: string;
  document_id: string;
  content: string;
  parent_content?: string | null;
  parent_index?: number | null;
  similarity: number;
  keyword_score?: number;
  combined_score?: number;
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
          parent_index INTEGER,
          parent_content TEXT,
          embedding VECTOR(${VECTOR_DIM}),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await client.query(`
        ALTER TABLE chunks
        ADD COLUMN IF NOT EXISTS parent_index INTEGER
      `);

      await client.query(`
        ALTER TABLE chunks
        ADD COLUMN IF NOT EXISTS parent_content TEXT
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS chunks_embedding_idx
        ON chunks USING ivfflat (embedding vector_cosine_ops)
        WITH (lists = 100)
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS chunks_content_tsv_idx
        ON chunks USING GIN (to_tsvector('simple', content))
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
}): Promise<string> {
  const result = await this.pool.query(
    `
    INSERT INTO documents (filename, file_path, file_size, content_type)
    VALUES ($1, $2, $3, $4)
    RETURNING id
    `,
    [
      params.filename,
      params.file_path,
      params.file_size,
      params.content_type,
    ]
  );

  return result.rows[0].id;
}


  async insertChunk(params: {
    document_id: string;
    content: string;
    chunk_index: number;
    parent_index?: number;
    parent_content?: string;
    embedding: number[];
  }): Promise<void> {
    if (params.embedding.length !== VECTOR_DIM) {
      throw new Error(`Embedding dimension mismatch: ${params.embedding.length}`);
    }

    const embeddingStr = `[${params.embedding.join(',')}]`;

    await this.pool.query(
      `INSERT INTO chunks (document_id, content, chunk_index, parent_index, parent_content, embedding)
       VALUES ($1, $2, $3, $4, $5, $6::vector)`,
      [
        params.document_id,
        params.content,
        params.chunk_index,
        params.parent_index ?? null,
        params.parent_content ?? null,
        embeddingStr,
      ]
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
        c.parent_content,
        c.parent_index,
        1 - (c.embedding <=> $1::vector) AS similarity
      FROM chunks c
      ORDER BY c.embedding <=> $1::vector
      LIMIT $2
      `,
      [embeddingStr, limit]
    );

    return result.rows;
  }

  async searchKeywordChunks(query: string, limit = 5): Promise<SearchResult[]> {
    const result = await this.pool.query(
      `
      SELECT
        c.id AS chunk_id,
        c.document_id,
        c.content,
        c.parent_content,
        c.parent_index,
        ts_rank_cd(to_tsvector('simple', c.content), plainto_tsquery('simple', $1)) AS keyword_score
      FROM chunks c
      WHERE to_tsvector('simple', c.content) @@ plainto_tsquery('simple', $1)
      ORDER BY keyword_score DESC
      LIMIT $2
      `,
      [query, limit]
    );

    return result.rows.map((row) => ({
      ...row,
      similarity: 0,
      keyword_score: Number(row.keyword_score || 0),
    }));
  }

  async searchHybridChunks(
    queryEmbedding: number[],
    queryText: string,
    limit = 8
  ): Promise<SearchResult[]> {
    const [vectorResults, keywordResults] = await Promise.all([
      this.searchSimilarChunks(queryEmbedding, Math.max(limit, 12)),
      this.searchKeywordChunks(queryText, Math.max(limit, 12)),
    ]);

    const maxSimilarity = vectorResults.reduce(
      (max, item) => Math.max(max, item.similarity ?? 0),
      0
    );
    const maxKeyword = keywordResults.reduce(
      (max, item) => Math.max(max, item.keyword_score ?? 0),
      0
    );

    const weightVector = 0.65;
    const weightKeyword = 0.35;

    const merged = new Map<string, SearchResult>();

    const upsert = (result: SearchResult) => {
      const existing = merged.get(result.chunk_id);
      if (!existing) {
        merged.set(result.chunk_id, {
          ...result,
          similarity: result.similarity ?? 0,
          keyword_score: result.keyword_score ?? 0,
          combined_score: 0,
        });
        return;
      }

      existing.similarity = Math.max(existing.similarity ?? 0, result.similarity ?? 0);
      existing.keyword_score = Math.max(existing.keyword_score ?? 0, result.keyword_score ?? 0);
      existing.parent_content = existing.parent_content ?? result.parent_content;
      existing.parent_index = existing.parent_index ?? result.parent_index;
    };

    vectorResults.forEach(upsert);
    keywordResults.forEach(upsert);

    const scoredResults = Array.from(merged.values()).map((item) => {
      const normalizedSimilarity = maxSimilarity
        ? (item.similarity ?? 0) / maxSimilarity
        : 0;
      const normalizedKeyword = maxKeyword
        ? (item.keyword_score ?? 0) / maxKeyword
        : 0;
      const combinedScore =
        weightVector * normalizedSimilarity + weightKeyword * normalizedKeyword;
      return {
        ...item,
        combined_score: combinedScore,
      };
    });

    return scoredResults
      .sort((a, b) => (b.combined_score ?? 0) - (a.combined_score ?? 0))
      .slice(0, limit);
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
