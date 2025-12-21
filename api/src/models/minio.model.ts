import { Client } from 'minio';
import * as fs from 'fs';

export class MinIOModel {
  private client: Client;
  private bucketName: string;

  constructor(
    endpoint: string,
    port: number,
    accessKey: string,
    secretKey: string,
    bucketName: string,
    useSSL: boolean = false
  ) {
    console.log('Connecting to MinIO:', { endpoint, port, bucketName });
    
    this.client = new Client({
      endPoint: endpoint,
      port: port,
      useSSL: useSSL,
      accessKey: accessKey,
      secretKey: secretKey,
    });
    this.bucketName = bucketName;
  }

  async initialize(): Promise<void> {
    try {
      console.log('Testing MinIO connection...');
      
      const exists = await this.client.bucketExists(this.bucketName);
      if (!exists) {
        console.log(`Creating bucket '${this.bucketName}'...`);
        await this.client.makeBucket(this.bucketName, 'us-east-1');
        console.log(`✓ Bucket '${this.bucketName}' created`);
      } else {
        console.log(`✓ Bucket '${this.bucketName}' exists`);
      }

      const policy = {
        Version: '2012-10-17',
        Statement: [{
          Effect: 'Allow',
          Principal: { AWS: ['*'] },
          Action: ['s3:GetObject'],
          Resource: [`arn:aws:s3:::${this.bucketName}/*`],
        }],
      };
      
      await this.client.setBucketPolicy(this.bucketName, JSON.stringify(policy));
      console.log('✓ Bucket policy set');
      
    } catch (error: any) {
      console.error('✗ MinIO error:', error.message);
      throw error;
    }
  }

  async uploadFile(filePath: string, objectName: string, contentType: string): Promise<string> {
    try {
      const fileStream = fs.createReadStream(filePath);
      const fileStats = fs.statSync(filePath);

      await this.client.putObject(
        this.bucketName,
        objectName,
        fileStream,
        fileStats.size,
        { 'Content-Type': contentType }
      );

      return `${this.bucketName}/${objectName}`;
    } catch (error) {
      console.error('✗ Upload error:', error);
      throw error;
    }
  }

  async downloadFile(objectName: string, destinationPath: string): Promise<void> {
    await this.client.fGetObject(this.bucketName, objectName, destinationPath);
  }

  async getFileUrl(objectName: string, expirySeconds: number = 3600): Promise<string> {
    return await this.client.presignedGetObject(this.bucketName, objectName, expirySeconds);
  }

  async deleteFile(objectName: string): Promise<void> {
    await this.client.removeObject(this.bucketName, objectName);
  }

  async listFiles(prefix: string = ''): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const files: string[] = [];
      const stream = this.client.listObjects(this.bucketName, prefix, true);
      stream.on('data', (obj) => files.push(obj.name));
      stream.on('error', reject);
      stream.on('end', () => resolve(files));
    });
  }
}