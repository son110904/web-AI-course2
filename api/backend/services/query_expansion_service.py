from __future__ import annotations

import re

QUERY_SYNONYMS: dict[str, list[str]] = {
    "khoa luan": ["khoa luan tot nghiep", "luan van", "thesis"],
    "do an": ["do an mon hoc", "do an tot nghiep", "project"],
    "giang vien": ["thay", "co", "giao vien", "lecturer", "instructor"],
    "tin chi": ["credits", "so tin chi", "tc"],
    "mon hoc": ["hoc phan", "course", "subject"],
    "quy dinh": ["quy che", "regulation", "rule", "policy"],
}


def _escape_regexp(value: str) -> str:
    return re.escape(value)


def expand_query(query: str) -> list[str]:
    expanded: set[str] = {query}
    lower_query = str(query or "").lower()

    for key, synonyms in QUERY_SYNONYMS.items():
        if key in lower_query:
            pattern = re.compile(_escape_regexp(key), flags=re.IGNORECASE)
            for synonym in synonyms:
                expanded.add(synonym)
                expanded.add(pattern.sub(synonym, query))

    stripped_mon = re.sub(r"\bmon\s+(?!hoc\b)", "", query, flags=re.IGNORECASE)
    stripped_mon = re.sub(r"\s+", " ", stripped_mon).strip()
    if stripped_mon and stripped_mon != query:
        expanded.add(stripped_mon)

    return list(expanded)


def get_synonyms(keyword: str) -> list[str]:
    return QUERY_SYNONYMS.get(str(keyword or "").lower(), [])


def contains_keywords(query: str, keywords: list[str]) -> bool:
    lower_query = str(query or "").lower()
    return any(keyword.lower() in lower_query for keyword in keywords)
