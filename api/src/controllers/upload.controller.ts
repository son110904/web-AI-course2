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

      //  Lấy file từ MinIO
      const buffer = await this.minio.getFile(objectName);

      // Extract text
      const text = (await this.documentService.extractText(buffer)).trim();
      if (!text) {
        return res.status(400).json({ error: 'File không có nội dung text' });
      }

      // Insert document → lấy document_id (UUID)
      const documentId = await this.db.insertDocument({
        filename: objectName,
        file_path: objectName,
        file_size: buffer.length,
        content_type: 'unknown',
      });

      // Chunk text
      const chunks = this.chunkText(text);

      // Embed + insert chunks
      for (let i = 0; i < chunks.length; i++) {
        const chunkText = chunks[i].trim();
        if (!chunkText) continue;

        const embedding = await this.embeddingService.generateEmbedding(chunkText);

        // debug cực kỳ hữu ích
        if (embedding.length !== 384) {
          throw new Error(`Embedding dimension invalid: ${embedding.length}`);
        }

        await this.db.insertChunk({
          document_id: documentId, // UUID thật
          content: chunkText,
          chunk_index: i,
          embedding,
        });
      }

      return res.json({
        message: 'Ingest thành công',
        documentId,
        totalChunks: chunks.length,
      });
    } catch (error: any) {
      console.error('Ingest error:', error);
      return res.status(500).json({ error: error.message });
    }
  }

  // 👉 List files trong MinIO
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

  private chunkText(text: string, chunkSize = 300, overlap = 50): string[] {
    const chunks: string[] = [];
    let start = 0;

    while (start < text.length) {
      const chunk = text.slice(start, start + chunkSize);
      if (chunk.trim()) chunks.push(chunk);
      start += chunkSize - overlap;
    }

    return chunks;
  }
}
