from __future__ import annotations

import os
from contextlib import asynccontextmanager
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

from backend.controllers.chat_controller import ChatController
from backend.controllers.ingest_controller import IngestController
from backend.controllers.upload_controller import UploadController
from backend.models.database import DatabaseModel
from backend.models.minio_model import MinIOModel
from backend.services.document_service import DocumentService
from backend.services.embedding_service import EmbeddingService
from backend.services.rag_service import RAGService


load_dotenv()


def _build_services() -> dict[str, Any]:
    qdrant_url = os.getenv("QDRANT_URL")
    qdrant_collection = os.getenv("QDRANT_COLLECTION")
    openai_api_key = os.getenv("OPENAI_API_KEY")

    if not qdrant_url:
        raise RuntimeError("Missing required env var: QDRANT_URL")
    if not qdrant_collection:
        raise RuntimeError("Missing required env var: QDRANT_COLLECTION")
    if not openai_api_key:
        raise RuntimeError("Missing required env var: OPENAI_API_KEY")

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
        openai_chat_model=os.getenv("OPENAI_CHAT_MODEL") or os.getenv("OPENAI_MODEL") or "gpt-4o-mini",
        openai_base_url=os.getenv("OPENAI_BASE_URL") or None,
        openai_timeout_ms=int(os.getenv("OPENAI_TIMEOUT_MS") or 60000),
    )

    chat_controller = ChatController(rag_service)
    document_service = DocumentService()

    services: dict[str, Any] = {
        "db": db,
        "embedding_service": embedding_service,
        "rag_service": rag_service,
        "chat_controller": chat_controller,
        "document_service": document_service,
    }

    minio_required = [
        os.getenv("MINIO_ENDPOINT"),
        os.getenv("MINIO_PORT"),
        os.getenv("MINIO_ACCESS_KEY"),
        os.getenv("MINIO_SECRET_KEY"),
        os.getenv("MINIO_BUCKET_NAME"),
    ]

    if all(minio_required):
        minio_model = MinIOModel(
            endpoint=str(os.getenv("MINIO_ENDPOINT")),
            port=int(os.getenv("MINIO_PORT") or 9000),
            access_key=str(os.getenv("MINIO_ACCESS_KEY")),
            secret_key=str(os.getenv("MINIO_SECRET_KEY")),
            bucket=str(os.getenv("MINIO_BUCKET_NAME")),
            use_ssl=(os.getenv("MINIO_USE_SSL") or "false").lower() == "true",
        )

        services["minio"] = minio_model
        services["upload_controller"] = UploadController(
            db=db,
            minio=minio_model,
            document_service=document_service,
            embedding_service=embedding_service,
        )
        services["ingest_controller"] = IngestController(
            minio=minio_model,
            document_service=document_service,
            embedding_service=embedding_service,
            db=db,
        )

    return services


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.services = _build_services()
    yield


app = FastAPI(title="Chatbot API (Python)", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[os.getenv("CORS_ORIGIN") or "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def request_logger(request: Request, call_next):
    print(f"{request.method} {request.url.path}")
    return await call_next(request)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/demo_agent/v1/ask")
async def ask(request: Request):
    payload = await request.json()
    controller: ChatController = request.app.state.services["chat_controller"]
    data, status = controller.ask(payload)
    if status >= 400:
        raise HTTPException(status_code=status, detail=data)
    return data


@app.post("/api/demo_agent/v1/chat")
async def chat(request: Request):
    payload = await request.json()
    controller: ChatController = request.app.state.services["chat_controller"]
    data, status = controller.chat(payload)
    if status >= 400:
        raise HTTPException(status_code=status, detail=data)
    return data


@app.post("/api/ingest/all")
async def ingest_all(request: Request):
    controller: IngestController | None = request.app.state.services.get("ingest_controller")
    if controller is None:
        raise HTTPException(status_code=400, detail="MinIO is not configured")

    data, status = controller.ingest_all()
    if status >= 400:
        raise HTTPException(status_code=status, detail=data)
    return data


@app.get("/api/ingest/status")
async def ingest_status(request: Request):
    controller: IngestController | None = request.app.state.services.get("ingest_controller")
    if controller is None:
        raise HTTPException(status_code=400, detail="MinIO is not configured")

    data, status = controller.check_ingest_status()
    if status >= 400:
        raise HTTPException(status_code=status, detail=data)
    return data


@app.delete("/api/ingest/clear")
async def clear_all(request: Request):
    controller: IngestController | None = request.app.state.services.get("ingest_controller")
    if controller is None:
        raise HTTPException(status_code=400, detail="MinIO is not configured")

    data, status = controller.clear_all()
    if status >= 400:
        raise HTTPException(status_code=status, detail=data)
    return data


@app.post("/api/upload/ingest-minio")
async def upload_ingest_from_minio(request: Request):
    controller: UploadController | None = request.app.state.services.get("upload_controller")
    if controller is None:
        raise HTTPException(status_code=400, detail="MinIO is not configured")

    payload = await request.json()
    data, status = controller.ingest_from_minio(payload)
    if status >= 400:
        raise HTTPException(status_code=status, detail=data)
    return data


@app.get("/api/upload/minio-files")
async def upload_list_minio_files(request: Request, prefix: str = Query(default="")):
    controller: UploadController | None = request.app.state.services.get("upload_controller")
    if controller is None:
        raise HTTPException(status_code=400, detail="MinIO is not configured")

    data, status = controller.list_minio_files(prefix)
    if status >= 400:
        raise HTTPException(status_code=status, detail=data)
    return data


@app.get("/api/upload/status")
async def upload_status(request: Request):
    controller: UploadController | None = request.app.state.services.get("upload_controller")
    if controller is None:
        raise HTTPException(status_code=400, detail="MinIO is not configured")

    data, status = controller.check_upload_status()
    if status >= 400:
        raise HTTPException(status_code=status, detail=data)
    return data


if __name__ == "__main__":
    port = int(os.getenv("PORT") or 4000)
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False)
