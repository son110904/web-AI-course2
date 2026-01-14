import pdfParse from 'pdf-parse';
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
