import Ollama from 'ollama';
import { DatabaseModel, SearchResult, ChatMessage } from '../models/database.model';
import { EmbeddingService } from './embedding.service';

export class RAGService {
  private ollama: Ollama;
  private db: DatabaseModel;
  private embeddingService: EmbeddingService;
  private ollamaModel: string;

  constructor(
    db: DatabaseModel,
    embeddingService: EmbeddingService,
    ollamaHost: string,
    ollamaModel: string
  ) {
    this.ollama = new Ollama({ host: ollamaHost });
    this.db = db;
    this.embeddingService = embeddingService;
    this.ollamaModel = ollamaModel;
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    try {
      const userMessage = messages[messages.length - 1];
      if (!userMessage || userMessage.role !== 'user') {
        throw new Error('Invalid message format');
      }

      const query = userMessage.content;
      const queryEmbedding = await this.embeddingService.generateEmbedding(query);
      const similarChunks = await this.db.searchSimilarChunks(queryEmbedding, 5);
      const context = this.buildContext(similarChunks);
      const response = await this.generateResponse(query, context, messages);

      return response;
    } catch (error) {
      console.error('✗ RAG error:', error);
      throw error;
    }
  }

  private buildContext(chunks: SearchResult[]): string {
    if (chunks.length === 0) return '';

    const contextParts = chunks.map((chunk, index) => {
      return `[Tài liệu ${index + 1}]\n${chunk.content}\n(Độ liên quan: ${(chunk.similarity * 100).toFixed(1)}%)`;
    });

    return contextParts.join('\n\n');
  }

  private async generateResponse(
    query: string,
    context: string,
    conversationHistory: ChatMessage[]
  ): Promise<string> {
    const systemPrompt = `Bạn là trợ lý AI thông minh của Đại học Kinh tế Quốc dân.
Nhiệm vụ: Trả lời câu hỏi dựa trên thông tin được cung cấp.

QUY TẮC:
- Chỉ sử dụng thông tin từ tài liệu được cung cấp
- Nếu không tìm thấy thông tin, hãy nói rõ
- Trả lời bằng tiếng Việt, rõ ràng và súc tích
- Không bịa đặt thông tin`;

    let userPrompt = '';

    if (context.trim().length === 0) {
      userPrompt = `Câu hỏi: ${query}

Lưu ý: Không tìm thấy thông tin trong cơ sở dữ liệu. Hãy lịch sự từ chối và đề nghị upload tài liệu.`;
    } else {
      userPrompt = `Dựa trên tài liệu:

${context}

---

Câu hỏi: ${query}`;
    }

    try {
      const response = await this.ollama.chat({
        model: this.ollamaModel,
        messages: [
          { role: 'system', content: systemPrompt },
          ...conversationHistory.slice(-4, -1),
          { role: 'user', content: userPrompt },
        ],
        stream: false,
      });

      return response.message.content;
    } catch (error: any) {
      console.error('✗ Ollama error:', error);
      
      if (error.message?.includes('model')) {
        return `Xin lỗi, mô hình AI chưa sẵn sàng. Vui lòng đợi.`;
      }
      
      throw error;
    }
  }
}