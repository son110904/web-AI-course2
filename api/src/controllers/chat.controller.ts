import { Request, Response } from 'express';
import { RAGService } from '../services/rag.service';
import { ChatMessage } from '../models/database.model';
import { expandQuery } from "../services/query-expansion.service";

export class ChatController {
  constructor(private ragService: RAGService) { }

  /**
   * Chat endpoint - hỗ trợ cả format realtime (UI chat) và course-ai format
   * Tự động detect format dựa trên request body
   */
  async chat(req: Request, res: Response): Promise<void> {
    try {
      // Detect format: nếu có session_id và prompt => course-ai format, ngược lại => realtime format
      const { messages, session_id, prompt, context, model_id, user } = req.body;
      const isCourseAIFormat = !!(session_id && prompt);

      let validMessages: ChatMessage[];
      let expandedQueries: string[] | null = null;
      let isSuccessResponse = false;

      if (isCourseAIFormat) {
        // Course-AI format: /api/demo_agent/v1/ask
        if (!session_id || !model_id || !user || !prompt) {
          res.status(400).json({
            status: 'error',
            message: 'Thiếu dữ liệu bắt buộc: session_id, model_id, user, prompt',
          });
          return;
        }

        const history = Array.isArray(context?.history) ? context.history : [];
        validMessages = [
          ...history.map((m: any) => ({
            role: m.role === 'user' ? 'user' : 'assistant',
            content: String(m.content || ''),
          })),
          {
            role: 'user',
            content: String(prompt),
          },
        ];

        expandedQueries = expandQuery(prompt);
        isSuccessResponse = true;
      } else {
        // Realtime format: /api/chat
        if (!Array.isArray(messages) || messages.length === 0) {
          res.status(400).json({ botMessage: 'Tin nhắn không hợp lệ' });
          return;
        }

        validMessages = messages.map((m: any) => ({
          role: m.role === 'user' ? 'user' : 'assistant',
          content: String(m.content || ''),
        }));

        const lastMessage = validMessages[validMessages.length - 1];
        if (lastMessage.role === 'user') {
          expandedQueries = expandQuery(lastMessage.content);
        }
      }

      /**
       * Gọi RAG service
       */
      const startTime = Date.now();
      const content = await this.ragService.chat(validMessages);
      const responseTimeMs = Date.now() - startTime;

      // Return response theo format
      if (isSuccessResponse) {
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
      } else {
        res.json({ botMessage: content });
      }
    } catch (error) {
      console.error('Chat error:', error);
      const { session_id } = req.body;
      if (session_id) {
        // Course-AI format error
        res.status(500).json({
          session_id,
          status: 'error',
          message: 'Xin lỗi, hệ thống đang gặp lỗi.',
        });
      } else {
        // Realtime format error
        res.status(500).json({
          botMessage: 'Xin lỗi, hệ thống đang gặp lỗi.',
        });
      }
    }
  }
}
