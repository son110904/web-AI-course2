import { Request, Response } from 'express';
import { DocumentService } from '../services/document.service';
import { EmbeddingService } from '../services/embedding.service';
import { DatabaseModel } from '../models/database.model';
import { MinIOModel } from '../models/minio.model';

export class UploadController {
  constructor(
    private db: DatabaseModel,
    private minio: MinIOModel,
    private documentService: DocumentService,
    private embeddingService: EmbeddingService
  ) {}

  // 👉 INGEST từ MinIO → PostgreSQL
  async ingestFromMinIO(req: Request, res: Response) {
    try {
      const { objectName } = req.body;

      if (!objectName) {
        return res.status(400).json({ error: 'Thiếu objectName' });
      }

      // 1. Lấy file từ MinIO
      const buffer = await this.minio.getFile(objectName);
      
      // 2. Extract text từ buffer
      const text = await this.documentService.extractText(buffer, objectName);

      // 3. Chunk text
      const chunks = this.chunkText(text);

      // 4. Embed + lưu DB
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const embedding = await this.embeddingService.generateEmbedding(chunk);
        await this.db.insertChunk({
          document_id: objectName,
          content: chunk,
          chunk_index: i,
          embedding,
        });
      }

      return res.json({
        message: 'Ingest thành công',
        totalChunks: chunks.length,
      });
    } catch (error: any) {
      console.error('Ingest error:', error);
      return res.status(500).json({ error: error.message });
    }
  }

  // 👉 List files trong MinIO (để debug)
  async listMinIOFiles(req: Request, res: Response) {
    try {
      const files = await this.minio.listFiles();
      return res.json({
        files,
        total: files.length,
      });
    } catch (error: any) {
      console.error('List files error:', error);
      return res.status(500).json({ error: error.message });
    }
  }

  private chunkText(
    text: string,
    chunkSize = 300,
    overlap = 50
  ): string[] {
    const chunks: string[] = [];
    let start = 0;

    while (start < text.length) {
      chunks.push(text.slice(start, start + chunkSize));
      start += chunkSize - overlap;
    }

    return chunks;
  }
}