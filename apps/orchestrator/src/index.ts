import { asyncHandler, createLogger } from "@repo/common";
import { prisma, type RawVideo } from "@repo/db";
import { ensureConsumerGroup } from "../../../packages/redis/src/streams";
import {
  bulkXAdd,
  xAck,
  xReadGroupPending,
  type RawVideoPending,
  type VideoTranscodeJob,
} from "@repo/redis";

const logger = createLogger("orchestrator");
const POLL_INTERVAL_MS = 1000 * 60 * 3; // 3 minutes
const STREAM_PREFIX = "orchestrator_events";
const GROUP_NAME = "orchestrator_group";
const TAKE_SIZE = 10;
const videoResolutionArr = [
  "144p",
  "240p",
  "360p",
  "480p",
  "720p",
  "1080p",
] as const;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const bindWithResolution = (videos: RawVideoPending[]): VideoTranscodeJob[] => {
  const jobs: VideoTranscodeJob[] = [];
  videos.forEach((video) => {
    videoResolutionArr.forEach((resolution) => {
      jobs.push({
        rawVideoId: video.message.RawVideoId,
        url: video.message.url,
        quality: resolution,
      });
    });
  });
  return jobs;
};

const startPoller = asyncHandler(async () => {
  logger.info("Started");
  while (true) {
    let startTime = Date.now();
    logger.info("Polling videos...");
    let cursor: string | undefined = undefined;
    await ensureConsumerGroup({
      streamKey: "push_video",
      groupKey: "orchestrator_group",
    });

    while (true) {
      // const videos: { id: string; url: string }[] =
      //   await prisma.rawVideo.findMany({
      //     take: TAKE_SIZE,
      //     select: { id: true, url: true },
      //     ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      //   });
      const videos: RawVideoPending[] = await xReadGroupPending(
        "push_video",
        "orchestrator_group",
        "orchestrator_consumer",
        TAKE_SIZE
      );
      if (videos.length === 0) break;
      const jobs = bindWithResolution(videos);
      await bulkXAdd(STREAM_PREFIX, jobs);
      for (const video of videos) {
        await xAck("push_video", "orchestrator_group", video.id);
      }
      logger.info(`Finished queuing ${videos.length} video`);
    }

    let endTime = Date.now();
    await sleep(POLL_INTERVAL_MS - (endTime - startTime));
  }
});

void startPoller();
