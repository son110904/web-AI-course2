from __future__ import annotations

from typing import Any

import requests


class EmbeddingService:
    def __init__(
        self,
        *,
        openai_api_key: str,
        openai_embedding_model: str = "text-embedding-3-small",
        openai_base_url: str | None = None,
        openai_timeout_ms: int | None = None,
    ) -> None:
        self.openai_api_key = openai_api_key
        self.openai_embedding_model = openai_embedding_model
        self.openai_base_url = (openai_base_url or "https://api.openai.com").rstrip("/")
        self.openai_timeout_ms = int(openai_timeout_ms or 60_000)

    def initialize(self) -> None:
        return

    def generate_embedding(self, text: str) -> list[float]:
        return self.generate_batch_embeddings([text])[0]

    def generate_batch_embeddings(self, texts: list[str]) -> list[list[float]]:
        inputs = [self._preprocess(text) for text in texts]
        response = requests.post(
            f"{self.openai_base_url}/v1/embeddings",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.openai_api_key}",
            },
            json={"model": self.openai_embedding_model, "input": inputs},
            timeout=self.openai_timeout_ms / 1000,
        )

        if not response.ok:
            detail = response.text or response.reason
            raise RuntimeError(f"OpenAI embeddings error ({response.status_code}): {detail}")

        data: dict[str, Any] = response.json()
        items = data.get("data") or []

        by_index: dict[int, list[float]] = {}
        for item in items:
            if isinstance(item, dict) and isinstance(item.get("index"), int) and isinstance(item.get("embedding"), list):
                by_index[item["index"]] = item["embedding"]

        results: list[list[float]] = []
        for index in range(len(inputs)):
            embedding = by_index.get(index)
            if embedding is None:
                raise RuntimeError(f"Missing embedding for input index {index}")
            results.append([float(value) for value in embedding])

        return results

    def _preprocess(self, text: str) -> str:
        return (
            str(text or "")
            .replace("\r\n", "\n")
            .replace("\u2022", "-")
            .replace("\u2013", "-")
            .replace("\u2014", "-")
            .strip()[:3000]
        )
