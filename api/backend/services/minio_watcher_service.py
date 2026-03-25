from __future__ import annotations

import os
import time
from typing import Any

from backend.models.database import DatabaseModel
from backend.models.minio_model import MinIOModel
from backend.services.document_service import DocumentService
from backend.services.embedding_service import EmbeddingService


class MinIOWatcherService:
    def __init__(
        self,
        *,
        minio: MinIOModel,
        document_service: DocumentService,
        embedding_service: EmbeddingService,
        db: DatabaseModel,
        interval_seconds: int = 300,
    ) -> None:
        self.minio = minio
        self.document_service = document_service
        self.embedding_service = embedding_service
        self.db = db
        self.interval_seconds = interval_seconds
        self.known_files: set[str] = set()
        self.running = False
        self.folders = ["curriculum", "career description", "syllabus"]

    def start(self) -> None:
        self.running = True
        self.load_existing_files()
        while self.running:
            self.check_new_files()
            time.sleep(self.interval_seconds)

    def stop(self) -> None:
        self.running = False

    def load_existing_files(self) -> None:
        for folder in self.folders:
            prefix = f"rag-processed/{folder}/"
            files = self.minio.list_files(prefix)
            for file_name in files:
                if file_name.endswith(".docx") and not file_name.split("/")[-1].startswith("~$"):
                    self.known_files.add(file_name)

    def check_new_files(self) -> None:
        new_files: list[str] = []
        for folder in self.folders:
            prefix = f"rag-processed/{folder}/"
            for file_name in self.minio.list_files(prefix):
                if not file_name.endswith(".docx"):
                    continue
                if file_name.split("/")[-1].startswith("~$"):
                    continue
                if file_name not in self.known_files:
                    self.known_files.add(file_name)
                    new_files.append(file_name)

        if new_files:
            self.ingest_files(new_files)

    def ingest_files(self, files: list[str]) -> None:
        ingest_batch_size = max(1, int(os.getenv("INGEST_BATCH_SIZE") or 32))
        for object_name in files:
            try:
                buffer = self.minio.get_file(object_name)
                text = self.document_service.extract_text(buffer, object_name).strip()
                if len(text) < 200:
                    continue

                metadata = self.document_service.parse_metadata_from_path(object_name)
                document_id = self.db.insert_document(
                    filename=object_name.split("/")[-1],
                    file_path=object_name,
                    file_size=len(buffer),
                    content_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                    document_type=str(metadata.get("document_type") or "syllabus"),
                    metadata=metadata,
                )

                chunks = [chunk.strip() for chunk in self.document_service.chunk_text(text) if chunk.strip()]
                for start in range(0, len(chunks), ingest_batch_size):
                    chunk_batch = chunks[start : start + ingest_batch_size]
                    embedding_batch = self.embedding_service.generate_batch_embeddings(chunk_batch)
                    self.db.insert_chunks_batch(
                        document_id=document_id,
                        chunks=chunk_batch,
                        embeddings=embedding_batch,
                        start_index=start,
                    )
            except Exception:
                self.known_files.discard(object_name)

    def sync_with_database(self) -> None:
        db_files = set(self.db.get_all_document_paths())
        missing_files = [file_name for file_name in self.known_files if file_name not in db_files]
        if missing_files:
            self.ingest_files(missing_files)
