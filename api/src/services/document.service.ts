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
    return text
      .replace(/\r\n/g, '\n')
      .replace(/\n{2,}/g, '\n')
      .replace(/[\t ]+/g, ' ')
      .trim();
  }

  // 🐛 FIX: Thêm tham số chunkSize và overlap
  chunkText(text: string, chunkSize: number = 500, overlap: number = 100): string[] {
    if (!text) return [];

    const chunks: string[] = [];
    let start = 0;

    while (start < text.length) {
      const end = Math.min(start + chunkSize, text.length);
      const chunk = text.slice(start, end).trim();
      
      if (chunk) {
        chunks.push(chunk);
      }
      
      start += chunkSize - overlap;
    }

    return chunks.filter(Boolean);
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
      const isHeading = headingPatterns.some(pattern => 
        pattern.test(line.trim())
      );

      if (isHeading && currentSection.length > 100) {
        sections.push(currentSection.trim());
        currentSection = line + '\n';
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
  chunkTextAdvanced(text: string, chunkSize: number = 500, overlap: number = 100): string[] {
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
}