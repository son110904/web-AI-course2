"""
RAG Evaluation Pipeline — Text + Retrieval metrics
====================================================
Chạy trực tiếp qua rag_service, không cần HTTP server.

TEXT METRICS (chạy ngay, chỉ cần query + ground_truth_answer):
  • Exact Match        — 1 nếu answer khớp hoàn toàn (sau normalize)
  • ROUGE-L            — độ dài chuỗi con chung dài nhất
  • Semantic Similarity — cosine similarity giữa 2 embedding (OpenAI)

RETRIEVAL METRICS (tự động bỏ qua nếu relevant_chunk_ids trống):
  • Precision@K
  • Recall@K
  • F1-Score@K
  • MRR

Cài đặt:
  pip install pandas openpyxl python-dotenv rouge-score

Cấu hình (.env — dùng chung với main.py):
  GROUND_TRUTH_FILE=ground_truth.csv
  OUTPUT_DIR=eval_results
  TOP_K=5

Cột ground truth:
  Bắt buộc : query (hoặc question), ground_truth_answer (hoặc expected_answer)
  Tuỳ chọn : question_id, relevant_chunk_ids (ngăn cách bởi |)
  Bỏ qua   : annotator, note, hoặc bất kỳ cột nào khác
"""

from __future__ import annotations

import json
import math
import os
import sys
import time
import unicodedata
from datetime import datetime
from pathlib import Path

import pandas as pd
from dotenv import load_dotenv

load_dotenv()

# ──────────────────────────────────────────────────────────────
# CẤU HÌNH
# ──────────────────────────────────────────────────────────────

GROUND_TRUTH_FILE = os.getenv("GROUND_TRUTH_FILE", "ground_truth.csv")
OUTPUT_DIR        = Path(os.getenv("OUTPUT_DIR", "eval_results"))
TOP_K             = int(os.getenv("TOP_K", "5"))
REQUEST_DELAY     = float(os.getenv("REQUEST_DELAY", "0.3"))

# Chế độ strict: chunk id là ground truth ưu tiên.
TEXT_FALLBACK_MATCH_THRESHOLD    = float(os.getenv("TEXT_FALLBACK_MATCH_THRESHOLD", "0.55"))
TEXT_FALLBACK_SEMANTIC_THRESHOLD = float(os.getenv("TEXT_FALLBACK_SEMANTIC_THRESHOLD", "0.92"))
TEXT_FALLBACK_PENALTY_FACTOR     = float(os.getenv("TEXT_FALLBACK_PENALTY_FACTOR", "0.35"))


# ──────────────────────────────────────────────────────────────
# 1. KHỞI TẠO SERVICES
# ──────────────────────────────────────────────────────────────

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

    return rag_service, embedding_service


# ──────────────────────────────────────────────────────────────
# 2. ĐỌC GROUND TRUTH
# ──────────────────────────────────────────────────────────────

def load_ground_truth(file_path: str) -> list[dict]:
    """
    Đọc CSV / Excel / JSON.
    Chấp nhận nhiều tên cột khác nhau, bỏ qua cột không liên quan.
    """
    path = Path(file_path)
    if not path.exists():
        sys.exit(f"❌  Không tìm thấy file: {file_path}")

    ext = path.suffix.lower()

    import unicodedata as _ud

    def _norm_col(c: str) -> str:
        s = str(c).strip().lower()
        s = _ud.normalize("NFD", s)
        s = "".join(ch for ch in s if _ud.category(ch) != "Mn")
        return s.replace(" ", "_")

    # Keywords để nhận diện cột (so khớp partial sau normalize)
    QUERY_KW    = ("query", "question", "cau_hoi")
    ANSWER_KW   = ("ground_truth_answer", "ground_truth", "expected_answer", "dap_an")
    ID_KW       = ("id",)
    CTX_KW      = ("retrieval_context",)
    CHUNK_ID_KW = ("retrieval_chunk_id", "relevant_chunk_id", "chunk_id")
    QTYPE_KW    = ("query_type", "question_type", "loai_truy_van")

    def _col_matches(col: str, kws: tuple) -> bool:
        return any(kw in col for kw in kws)

    def _find_header_row(raw_df: pd.DataFrame) -> int:
        # Phải có CẢ cột query VÀ cột answer trong cùng 1 hàng
        for row_idx in range(min(6, len(raw_df))):
            row_vals = [_norm_col(str(v)) for v in raw_df.iloc[row_idx] if pd.notna(v)]
            has_query  = any(_col_matches(v, QUERY_KW)  for v in row_vals)
            has_answer = any(_col_matches(v, ANSWER_KW) for v in row_vals)
            if has_query and has_answer:
                return row_idx
        return 0

    def _is_example_row(val: str) -> bool:
        v = _norm_col(val)
        return v.startswith("vd") or "cau hoi thuc te" in v or "dap an chuan" in v

    if ext == ".csv":
        raw  = pd.read_csv(path, encoding="utf-8-sig", header=None)
        hrow = _find_header_row(raw)
        df   = pd.read_csv(path, encoding="utf-8-sig", header=hrow)
    elif ext in {".xlsx", ".xls"}:
        raw  = pd.read_excel(path, header=None)
        hrow = _find_header_row(raw)
        df   = pd.read_excel(path, header=hrow)
    elif ext == ".json":
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        df = pd.DataFrame(data)
    else:
        sys.exit(f"❌  Định dạng không hỗ trợ: {ext}")

    # Chuẩn hoá tên cột
    df.columns = [_norm_col(str(c)) for c in df.columns]
    df = df.dropna(how="all").reset_index(drop=True)

    # Bỏ hàng ví dụ/mô tả ngay sau header
    first_col = df.columns[0]
    df = df[~df[first_col].astype(str).apply(_is_example_row)]
    df = df.reset_index(drop=True)

    # Map tên cột → tên chuẩn nội bộ
    rename_map: dict[str, str] = {}
    for col in df.columns:
        if _col_matches(col, QUERY_KW) and "query" not in rename_map.values():
            rename_map[col] = "query"
        elif _col_matches(col, ANSWER_KW) and "ground_truth_answer" not in rename_map.values():
            rename_map[col] = "ground_truth_answer"
        elif _col_matches(col, CHUNK_ID_KW) and "relevant_chunk_ids" not in rename_map.values():
            rename_map[col] = "relevant_chunk_ids"
        elif _col_matches(col, QTYPE_KW) and "query_type" not in rename_map.values():
            rename_map[col] = "query_type"
        elif _col_matches(col, CTX_KW) and "retrieval_context" not in rename_map.values():
            rename_map[col] = "retrieval_context"
        elif _col_matches(col, ID_KW) and "question_id" not in rename_map.values():
            rename_map[col] = "question_id"
    df.rename(columns=rename_map, inplace=True)

    required = {"query", "ground_truth_answer"}
    missing = required - set(df.columns)
    if missing:
        sys.exit(
            f"❌  File thiếu cột: {missing}\n"
            f"    Cột hiện có: {list(df.columns)}\n\n"
            f"    File cần cột 'query' (câu hỏi) và 'ground_truth_answer' (đáp án chuẩn)."
        )

    # Bỏ hàng trống
    df = df[df["query"].notna() & (df["query"].astype(str).str.strip() != "")]
    df = df.reset_index(drop=True)

    # question_id
    if "question_id" not in df.columns:
        df["question_id"] = [f"q{i+1:04d}" for i in range(len(df))]

    # relevant_chunk_ids: tuỳ chọn
    def parse_ids(raw) -> list[str]:
        if pd.isna(raw) or str(raw).strip() in ("", "nan"):
            return []
        import re as _re
        # Hỗ trợ mọi format:
        #   - UUID thẳng: abc123|def456  hoặc  abc123,def456
        #   - JSON array paste: "abc123",\n    "def456"
        # Trích tất cả UUID/ID bằng regex (alphanum + dấu -)
        ids = _re.findall(r'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[\w]{8,}', str(raw))
        # Nếu không tìm thấy UUID format, fallback split , hoặc |
        if not ids:
            for sep in (",", "|", ";"):
                parts = [s.strip().strip('"').strip("'") for s in str(raw).split(sep)]
                parts = [p for p in parts if p and p != "nan"]
                if parts:
                    return parts
        return ids

    if "relevant_chunk_ids" in df.columns:
        df["relevant_chunk_ids"] = df["relevant_chunk_ids"].apply(parse_ids)
    else:
        df["relevant_chunk_ids"] = [[] for _ in range(len(df))]

        # relevant_context_texts: parse từ cột Retrieval_context nếu có
    def parse_contexts(raw) -> list[str]:
        if pd.isna(raw) or str(raw).strip() in ("", "nan"):
            return []
        # Hỗ trợ ngăn cách bởi "|||" hoặc để nguyên 1 đoạn
        parts = [s.strip() for s in str(raw).split("|||") if s.strip()]
        return parts if parts else [str(raw).strip()]

    if "retrieval_context" in df.columns:
        df["relevant_context_texts"] = df["retrieval_context"].apply(parse_contexts)
    else:
        df["relevant_context_texts"] = [[] for _ in range(len(df))]

    # query_type: tuỳ chọn — single-hop / multi-hop / global
    if "query_type" not in df.columns:
        df["query_type"] = ""
    else:
        df["query_type"] = df["query_type"].fillna("").astype(str).str.strip()

    return df[["question_id", "query", "ground_truth_answer",
               "relevant_chunk_ids", "relevant_context_texts",
               "query_type"]].to_dict(orient="records")


# ──────────────────────────────────────────────────────────────
# 3. GỌI CHATBOT TRỰC TIẾP
# ──────────────────────────────────────────────────────────────

def ask_rag(rag_service, question: str) -> tuple[str, list[str], list[str]]:
    from backend.models.database import ChatMessage
    from backend.services.query_expansion_service import expand_query

    messages = [ChatMessage(role="user", content=question)]
    expanded = expand_query(question)
    result   = rag_service.chat_with_context(messages, expanded)

    return (
        result.get("answer", ""),
        result.get("chunk_ids", []),
        result.get("retrieval_context", []),
    )


# ──────────────────────────────────────────────────────────────
# 4A. TEXT METRICS
# ──────────────────────────────────────────────────────────────

def _normalize_text(text: str) -> str:
    """Lowercase, bỏ dấu, chuẩn hoá khoảng trắng."""
    text = text.lower().strip()
    text = unicodedata.normalize("NFD", text)
    text = "".join(c for c in text if unicodedata.category(c) != "Mn")
    return " ".join(text.split())


NO_ANSWER_PREFIXES = (
    "toi khong tim thay thong tin phu hop trong tai lieu hien co.",
    "khong tim thay thong tin phu hop trong tai lieu hien co.",
    "khong co cau hoi hop le.",
    "no valid question found.",
)


def _is_unanswered_text(text: str) -> bool:
    normalized = _normalize_text(text)
    if not normalized:
        return True
    return any(normalized.startswith(prefix) for prefix in NO_ANSWER_PREFIXES)


def exact_match(prediction: str, reference: str) -> float:
    """1.0 nếu khớp hoàn toàn sau normalize, 0.0 nếu không."""
    return 1.0 if _normalize_text(prediction) == _normalize_text(reference) else 0.0


def rouge_l(prediction: str, reference: str) -> float:
    """
    ROUGE-L dùng thư viện rouge-score nếu có,
    fallback tự tính LCS nếu không cài.
    """
    try:
        from rouge_score import rouge_scorer
        scorer = rouge_scorer.RougeScorer(["rougeL"], use_stemmer=False)
        scores = scorer.score(reference, prediction)
        return round(scores["rougeL"].fmeasure, 4)
    except ImportError:
        pass

    # Fallback: tự tính LCS token-level
    pred_tokens = _normalize_text(prediction).split()
    ref_tokens  = _normalize_text(reference).split()
    if not pred_tokens or not ref_tokens:
        return 0.0
    m, n   = len(ref_tokens), len(pred_tokens)
    dp     = [[0] * (n + 1) for _ in range(m + 1)]
    for i in range(1, m + 1):
        for j in range(1, n + 1):
            dp[i][j] = dp[i-1][j-1] + 1 if ref_tokens[i-1] == pred_tokens[j-1] else max(dp[i-1][j], dp[i][j-1])
    lcs = dp[m][n]
    precision = lcs / n if n else 0.0
    recall    = lcs / m if m else 0.0
    f1        = (2 * precision * recall / (precision + recall)) if (precision + recall) else 0.0
    return round(f1, 4)


def _cosine(v1: list[float], v2: list[float]) -> float:
    dot  = sum(a * b for a, b in zip(v1, v2))
    mag1 = math.sqrt(sum(a * a for a in v1))
    mag2 = math.sqrt(sum(b * b for b in v2))
    return dot / (mag1 * mag2) if mag1 and mag2 else 0.0


def semantic_similarity(
    prediction: str,
    reference: str,
    embedding_service,
) -> float:
    """Cosine similarity giữa 2 embedding OpenAI."""
    if _is_unanswered_text(prediction) or _is_unanswered_text(reference):
        return 0.0
    try:
        v1 = embedding_service.generate_embedding(prediction)
        v2 = embedding_service.generate_embedding(reference)
        return round(_cosine(v1, v2), 4)
    except Exception:
        return None  # type: ignore


def compute_text_scores(
    actual: str,
    expected: str,
    embedding_service,
) -> dict[str, float | None]:
    if _is_unanswered_text(actual):
        return {
            "exact_match": 0.0,
            "rouge_l": 0.0,
            "semantic_similarity": 0.0,
        }
    return {
        "exact_match"         : exact_match(actual, expected),
        "rouge_l"             : rouge_l(actual, expected),
        "semantic_similarity" : semantic_similarity(actual, expected, embedding_service),
    }


# ──────────────────────────────────────────────────────────────
# 4B. RETRIEVAL METRICS
# ──────────────────────────────────────────────────────────────

def _precision_at_k(retrieved: list[str], relevant: set[str], k: int) -> float:
    return sum(1 for c in retrieved[:k] if c in relevant) / k if k else 0.0

def _recall_at_k(retrieved: list[str], relevant: set[str], k: int) -> float:
    return sum(1 for c in retrieved[:k] if c in relevant) / len(relevant) if relevant else 0.0

def _f1(p: float, r: float) -> float:
    return 2 * p * r / (p + r) if (p + r) else 0.0

def _rr(retrieved: list[str], relevant: set[str]) -> float:
    for rank, cid in enumerate(retrieved, 1):
        if cid in relevant:
            return 1.0 / rank
    return 0.0


def compute_retrieval_scores(
    retrieved_ids: list[str],
    relevant_ids: list[str],
    k: int,
) -> dict[str, float] | None:
    """Trả về None nếu relevant_ids rỗng (chưa điền ground truth)."""
    if not relevant_ids:
        return None
    relevant = set(relevant_ids)
    p  = _precision_at_k(retrieved_ids, relevant, k)
    r  = _recall_at_k(retrieved_ids, relevant, k)
    return {
        f"precision_at_{k}": round(p,       4),
        f"recall_at_{k}"   : round(r,       4),
        f"f1_at_{k}"       : round(_f1(p,r),4),
        "reciprocal_rank"  : round(_rr(retrieved_ids, relevant), 4),
    }


def zero_retrieval_scores(k: int) -> dict[str, float]:
    return {
        f"precision_at_{k}": 0.0,
        f"recall_at_{k}"   : 0.0,
        f"f1_at_{k}"       : 0.0,
        "reciprocal_rank"  : 0.0,
    }


def apply_retrieval_penalty(scores: dict[str, float] | None, penalty_factor: float) -> dict[str, float]:
    if not scores:
        return {}
    factor = max(0.0, min(float(penalty_factor), 1.0))
    return {key: round(value * factor, 4) for key, value in scores.items()}


def compute_retrieval_scores_from_text(
    retrieved_texts: list[str],
    relevant_texts: list[str],
    k: int,
    match_threshold: float = TEXT_FALLBACK_MATCH_THRESHOLD,
    embedding_service=None,
    semantic_threshold: float = TEXT_FALLBACK_SEMANTIC_THRESHOLD,
) -> dict[str, float] | None:
    """
    Tính P@K / R@K / F1@K / MRR bằng cách so sánh TEXT thay vì chunk ID.

    Một retrieved chunk được coi là "đúng" nếu ROUGE-L với bất kỳ
    relevant_text nào >= match_threshold (mặc định 0.35).
    Nếu embedding_service được cung cấp, dùng thêm semantic similarity
    làm điều kiện OR (>= semantic_threshold).

    Trả về None nếu relevant_texts rỗng.
    """
    if not relevant_texts or not retrieved_texts:
        return None

    def _is_match(ret_text: str) -> bool:
        for rel_text in relevant_texts:
            # ROUGE-L check
            rl = rouge_l(ret_text, rel_text)
            if rl >= match_threshold:
                return True
            # Semantic check (nếu có embedding_service)
            if embedding_service is not None:
                try:
                    v1 = embedding_service.generate_embedding(ret_text[:500])
                    v2 = embedding_service.generate_embedding(rel_text[:500])
                    if _cosine(v1, v2) >= semantic_threshold:
                        return True
                except Exception:
                    pass
        return False

    # Đánh dấu từng retrieved chunk: 1 nếu match, 0 nếu không
    top_k    = retrieved_texts[:k]
    is_hit   = [_is_match(t) for t in top_k]
    n_rel    = len(relevant_texts)

    hits_k   = sum(is_hit)
    p        = hits_k / k if k else 0.0
    r        = hits_k / n_rel if n_rel else 0.0
    f1       = 2 * p * r / (p + r) if (p + r) else 0.0

    # MRR: rank của hit đầu tiên
    rr = 0.0
    for rank, hit in enumerate(is_hit, 1):
        if hit:
            rr = 1.0 / rank
            break

    return {
        f"precision_at_{k}": round(p,  4),
        f"recall_at_{k}"   : round(r,  4),
        f"f1_at_{k}"       : round(f1, 4),
        "reciprocal_rank"  : round(rr, 4),
    }


# ──────────────────────────────────────────────────────────────
# 5. LƯU JSON
# ──────────────────────────────────────────────────────────────

def save_result(output_dir: Path, result: dict) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    with open(output_dir / f"{result['question_id']}.json", "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)


# ──────────────────────────────────────────────────────────────
# 6. BẢNG KẾT QUẢ
# ──────────────────────────────────────────────────────────────

def _avg(results: list[dict], key: str) -> float | None:
    vals = [r["scores"].get(key) for r in results if r["scores"].get(key) is not None]
    return round(sum(vals) / len(vals), 4) if vals else None


def _bar(score: float | None) -> str:
    if score is None:
        return "░" * 20 + "  N/A"
    filled = int(score * 20)
    return "█" * filled + "░" * (20 - filled) + f"  {score:.4f}"


def print_summary_table(all_results: list[dict], k: int) -> None:
    ok = [r for r in all_results if r["status"] == "success"]
    has_retrieval = any(r["scores"].get(f"precision_at_{k}") is not None for r in ok)

    # ── TEXT columns ──
    text_cols    = ["exact_match", "rouge_l", "semantic_similarity"]
    text_display = ["Exact Match", "ROUGE-L", "Semantic Sim"]

    # ── RETRIEVAL columns ──
    ret_cols    = [f"precision_at_{k}", f"recall_at_{k}", f"f1_at_{k}", "reciprocal_rank"]
    ret_display = [f"P@{k}", f"R@{k}", f"F1@{k}", "RR"]

    all_cols    = text_cols + (ret_cols if has_retrieval else [])
    all_display = text_display + (ret_display if has_retrieval else [])

    qw = 14
    mw = 14

    def sep():
        return "+" + f"{'-'*(qw+2)}+" + "+".join([f"{'-'*(mw+2)}"] * len(all_cols)) + "+"

    total_w = qw + (mw + 3) * len(all_cols) + 5

    def fmt(v) -> str:
        return f"{v:.4f}" if v is not None else "N/A   "

    print("\n" + "═" * total_w)
    print(f"{'📊  BẢNG KẾT QUẢ ĐÁNH GIÁ RAG':^{total_w}}")
    if not has_retrieval:
        print(f"{'(Retrieval metrics: chưa có relevant_chunk_ids)':^{total_w}}")
    print("═" * total_w)
    print(sep())
    print(
        "| " + f"{'Question ID':<{qw}}" + " | "
        + " | ".join(f"{n:<{mw}}" for n in all_display) + " |"
    )
    print(sep())

    for r in all_results:
        sc   = r.get("scores", {})
        vals = [fmt(sc.get(m)) for m in all_cols]
        status_icon = "✅" if r["status"] == "success" else "❌"
        print(
            "| " + f"{status_icon} {r['question_id']:<{qw-2}}" + " | "
            + " | ".join(f"{v:<{mw}}" for v in vals) + " |"
        )

    print(sep())

    avg_vals = [fmt(_avg(ok, m)) for m in all_cols]
    print(
        "| " + f"{'AVERAGE':<{qw}}" + " | "
        + " | ".join(f"{v:<{mw}}" for v in avg_vals) + " |"
    )
    print(sep())

    print("\n📈  Tổng hợp:")
    labels = dict(zip(all_cols, all_display))
    for m in all_cols:
        print(f"   {labels[m]:<18}  {_bar(_avg(ok, m))}")

    if not has_retrieval:
        print(
            "\n💡  Điền cột 'relevant_chunk_ids' vào ground truth để bật "
            f"P@{k} / R@{k} / F1@{k} / MRR."
        )
        print(
            f"    Gợi ý: xem field 'retrieved_chunk_ids' trong các file "
            f"{OUTPUT_DIR}/<question_id>.json vừa tạo."
        )
    print()


def export_png(all_results: list[dict], k: int, output_dir: Path) -> tuple[Path, Path]:
    """
    Xuất 2 file PNG riêng biệt:
      eval_table_overall.png    — Bảng 1: Overall
      eval_table_by_type.png    — Bảng 2: Theo query_type
    """
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.colors import LinearSegmentedColormap

    ok = [r for r in all_results if r["status"] == "success"]
    metric_cols = [
        (f"precision_at_{k}", f"Precision@"),
        (f"recall_at_{k}",    f"Recall@"),
        (f"f1_at_{k}",        "F1 Score"),
        ("reciprocal_rank",   "MRR"),
    ]

    def fmt(v): return f"{v:.3f}" if v is not None else "N/A"

    cmap = LinearSegmentedColormap.from_list("rg", ["#ff6b6b", "#ffd93d", "#6bcb77"])
    def score_color(val_str):
        try:
            v = float(val_str)
            r2, g, b, _ = cmap(v)
            return f"#{int(r2*255):02x}{int(g*255):02x}{int(b*255):02x}"
        except:
            return "#f0f0f0"

    def draw_and_save(rows, headers, title, filepath, figsize=(5.5, 3.5)):
        fig, ax = plt.subplots(figsize=figsize)
        ax.axis("off")
        table = ax.table(cellText=rows, colLabels=headers, loc="center", cellLoc="center")
        table.auto_set_font_size(False)
        table.set_fontsize(11)
        table.scale(1, 2.0)
        n_cols = len(headers)
        for col in range(n_cols):
            cell = table[0, col]
            cell.set_facecolor("#2d3436")
            cell.set_text_props(color="white", fontweight="bold")
            cell.set_edgecolor("#ffffff")
        for row_idx in range(1, len(rows) + 1):
            for col_idx in range(n_cols):
                cell = table[row_idx, col_idx]
                cell.set_edgecolor("#cccccc")
                if col_idx == 0:
                    cell.set_facecolor("#f8f9fa")
                else:
                    cell.set_facecolor(score_color(rows[row_idx - 1][col_idx]))
                    cell.set_text_props(fontweight="bold")
        ax.set_title(title, fontsize=12, fontweight="bold", color="#2d3436", pad=12)
        plt.tight_layout()
        fig.savefig(filepath, dpi=160, bbox_inches="tight", facecolor="white")
        plt.close(fig)

    output_dir.mkdir(parents=True, exist_ok=True)

    # ── File 1: Overall ──
    rows1    = [[label, fmt(_avg(ok, col))] for col, label in metric_cols]
    headers1 = ["Metric", "Score"]
    path1    = output_dir / "eval_table_overall.png"
    draw_and_save(rows1, headers1,
                  f"Ket qua Danh gia RAG — Overall  (K={k})",
                  path1, figsize=(5, 3.5))

    # ── File 2: By query_type ──
    types = ["global", "multi-hop", "single-hop"]
    by_type: dict[str, list] = {t: [] for t in types}
    for r in ok:
        qt = str(r.get("query_type") or "").lower().strip()
        if "multi" in qt:
            qt = "single-hop"
        elif "single" in qt:
            qt = "multi-hop"
        else:
            qt = "global"
        by_type[qt].append(r)

    rows2    = [[label] + [fmt(_avg(by_type[t], col)) for t in types]
                for col, label in metric_cols]
    headers2 = ["Metric", "Global", "Multi-hop", "Single-hop"]
    path2    = output_dir / "eval_table_by_type.png"
    draw_and_save(rows2, headers2,
                  f"Ket qua Danh gia RAG — Theo Query Type  (K={k})",
                  path2, figsize=(9, 3.5))

    return path1, path2



# ──────────────────────────────────────────────────────────────
# MAIN
# ──────────────────────────────────────────────────────────────

def main() -> None:
    print("🚀  RAG Evaluation Pipeline")
    print(f"    Ground Truth : {GROUND_TRUTH_FILE}")
    print(f"    Output Dir   : {OUTPUT_DIR}")
    print(f"    K            : {TOP_K}")
    print()

    print("⚙️   Khởi tạo services...")
    rag_service, embedding_service = build_services()
    print("✅  Kết nối Qdrant và OpenAI thành công.\n")

    ground_truths = load_ground_truth(GROUND_TRUTH_FILE)
    has_chunk_ids = any(item["relevant_chunk_ids"] for item in ground_truths)
    has_ctx_texts = any(item.get("relevant_context_texts", []) for item in ground_truths)
    has_query_type = any(item.get("query_type", "") for item in ground_truths)

    print(f"📂  Đã đọc {len(ground_truths)} câu hỏi")
    print(f"    Chunk ID mode    : {'✅' if has_chunk_ids else '—'}")
    print(f"    Context text mode: {'✅' if has_ctx_texts else '—'}")
    print(f"    Query type       : {'✅ (' + ', '.join(set(i['query_type'] for i in ground_truths if i.get('query_type'))) + ')' if has_query_type else '—'}\n")

    all_results: list[dict] = []
    run_timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

    for i, item in enumerate(ground_truths, 1):
        qid            = item["question_id"]
        question       = item["query"]
        expected       = item["ground_truth_answer"]
        relevant_ids   = item["relevant_chunk_ids"]
        relevant_texts = item.get("relevant_context_texts", [])
        query_type     = item.get("query_type", "")

        print(f"[{i:>3}/{len(ground_truths)}] {qid}: {question[:60]}...")

        result: dict = {
            "question_id"          : qid,
            "query_type"           : query_type,
            "input"                : question,
            "expected_output"      : expected,
            "relevant_chunk_ids"   : relevant_ids,
            "actual_output"        : None,
            "retrieved_chunk_ids"  : [],
            "retrieval_context"    : [],
            "retrieval_scoring_mode": "unscored",
            "retrieval_penalty_factor": 1.0,
            "retrieval_note"       : None,
            "scores"               : {},
            "status"               : "pending",
            "error"                : None,
            "timestamp"            : run_timestamp,
        }

        try:
            answer, retrieved_ids, context_texts = ask_rag(rag_service, question)
            result["actual_output"]       = answer
            result["retrieved_chunk_ids"] = retrieved_ids
            result["retrieval_context"]   = context_texts

            # Text metrics
            text_scores = compute_text_scores(answer, expected, embedding_service)
            result["scores"].update(text_scores)

            # Retrieval metrics — ưu tiên chunk ID, fallback context text
            # Nếu relevant_ids có nhưng retrieved_ids rỗng (bot không tìm thấy) → điểm 0
            if relevant_ids:
                if retrieved_ids:
                    ret_scores = compute_retrieval_scores(retrieved_ids, relevant_ids, k=TOP_K)
                else:
                    ret_scores = zero_retrieval_scores(TOP_K)
                result["retrieval_scoring_mode"] = "chunk_ids"
                result["retrieval_penalty_factor"] = 1.0
                result["retrieval_note"] = "Scored with relevant_chunk_ids."
                result["scores"].update(ret_scores)
            elif relevant_texts:
                raw_ret_scores = compute_retrieval_scores_from_text(
                    context_texts, relevant_texts, k=TOP_K,
                    embedding_service=embedding_service,
                )
                ret_scores = apply_retrieval_penalty(
                    raw_ret_scores or zero_retrieval_scores(TOP_K),
                    TEXT_FALLBACK_PENALTY_FACTOR,
                )
                result["retrieval_scoring_mode"] = "context_text_penalized"
                result["retrieval_penalty_factor"] = TEXT_FALLBACK_PENALTY_FACTOR
                result["retrieval_note"] = (
                    "Missing relevant_chunk_ids; used strict context-text fallback "
                    f"with penalty x{TEXT_FALLBACK_PENALTY_FACTOR:.2f}."
                )
                result["scores"].update(ret_scores)
            else:
                result["retrieval_scoring_mode"] = "missing_ground_truth_zeroed"
                result["retrieval_penalty_factor"] = 0.0
                result["retrieval_note"] = (
                    "Missing relevant_chunk_ids and relevant_context_texts; "
                    "retrieval metrics forced to 0 in strict mode."
                )
                result["scores"].update(zero_retrieval_scores(TOP_K))

            result["status"] = "success"

            p  = result["scores"].get(f"precision_at_{TOP_K}")
            r  = result["scores"].get(f"recall_at_{TOP_K}")
            f1 = result["scores"].get(f"f1_at_{TOP_K}")
            rr = result["scores"].get("reciprocal_rank")
            if p is not None:
                print(f"         ✅  P@{TOP_K}={p:.3f}  R@{TOP_K}={r:.3f}  F1={f1:.3f}  RR={rr:.3f}")
            else:
                print(f"         ✅  (không có relevant_chunk_ids → bỏ qua retrieval metrics)")

        except Exception as e:
            result["status"] = "error"
            result["error"]  = str(e)
            print(f"         ❌  Lỗi: {e}")

        save_result(OUTPUT_DIR, result)
        all_results.append(result)

        if i < len(ground_truths):
            time.sleep(REQUEST_DELAY)

    # Lưu summary JSON
    summary_path = OUTPUT_DIR / f"summary_{run_timestamp}.json"
    with open(summary_path, "w", encoding="utf-8") as f:
        json.dump(all_results, f, ensure_ascii=False, indent=2)

    print(f"\n💾  Lưu {len(all_results)} file JSON vào : {OUTPUT_DIR}/")
    print(f"💾  Summary                    : {summary_path}")

    # Xuất 2 file PNG
    try:
        path1, path2 = export_png(all_results, k=TOP_K, output_dir=OUTPUT_DIR)
        print(f"🖼️   Bảng Overall              : {path1}")
        print(f"🖼️   Bảng theo Query Type      : {path2}")
    except Exception as e:
        print(f"⚠️   Không xuất được ảnh: {e}")


if __name__ == "__main__":
    main()
