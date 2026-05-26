import { prisma } from "@repo/db";
import { newRawVideoSchema } from "../schemas/video.schema";
import { asyncHandler } from "../services/asyncHandler";
import { AppError } from "../services/appError";
import { appResponse } from "../services/appResponse";
import { xAdd } from "@repo/redis";

export const transcodeVideo = asyncHandler(async (req, res) => {
  const parsed = newRawVideoSchema.safeParse(req.body);
  if (!parsed.success) {
    throw parsed.error;
  }

  const rawVideo = await prisma.rawVideo.create({
    data: {
      url: parsed.data.url,
      userId: req.userId,
      status: "PENDING",
    },
  });

  try {
    await xAdd("push_video", rawVideo);
    console.log("Video pushed", rawVideo);
  } catch (err) {
    await prisma.rawVideo.delete({ where: { id: rawVideo.id } });
    throw new AppError("Failed to queue video for transcoding", 500);
  }

  return appResponse({ res, message: "Raw video created successfully" });
});
