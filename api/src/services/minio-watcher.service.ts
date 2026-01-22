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

  /* 
   * INGEST FILES */
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
        const { documentMetadata, chunkMetadata } =
          this.documentService.parseMetadataFromPath(objectName);
        const documentId = await this.db.insertDocument({
          filename,
          file_path: objectName,
          file_size: buffer.length,
          content_type:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          document_type: documentMetadata.document_type,
          entity: documentMetadata.entity,
          major: documentMetadata.major,
          source_file: documentMetadata.source_file,
          subject_name: documentMetadata.subject_name,
          subject_code: documentMetadata.subject_code,
          credits: documentMetadata.credits,
          faculty: documentMetadata.faculty,
          level: documentMetadata.level,
          language: documentMetadata.language,
          academic_year: documentMetadata.academic_year,
          regulation_type: documentMetadata.regulation_type,
          decision_number: documentMetadata.decision_number,
          issued_year: documentMetadata.issued_year,
          issuing_body: documentMetadata.issuing_body,
          applicable_object: documentMetadata.applicable_object,
          effective_status: documentMetadata.effective_status,
          admission_year: documentMetadata.admission_year,
          education_level: documentMetadata.education_level,
          institution: documentMetadata.institution,
          applicable_major: documentMetadata.applicable_major,
          program_name: documentMetadata.program_name,
          major_code: documentMetadata.major_code,
          degree: documentMetadata.degree,
          total_credits: documentMetadata.total_credits,
          training_duration: documentMetadata.training_duration,
          admission_from_year: documentMetadata.admission_from_year,
          issuing_decision: documentMetadata.issuing_decision,
          issuing_date: documentMetadata.issuing_date,
          managing_unit: documentMetadata.managing_unit,
        });

        // 4. Chunk & Embed
        const chunks = this.documentService.chunkText(text);
        console.log(`  ✓ Created ${chunks.length} chunks`);
        
        for (let i = 0; i < chunks.length; i++) {
          const embedding = await this.embeddingService.generateEmbedding(chunks[i]);
          
          await this.db.insertChunk({
            document_id: documentId,
            content: chunks[i],
            chunk_index: i,
            embedding,
            document_type: chunkMetadata.document_type,
            entity: chunkMetadata.entity,
            major: chunkMetadata.major,
            source_file: chunkMetadata.source_file,
            subject_name: chunkMetadata.subject_name,
            subject_code: chunkMetadata.subject_code,
            credits: chunkMetadata.credits,
            faculty: chunkMetadata.faculty,
            level: chunkMetadata.level,
            language: chunkMetadata.language,
            academic_year: chunkMetadata.academic_year,
            regulation_type: chunkMetadata.regulation_type,
            decision_number: chunkMetadata.decision_number,
            issued_year: chunkMetadata.issued_year,
            issuing_body: chunkMetadata.issuing_body,
            applicable_object: chunkMetadata.applicable_object,
            effective_status: chunkMetadata.effective_status,
            admission_year: chunkMetadata.admission_year,
            education_level: chunkMetadata.education_level,
            institution: chunkMetadata.institution,
            applicable_major: chunkMetadata.applicable_major,
            program_name: chunkMetadata.program_name,
            major_code: chunkMetadata.major_code,
            degree: chunkMetadata.degree,
            total_credits: chunkMetadata.total_credits,
            training_duration: chunkMetadata.training_duration,
            admission_from_year: chunkMetadata.admission_from_year,
            issuing_decision: chunkMetadata.issuing_decision,
            issuing_date: chunkMetadata.issuing_date,
            managing_unit: chunkMetadata.managing_unit,
          });
          
          // Log progress mỗi 10 chunks
          if ((i + 1) % 10 === 0 || i === chunks.length - 1) {
            console.log(`  ✓ Embedded ${i + 1}/${chunks.length} chunks`);
          }
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
