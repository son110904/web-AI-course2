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

      // ✅ 1. PHÁT HIỆN GREETING
      if (this.isGreeting(query)) {
        console.log('👋 Detected greeting');
        return this.getGreetingResponse();
      }

      // 2. Generate embedding
      const queryEmbedding = await this.embeddingService.generateEmbedding(query);
      console.log(`✓ Generated query embedding`);

      // 3. Search similar chunks
      const topK = 5;
      const chunks = await this.db.searchSimilarChunks(queryEmbedding, topK);
      console.log(`✓ Found ${chunks.length} relevant chunks`);

      // Log similarity scores
      chunks.forEach((c, i) => {
        console.log(`  [${i + 1}] Similarity: ${(c.similarity * 100).toFixed(1)}%`);
      });

      // ✅ 4. KIỂM TRA QUALITY NGHIÊM NGẶT
      const topSimilarity = chunks.length > 0 ? chunks[0].similarity : 0;
      const avgSimilarity = chunks.length > 0 
        ? chunks.reduce((sum, c) => sum + c.similarity, 0) / chunks.length 
        : 0;

      console.log(`✓ Top similarity: ${(topSimilarity * 100).toFixed(1)}%`);
      console.log(`✓ Avg similarity: ${(avgSimilarity * 100).toFixed(1)}%`);

      // ✅ NGƯỠNG CHẤT LƯỢNG
      const MIN_TOP_SIMILARITY = 0.55;
      const MIN_AVG_SIMILARITY = 0.45;
      
      if (topSimilarity < MIN_TOP_SIMILARITY || avgSimilarity < MIN_AVG_SIMILARITY) {
        console.log('⚠️ Similarity too low');
        return this.getNoContextResponse(query);
      }

      // 5. Build context
      const context = this.buildContext(chunks);

      if (context.trim().length < 50) {
        console.log('⚠️ Context too short');
        return this.getNoContextResponse(query);
      }

      // 6. Generate response
      const response = await this.generateResponse(
        query, 
        context, 
        messages, 
        avgSimilarity
      );
      
      console.log(`✓ Generated response (${response.length} chars)\n`);

      return response;

    } catch (error: any) {
      console.error('❌ RAG chat error:', error.message);
      throw error;
    }
  }

  // ✅ PHÁT HIỆN GREETING
  private isGreeting(query: string): boolean {
    const greetings = [
      'xin chào', 'chào', 'hello', 'hi', 'hey', 'Xin chào',
      'chào bạn', 'chào em', 'chào anh', 'chào chị',
    ];
    const lowerQuery = query.toLowerCase().trim();
    return greetings.some(g => 
      lowerQuery === g || 
      (lowerQuery.length < 20 && lowerQuery.includes(g))
    );
  }

  // ✅ RESPONSE CHO GREETING
  private getGreetingResponse(): string {
    return `Xin chào! Tôi là trợ lý AI của Đại học Kinh tế Quốc dân.

Tôi có thể hỗ trợ bạn về:
• Chương trình đào tạo Công nghệ Thông tin
• Quy chế học vụ (điểm, thi cử, học lại)
• Đề cương các môn học
• Cấu trúc chương trình, tín chỉ

Bạn muốn biết thông tin gì?`;
  }

  // ✅ RESPONSE KHI KHÔNG CÓ CONTEXT
  private getNoContextResponse(query: string): string {
    return `Xin lỗi, tôi không tìm thấy thông tin liên quan đến câu hỏi của bạn trong cơ sở dữ liệu tài liệu.

Tôi chỉ có thể tư vấn về:
• Chương trình đào tạo Công nghệ Thông tin
• Quy chế học vụ
• Đề cương môn học
• Cấu trúc chương trình

Vui lòng đặt lại câu hỏi cụ thể hơn hoặc liên hệ phòng Đào tạo để được hỗ trợ.`;
  }

  // ✅ BUILD CONTEXT - LỌC KỸ
  private buildContext(chunks: SearchResult[]): string {
    if (chunks.length === 0) return '';

    const uniqueChunks = new Map<string, SearchResult>();
    
    chunks.forEach(chunk => {
      const content = chunk.content.trim();
      // Chỉ giữ chunks có similarity > 0.5
      if (chunk.similarity > 0.5 && !uniqueChunks.has(content)) {
        uniqueChunks.set(content, chunk);
      }
    });

    if (uniqueChunks.size === 0) {
      return '';
    }

    return Array.from(uniqueChunks.values())
      .map((c, i) => `[Tài liệu ${i + 1}]\n${c.content}`)
      .join('\n\n');
  }

  // ✅ GENERATE RESPONSE - PROMPT TỐI ƯU
  private async generateResponse(
    query: string,
    context: string,
    history: ChatMessage[],
    avgSimilarity: number
  ): Promise<string> {
    
    // System prompt đơn giản, rõ ràng
    const systemPrompt = `Bạn là trợ lý AI của Đại học Kinh tế Quốc dân, chuyên tư vấn về chương trình Công nghệ Thông tin.

NHIỆM VỤ:
- Trả lời câu hỏi dựa trên tài liệu được cung cấp
- Trả lời đầy đủ, rõ ràng, dễ hiểu
- Sử dụng bullet points khi liệt kê

QUY TẮC:
1. Chỉ dùng thông tin từ tài liệu
2. Không bịa đặt hoặc suy đoán
3. Nếu tài liệu không đủ, nói rõ và đề xuất liên hệ phòng Đào tạo
4. Trả lời bằng tiếng Việt chuẩn, không có ký tự lạ`;

    // User prompt với context
    const userPrompt = `Dựa trên các tài liệu sau, hãy trả lời câu hỏi của sinh viên.

TÀI LIỆU THAM KHẢO:
${context}

CÂU HỎI: ${query}

Hãy trả lời đầy đủ và rõ ràng.`;

    // Gọi Ollama
    const res = await this.ollama.chat({
      model: this.ollamaModel,
      messages: [
        { role: 'system', content: systemPrompt },
        ...history.slice(-2, -1), // Chỉ lấy 1 message trước đó
        { role: 'user', content: userPrompt },
      ],
      stream: false,
      options: {
        temperature: 0.3,        // Cân bằng giữa chính xác và tự nhiên
        top_p: 0.9,
        top_k: 40,
        repeat_penalty: 1.1,
        num_predict: 800,        // Đủ dài cho câu trả lời đầy đủ
      },
    });

    // Clean response
    let response = res.message.content.trim();

    // Loại bỏ các prefix không cần thiết
    response = response
      .replace(/^(Trả lời:|Câu trả lời:|Dựa vào tài liệu:|Dựa trên tài liệu:)\s*/gi, '')
      .replace(/^\*\*.*?\*\*\s*/gi, '') // Loại bỏ bold markdown nếu có
      .trim();

    // Kiểm tra hallucination
    if (this.hasHallucination(response)) {
      console.log('⚠️ Warning: Potential hallucination detected');
    }

    return response;
  }

  // ✅ PHÁT HIỆN HALLUCINATION ĐỖN GIẢN
  private hasHallucination(response: string): boolean {
    const badPhrases = [
      'theo tôi',
      'tôi nghĩ',
      'có lẽ',
      'thường thì',
      'ước tính',
    ];
    
    const lowerResponse = response.toLowerCase();
    return badPhrases.some(phrase => lowerResponse.includes(phrase));
  }

  // Helper method
  async testSearch(query: string): Promise<{ query: string; results: SearchResult[] }> {
    const queryEmbedding = await this.embeddingService.generateEmbedding(query);
    const results = await this.db.searchSimilarChunks(queryEmbedding, 10);

    console.log(`\n🔍 Test search: "${query}"`);
    results.forEach((r, i) => {
      console.log(`[${i + 1}] Sim: ${(r.similarity * 100).toFixed(1)}% | ${r.content.substring(0, 100)}...`);
    });

    return { query, results };
  }
}