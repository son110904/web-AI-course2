from __future__ import annotations

import os
from typing import Any

from backend.models.database import DatabaseModel
from backend.models.minio_model import MinIOModel
from backend.services.document_service import DocumentService
from backend.services.embedding_service import EmbeddingService


class UploadController:
    def __init__(
        self,
        *,
        db: DatabaseModel,
        minio: MinIOModel,
        document_service: DocumentService,
        embedding_service: EmbeddingService,
    ) -> None:
        self.db = db
        self.minio = minio
        self.document_service = document_service
        self.embedding_service = embedding_service

    def ingest_from_minio(self, payload: dict[str, Any]) -> tuple[dict[str, Any], int]:
        object_name = payload.get("objectName")
        if not object_name:
            return {"error": "Missing objectName"}, 400
        ingest_batch_size = max(1, int(os.getenv("INGEST_BATCH_SIZE") or 32))

        try:
            file_buffer = self.minio.get_file(str(object_name))
            raw_text = self.document_service.extract_text(file_buffer, str(object_name))
            text = self.document_service.clean_text(raw_text)

            if not text:
                return {"error": "No extractable text in file"}, 400

            metadata = self.document_service.parse_metadata_from_path(str(object_name), text)

            document_id = self.db.insert_document(
                filename=str(object_name),
                file_path=str(object_name),
                file_size=len(file_buffer),
                content_type="unknown",
                document_type=str(metadata.get("document_type") or "syllabus"),
                metadata=metadata,
            )

            chunks = [chunk for chunk in self.document_service.chunk_text(text) if chunk]
            for start in range(0, len(chunks), ingest_batch_size):
                chunk_batch = chunks[start : start + ingest_batch_size]
                embedding_batch = self.embedding_service.generate_batch_embeddings(chunk_batch)
                self.db.insert_chunks_batch(
                    document_id=document_id,
                    chunks=chunk_batch,
                    embeddings=embedding_batch,
                    start_index=start,
                )

            return {
                "message": "Ingest completed",
                "documentId": document_id,
                "totalChunks": len(chunks),
            }, 200
        except Exception as exc:
            return {"error": str(exc)}, 500

    def list_minio_files(self, prefix: str = "") -> tuple[dict[str, Any], int]:
        try:
            files = self.minio.list_files(prefix)
            return {"files": files, "total": len(files)}, 200
        except Exception as exc:
            return {"error": str(exc)}, 500

    def check_upload_status(self) -> tuple[dict[str, Any], int]:
        try:
            stats = self.db.get_ingest_stats()
            return {
                "summary": {
                    "totalDocuments": int(stats.get("totalDocuments") or 0),
                    "totalChunks": int(stats.get("totalChunks") or 0),
                    "totalSize": 0,
                },
                "documents": stats.get("documents") or [],
            }, 200
        except Exception as exc:
            return {"error": str(exc)}, 500
