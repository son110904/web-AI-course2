from __future__ import annotations

import re
import unicodedata
from typing import Any

import requests

from backend.models.database import ChatMessage, DatabaseModel, SearchResult
from backend.services.embedding_service import EmbeddingService
from backend.services.neighbor_chunk_service import NeighborChunkService


class RAGService:
    def __init__(
        self,
        *,
        db: DatabaseModel,
        embedding_service: EmbeddingService,
        openai_api_key: str,
        openai_chat_model: str,
        openai_base_url: str | None = None,
        openai_timeout_ms: int | None = None,
    ) -> None:
        self.db = db
        self.embedding_service = embedding_service
        self.openai_api_key = openai_api_key
        self.openai_chat_model = openai_chat_model
        self.openai_base_url = (openai_base_url or "https://api.openai.com").rstrip("/")
        self.openai_timeout_ms = int(openai_timeout_ms or 60_000)
        self.neighbor_chunk_service = NeighborChunkService(db)

    def chat(self, messages: list[ChatMessage], expanded_queries: list[str] | None = None) -> str:
        user_message = next((message for message in reversed(messages) if message.role == "user"), None)
        if not user_message:
            return "No valid question found."

        query = user_message.content.strip()
        filters = self._detect_query_intent(query)

        if filters.get("query_type") == "teaching_list":
            instructor_name = self._extract_instructor_name(query)
            if instructor_name:
                metadata_results = self.db.search_by_instructor_two_pass(
                    instructor_name,
                    {"document_type": "syllabus", "limit": 50},
                )
                if not metadata_results:
                    metadata_results = self.db.search_by_instructor(
                        instructor_name,
                        {"document_type": "syllabus", "limit": 50},
                    )
                if len(metadata_results) >= 2:
                    return self._build_teaching_list_response(instructor_name, metadata_results)

        candidate_queries = [query, *(expanded_queries or [])]
        normalized_candidates = []
        for candidate in candidate_queries:
            value = str(candidate or "").strip()
            if value and value not in normalized_candidates:
                normalized_candidates.append(value)
        normalized_candidates = normalized_candidates[:5]

        raw_chunks_by_id: dict[str, SearchResult] = {}
        embedding_for_followups: list[float] | None = None

        for candidate in normalized_candidates:
            embedding = self.embedding_service.generate_embedding(candidate)
            if embedding_for_followups is None and candidate == query:
                embedding_for_followups = embedding

            results = self.db.search_similar_chunks(embedding, 15, filters)
            for item in results:
                if item.chunk_id not in raw_chunks_by_id:
                    raw_chunks_by_id[item.chunk_id] = item

        embedding = embedding_for_followups or self.embedding_service.generate_embedding(query)
        raw_chunks = list(raw_chunks_by_id.values())

        if not raw_chunks:
            return self._no_context()

        reranked = self._rerank_with_metadata(raw_chunks, query)

        file_mention = self._detect_mentioned_source_file(query, reranked)
        if file_mention:
            reranked = [chunk for chunk in reranked if chunk.metadata.get("source_file") == file_mention]

        expanded_by_subject = False
        if reranked:
            top_after_filter = reranked[0]
            if top_after_filter.document_type == "syllabus" and self._query_mentions_subject(query, top_after_filter.metadata):
                if top_after_filter.metadata.get("subject_code"):
                    subject_filters = {"metadata_filters": {"subject_code": top_after_filter.metadata.get("subject_code")}}
                else:
                    subject_filters = {"metadata_filters": {"subject_name": top_after_filter.metadata.get("subject_name")}}

                subject_chunks = self.db.search_similar_chunks(embedding, 100, subject_filters)
                if subject_chunks:
                    reranked = self._rerank_with_metadata(subject_chunks, query)
                    expanded_by_subject = True

        if not reranked:
            return self._no_context()

        min_top = 0.38
        min_chunk = 0.32

        top = reranked[0]
        if top.similarity < min_top:
            return self._no_context()

        chunk_limit = 4
        if filters.get("query_type") == "teaching_list":
            chunk_limit = 20
        elif expanded_by_subject:
            chunk_limit = 8

        if expanded_by_subject or filters.get("query_type") == "teaching_list":
            selected_chunks = reranked[:chunk_limit]
        else:
            selected_chunks = [chunk for chunk in reranked if chunk.similarity >= min_chunk][:chunk_limit]

        if not selected_chunks:
            return self._no_context()

        neighbor_window = int(__import__("os").environ.get("NEIGHBOR_CHUNK_WINDOW", "1") or "1")
        expanded_chunks = self.neighbor_chunk_service.expand(selected_chunks, neighbor_window)

        context = self._build_context_with_metadata(expanded_chunks)
        if len(context) < 50:
            return self._no_context()

        return self._generate_response(query, context, expanded_chunks, filters.get("query_type"))

    def _build_teaching_list_response(self, instructor_name: str, chunks: list[SearchResult]) -> str:
        subjects_map: dict[str, dict[str, str | None]] = {}

        for chunk in chunks:
            subject_name = chunk.metadata.get("subject_name")
            subject_code = chunk.metadata.get("subject_code")
            if subject_name:
                key = str(subject_code or subject_name)
                if key not in subjects_map:
                    subjects_map[key] = {"name": str(subject_name), "code": str(subject_code) if subject_code else None}

        if not subjects_map:
            return (
                f"Không tìm thấy thông tin môn học nào của giảng viên {instructor_name} "
                "trong phần phân công giảng dạy của đề cương."
            )

        ordered = sorted(subjects_map.values(), key=lambda item: item["name"] or "")
        lines = []
        for index, subject in enumerate(ordered, start=1):
            if subject.get("code"):
                lines.append(f"{index}. {subject['name']} ({subject['code']})")
            else:
                lines.append(f"{index}. {subject['name']}")

        if len(ordered) == 1:
            note = "\n\nLưu ý: chỉ tìm thấy một môn học trong các file đề cương hiện có."
        else:
            note = "\n\nThông tin được trích xuất từ phần phân công giảng dạy trong các file đề cương."

        return (
            f"Dựa trên các file đề cương, giảng viên {instructor_name} giảng dạy {len(ordered)} môn học:\n\n"
            + "\n".join(lines)
            + note
        )

    def _detect_query_intent(self, query: str) -> dict[str, Any]:
        q = self._normalize_for_match(query)
        filters: dict[str, Any] = {}

        if self._match_query_phrase(q, "de cuong", 0.8) or self._match_query_phrase(q, "syllabus", 1) or self._match_query_phrase(q, "mon hoc", 0.8):
            filters["document_type"] = "syllabus"
        elif self._match_query_phrase(q, "chuong trinh dao tao", 0.8) or self._match_query_phrase(q, "ctdt", 1) or self._match_query_phrase(q, "curriculum", 1):
            filters["document_type"] = "curriculum"
        elif self._match_query_phrase(q, "career", 1) or self._match_query_phrase(q, "nghe nghiep", 0.8) or self._match_query_phrase(q, "job", 1):
            filters["document_type"] = "career"

        if self._match_query_phrase(q, "ky nang", 0.8) or self._match_query_phrase(q, "skills", 1):
            filters["section"] = "skills"
        elif self._match_query_phrase(q, "nhiem vu", 0.8) or self._match_query_phrase(q, "responsibility", 0.8):
            filters["section"] = "responsibilities"
        elif self._match_query_phrase(q, "yeu cau", 0.8) or self._match_query_phrase(q, "requirements", 0.8):
            filters["section"] = "requirements"

        is_teaching_query = (
            self._match_query_phrase(q, "giang vien", 0.8)
            or self._match_query_phrase(q, "giao vien", 0.8)
            or self._has_token(q, "thay")
            or self._has_token(q, "co")
            or self._has_token(q, "day")
        )

        if "document_type" not in filters and is_teaching_query:
            filters["document_type"] = "syllabus"

        if is_teaching_query:
            is_list_query = (
                self._match_query_phrase(q, "nhung mon", 0.7)
                or self._match_query_phrase(q, "cac mon", 0.7)
                or self._match_query_phrase(q, "mon nao", 0.7)
                or self._match_query_phrase(q, "mon gi", 0.7)
                or "day gi" in q
                or "day nhung" in q
                or "day cac" in q
                or "phu trach mon" in q
                or "giang day" in q
            )
            is_check_query = (
                self._match_query_phrase(q, "co day", 0.8)
                or self._match_query_phrase(q, "co phu trach", 0.8)
                or "co day mon" in q
                or "khong" in q
            )

            if is_list_query and not is_check_query:
                filters["query_type"] = "teaching_list"
            elif is_check_query:
                filters["query_type"] = "teaching_check"
            else:
                filters["query_type"] = "general"

        if self._match_query_phrase(q, "cong nghe thong tin", 0.8) or self._has_token(q, "cntt"):
            filters["metadata_filters"] = {**filters.get("metadata_filters", {}), "major": "Cong nghe thong tin"}
        elif self._match_query_phrase(q, "khoa hoc may tinh", 0.8) or self._has_token(q, "khmt"):
            filters["metadata_filters"] = {**filters.get("metadata_filters", {}), "major": "Khoa hoc may tinh"}

        code_match = re.search(r"[a-z]{2,4}\s*\d{3,4}", q, flags=re.IGNORECASE)
        if code_match:
            code = re.sub(r"\s+", "", code_match.group(0)).upper()
            filters["metadata_filters"] = {**filters.get("metadata_filters", {}), "subject_code": code}

        return filters

    def _rerank_with_metadata(self, chunks: list[SearchResult], query: str) -> list[SearchResult]:
        q = self._normalize_for_match(query)
        instructor_name = self._extract_instructor_name(query)
        query_wants_curriculum = (
            self._match_query_phrase(q, "chuong trinh dao tao", 0.8)
            or self._match_query_phrase(q, "ctdt", 1)
            or self._match_query_phrase(q, "curriculum", 1)
        )

        reranked: list[SearchResult] = []
        for chunk in chunks:
            score = chunk.similarity
            meta = chunk.metadata or {}
            is_curriculum = chunk.document_type == "curriculum"

            if chunk.document_type == "syllabus" and self._has_token(q, "de cuong"):
                score += 0.15

            if self._query_mentions_source_file(q, str(meta.get("source_file") or "")):
                score += 0.3

            if instructor_name:
                normalized_content = self._normalize_for_match(chunk.content)
                normalized_instructor = self._normalize_for_match(instructor_name)
                has_instructor = normalized_instructor and normalized_instructor in normalized_content
                if has_instructor:
                    is_teaching_section = (
                        "giang vien giang day" in normalized_content
                        or "giang vien phu trach" in normalized_content
                        or "nguoi giang day" in normalized_content
                    )
                    score += 0.35 if is_teaching_section else 0.15

            if meta.get("subject_name") and self._match_query_phrase(q, str(meta.get("subject_name")), 0.7):
                score += 0.2
            if meta.get("subject_code") and self._has_token(q, str(meta.get("subject_code"))):
                score += 0.25

            if meta.get("major") and self._match_query_phrase(q, str(meta.get("major")), 0.7):
                score += 0.04 if is_curriculum else 0.1

            if is_curriculum and not query_wants_curriculum:
                score -= 0.06

            chunk.similarity = max(0.0, min(score, 1.0))
            reranked.append(chunk)

        reranked.sort(key=lambda item: item.similarity, reverse=True)
        return reranked

    def _build_context_with_metadata(self, chunks: list[SearchResult]) -> str:
        blocks: list[str] = []
        for chunk in chunks:
            meta = chunk.metadata or {}
            header = f"[{chunk.document_type.upper()}]"

            if chunk.document_type == "syllabus":
                if meta.get("subject_name"):
                    header += f"\nSubject: {meta.get('subject_name')}"
                if meta.get("subject_code"):
                    header += f" ({meta.get('subject_code')})"
                if meta.get("credits"):
                    header += f"\nCredits: {meta.get('credits')}"
                if meta.get("major"):
                    header += f"\nMajor: {meta.get('major')}"
            elif chunk.document_type == "regulation":
                header += "\nType: Regulation"
                if meta.get("regulation_type"):
                    header += f"\nCategory: {meta.get('regulation_type')}"
                if meta.get("decision_number"):
                    header += f"\nDecision: {meta.get('decision_number')}"
            elif chunk.document_type == "curriculum":
                header += "\nType: Curriculum"
                if meta.get("program_name"):
                    header += f"\nProgram: {meta.get('program_name')}"
                if meta.get("major_code"):
                    header += f"\nMajor code: {meta.get('major_code')}"
                if meta.get("total_credits"):
                    header += f"\nTotal credits: {meta.get('total_credits')}"

            blocks.append(f"{header}\n\n{chunk.content}")

        return "\n\n---\n\n".join(blocks)

    def _generate_response(self, query: str, context: str, chunks: list[SearchResult], query_type: str | None = None) -> str:
        _ = chunks

        system_prompt = (
            "Bạn là trợ lý AI của Trường Đại học Kinh tế Quốc dân. "
            "Hãy trả lời bằng tiếng Việt về tư vấn định hướng ngành học, nghề nghiệp và tra cứu thông tin. "
            "Chỉ trả lời dựa trên ngữ cảnh được cung cấp. "
            "Nếu ngữ cảnh không đủ thông tin, hãy trả lời: 'Tôi không tìm thấy thông tin phù hợp trong tài liệu hiện có.'"
        )

        if query_type == "teaching_list":
            system_prompt += (
                " Với câu hỏi về danh sách giảng dạy, chỉ liệt kê các môn học mà giảng viên đó được ghi rõ là giảng dạy "
                "trong phần phân công giảng dạy của đề cương môn học."
            )

        user_prompt = f"NGỮ CẢNH:\n{context}\n\nCÂU HỎI:\n{query}\n\nHãy trả lời bằng tiếng Việt dựa trên ngữ cảnh trên."
        return self._openai_chat(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.1 if query_type == "teaching_list" else 0.2,
            top_p=0.9,
        )

    def _openai_chat(self, messages: list[dict[str, str]], temperature: float = 0.2, top_p: float = 0.9) -> str:
        response = requests.post(
            f"{self.openai_base_url}/v1/chat/completions",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.openai_api_key}",
            },
            json={
                "model": self.openai_chat_model,
                "messages": messages,
                "temperature": temperature,
                "top_p": top_p,
            },
            timeout=self.openai_timeout_ms / 1000,
        )

        if not response.ok:
            detail = response.text or response.reason
            raise RuntimeError(f"OpenAI error ({response.status_code}): {detail}")

        data: dict[str, Any] = response.json()
        content = (((data.get("choices") or [{}])[0].get("message") or {}).get("content") or "").strip()
        if not content:
            raise RuntimeError("OpenAI returned empty response content")
        return content

    def _normalize_for_match(self, text: str) -> str:
        normalized = unicodedata.normalize("NFD", str(text or "").lower())
        normalized = "".join(char for char in normalized if unicodedata.category(char) != "Mn")
        normalized = normalized.replace("_", " ").replace("-", " ")
        return re.sub(r"\s+", " ", normalized).strip()

    def _escape_regexp(self, value: str) -> str:
        return re.escape(value)

    def _has_exact_phrase(self, query_normalized: str, phrase_normalized: str) -> bool:
        if not phrase_normalized:
            return False
        escaped = self._escape_regexp(phrase_normalized)
        pattern = re.compile(rf"(?:^|\s){escaped}(?:\s|$)", flags=re.IGNORECASE)
        return bool(pattern.search(query_normalized))

    def _token_overlap_ratio(self, query_normalized: str, phrase_normalized: str) -> float:
        if not query_normalized or not phrase_normalized:
            return 0.0
        query_tokens = set(token for token in query_normalized.split(" ") if token)
        phrase_tokens = [token for token in phrase_normalized.split(" ") if token]
        if not phrase_tokens:
            return 0.0
        hit = sum(1 for token in phrase_tokens if token in query_tokens)
        return hit / len(phrase_tokens)

    def _match_query_phrase(self, query_normalized: str, phrase: str, min_token_ratio: float = 0.6) -> bool:
        phrase_normalized = self._normalize_for_match(phrase)
        if not phrase_normalized:
            return False
        if self._has_exact_phrase(query_normalized, phrase_normalized):
            return True

        tokens = [token for token in phrase_normalized.split(" ") if token]
        if len(tokens) == 1 and len(tokens[0]) < 3:
            return False

        return self._token_overlap_ratio(query_normalized, phrase_normalized) >= min_token_ratio

    def _has_token(self, query_normalized: str, token: str) -> bool:
        token_normalized = self._normalize_for_match(token)
        return self._has_exact_phrase(query_normalized, token_normalized)

    def _extract_instructor_name(self, query: str) -> str | None:
        q = self._normalize_for_match(query)
        markers = ["thay", "co", "giang vien", "giao vien"]
        for marker in markers:
            is_match = self._has_token(q, marker) if len(marker) < 3 else self._match_query_phrase(q, marker, 1)
            if is_match:
                after = q.split(marker, 1)[1].strip() if marker in q else ""
                if not after:
                    continue
                cutoff = " ".join(after.split(" ")[:4]).strip()
                return cutoff or None

        if self._match_query_phrase(q, "day", 1):
            parts = q.split("day", 1)[1].strip() if "day" in q else ""
            tokens = [token for token in parts.split(" ") if token]
            if len(tokens) >= 2:
                return " ".join(tokens[:4])

        return None

    def _query_mentions_source_file(self, query_normalized: str, source_file: str | None) -> bool:
        if not source_file:
            return False
        full = self._normalize_for_match(source_file)
        no_ext = self._normalize_for_match(re.sub(r"\.[^/.]+$", "", source_file))
        return self._has_exact_phrase(query_normalized, full) or self._has_exact_phrase(query_normalized, no_ext)

    def _detect_mentioned_source_file(self, query: str, chunks: list[SearchResult]) -> str | None:
        q = self._normalize_for_match(query)
        for chunk in chunks:
            source_file = chunk.metadata.get("source_file") if isinstance(chunk.metadata, dict) else None
            if source_file and self._query_mentions_source_file(q, str(source_file)):
                return str(source_file)
        return None

    def _query_mentions_subject(self, query: str, metadata: dict[str, Any]) -> bool:
        q = self._normalize_for_match(query)
        subject_name = self._normalize_for_match(str(metadata.get("subject_name") or ""))
        subject_code = self._normalize_for_match(str(metadata.get("subject_code") or ""))
        if subject_code and self._has_token(q, subject_code):
            return True
        if subject_name and self._match_query_phrase(q, subject_name, 0.8):
            return True
        return False

    def _no_context(self) -> str:
        return "Tôi không tìm thấy thông tin phù hợp trong tài liệu hiện có."