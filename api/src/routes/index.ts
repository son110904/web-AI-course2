import { Router } from 'express';
import { ChatController } from '../controllers/chat.controller';
import { IngestController } from '../controllers/ingest.controller';

export function createRoutes(
  chatController: ChatController,
  ingestController: IngestController
): Router {
  const router = Router();

  router.get('/health', (_, res) => {
    res.json({ status: 'ok' });
  });

  router.post('/api/chat', (req, res) =>
    chatController.chat(req, res)
  );

  // INGEST ALL DOCUMENTS
  router.post('/api/ingest', (req, res) =>
    ingestController.ingestAll(req, res)
  );

  return router;
}
