// api/src/models/chunk.model.ts


export interface Chunk {
    chunkId: number;   // ID duy nhất của chunk
    docId: string;     // ID của document gốc (vd: handbook_cntt_2024)
    order: number;     // vị trí chunk trong document
    content: string;   // nội dung text của chunk

    /*
    // (khuyên thêm – dùng sau này)
    metadata?: {
      faculty?: string;
      topic?: string;
      academicYear?: string;
      source?: string;
    };*/
}
