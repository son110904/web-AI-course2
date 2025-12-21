import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { DatabaseModel } from './models/database.model';
import { MinIOModel } from './models/minio.model';
import { EmbeddingService } from './services/embedding.service';
import { DocumentService } from './services/document.service';
import { RAGService } from './services/rag.service';
import { ChatController } from './controllers/chat.controller';
import { UploadController } from './controllers/upload.controller';
import { createRoutes } from './routes';

dotenv.config();

export async function createApp(): Promise<Express> {
  const app = express();

  app.use(cors({
    origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
    credentials: true,
  }));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.use((req: Request, res: Response, next: NextFunction) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
  });

  console.log('⏳ Initializing services...');

  const db = new DatabaseModel(process.env.DATABASE_URL!);
  await db.initialize();

  const minio = new MinIOModel(
    process.env.MINIO_ENDPOINT!,
    parseInt(process.env.MINIO_PORT || '8008'),
    process.env.MINIO_ACCESS_KEY!,
    process.env.MINIO_SECRET_KEY!,
    process.env.MINIO_BUCKET_NAME!,
    false
  );
  await minio.initialize();

  const embeddingService = new EmbeddingService(
    process.env.EMBEDDING_MODEL || 'Xenova/all-MiniLM-L6-v2'
  );
  await embeddingService.initialize();

  const documentService = new DocumentService();

  const ragService = new RAGService(
    db,
    embeddingService,
    process.env.OLLAMA_HOST!,
    process.env.OLLAMA_MODEL!
  );

  const chatController = new ChatController(ragService);
  const uploadController = new UploadController(
    db,
    minio,
    documentService,
    embeddingService
  );

  const routes = createRoutes(chatController, uploadController);
  app.use('/', routes);

  app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    console.error('Error:', err);
    res.status(500).json({
      error: 'Internal server error',
      message: err.message,
    });
  });

  app.use((req: Request, res: Response) => {
    res.status(404).json({
      error: 'Not found',
      path: req.path,
    });
  });

  console.log('✓ All services initialized');

  return app;
}