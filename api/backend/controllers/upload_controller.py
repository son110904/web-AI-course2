from __future__ import annotations

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

            chunks = self.document_service.chunk_text(text)
            for index, chunk_text in enumerate(chunks):
                if not chunk_text:
                    continue

                embedding = self.embedding_service.generate_embedding(chunk_text)
                self.db.insert_chunk(
                    document_id=document_id,
                    content=chunk_text,
                    chunk_index=index,
                    embedding=embedding,
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
