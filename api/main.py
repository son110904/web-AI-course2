from __future__ import annotations

import os
import sys

from dotenv import load_dotenv

load_dotenv()


# ──────────────────────────────────────────────
# Khởi tạo services
# ──────────────────────────────────────────────

def build_services():
    qdrant_url        = os.getenv("QDRANT_URL")
    qdrant_collection = os.getenv("QDRANT_COLLECTION")
    openai_api_key    = os.getenv("OPENAI_API_KEY")

    if not qdrant_url:
        sys.exit("❌  Thiếu biến môi trường: QDRANT_URL")
    if not qdrant_collection:
        sys.exit("❌  Thiếu biến môi trường: QDRANT_COLLECTION")
    if not openai_api_key:
        sys.exit("❌  Thiếu biến môi trường: OPENAI_API_KEY")

    from backend.models.database import DatabaseModel
    from backend.services.embedding_service import EmbeddingService
    from backend.services.rag_service import RAGService

    db = DatabaseModel(
        qdrant_url=qdrant_url,
        collection=qdrant_collection,
        qdrant_api_key=os.getenv("QDRANT_API_KEY"),
        vector_dim=int(os.getenv("VECTOR_DIM") or 1536),
        vector_name=os.getenv("QDRANT_VECTOR_NAME") or None,
        ensure_indexes=(os.getenv("QDRANT_ENSURE_INDEXES") or "false").lower() == "true",
    )
    db.initialize()

    embedding_service = EmbeddingService(
        openai_api_key=openai_api_key,
        openai_embedding_model=os.getenv("OPENAI_EMBEDDING_MODEL") or "text-embedding-3-small",
        openai_base_url=os.getenv("OPENAI_BASE_URL") or None,
        openai_timeout_ms=int(os.getenv("OPENAI_TIMEOUT_MS") or 60000),
    )
    embedding_service.initialize()

    rag_service = RAGService(
        db=db,
        embedding_service=embedding_service,
        openai_api_key=openai_api_key,
        openai_chat_model=os.getenv("OPENAI_CHAT_MODEL") or "gpt-4o-mini",
        openai_base_url=os.getenv("OPENAI_BASE_URL") or None,
        openai_timeout_ms=int(os.getenv("OPENAI_TIMEOUT_MS") or 60000),
    )

    return db, embedding_service, rag_service


# ──────────────────────────────────────────────
# INGEST: MinIO (rag-processed) → extract → chunk → embed → Qdrant
# ──────────────────────────────────────────────

def extract_text_from_file(document_service, buffer: bytes, filename: str) -> str:
    """
    DocumentService hỗ trợ: .docx .pdf .txt .xlsx
    Thêm xử lý .json và .md trực tiếp ở đây.
    """
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""

    if ext in {"json", "md", "txt", "text"}:
        return document_service.clean_text(buffer.decode("utf-8", errors="ignore"))

    # Các loại còn lại (.docx, .pdf, .xlsx) giao cho DocumentService
    return document_service.extract_text(buffer, filename)


def run_ingest(db, embedding_service):
    minio_endpoint      = os.getenv("MINIO_ENDPOINT")
    minio_port          = os.getenv("MINIO_PORT")
    minio_access_key    = os.getenv("MINIO_ACCESS_KEY")
    minio_secret_key    = os.getenv("MINIO_SECRET_KEY")
    minio_bucket        = os.getenv("MINIO_BUCKET_NAME")
    minio_processed_prefix = os.getenv("MINIO_PROCESSED_PREFIX") or "rag-processed"

    if not all([minio_endpoint, minio_port, minio_access_key, minio_secret_key, minio_bucket]):
        print("⚠️  Không tìm thấy đủ cấu hình MinIO trong .env → bỏ qua bước ingest.")
        return

    from backend.models.minio_model import MinIOModel
    from backend.services.document_service import DocumentService

    minio = MinIOModel(
        endpoint=str(minio_endpoint),
        port=int(minio_port),
        access_key=str(minio_access_key),
        secret_key=str(minio_secret_key),
        bucket=str(minio_bucket),
        use_ssl=(os.getenv("MINIO_USE_SSL") or "false").lower() == "true",
    )
    document_service = DocumentService()

    print("\n" + "═" * 55)
    print(f"📥  Bắt đầu ingest từ MinIO")
    print(f"    Endpoint : {minio_endpoint}:{minio_port}")
    print(f"    Bucket   : {minio_bucket}")
    print(f"    Prefix   : {minio_processed_prefix}/")
    print("═" * 55)

    # List toàn bộ file dưới rag-processed/
    try:
        all_files = minio.list_files(minio_processed_prefix + "/")
    except Exception as e:
        print(f"❌  Không kết nối được MinIO: {e}")
        return

    # Hỗ trợ: .docx .pdf .xlsx .txt .json .md
    SUPPORTED_EXTS = {".docx", ".pdf", ".xlsx", ".txt", ".json", ".md"}
    files = [
        f for f in all_files
        if not f.endswith("/") and any(f.lower().endswith(ext) for ext in SUPPORTED_EXTS)
    ]

    if not files:
        print(f"⚠️  Không tìm thấy file nào dưới '{minio_processed_prefix}/'")
        return

    print(f"📂  Tìm thấy {len(files)} file cần xử lý\n")

    total_chunks = 0
    errors = []

    for i, object_name in enumerate(files, 1):
        filename = object_name.split("/")[-1]
        print(f"  [{i}/{len(files)}] {filename}", end=" ... ", flush=True)

        try:
            # 1. Lấy file từ MinIO
            buffer = minio.get_file(object_name)

            # 2. Extract + clean text
            text = extract_text_from_file(document_service, buffer, filename)
            if not text:
                print("⚠️  Bỏ qua (không đọc được nội dung)")
                continue

            # 3. Parse metadata từ đường dẫn file
            metadata = document_service.parse_metadata_from_path(object_name, text)

            # 4. Lưu document record vào Qdrant
            document_id = db.insert_document(
                filename=filename,
                file_path=object_name,
                file_size=len(buffer),
                content_type="application/octet-stream",
                document_type=str(metadata.get("document_type") or "syllabus"),
                metadata=metadata,
            )

            # 5. Chunk → embed → đẩy từng chunk lên Qdrant
            chunks = document_service.chunk_text(text)
            for idx, chunk in enumerate(chunks):
                embedding = embedding_service.generate_embedding(chunk)
                db.insert_chunk(
                    document_id=document_id,
                    content=chunk,
                    chunk_index=idx,
                    embedding=embedding,
                )
                total_chunks += 1

            print(f"✅  {len(chunks)} chunks")

        except Exception as e:
            errors.append(f"{object_name}: {e}")
            print(f"❌  Lỗi: {e}")

    print("\n" + "═" * 55)
    print(f"✅  Ingest hoàn thành!")
    print(f"    📄  Files xử lý được : {len(files) - len(errors)}/{len(files)}")
    print(f"    🧩  Chunks đã embed  : {total_chunks}")
    if errors:
        print(f"    ⚠️   Lỗi ({len(errors)}):")
        for err in errors:
            print(f"         • {err}")
    print("═" * 55)


# ──────────────────────────────────────────────
# CHAT: hỏi đáp trên terminal
# ──────────────────────────────────────────────

def run_chat(rag_service):
    from backend.models.database import ChatMessage
    from backend.services.query_expansion_service import expand_query

    print("\n" + "═" * 55)
    print("💬  Chế độ hỏi đáp  (gõ 'exit' để thoát)")
    print("═" * 55)

    history: list[ChatMessage] = []

    while True:
        try:
            question = input("\nBạn: ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\n👋  Thoát.")
            break

        if not question:
            continue
        if question.lower() in {"exit", "quit", "thoat"}:
            print("👋  Thoát.")
            break

        history.append(ChatMessage(role="user", content=question))
        expanded = expand_query(question)

        try:
            answer = rag_service.chat(history, expanded)
        except Exception as e:
            answer = f"❌  Lỗi: {e}"

        history.append(ChatMessage(role="assistant", content=answer))
        print(f"\nBot: {answer}")


# ──────────────────────────────────────────────
# MAIN
# ──────────────────────────────────────────────

if __name__ == "__main__":
    print("🚀  Khởi động hệ thống...")

    db, embedding_service, rag_service = build_services()
    print("✅  Kết nối Qdrant và OpenAI thành công.")

    # Kiểm tra dữ liệu hiện có trong Qdrant
    try:
        stats        = db.get_ingest_stats()
        total_chunks = stats.get("totalChunks", 0)
        total_docs   = stats.get("totalDocuments", 0)
    except Exception:
        total_chunks = 0
        total_docs   = 0

    print(f"📊  Qdrant hiện có: {total_docs} documents, {total_chunks} chunks")

    if total_chunks == 0:
        print("\n⚠️  Chưa có dữ liệu trong Qdrant.")
        ans = input("▶  Chạy ingest từ MinIO ngay bây giờ? (y/n): ").strip().lower()
    else:
        ans = input("\n▶  Chạy lại ingest từ MinIO? (y/n): ").strip().lower()

    if ans == "y":
        run_ingest(db, embedding_service)

    run_chat(rag_service)