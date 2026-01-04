import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { DatabaseModel } from './src/models/database.model';
import { MinIOModel } from './src/models/minio.model';
import { EmbeddingService } from './src/services/embedding.service';
import { DocumentService } from './src/services/document.service';
import { RAGService } from './src/services/rag.service';
import { ChatController } from './src/controllers/chat.controller';
import { UploadController } from './src/controllers/upload.controller';
import { createRoutes } from './src/routes';
import { IngestController } from './src/controllers/ingest.controller';
import { MinIOWatcherService } from './src/services/minio-watcher.service';

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
  const db = new DatabaseModel(process.env.DATABASE_URL!);
  await db.initialize();
  
  const minio = new MinIOModel();
  
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

  // Initialize controllers
  const chatController = new ChatController(ragService);
  
  const uploadController = new UploadController(
    db,
    minio,
    documentService,
    embeddingService
  );
  
  const ingestController = new IngestController(
    minio,
    documentService,
    embeddingService,
    db
  );
  

  console.log('✓ All services initialized');


  // AUTO-INGEST KHI KHỞI ĐỘNG

  const autoIngestEnabled = process.env.AUTO_INGEST_ON_START !== 'false'; // Default: true
  
  if (autoIngestEnabled) {
    console.log('🔄 Checking if auto-ingest is needed...');
    
    try {
      const stats = await db.getIngestStats();
      
      if (stats.totalDocuments === 0) {
        console.log('📥 Database is empty. Starting auto-ingest...');
        console.log('⏳ This may take a few minutes...');
        
        await runAutoIngest(ingestController);
        
        console.log('✅ Auto-ingest completed successfully');
      } else {
        console.log(`✓ Database already has ${stats.totalDocuments} documents (${stats.totalChunks} chunks)`);
        console.log('ℹ️  Skipping auto-ingest. Use POST /api/ingest to re-ingest if needed.');
      }
    } catch (error: any) {
      console.error('❌ Auto-ingest failed:', error.message);
      console.log('⚠️  Server will continue without initial data');
      console.log('ℹ️  You can manually ingest using: POST /api/ingest');
    }
  } else {
    console.log(' Auto-ingest disabled (set AUTO_INGEST_ON_START=true to enable)');
  }
  //Auto watch 
  const watcherEnabled = process.env.MINIO_WATCHER_ENABLED !== 'false'; // Default: true
  
  if (watcherEnabled) {
    const watcher = new MinIOWatcherService(
      minio,
      documentService,
      embeddingService,
      db
    );
    await watcher.start();
  }

  // Setup routes
  const routes = createRoutes(chatController, ingestController, uploadController);
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

// HELPER FUNCTION: Run Auto Ingest
async function runAutoIngest(ingestController: IngestController): Promise<void> {
  return new Promise((resolve, reject) => {
    // Create mock request and response objects
    const mockReq = { 
      body: {} 
    } as Request;
    
    const mockRes = {
      json: (data: any) => {
        console.log('📊 Ingest Results:');
        console.log(`   - Files processed: ${data.totalFiles || 0}`);
        console.log(`   - Chunks created: ${data.totalChunks || 0}`);
        console.log(`   - Folders: ${data.folders?.join(', ') || 'N/A'}`);
        if (data.errors && data.errors.length > 0) {
          console.log(`   - Errors: ${data.errors.length}`);
          data.errors.forEach((err: string) => console.log(`     • ${err}`));
        }
        resolve();
      },
      status: (code: number) => ({
        json: (data: any) => {
          console.error(`❌ Ingest failed with status ${code}:`, data.error);
          reject(new Error(data.error || 'Ingest failed'));
        }
      })
    } as unknown as Response;

    // Run the ingest
    ingestController.ingestAll(mockReq, mockRes).catch(reject);
  });
}