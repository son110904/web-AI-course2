import { Request, Response } from 'express';
import { RAGService } from '../services/rag.service';
import { ChatMessage } from '../models/database.model';
import { expandQuery } from "../services/query-expansion.service";

export class ChatController {
  constructor(private ragService: RAGService) { }

  /**
   * Chat dạng realtime (UI chat)
   */
  async chat(req: Request, res: Response): Promise<void> {
    try {
      const { messages } = req.body;

      if (!Array.isArray(messages) || messages.length === 0) {
        res.status(400).json({ botMessage: 'Tin nhắn không hợp lệ' });
        return;
      }

      // Chuẩn hóa message
      const validMessages: ChatMessage[] = messages.map((m: any) => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: String(m.content || ''),
      }));

      /**
       * Gọi RAG service
       */
      const botMessage = await this.ragService.chat(validMessages);

      res.json({ botMessage });
    } catch (error) {
      console.error('Chat error:', error);
      res.status(500).json({
        botMessage: 'Xin lỗi, hệ thống đang gặp lỗi.',
      });
    }
  }

  /**
   * Endpoint tích hợp với repo course-ai
   */
  async ask(req: Request, res: Response): Promise<void> {
    try {
      // Support the UI chat payload too: { messages: [{ role, content }, ...] }
      // This effectively merges /api/chat into /api/demo_agent/v1/ask.
      if (Array.isArray(req.body?.messages)) {
        await this.chat(req, res);
        return;
      }

      const { session_id, model_id, user, prompt, context } = req.body;

      if (!session_id || !model_id || !user || !prompt) {
        res.status(400).json({
          status: 'error',
          message: 'Thiếu dữ liệu bắt buộc: session_id, model_id, user, prompt',
        });
        return;
      }

      const history = Array.isArray(context?.history) ? context.history : [];

      const messages: ChatMessage[] = [
        ...history.map((m: any) => ({
          role: m.role === 'user' ? 'user' : 'assistant',
          content: String(m.content || ''),
        })),
        {
          role: 'user',
          content: String(prompt),
        },
      ];

      const startTime = Date.now();
      const content = await this.ragService.chat(messages);
      const responseTimeMs = Date.now() - startTime;

      res.json({
        session_id,
        status: 'success',
        content_markdown: content,
        meta: {
          model: model_id,
          response_time_ms: responseTimeMs,
          tokens_used: 0,
        },
        attachments: [],
      });
    } catch (error) {
      console.error('Ask error:', error);
      res.status(500).json({
        session_id: req.body?.session_id,
        status: 'error',
        message: 'Xin lỗi, hệ thống đang gặp lỗi.',
      });
    }
  }
}
