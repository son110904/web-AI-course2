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
    const userMessage = messages[messages.length - 1];
    const query = userMessage.content;

    const queryEmbedding = await this.embeddingService.generateEmbedding(query);
    const chunks = await this.db.searchSimilarChunks(queryEmbedding, 5);
    const context = this.buildContext(chunks);

    return this.generateResponse(query, context, messages);
  }

  private buildContext(chunks: SearchResult[]): string {
    if (chunks.length === 0) return '';

    return chunks
      .map(
        (c, i) =>
          `[Tài liệu ${i + 1}]\n${c.content}\n(Độ liên quan: ${(c.similarity * 100).toFixed(1)}%)`
      )
      .join('\n\n');
  }

  private async generateResponse(
    query: string,
    context: string,
    history: ChatMessage[]
  ): Promise<string> {
    const systemPrompt = `
Bạn là trợ lý AI của Đại học Kinh tế Quốc dân.
Chỉ trả lời dựa trên tài liệu được cung cấp.
Nếu không có thông tin, hãy nói rõ.
`.trim();

    const userPrompt =
      context.trim().length === 0
        ? `Câu hỏi: ${query}\n\nKhông tìm thấy thông tin trong tài liệu.`
        : `Tài liệu:\n${context}\n\nCâu hỏi: ${query}`;

    const res = await this.ollama.chat({
      model: this.ollamaModel,
      messages: [
        { role: 'system', content: systemPrompt },
        ...history.slice(-4, -1),
        { role: 'user', content: userPrompt },
      ],
      stream: false,
    });

    return res.message.content;
  }
}