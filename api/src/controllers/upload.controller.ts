import { Request, Response } from 'express';
import { DocumentService } from '../services/document.service';
import { EmbeddingService } from '../services/embedding.service';
import { DatabaseModel } from '../models/database.model';
import { MinIOModel } from '../models/minio.model';
import { v4 as uuidv4 } from "uuid";
import { Chunk } from "../models/chunk.model";


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

      const metadata = this.documentService.parseMetadataFromPath(objectName);

      // Insert document → lấy document_id
      const documentId = await this.db.insertDocument({
        filename: objectName,
        file_path: objectName,
        file_size: buffer.length,
        content_type: 'unknown',
        document_type: metadata.document_type,
        entity: metadata.entity,
        major: metadata.major,
        source_file: metadata.source_file,
      });

      //  Chunk text - đoạn này HA sửa theo metadata từng chunk đã thiết lập mới
      const rawChunks = this.documentService.chunkText(text);

      const chunks: Chunk[] = rawChunks.map((chunkText, index) => ({
        id: uuidv4(),
        docId: documentId,
        order: index,
        content: chunkText,
        metadata: {
          document_type: metadata.document_type,
          entity: metadata.entity,
          major: metadata.major,
          source_file: metadata.source_file,
        },
      }));


      // Embed + insert chunks - HA cũng sửa vòng for
      for (const chunk of chunks) {
        if (!chunk.content) continue;

        const embedding = await this.embeddingService.generateEmbedding(chunk.content);

        if (embedding.length !== 768) {
          throw new Error(`Embedding dimension invalid: ${embedding.length}`);
        }

        await this.db.insertChunk({
          document_id: chunk.docId,
          content: chunk.content,
          chunk_index: chunk.order,
          embedding,
          document_type: chunk.metadata.document_type,
          entity: chunk.metadata.entity,
          major: chunk.metadata.major,
          source_file: chunk.metadata.source_file,
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
      const statsQuery = await this.db['pool'].query(`
        SELECT 
          COUNT(DISTINCT d.id) as total_documents,
          COUNT(c.id) as total_chunks,
          SUM(d.file_size) as total_size
        FROM documents d
        LEFT JOIN chunks c ON c.document_id = d.id
      `);

      const documentsQuery = await this.db['pool'].query(`
        SELECT 
          d.id,
          d.filename,
          d.file_path,
          d.file_size,
          d.content_type,
          d.uploaded_at,
          COUNT(c.id) as chunk_count,
          COUNT(c.id) > 0 as has_embeddings
        FROM documents d
        LEFT JOIN chunks c ON c.document_id = d.id
        GROUP BY d.id
        ORDER BY d.uploaded_at DESC
      `);

      return res.json({
        summary: {
          totalDocuments: Number(statsQuery.rows[0]?.total_documents || 0),
          totalChunks: Number(statsQuery.rows[0]?.total_chunks || 0),
          totalSize: Number(statsQuery.rows[0]?.total_size || 0),
        },
        documents: documentsQuery.rows,
      });
    } catch (error: any) {
      console.error('Check status failed:', error);
      res.status(500).json({ error: error.message });
    }
  }
}
