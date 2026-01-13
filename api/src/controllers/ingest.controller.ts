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

  // 🚀 INGEST TOÀN BỘ BUCKET SYLLABUS
  async ingestAll(req: Request, res: Response) {
    try {
      const basePrefix = 'chatbot courses';
      const folders = ['ctdt-co-dau-moc', 'de-cuong', 'quy-che-hoc-vu'];
      
      let totalFiles = 0;
      let totalChunks = 0;
      const errors: string[] = [];

      for (const folder of folders) {
        const prefix = `${basePrefix}/${folder}/`;
        
        console.log(`📂 Scanning folder: ${prefix}`);
        
        try {
          const files = await this.minio.listFiles(prefix);
          console.log(`Found ${files.length} files in ${folder}`);

          for (const objectName of files) {
            // Bỏ qua thư mục
            if (objectName.endsWith('/')) continue;
            
            // Chỉ lấy file .docx
            if (!objectName.toLowerCase().endsWith('.docx')) {
              console.log(`⏭️ Skipping non-docx file: ${objectName}`);
              continue;
            }

            console.log(`📥 Processing: ${objectName}`);
            
            try {
              totalFiles++;

              // Download file từ MinIO
              const buffer = await this.minio.getFile(objectName);
              console.log(`  ✓ Downloaded ${buffer.length} bytes`);

              // Extract text từ docx
              const rawText = await this.documentService.extractText(buffer, objectName);
              console.log(`  ✓ Extracted ${rawText.length} characters`);

              // Clean text
              const text = this.documentService.cleanText(rawText);
              
              if (!text || text.trim().length === 0) {
                console.log(`  ⚠️ No text content after cleaning, skipping`);
                continue;
              }

              // Semantic chunk text (parent-child)
              const chunkGroups = await this.documentService.createSemanticChunks(
                text,
                this.embeddingService
              );
              const fileChunkCount = chunkGroups.reduce(
                (sum, group) => sum + group.children.length,
                0
              );
              console.log(`  ✓ Created ${fileChunkCount} chunks from ${chunkGroups.length} sections`);

              // Insert document vào DB để lấy UUID
              const documentId = await this.db.insertDocument({
                filename: objectName.split('/').pop() || objectName,
                file_path: objectName,
                file_size: buffer.length,
                content_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
              });

              console.log(`  ✓ Document inserted with ID: ${documentId}`);

              // Embed và save từng chunk
              let chunkIndex = 0;
              for (const group of chunkGroups) {
                for (const child of group.children) {
                  const embedding = await this.embeddingService.generateEmbedding(child);
                  
                  await this.db.insertChunk({
                    document_id: documentId,
                    content: child,
                    chunk_index: chunkIndex,
                    parent_index: group.parentIndex,
                    parent_content: group.parentContent,
                    embedding,
                  });

                  chunkIndex += 1;
                  totalChunks++;
                  
                  if (chunkIndex % 10 === 0) {
                    console.log(`  ✓ Processed ${chunkIndex}/${fileChunkCount} chunks`);
                  }
                }
              }

              console.log(`✅ Successfully ingested: ${objectName} (${fileChunkCount} chunks)`);

            } catch (fileError: any) {
              const errorMsg = `Error processing ${objectName}: ${fileError.message}`;
              console.error(`❌ ${errorMsg}`);
              errors.push(errorMsg);
              // Tiếp tục với file tiếp theo
            }
          }
        } catch (folderError: any) {
          const errorMsg = `Error scanning folder ${folder}: ${folderError.message}`;
          console.error(`❌ ${errorMsg}`);
          errors.push(errorMsg);
        }
      }

      console.log(`\n🎉 Ingest completed!`);
      console.log(`📊 Total files processed: ${totalFiles}`);
      console.log(`📦 Total chunks created: ${totalChunks}`);
      if (errors.length > 0) {
        console.log(`⚠️ Errors encountered: ${errors.length}`);
      }

      res.json({
        message: 'Ingest hoàn tất',
        totalFiles,
        totalChunks,
        errors: errors.length > 0 ? errors : undefined,
        folders: folders
      });

    } catch (error: any) {
      console.error('❌ Ingest failed:', error);
      res.status(500).json({ 
        error: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  }

  // Kiểm tra trạng thái ingest
  async checkIngestStatus(req: Request, res: Response) {
    try {
      const stats = await this.db.getIngestStats();
      res.json({
        summary: {
          totalDocuments: stats.totalDocuments,
          totalChunks: stats.totalChunks
        },
        documents: stats.documents
      });
    } catch (error: any) {
      console.error('Check status failed:', error);
      res.status(500).json({ error: error.message });
    }
  }
  // XÓA TOÀN BỘ DỮ LIỆU INGEST
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
      message: 'Đã xóa toàn bộ dữ liệu ingest',
      deletedChunks: chunksResult.rowCount,
      deletedDocuments: docsResult.rowCount
    });
  } catch (error: any) {
    console.error('Clear failed:', error);
    res.status(500).json({ error: error.message });
  }
}
}
