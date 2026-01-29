import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import { DocumentMetadata } from '../models/database.model';

export class DocumentService {

  /* ========================================
     TEXT EXTRACTION
  ======================================== */
  async extractText(buffer: Buffer, filename: string): Promise<string> {
    const ext = filename.split('.').pop()?.toLowerCase();

    let raw = '';
    switch (ext) {
      case 'pdf':
        raw = (await pdfParse(buffer)).text || '';
        break;
      case 'docx':
        raw = (await mammoth.extractRawText({ buffer })).value || '';
        break;
      case 'txt':
        raw = buffer.toString('utf-8');
        break;
      case 'xlsx':
      case 'xls':
        raw = this.extractExcel(buffer);
        break;
      default:
        throw new Error(`Unsupported file type: ${ext}`);
    }

    return this.cleanText(raw);
  }

  private extractExcel(buffer: Buffer): string {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    return workbook.SheetNames
      .map(name => XLSX.utils.sheet_to_csv(workbook.Sheets[name]))
      .join('\n');
  }

  cleanText(text: string): string {
    if (!text) return '';

    return text
      .replace(/\r\n/g, '\n')
      .replace(/\t/g, ' ')
      .replace(/[ ]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /* ========================================
     METADATA PARSING (FULL)
  ======================================== */
  parseMetadataFromPath(
    filePath: string,
    fileContent?: string
  ): DocumentMetadata {
    const normalized = filePath.replace(/\\/g, '/');
    const parts = normalized.split('/');
    const filename = parts.pop() || normalized;

    const folder =
      parts.find(p =>
        ['syllabus', 'curriculum', 'regulation'].includes(p)
      ) || 'syllabus';

    console.log(`📋 Parsing metadata for: ${filename} (folder: ${folder})`);

    switch (folder) {
      case 'syllabus':
        return this.parseSyllabusMetadata(filename, fileContent);
      case 'curriculum':
        return this.parseCurriculumMetadata(filename, fileContent);
      case 'regulation':
        return this.parseRegulationMetadata(filename, fileContent);
      default:
        return this.parseSyllabusMetadata(filename, fileContent);
    }
  }

  /* ========================================
     SYLLABUS METADATA
  ======================================== */
  private parseSyllabusMetadata(
    filename: string,
    content?: string
  ): DocumentMetadata {
    const cleanName = filename.replace('.docx', '').trim();

    const parts = cleanName.split('_');
    const subjectName = parts[0] || cleanName;
    const subjectCode = parts[1] || this.extractSubjectCode(cleanName);

    return {
      document_type: 'syllabus',
      subject_name: subjectName,
      subject_code: subjectCode,
      major: this.detectMajor(cleanName), credits: this.extractCredits(content),
      faculty: this.detectFaculty(cleanName),
      level: 'undergraduate',
      language: 'vi',
      academic_year: this.extractAcademicYear(content) || '2024-2025',
      source_file: filename
    };
  }

  /* ========================================
     CURRICULUM METADATA
  ======================================== */
  private parseCurriculumMetadata(
    filename: string,
    content?: string
  ): DocumentMetadata {
    const cleanName = filename.replace('.docx', '').toLowerCase();
    const major = this.detectMajorFull(cleanName);

    return {
      document_type: 'curriculum',
      program_name: this.extractProgramName(cleanName),
      major,
      major_code: this.getMajorCode(major),
      degree: 'Bachelor',
      total_credits: this.extractTotalCredits(content) || 130,
      training_duration: '4 years',
      admission_from_year: this.extractAdmissionYear(content) || 2024,
      issuing_decision: this.extractDecisionNumber(content) || 'N/A',
      issuing_date: this.extractIssuingDate(content) || 'N/A',
      managing_unit: this.detectFaculty(cleanName),
      language: 'vi',
      source_file: filename
    };
  }

  /* ========================================
     REGULATION METADATA
  ======================================== */
  private parseRegulationMetadata(
    filename: string,
    content?: string
  ): DocumentMetadata {
    const cleanName = filename.replace('.docx', '').toLowerCase();
    const isAdmission =
      cleanName.includes('tuyển sinh') || cleanName.includes('đề án');

    if (isAdmission) {
      return {
        document_type: 'regulation',
        regulation_type: 'admission_policy',
        admission_year: this.extractYear(cleanName) || new Date().getFullYear(),
        education_level: 'undergraduate',
        institution: 'Đại học Kinh tế Quốc dân',
        applicable_major: 'all',
        issuing_body: 'Hội đồng tuyển sinh',
        language: 'vi',
        source_file: filename
      };
    }

    return {
      document_type: 'regulation',
      regulation_type: 'student_assessment',
      decision_number: this.extractDecisionNumber(content),
      issued_year: this.extractYear(cleanName),
      issuing_body: 'Trường Đại học Kinh tế Quốc dân',
      applicable_object: 'sinh viên',
      effective_status: this.isExpired(content) ? 'expired' : 'active',
      language: 'vi',
      source_file: filename
    };
  }

  /* ========================================
     CHUNKING (🔥 MODIFIED)
  ======================================== */
  chunkText(
    text: string,
    metadata?: DocumentMetadata,
    chunkSize = 700,
    overlap = 200
  ): string[] {
    if (!text) return [];

    const chunks: string[] = [];
    let start = 0;

    const safeMetadata: DocumentMetadata =
      metadata ?? ({ document_type: 'syllabus', source_file: 'unknown' } as DocumentMetadata);

    if (!metadata) {
      console.warn('⚠️ chunkText called without metadata; using default header');
    }

    const docHeader =
      `[TÀI LIỆU: ${safeMetadata.source_file} | LOẠI: ${safeMetadata.document_type}]`;

    while (start < text.length) {
      const end = Math.min(start + chunkSize, text.length);
      const slice = text.slice(start, end).trim();

      if (slice.length > 50) {
        chunks.push(`${docHeader}\n${slice}`);
      }

      start += chunkSize - overlap;
    }

    return chunks;
  }

  /* ========================================
     HELPERS
  ======================================== */
  private extractSubjectCode(text: string): string {
    const match = text.match(/[A-Z]{2,4}\d{3,4}/i);
    return match ? match[0].toUpperCase() : 'UNKNOWN';
  }

  private detectMajor(text: string): string {
    const lower = text.toLowerCase();
    if (lower.includes('công nghệ thông tin') || lower.includes('cntt')) {
      return 'Công nghệ thông tin';
    }
    if (lower.includes('khoa học máy tính') || lower.includes('khmt')) {
      return 'Khoa học máy tính';
    }
    if (lower.includes('kinh tế')) {
      return 'Kinh tế';
    }
    if (lower.includes('marketing')) {
      return 'Marketing';
    }
    return 'Khác';
  }

  private detectMajorFull(text: string): string {
    if (text.includes('công nghệ thông tin') || text.includes('cntt')) {
      return 'Công nghệ thông tin';
    }
    if (text.includes('khoa học máy tính')) {
      return 'Khoa học máy tính';
    }
    if (text.includes('marketing')) {
      return 'Marketing';
    }
    if (text.includes('kế toán')) {
      return 'Kế toán';
    }
    return 'Đa ngành';
  }

  private getMajorCode(major: string): string {
    const map: Record<string, string> = {
      'Công nghệ thông tin': '7480201',
      'Khoa học máy tính': '7480101',
      'Marketing': '7340115',
      'Kế toán': '7340301'
    };
    return map[major] || '7000000';
  }

  private detectFaculty(text: string): string {
    const lower = text.toLowerCase();
    if (lower.includes('cntt')) return 'Viện CNTT & Kinh tế số';
    if (lower.includes('marketing')) return 'Khoa Marketing';
    return 'Đại học Kinh tế Quốc dân';
  }

  private extractCredits(content?: string): number {
    if (!content) return 3;
    const match = content.match(/(\d{1,2})\s*(tín chỉ|tc|credits?)/i);
    return match ? parseInt(match[1]) : 3;
  }

  private extractTotalCredits(content?: string): number {
    const match = content?.match(/tổng số.*?(\d{2,3})\s*(tín chỉ|credits)/i);
    return match ? parseInt(match[1]) : 130;
  }

  private extractAcademicYear(content?: string): string | undefined {
    const match = content?.match(/(\d{4})[-–](\d{4})/);
    return match ? `${match[1]}-${match[2]}` : undefined;
  }

  private extractAdmissionYear(content?: string): number | undefined {
    const match = content?.match(/khóa\s*(\d{4})/i);
    return match ? parseInt(match[1]) : undefined;
  }

  private extractDecisionNumber(content?: string): string | undefined {
    const match = content?.match(/(\d+\/[A-Z]{2}[-–][A-ZĐ]+)/i);
    return match ? match[1] : undefined;
  }private extractIssuingDate(content?: string): string | undefined {
    const match = content?.match(/\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}/);
    return match ? match[0] : undefined;
  }

  private extractYear(text: string): number | undefined {
    const match = text.match(/\b(20\d{2})\b/);
    return match ? parseInt(match[1]) : undefined;
  }

  private extractProgramName(text: string): string {
    if (text.includes('công nghệ thông tin')) return 'Cử nhân Công nghệ thông tin';
    if (text.includes('khoa học máy tính')) return 'Cử nhân Khoa học máy tính';
    return 'Chương trình đào tạo';
  }

  private isExpired(content?: string): boolean {
    if (!content) return false;
    if (content.includes('hết hiệu lực') || content.includes('đã thay thế')) {
      return true;
    }
    const year = this.extractYear(content);
    return !!(year && year < 2020);
  }
}
