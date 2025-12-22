import { Request, Response } from 'express';
import { MinIOModel } from '../models/minio.model';
import { DocumentService } from '../services/document.service';
import { EmbeddingService } from '../services/embedding.service';
import { DatabaseModel } from '../models/database.model';

export class IngestController {
  constructor(
    private minio: MinIOModel,
    private documentService: DocumentService,
    private embeddingService: EmbeddingService,
    private db: DatabaseModel
  ) {}

  // 🚀 INGEST TOÀN BỘ BUCKET
  async ingestAll(req: Request, res: Response) {
    try {
      const basePrefix = 'chatbot courses';
      let totalFiles = 0;
      let totalChunks = 0;

      for (const lang of ['vi', 'en']) {
        const prefix = `${basePrefix}/${lang}/`;

        console.log(`📂 Scanning ${prefix}`);
        const files = await this.minio.listFiles(prefix);

        for (const objectName of files) {
          if (objectName.endsWith('/')) continue;

          console.log(`📥 Ingesting ${objectName}`);
          totalFiles++;

          // Download
          const buffer = await this.minio.getFile(objectName);

          // Extract + clean
          const rawText = await this.documentService.extractText(buffer, objectName);
          const text = this.documentService.cleanText(rawText);

          if (!text) continue;

          // Chunk
          const chunks = this.documentService.chunkText(text, 300, 50);

          // Embed + Save
          for (let i = 0; i < chunks.length; i++) {
            const embedding = await this.embeddingService.generateEmbedding(chunks[i]);

            await this.db.insertChunk({
              document_id: objectName,
              content: chunks[i],
              chunk_index: i,
              embedding,
            });

            totalChunks++;
          }
        }
      }

      res.json({
        message: 'Ingest toàn bộ bucket thành công',
        totalFiles,
        totalChunks,
      });
    } catch (error: any) {
      console.error('Ingest failed:', error);
      res.status(500).json({ error: error.message });
    }
  }
}
