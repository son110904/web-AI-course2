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
      const basePrefix = 'courses-chatbot';
      const folders = ['curriculum', 'regulation', 'syllabus'];
       
      let totalFiles = 0;
      let totalChunks = 0;
      const errors: string[] = [];

      for (const folder of folders) {
        const prefix = `${basePrefix}/${folder}/`;
        
        console.log(`\n📂 Processing folder: ${prefix}`);
        
        try {
          const files = await this.minio.listFiles(prefix);
          console.log(`Found ${files.length} files in ${folder}`);

          for (const objectName of files) {
            // Bỏ qua thư mục
            if (objectName.endsWith('/')) continue;
            
            // Chỉ lấy file .docx
            if (!objectName.toLowerCase().endsWith('.docx')) {
              console.log(`⏭️ Skipping: ${objectName}`);
              continue;
            }

            console.log(`\n📥 Processing: ${objectName}`);
            
            try {
              totalFiles++;

              // 1. Download file
              const buffer = await this.minio.getFile(objectName);
              console.log(`  ✓ Downloaded ${buffer.length} bytes`);

              // 2. Extract text
              const rawText = await this.documentService.extractText(buffer, objectName);
              console.log(`  ✓ Extracted ${rawText.length} characters`);

              // 3. Clean text
              const text = this.documentService.cleanText(rawText);
              
              if (!text || text.trim().length === 0) {
                console.log(`  ⚠️ No content, skipping`);
                continue;
              }

              // 4. Parse metadata (FULL VERSION)
              const metadata = this.documentService.parseMetadataFromPath(
                objectName,
                text
              );

              console.log('  📋 Metadata:', JSON.stringify(metadata, null, 2));

              // 5. Insert document with full metadata
              const documentId = await this.db.insertDocument({
                filename: objectName.split('/').pop() || objectName,
                file_path: objectName,
                file_size: buffer.length,
                content_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                document_type: metadata.document_type,
                metadata: metadata as any
              });

              console.log(`  ✓ Document inserted: ${documentId}`);

              // 6. Chunk text
              const chunks = this.documentService.chunkText(text, metadata);
              console.log(`  ✓ Created ${chunks.length} chunks`);

              // 7. Embed và save chunks
              for (let i = 0; i < chunks.length; i++) {
                const embedding = await this.embeddingService.generateEmbedding(chunks[i]);
                
                await this.db.insertChunk({
                  document_id: documentId,
                  content: chunks[i],
                  chunk_index: i,
                  embedding
                });

                totalChunks++;
                
                if ((i + 1) % 10 === 0) {
                  console.log(`  ✓ Embedded ${i + 1}/${chunks.length} chunks`);
                }
              }

              console.log(`✅ Successfully ingested: ${objectName}`);

            } catch (fileError: any) {
              const errorMsg = `Error processing ${objectName}: ${fileError.message}`;
              console.error(`❌ ${errorMsg}`);
              errors.push(errorMsg);
            }
          }
        } catch (folderError: any) {
          const errorMsg = `Error scanning folder ${folder}: ${folderError.message}`;
          console.error(`❌ ${errorMsg}`);
          errors.push(errorMsg);
        }
      }

      console.log(`\n🎉 Ingest completed!`);
      console.log(`📊 Total files: ${totalFiles}`);
      console.log(`📦 Total chunks: ${totalChunks}`);
      if (errors.length > 0) {
        console.log(`⚠️ Errors: ${errors.length}`);
      }

      res.json({
        message: 'Ingest hoàn tất',
        totalFiles,
        totalChunks,
        errors: errors.length > 0 ? errors : undefined,
        folders
      });

    } catch (error: any) {
      console.error('❌ Ingest failed:', error);
      res.status(500).json({ 
        error: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  }

  // Kiểm tra trạng thái
  async checkIngestStatus(req: Request, res: Response) {
    try {
      const stats = await this.db.getIngestStats();
      res.json(stats);
    } catch (error: any) {
      console.error('Check status failed:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // Xóa tất cả
  async clearAll(req: Request, res: Response) {
    try {
      const chunksResult = await this.db['pool'].query(
        'DELETE FROM chunks RETURNING id'
      );
      
      const docsResult = await this.db['pool'].query(
        'DELETE FROM documents RETURNING id'
      );
      
      console.log(`Deleted ${chunksResult.rowCount} chunks`);
      console.log(`Deleted ${docsResult.rowCount} documents`);
      
      res.json({
        message: 'Đã xóa toàn bộ dữ liệu',
        deletedChunks: chunksResult.rowCount,
        deletedDocuments: docsResult.rowCount
      });
    } catch (error: any) {
      console.error('Clear failed:', error);
      res.status(500).json({ error: error.message });
    }
  }
}
