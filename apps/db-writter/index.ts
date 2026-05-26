import { asyncHandler, createLogger } from "@repo/common";
import { prisma } from "@repo/db";
import {
  ensureConsumerGroup,
  getRedisConnection,
  xAck,
  type TranscodedVideoPending,
} from "@repo/redis";

const redis = getRedisConnection();
const logger = createLogger("db-writer");

const STREAM_KEY = "transcoded_videos";
const GROUP_NAME = "db_writter_group";
const CONSUMER_NAME = "db-writter_consumer";
const TAKE_SIZE = 10;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const bulkDbUpdate = async (videos: TranscodedVideoPending[]) => {
  const operations = videos.flatMap((video) => [
    prisma.transcodedVideo.create({
      data: {
        rawVideoId: video.message.rawVideoId,
        url: video.message.url,
      },
    }),
    prisma.rawVideo.update({
      where: {
        id: video.message.rawVideoId,
      },
      data: {
        status: "PROCESSED",
      },
    }),
  ]);
  await prisma.$transaction(operations);
};

const startPoller = asyncHandler(async () => {
  logger.info("Started db-writer service");

  await ensureConsumerGroup({
    streamKey: STREAM_KEY,
    groupKey: GROUP_NAME,
  });

  while (true) {
    try {
      const data = await redis.xReadGroup(
        GROUP_NAME,
        CONSUMER_NAME,
        {
          key: STREAM_KEY,
          id: ">",
        },
        { COUNT: TAKE_SIZE, BLOCK: 5000 }
      );

      if (!data || data.length === 0) {
        continue;
      }

      const messages = data[0]?.messages;
      if (!messages || messages.length === 0) {
        continue;
      }

      const videos: TranscodedVideoPending[] = messages.map((m) => ({
        id: m.id,
        message: {
          rawVideoId: m.message.rawVideoId as string,
          url: m.message.url as string,
          quality: m.message.quality as string,
        },
      }));

      await bulkDbUpdate(videos);

      for (const video of videos) {
        await xAck(STREAM_KEY, GROUP_NAME, video.id);
      }

      logger.info(`Successfully processed and saved ${videos.length} transcoded video records`);
    } catch (err) {
      logger.error(`Error in db-writer poller loop: ${err instanceof Error ? err.message : String(err)}`);
      await sleep(5000);
    }
  }
});

void startPoller();
