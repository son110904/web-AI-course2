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

  // HELPERS
  private async extractPdf(buffer: Buffer): Promise<string> {
    const data = await pdfParse(buffer);
    return data.text;
  }

  private async extractDocx(buffer: Buffer): Promise<string> {
    const [rawResult, htmlResult] = await Promise.all([
      mammoth.extractRawText({ buffer }),
      mammoth.convertToHtml({ buffer })
    ]);

    const htmlText = this.htmlToText(htmlResult.value || '');
    const rawText = rawResult.value || '';

    return [htmlText, rawText]
      .map((text) => text.trim())
      .filter(Boolean)
      .join('\n');
  }

  private extractExcel(buffer: Buffer): string {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    return workbook.SheetNames
      .map((name) =>
        XLSX.utils.sheet_to_csv(workbook.Sheets[name])
      )
      .join('\n');
  }

  // CLEAN + CHUNK
  cleanText(text: string): string {
    if (!text) return '';
    return text
      .replace(/\r\n/g, '\n')
      .replace(/\n{2,}/g, '\n')
      .replace(/\t+/g, ' | ')
      .replace(/ {2,}/g, ' ')
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

  private htmlToText(html: string): string {
    return html
      .replace(/<(\/)?(p|div|br|tr|li|h[1-6])[^>]*>/gi, '\n')
      .replace(/<(td|th)[^>]*>/gi, '\t')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
  }
}

