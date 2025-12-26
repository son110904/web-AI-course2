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

  // INGEST từ MinIO → PostgreSQL
  async ingestFromMinIO(req: Request, res: Response) {
    try {
      const { objectName } = req.body;

      if (!objectName) {
        return res.status(400).json({ error: 'Thiếu objectName' });
      }

      //  Lấy file từ MinIO
      const buffer = await this.minio.getFile(objectName);

      // Extract text
      const text = (await this.documentService.extractText(buffer, objectName)).trim();
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

  // List files trong MinIO
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
  // 📊 Kiểm tra trạng thái upload
async checkUploadStatus(req: Request, res: Response) {
  try {
    // Đếm tổng documents và chunks
    const statsQuery = await this.db['pool'].query(`
      SELECT 
        COUNT(DISTINCT d.id) as total_documents,
        COUNT(c.id) as total_chunks,
        SUM(d.file_size) as total_size
      FROM documents d
      LEFT JOIN chunks c ON c.document_id = d.id
    `);

    // Lấy danh sách documents với thông tin chi tiết
    const documentsQuery = await this.db['pool'].query(`
      SELECT 
        d.id,
        d.filename,
        d.file_path,
        d.file_size,
        d.content_type,
        d.uploaded_at,
        COUNT(c.id) as chunk_count,
        CASE 
          WHEN COUNT(c.id) > 0 THEN true 
          ELSE false 
        END as has_embeddings
      FROM documents d
      LEFT JOIN chunks c ON c.document_id = d.id
      GROUP BY d.id
      ORDER BY d.uploaded_at DESC
    `);

    // Kiểm tra embedding dimension
    const embeddingCheck = await this.db['pool'].query(`
      SELECT 
        document_id,
        chunk_index,
        array_length(embedding, 1) as embedding_dim
      FROM chunks
      LIMIT 5
    `);

    return res.json({
      summary: {
        totalDocuments: parseInt(statsQuery.rows[0]?.total_documents || '0'),
        totalChunks: parseInt(statsQuery.rows[0]?.total_chunks || '0'),
        totalSize: parseInt(statsQuery.rows[0]?.total_size || '0'),
      },
      documents: documentsQuery.rows,
      embeddingSample: embeddingCheck.rows,
    });
  } catch (error: any) {
    console.error('Check status failed:', error);
    res.status(500).json({ error: error.message });
  }
}
}
