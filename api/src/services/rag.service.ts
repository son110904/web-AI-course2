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
     MAIN ENTRY
  ====================================================== */
  async chat(messages: ChatMessage[]): Promise<string> {
    /* ========= 1. SANITIZE INPUT ========= */
    const userMessage = messages.filter(m => m.role === 'user').pop();
    if (!userMessage) {
      return 'Không có câu hỏi hợp lệ.';
    }

    const query = userMessage.content.trim();
    console.log('\n🔥 RAGService.chat()');
    console.log('🔍 Query:', query);

    /* ========= 2. EMBEDDING ========= */
    const embedding = await this.embeddingService.generateEmbedding(query);
    console.log('Embedding length:', embedding.length);

    /* ========= 3. VECTOR RETRIEVAL ========= */
    const rawChunks = await this.db.searchSimilarChunks(
      embedding,
      15 // TOP-K đủ lớn để tránh CTĐT đè
    );

    console.log('Chunks retrieved:', rawChunks.length);

    rawChunks.forEach((c, i) => {
      console.log(`--- Chunk ${i + 1} ---`);
      console.log('Similarity:', c.similarity.toFixed(3));
      console.log('Source:', c.source_file);
      console.log('Preview:', c.content.slice(0, 150));
    });

    if (rawChunks.length === 0) {
      return this.noContext();
    }

    /* ========= 4. RE-RANK (DOCUMENT-AWARE) ========= */
    const reranked = this.rerankChunks(rawChunks, query);

    console.log('\n🔁 After re-rank');
    reranked.slice(0, 5).forEach((c, i) => {
      console.log(
        `#${i + 1} | ${(c.similarity * 100).toFixed(1)}% | ${c.source_file}`
      );
    });

    /* ========= 5. THRESHOLD ========= */
    const MIN_TOP = 0.45;
    const MIN_CHUNK = 0.4;

    const top = reranked[0];
    console.log('Top similarity:', top.similarity);

    if (top.similarity < MIN_TOP) {
      console.log('❌ Top similarity below threshold');
      return this.noContext();
    }

    const selectedChunks = reranked
      .filter(c => c.similarity >= MIN_CHUNK)
      .slice(0, 4);

    if (selectedChunks.length === 0) {
      return this.noContext();
    }

    /* ========= 6. BUILD CONTEXT ========= */
    const context = this.buildContext(selectedChunks);

    console.log('\n🧠 FINAL CONTEXT');
    console.log(context);
    console.log('Context length:', context.length);

    if (context.length < 50) {
      return this.noContext();
    }

    /* ========= 7. LLM GENERATION ========= */
    return await this.generateResponse(query, context);
  }

  /* =====================================================
     RE-RANKING
     - Ưu tiên tài liệu chuyên biệt
     - Giảm CTĐT tổng quát
     - Boost theo trùng tên tài liệu
  ====================================================== */
  private rerankChunks(
    chunks: SearchResult[],
    query: string
  ): SearchResult[] {
    const q = query.toLowerCase();

    return chunks
      .map(c => {
        let bonus = 0;
        const source = c.source_file.toLowerCase();

        // 1️⃣ Ưu tiên đề cương / học phần / chuyên đề
        if (
          source.includes('công nghệ') ||
          source.includes('lập trình') ||
          source.includes('chuyên đề') ||
          source.includes('học phần')
        ) {
          bonus += 0.12;
        }

        // 2️⃣ Giảm CTĐT (rất quan trọng)
        if (
          source.includes('ctđt') ||
          source.includes('chương trình đào tạo')
        ) {
          bonus -= 0.12;
        }

        // 3️⃣ Boost nếu query nhắc đến tên tài liệu
        const normalizedSource = source.replace('.docx', '');
        if (q.includes(normalizedSource)) {
          bonus += 0.2;
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
  ====================================================== */
  private buildContext(chunks: SearchResult[]): string {
    return chunks
      .map(
        (c, i) =>
          `[Tài liệu ${i + 1} | ${(c.similarity * 100).toFixed(0)}% | ${c.source_file}]
${c.content}`
      )
      .join('\n\n');
  }

  /* =====================================================
     LLM RESPONSE
  ====================================================== */
  private async generateResponse(
    query: string,
    context: string
  ): Promise<string> {
    const systemPrompt = `Bạn là trợ lý AI của Đại học Kinh tế Quốc dân.

NGUYÊN TẮC:
- Chỉ sử dụng thông tin trong TÀI LIỆU.
- Không suy diễn, không bịa.
- Nếu không đủ thông tin, trả lời: "Không tìm thấy thông tin trong tài liệu."`;

    const res = await this.ollama.chat({
      model: this.ollamaModel,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `TÀI LIỆU:\n${context}\n\nCÂU HỎI:\n${query}`
        }
      ],
      stream: false,
      options: {
        temperature: 0.2,
        top_p: 0.9,
        num_ctx: 4096
      }
    });

    return res.message.content.trim();
  }

  /* =====================================================
     FALLBACK
  ====================================================== */
  private noContext(): string {
    return 'Không tìm thấy thông tin trong tài liệu.';
  }

  private buildConversationContext(history: ChatMessage[]): string {
    const recent = history
      .filter(message => message.role === 'user' && message.content.trim())
      .slice(-4)
      .map((message, index) => `Người dùng ${index + 1}: ${message.content}`);
    return recent.join('\n');
  }
}