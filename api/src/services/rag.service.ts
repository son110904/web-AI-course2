import { Ollama } from 'ollama';
import { DatabaseModel, SearchResult, ChatMessage } from '../models/database.model';
import { EmbeddingService } from './embedding.service';

export class RAGService {
  private ollama: Ollama;

  constructor(
    private db: DatabaseModel,
    private embeddingService: EmbeddingService,
    ollamaHost: string,
    private ollamaModel: string
  ) {
    this.ollama = new Ollama({ host: ollamaHost });
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

    // 3. Search với metadata filters
    const rawChunks = await this.db.searchSimilarChunks(
      embedding,
      15,
      filters
    );

    console.log(`📊 Retrieved ${rawChunks.length} chunks`);

    if (rawChunks.length === 0) {
      return this.noContext();
    }

    // 4. Re-rank với metadata awareness
    const reranked = this.rerankWithMetadata(rawChunks, query);

    console.log('\n🔁 Top 5 after re-rank:');
    reranked.slice(0, 5).forEach((c, i) => {
      console.log(
        `#${i + 1} | ${(c.similarity * 100).toFixed(1)}% | ${c.document_type} | ${c.metadata.source_file}`
      );
    });

    // 5. Threshold filtering
    const MIN_TOP = 0.45;
    const MIN_CHUNK = 0.4;

    const top = reranked[0];
    if (top.similarity < MIN_TOP) {
      console.log('❌ Similarity too low');
      return this.noContext();
    }

    const selectedChunks = reranked
      .filter(c => c.similarity >= MIN_CHUNK)
      .slice(0, 4);

    if (selectedChunks.length === 0) {
      return this.noContext();
    }

    // 6. Build context
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
    const q = query.toLowerCase();
    const filters: any = {};

    // Detect document type
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

    // Detect major
    if (q.includes('công nghệ thông tin') || q.includes('cntt')) {
      filters.metadata_filters = {
        ...filters.metadata_filters,
        major: 'Công nghệ thông tin'
      };
    } else if (q.includes('khoa học máy tính') || q.includes('khmt')) {
      filters.metadata_filters = {
        ...filters.metadata_filters,
        major: 'Khoa học máy tính'
      };
    }

    // Detect subject code (e.g., CNTT1153)
    const codeMatch = q.match(/[a-z]{2,4}\s*\d{3,4}/i);
    if (codeMatch) {
      const code = codeMatch[0].replace(/\s+/g, '').toUpperCase();
      filters.metadata_filters = {
        ...filters.metadata_filters,
        subject_code: code
      };
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

    return chunks
      .map(c => {
        let bonus = 0;
        const meta = c.metadata;

        // 1. Prioritize specific document types
        if (c.document_type === 'syllabus') {
          // Syllabus có ưu tiên cao cho câu hỏi về môn học
          if (
            q.includes('học phần') ||
            q.includes('môn') ||
            q.includes('đề cương')
          ) {
            bonus += 0.15;
          }

          // Boost nếu match subject code
          if (meta.subject_code && q.includes(meta.subject_code.toLowerCase())) {
            bonus += 0.25;
          }

          // Boost nếu match subject name
          if (meta.subject_name && q.includes(meta.subject_name.toLowerCase())) {
            bonus += 0.2;
          }
        }

        if (c.document_type === 'regulation') {
          // Regulation có ưu tiên cao cho câu hỏi về quy định
          if (
            q.includes('quy định') ||
            q.includes('quy chế') ||
            q.includes('điều kiện') ||
            q.includes('tốt nghiệp')
          ) {
            bonus += 0.15;
          }

          // Penalize expired regulations
          if (meta.effective_status === 'expired') {
            bonus -= 0.3;
          }
        }

        if (c.document_type === 'curriculum') {
          // CTĐT có ưu tiên cho câu hỏi về chương trình
          if (
            q.includes('chương trình') ||
            q.includes('ctđt') ||
            q.includes('tổng số tín chỉ')
          ) {
            bonus += 0.15;
          } else {
            // Giảm CTĐT cho các câu hỏi cụ thể
            bonus -= 0.1;
          }
        }

        // 2. Major matching
        if (meta.major) {
          const majorLower = meta.major.toLowerCase();
          if (q.includes(majorLower)) {
            bonus += 0.1;
          }
        }

        // 3. Recent year bonus
        const year = meta.academic_year || meta.admission_from_year || meta.issued_year;
        if (year) {
          const yearNum = typeof year === 'string' ? parseInt(year) : year;
          if (yearNum >= 2024) {
            bonus += 0.05;
          } else if (yearNum < 2020) {
            bonus -= 0.1;
          }
        }

        return {
          ...c,
          similarity: Math.min(c.similarity + bonus, 1)
        };
      })
      .sort((a, b) => b.similarity - a.similarity);
  }

  /* =====================================================
     CONTEXT BUILDER WITH METADATA
  ====================================================== */
  private buildContextWithMetadata(chunks: SearchResult[]): string {
    return chunks
      .map((c, i) => {
        const meta = c.metadata;
        let header = `[Tài liệu ${i + 1} | ${(c.similarity * 100).toFixed(0)}%]`;

        // Add specific metadata based on type
        if (c.document_type === 'syllabus') {
          header += `\nLoại: Đề cương môn học`;
          if (meta.subject_name) header += `\nMôn: ${meta.subject_name}`;
          if (meta.subject_code) header += ` (${meta.subject_code})`;
          if (meta.credits) header += `\nSố tín chỉ: ${meta.credits}`;
          if (meta.major) header += `\nNgành: ${meta.major}`;
        } else if (c.document_type === 'regulation') {
          header += `\nLoại: Quy định`;
          if (meta.regulation_type) header += `\nPhân loại: ${meta.regulation_type}`;
          if (meta.decision_number) header += `\nSố QĐ: ${meta.decision_number}`;
          if (meta.effective_status) header += `\nTrạng thái: ${meta.effective_status}`;
        } else if (c.document_type === 'curriculum') {
          header += `\nLoại: Chương trình đào tạo`;
          if (meta.program_name) header += `\nChương trình: ${meta.program_name}`;
          if (meta.major_code) header += `\nMã ngành: ${meta.major_code}`;
          if (meta.total_credits) header += `\nTổng tín chỉ: ${meta.total_credits}`;
        }

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
    // Build source list
    const sources = chunks
      .map(c => {
        const meta = c.metadata;
        if (c.document_type === 'syllabus') {
          return `- Đề cương: ${meta.subject_name} (${meta.subject_code})`;
        } else if (c.document_type === 'regulation') {
          return `- Quy định: ${meta.source_file}`;
        } else {
          return `- CTĐT: ${meta.major || meta.program_name}`;
        }
      })
      .join('\n');

    const systemPrompt = `Bạn là trợ lý AI của Đại học Kinh tế Quốc dân.

NGUYÊN TẮC:
- Chỉ sử dụng thông tin trong TÀI LIỆU.
- Ưu tiên thông tin từ tài liệu cụ thể (đề cương, quy định) hơn CTĐT tổng quát.
- Trích dẫn rõ nguồn (tên môn, số quyết định, v.v.).
- Nếu không đủ thông tin, trả lời: "Không tìm thấy thông tin."`;

    const res = await this.ollama.chat({
      model: this.ollamaModel,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `TÀI LIỆU THAM KHẢO:\n${context}\n\nCÂU HỎI:\n${query}\n\nHãy trả lời dựa trên tài liệu trên.`
        }
      ],
      stream: false,
      options: {
        temperature: 0.2,
        top_p: 0.9,
        num_ctx: 4096
      }
    });

    const answer = res.message.content.trim();

    // Append sources
    return answer;
  }

  private noContext(): string {
    return 'Không tìm thấy thông tin phù hợp trong tài liệu. Vui lòng liên hệ phòng Đào tạo để được hỗ trợ.';
  }
}
