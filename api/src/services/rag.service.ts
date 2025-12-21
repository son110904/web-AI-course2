import ollama from 'ollama';
import { DatabaseModel, SearchResult, ChatMessage } from '../models/database.model';
import { EmbeddingService } from './embedding.service';

export class RAGService {
  private db: DatabaseModel;
  private embeddingService: EmbeddingService;
  private ollamaModel: string;
  private ollamaHost: string;

  constructor(
    db: DatabaseModel,
    embeddingService: EmbeddingService,
    ollamaHost: string,
    ollamaModel: string
  ) {
    this.db = db;
    this.embeddingService = embeddingService;
    this.ollamaHost = ollamaHost;
    this.ollamaModel = ollamaModel;
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    const userMessage = messages[messages.length - 1];
    if (!userMessage || userMessage.role !== 'user') {
      throw new Error('Invalid message format');
    }

    const query = userMessage.content;
    const queryEmbedding = await this.embeddingService.generateEmbedding(query);
    const similarChunks = await this.db.searchSimilarChunks(queryEmbedding, 5);
    const context = this.buildContext(similarChunks);

    return this.generateResponse(query, context, messages);
  }

  private buildContext(chunks: SearchResult[]): string {
    if (chunks.length === 0) return '';

    return chunks
      .map(
        (chunk, index) =>
          `[Tài liệu ${index + 1}]\n${chunk.content}\n(Độ liên quan: ${(chunk.similarity * 100).toFixed(1)}%)`
      )
      .join('\n\n');
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
- Trả lời bằng tiếng Việt
- Không bịa đặt thông tin`;

    const userPrompt =
      context.trim().length === 0
        ? `Câu hỏi: ${query}

Không tìm thấy thông tin trong cơ sở dữ liệu.`
        : `Dựa trên tài liệu:

${context}

---

Câu hỏi: ${query}`;

    const response = await ollama.chat({
      model: this.ollamaModel,
      host: this.ollamaHost,
      messages: [
        { role: 'system', content: systemPrompt },
        ...conversationHistory.slice(-4, -1),
        { role: 'user', content: userPrompt },
      ],
    });

    return response.message.content;
  }
}
