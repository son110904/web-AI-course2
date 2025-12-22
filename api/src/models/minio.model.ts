// src/models/minio.model.ts
import { Client } from 'minio';

export class MinIOModel {
  private client: Client;
  private bucket: string;

  constructor() {
    this.client = new Client({
      endPoint: process.env.MINIO_ENDPOINT!,
      port: Number(process.env.MINIO_PORT),
      useSSL: process.env.MINIO_USE_SSL === 'true',
      accessKey: process.env.MINIO_ACCESS_KEY!,
      secretKey: process.env.MINIO_SECRET_KEY!,
    });

    this.bucket = process.env.MINIO_BUCKET_NAME!;
  }

  async getFileBuffer(objectName: string): Promise<Buffer> {
    const stream = await this.client.getObject(this.bucket, objectName);

    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async initialize(): Promise<void> {
    try {
      const exists = await this.client.bucketExists(this.bucket);
      if (!exists) {
        await this.client.makeBucket(this.bucket);
      }
    } catch (err) {
      // rethrow so caller can handle initialization errors
      throw err;
    }
  }

  async uploadFile(filePath: string, objectName: string, contentType?: string): Promise<string> {
    const metaData = contentType ? { 'Content-Type': contentType } : {};
    // fPutObject(bucketName, objectName, filePath, metaData)
    await this.client.fPutObject(this.bucket, objectName, filePath, metaData as any);
    // return stored object identifier (controller will save this)
    return objectName;
  }
}
