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
  ) { }

  // INGEST từ MinIO → PostgreSQL
  async ingestFromMinIO(req: Request, res: Response) {
    try {
      const { objectName } = req.body;
      if (!objectName) {
        return res.status(400).json({ error: 'Thiếu objectName' });
      }

      // Lấy file từ MinIO
      const buffer = await this.minio.getFile(objectName);

      // Extract + clean text
      const rawText = await this.documentService.extractText(buffer, objectName);
      const text = this.documentService.cleanText(rawText);

      if (!text) {
        return res.status(400).json({ error: 'File không có nội dung text' });
      }

      const metadata = this.documentService.parseMetadataFromPath(objectName, text);

      // Insert document → lấy document_id
      const documentId = await this.db.insertDocument({
        filename: objectName,
        file_path: objectName,
        file_size: buffer.length,
        content_type: 'unknown',
        document_type: metadata.document_type,
        metadata: metadata as any,
      });

      //  Chunk text - đoạn này HA sửa theo metadata từng chunk đã thiết lập mới
      const chunks = this.documentService.chunkText(text);


      // Embed + insert chunks - HA cũng sửa vòng for
      for (let i = 0; i < chunks.length; i++) {
        const chunkText = chunks[i];
        if (!chunkText) continue;

        const embedding = await this.embeddingService.generateEmbedding(chunkText);

        if (embedding.length !== 1536) {
          throw new Error(`Embedding dimension invalid: ${embedding.length}`);
        }

        await this.db.insertChunk({
          document_id: documentId,
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

  // List files trong MinIO
  async listMinIOFiles(req: Request, res: Response) {
    try {
      const prefix = (req.query.prefix as string) || '';
      const files = await this.minio.listFiles(prefix);
      return res.json({
        files,
        total: files.length,
      });
    } catch (error: any) {
      console.error('List files error:', error);
      return res.status(500).json({ error: error.message });
    }
  }

  // Kiểm tra trạng thái upload
  async checkUploadStatus(req: Request, res: Response) {
    try {
      const stats = await this.db.getIngestStats();

      return res.json({
        summary: {
          totalDocuments: Number(stats.totalDocuments || 0),
          totalChunks: Number(stats.totalChunks || 0),
          totalSize: 0,
        },
        documents: stats.documents || [],
      });
    } catch (error: any) {
      console.error('Check status failed:', error);
      res.status(500).json({ error: error.message });
    }
  }
}
