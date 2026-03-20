import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { DatabaseModel } from './src/models/database.model';
import { EmbeddingService } from './src/services/embedding.service';
import { RAGService } from './src/services/rag.service';
import { ChatController } from './src/controllers/chat.controller';
import { createRoutes } from './src/routes';

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
  
  // Initialize models and services
  const qdrantUrl = process.env.QDRANT_URL;
  const qdrantCollection = process.env.QDRANT_COLLECTION;
  if (!qdrantUrl) {
    throw new Error('Missing required env var: QDRANT_URL');
  }
  if (!qdrantCollection) {
    throw new Error('Missing required env var: QDRANT_COLLECTION');
  }

  const db = new DatabaseModel({
    qdrantUrl,
    collection: qdrantCollection,
    qdrantApiKey: process.env.QDRANT_API_KEY,
    vectorDim: process.env.VECTOR_DIM ? Number(process.env.VECTOR_DIM) : undefined,
    vectorName: process.env.QDRANT_VECTOR_NAME,
    ensureIndexes: process.env.QDRANT_ENSURE_INDEXES === 'true',
  });
  await db.initialize();
  
  const openaiApiKey = process.env.OPENAI_API_KEY;
  if (!openaiApiKey) {
    throw new Error('Missing required env var: OPENAI_API_KEY');
  }

  const embeddingService = new EmbeddingService(
    openaiApiKey,
    process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
    process.env.OPENAI_BASE_URL,
    process.env.OPENAI_TIMEOUT_MS ? Number(process.env.OPENAI_TIMEOUT_MS) : undefined
  );
  await embeddingService.initialize();
  
  const ragService = new RAGService(
    db,
    embeddingService,
    openaiApiKey,
    process.env.OPENAI_CHAT_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini',
    process.env.OPENAI_BASE_URL,
    process.env.OPENAI_TIMEOUT_MS ? Number(process.env.OPENAI_TIMEOUT_MS) : undefined
  );

  // Initialize controllers
  const chatController = new ChatController(ragService);
  


  console.log('✓ All services initialized');

  // Setup routes
  const routes = createRoutes(chatController);
  app.use('/', routes);

  // Error handling middleware
  app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    console.error('Error:', err);
    res.status(500).json({
      error: 'Internal server error',
      message: err.message,
    });
  });

  // 404 handler
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      error: 'Not found',
      path: req.path,
    });
  });

  return app;
}
