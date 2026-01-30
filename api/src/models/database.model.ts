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
  chunk_index: number;
  // Metadata từ documents
  document_type: string;
  metadata: Record<string, any>;
}

// ========================================
// METADATA INTERFACES
// ========================================

export interface SyllabusMetadata {
  document_type: 'syllabus';
  source_file: string;
  subject_name?: string;
  subject_code?: string;
  major?: string;
  credits?: number;
  faculty?: string;
  level?: string;
  language?: string;
  academic_year?: string;
}

export interface RegulationMetadata {
  document_type: 'regulation';
  source_file: string;
  regulation_type?: 'student_assessment' | 'admission_policy' | 'other';
  decision_number?: string;
  issued_year?: number;
  admission_year?: number;
  issuing_body?: string;
  applicable_object?: string;
  applicable_major?: string;
  effective_status?: 'active' | 'expired';
  education_level?: string;
  institution?: string;
  language?: string;
}

export interface CurriculumMetadata {
  document_type: 'curriculum';
  source_file: string;
  program_name?: string;
  major?: string;
  major_code?: string;
  degree?: string;
  total_credits?: number;
  training_duration?: string;
  admission_from_year?: number;
  issuing_decision?: string;
  issuing_date?: string;
  managing_unit?: string;
  language?: string;
}

export type DocumentMetadata = SyllabusMetadata | RegulationMetadata | CurriculumMetadata;

// OpenAI embeddings are 1536 dims for `text-embedding-3-small` (default in this repo).
// If you change the embedding model, update this constant and re-create/migrate the DB column accordingly.
const VECTOR_DIM = 1536;

export class DatabaseModel {
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');

      // ============================================
      // DOCUMENTS TABLE - Metadata đầy đủ
      // ============================================
      await client.query(`
        CREATE TABLE IF NOT EXISTS documents (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          filename TEXT NOT NULL,
          file_path TEXT NOT NULL,
          file_size INTEGER,
          content_type TEXT,
          
          -- Document type
          document_type TEXT NOT NULL,
          
          -- Metadata JSON (chứa tất cả metadata đặc thù)
          metadata JSONB DEFAULT '{}'::jsonb,
          
          uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          
          -- Index cho search nhanh
          CONSTRAINT valid_document_type CHECK (document_type IN ('syllabus', 'regulation', 'curriculum'))
        )
      `);

      // ============================================
      // CHUNKS TABLE - Minimal metadata
      // ============================================
      await client.query(`
        CREATE TABLE IF NOT EXISTS chunks (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
          content TEXT NOT NULL,
          chunk_index INTEGER,
          
          -- Embedding
          embedding VECTOR(${VECTOR_DIM}),
          
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Detect existing vector dimension in a robust way.
      // Prefer parsing `format_type(...)` (e.g. "vector(1536)") to avoid typmod quirks.
      const dimResult = await client.query(`
        SELECT
          format_type(a.atttypid, a.atttypmod) AS formatted_type,
          a.atttypmod AS typmod
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        WHERE c.relname = 'chunks'
          AND a.attname = 'embedding'
          AND a.attnum > 0
          AND NOT a.attisdropped
        LIMIT 1
      `);

      const formattedType = String(dimResult.rows?.[0]?.formatted_type || '');
      const match = formattedType.match(/vector\((\d+)\)/i);
      const existingDim = match ? Number(match[1]) : Number(dimResult.rows?.[0]?.typmod || 0);
      if (existingDim && existingDim !== VECTOR_DIM) {
        throw new Error(
          `Vector dimension mismatch: DB has ${existingDim} but app expects ${VECTOR_DIM}. ` +
          `You need to migrate the chunks.embedding column (or drop/recreate tables) and re-ingest.`
        );
      }

      // ============================================
      // INDEXES
      // ============================================
      
      // Vector similarity search
      await client.query(`
        CREATE INDEX IF NOT EXISTS chunks_embedding_idx
        ON chunks USING ivfflat (embedding vector_cosine_ops)
        WITH (lists = 100)
      `);

      // Metadata search indexes
      await client.query(`
        CREATE INDEX IF NOT EXISTS documents_type_idx 
        ON documents(document_type)
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS documents_metadata_idx 
        ON documents USING gin(metadata)
      `);

      console.log('✓ Database initialized with full metadata support');
    } finally {
      client.release();
    }
  }

  // ============================================
  // INSERT DOCUMENT
  // ============================================
  async insertDocument(params: {
    filename: string;
    file_path: string;
    file_size: number;
    content_type: string;
    document_type: 'syllabus' | 'regulation' | 'curriculum';
    metadata: Record<string, any>;
  }): Promise<string> {
    const result = await this.pool.query(
      `INSERT INTO documents (filename, file_path, file_size, content_type, document_type, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        params.filename,
        params.file_path,
        params.file_size,
        params.content_type,
        params.document_type,
        JSON.stringify(params.metadata)
      ]
    );

    return result.rows[0].id;
  }

  // ============================================
  // INSERT CHUNK
  // ============================================
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
      [
        params.document_id,
        params.content,
        params.chunk_index,
        embeddingStr,
      ]
    );
  }

  // ============================================
  // SEARCH WITH METADATA
  // ============================================
  async searchSimilarChunks(
    queryEmbedding: number[],
    limit = 5,
    filters?: {
      document_type?: string;
      metadata_filters?: Record<string, any>;
    }
  ): Promise<SearchResult[]> {
    if (queryEmbedding.length !== VECTOR_DIM) {
      throw new Error(`Query embedding dimension mismatch: ${queryEmbedding.length}`);
    }

    const embeddingStr = `[${queryEmbedding.join(',')}]`;

    let query = `
      SELECT
        c.id AS chunk_id,
        c.document_id,
        c.content,
        c.chunk_index,
        1 - (c.embedding <=> $1::vector) AS similarity,
        d.document_type,
        d.metadata
      FROM chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE 1=1
    `;

    const params: any[] = [embeddingStr];
    let paramIndex = 2;

    // Filter by document type
    if (filters?.document_type) {
      query += ` AND d.document_type = $${paramIndex}`;
      params.push(filters.document_type);
      paramIndex++;
    }

    // Filter by metadata (JSON query)
    if (filters?.metadata_filters) {
    for (const [key, value] of Object.entries(filters.metadata_filters)) {
      if (key === 'subject_name') {
        query += ` AND d.metadata->>'subject_name' ILIKE $${paramIndex}`;
        params.push(`%${value}%`);
      } else {
        query += ` AND d.metadata->>'${key}' = $${paramIndex}`;
        params.push(value);
      }
      paramIndex++;
    }
  }

    query += `
      ORDER BY c.embedding <=> $1::vector
      LIMIT $${paramIndex}
    `;
    params.push(limit);

    const result = await this.pool.query(query, params);
    return result.rows;
  }

  // ============================================
  // GET CHUNKS IN RANGES (neighbor expansion)
  // ============================================
  async getChunksInRanges(
    ranges: Array<{ document_id: string; start_index: number; end_index: number }>
  ): Promise<SearchResult[]> {
    if (ranges.length === 0) return [];

    const params: any[] = [];
    const valuesSql = ranges
      .map((r, i) => {
        const base = i * 3;
        params.push(r.document_id, r.start_index, r.end_index);
        return `($${base + 1}::uuid, $${base + 2}::int, $${base + 3}::int)`;
      })
      .join(', ');

    const query = `
      WITH ranges(document_id, start_index, end_index) AS (
        VALUES ${valuesSql}
      )
      SELECT
        c.id AS chunk_id,
        c.document_id,
        c.content,
        0::float8 AS similarity,
        c.chunk_index,
        d.document_type,
        d.metadata
      FROM chunks c
      JOIN documents d ON d.id = c.document_id
      JOIN ranges r
        ON r.document_id = c.document_id
       AND c.chunk_index BETWEEN r.start_index AND r.end_index
      ORDER BY c.document_id, c.chunk_index
    `;

    const result = await this.pool.query(query, params);
    return result.rows;
  }

  // ============================================
  // STATS
  // ============================================
  async getIngestStats() {
    const totalChunksResult = await this.pool.query(
      'SELECT COUNT(*) as count FROM chunks'
    );

    const totalDocsResult = await this.pool.query(
      'SELECT COUNT(*) as count FROM documents'
    );

    const byTypeResult = await this.pool.query(`
      SELECT 
        document_type,
        COUNT(*) as count
      FROM documents
      GROUP BY document_type
    `);

    const documentsResult = await this.pool.query(`
      SELECT 
        d.id,
        d.filename,
        d.document_type,
        d.metadata,
        COUNT(c.id) as num_chunks
      FROM documents d
      LEFT JOIN chunks c ON c.document_id = d.id
      GROUP BY d.id
      ORDER BY d.uploaded_at DESC
    `);

    return {
      totalDocuments: parseInt(totalDocsResult.rows[0]?.count || '0'),
      totalChunks: parseInt(totalChunksResult.rows[0]?.count || '0'),
      byType: byTypeResult.rows,
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
