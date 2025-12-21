import * as fs from 'fs';
import * as path from 'path';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';

export class DocumentService {
  async extractText(filePath: string, contentType: string): Promise<string> {
    const extension = path.extname(filePath).toLowerCase();

    switch (extension) {
      case '.pdf':
        return await this.extractFromPDF(filePath);
      case '.docx':
        return await this.extractFromDOCX(filePath);
      case '.txt':
        return await this.extractFromTXT(filePath);
      case '.xlsx':
      case '.xls':
        return await this.extractFromExcel(filePath);
      default:
        throw new Error(`Unsupported file type: ${extension}`);
    }
  }

  private async extractFromPDF(filePath: string): Promise<string> {
    const dataBuffer = fs.readFileSync(filePath);
    const data = await pdfParse(dataBuffer);
    return data.text;
  }

  private async extractFromDOCX(filePath: string): Promise<string> {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  }

  private async extractFromTXT(filePath: string): Promise<string> {
    return fs.readFileSync(filePath, 'utf-8');
  }

  private async extractFromExcel(filePath: string): Promise<string> {
    const workbook = XLSX.readFile(filePath);
    let text = '';
    workbook.SheetNames.forEach((sheetName) => {
      const sheet = workbook.Sheets[sheetName];
      const sheetData = XLSX.utils.sheet_to_csv(sheet);
      text += sheetData + '\n\n';
    });
    return text;
  }

  chunkText(text: string, chunkSize: number = 500, overlap: number = 50): string[] {
    const chunks: string[] = [];
    const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
    
    let currentChunk = '';
    let currentLength = 0;

    for (const sentence of sentences) {
      const sentenceLength = sentence.length;

      if (currentLength + sentenceLength > chunkSize && currentChunk.length > 0) {
        chunks.push(currentChunk.trim());
        
        const words = currentChunk.split(' ');
        const overlapWords = words.slice(-Math.floor(overlap / 5));
        currentChunk = overlapWords.join(' ') + ' ';
        currentLength = currentChunk.length;
      }

      currentChunk += sentence + '. ';
      currentLength += sentenceLength;
    }

    if (currentChunk.trim().length > 0) {
      chunks.push(currentChunk.trim());
    }

    return chunks;
  }

  cleanText(text: string): string {
    text = text.replace(/\s+/g, ' ');
    text = text.replace(/[^\w\sÀ-ỹ.,!?-]/g, '');
    return text.trim();
  }
}