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

  /* Bắt đầu xem - Mỗi 5 phut check 1 lần */
  async start(): Promise<void> {
    console.log('MinIO Watcher started');

    // Load files hiện tại
    await this.loadExistingFiles();

    // Check mỗi 5 phut
    this.intervalId = setInterval(() => {
      this.checkNewFiles();
    }, 300000); //đơn vị là mili giây
  }

  /* Dừng xem  */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      console.log(' MinIO Watcher stopped');
    }
  }

  /**
   * Load danh sách files đã có
   */
  private async loadExistingFiles(): Promise<void> {
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
  }

  /* Check files mới */
  private async checkNewFiles(): Promise<void> {
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
  }

  // Ingest files mới//
  private async ingestFiles(files: string[]): Promise<void> {
    for (const objectName of files) {
      try {
        console.log(`\n📥 ${objectName}`);

        // 1. Download
        const buffer = await this.minio.getFile(objectName);

        // 2. Extract text
        const rawText = await this.documentService.extractText(buffer, objectName);
        const text = this.documentService.cleanText(rawText);

        if (!text) {
          console.log('  ⚠️ No text, skipped');
          continue;
        }

        // 3. Save document
        const filename = objectName.split('/').pop() || objectName;
        const documentId = await this.db.insertDocument({
          filename,
          file_path: objectName,
          file_size: buffer.length,
          content_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        });

        // 4. Chunk & Embed
        const chunks = this.documentService.chunkText(text, 300, 50);

        for (let i = 0; i < chunks.length; i++) {
          const embedding = await this.embeddingService.generateEmbedding(chunks[i]);

          await this.db.insertChunk({
            document_id: documentId,
            content: chunks[i],
            chunk_index: i,
            embedding,
          });
        }

        console.log(`  ✅ Done (${chunks.length} chunks)`);
      } catch (error: any) {
        console.error(`  ❌ Error: ${error.message}`);
      }
    }
  }
}