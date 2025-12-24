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
  
  router.post('/api/ingest', (req, res) =>
    ingestController.ingestAll(req, res)
  );
 
  router.get('/api/ingest/status', (req, res) =>
    ingestController.checkIngestStatus(req, res)
  );
  
  router.delete('/api/ingest/clear', (req, res) =>
    ingestController.clearAll(req, res)
);
  return router;
}