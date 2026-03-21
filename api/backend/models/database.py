from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any

import requests


DEFAULT_VECTOR_DIM = 1536


@dataclass
class ChatMessage:
    role: str
    content: str


@dataclass
class SearchResult:
    chunk_id: str
    document_id: str
    content: str
    similarity: float
    chunk_index: int
    document_type: str
    metadata: dict[str, Any]


class DatabaseModel:
    def __init__(
        self,
        *,
        qdrant_url: str,
        collection: str,
        qdrant_api_key: str | None = None,
        vector_dim: int | None = None,
        vector_name: str | None = None,
        ensure_indexes: bool = False,
    ) -> None:
        self.qdrant_url = str(qdrant_url or "").strip().rstrip("/")
        self.collection = str(collection or "").strip()
        self.qdrant_api_key = qdrant_api_key
        self.vector_dim = int(vector_dim or DEFAULT_VECTOR_DIM)
        self.vector_name = str(vector_name or "").strip() or None
        self.ensure_indexes = ensure_indexes
        self.documents_by_id: dict[str, dict[str, Any]] = {}

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.qdrant_api_key:
            headers["api-key"] = self.qdrant_api_key
        return headers

    def _qdrant(self, method: str, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        response = requests.request(
            method=method,
            url=f"{self.qdrant_url}{path}",
            json=payload,
            headers=self._headers(),
            timeout=60,
        )

        text = response.text
        data: dict[str, Any] = {}
        if text:
            try:
                data = response.json()
            except Exception:
                data = {}

        if not response.ok:
            err = (
                data.get("status", {}).get("error")
                or data.get("message")
                or data.get("result", {}).get("error")
                or text
                or response.reason
            )
            raise RuntimeError(f"Qdrant error ({response.status_code}) {path}: {err}")

        return data

    def initialize(self) -> None:
        if not self.qdrant_url:
            raise RuntimeError("Missing required config: QDRANT_URL")
        if not self.collection:
            raise RuntimeError("Missing required config: QDRANT_COLLECTION")

        self._qdrant("GET", f"/collections/{self.collection}")

        if self.ensure_indexes:
            # Recommended payload indexes for RAG filtering/hybrid search.
            self._ensure_payload_index("doc_type", "keyword")
            self._ensure_payload_index("section", "keyword")
            self._ensure_payload_index("course_code", "keyword")
            self._ensure_payload_index("career_name_en", "keyword")
            self._ensure_payload_index("text", "text")

    def _ensure_payload_index(self, field_name: str, field_schema: str) -> None:
        try:
            self._qdrant(
                "PUT",
                f"/collections/{self.collection}/index?wait=true",
                {"field_name": field_name, "field_schema": field_schema},
            )
        except Exception as exc:
            message = str(exc).lower()
            if any(x in message for x in ["already exists", "conflict", "unsupported", "unimplemented"]):
                return
            raise

    def insert_document(
        self,
        *,
        filename: str,
        file_path: str,
        file_size: int,
        content_type: str,
        document_type: str,
        metadata: dict[str, Any],
    ) -> str:
        document_id = str(uuid.uuid4())
        metadata = metadata or {}
        doc_type = str(metadata.get("doc_type") or document_type or "")
        course_code = metadata.get("course_code") or metadata.get("subject_code")
        payload = {
            "record_type": "document",
            "document_id": document_id,
            "filename": filename,
            "file_path": file_path,
            "file_size": file_size,
            "content_type": content_type,
            "doc_type": doc_type,
            "document_type": document_type,
            "section": metadata.get("section"),
            "course_code": course_code,
            "career_name_en": metadata.get("career_name_en"),
            "metadata": metadata,
            "uploaded_at": __import__("datetime").datetime.utcnow().isoformat(),
        }

        vector = [0.0] * self.vector_dim
        point = {
            "id": document_id,
            "vector": {self.vector_name: vector} if self.vector_name else vector,
            "payload": payload,
        }

        self._qdrant(
            "PUT",
            f"/collections/{self.collection}/points?wait=true",
            {"points": [point]},
        )

        self.documents_by_id[document_id] = {
            "doc_type": doc_type,
            "document_type": document_type,
            "metadata": metadata,
            "filename": filename,
            "file_path": file_path,
        }
        return document_id

    def insert_chunk(
        self,
        *,
        document_id: str,
        content: str,
        chunk_index: int,
        embedding: list[float],
    ) -> None:
        if len(embedding) != self.vector_dim:
            raise RuntimeError(f"Embedding dimension mismatch: {len(embedding)}")

        chunk_id = str(uuid.uuid4())
        doc = self.documents_by_id.get(document_id, {})
        metadata = doc.get("metadata", {}) if isinstance(doc.get("metadata"), dict) else {}
        doc_type = metadata.get("doc_type") or doc.get("doc_type") or doc.get("document_type")
        course_code = metadata.get("course_code") or metadata.get("subject_code")
        payload = {
            "record_type": "chunk",
            "document_id": document_id,
            "text": content,
            "content": content,
            "chunk_index": int(chunk_index),
            "doc_type": doc_type,
            "document_type": doc.get("document_type"),
            "section": metadata.get("section"),
            "course_code": course_code,
            "career_name_en": metadata.get("career_name_en"),
            "metadata": metadata,
            "source_file": doc.get("file_path"),
        }

        point = {
            "id": chunk_id,
            "vector": {self.vector_name: embedding} if self.vector_name else embedding,
            "payload": payload,
        }

        self._qdrant(
            "PUT",
            f"/collections/{self.collection}/points?wait=true",
            {"points": [point]},
        )

    def search_similar_chunks(
        self,
        query_embedding: list[float],
        limit: int = 5,
        filters: dict[str, Any] | None = None,
    ) -> list[SearchResult]:
        if len(query_embedding) != self.vector_dim:
            raise RuntimeError(f"Query embedding dimension mismatch: {len(query_embedding)}")

        raw_limit = max(limit * 5, 25)
        vector_payload: Any = (
            {"name": self.vector_name, "vector": query_embedding}
            if self.vector_name
            else query_embedding
        )
        query_filter = self._build_search_filter(filters or {})

        search_body: dict[str, Any] = {
            "vector": vector_payload,
            "limit": raw_limit,
            "with_payload": True,
        }
        if query_filter:
            search_body["filter"] = query_filter

        response = self._qdrant(
            "POST",
            f"/collections/{self.collection}/points/search",
            search_body,
        )

        points = response.get("result") or []
        results = [self._to_search_result(point) for point in points]
        results = [item for item in results if item.content]

        filters = filters or {}

        doc_type = filters.get("doc_type") or filters.get("document_type")
        if doc_type:
            results = [
                item
                for item in results
                if item.document_type == doc_type
                or item.metadata.get("doc_type") == doc_type
                or item.metadata.get("document_type") == doc_type
            ]

        section = filters.get("section")
        if section:
            results = [
                item
                for item in results
                if str(item.metadata.get("section", "")) == str(section)
            ]

        metadata_filters = filters.get("metadata_filters") or {}
        for key, value in metadata_filters.items():
            if key == "subject_code":
                key = "course_code"
            elif key == "document_type":
                key = "doc_type"
            if key == "subject_name":
                needle = str(value or "").lower()
                results = [
                    item
                    for item in results
                    if needle in str(item.metadata.get("subject_name") or "").lower()
                ]
            else:
                results = [
                    item
                    for item in results
                    if str(item.metadata.get(key, "")) == str(value)
                ]

        return results[:limit]

    def _build_search_filter(self, filters: dict[str, Any]) -> dict[str, Any] | None:
        must: list[dict[str, Any]] = []

        doc_type = filters.get("doc_type") or filters.get("document_type")
        if doc_type:
            must.append({"key": "doc_type", "match": {"value": doc_type}})

        section = filters.get("section")
        if section:
            must.append({"key": "section", "match": {"value": section}})

        metadata_filters = filters.get("metadata_filters") or {}
        for key, value in metadata_filters.items():
            if value is None or value == "":
                continue

            if key == "subject_code":
                key = "course_code"
            elif key == "document_type":
                key = "doc_type"

            if key in {"doc_type", "section", "course_code", "career_name_en"}:
                must.append({"key": key, "match": {"value": value}})

        if not must:
            return None
        return {"must": must}

    def search_by_instructor(self, instructor_name: str, options: dict[str, Any] | None = None) -> list[SearchResult]:
        _ = instructor_name
        _ = options
        return []

    def search_by_instructor_two_pass(self, instructor_name: str, options: dict[str, Any] | None = None) -> list[SearchResult]:
        _ = instructor_name
        _ = options
        return []

    def get_chunks_in_ranges(self, ranges: list[dict[str, int | str]]) -> list[SearchResult]:
        if not ranges:
            return []

        output: list[SearchResult] = []
        doc_keys = ["minio_path", "document_id", "docId", "doc_id", "file_path", "file_name"]
        idx_keys = ["chunk_index", "order"]

        for item in ranges:
            document_id = str(item["document_id"])
            start_index = int(item["start_index"])
            end_index = int(item["end_index"])
            limit = max(256, (end_index - start_index + 1) * 2)

            points: list[dict[str, Any]] = []
            for doc_key in doc_keys:
                for idx_key in idx_keys:
                    body = {
                        "filter": {
                            "must": [
                                {"key": doc_key, "match": {"value": document_id}},
                                {"key": idx_key, "range": {"gte": start_index, "lte": end_index}},
                            ]
                        },
                        "limit": limit,
                        "with_payload": True,
                    }
                    response = self._qdrant(
                        "POST",
                        f"/collections/{self.collection}/points/scroll",
                        body,
                    )
                    points = (response.get("result") or {}).get("points") or []
                    if points:
                        break
                if points:
                    break

            for point in points:
                output.append(self._to_search_result(point))

        output.sort(key=lambda x: (x.document_id, x.chunk_index))
        return output

    def get_ingest_stats(self) -> dict[str, Any]:
        try:
            total_chunks = self._count_by_filter({"must": [{"key": "record_type", "match": {"value": "chunk"}}]})
        except Exception as exc:
            if self._is_missing_index_error(exc):
                total_chunks = self._count_by_field_value_no_index("record_type", "chunk")
            else:
                raise

        try:
            total_documents = self._count_by_filter(
                {"must": [{"key": "record_type", "match": {"value": "document"}}]}
            )
        except Exception as exc:
            if self._is_missing_index_error(exc):
                total_documents = self._count_by_field_value_no_index("record_type", "document")
            else:
                raise

        if total_chunks == 0 and total_documents == 0:
            fallback = self._qdrant(
                "POST",
                f"/collections/{self.collection}/points/count",
                {"exact": True},
            )
            total_chunks = int((fallback.get("result") or {}).get("count") or 0)

        return {
            "totalDocuments": total_documents,
            "totalChunks": total_chunks,
            "byType": [],
            "documents": [],
        }

    def _count_by_filter(self, payload_filter: dict[str, Any]) -> int:
        response = self._qdrant(
            "POST",
            f"/collections/{self.collection}/points/count",
            {"filter": payload_filter, "exact": True},
        )
        return int((response.get("result") or {}).get("count") or 0)

    def _is_missing_index_error(self, exc: Exception) -> bool:
        message = str(exc).lower()
        return "index required but not found" in message

    def _count_by_field_value_no_index(self, key: str, expected_value: str) -> int:
        total = 0
        next_offset: Any = None

        while True:
            payload: dict[str, Any] = {"limit": 1000, "with_payload": [key]}
            if next_offset is not None:
                payload["offset"] = next_offset

            response = self._qdrant(
                "POST",
                f"/collections/{self.collection}/points/scroll",
                payload,
            )
            result = response.get("result") or {}
            points = result.get("points") or []

            for point in points:
                value = (point.get("payload") or {}).get(key)
                if str(value) == expected_value:
                    total += 1

            next_offset = result.get("next_page_offset")
            if not next_offset or not points:
                break

        return total

    def get_all_document_paths(self) -> list[str]:
        response = self._qdrant(
            "POST",
            f"/collections/{self.collection}/points/scroll",
            {
                "limit": 10_000,
                "with_payload": ["minio_path", "file_path", "file_name"],
            },
        )

        points = (response.get("result") or {}).get("points") or []
        paths: list[str] = []
        for point in points:
            payload = point.get("payload") or {}
            path = payload.get("minio_path") or payload.get("file_path") or payload.get("file_name")
            if isinstance(path, str) and path:
                paths.append(path)

        return sorted(set(paths))

    def clear_all(self) -> None:
        self._qdrant(
            "POST",
            f"/collections/{self.collection}/points/delete?wait=true",
            {"filter": {"must": [{"key": "record_type", "match": {"value": "chunk"}}]}},
        )
        self._qdrant(
            "POST",
            f"/collections/{self.collection}/points/delete?wait=true",
            {"filter": {"must": [{"key": "record_type", "match": {"value": "document"}}]}},
        )

    def _to_search_result(self, point: dict[str, Any]) -> SearchResult:
        payload = point.get("payload") or {}
        metadata = self._pick_metadata(payload)

        return SearchResult(
            chunk_id=str(point.get("id") or ""),
            document_id=str(
                payload.get("document_id")
                or payload.get("docId")
                or payload.get("doc_id")
                or payload.get("minio_path")
                or payload.get("file_path")
                or metadata.get("document_id")
                or metadata.get("source_file")
                or ""
            ),
            content=str(payload.get("text") or payload.get("content") or payload.get("page_content") or ""),
            similarity=float(point.get("score") or 0.0),
            chunk_index=int(payload.get("chunk_index") or payload.get("chunkIndex") or payload.get("order") or 0),
            document_type=str(
                payload.get("doc_type")
                or payload.get("folder_type")
                or payload.get("document_type")
                or metadata.get("doc_type")
                or metadata.get("document_type")
                or ""
            ),
            metadata=metadata,
        )

    def _pick_metadata(self, payload: dict[str, Any]) -> dict[str, Any]:
        meta = payload.get("metadata")
        if isinstance(meta, dict):
            return meta

        folder_type = payload.get("doc_type") or payload.get("folder_type") or payload.get("document_type")
        source_file = (
            payload.get("minio_path")
            or payload.get("file_path")
            or payload.get("source_file")
            or payload.get("file_name")
        )

        derived: dict[str, Any] = {}
        if folder_type is not None:
            derived["doc_type"] = folder_type
            derived["document_type"] = folder_type
        if source_file is not None:
            derived["source_file"] = source_file

        passthrough_keys = [
            "file_name",
            "chunk_name",
            "chunk_index",
            "total_chunks",
            "text_length",
            "bucket_source",
            "path_prefix",
            "doc_type",
            "section",
            "course_code",
            "career_name_en",
            "folder_type",
            "minio_path",
            "created_at",
        ]

        for key in passthrough_keys:
            if key in payload and key not in derived:
                derived[key] = payload[key]

        return derived
