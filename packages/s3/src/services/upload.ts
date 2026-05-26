import { PutObjectCommand } from "@aws-sdk/client-s3";
import { s3Client, env } from "../client";

export const uploadFile = async (
  key: string,
  body: Buffer | Uint8Array | string,
  contentType: string
): Promise<string> => {
  await s3Client.send(
    new PutObjectCommand({
      Bucket: env.AWS_BUCKET_NAME,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );

  return `https://${env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
};
