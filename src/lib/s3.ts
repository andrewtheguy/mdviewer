import { S3Client } from "bun";

export const s3 = new S3Client({
  accessKeyId: process.env.S3_ACCESS_KEY_ID!,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
  bucket: process.env.S3_BUCKET!,
  endpoint: process.env.S3_ENDPOINT!,
  region: process.env.S3_REGION,
});
