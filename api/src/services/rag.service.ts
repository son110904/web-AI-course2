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

      console.log(`\n🔍 User query: "${query}"`);

      // 1. Greeting detection
      if (this.isGreeting(query)) {
        console.log('Detected greeting');
        return this.getGreetingResponse();
      }

      // 2. Query expansion
      const expandedQueries = this.expandQuery(query);
      console.log(`✓ Expanded to ${expandedQueries.length} queries`);

      const metadataFilters = this.extractMetadataFilters(query);
      if (metadataFilters) {
        console.log(`✓ Applying metadata filters:`, metadataFilters);
      }

      // 3. Search với multiple queries
      let allChunks: SearchResult[] = [];
      for (const q of expandedQueries) {
        const embedding = await this.embeddingService.generateEmbedding(q);
        const chunks = await this.db.searchSimilarChunks(embedding, 8, metadataFilters || undefined);
        allChunks.push(...chunks);
      }

      // 4. Deduplicate và sort
      const uniqueChunks = this.deduplicateAndSort(allChunks);
      console.log(`✓ Found ${uniqueChunks.length} unique chunks`);

      // Log top results
      uniqueChunks.slice(0, 5).forEach((c, i) => {
        console.log(`  [${i + 1}] Similarity: ${(c.similarity * 100).toFixed(1)}% | ${c.content.substring(0, 80)}...`);
      });

      // 5. NGƯỠNG ĐỘNG - Adjust based on query type
      const thresholds = this.getAdaptiveThresholds(query, uniqueChunks);
      const topSimilarity = uniqueChunks.length > 0 ? uniqueChunks[0].similarity : 0;

      console.log(`✓ Top similarity: ${(topSimilarity * 100).toFixed(1)}%`);
      console.log(`✓ Threshold: ${(thresholds.minTop * 100).toFixed(1)}%`);

      // 6. Check quality với ngưỡng động
      if (topSimilarity < thresholds.minTop) {
        console.log('⚠️ Similarity too low - no reliable context found');
        return this.getNoContextResponse(query);
      }

      // 7. Lấy chunks tốt
      const goodChunks = uniqueChunks.filter(c =>
        c.similarity >= thresholds.minChunk
      ).slice(0, 5); // Lấy topK 3-5

      if (goodChunks.length === 0) {
        console.log('No good chunks');
        return this.getNoContextResponse(query);
      }

      const enrichedChunks = this.includeNeighborChunks(goodChunks, uniqueChunks);

      // 8. Build context
      const context = this.buildContext(enrichedChunks);

      if (context.trim().length < 50) {
        console.log('Context too short');
        return this.getNoContextResponse(query);
      }

      console.log(`✓ Context: ${context.length} chars, ${enrichedChunks.length} chunks`);

      // 9. Generate response
      const response = await this.generateResponse(
        query, 
        context, 
        messages,
        topSimilarity
      );
      
      console.log(`✓ Response: ${response.length} chars\n`);

      return response;

    } catch (error: any) {
      console.error('RAG error:', error.message);
      throw error;
    }
  }

  private expandQuery(query: string): string[] {
    const queries = [query];
    const lower = query.toLowerCase();

    // Đề cương / Chương trình học
    if (lower.includes('đề cương')) {
      queries.push(query.replace(/đề cương/gi, 'chương trình học'));
      queries.push(query.replace(/đề cương/gi, 'nội dung môn học'));
      queries.push(query.replace(/đề cương/gi, 'giáo trình'));
    }

    // Môn học / Học phần
    if (lower.includes('môn')) {
      queries.push(query.replace(/môn/gi, 'học phần'));
      queries.push(query.replace(/môn/gi, 'course'));
    }

    // Tuyển sinh
    if (lower.includes('tuyển sinh')) {
      queries.push('đề án tuyển sinh');
      queries.push('phương thức tuyển sinh');
      queries.push('điều kiện tuyển sinh');
    }

    // Năm 2024
    if (lower.includes('2024') || lower.includes('năm 2024')) {
      queries.push('đề án tuyển sinh 2024');
      queries.push('tuyển sinh đại học 2024');
    }

    // Điểm / Điểm chuẩn
    if (lower.includes('điểm')) {
      queries.push(query.replace(/điểm/gi, 'điểm chuẩn'));
      queries.push(query.replace(/điểm/gi, 'điểm xét tuyển'));
    }

    // Tín chỉ
    if (lower.includes('tín chỉ') || lower.includes('tin chi') || lower.includes('mấy tín chỉ')) {
      queries.push(query.replace(/mấy tín chỉ/gi, 'số tín chỉ'));
      queries.push(query.replace(/tín chỉ/gi, 'số tín chỉ'));
    }

    // Quy chế
    if (lower.includes('quy chế')) {
      queries.push('quy định học vụ');
      queries.push('nội quy đào tạo');
    }

    // Extract keywords (từ > 3 ký tự)
    const keywords = query.split(' ')
      .filter(w => w.length > 3)
      .filter(w => !['của', 'về', 'cho', 'và', 'là', 'các', 'những', 'trong'].includes(w.toLowerCase()));
    
    if (keywords.length >= 2) {
      queries.push(keywords.join(' '));
    }

    // Loại trùng lặp
    return [...new Set(queries)].slice(0, 4);
  }

  // ✅ NGƯỠNG ĐỘNG - Thích ứng theo query
  private getAdaptiveThresholds(query: string, chunks: SearchResult[]): {
    minTop: number;
    minChunk: number;
  } {
    // Phân loại query
    const lowerQuery = query.toLowerCase();
    const isSpecificQuery = 
      lowerQuery.includes('năm 2024') || 
      lowerQuery.includes('đề án') ||
      lowerQuery.includes('phương thức') ||
      lowerQuery.includes('điều kiện');

    // Tính toán ngưỡng
    if (isSpecificQuery) {
      // Query cụ thể: yêu cầu similarity cao hơn
      return {
        minTop: 0.78,
        minChunk: 0.62
      };
    }

    return {
      minTop: 0.72,
      minChunk: 0.55
    };
  }

  private deduplicateAndSort(chunks: SearchResult[]): SearchResult[] {
    const map = new Map<string, SearchResult>();

    chunks.forEach(chunk => {
      const content = chunk.content.trim();
      const existing = map.get(content);
      
      // Giữ chunk có similarity cao nhất
      if (!existing || chunk.similarity > existing.similarity) {
        map.set(content, chunk);
      }
    });

    // Sort theo similarity giảm dần
    return Array.from(map.values())
      .sort((a, b) => b.similarity - a.similarity);
  }


  private isGreeting(query: string): boolean {
    const greetings = [
      'xin chào', 'chào', 'hello', 'hi', 'hey',
      'chào bạn', 'chào anh', 'chào chị', 'chào em',
    ];
    const lower = query.toLowerCase().trim();
    return greetings.some(g => 
      lower === g || 
      (lower.length < 20 && lower.startsWith(g))
    );
  }

  private getGreetingResponse(): string {
    return `Xin chào! Tôi là trợ lý AI của Đại học Kinh tế Quốc dân.

Tôi có thể hỗ trợ bạn về: chương trình đào tạo Công nghệ Thông tin ,quy chế học vụ (điểm, thi cử, học lại, tốt nghiệp), đề cương các môn học, tuyển sinh đại học, cấu trúc chương trình, tín chỉ

Bạn muốn biết thông tin gì?`;
  }


  private getNoContextResponse(query: string): string {
    return 'Không tìm thấy thông tin trong tài liệu.';
  }

  private buildContext(chunks: SearchResult[]): string {
    if (chunks.length === 0) return '';

    return chunks
      .map((chunk, i) => {
        const simPercent = (chunk.similarity * 100).toFixed(0);
        const metadata = [
          chunk.document_type && `loại: ${chunk.document_type}`,
          chunk.entity && `chủ đề: ${chunk.entity}`,
          chunk.major && `ngành: ${chunk.major}`,
          chunk.source_file && `nguồn: ${chunk.source_file}`,
        ].filter(Boolean).join(' | ');
        return `[Tài liệu ${i + 1} - Độ tin cậy: ${simPercent}%${metadata ? ` | ${metadata}` : ''}]\n${chunk.content}`;
      })
      .join('\n\n━━━━━━━━━━━━━━━━━━━━━━━━\n\n');
  }

  private includeNeighborChunks(primary: SearchResult[], all: SearchResult[]): SearchResult[] {
    const byKey = new Map<string, SearchResult>();

    const addChunk = (chunk: SearchResult | undefined) => {
      if (!chunk) return;
      const key = chunk.chunk_id;
      if (!byKey.has(key)) {
        byKey.set(key, chunk);
      }
    };

    primary.forEach(addChunk);

    primary.forEach(chunk => {
      const neighbors = all.filter(candidate =>
        candidate.source_file === chunk.source_file &&
        Math.abs(candidate.chunk_index - chunk.chunk_index) === 1
      );
      neighbors.forEach(addChunk);
    });

    return Array.from(byKey.values()).sort((a, b) => b.similarity - a.similarity);
  }


  private async generateResponse(
    query: string,
    context: string,
    history: ChatMessage[],
    topSimilarity: number
  ): Promise<string> {
    
    // Đánh giá độ tin cậy
    const confidence = topSimilarity > 0.65 ? 'cao' : 
                      topSimilarity > 0.50 ? 'trung bình' : 'thấp';

    const systemPrompt = `Bạn là trợ lý AI của Đại học Kinh tế Quốc dân.

NHIỆM VỤ:
Trả lời câu hỏi dựa trên tài liệu được cung cấp một cách đầy đủ, chính xác và dễ hiểu.

NGUYÊN TẮC:
1. Bạn CHỈ được trả lời dựa trên CONTEXT.
2. Nếu CONTEXT không đủ thông tin, trả lời: "Không tìm thấy thông tin trong tài liệu."
3. TUYỆT ĐỐI không suy diễn hoặc bịa đặt.
4. Bạn được phép diễn giải nếu nội dung trong CONTEXT tương đương về mặt ý nghĩa.
5. Luôn trích dẫn câu liên quan; nếu không trích dẫn được thì trả lời "Không tìm thấy thông tin trong tài liệu."

ĐỘ TIN CẬY: ${confidence} (${(topSimilarity * 100).toFixed(0)}%)`;

    const userPrompt = `Dựa trên tài liệu dưới đây, hãy trả lời câu hỏi.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TÀI LIỆU THAM KHẢO:
${context}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CÂU HỎI: ${query}

YÊU CẦU TRẢ LỜI:
- Trả lời ngắn gọn, đúng trọng tâm.
- Kèm trích dẫn câu liên quan trong CONTEXT.
- Nếu không thể trích dẫn, trả lời đúng nguyên văn: "Không tìm thấy thông tin trong tài liệu."`;

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
        top_k: 40,
        repeat_penalty: 1.1,
        num_predict: 1000,
        num_ctx: 4096,
      },
    });

    let response = res.message.content.trim();

    // Clean response
    response = response
      .replace(/^(Trả lời:|Câu trả lời:|Dựa vào tài liệu:|Dựa trên tài liệu:|Theo tài liệu:)\s*/gi, '')
      .replace(/^\*\*.*?\*\*\s*/gi, '')
      .replace(/━+/g, '')
      .trim();

    // Detect hallucination
    if (this.hasHallucination(response)) {
      console.log(' Hallucination detected');
    }

    return response;
  }

  private extractMetadataFilters(query: string): { document_type?: string; entity?: string; major?: string } | null {
    const lower = query.toLowerCase();
    const filters: { document_type?: string; entity?: string; major?: string } = {};

    if (lower.includes('quy định') || lower.includes('quy che') || lower.includes('quy chế')) {
      filters.document_type = 'quy_dinh';
    }

    if (lower.includes('đề cương') || lower.includes('de cuong') || lower.includes('syllabus')) {
      filters.document_type = 'de_cuong';
    }

    if (lower.includes('chương trình') || lower.includes('chuong trinh') || lower.includes('curriculum')) {
      filters.document_type = 'chuong_trinh';
    }

    if (lower.includes('chuyên đề thực tập') || lower.includes('chuyen de thuc tap')) {
      filters.entity = 'chuyen_de_thuc_tap';
    }

    if (/(cntt|cong nghe thong tin|công nghệ thông tin|it)/i.test(query)) {
      filters.major = 'CNTT';
    }

    if (!filters.document_type && !filters.entity && !filters.major) {
      return null;
    }

    return filters;
  }


  // HALLUCINATION DETECTION
  private hasHallucination(response: string): boolean {
    const bad = [
      'theo tôi nghĩ',
      'tôi đoán',
      'có lẽ là',
      'thường thì',
      'ước tính',
      'dự đoán',
      'theo kinh nghiệm',
    ];
    
    const lowerResponse = response.toLowerCase();
    return bad.some(phrase => lowerResponse.includes(phrase));
  }

  // ✅ TEST SEARCH - Debug tool
  async testSearch(query: string): Promise<{ query: string; results: SearchResult[] }> {
    console.log(`\n🔍 Test search: "${query}"`);
    
    const expandedQueries = this.expandQuery(query);
    console.log(`✓ Expanded queries:`, expandedQueries);
    const metadataFilters = this.extractMetadataFilters(query);

    let allResults: SearchResult[] = [];

    for (const q of expandedQueries) {
      const embedding = await this.embeddingService.generateEmbedding(q);
      const results = await this.db.searchSimilarChunks(embedding, 5, metadataFilters || undefined);
      allResults.push(...results);
    }

    const uniqueResults = this.deduplicateAndSort(allResults);

    console.log(`\n📊 Top ${Math.min(10, uniqueResults.length)} results:`);
    uniqueResults.slice(0, 10).forEach((r, i) => {
      console.log(`[${i + 1}] Sim: ${(r.similarity * 100).toFixed(1)}%`);
      console.log(`    Content: ${r.content.substring(0, 120)}...`);
      console.log('');
    });

    return { query, results: uniqueResults };
  }
}
