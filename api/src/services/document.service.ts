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
        throw new Error(`Unsupported file type: ${ext}`);
    }
  }


  private async extractPdf(buffer: Buffer): Promise<string> {
    const data = await pdfParse(buffer);
    return data.text || '';
  }

  private async extractDocx(buffer: Buffer): Promise<string> {
    const raw = await mammoth.extractRawText({ buffer });
    return raw.value || '';
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
    return text
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n +/g, '\n')
      .trim();
  }

  chunkText(text: string): string[] {
    if (!text) return [];

    // 1. Split by headings
    const sections = this.splitByHeadings(text);

    // 2. Build chunks from sections
    const chunks: string[] = [];
    let buffer = '';

    for (const section of sections) {
      if ((buffer + section).length < 1200) {
        buffer += (buffer ? '\n\n' : '') + section;
      } else {
        if (buffer.length > 200) {
          chunks.push(buffer.trim());
        }
        buffer = section;
      }
    }

    if (buffer.length > 200) {
      chunks.push(buffer.trim());
    }

    return chunks;
  }


  private splitByHeadings(text: string): string[] {
    const lines = text.split('\n');
    const sections: string[] = [];

    let current = '';

    for (const line of lines) {
      if (this.isHeading(line)) {
        if (current.trim().length > 0) {
          sections.push(current.trim());
        }
        current = line.trim();
      } else {
        current += '\n' + line.trim();
      }
    }

    if (current.trim().length > 0) {
      sections.push(current.trim());
    }

    return sections;
  }

  private isHeading(line: string): boolean {
    const l = line.trim();

    return (
      /^CHƯƠNG\s+\d+/i.test(l) ||
      /^Chương\s+\d+/i.test(l) ||
      /^MỤC\s+\d+/i.test(l) ||
      /^Mục\s+\d+/i.test(l) ||
      /^ĐIỀU\s+\d+/i.test(l) ||
      /^Điều\s+\d+/i.test(l) ||
      /^[IVX]+\./.test(l) ||          // I. II. III.
      /^\d+\.\d+/.test(l) ||           // 1.1 2.3
      /^\d+\./.test(l) ||              // 1. 2.
      /^[A-ZÀ-Ỵ\s]{5,}$/.test(l)       // TIÊU ĐỀ VIẾT HOA
    );
  }
}
