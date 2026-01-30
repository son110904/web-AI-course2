import { DatabaseModel, SearchResult } from '../models/database.model';

// Back-compat for older code paths (e.g. chat.service.ts).
export function addNeighborChunks(topChunks: any[], allChunks: any[], window = 1) {
  const chunkMap = new Map<string, any>();

  allChunks.forEach(chunk => {
    const key = `${chunk.docId}_${chunk.order}`;
    chunkMap.set(key, chunk);
  });

  const result = new Map<number, any>();

  topChunks.forEach(chunk => {
    for (let offset = -window; offset <= window; offset++) {
      const key = `${chunk.docId}_${chunk.order + offset}`;
      const neighbor = chunkMap.get(key);
      if (neighbor) {
        result.set(neighbor.chunkId, neighbor);
      }
    }
  });

  return Array.from(result.values());
}

export class NeighborChunkService {
  constructor(private db: DatabaseModel) {}

  async expand(chunks: SearchResult[], window = 1): Promise<SearchResult[]> {
    const w = Number.isFinite(window) ? Math.max(0, Math.floor(window)) : 1;
    if (w === 0 || chunks.length === 0) return chunks;

    // Build + merge ranges per document to minimize DB queries.
    const byDoc = new Map<string, Array<{ start: number; end: number }>>();
    for (const c of chunks) {
      const start = Math.max(0, c.chunk_index - w);
      const end = c.chunk_index + w;
      const list = byDoc.get(c.document_id) || [];
      list.push({ start, end });
      byDoc.set(c.document_id, list);
    }

    const mergedRanges: Array<{ document_id: string; start_index: number; end_index: number }> = [];
    for (const [documentId, ranges] of byDoc.entries()) {
      ranges.sort((a, b) => a.start - b.start);
      let current = ranges[0];
      for (let i = 1; i < ranges.length; i++) {
        const r = ranges[i];
        if (r.start <= current.end + 1) {
          current.end = Math.max(current.end, r.end);
        } else {
          mergedRanges.push({ document_id: documentId, start_index: current.start, end_index: current.end });
          current = r;
        }
      }
      mergedRanges.push({ document_id: documentId, start_index: current.start, end_index: current.end });
    }

    const neighbors = await this.db.getChunksInRanges(mergedRanges);

    // Merge: keep max similarity for chunks that were originally retrieved.
    const merged = new Map<string, SearchResult>();
    for (const n of neighbors) merged.set(n.chunk_id, n);
    for (const c of chunks) {
      const existing = merged.get(c.chunk_id);
      merged.set(c.chunk_id, existing ? { ...existing, similarity: Math.max(existing.similarity, c.similarity) } : c);
    }

    // Sort: documents by best match similarity, then chunk_index asc.
    const docScore = new Map<string, number>();
    for (const c of chunks) {
      const prev = docScore.get(c.document_id) ?? 0;
      docScore.set(c.document_id, Math.max(prev, c.similarity));
    }

    const docs = [...new Set([...merged.values()].map(c => c.document_id))].sort(
      (a, b) => (docScore.get(b) ?? 0) - (docScore.get(a) ?? 0)
    );

    const byDocChunks = new Map<string, SearchResult[]>();
    for (const c of merged.values()) {
      const list = byDocChunks.get(c.document_id) || [];
      list.push(c);
      byDocChunks.set(c.document_id, list);
    }

    const result: SearchResult[] = [];
    for (const docId of docs) {
      const list = byDocChunks.get(docId) || [];
      list.sort((a, b) => a.chunk_index - b.chunk_index);
      result.push(...list);
    }

    return result;
  }
}
