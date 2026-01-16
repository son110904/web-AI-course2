import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';

export class DocumentService {
  constructor() {}

  async extractText(buffer: Buffer, filename: string): Promise<string> {
    const ext = filename.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'pdf':
        return this.cleanText(await this.extractPdf(buffer));
      case 'docx':
        return this.cleanText(await this.extractDocx(buffer));
      case 'txt':
        return this.cleanText(buffer.toString('utf-8'));
      case 'xlsx':
      case 'xls':
        return this.cleanText(this.extractExcel(buffer));
      default:
        throw new Error(`Unsupported file type: ${ext}`); // ✅ FIXED: Thêm dấu ngoặc ()
    }
  }

  private async extractPdf(buffer: Buffer): Promise<string> {
    const data = await pdfParse(buffer);
    return data.text || '';
  }

  private async extractDocx(buffer: Buffer): Promise<string> {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  private extractExcel(buffer: Buffer): string {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    return workbook.SheetNames
      .map((name) =>
        XLSX.utils.sheet_to_csv(workbook.Sheets[name])
      )
      .join('\n');
  }

  public cleanText(text: string): string {
    if (!text) return '';

    const normalizedNewlines = text.replace(/\r\n/g, '\n');
    const cleanedLines = normalizedNewlines
      .split('\n')
      .map(line => line.replace(/\t/g, ' ').replace(/[ ]{2,}/g, ' ').trimEnd());

    const merged = cleanedLines.join('\n').trim();
    return this.normalizeLabelValuePairs(merged);
  }

  public parseMetadataFromPath(filePath: string): {
    document_type: string;
    entity: string;
    major: string;
    source_file: string;
  } {
    const normalizedPath = filePath.replace(/\\/g, '/');
    const filename = normalizedPath.split('/').pop() || normalizedPath;
    const lower = normalizedPath.toLowerCase();

    const documentType = this.normalizeDocumentType(lower);
    const major = this.normalizeMajor(lower);
    const entity = this.normalizeEntity(filename);

    return {
      document_type: documentType,
      entity,
      major,
      source_file: filename,
    };
  }

  // Chunk theo ngữ nghĩa: heading -> đoạn -> fallback chunk size
  chunkText(text: string, chunkSize: number = 800, overlapRatio: number = 0.4): string[] {
    if (!text) return [];

    const sections = this.splitByHeadings(text);
    const chunks: string[] = [];
    const overlap = Math.max(1, Math.floor(chunkSize * overlapRatio));

    for (const section of sections) {
      const paragraphs = section
        .split(/\n\s*\n/)
        .map(p => p.trim())
        .filter(Boolean);

      let buffer = '';

      for (const paragraph of paragraphs) {
        if (buffer.length === 0) {
          buffer = paragraph;
          continue;
        }

        if ((buffer + '\n\n' + paragraph).length <= chunkSize) {
          buffer = `${buffer}\n\n${paragraph}`;
        } else {
          chunks.push(buffer.trim());
          buffer = paragraph;
        }
      }

      if (buffer.trim()) {
        chunks.push(buffer.trim());
      }
    }

    return this.enforceChunkSize(chunks, chunkSize, overlap);
  }

  // 🐛 FIX: Thêm phương thức splitByHeadings nếu cần sử dụng
  private splitByHeadings(text: string): string[] {
    // Tách văn bản theo các tiêu đề (heading)
    // Phát hiện các pattern như: "1.", "1.1", "Chương 1", etc.
    const headingPatterns = [
      /^\d+\.\s+.+$/gm,           // "1. Tiêu đề"
      /^\d+\.\d+\s+.+$/gm,        // "1.1 Tiêu đề"
      /^[A-Z][^\n]{10,80}$/gm,    // Dòng chữ in hoa ngắn
      /^Chương\s+\d+/gm,          // "Chương 1"
      /^Phần\s+\d+/gm,            // "Phần 1"
    ];

    const sections: string[] = [];
    let currentSection = '';
    const lines = text.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      const isHeading = headingPatterns.some(pattern =>
        pattern.test(trimmed)
      );

      if (isHeading && currentSection.length > 100) {
        sections.push(currentSection.trim());
        currentSection = trimmed + '\n';
      } else {
        currentSection += line + '\n';
      }
    }

    if (currentSection.trim()) {
      sections.push(currentSection.trim());
    }

    return sections.filter(Boolean);
  }

  // Phương thức kết hợp cả hai cách: chia theo heading và theo size
  chunkTextAdvanced(text: string, chunkSize: number = 800, overlap: number = 320): string[] {
    if (!text) return [];

    // 1. Chia theo headings trước
    const sections = this.splitByHeadings(text);
    
    // 2. Chia mỗi section thành chunks nhỏ hơn nếu cần
    const allChunks: string[] = [];
    
    for (const section of sections) {
      if (section.length <= chunkSize) {
        allChunks.push(section);
      } else {
        // Section quá dài -> chia nhỏ
        let start = 0;
        while (start < section.length) {
          const end = Math.min(start + chunkSize, section.length);
          const chunk = section.slice(start, end).trim();
          
          if (chunk) {
            allChunks.push(chunk);
          }
          
          start += chunkSize - overlap;
        }
      }
    }

    return allChunks.filter(Boolean);
  }

  private normalizeLabelValuePairs(text: string): string {
    return text.replace(
      /((?:[\p{L}\p{N}]+\s*\n)+[\p{L}\p{N}]+)\s*\n*:\s*\n*([^\n]+)/gu,
      (match, labelBlock: string, value: string) => {
        const label = labelBlock
          .split('\n')
          .map(part => part.trim())
          .filter(Boolean)
          .join(' ');
        return `${label}: ${value.trim()}`;
      }
    );
  }

  private normalizeDocumentType(path: string): string {
    if (path.includes('relegation') || path.includes('quy_dinh') || path.includes('quy-dinh') || path.includes('regulation')) {
      return 'quy_dinh';
    }
    if (path.includes('syllabus') || path.includes('de_cuong') || path.includes('đề cương')) {
      return 'de_cuong';
    }
    if (path.includes('curriculum') || path.includes('chuong_trinh') || path.includes('chương trình')) {
      return 'chuong_trinh';
    }
    return 'khac';
  }

  private normalizeMajor(path: string): string {
    if (/(cntt|cong nghe thong tin|công nghệ thông tin|it|computer science)/i.test(path)) {
      return 'CNTT';
    }
    return 'KHAC';
  }

  private normalizeEntity(filename: string): string {
    const base = filename.replace(/\.[^.]+$/, '');
    const normalized = base
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');

    if (normalized.includes('chuyen_de_thuc_tap') || normalized.includes('chuyen_de') || normalized.includes('thuc_tap')) {
      return 'chuyen_de_thuc_tap';
    }

    return normalized || 'unknown';
  }

  private enforceChunkSize(chunks: string[], chunkSize: number, overlap: number): string[] {
    const finalChunks: string[] = [];

    for (const chunk of chunks) {
      if (chunk.length <= chunkSize) {
        finalChunks.push(chunk);
        continue;
      }

      let start = 0;
      while (start < chunk.length) {
        const end = Math.min(start + chunkSize, chunk.length);
        const slice = chunk.slice(start, end).trim();
        if (slice) {
          finalChunks.push(slice);
        }
        start += chunkSize - overlap;
      }
    }

    return finalChunks.filter(Boolean);
  }
}
