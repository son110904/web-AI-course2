// services/queryExpansion.service.ts
// phai lap ra 1 list query synonyms
//co the them sau này: queryExpansion.llm.ts

const QUERY_SYNONYMS: Record<string, string[]> = {
    "khóa luận": [
        "khóa luận tốt nghiệp",
        "quy trình thực hiện khóa luận",
        "hướng dẫn làm khóa luận",
        "đề cương khóa luận"
    ],
    "đồ án": [
        "đồ án môn học",
        "đồ án tốt nghiệp"
    ],
    "ai là người dạy": [
        "giảng viên",
        "thầy",
        "cô",
        "thầy cô"
    ]
};

export function expandQuery(query: string): string[] {
    const expanded = new Set<string>();
    expanded.add(query);

    const lowerQuery = query.toLowerCase();

    for (const key in QUERY_SYNONYMS) {
        if (lowerQuery.includes(key)) {
            QUERY_SYNONYMS[key].forEach(q => expanded.add(q));
        }
    }

    return Array.from(expanded);
}
