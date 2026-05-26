import { prisma, type RawVideo } from "@repo/db";
import { getRedisConnection } from "./redis";
import type {
  RawVideoPending,
  VideoTranscodeJob,
  xReadGroupResponseMessages,
} from "./types";

const redis = getRedisConnection();

export const xAdd = async (stream: string, data: RawVideo) => {
  const eventId = await redis.xAdd(stream, "*", {
    RawVideoId: data.id,
    url: data.url,
  });
  console.log(`Added to stream "${stream}" with ID ${eventId}`);
  return eventId;
};

export const bulkXAdd = async (stream: string, data: VideoTranscodeJob[]) => {
  const multi = redis.multi();
  data.forEach((job) => {
    multi.xAdd(
      stream,
      "*",
      {
        rawVideoId: job.rawVideoId,
        url: job.url,
        quality: job.quality,
      },
      {
        TRIM: {
          strategy: "MAXLEN",
          strategyModifier: "~",
          threshold: 2_000_000,
        },
      }
    );
  });
  await multi.exec();
};

export const xReadGroup = async (
  stream: string,
  group: string,
  consumer: string,
  count: number = 1
): Promise<xReadGroupResponseMessages[]> => {
  const messages = await redis.xReadGroup(
    group,
    consumer,
    {
      key: stream,
      id: ">",
    },
    { COUNT: count, BLOCK: 5000 }
  );

  return messages?.[0]?.messages as xReadGroupResponseMessages[];
};

export const xReadGroupPending = async (
  stream: string,
  group: string,
  consumer: string,
  count: number = 1
): Promise<RawVideoPending[]> => {
  const messages = await redis.xReadGroup(
    group,
    consumer,
    {
      key: stream,
      id: ">",
    },
    { COUNT: count, BLOCK: 5000 }
  );
  console.log(
    `Read ${messages?.[0]?.messages.length ?? 0} pending messages from stream "${stream}" for consumer "${consumer}" in group "${group}" (total pending: ${messages?.[0]?.messages.length ?? 0})`
  );
  return (messages?.[0]?.messages ?? []) as RawVideoPending[];
};

export const xAck = async (
  stream: string,
  group: string,
  messageId: string
) => {
  await redis.xAck(stream, group, messageId);
};

export const ensureConsumerGroup = async ({
  streamKey,
  groupKey,
}: {
  streamKey: string;
  groupKey: string;
}) => {
  try {
    await redis.xGroupCreate(streamKey, groupKey, "$", { MKSTREAM: true });
    console.log(
      `Consumer group "${groupKey}" created on stream "${streamKey}"`
    );
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("BUSYGROUP")) {
      console.info(
        `Consumer group "${groupKey}" already exists — skipping create`
      );
    } else {
      throw err;
    }
  }
};
