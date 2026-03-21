from __future__ import annotations

import time
from typing import Any

from backend.models.database import ChatMessage
from backend.services.query_expansion_service import expand_query
from backend.services.rag_service import RAGService


class ChatController:
    def __init__(self, rag_service: RAGService) -> None:
        self.rag_service = rag_service

    def chat(self, payload: dict[str, Any]) -> tuple[dict[str, Any], int]:
        messages = payload.get("messages")
        if not isinstance(messages, list) or not messages:
            return {"botMessage": "Invalid message payload"}, 400

        valid_messages: list[ChatMessage] = []
        for item in messages:
            role = "user" if str(item.get("role")) == "user" else "assistant"
            content = str(item.get("content") or "")
            valid_messages.append(ChatMessage(role=role, content=content))

        last_message = valid_messages[-1]
        expanded_queries: list[str] | None = None
        if last_message.role == "user":
            expanded_queries = expand_query(last_message.content)

        try:
            bot_message = self.rag_service.chat(valid_messages, expanded_queries)
            return {"botMessage": bot_message}, 200
        except Exception as exc:
            return {
                "botMessage": "System error while processing your request",
                "error_detail": f"{type(exc).__name__}: {exc}",
            }, 500

    def ask(self, payload: dict[str, Any]) -> tuple[dict[str, Any], int]:
        if isinstance(payload.get("messages"), list):
            return self.chat(payload)

        session_id = payload.get("session_id")
        model_id = payload.get("model_id")
        user = payload.get("user")
        prompt = payload.get("prompt")
        context = payload.get("context") or {}

        if not session_id or not model_id or not user or not prompt:
            return (
                {
                    "status": "error",
                    "message": "Missing required fields: session_id, model_id, user, prompt",
                },
                400,
            )

        history = context.get("history") if isinstance(context, dict) else []
        if not isinstance(history, list):
            history = []

        messages: list[ChatMessage] = []
        for item in history:
            role = "user" if str(item.get("role")) == "user" else "assistant"
            content = str(item.get("content") or "")
            messages.append(ChatMessage(role=role, content=content))

        messages.append(ChatMessage(role="user", content=str(prompt)))
        expanded_queries = expand_query(str(prompt))

        start_time = time.time()
        try:
            content_markdown = self.rag_service.chat(messages, expanded_queries)
            response_time_ms = int((time.time() - start_time) * 1000)
            return (
                {
                    "session_id": session_id,
                    "status": "success",
                    "content_markdown": content_markdown,
                    "meta": {
                        "model": model_id,
                        "response_time_ms": response_time_ms,
                        "tokens_used": 0,
                    },
                    "attachments": [],
                },
                200,
            )
        except Exception as exc:
            return (
                {
                    "session_id": session_id,
                    "status": "error",
                    "message": "System error while processing your request",
                    "error_detail": f"{type(exc).__name__}: {exc}",
                },
                500,
            )
