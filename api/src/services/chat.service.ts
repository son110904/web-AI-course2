import { expandQuery } from "./query-expansion.service";
import { addNeighborChunks } from "./neighbor-chunk.service";
//import { vectorSearch } from "./vectorSearch.service";

export async function chatRAG(query: string) {
  // 1. Expand query
  const expandedQueries = expandQuery(query);

  // 2. Vector search (top_k nhỏ)
  const topChunks = await vectorSearch(expandedQueries, 3);

  // 3. Load all chunks cùng document
  const allChunks = await loadChunksByDocIds(
    topChunks.map(c => c.docId)
  );

  // 4. Add neighbor chunks
  const contextChunks = addNeighborChunks(
    topChunks,
    allChunks,
    1
  );

  // 5. Ghép context cho LLM
  const contextText = contextChunks
    .sort((a, b) => a.order - b.order)
    .map(c => c.content)
    .join("\n");

  return contextText;
}
