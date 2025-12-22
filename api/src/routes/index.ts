import { Router } from 'express';
import { ChatController } from '../controllers/chat.controller';
import { UploadController } from '../controllers/upload.controller';

export function createRoutes(
  chatController: ChatController,
  uploadController: UploadController
): Router {
  const router = Router();

  // Health check
  router.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      message: 'Chatbot API running',
      timestamp: new Date().toISOString(),
    });
  });

  // Chat API
  router.post('/api/chat', (req, res) =>
    chatController.chat(req, res)
  );

  // 🔥 INGEST từ MinIO → PostgreSQL (chạy 1 lần)
  router.post('/api/ingest', (req, res) =>
    uploadController.ingestFromMinIO(req, res)
  );

  // (Optional) list file trong MinIO để debug
  router.get('/api/minio/files', (req, res) =>
    uploadController.listMinIOFiles(req, res)
  );

  return router;
}
