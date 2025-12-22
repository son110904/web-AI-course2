import { Request, Response } from 'express';
import { DocumentService } from '../services/document.service';
import { EmbeddingService } from '../services/embedding.service';
import { DatabaseModel } from '../models/database.model';

export class IngestController {
  constructor(
    private documentService: DocumentService,
    private embeddingService: EmbeddingService,
    private db: DatabaseModel
  ) {}

  async ingest(req: Request, res: Response) {
    try {
      for (const lang of ['vi', 'en']) {
        const files = await this.documentService.listFiles(lang);

        for (const file of files) {
          console.log(`Ingesting ${file}`);

          const buffer = await this.documentService.downloadFile(file);
          const text = await this.documentService.extractText(buffer, file);

          const chunks = this.documentService.splitText(text, 300, 50);

          for (const chunk of chunks) {
            const embedding = await this.embeddingService.generateEmbedding(chunk);

            await this.db.insertChunk({
              source: file,
              language: lang,
              content: chunk,
              embedding: embedding
            });
          }
        }
      }

      res.json({ message: 'Ingest hoàn tất' });
    } catch (error: any) {
      console.error('Ingest error:', error);
      res.status(500).json({ error: error.message });
    }
  }
}