import { Client } from 'minio';

export class MinIOModel {
  private client: Client;
  private bucket: string;

  constructor() {
    this.client = new Client({
      endPoint: process.env.MINIO_ENDPOINT!,
      port: Number(process.env.MINIO_PORT),
      useSSL: false,
      accessKey: process.env.MINIO_ACCESS_KEY!,
      secretKey: process.env.MINIO_SECRET_KEY!,
    });

    this.bucket = process.env.MINIO_BUCKET_NAME!;
  }

  async listFiles(prefix: string): Promise<string[]> {
    const objects: string[] = [];

    return new Promise((resolve, reject) => {
      const stream = this.client.listObjectsV2(this.bucket, prefix, true);

      stream.on('data', (obj) => {
        if (obj.name) objects.push(obj.name);
      });

      stream.on('end', () => resolve(objects));
      stream.on('error', reject);
    });
  }

  async getFile(objectName: string): Promise<Buffer> {
    const stream = await this.client.getObject(this.bucket, objectName);

    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];

      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  }
}
