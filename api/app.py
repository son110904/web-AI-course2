from __future__ import annotations

import os
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

load_dotenv()

app = FastAPI(title="Courses AI API")

# CORS – đọc từ env, mặc định cho phép tất cả
_raw_origins = os.getenv("CORS_ORIGIN") or "*"
_cors_origins = [o.strip() for o in _raw_origins.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ──────────────────────────────────────────────
# Lazy service initialization (tránh cold-start nặng)
# ──────────────────────────────────────────────
_rag_service = None


def _get_rag_service():
    global _rag_service
    if _rag_service is not None:
        return _rag_service

    qdrant_url = os.getenv("QDRANT_URL")
    qdrant_collection = os.getenv("QDRANT_COLLECTION")
    openai_api_key = os.getenv("OPENAI_API_KEY")

    missing = [k for k, v in {
        "QDRANT_URL": qdrant_url,
        "QDRANT_COLLECTION": qdrant_collection,
        "OPENAI_API_KEY": openai_api_key,
    }.items() if not v]
    if missing:
        raise RuntimeError(f"Thiếu biến môi trường: {', '.join(missing)}")

    from backend.models.database import DatabaseModel
    from backend.services.embedding_service import EmbeddingService
    from backend.services.rag_service import RAGService

    db = DatabaseModel(
        qdrant_url=str(qdrant_url),
        collection=str(qdrant_collection),
        qdrant_api_key=os.getenv("QDRANT_API_KEY"),
        vector_dim=int(os.getenv("VECTOR_DIM") or 1536),
        vector_name=os.getenv("QDRANT_VECTOR_NAME") or None,
        ensure_indexes=False,  # tắt khi chạy serverless để tránh timeout
    )
    db.initialize()

    embedding_service = EmbeddingService(
        openai_api_key=str(openai_api_key),
        openai_embedding_model=os.getenv("OPENAI_EMBEDDING_MODEL") or "text-embedding-3-small",
        openai_base_url=os.getenv("OPENAI_BASE_URL") or None,
        openai_timeout_ms=int(os.getenv("OPENAI_TIMEOUT_MS") or 30000),
    )

    _rag_service = RAGService(
        db=db,
        embedding_service=embedding_service,
        openai_api_key=str(openai_api_key),
        openai_chat_model=os.getenv("OPENAI_CHAT_MODEL") or "gpt-4o-mini",
        openai_base_url=os.getenv("OPENAI_BASE_URL") or None,
        openai_timeout_ms=int(os.getenv("OPENAI_TIMEOUT_MS") or 30000),
    )
    return _rag_service


# ──────────────────────────────────────────────
# Schemas
# ──────────────────────────────────────────────
class MessageItem(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: list[dict[str, Any]]


# ──────────────────────────────────────────────
# Routes
# ──────────────────────────────────────────────
@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.post("/api/chat")
def chat(body: ChatRequest):
    from backend.controllers.chat_controller import ChatController

    try:
        rag_service = _get_rag_service()
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    controller = ChatController(rag_service)
    result, status_code = controller.chat(body.model_dump())

    if status_code >= 400:
        raise HTTPException(status_code=status_code, detail=result)
    return result
