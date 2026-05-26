import { asyncHandler, createLogger } from "@repo/common";
import { xReadGroup, getRedisConnection, xAdd } from "@repo/redis";
import { transcode } from "@repo/ffmpeg";
import { uploadFile } from "@repo/s3";
import { readFile, rm } from "node:fs/promises";
import { hostname } from "node:os";

const logger = createLogger("transcoder");
const redis = getRedisConnection();

const STREAM_KEY = "orchestrator_events";
const GROUP_NAME = "transcode-group";
const CONSUMER_NAME = `${hostname()}-${process.pid}`;

const s3Key = (rawVideoId: string, quality: string) =>
  `transcoded/${rawVideoId}/${quality}.mp4`;

const ensureConsumerGroup = asyncHandler(async () => {
  try {
    await redis.xGroupCreate(STREAM_KEY, GROUP_NAME, "$", { MKSTREAM: true });
    logger.info(
      `Consumer group "${GROUP_NAME}" created on stream "${STREAM_KEY}"`
    );
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("BUSYGROUP")) {
      logger.info(
        `Consumer group "${GROUP_NAME}" already exists — skipping create`
      );
    } else {
      throw err;
    }
  }
});

const processVideo = async (
  rawVideoId: string,
  sourceUrl: string,
  quality: string
): Promise<{
  success: boolean;
  rawVideoId: string;
  quality: string;
  s3Url?: string;
  durationMs?: number;
  error?: string;
}> => {
  logger.info(
    `[${CONSUMER_NAME}] Starting transcode → rawVideoId=${rawVideoId}  quality=${quality}  src=${sourceUrl}`
  );

  const result = await transcode({
    rawVideoId,
    url: sourceUrl,
    quality: quality as "144p" | "240p" | "360p" | "480p" | "720p" | "1080p",
  });

  if (!result.success || !result.outputPath) {
    logger.error(
      `[${CONSUMER_NAME}] ✗ Transcode failed → ${quality}  error=${result.error ?? "unknown"}`
    );
    return { success: false, rawVideoId, quality, error: result.error };
  }

  logger.info(
    `[${CONSUMER_NAME}] ✓ Transcoded → ${quality}  localFile=${result.outputPath}  took=${result.durationMs}ms`
  );

  let s3Url: string;
  const key = s3Key(rawVideoId, quality);

  try {
    const fileBuffer = await readFile(result.outputPath);
    s3Url = await uploadFile(key, fileBuffer, "video/mp4");
    logger.info(`[${CONSUMER_NAME}] ☁  Uploaded → s3Key=${key}  url=${s3Url}`);
  } catch (uploadErr) {
    const error =
      uploadErr instanceof Error ? uploadErr.message : String(uploadErr);
    logger.error(
      `[${CONSUMER_NAME}] ✗ S3 upload failed → ${key}  error=${error}`
    );
    return { success: false, rawVideoId, quality, error };
  }

  try {
    // Delete ONLY this worker's file — never the parent directory.
    // Other parallel workers processing different qualities of the same
    // rawVideoId share the same {rawVideoId}/ folder; deleting it
    // recursively would remove their files before they can upload.
    await rm(result.outputPath, { force: true });
    logger.info(
      `[${CONSUMER_NAME}] 🗑  Deleted local file → ${result.outputPath}`
    );
  } catch (rmErr) {
    logger.warn(
      `[${CONSUMER_NAME}] Could not delete local file: ${String(rmErr)}`
    );
  }

  return {
    success: true,
    rawVideoId,
    quality,
    s3Url,
    durationMs: result.durationMs,
  };
};

const startWorker = asyncHandler(async () => {
  await ensureConsumerGroup();

  logger.info(
    `Worker "${CONSUMER_NAME}" listening on stream "${STREAM_KEY}" (group="${GROUP_NAME}")`
  );

  while (true) {
    const messages = await xReadGroup(STREAM_KEY, GROUP_NAME, CONSUMER_NAME, 1);

    if (!messages || messages.length === 0) {
      continue;
    }

    const message = messages[0];
    if (!message) continue;

    const { rawVideoId, url, quality } = message.message;

    if (!rawVideoId || !url || !quality) {
      logger.warn(
        `Skipping malformed message ${message.id}: missing rawVideoId / url / quality`
      );
      await redis.xAck(STREAM_KEY, GROUP_NAME, message.id);
      continue;
    }

    const result = await processVideo(rawVideoId, url, quality);

    if (result.success) {
      const eventId = await redis.xAdd("transcoded_videos", "*", {
        rawVideoId,
        quality,
        url: result.s3Url!,
      });
      logger.info(
        `✅ Job complete → rawVideoId=${rawVideoId}  quality=${quality}  s3Url=${result.s3Url}`
      );
    }

    await redis.xAck(STREAM_KEY, GROUP_NAME, message.id);
    logger.info(`ACKed message ${message.id}`);
  }
});

void startWorker();
