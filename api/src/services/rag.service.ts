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

      // 1. Generate embedding cho câu hỏi
      const queryEmbedding = await this.embeddingService.generateEmbedding(query);
      console.log(`✓ Generated query embedding`);

      // 2. Search similar chunks
      const topK = 5;
      const chunks = await this.db.searchSimilarChunks(queryEmbedding, topK);
      console.log(`✓ Found ${chunks.length} relevant chunks`);

      // Log similarity scores
      chunks.forEach((c, i) => {
        console.log(`  [${i + 1}] Similarity: ${(c.similarity * 100).toFixed(1)}% - ${c.content.substring(0, 60)}...`);
      });

      // 3. Kiểm tra quality của results
      const hasRelevantContent = chunks.length > 0 && chunks[0].similarity > 0.3;
      const avgSimilarity = chunks.length > 0 
        ? chunks.reduce((sum, c) => sum + c.similarity, 0) / chunks.length 
        : 0;

      console.log(`✓ Average similarity: ${(avgSimilarity * 100).toFixed(1)}%`);

      // 4. Xây dựng context
      const context = this.buildContext(chunks);

      // 5. Generate response
      const response = await this.generateResponse(query, context, messages, avgSimilarity, hasRelevantContent);
      console.log(`✓ Generated response (${response.length} chars)\n`);

      return response;

    } catch (error: any) {
      console.error('❌ RAG chat error:', error.message);
      throw error;
    }
  }

  private buildContext(chunks: SearchResult[]): string {
    if (chunks.length === 0) return '';

    // Loại bỏ duplicates và filter theo similarity threshold
    const uniqueChunks = new Map<string, SearchResult>();
    
    chunks.forEach(chunk => {
      const content = chunk.content.trim();
      // Chỉ giữ chunks có similarity > 0.3 và chưa tồn tại
      if (chunk.similarity > 0.3 && !uniqueChunks.has(content)) {
        uniqueChunks.set(content, chunk);
      }
    });

    // Xây dựng context từ unique chunks
    return Array.from(uniqueChunks.values())
      .map((c, i) => {
        const simPercentage = (c.similarity * 100).toFixed(1);
        return `[Tài liệu ${i + 1}] (Độ liên quan: ${simPercentage}%)\n${c.content}`;
      })
      .join('\n\n---\n\n');
  }

  private async generateResponse(
    query: string,
    context: string,
    history: ChatMessage[],
    avgSimilarity: number,
    hasRelevantContent: boolean
  ): Promise<string> {
    // Xác định confidence level
    const confidenceLevel = avgSimilarity > 0.7 ? 'cao' : avgSimilarity > 0.5 ? 'trung bình' : 'thấp';

    // System prompt được tối ưu để giảm hallucination
    const systemPrompt = `Bạn là trợ lý AI của Đại học Kinh tế Quốc dân, chuyên tư vấn về chương trình đào tạo, quy chế học vụ và đề cương môn học.

NGUYÊN TẮC:
1. CHỈ trả lời dựa trên thông tin trong [TÀI LIỆU THAM KHẢO] bên dưới
2. TUYỆT ĐỐI KHÔNG bịa đặt, suy đoán hoặc thêm thông tin không có trong tài liệu
3. Nếu tài liệu KHÔNG ĐỦ để trả lời đầy đủ câu hỏi:
   - Nói rõ "Dựa trên tài liệu hiện có, tôi chỉ tìm thấy..."
   - Chỉ nêu những gì CÓ TRONG tài liệu
   - Đề xuất sinh viên liên hệ văn phòng khoa/phòng đào tạo để biết thêm chi tiết
4. Nếu câu hỏi HOÀN TOÀN không liên quan đến tài liệu, trả lời:
   "Xin lỗi, tôi chỉ có thể tư vấn về chương trình đào tạo, quy chế học vụ và đề cương môn học của trường. Vui lòng hỏi về các vấn đề liên quan."
5. Trả lời ngắn gọn, rõ ràng, có cấu trúc (dùng bullet points nếu cần)
6. Trích dẫn số liệu, điều khoản CHÍNH XÁC từ tài liệu
7. Không nói "theo tôi biết", "thường thì", "có lẽ", "ước tính" - chỉ nói điều chắc chắn có trong tài liệu

ĐỘ TIN CẬY: ${confidenceLevel}`;

    // User prompt tùy thuộc vào có context hay không
    let userPrompt: string;

    if (!hasRelevantContent || context.trim().length === 0) {
      // Không có context phù hợp
      userPrompt = this.buildNoContextPrompt(query);
    } else {
      // Có context
      userPrompt = `[TÀI LIỆU THAM KHẢO]
${context}
[HẾT TÀI LIỆU]

Câu hỏi của sinh viên: ${query}

Yêu cầu:
- Chỉ dựa vào tài liệu trên để trả lời
- Không được bịa thêm thông tin
- Nếu tài liệu không đủ chi tiết, hãy nói rõ và đề xuất sinh viên hỏi thêm`;
    }

    // Gọi Ollama với options tối ưu
    const res = await this.ollama.chat({
      model: this.ollamaModel,
      messages: [
        { role: 'system', content: systemPrompt },
        ...history.slice(-4, -1), // Giữ 4 messages gần nhất (trừ message hiện tại)
        { role: 'user', content: userPrompt },
      ],
      stream: false,
      options: {
        temperature: 0.1,        
        top_p: 0.9,              // Nucleus sampling
        top_k: 20,               // Giới hạn vocabulary
        repeat_penalty: 1.2,     // Tránh lặp lại
        num_predict: 600,        // Giới hạn độ dài response
        stop: [                  // Stop tokens để tránh model tự sinh thêm
          '\n\nCâu hỏi:',
          '\n\nUser:',
          '\n\n[TÀI LIỆU',
          'Nguồn tham khảo:',
          '---END---'
        ],
      },
    });

    // Clean up response
    let cleanedResponse = res.message.content.trim();

    // Loại bỏ các prefix không mong muốn
    cleanedResponse = cleanedResponse
      .replace(/^(Trả lời:|Câu trả lời:|Response:|Dựa vào tài liệu:|Theo tài liệu:)\s*/i, '')
      .trim();

    // Detect potential hallucination
    if (this.detectHallucination(cleanedResponse)) {
      console.log('⚠️  Warning: Potential hallucination detected in response');
    }

    return cleanedResponse;
  }

  private buildNoContextPrompt(query: string): string {
    const lowerQuery = query.toLowerCase();

    // Xử lý các câu chào hỏi
    if (lowerQuery.includes('xin chào') || 
        lowerQuery.includes('hello') || 
        lowerQuery.includes('hi') ||
        lowerQuery.includes('chào')) {
      return `Câu hỏi: ${query}

Đây là lời chào. Hãy chào lại và giới thiệu bản thân là trợ lý AI của Đại học Kinh tế Quốc dân, có thể giúp về:
- Chương trình đào tạo
- Quy chế học vụ
- Đề cương môn học`;
    }

    // Các câu hỏi khác không có context
    return `Câu hỏi: ${query}

Không tìm thấy thông tin liên quan trong cơ sở dữ liệu tài liệu.

Hãy trả lời:
"Xin lỗi, tôi không tìm thấy thông tin liên quan đến câu hỏi của bạn trong cơ sở dữ liệu tài liệu hiện tại.

Tôi có thể giúp bạn về các vấn đề sau:
• Chương trình đào tạo Công nghệ Thông tin
• Quy chế học vụ, điểm, thi cử, học lại
• Đề cương các môn học
• Cấu trúc chương trình, học phần, tín chỉ

Vui lòng đặt lại câu hỏi cụ thể hơn hoặc liên hệ phòng Đào tạo để được hỗ trợ trực tiếp."`;
  }

  private detectHallucination(response: string): boolean {
    // Các cụm từ thường xuất hiện khi model đang hallucinate
    const hallMarkers = [
      'theo như tôi biết',
      'theo kinh nghiệm',
      'thông thường thì',
      'thường thì',
      'có thể là',
      'tôi nghĩ rằng',
      'có lẽ',
      'ước tính',
      'khoảng chừng',
      'dự đoán',
      'giả sử',
      'thường là',
      'theo tôi',
      'tôi cho rằng'
    ];

    const lowerResponse = response.toLowerCase();
    return hallMarkers.some(marker => lowerResponse.includes(marker));
  }

  // Helper method để test search quality
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