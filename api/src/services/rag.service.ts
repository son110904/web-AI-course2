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

  async chat(messages: ChatMessage[]): Promise<string> {
    try {
      const userMessage = messages[messages.length - 1];
      const query = userMessage.content;
      const conversationContext = this.buildConversationContext(
        messages.slice(0, -1)
      );

      console.log(`\n🔍 User query: "${query}"`);

      if (this.isGreeting(query)) {
        return this.getGreetingResponse();
      }

      const isProcess = this.isProcessQuery(query);
      if (isProcess) {
        console.log('✓ Detected PROCESS query');
      }

      const expandedQueries = this.expandQuery(query);
      console.log('✓ Expanded queries:', expandedQueries);

      const metadataFilters = this.extractMetadataFilters(query);
      if (metadataFilters) {
        console.log('✓ Metadata filters:', metadataFilters);
      }

      let allChunks: SearchResult[] = [];

      for (const q of expandedQueries) {
        const embedding = await this.embeddingService.generateEmbedding(q);
        let chunks = await this.db.searchSimilarChunks(
          embedding,
          8,
          metadataFilters || undefined
        );

        // Relax filter nếu bị quá chặt
        if (chunks.length === 0 && metadataFilters?.document_type) {
          console.log('⚠️ Relaxing metadata filter...');
          chunks = await this.db.searchSimilarChunks(embedding, 8, {
            major: metadataFilters.major,
          });
        }

        allChunks.push(...chunks);
      }

      const uniqueChunks = this.deduplicateAndSort(allChunks);
      console.log(`✓ Found ${uniqueChunks.length} unique chunks`);

      if (uniqueChunks.length === 0 && !conversationContext) {
        return this.getNoContextResponse(query);
      }

      const thresholds = this.getAdaptiveThresholds(query);
      const topSimilarity = uniqueChunks[0]?.similarity ?? 0;

      console.log(`✓ Top similarity: ${(topSimilarity * 100).toFixed(1)}%`);
      console.log(`✓ Threshold: ${(thresholds.minTop * 100).toFixed(1)}%`);

      if (topSimilarity < thresholds.minTop && !conversationContext) {
        return this.getNoContextResponse(query);
      }

      const goodChunks = uniqueChunks
        .filter(c => c.similarity >= thresholds.minChunk)
        .slice(0, 5);

      if (goodChunks.length === 0 && !conversationContext) {
        return this.getNoContextResponse(query);
      }

      const enrichedChunks = this.includeNeighborChunks(
        goodChunks,
        uniqueChunks
      );

      const context = this.buildContext(enrichedChunks);

      if (context.length < 50 && !conversationContext) {
        return this.getNoContextResponse(query);
      }

      return await this.generateResponse(
        query,
        context,
        conversationContext,
        messages,
        topSimilarity,
        isProcess
      );

    } catch (err: any) {
      console.error('❌ RAG error:', err.message);
      throw err;
    }
  }

  /* =========================
     INTENT DETECTION
  ========================== */
  private isProcessQuery(query: string): boolean {
    const lower = query.toLowerCase();
    return [
      'quy trình',
      'các bước',
      'trình tự',
      'làm như thế nào',
      'hướng dẫn',
      'thực hiện'
    ].some(k => lower.includes(k));
  }

  /* =========================
     QUERY EXPANSION (FIXED)
  ========================== */
  private expandQuery(query: string): string[] {
    const queries = [query];
    const lower = query.toLowerCase();
    const isProcess = this.isProcessQuery(query);

    if (lower.includes('khóa luận') || lower.includes('khoa luan')) {
      if (isProcess) {
        queries.push('quy trình thực hiện khóa luận tốt nghiệp');
        queries.push('các bước làm khóa luận tốt nghiệp');
        queries.push('hướng dẫn thực hiện khóa luận');
      } else {
        queries.push('điều kiện làm khóa luận tốt nghiệp');
        queries.push('quy định khóa luận tốt nghiệp');
      }
    }

    if (lower.includes('đề cương')) {
      queries.push('đề cương khóa luận');
    }

    if (/(cntt|công nghệ thông tin|it)/i.test(query)) {
      queries.push('khóa luận tốt nghiệp CNTT');
    }

    return [...new Set(queries)].slice(0, 4);
  }

  /* =========================
     THRESHOLD (FIXED)
  ========================== */
  private getAdaptiveThresholds(query: string): {
    minTop: number;
    minChunk: number;
  } {
    if (this.isProcessQuery(query)) {
      return { minTop: 0.62, minChunk: 0.5 };
    }
    return { minTop: 0.72, minChunk: 0.55 };
  }

  /* =========================
     METADATA FILTER (FIXED)
  ========================== */
  private extractMetadataFilters(query: string): {
    document_type?: string;
    major?: string;
  } | null {
    const lower = query.toLowerCase();
    const filters: any = {};

    const isProcess = this.isProcessQuery(query);

    if (!isProcess && lower.includes('quy định')) {
      filters.document_type = 'quy_dinh';
    }

    if (/(cntt|công nghệ thông tin|it)/i.test(query)) {
      filters.major = 'CNTT';
    }

    if (Object.keys(filters).length === 0) return null;
    return filters;
  }

  /* =========================
     RESPONSE GENERATION
  ========================== */
  private async generateResponse(
    query: string,
    context: string,
    conversationContext: string,
    history: ChatMessage[],
    topSimilarity: number,
    isProcess: boolean
  ): Promise<string> {

    const systemPrompt = `
Bạn là trợ lý AI của Đại học Kinh tế Quốc dân.

NGUYÊN TẮC:
1. Chỉ sử dụng thông tin trong CONTEXT hoặc THÔNG TIN NGƯỜI DÙNG CUNG CẤP.
2. Không suy diễn, không bịa đặt.
3. Nếu không đủ thông tin, trả lời:
   "Không tìm thấy thông tin trong tài liệu."

${isProcess ? `
Nếu câu hỏi là QUY TRÌNH / CÁC BƯỚC:
- Trả lời dạng danh sách đánh số (1,2,3…)
- Mỗi bước ngắn gọn
` : ''}
`;

    const userPrompt = `
THÔNG TIN NGƯỜI DÙNG CUNG CẤP:
${conversationContext || 'Không có'}

TÀI LIỆU:
${context || 'Không có'}

CÂU HỎI:
${query}
`;

    const res = await this.ollama.chat({
      model: this.ollamaModel,
      messages: [
        { role: 'system', content: systemPrompt },
        ...history.slice(-2, -1),
        { role: 'user', content: userPrompt },
      ],
      stream: false,
      options: {
        temperature: 0.2,
        top_p: 0.9,
        num_ctx: 4096,
      },
    });

    return res.message.content.trim();
  }

  /* =========================
     HELPERS
  ========================== */
  private deduplicateAndSort(chunks: SearchResult[]): SearchResult[] {
    const map = new Map<string, SearchResult>();
    for (const c of chunks) {
      if (!c?.content) continue;
      const key = c.content.trim();
      if (!map.has(key) || c.similarity > map.get(key)!.similarity) {
        map.set(key, c);
      }
    }
    return [...map.values()].sort((a, b) => b.similarity - a.similarity);
  }

  private includeNeighborChunks(
    primary: SearchResult[],
    all: SearchResult[]
  ): SearchResult[] {
    const map = new Map<string, SearchResult>();
    const add = (c?: SearchResult) => {
      if (c && c.chunk_id && !map.has(c.chunk_id)) {
        map.set(c.chunk_id, c);
      }
    };
    primary.forEach(add);
    primary.forEach(c => {
      all
        .filter(
          x =>
            x.source_file === c.source_file &&
            Math.abs(x.chunk_index - c.chunk_index) === 1
        )
        .forEach(add);
    });
    return [...map.values()];
  }

  private buildContext(chunks: SearchResult[]): string {
    return chunks
      .map(
        (c, i) =>
          `[Tài liệu ${i + 1} | ${(c.similarity * 100).toFixed(0)}%]\n${c.content}`
      )
      .join('\n\n');
  }

  private isGreeting(query: string): boolean {
    return ['xin chào', 'chào', 'hello', 'hi'].includes(
      query.toLowerCase().trim()
    );
  }

  private getGreetingResponse(): string {
    return 'Xin chào! Tôi có thể hỗ trợ bạn về chương trình đào tạo, quy chế, và khóa luận tốt nghiệp.';
  }

  private getNoContextResponse(_: string): string {
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
