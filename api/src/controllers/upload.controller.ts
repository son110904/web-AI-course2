import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import * as path from 'path';
import * as fs from 'fs';
import { DatabaseModel } from '../models/database.model';
import { MinIOModel } from '../models/minio.model';
import { DocumentService } from '../services/document.service';
import { EmbeddingService } from '../services/embedding.service';

export class UploadController {
  constructor(
    private db: DatabaseModel,
    private minio: MinIOModel,
    private documentService: DocumentService,
    private embeddingService: EmbeddingService
  ) {}

  async uploadDocument(req: Request, res: Response): Promise<void> {
    try {
      if (!req.file) {
        res.status(400).json({
          success: false,
          message: 'Không có file nào được upload',
        });
        return;
      }

      const file = req.file;
      const fileId = uuidv4();
      const originalName = file.originalname;
      const filePath = file.path;
      const contentType = file.mimetype;
      const fileSize = file.size;

      console.log(`⏳ Processing: ${originalName}`);

      console.log('  ⏳ Extracting text...');
      const text = await this.documentService.extractText(filePath, contentType);
      const cleanedText = this.documentService.cleanText(text);

      if (!cleanedText || cleanedText.length < 50) {
        res.status(400).json({
          success: false,
          message: 'Không thể trích xuất nội dung hoặc file quá ngắn',
        });
        return;
      }

      console.log('  ⏳ Uploading to MinIO...');
      const objectName = `${fileId}${path.extname(originalName)}`;
      const minioPath = await this.minio.uploadFile(filePath, objectName, contentType);

      console.log('  ⏳ Saving to database...');
      const documentId = await this.db.insertDocument({
        filename: originalName,
        file_path: minioPath,
        file_size: fileSize,
        content_type: contentType,
      });

      console.log('  ⏳ Chunking...');
      const chunks = this.documentService.chunkText(cleanedText, 500, 50);
      console.log(`  ✓ Created ${chunks.length} chunks`);

      console.log('  ⏳ Generating embeddings...');
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const embedding = await this.embeddingService.generateEmbedding(chunk);

        await this.db.insertChunk({
          document_id: documentId,
          content: chunk,
          chunk_index: i,
          embedding: embedding,
        });

        if ((i + 1) % 10 === 0) {
          console.log(`  ⏳ Progress: ${i + 1}/${chunks.length}`);
        }
      }

      fs.unlinkSync(filePath);

      console.log(`✓ Processed: ${originalName}`);

      res.json({
        success: true,
        message: 'Upload thành công',
        document: {
          id: documentId,
          filename: originalName,
          chunks: chunks.length,
        },
      });
    } catch (error: any) {
      console.error('✗ Upload error:', error);
      
      if (req.file?.path) {
        try {
          fs.unlinkSync(req.file.path);
        } catch (e) {}
      }

      res.status(500).json({
        success: false,
        message: 'Lỗi khi xử lý file',
        error: error.message,
      });
    }
  }

  async listDocuments(req: Request, res: Response): Promise<void> {
    try {
      const documents = await this.db.getDocuments();
      res.json({ success: true, documents });
    } catch (error: any) {
      console.error('✗ List error:', error);
      res.status(500).json({
        success: false,
        message: 'Lỗi khi lấy danh sách',
      });
    }
  }

  async deleteDocument(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      if (!id) {
        res.status(400).json({
          success: false,
          message: 'Thiếu ID',
        });
        return;
      }

      await this.db.deleteDocument(id);

      res.json({
        success: true,
        message: 'Xóa thành công',
      });
    } catch (error: any) {
      console.error('✗ Delete error:', error);
      res.status(500).json({
        success: false,
        message: 'Lỗi khi xóa',
      });
    }
  }
}