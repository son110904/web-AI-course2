import { DatabaseModel, SearchResult, ChatMessage } from '../models/database.model';
import { EmbeddingService } from './embedding.service';

type OpenAIChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export class RAGService {
  private openaiBaseUrl: string;
  private openaiTimeoutMs: number;

  constructor(
    private db: DatabaseModel,
    private embeddingService: EmbeddingService,
    private openaiApiKey: string,
    private openaiChatModel: string,
    openaiBaseUrl?: string,
    openaiTimeoutMs?: number
  ) {
    this.openaiBaseUrl = (openaiBaseUrl || 'https://api.openai.com').replace(/\/+$/, '');
    this.openaiTimeoutMs = openaiTimeoutMs ?? 60_000;
  }

  /* =====================================================
     MAIN ENTRY - Metadata-aware
  ====================================================== */
  async chat(messages: ChatMessage[]): Promise<string> {
    const userMessage = messages.filter(m => m.role === 'user').pop();
    if (!userMessage) {
      return 'Không có câu hỏi hợp lệ.';
    }

    const query = userMessage.content.trim();
    console.log('\n🔥 RAGService.chat()');
    console.log('🔍 Query:', query);

    // 1. Detect intent & metadata filters
    const filters = this.detectQueryIntent(query);
    console.log('🎯 Detected filters:', filters);

    // 2. Generate embedding
    const embedding = await this.embeddingService.generateEmbedding(query);

    // 3. Vector search with metadata filters
    const rawChunks = await this.db.searchSimilarChunks(
      embedding,
      15,
      filters
    );

    console.log(`📊 Retrieved ${rawChunks.length} chunks`);

    rawChunks.forEach((c, i) => {
      console.log(
        `#${i + 1} | ${(c.similarity * 100).toFixed(1)}% | ${c.document_type} | ${c.metadata?.source_file}`
      );
    });

    if (rawChunks.length === 0) {
      return this.noContext();
    }

    // 4. Re-rank with metadata awareness
    let reranked = this.rerankWithMetadata(rawChunks, query);

    // Explicit source file mention
    const fileMention = this.detectMentionedSourceFile(query, reranked);
    if (fileMention) {
      reranked = reranked.filter(c => c.metadata?.source_file === fileMention);
      console.log(`INFO: Restricting to source file: ${fileMention}`);
    }

    // Expand syllabus → subject-level search
    let expandedBySubject = false;
    const topAfterFilter = reranked[0];

    if (
      topAfterFilter?.document_type === 'syllabus' &&
      this.queryMentionsSubject(query, topAfterFilter.metadata)
    ) {
      const subjectFilters = topAfterFilter.metadata.subject_code
        ? { metadata_filters: { subject_code: topAfterFilter.metadata.subject_code } }
        : { metadata_filters: { subject_name: topAfterFilter.metadata.subject_name } };

      const subjectChunks = await this.db.searchSimilarChunks(
        embedding,
        100,
        subjectFilters
      );

      if (subjectChunks.length > 0) {
        reranked = this.rerankWithMetadata(subjectChunks, query);
        expandedBySubject = true;
        console.log(`INFO: Expanded to ${subjectChunks.length} chunks for subject`);
      }
    }

    console.log('\n🔁 Top 5 after re-rank:');reranked.slice(0, 5).forEach((c, i) => {
      console.log(
        `#${i + 1} | ${(c.similarity * 100).toFixed(1)}% | ${c.document_type} | ${c.metadata?.source_file}`
      );
    });

    // 5. Threshold filtering
    const MIN_TOP = 0.45;
    const MIN_CHUNK = 0.4;

    const top = reranked[0];
    if (!top || top.similarity < MIN_TOP) {
      console.log('❌ Similarity too low');
      return this.noContext();
    }

    const selectedChunks = expandedBySubject
      ? reranked.slice(0, 8)
      : reranked.filter(c => c.similarity >= MIN_CHUNK).slice(0, 4);

    if (selectedChunks.length === 0) {
      return this.noContext();
    }

    // 6. Build context
    // ⚠️ chunk.content đã chứa tên tài liệu từ DocumentService
    const context = this.buildContextWithMetadata(selectedChunks);

    console.log('\n🧠 CONTEXT LENGTH:', context.length);

    if (context.length < 50) {
      return this.noContext();
    }

    // 7. Generate response
    return await this.generateResponse(query, context, selectedChunks);
  }

  /* =====================================================
     QUERY INTENT DETECTION
  ====================================================== */
  private detectQueryIntent(query: string): {
    document_type?: string;
    metadata_filters?: Record<string, any>;
  } {
    const q = this.normalizeForMatch(query);
    const filters: any = {};

    if (
      q.includes('đề cương') ||
      q.includes('syllabus') ||
      q.includes('học phần') ||
      q.includes('môn học')
    ) {
      filters.document_type = 'syllabus';
    } else if (
      q.includes('chương trình đào tạo') ||
      q.includes('ctđt') ||
      q.includes('curriculum')
    ) {
      filters.document_type = 'curriculum';
    } else if (
      q.includes('quy định') ||
      q.includes('quy chế') ||
      q.includes('quyết định')
    ) {
      filters.document_type = 'regulation';
    }

    if (q.includes('công nghệ thông tin') || q.includes('cntt')) {
      filters.metadata_filters = { ...filters.metadata_filters, major: 'Công nghệ thông tin' };
    } else if (q.includes('khoa học máy tính') || q.includes('khmt')) {
      filters.metadata_filters = { ...filters.metadata_filters, major: 'Khoa học máy tính' };
    }

    const codeMatch = q.match(/[a-z]{2,4}\s*\d{3,4}/i);
    if (codeMatch) {
      const code = codeMatch[0].replace(/\s+/g, '').toUpperCase();
      filters.metadata_filters = { ...filters.metadata_filters, subject_code: code };
    }

    return filters;
  }

  /* =====================================================
     RE-RANK WITH METADATA
  ====================================================== */
  private rerankWithMetadata(
    chunks: SearchResult[],
    query: string
  ): SearchResult[] {
    const q = query.toLowerCase();
    const qNormalized = this.normalizeForMatch(query);

    return chunks
      .map(c => {
        let bonus = 0;
        const meta = c.metadata || {};// Boost if query explicitly mentions source file
        if (this.queryMentionsSourceFile(qNormalized, meta.source_file)) {
          bonus += 0.3;
        }

        if (c.document_type === 'syllabus') {
          if (q.includes('học phần') || q.includes('môn') || q.includes('đề cương')) {
            bonus += 0.15;
          }
          if (meta.subject_code && q.includes(meta.subject_code.toLowerCase())) {
            bonus += 0.25;
          }
          bonus += this.getNameMatchBonus(qNormalized, meta.subject_name);
        }

        if (c.document_type === 'regulation') {
          const isSpecific =
            meta.decision_number ||
            meta.source_file?.toLowerCase().includes('qđ') ||
            meta.source_file?.toLowerCase().includes('quyết định');

          const isGeneral =
            meta.source_file?.toLowerCase().includes('quy chế đào tạo') ||
            meta.source_file?.toLowerCase().includes('quy chế tuyển sinh');

          if (isSpecific) {
            bonus += 0.2;
            if (q.includes('rèn luyện') && meta.source_file?.toLowerCase().includes('rèn luyện')) {
              bonus += 0.25;
            }
            if (q.includes('đánh giá') && meta.source_file?.toLowerCase().includes('đánh giá')) {
              bonus += 0.15;
            }
          } else if (isGeneral) {
            if (q.includes('quy định') || q.includes('quy chế')) {
              bonus += 0.05;
            }
            if (q.includes('ban hành') || q.includes('quyết định')) {
              bonus -= 0.1;
            }
          } else {
            if (q.includes('quy định') || q.includes('quy chế')) {
              bonus += 0.12;
            }
          }

          if (meta.effective_status === 'expired') {
            bonus -= 0.3;
          }
        }

        if (c.document_type === 'curriculum') {
          if (
            q.includes('chương trình') ||
            q.includes('ctđt') ||
            q.includes('tổng số tín chỉ')
          ) {
            bonus += 0.15;
          } else {
            bonus -= 0.1;
          }
          bonus += this.getNameMatchBonus(qNormalized, meta.program_name);
        }

        if (meta.major) {
          bonus += this.getNameMatchBonus(qNormalized, meta.major);
        }

        const year = meta.academic_year || meta.admission_from_year || meta.issued_year;
        if (year) {
          const yearNum = typeof year === 'string' ? parseInt(year) : year;
          if (yearNum >= 2024) bonus += 0.05;
          else if (yearNum < 2020) bonus -= 0.1;
        }

        return {
          ...c,
          similarity: Math.min(c.similarity + bonus, 1)
        };
      })
      .sort((a, b) => b.similarity - a.similarity);
  }

  /* =====================================================
     CONTEXT BUILDER
  ====================================================== */private buildContextWithMetadata(chunks: SearchResult[]): string {
    return chunks
      .map((c, i) => {
        let header = `[Tài liệu ${i + 1} | ${(c.similarity * 100).toFixed(0)}%]`;

        return `${header}\n\n${c.content}`;
      })
      .join('\n\n---\n\n');
  }

  /* =====================================================
     LLM GENERATION
  ====================================================== */
  private async generateResponse(
    query: string,
    context: string,
    chunks: SearchResult[]
  ): Promise<string> {
    const systemPrompt = `Bạn là trợ lý AI của Đại học Kinh tế Quốc dân.

NGUYÊN TẮC:
- Ưu tiên thông tin trong TÀI LIỆU.
- Trích dẫn rõ nguồn (tên môn, số quyết định).
- Nếu không đủ thông tin, nói rõ không tìm thấy.`;

    const content = `TÀI LIỆU THAM KHẢO:\n${context}\n\nCÂU HỎI:\n${query}`;

    const messages: OpenAIChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content }
    ];

    return await this.openaiChat(messages, {
      temperature: 0.2,
      top_p: 0.9
    });
  }

  private async openaiChat(
    messages: OpenAIChatMessage[],
    options: { temperature?: number; top_p?: number } = {}
  ): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.openaiTimeoutMs);

    try {
      const res = await fetch(`${this.openaiBaseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.openaiApiKey}`
        },
        body: JSON.stringify({
          model: this.openaiChatModel,
          messages,
          temperature: options.temperature ?? 0.2,
          top_p: options.top_p ?? 0.9
        }),
        signal: controller.signal
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`OpenAI error (${res.status}): ${text || res.statusText}`);
      }

      const data: any = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) {
        throw new Error('OpenAI returned empty response content');
      }

      return content.trim();
    } finally {
      clearTimeout(timeout);
    }
  }

  /* =====================================================
     HELPERS
  ====================================================== */
  private normalizeForMatch(text: string): string {
    return text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private queryMentionsSourceFile(queryNormalized: string, sourceFile?: string): boolean {
    if (!sourceFile) return false;
    const full = this.normalizeForMatch(sourceFile);
    const noExt = this.normalizeForMatch(sourceFile.replace(/\.[^/.]+$/, ''));
    return queryNormalized.includes(full) || queryNormalized.includes(noExt);
  }

  private getNameMatchBonus(queryNormalized: string, name?: string): number {
    if (!name) return 0;
    const nameNormalized = this.normalizeForMatch(name);
    if (!nameNormalized) return 0;

    if (queryNormalized.includes(nameNormalized)) {
      return 0.25;
    }

    const tokens = nameNormalized.split(' ').filter(t => t.length >= 3);
    return tokens.some(t => queryNormalized.includes(t)) ? 0.1 : 0;
  }

  private detectMentionedSourceFile(query: string, chunks: SearchResult[]): string | null {
    const q = this.normalizeForMatch(query);
    const matches = chunks
      .map(c => c.metadata?.source_file)
      .filter((f): f is string => !!f)
      .filter(f => this.queryMentionsSourceFile(q, f));

    return matches.length > 0 ? matches[0] : null;
  }

  private queryMentionsSubject(query: string, meta: Record<string, any>): boolean {
    const q = this.normalizeForMatch(query);
    if (meta?.subject_code && q.includes(this.normalizeForMatch(meta.subject_code))) return true;if (meta?.subject_name && q.includes(this.normalizeForMatch(meta.subject_name))) return true;
    return false;
  }

  private noContext(): string {
    return 'Không tìm thấy thông tin phù hợp trong tài liệu.';
  }
}
