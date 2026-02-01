import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';

export class DocumentService {
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

  // ========================================
  // METADATA PARSING - Returns single metadata object
  // ========================================

  parseMetadataFromPath(filePath: string, fileContent?: string): Record<string, any> {
    const normalized = filePath.replace(/\\/g, '/');
    const parts = normalized.split('/');
    const filename = parts.pop() || normalized;
    
    // Xác định folder
    const folder = parts.find(p => 
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

  // ========================================
  // SYLLABUS METADATA
  // ========================================
  private parseSyllabusMetadata(filename: string, content?: string): Record<string, any> {
    const cleanName = filename.replace('.docx', '').trim();
    
    // Parse pattern: "Tên học phần_Mã môn"
    const parts = cleanName.split('_');
    const subjectName = parts[0] || cleanName;
    const subjectCode = parts[1] || this.extractSubjectCode(cleanName);

    return {
      document_type: 'syllabus',
      subject_name: subjectName,
      subject_code: subjectCode,
      major: this.detectMajor(cleanName),
      credits: this.extractCredits(content),
      faculty: this.detectFaculty(cleanName),
      level: 'undergraduate',
      language: 'vi',
      academic_year: this.extractAcademicYear(content) || '2024-2025',
      source_file: filename
    };
  }

  // ========================================
  // CURRICULUM METADATA
  // ========================================
  private parseCurriculumMetadata(filename: string, content?: string): Record<string, any> {
    const cleanName = filename.replace('.docx', '').toLowerCase();
    const major = this.detectMajorFull(cleanName);

    return {
      document_type: 'curriculum',
      program_name: this.extractProgramName(cleanName),
      major: major,
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

  // ========================================
  // REGULATION METADATA
  // ========================================
  private parseRegulationMetadata(filename: string, content?: string): Record<string, any> {
    const cleanName = filename.replace('.docx', '').toLowerCase();
    
    // Kiểm tra loại regulation
    const isAdmission = cleanName.includes('tuyển sinh') || cleanName.includes('đề án');
    
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
    
    // Các quy chế khác (đánh giá, rèn luyện, v.v.)
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

  // ========================================
  // HELPER FUNCTIONS
  // ========================================

  private extractSubjectCode(text: string): string {
    // Match patterns: CNTT1153, IT301, etc.
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
    if (lower.includes('kinh tế') || lower.includes('ktqt')) {
      return 'Kinh tế quốc tế';
    }
    if (lower.includes('marketing') || lower.includes('mkt')) {
      return 'Marketing';
    }
    
    return 'Khác';
  }

  private detectMajorFull(text: string): string {
    if (text.includes('công nghệ thông tin') || text.includes('cntt')) {
      return 'Công nghệ thông tin';
    }
    if (text.includes('khoa học máy tính') || text.includes('khmt')) {
      return 'Khoa học máy tính';
    }
    if (text.includes('kinh tế quốc tế')) {
      return 'Kinh tế quốc tế';
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
    const codes: Record<string, string> = {
      'Công nghệ thông tin': '7480201',
      'Khoa học máy tính': '7480101',
      'Kinh tế quốc tế': '7310106',
      'Marketing': '7340115',
      'Kế toán': '7340301'
    };
    
    return codes[major] || '7000000';
  }

  private detectFaculty(text: string): string {
    const lower = text.toLowerCase();
    
    if (lower.includes('cntt') || lower.includes('công nghệ thông tin')) {
      return 'Viện CNTT & Kinh tế số';
    }
    if (lower.includes('kinh tế')) {
      return 'Khoa Kinh tế';
    }
    if (lower.includes('marketing')) {
      return 'Khoa Marketing';
    }
    
    return 'Đại học Kinh tế Quốc dân';
  }

  private normalizeForSearch(text: string): string {
    return text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private extractCredits(content?: string): number {
    if (!content) return 3;

    const normalized = this.normalizeForSearch(content);
    const patterns: RegExp[] = [
      /so\s*tin\s*chi\s*[:\-]?\s*(\d{1,2})/i,
      /tin\s*chi\s*[:\-]?\s*(\d{1,2})/i,
      /credits?\s*[:\-]?\s*(\d{1,2})/i,
      /(\d{1,2})\s*(tin\s*chi|tc|credits?)\b/i
    ];

    const values: number[] = [];
    for (const pattern of patterns) {
      const match = normalized.match(pattern);
      if (match) {
        const value = parseInt(match[1], 10);
        if (!Number.isNaN(value) && value > 0) {
          values.push(value);
        }
      }
    }

    if (values.length === 0) return 3;
    return Math.max(...values);
  }

  private extractTotalCredits(content?: string): number {
    if (!content) return 130;
    
    const match = content.match(/tổng số.*?(\d{2,3})\s*(?:tín chỉ|credits)/i);
    return match ? parseInt(match[1]) : 130;
  }

  private extractAcademicYear(content?: string): string | undefined {
    if (!content) return undefined;
    
    // Match: "2024-2025", "năm học 2024"
    const match = content.match(/(?:năm học\s*)?(\d{4})[-–]?(\d{4})?/i);
    if (match) {
      return match[2] ? `${match[1]}-${match[2]}` : match[1];
    }
    
    return undefined;
  }

  private extractAdmissionYear(content?: string): number | undefined {
    if (!content) return undefined;
    
    const match = content.match(/khóa\s*(\d{4})/i);
    return match ? parseInt(match[1]) : undefined;
  }

  private extractDecisionNumber(content?: string): string | undefined {
    if (!content) return undefined;
    
    // Match: "1566/QĐ-ĐHKTQD", "Số 123/QĐ"
    const match = content.match(/(?:số\s*)?(\d+\/[A-Z]{2}[-–][A-ZĐ]+)/i);
    return match ? match[1] : undefined;
  }

  private extractIssuingDate(content?: string): string | undefined {
    if (!content) return undefined;
    
    // Match: "28/12/2023", "2023-12-28"
    const match = content.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})/);
    return match ? match[1] : undefined;
  }

  private extractYear(text: string): number | undefined {
    const match = text.match(/\b(20\d{2})\b/);
    return match ? parseInt(match[1]) : undefined;
  }

  private extractProgramName(text: string): string {
    if (text.includes('công nghệ thông tin')) {
      return 'Cử nhân Công nghệ thông tin';
    }
    if (text.includes('khoa học máy tính')) {
      return 'Cử nhân Khoa học máy tính';
    }
    
    return 'Chương trình đào tạo';
  }

  private isExpired(content?: string): boolean {
    if (!content) return false;
    
    // Kiểm tra xem có từ "hết hiệu lực" hay năm cũ
    if (content.includes('hết hiệu lực') || content.includes('đã thay thế')) {
      return true;
    }
    
    const year = this.extractYear(content);
    if (year && year < 2020) {
      return true;
    }
    
    return false;
  }

  // ========================================
  // CHUNKING
  // ========================================
  chunkText(
    text: string,
    chunkSize = 700,
    overlap = 200
  ): string[] {
    if (!text) return [];

    const chunks: string[] = [];
    let start = 0;

    while (start < text.length) {
      const end = Math.min(start + chunkSize, text.length);
      const slice = text.slice(start, end).trim();
      if (slice.length > 50) {
        chunks.push(slice);
      }
      start += chunkSize - overlap;
    }

    return chunks;
  }
}