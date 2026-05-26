import { DeleteObjectCommand, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { s3Client, env } from "../client";

export const deleteFile = async (key: string): Promise<void> => {
  await s3Client.send(
    new DeleteObjectCommand({
      Bucket: env.AWS_BUCKET_NAME,
      Key: key,
    })
  );
};

export const deleteFiles = async (keys: string[]): Promise<void> => {
  await s3Client.send(
    new DeleteObjectsCommand({
      Bucket: env.AWS_BUCKET_NAME,
      Delete: {
        Objects: keys.map((Key) => ({ Key })),
      },
    })
  );
};
