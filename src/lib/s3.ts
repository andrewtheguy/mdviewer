import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";

const endpoint = process.env.S3_ENDPOINT!;
const bucket = process.env.S3_BUCKET!;

const client = new S3Client({
  endpoint: endpoint.startsWith("http") ? endpoint : "https://" + endpoint,
  region: process.env.S3_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
  },
  forcePathStyle: true,
});

export const s3 = {
  async list(options?: { prefix?: string }) {
    const allContents: { key: string | undefined; size: number | undefined; lastModified: string | undefined }[] = [];
    let continuationToken: string | undefined;

    do {
      const command = new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: options?.prefix,
        ContinuationToken: continuationToken,
      });
      const response = await client.send(command);

      if (response.Contents) {
        for (const obj of response.Contents) {
          allContents.push({
            key: obj.Key,
            size: obj.Size,
            lastModified: obj.LastModified?.toISOString(),
          });
        }
      }

      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);

    return { contents: allContents };
  },

  file(key: string) {
    return {
      async exists(): Promise<boolean> {
        try {
          await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
          return true;
        } catch {
          return false;
        }
      },

      async text(): Promise<string> {
        const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return response.Body!.transformToString();
      },

      async arrayBuffer(): Promise<ArrayBuffer> {
        const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const bytes = await response.Body!.transformToByteArray();
        return bytes.buffer as ArrayBuffer;
      },

      get type(): string | undefined {
        return undefined; // Will be fetched from response if needed
      },
    };
  },

  async write(key: string, data: ArrayBuffer | Uint8Array) {
    const body = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
  },
};
