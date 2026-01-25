import { MinIOModel } from '../models/minio.model';
import { DocumentService } from './document.service';
import { EmbeddingService } from './embedding.service';
import { DatabaseModel } from '../models/database.model';

export class MinIOWatcherService {
  private knownFiles: Set<string> = new Set();

  // dùng setTimeout thay vì setInterval để tránh overlap
  private timer?: NodeJS.Timeout;
  private running = false;

  // nếu muốn khóa tuyệt đối mọi ingest/check chạy tuần tự
  private busy = false;

  // NOTE: kiểm tra lại tên folder thật trong MinIO:
  // 'relegation' rất dễ là typo của 'regulation'
  private readonly folders = ['curriculum', 'relegation', 'syllabus'] as const;

  private readonly intervalMs = 300000; // 5 phút

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

    this.running = true;

    await this.loadExistingFiles();
    await this.syncWithDatabase();

    // tick ngay lần đầu, sau đó schedule tuần tự
    await this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    console.log('🛑 MinIO Watcher stopped');
  }

  /* =====================================================
   * MAIN LOOP TICK (no overlap)
   * ===================================================== */
  private async tick(): Promise<void> {
    if (!this.running) return;

    // lock đơn giản chống overlap
    if (this.busy) {
      // nếu đang bận, schedule lại lần sau
      this.timer = setTimeout(() => void this.tick(), this.intervalMs);
      return;
    }

    this.busy = true;
    try {
      await this.checkNewFiles();
    } catch (err) {
      console.error(err);
    } finally {
      this.busy = false;
      if (this.running) {
        this.timer = setTimeout(() => void this.tick(), this.intervalMs);
      }
    }
  }

  /* =====================================================
   * LOAD FILES FROM MINIO
   * ===================================================== */
  private async loadExistingFiles(): Promise<void> {
    for (const folder of this.folders) {
      const prefix = `courses-chatbot/${folder}/`;
      const files = await this.minio.listFiles(prefix);

      files
        .filter(f => f.endsWith('.docx'))
        .filter(f => !f.split('/').pop()?.startsWith('~$')) // bỏ file tạm Word
        .forEach(f => this.knownFiles.add(f));
    }

    console.log(`✓ Tracking ${this.knownFiles.size} files from MinIO`);
  }

  /* =====================================================
   * CHECK NEW FILES
   * ===================================================== */
  private async checkNewFiles(): Promise<void> {
    console.log('🔍 Checking for new files...');

    const newFiles: string[] = [];

    for (const folder of this.folders) {
      const prefix = `courses-chatbot/${folder}/`;
      const files = await this.minio.listFiles(prefix);

      for (const file of files) {
        if (!file.endsWith('.docx')) continue;

        const base = file.split('/').pop() || '';
        if (base.startsWith('~$')) continue; // bỏ file tạm Word

        if (!this.knownFiles.has(file)) {
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

        // 2. Extract & clean
        const rawText = await this.documentService.extractText(buffer, objectName);
        const text = (rawText || '').trim();

        if (!text || text.length < 200) {
          console.log('⚠️ File too short/empty after trim, skipped');
          continue;
        }

        // 3. Save document
        const filename = objectName.split('/').pop()!;
        const { documentMetadata, chunkMetadata } =
          this.documentService.parseMetadataFromPath(objectName);

        // Nếu DB của bạn có unique(file_path), nên xử lý duplicate ở đây:
        // - tốt nhất: db.upsertDocument(...) trả về documentId
        // - hoặc: nếu insertDocument fail unique -> lấy documentId theo file_path
        let documentId: number;

        try {
          documentId = await this.db.insertDocument({
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
        } catch (e: any) {
          // ✅ CHỐT: Không retry vô hạn với lỗi duplicate.
          // Bạn nên thay bằng check error code unique của driver DB bạn dùng.
          // Ví dụ: if (e.code === 'SQLITE_CONSTRAINT' || e.code === '23505') ...
          //
          // Nếu bạn có method này, dùng:
          // documentId = await this.db.getDocumentIdByPath(objectName);
          //
          // Nếu chưa có, tạm thời throw để bạn bổ sung method cho chuẩn.
          console.error('❌ insertDocument failed (maybe duplicate). Consider upsert/get-by-path.', e?.message);
          throw e;
        }

        // 4. Chunk & Embed
        const chunks = this.documentService
          .chunkText(text)
          .map(c => c.trim())
          .filter(Boolean);

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

          if ((i + 1) % 10 === 0 || i === chunks.length - 1) {
            console.log(`  ✓ Embedded ${i + 1}/${chunks.length} chunks`);
          }
        }

        console.log(`✅ Ingested successfully: ${filename}`);
      } catch (error: any) {
        console.error(`❌ Failed ingest ${objectName}`, error?.message);

        // retry lần sau (hợp lý cho lỗi tạm thời: network/minio/extract)
        // nhưng nếu lỗi là duplicate DB, bạn nên xử lý ở catch insertDocument để không rơi vào đây mãi
        this.knownFiles.delete(objectName);
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

    const missingFiles = [...this.knownFiles].filter(f => !dbSet.has(f));

    if (missingFiles.length > 0) {
      console.log(`⚠️ ${missingFiles.length} files missing in DB`);
      await this.ingestFiles(missingFiles);
    } else {
      console.log('✓ Database is up to date');
    }
  }
}
