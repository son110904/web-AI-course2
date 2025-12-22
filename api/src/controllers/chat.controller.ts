import { Request, Response } from 'express';
import { RAGService } from '../services/rag.service';
import { ChatMessage } from '../models/database.model';

export class ChatController {
  constructor(private ragService: RAGService) {}

  async chat(req: Request, res: Response): Promise<void> {
    try {
      const { messages } = req.body;

      if (!Array.isArray(messages) || messages.length === 0) {
        res.status(400).json({ botMessage: 'Tin nhắn không hợp lệ' });
        return;
      }

      const validMessages: ChatMessage[] = messages.map((m: any) => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: String(m.content || ''),
      }));

      const botMessage = await this.ragService.chat(validMessages);

      res.json({ botMessage });
    } catch (error) {
      console.error('Chat error:', error);
      res.status(500).json({
        botMessage: 'Xin lỗi, hệ thống đang gặp lỗi.',
      });
    }
  }
}
