import fs from 'fs';
import path from 'path';
const pdfParse: any = require('pdf-parse');
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';

export class DocumentService {
  constructor() {}

  async extractText(filePath: string, contentType?: string): Promise<string> {
    const buffer = await fs.promises.readFile(filePath);
    const extension = path.extname(filePath).toLowerCase();

    // prefer extension, fallback to contentType checks
    switch (extension) {
      case '.pdf':
        return (await pdfParse(buffer)).text;

      case '.docx':
        return (await mammoth.extractRawText({ buffer })).value;

      case '.txt':
        return buffer.toString('utf-8');

      case '.xlsx':
      case '.xls': {
        const workbook = XLSX.read(buffer, { type: 'buffer' });
        return workbook.SheetNames
          .map((name) => XLSX.utils.sheet_to_csv(workbook.Sheets[name]))
          .join('\n');
      }

      default:
        // try content type
        if (contentType?.includes('pdf')) return (await pdfParse(buffer)).text;
        if (contentType?.includes('word')) return (await mammoth.extractRawText({ buffer })).value;
        if (contentType?.includes('text')) return buffer.toString('utf-8');

        throw new Error(`Unsupported file type: ${extension || contentType}`);
    }
  }

  cleanText(text: string): string {
    if (!text) return '';
    // normalize whitespace and remove excessive newlines
    return text
      .replace(/\r\n/g, '\n')
      .replace(/\n{2,}/g, '\n')
      .replace(/[\t ]+/g, ' ')
      .trim();
  }

  chunkText(text: string, chunkSize = 500, overlap = 50): string[] {
    if (!text) return [];
    const chunks: string[] = [];
    let start = 0;
    const len = text.length;

    while (start < len) {
      const end = Math.min(start + chunkSize, len);
      let chunk = text.slice(start, end).trim();

      // try to expand to nearest sentence end for better context
      if (end < len) {
        const remaining = text.slice(end, Math.min(end + 100, len));
        const dotIdx = remaining.indexOf('.');
        if (dotIdx !== -1) chunk += remaining.slice(0, dotIdx + 1);
      }

      chunks.push(chunk);
      start += chunkSize - overlap;
    }

    return chunks.filter((c) => c.length > 0);
  }
}
