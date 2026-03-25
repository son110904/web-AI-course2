from __future__ import annotations

import os
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

    def ingest_all(self, force: bool = False) -> tuple[dict[str, Any], int]:
        base_prefix = (os.getenv("MINIO_BASE_PREFIX") or "rag-processed").strip("/ ")
        ingest_batch_size = max(1, int(os.getenv("INGEST_BATCH_SIZE") or 32))
        folders = [
            "curriculum",
            "career",
            "career_description",
            "career-description",
            "career description",
            "regulation",
            "syllabus",
        ]
        supported_extensions = {".docx", ".pdf", ".txt", ".text", ".xlsx", ".xls"}

        candidate_files: set[str] = set()
        scanned_files = 0
        ingested_files = 0
        skipped_existing = 0
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
                    scanned_files += 1
                    if object_name.endswith("/") or object_name.split("/")[-1].startswith("~$"):
                        continue
                    ext = f".{object_name.rsplit('.', 1)[-1].lower()}" if "." in object_name else ""
                    if ext not in supported_extensions:
                        continue
                    candidate_files.add(object_name)

            existing_paths: set[str] = set()
            if not force:
                try:
                    existing_paths = set(self.db.get_all_document_paths())
                except Exception as exc:
                    errors.append(f"Error loading existing document paths: {exc}")

            for object_name in sorted(candidate_files):
                if not force and object_name in existing_paths:
                    skipped_existing += 1
                    continue

                try:
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
                        content_type="application/octet-stream",
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
                        total_chunks += len(chunk_batch)
                    ingested_files += 1
                except Exception as exc:
                    errors.append(f"Error processing {object_name}: {exc}")

            return {
                "message": "Ingest completed",
                "basePrefix": base_prefix,
                "scannedFiles": scanned_files,
                "candidateFiles": len(candidate_files),
                "ingestedFiles": ingested_files,
                "skippedExisting": skipped_existing,
                "totalChunks": total_chunks,
                "errors": errors if errors else None,
                "folders": folders,
                "force": force,
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
