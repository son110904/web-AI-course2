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

  /* =====================================================
   * START WATCHER
   * ===================================================== */
  async start(): Promise<void> {
    console.log('🚀 MinIO Watcher started');

    await this.loadExistingFiles();
    await this.syncWithDatabase();
    await this.checkNewFiles();

    this.intervalId = setInterval(() => {
      this.checkNewFiles().catch(console.error);
    }, 300000); // 5 phút
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      console.log('🛑 MinIO Watcher stopped');
    }
  }

  /* =====================================================
   * LOAD FILES FROM MINIO
   * ===================================================== */
  private async loadExistingFiles(): Promise<void> {
    const folders = ['curriculum', 'relegation', 'syllabus'];

    for (const folder of folders) {
      const prefix = `courses-chatbot/${folder}/`;
      const files = await this.minio.listFiles(prefix);

      files
        .filter(f => f.endsWith('.docx'))
        .forEach(f => this.knownFiles.add(f));
    }

    console.log(`✓ Tracking ${this.knownFiles.size} files from MinIO`);
  }

  /* =====================================================
   * CHECK NEW FILES
   * ===================================================== */
  private async checkNewFiles(): Promise<void> {
    console.log('🔍 Checking for new files...');

    const folders = ['curriculum', 'relegation', 'syllabus'];
    const newFiles: string[] = [];

    for (const folder of folders) {
      const prefix = `courses-chatbot/${folder}/`;
      const files = await this.minio.listFiles(prefix);

      for (const file of files) {
        if (file.endsWith('.docx') && !this.knownFiles.has(file)) {
          this.knownFiles.add(file);
          newFiles.push(file);
          console.log(`📄 New file detected: ${file}`);
        }
      }
    }

    if (newFiles.length > 0) {
      await this.ingestFiles(newFiles);
    } else {
      console.log('✓ No new files');
    }
  }

  /* =====================================================
   * INGEST FILES
   * ===================================================== */
  private async ingestFiles(files: string[]): Promise<void> {
    for (const objectName of files) {
      try {
        console.log(`\n📥 Ingesting: ${objectName}`);

        // 1. Download
        const buffer = await this.minio.getFile(objectName);

        // 2. Extract & clean (đã clean sẵn)
        const text = await this.documentService.extractText(buffer, objectName);

        if (!text || text.length < 200) {
          console.log('⚠️ File too short, skipped');
          continue;
        }

        // 3. Save document
        const filename = objectName.split('/').pop()!;
        const documentId = await this.db.insertDocument({
          filename,
          file_path: objectName,
          file_size: buffer.length,
          content_type:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        });

        // 4. Chunk (STRUCTURE-BASED)
        const chunks = this.documentService.chunkText(text);
        console.log(`✓ Created ${chunks.length} chunks`);

        // 5. Embed + save
        for (let i = 0; i < chunks.length; i++) {
          const embedding = await this.embeddingService.generateEmbedding(chunks[i]);

          await this.db.insertChunk({
            document_id: documentId,
            content: chunks[i],
            chunk_index: i,
            embedding,
          });
        }

        console.log(`✅ Ingested successfully: ${filename}`);

      } catch (error: any) {
        console.error(`❌ Failed ingest ${objectName}`, error.message);
        this.knownFiles.delete(objectName); // retry lần sau
      }
    }
  }

  /* =====================================================
   * SYNC MINIO VS DATABASE
   * ===================================================== */
  public async syncWithDatabase(): Promise<void> {
    console.log('🔄 Syncing MinIO with database...');

    const dbFiles = await this.db.getAllDocumentPaths();
    const dbSet = new Set(dbFiles);

    const missingFiles = [...this.knownFiles].filter(
      f => !dbSet.has(f)
    );

    if (missingFiles.length > 0) {
      console.log(`⚠️ ${missingFiles.length} files missing in DB`);
      await this.ingestFiles(missingFiles);
    } else {
      console.log('✓ Database is up to date');
    }
  }
}
