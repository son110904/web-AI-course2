import { Request, Response } from 'express';
import { RAGService } from '../services/rag.service';
import { ChatMessage } from '../models/database.model';

export class ChatController {
  constructor(private ragService: RAGService) {}

  async chat(req: Request, res: Response): Promise<void> {
    try {
      const { messages } = req.body;

      if (!messages || !Array.isArray(messages) || messages.length === 0) {
        res.status(400).json({
          botMessage: 'Vui lòng cung cấp tin nhắn hợp lệ',
        });
        return;
      }

      // Validate message format
      const validMessages: ChatMessage[] = messages.map((msg: any) => ({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: msg.content || '',
      }));

      // Generate response
      const botMessage = await this.ragService.chat(validMessages);

      res.json({
        botMessage,
      });
    } catch (error: any) {
      console.error('Chat error:', error);
      res.status(500).json({
        botMessage: 'Xin lỗi, có lỗi xảy ra. Hãy thử lại nhé!',
      });
    }
  }

  async streamChat(req: Request, res: Response): Promise<void> {
    try {
      const { messages } = req.body;

      if (!messages || !Array.isArray(messages) || messages.length === 0) {
        res.status(400).json({
          error: 'Invalid messages',
        });
        return;
      }

      const validMessages: ChatMessage[] = messages.map((msg: any) => ({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: msg.content || '',
      }));

      // Set headers for streaming
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      // Stream response
      await this.ragService.streamChat(validMessages, (chunk) => {
        res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
      });

      res.write('data: [DONE]\n\n');
      res.end();
    } catch (error: any) {
      console.error('Stream chat error:', error);
      res.status(500).json({
        error: 'Stream chat failed',
      });
    }
  }
}