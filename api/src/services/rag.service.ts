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
        console.log('👋 Detected greeting');
        return this.getGreetingResponse();
      }

      // 2. Query expansion - Mở rộng query để tìm tốt hơn
      const expandedQueries = this.expandQuery(query);
      console.log(`✓ Expanded to ${expandedQueries.length} queries`);

      // 3. Search với multiple queries (hybrid)
      let allChunks: SearchResult[] = [];
      for (const q of expandedQueries) {
        const embedding = await this.embeddingService.generateEmbedding(q);
        const chunks = await this.db.searchHybridChunks(embedding, q, 8);
        allChunks.push(...chunks);
      }

      // 4. Deduplicate và sort
      const uniqueChunks = this.deduplicateAndSort(allChunks);
      console.log(`✓ Found ${uniqueChunks.length} unique chunks`);

      // Log top results
      uniqueChunks.slice(0, 5).forEach((c, i) => {
        const preview = (c.parent_content ?? c.content).substring(0, 80);
        const score = this.getScore(c);
        console.log(`  [${i + 1}] Score: ${(score * 100).toFixed(1)}% | ${preview}...`);
      });

      // 5. NGƯỠNG ĐỘNG - Adjust based on query type
      const thresholds = this.getAdaptiveThresholds(query);
      const topScore = uniqueChunks.length > 0 ? this.getScore(uniqueChunks[0]) : 0;

      console.log(`✓ Top score: ${(topScore * 100).toFixed(1)}%`);
      console.log(`✓ Threshold: ${(thresholds.minTop * 100).toFixed(1)}%`);

      // 6. Check quality với ngưỡng động
      if (topScore < thresholds.minTop) {
        console.log('⚠️ Score too low - no reliable context found');
        return this.getNoContextResponse(query);
      }

      // 7. Lấy chunks đủ tốt
      const goodChunks = uniqueChunks.filter(c => 
        this.getScore(c) >= thresholds.minChunk
      ).slice(0, 10); // Lấy tối đa 10 chunks tốt nhất

      if (goodChunks.length === 0) {
        console.log('⚠️ No chunks passed quality threshold');
        return this.getNoContextResponse(query);
      }

      // 8. Build context
      const context = this.buildContext(goodChunks);

      if (context.trim().length < 50) {
        console.log('⚠️ Context too short');
        return this.getNoContextResponse(query);
      }

      console.log(`✓ Context built: ${context.length} chars, ${goodChunks.length} chunks`);

      // 9. Generate response
      const response = await this.generateResponse(
        query, 
        context, 
        messages,
        topScore
      );
      
      console.log(`✓ Generated response (${response.length} chars)\n`);

      return response;

    } catch (error: any) {
      console.error('❌ RAG chat error:', error.message);
      throw error;
    }
  }

  // ✅ MỞ RỘNG QUERY - Tìm kiếm đa dạng hơn
  private expandQuery(query: string): string[] {
    const queries = [query]; // Query gốc

    const lowerQuery = query.toLowerCase();

    // Nếu hỏi về tuyển sinh
    if (lowerQuery.includes('tuyển sinh') || lowerQuery.includes('tuyển')) {
      queries.push('đề án tuyển sinh');
      queries.push('phương thức tuyển sinh');
      queries.push('điều kiện tuyển sinh');
      queries.push('quy định tuyển sinh đại học');
    }

    // Nếu hỏi về năm cụ thể
    if (lowerQuery.includes('2024') || lowerQuery.includes('năm 2024')) {
      queries.push('đề án tuyển sinh năm 2024');
      queries.push('tuyển sinh đại học chính quy 2024');
    }

    // Nếu hỏi về phương thức
    if (lowerQuery.includes('phương thức') || lowerQuery.includes('phương pháp')) {
      queries.push('xét tuyển');
      queries.push('phương thức xét tuyển');
      queries.push('hình thức tuyển sinh');
    }

    // Nếu hỏi về điều kiện/yêu cầu
    if (lowerQuery.includes('điều kiện') || lowerQuery.includes('yêu cầu')) {
      queries.push('yêu cầu đầu vào');
      queries.push('tiêu chí xét tuyển');
      queries.push('điều kiện dự tuyển');
    }

    // Nếu hỏi về điểm
    if (lowerQuery.includes('điểm') || lowerQuery.includes('đầu vào')) {
      queries.push('điểm chuẩn');
      queries.push('điểm xét tuyển');
      queries.push('ngưỡng đảm bảo chất lượng');
    }

    return [...new Set(queries)]; // Loại trùng lặp
  }

  // ✅ NGƯỠNG ĐỘNG - Thích ứng theo query
  private getAdaptiveThresholds(query: string): {
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
        minTop: 0.45,
        minChunk: 0.30
      };
    } else {
      // Query chung chung: linh hoạt hơn
      return {
        minTop: 0.35,
        minChunk: 0.25
      };
    }
  }

  // ✅ DEDUPLICATE VÀ SORT
  private deduplicateAndSort(chunks: SearchResult[]): SearchResult[] {
    const uniqueMap = new Map<string, SearchResult>();

    chunks.forEach(chunk => {
      const content = (chunk.parent_content ?? chunk.content).trim();
      const existing = uniqueMap.get(content);
      
      // Giữ chunk có similarity cao nhất
      if (!existing || this.getScore(chunk) > this.getScore(existing)) {
        uniqueMap.set(content, chunk);
      }
    });

    // Sort theo similarity giảm dần
    return Array.from(uniqueMap.values())
      .sort((a, b) => this.getScore(b) - this.getScore(a));
  }

  // ✅ GREETING DETECTION
  private isGreeting(query: string): boolean {
    const greetings = [
      'xin chào', 'chào', 'hello', 'hi', 'hey',
      'chào bạn', 'chào em', 'chào anh', 'chào chị',
    ];
    const lowerQuery = query.toLowerCase().trim();
    return greetings.some(g => 
      lowerQuery === g || 
      (lowerQuery.length < 20 && lowerQuery.startsWith(g))
    );
  }

  // ✅ GREETING RESPONSE
  private getGreetingResponse(): string {
    return `Xin chào! Tôi là trợ lý AI của Đại học Kinh tế Quốc dân.

Tôi có thể hỗ trợ bạn về:
• Đề án tuyển sinh đại học năm 2024
• Chương trình đào tạo Công nghệ Thông tin
• Quy chế học vụ (điểm, thi cử, học lại)
• Đề cương các môn học
• Cấu trúc chương trình, tín chỉ

Bạn muốn biết thông tin gì?`;
  }

  // ✅ NO CONTEXT RESPONSE
  private getNoContextResponse(query: string): string {
    return `Xin lỗi, tôi không tìm thấy thông tin đáng tin cậy về câu hỏi này trong tài liệu.

Tôi có thể tư vấn về:
• Đề án tuyển sinh đại học (2024)
• Chương trình đào tạo Công nghệ Thông tin
• Quy chế học vụ
• Đề cương môn học

Vui lòng:
1. Đặt lại câu hỏi rõ ràng hơn (ví dụ: "Đề án tuyển sinh năm 2024 có gì?")
2. Hoặc liên hệ Phòng Đào tạo để được hỗ trợ trực tiếp

Bạn có thể thử hỏi theo cách khác không?`;
  }

  // ✅ BUILD CONTEXT - Cải thiện
  private buildContext(chunks: SearchResult[]): string {
    if (chunks.length === 0) return '';

    return chunks
      .map((chunk, i) => {
        const scorePercent = (this.getScore(chunk) * 100).toFixed(0);
        const content = chunk.parent_content ?? chunk.content;
        return `[Tài liệu ${i + 1} - Độ tin cậy: ${scorePercent}%]\n${content}`;
      })
      .join('\n\n---\n\n');
  }

  // ✅ GENERATE RESPONSE - Prompt cải tiến
  private async generateResponse(
    query: string,
    context: string,
    history: ChatMessage[],
    topScore: number
  ): Promise<string> {
    
    // Đánh giá độ tin cậy
    const confidence = topScore > 0.65 ? 'cao' : 
                      topScore > 0.50 ? 'trung bình' : 'thấp';

    const systemPrompt = `Bạn là trợ lý AI của Đại học Kinh tế Quốc dân, chuyên tư vấn về tuyển sinh và chương trình đào tạo.

NHIỆM VỤ:
- Trả lời câu hỏi dựa CHÍNH XÁC trên tài liệu được cung cấp
- Trích dẫn trực tiếp từ tài liệu khi có thể
- Trả lời đầy đủ, có cấu trúc rõ ràng
- Sử dụng bullet points khi liệt kê thông tin

QUY TẮC NGHIÊM NGẶT:
1. CHỈ sử dụng thông tin từ tài liệu được cung cấp
2. KHÔNG bịa đặt, suy đoán, hoặc thêm thông tin từ kiến thức chung
3. Nếu tài liệu KHÔNG đủ thông tin, hãy nói rõ: "Theo tài liệu, [thông tin có], nhưng tôi không tìm thấy thông tin về [phần còn thiếu]"
4. Khi trả lời về năm cụ thể (2024), phải chắc chắn thông tin từ tài liệu là về năm đó
5. Trả lời bằng tiếng Việt chuẩn, tự nhiên

ĐỘ TIN CẬY CỦA TÀI LIỆU: ${confidence}`;

    const userPrompt = `Dựa trên các tài liệu sau đây, hãy trả lời câu hỏi của sinh viên.

${context}

---

CÂU HỎI CỦA SINH VIÊN: ${query}

Hãy trả lời chính xác dựa trên tài liệu. Nếu tài liệu không đủ thông tin, hãy nói rõ phần nào có và phần nào thiếu.`;

    const res = await this.ollama.chat({
      model: this.ollamaModel,
      messages: [
        { role: 'system', content: systemPrompt },
        ...history.slice(-3, -1), // Lấy 2 messages trước đó cho context
        { role: 'user', content: userPrompt },
      ],
      stream: false,
      options: {
        temperature: 0.2,        // Giảm nhiệt độ để chính xác hơn
        top_p: 0.85,
        top_k: 30,
        repeat_penalty: 1.15,
        num_predict: 1000,
      },
    });

    let response = res.message.content.trim();

    // Clean response
    response = response
      .replace(/^(Trả lời:|Câu trả lời:|Dựa vào tài liệu:|Dựa trên tài liệu:)\s*/gi, '')
      .replace(/^\*\*.*?\*\*\s*/gi, '')
      .trim();

    // Warning nếu có dấu hiệu hallucination
    if (this.hasHallucination(response)) {
      console.log('⚠️ Warning: Potential hallucination detected in response');
    }

    return response;
  }

  // ✅ HALLUCINATION DETECTION
  private hasHallucination(response: string): boolean {
    const suspiciousPhrases = [
      'theo tôi nghĩ',
      'tôi đoán',
      'có lẽ là',
      'thường thì',
      'có thể là',
      'dự đoán',
      'ước tính khoảng',
    ];
    
    const lowerResponse = response.toLowerCase();
    return suspiciousPhrases.some(phrase => lowerResponse.includes(phrase));
  }

  private getScore(chunk: SearchResult): number {
    if (typeof chunk.combined_score === 'number') {
      return chunk.combined_score;
    }
    if (typeof chunk.similarity === 'number') {
      return chunk.similarity;
    }
    return 0;
  }

  // ✅ TEST SEARCH - Debug tool
  async testSearch(query: string): Promise<{ query: string; results: SearchResult[] }> {
    console.log(`\n🔍 Test search: "${query}"`);
    
    const expandedQueries = this.expandQuery(query);
    console.log(`✓ Expanded queries:`, expandedQueries);

    let allResults: SearchResult[] = [];

    for (const q of expandedQueries) {
      const embedding = await this.embeddingService.generateEmbedding(q);
      const results = await this.db.searchHybridChunks(embedding, q, 5);
      allResults.push(...results);
    }

    const uniqueResults = this.deduplicateAndSort(allResults);

    console.log(`\n📊 Top ${Math.min(10, uniqueResults.length)} results:`);
    uniqueResults.slice(0, 10).forEach((r, i) => {
      console.log(`[${i + 1}] Score: ${(this.getScore(r) * 100).toFixed(1)}%`);
      console.log(`    Content: ${(r.parent_content ?? r.content).substring(0, 120)}...`);
      console.log('');
    });

    return { query, results: uniqueResults };
  }
}
