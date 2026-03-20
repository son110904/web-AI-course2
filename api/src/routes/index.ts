import { Router } from 'express';
import { ChatController } from '../controllers/chat.controller';

export function createRoutes(
  chatController: ChatController
): Router {
  const router = Router();
  
  router.get('/health', (_, res) => {
    res.json({ status: 'ok' });
  });

  router.post('/api/demo_agent/v1/ask', (req, res) =>
    chatController.ask(req, res)
  );
  return router;
}
