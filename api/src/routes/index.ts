import { Router } from 'express';
import multer from 'multer';
import { ChatController } from '../controllers/chat.controller';
import { UploadController } from '../controllers/upload.controller';

const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ];

    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('File type not supported'));
    }
  },
});

export function createRoutes(
  chatController: ChatController,
  uploadController: UploadController
): Router {
  const router = Router();

  router.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      message: 'Chatbot API running',
      timestamp: new Date().toISOString(),
    });
  });

  router.post('/api/chat', (req, res) => chatController.chat(req, res));

  router.post('/api/upload', upload.single('file'), (req, res) =>
    uploadController.uploadDocument(req, res)
  );

  router.get('/api/documents', (req, res) =>
    uploadController.listDocuments(req, res)
  );

  router.delete('/api/documents/:id', (req, res) =>
    uploadController.deleteDocument(req, res)
  );

  return router;
}