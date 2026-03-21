from __future__ import annotations

from typing import Any

from backend.models.database import DatabaseModel
from backend.models.minio_model import MinIOModel
from backend.services.document_service import DocumentService
from backend.services.embedding_service import EmbeddingService


class IngestController:
    def __init__(
        self,
        *,
        minio: MinIOModel,
        document_service: DocumentService,
        embedding_service: EmbeddingService,
        db: DatabaseModel,
    ) -> None:
        self.minio = minio
        self.document_service = document_service
        self.embedding_service = embedding_service
        self.db = db

    def ingest_all(self) -> tuple[dict[str, Any], int]:
        base_prefix = "courses-chatbot"
        folders = ["curriculum", "career description", "syllabus"]

        total_files = 0
        total_chunks = 0
        errors: list[str] = []

        try:
            for folder in folders:
                prefix = f"{base_prefix}/{folder}/"
                try:
                    files = self.minio.list_files(prefix)
                except Exception as exc:
                    errors.append(f"Error scanning folder {folder}: {exc}")
                    continue

                for object_name in files:
                    if object_name.endswith("/"):
                        continue
                    if not object_name.lower().endswith(".docx"):
                        continue

                    try:
                        total_files += 1
                        buffer = self.minio.get_file(object_name)
                        raw_text = self.document_service.extract_text(buffer, object_name)
                        text = self.document_service.clean_text(raw_text)
                        if not text:
                            continue

                        metadata = self.document_service.parse_metadata_from_path(object_name, text)
                        document_id = self.db.insert_document(
                            filename=object_name.split("/")[-1],
                            file_path=object_name,
                            file_size=len(buffer),
                            content_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                            document_type=str(metadata.get("document_type") or "syllabus"),
                            metadata=metadata,
                        )

                        chunks = self.document_service.chunk_text(text)
                        for index, chunk in enumerate(chunks):
                            embedding = self.embedding_service.generate_embedding(chunk)
                            self.db.insert_chunk(
                                document_id=document_id,
                                content=chunk,
                                chunk_index=index,
                                embedding=embedding,
                            )
                            total_chunks += 1
                    except Exception as exc:
                        errors.append(f"Error processing {object_name}: {exc}")

            return {
                "message": "Ingest completed",
                "totalFiles": total_files,
                "totalChunks": total_chunks,
                "errors": errors if errors else None,
                "folders": folders,
            }, 200
        except Exception as exc:
            return {"error": str(exc)}, 500

    def check_ingest_status(self) -> tuple[dict[str, Any], int]:
        try:
            return self.db.get_ingest_stats(), 200
        except Exception as exc:
            return {"error": str(exc)}, 500

    def clear_all(self) -> tuple[dict[str, Any], int]:
        try:
            self.db.clear_all()
            return {
                "message": "All indexed data cleared",
                "deletedChunks": None,
                "deletedDocuments": None,
            }, 200
        except Exception as exc:
            return {"error": str(exc)}, 500
