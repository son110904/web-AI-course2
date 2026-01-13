import { MinIOModel } from '../models/minio.model';
import { DocumentService } from './document.service';
import { EmbeddingService } from './embedding.service';
import { DatabaseModel } from '../models/database.model';

export class MinIOWatcherService {
  private knownFiles: Set<string> = new Set();
  private intervalId?: NodeJS.Timeout;

  constructor(
    private minio: MinIOModel,
    private documentService: DocumentService,
    private embeddingService: EmbeddingService,
    private db: DatabaseModel
  ) {}

  /* Bắt đầu xem - Mỗi 5 phút check 1 lần */
  async start(): Promise<void> {
    console.log('MinIO Watcher started');
    
    // Load files hiện tại
    await this.loadExistingFiles();

    // Sync với database để ingest files thiếu
    await this.syncWithDatabase();
    
    // Check ngay lập tức lần đầu
    await this.checkNewFiles();
    
    // Check mỗi 5 phút
    this.intervalId = setInterval(async () => {
      await this.checkNewFiles(); 
    }, 300000);
  }

  /* Dừng xem */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      console.log('MinIO Watcher stopped');
    }
  }

  /**
   * Load danh sách files đã có
   */
  private async loadExistingFiles(): Promise<void> {
    try {
      const folders = ['ctdt-co-dau-moc', 'de-cuong', 'quy-che-hoc-vu'];
      
      for (const folder of folders) {
        const prefix = `chatbot courses/${folder}/`;
        const files = await this.minio.listFiles(prefix);
        
        files.forEach(file => {
          if (file.endsWith('.docx')) {
            this.knownFiles.add(file);
          }
        });
      }
      
      console.log(`✓ Tracking ${this.knownFiles.size} existing files`);
    } catch (error: any) {
      console.error('❌ Error loading existing files:', error.message);
    }
  }

  /* Check files mới */
  private async checkNewFiles(): Promise<void> {
    try {
      console.log('🔍 Checking for new files...');
      const folders = ['ctdt-co-dau-moc', 'de-cuong', 'quy-che-hoc-vu'];
      const newFiles: string[] = [];

      // Tìm files mới
      for (const folder of folders) {
        const prefix = `chatbot courses/${folder}/`;
        const files = await this.minio.listFiles(prefix);
        
        for (const file of files) {
          if (file.endsWith('.docx') && !this.knownFiles.has(file)) {
            newFiles.push(file);
            this.knownFiles.add(file);
            console.log(`📄 New file detected: ${file}`);
          }
        }
      }

      // Nếu có files mới → ingest
      if (newFiles.length > 0) {
        console.log(`📥 Found ${newFiles.length} new file(s), ingesting...`);
        await this.ingestFiles(newFiles);
      } else {
        console.log('✓ No new files');
      }
    } catch (error: any) {
      console.error('❌ Error checking new files:', error.message);
    }
  }

  // Ingest files mới
  private async ingestFiles(files: string[]): Promise<void> {
    for (const objectName of files) {
      try {
        console.log(`\n📥 Processing: ${objectName}`);
        
        // 1. Download
        const buffer = await this.minio.getFile(objectName);
        console.log(`  ✓ Downloaded (${buffer.length} bytes)`);
        
        // 2. Extract text
        const rawText = await this.documentService.extractText(buffer, objectName);
        const text = this.documentService.cleanText(rawText);
        
        if (!text || text.trim().length === 0) {
          console.log('  ⚠️ No text content, skipped');
          continue;
        }
        
        console.log(`  ✓ Extracted ${text.length} characters`);

        // 3. Save document
        const filename = objectName.split('/').pop() || objectName;
        const documentId = await this.db.insertDocument({
          filename,
          file_path: objectName,
          file_size: buffer.length,
          content_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        });
        
        console.log(`  ✓ Document saved with ID: ${documentId}`);

        // 4. Semantic Chunk & Embed (parent-child)
        const chunkGroups = await this.documentService.createSemanticChunks(
          text,
          this.embeddingService
        );
        const totalChunks = chunkGroups.reduce(
          (sum, group) => sum + group.children.length,
          0
        );
        console.log(`  ✓ Created ${totalChunks} chunks from ${chunkGroups.length} sections`);

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

            if (chunkIndex % 10 === 0 || chunkIndex === totalChunks) {
              console.log(`  ✓ Embedded ${chunkIndex}/${totalChunks} chunks`);
            }
          }
        }
        
        console.log(`  ✅ Successfully ingested: ${filename}`);
        
      } catch (error: any) {
        console.error(`  ❌ Error processing ${objectName}:`, error.message);
        console.error(error.stack);
        
        // Remove from known files nếu fail để retry lần sau
        this.knownFiles.delete(objectName);
      }
    }
  }
  /**
 * Đồng bộ lại: So sánh MinIO vs Database
 */
public async syncWithDatabase(): Promise<void> {
  console.log('🔄 Syncing MinIO files with database...');
  
  try {
    // 1. Lấy tất cả file paths từ database
    const dbFiles = await this.db.getAllDocumentPaths();
    const dbFileSet = new Set(dbFiles);
    
    console.log(`Database has ${dbFiles.length} documents`);
    console.log(`MinIO has ${this.knownFiles.size} files`);
    
    // 2. Tìm files trong MinIO nhưng chưa có trong DB
    const missingFiles: string[] = [];
    
    for (const file of this.knownFiles) {
      if (!dbFileSet.has(file)) {
        missingFiles.push(file);
      }
    }
    
    // 3. Ingest các files thiếu
    if (missingFiles.length > 0) {
      console.log(`\n⚠️  Found ${missingFiles.length} files not in database:`);
      missingFiles.forEach(f => console.log(`   - ${f}`));
      
      console.log('\n📥 Starting sync ingest...');
      await this.ingestFiles(missingFiles);
      console.log('✅ Sync completed!');
    } else {
      console.log('✅ All files are already in database');
    }
    
  } catch (error: any) {
    console.error('❌ Sync error:', error.message);
  }
}
}
