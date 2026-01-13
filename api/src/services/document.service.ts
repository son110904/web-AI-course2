const pdfParse: any = require('pdf-parse');
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import { EmbeddingService } from './embedding.service';

export interface ChunkGroup {
  parentIndex: number;
  parentContent: string;
  children: string[];
}

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

  private splitSemanticUnits(text: string): Array<{ text: string; hardBreak: boolean }> {
    const paragraphs = text.split(/\n{2,}/);
    const units: Array<{ text: string; hardBreak: boolean }> = [];

    paragraphs.forEach((paragraph, paragraphIndex) => {
      const trimmed = paragraph.trim();
      if (!trimmed) return;

      const sentences = trimmed.split(/(?<=[.!?])\s+/);
      if (sentences.length === 0) {
        units.push({ text: trimmed, hardBreak: paragraphIndex > 0 });
        return;
      }

      sentences.forEach((sentence, sentenceIndex) => {
        const hardBreak = paragraphIndex > 0 && sentenceIndex === 0;
        units.push({ text: sentence.trim(), hardBreak });
      });
    });

    return units;
  }

  private recursiveSplit(
    text: string,
    maxChunkSize: number,
    separators: string[] = ['\n\n', '\n', ' ', '']
  ): string[] {
    if (text.length <= maxChunkSize) {
      return [text.trim()].filter(Boolean);
    }

    const [separator, ...rest] = separators;
    if (separator === undefined) {
      return [text.trim()].filter(Boolean);
    }

    if (separator === '') {
      const chunks: string[] = [];
      let start = 0;
      while (start < text.length) {
        const end = Math.min(start + maxChunkSize, text.length);
        chunks.push(text.slice(start, end));
        start = end;
      }
      return chunks.map((chunk) => chunk.trim()).filter(Boolean);
    }

    const parts = text.split(separator);
    const chunks: string[] = [];
    let current = '';

    for (const part of parts) {
      const candidate = current ? `${current}${separator}${part}` : part;
      if (candidate.length > maxChunkSize) {
        if (current) {
          chunks.push(current);
        }
        current = part;
      } else {
        current = candidate;
      }
    }

    if (current) {
      chunks.push(current);
    }

    return chunks
      .flatMap((chunk) => this.recursiveSplit(chunk, maxChunkSize, rest))
      .map((chunk) => chunk.trim())
      .filter(Boolean);
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}
