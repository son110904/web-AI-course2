import { v4 as uuidv4 } from 'uuid';

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
// If you change the embedding model, update this constant AND your Qdrant collection vector size accordingly.
const DEFAULT_VECTOR_DIM = 1536;

type QdrantSearchPoint = {
  id: string | number;
  score?: number;
  payload?: Record<string, any> | null;
};

type QdrantFilter = {
  must?: any[];
  should?: any[];
  must_not?: any[];
};

type QdrantRange = { gte?: number; lte?: number };

function normalizeBaseUrl(url: string): string {
  return String(url || '').trim().replace(/\/+$/, '');
}

function isRecord(payload: unknown): payload is Record<string, any> {
  return !!payload && typeof payload === 'object' && !Array.isArray(payload);
}

function pickMetadata(payload: Record<string, any>): Record<string, any> {
  const meta = payload.metadata;
  if (isRecord(meta)) return meta;

  // Derive metadata from common Qdrant payload conventions (no nested `metadata` object).
  const folderType = payload.folder_type ?? payload.document_type;
  const sourceFile = payload.minio_path ?? payload.file_path ?? payload.source_file ?? payload.file_name;

  const derived: Record<string, any> = {
    ...(folderType ? { document_type: folderType } : {}),
    ...(sourceFile ? { source_file: sourceFile } : {}),
  };

  // Keep useful fields (helps debugging / UI).
  const passthroughKeys = [
    'file_name',
    'chunk_name',
    'chunk_index',
    'total_chunks',
    'text_length',
    'bucket_source',
    'path_prefix',
    'folder_type',
    'minio_path',
    'created_at',
  ];
  for (const k of passthroughKeys) {
    if (payload[k] !== undefined && derived[k] === undefined) derived[k] = payload[k];
  }

  return derived;
}

function toSearchResult(p: QdrantSearchPoint): SearchResult {
  const payload = isRecord(p.payload) ? p.payload : {};
  const metadata = pickMetadata(payload);

  return {
    chunk_id: String(p.id),
    // Your collection uses `minio_path` as the stable "document" identifier.
    document_id: String(
      payload.document_id ||
        payload.docId ||
        payload.doc_id ||
        payload.minio_path ||
        payload.file_path ||
        metadata.document_id ||
        metadata.source_file ||
        ''
    ),
    content: String(payload.text || payload.content || payload.page_content || ''),
    similarity: typeof p.score === 'number' ? p.score : 0,
    chunk_index: Number(payload.chunk_index ?? payload.chunkIndex ?? payload.order ?? payload.index ?? 0),
    document_type: String(payload.folder_type || payload.document_type || metadata.document_type || ''),
    metadata,
  };
}

export class DatabaseModel {
  private qdrantUrl: string;
  private qdrantApiKey?: string;
  private collection: string;
  private vectorDim: number;
  private vectorName?: string;
  private ensureIndexes: boolean;
  private documentsById = new Map<
    string,
    {
      document_type?: string;
      metadata?: Record<string, any>;
      filename?: string;
      file_path?: string;
    }
  >();

  constructor(params: {
    qdrantUrl: string;
    collection: string;
    qdrantApiKey?: string;
    vectorDim?: number;
    vectorName?: string;
    ensureIndexes?: boolean;
  }) {
    this.qdrantUrl = normalizeBaseUrl(params.qdrantUrl);
    this.qdrantApiKey = params.qdrantApiKey;
    this.collection = params.collection;
    this.vectorDim = params.vectorDim ?? DEFAULT_VECTOR_DIM;
    this.vectorName = params.vectorName ? String(params.vectorName).trim() : undefined;
    this.ensureIndexes = params.ensureIndexes ?? false;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.qdrantApiKey) h['api-key'] = this.qdrantApiKey;
    return h;
  }

  private async qdrant<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.qdrantUrl}${path}`, {
      ...init,
      headers: { ...this.headers(), ...(init?.headers || {}) },
    });

    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    if (!res.ok) {
      const msg =
        json?.status?.error ||
        json?.message ||
        json?.result?.error ||
        text ||
        res.statusText;
      throw new Error(`Qdrant error (${res.status}) ${path}: ${msg}`);
    }

    return json as T;
  }

  private async ensurePayloadIndex(fieldName: string, fieldSchema: 'keyword' | 'integer' | 'float' | 'bool' | 'text') {
    try {
      await this.qdrant(`/collections/${encodeURIComponent(this.collection)}/index?wait=true`, {
        method: 'PUT',
        body: JSON.stringify({
          field_name: fieldName,
          field_schema: fieldSchema,
        }),
      });
      console.log(`✓ Qdrant payload index ensured: ${fieldName} (${fieldSchema})`);
    } catch (err: any) {
      const msg = String(err?.message || err || '');
      // If it already exists or Qdrant version differs, don't hard-fail startup.
      if (
        msg.toLowerCase().includes('already exists') ||
        msg.toLowerCase().includes('conflict') ||
        msg.toLowerCase().includes('not found') ||
        msg.toLowerCase().includes('unsupported') ||
        msg.toLowerCase().includes('unimplemented')
      ) {
        console.warn(`⚠️ Qdrant payload index not ensured for "${fieldName}": ${msg}`);
        return;
      }
      throw err;
    }
  }

  async initialize(): Promise<void> {
    if (!this.qdrantUrl) {
      throw new Error('Missing required config: qdrantUrl');
    }
    if (!this.collection) {
      throw new Error('Missing required config: collection');
    }

    // Verify collection exists (user said they already uploaded embeddings).
    await this.qdrant(`/collections/${encodeURIComponent(this.collection)}`, {
      method: 'GET',
    });

    if (this.ensureIndexes) {
      // Needed for neighbor expansion + optional filters.
      await this.ensurePayloadIndex('minio_path', 'keyword');
      await this.ensurePayloadIndex('chunk_index', 'integer');
      await this.ensurePayloadIndex('folder_type', 'keyword');
    }

    console.log('✓ Qdrant connected');
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
    const id = uuidv4();

    // Store a "document" point with a zero-vector (so it fits the collection schema).
    const vector = new Array(this.vectorDim).fill(0);
    const payload = {
      record_type: 'document',
      document_id: id,
      filename: params.filename,
      file_path: params.file_path,
      file_size: params.file_size,
      content_type: params.content_type,
      document_type: params.document_type,
      metadata: params.metadata || {},
      uploaded_at: new Date().toISOString(),
    };

    await this.qdrant(`/collections/${encodeURIComponent(this.collection)}/points?wait=true`, {
      method: 'PUT',
      body: JSON.stringify({
        points: [
          {
            id,
            vector: this.vectorName ? { [this.vectorName]: vector } : vector,
            payload,
          },
        ],
      }),
    });

    this.documentsById.set(id, {
      document_type: params.document_type,
      metadata: params.metadata || {},
      filename: params.filename,
      file_path: params.file_path,
    });

    return id;
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
    if (params.embedding.length !== this.vectorDim) {
      throw new Error(`Embedding dimension mismatch: ${params.embedding.length}`);
    }

    const id = uuidv4();
    const doc = this.documentsById.get(params.document_id);
    const payload = {
      document_id: params.document_id,
      content: params.content,
      chunk_index: params.chunk_index,
      document_type: doc?.document_type,
      metadata: doc?.metadata,
      source_file: doc?.file_path,
    };

    await this.qdrant(`/collections/${encodeURIComponent(this.collection)}/points?wait=true`, {
      method: 'PUT',
      body: JSON.stringify({
        points: [
          {
            id,
            vector: this.vectorName ? { [this.vectorName]: params.embedding } : params.embedding,
            payload,
          },
        ],
      }),
    });
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
    if (queryEmbedding.length !== this.vectorDim) {
      throw new Error(`Query embedding dimension mismatch: ${queryEmbedding.length}`);
    }

    // Qdrant filtering can vary depending on how you uploaded payloads.
    // To be robust, we retrieve more results and apply filters client-side.
    const rawLimit = Math.max(limit * 5, 25);

    const body: any = {
      limit: rawLimit,
      with_payload: true,
    };

    body.vector = this.vectorName ? { name: this.vectorName, vector: queryEmbedding } : queryEmbedding;

    const resp = await this.qdrant<{
      result?: QdrantSearchPoint[];
    }>(`/collections/${encodeURIComponent(this.collection)}/points/search`, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    const points = Array.isArray(resp?.result) ? resp.result : [];
    let results = points.map(toSearchResult).filter(r => r.content);

    if (filters?.document_type) {
      results = results.filter(r => (r.document_type || r.metadata?.document_type) === filters.document_type);
    }

    if (filters?.metadata_filters) {
      for (const [key, value] of Object.entries(filters.metadata_filters)) {
        if (key === 'subject_name') {
          const needle = String(value || '').toLowerCase();
          results = results.filter(r => String(r.metadata?.subject_name || '').toLowerCase().includes(needle));
        } else {
          results = results.filter(r => String(r.metadata?.[key] ?? '') === String(value ?? ''));
        }
      }
    }

    return results.slice(0, limit);
  }

  // ============================================
  // 🆕 SEARCH BY INSTRUCTOR NAME (TEACHING SECTION ONLY)
  // ============================================
  /**
   * Search for syllabus chunks that mention an instructor's name
   * ONLY in the "Giảng viên giảng dạy học phần" section
   * to avoid false positives from dean signatures, editors, etc.
   */
  async searchByInstructor(
    instructorName: string,
    options?: {
      document_type?: string;
      limit?: number;
    }
  ): Promise<SearchResult[]> {
    // Qdrant doesn't provide SQL-style substring queries unless you created text indexes.
    // Return empty so RAGService falls back to semantic search.
    void instructorName;
    void options;
    return [];
  }

  /**
   * 🆕 ALTERNATIVE: Two-pass search for better accuracy
   * Pass 1: Find chunks with "Giảng viên giảng dạy" section marker
   * Pass 2: In those documents, find chunks with instructor name nearby
   */
  async searchByInstructorTwoPass(
    instructorName: string,
    options?: {
      document_type?: string;
      limit?: number;
    }
  ): Promise<SearchResult[]> {
    void instructorName;
    void options;
    return [];
  }

  /**
   * Helper: Normalize Vietnamese text for search
   */
  private normalizeVietnamese(text: string): string {
    return text
      .toLowerCase()
      .trim();
  }

  // ============================================
  // GET CHUNKS IN RANGES (neighbor expansion)
  // ============================================
  async getChunksInRanges(
    ranges: Array<{ document_id: string; start_index: number; end_index: number }>
  ): Promise<SearchResult[]> {
    if (ranges.length === 0) return [];

    const out: SearchResult[] = [];

    // Qdrant doesn't support querying multiple (doc,range) tuples in one call easily.
    // Keep it simple and scroll per range (ranges are merged already by NeighborChunkService).
    const tryScroll = async (filter: QdrantFilter, limit: number) => {
      const resp = await this.qdrant<{
        result?: { points?: Array<{ id: string | number; payload?: Record<string, any> | null }> };
      }>(`/collections/${encodeURIComponent(this.collection)}/points/scroll`, {
        method: 'POST',
        body: JSON.stringify({ filter, limit, with_payload: true }),
      });
      return resp?.result?.points || [];
    };

    for (const r of ranges) {
      const limit = Math.max(256, (r.end_index - r.start_index + 1) * 2);

      const docKeys = ['minio_path', 'document_id', 'docId', 'doc_id', 'file_path', 'file_name'];
      const idxKeys = ['chunk_index', 'order'];

      let points: Array<{ id: string | number; payload?: Record<string, any> | null }> = [];

      for (const docKey of docKeys) {
        for (const idxKey of idxKeys) {
          const filter: QdrantFilter = {
            must: [
              { key: docKey, match: { value: r.document_id } },
              { key: idxKey, range: { gte: r.start_index, lte: r.end_index } as QdrantRange },
            ],
          };

          points = await tryScroll(filter, limit);
          if (points.length > 0) break;
        }
        if (points.length > 0) break;
      }

      for (const p of points) {
        out.push(toSearchResult({ id: p.id, score: 0, payload: p.payload ?? {} }));
      }
    }

    out.sort((a, b) =>
      a.document_id === b.document_id
        ? a.chunk_index - b.chunk_index
        : a.document_id.localeCompare(b.document_id)
    );

    return out;
  }

  // ============================================
  // STATS
  // ============================================
  async getIngestStats() {
    const countByFilter = async (filter: QdrantFilter) => {
      const resp = await this.qdrant<{ result?: { count?: number } }>(
        `/collections/${encodeURIComponent(this.collection)}/points/count`,
        {
          method: 'POST',
          body: JSON.stringify({ filter, exact: true }),
        }
      );
      return Number(resp?.result?.count || 0);
    };

    let totalChunks = await countByFilter({
      must: [{ key: 'record_type', match: { value: 'chunk' } }],
    });

    let totalDocuments = await countByFilter({
      must: [{ key: 'record_type', match: { value: 'document' } }],
    });

    // Backward-compatible fallback for collections that don't store `record_type`.
    if (totalChunks === 0 && totalDocuments === 0) {
      const resp = await this.qdrant<{ result?: { count?: number } }>(
        `/collections/${encodeURIComponent(this.collection)}/points/count`,
        { method: 'POST', body: JSON.stringify({ exact: true }) }
      );
      totalChunks = Number(resp?.result?.count || 0);
      totalDocuments = 0;
    }

    // Keep shape compatible, but avoid expensive aggregations.
    return {
      totalDocuments,
      totalChunks,
      byType: [],
      documents: [],
    };
  }

  async getAllDocumentPaths(): Promise<string[]> {
    const resp = await this.qdrant<{
      result?: { points?: Array<{ payload?: Record<string, any> | null }> };
    }>(`/collections/${encodeURIComponent(this.collection)}/points/scroll`, {
      method: 'POST',
      body: JSON.stringify({
        limit: 10_000,
        with_payload: ['minio_path', 'file_path', 'file_name'],
      }),
    });

    const points = resp?.result?.points || [];
    const paths = points
      .map(p => (isRecord(p.payload) ? (p.payload.minio_path ?? p.payload.file_path ?? p.payload.file_name) : null))
      .filter((p): p is string => typeof p === 'string' && p.length > 0);

    return Array.from(new Set(paths));
  }

  // Used by ingest.controller.ts to wipe data (optional).
  async clearAll(): Promise<void> {
    await this.qdrant(`/collections/${encodeURIComponent(this.collection)}/points/delete?wait=true`, {
      method: 'POST',
      body: JSON.stringify({
        filter: {
          must: [{ key: 'record_type', match: { value: 'chunk' } }],
        },
      }),
    });

    await this.qdrant(`/collections/${encodeURIComponent(this.collection)}/points/delete?wait=true`, {
      method: 'POST',
      body: JSON.stringify({
        filter: {
          must: [{ key: 'record_type', match: { value: 'document' } }],
        },
      }),
    });
  }
}
