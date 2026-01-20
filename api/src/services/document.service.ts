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

  /* =========================
     TEXT CLEANING (NEUTRAL)
  ========================== */
  cleanText(text: string): string {
    if (!text) return '';

    return text
      .replace(/\r\n/g, '\n')
      .replace(/\t/g, ' ')
      .replace(/[ ]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /* =========================
     METADATA – GIỮ TRUNG LẬP
  ========================== */
  parseMetadataFromPath(filePath: string) {
    const normalized = filePath.replace(/\\/g, '/');
    const filename = normalized.split('/').pop() || normalized;
    const lower = filename.toLowerCase();

    return {
      document_type: this.detectDocumentType(lower),
      entity: this.detectEntity(lower),
      major: this.detectMajor(lower),
      source_file: filename,
    };
  }

  private detectDocumentType(name: string): string {
    if (name.includes('chuong_trinh') || name.includes('ctdt')) return 'chuong_trinh';
    if (name.includes('de_cuong') || name.includes('syllabus')) return 'de_cuong';
    if (name.includes('quy_dinh') || name.includes('regulation')) return 'quy_dinh';
    return 'tai_lieu';
  }

  private detectEntity(name: string): string {
    return name
      .replace(/\.[^.]+$/, '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  private detectMajor(name: string): string {
    if (/khoa_hoc_may_tinh|computer_science|khmt/.test(name)) return 'KHMT';
    if (/cong_nghe_thong_tin|cntt|information_technology/.test(name)) return 'CNTT';
    return 'KHAC';
  }

  /* =========================
     CHUNKING – PHẲNG, CÔNG BẰNG
  ========================== */
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