const pdfParse: any = require('pdf-parse');
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';

export class DocumentService {
  constructor() {}

  // MAIN: extract text from Buffer
  async extractText(buffer: Buffer, filename: string): Promise<string> {
    const ext = filename.split('.').pop()?.toLowerCase();

    switch (ext) {
      case 'pdf':
        return this.extractPdf(buffer);

      case 'docx':
        return this.extractDocx(buffer);

      case 'txt':
        return buffer.toString('utf-8');

      case 'xlsx':
      case 'xls':
        return this.extractExcel(buffer);

      default:
        throw new Error(`Unsupported file type: ${ext}`);
    }
  }

  // =========================
  // HELPERS
  // =========================
  private async extractPdf(buffer: Buffer): Promise<string> {
    const data = await pdfParse(buffer);
    return data.text;
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

  // =========================
  // CLEAN + CHUNK
  // =========================
  cleanText(text: string): string {
    if (!text) return '';
    return text
      .replace(/\r\n/g, '\n')
      .replace(/\n{2,}/g, '\n')
      .replace(/[\t ]+/g, ' ')
      .trim();
  }

  chunkText(text: string, chunkSize = 500, overlap = 100): string[] {
    const chunks: string[] = [];
    let start = 0;

    while (start < text.length) {
      const end = Math.min(start + chunkSize, text.length);
      chunks.push(text.slice(start, end));
      start += chunkSize - overlap;
    }

    return chunks.filter(Boolean);
  }

  // alias để KHỚP với controller
  splitText(text: string, chunkSize = 300, overlap = 50): string[] {
    return this.chunkText(text, chunkSize, overlap);
  }
}


