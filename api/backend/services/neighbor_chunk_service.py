from __future__ import annotations

from backend.models.database import DatabaseModel, SearchResult


def add_neighbor_chunks(top_chunks: list[dict], all_chunks: list[dict], window: int = 1) -> list[dict]:
    chunk_map: dict[str, dict] = {}
    for chunk in all_chunks:
        key = f"{chunk.get('docId')}_{chunk.get('order')}"
        chunk_map[key] = chunk

    result: dict[str, dict] = {}
    for chunk in top_chunks:
        for offset in range(-window, window + 1):
            key = f"{chunk.get('docId')}_{int(chunk.get('order', 0)) + offset}"
            neighbor = chunk_map.get(key)
            if neighbor:
                result[str(neighbor.get("chunkId"))] = neighbor

    return list(result.values())


class NeighborChunkService:
    def __init__(self, db: DatabaseModel) -> None:
        self.db = db

    def expand(self, chunks: list[SearchResult], window: int = 1) -> list[SearchResult]:
        width = max(0, int(window))
        if width == 0 or not chunks:
            return chunks

        by_doc: dict[str, list[tuple[int, int]]] = {}
        for chunk in chunks:
            start = max(0, chunk.chunk_index - width)
            end = chunk.chunk_index + width
            by_doc.setdefault(chunk.document_id, []).append((start, end))

        merged_ranges: list[dict[str, int | str]] = []
        for document_id, ranges in by_doc.items():
            ranges.sort(key=lambda item: item[0])
            current_start, current_end = ranges[0]

            for next_start, next_end in ranges[1:]:
                if next_start <= current_end + 1:
                    current_end = max(current_end, next_end)
                else:
                    merged_ranges.append(
                        {
                            "document_id": document_id,
                            "start_index": current_start,
                            "end_index": current_end,
                        }
                    )
                    current_start, current_end = next_start, next_end

            merged_ranges.append(
                {
                    "document_id": document_id,
                    "start_index": current_start,
                    "end_index": current_end,
                }
            )

        try:
            neighbors = self.db.get_chunks_in_ranges(merged_ranges)
        except Exception as exc:
            message = str(exc).lower()
            if "index required" in message or "payload index" in message:
                return chunks
            raise

        merged: dict[str, SearchResult] = {item.chunk_id: item for item in neighbors}
        for chunk in chunks:
            existing = merged.get(chunk.chunk_id)
            if existing:
                existing.similarity = max(existing.similarity, chunk.similarity)
            else:
                merged[chunk.chunk_id] = chunk

        doc_score: dict[str, float] = {}
        for chunk in chunks:
            doc_score[chunk.document_id] = max(doc_score.get(chunk.document_id, 0.0), chunk.similarity)

        docs = sorted({item.document_id for item in merged.values()}, key=lambda doc: doc_score.get(doc, 0.0), reverse=True)

        by_doc_chunks: dict[str, list[SearchResult]] = {}
        for item in merged.values():
            by_doc_chunks.setdefault(item.document_id, []).append(item)

        output: list[SearchResult] = []
        for document_id in docs:
            values = by_doc_chunks.get(document_id, [])
            values.sort(key=lambda item: item.chunk_index)
            output.extend(values)

        return output
