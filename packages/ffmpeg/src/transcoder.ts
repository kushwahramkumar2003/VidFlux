import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ffmpegConfig } from "./config.ts";
import type {
  TranscodeOptions,
  TranscodeResult,
  VideoQuality,
  ResolutionDimensions,
} from "./types.ts";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const RESOLUTION_MAP: Record<VideoQuality, ResolutionDimensions> = {
  "144p": { width: 256, height: 144 },
  "240p": { width: 426, height: 240 },
  "360p": { width: 640, height: 360 },
  "480p": { width: 854, height: 480 },
  "720p": { width: 1280, height: 720 },
  "1080p": { width: 1920, height: 1080 },
};

export const transcode = async (
  options: TranscodeOptions
): Promise<TranscodeResult> => {
  const {
    rawVideoId,
    url,
    quality,
    outputDir = ffmpegConfig.OUTPUT_DIR,
  } = options;
  const startTime = Date.now();

  const dims = RESOLUTION_MAP[quality];

  const videoOutputDir = join(outputDir, rawVideoId);
  await mkdir(videoOutputDir, { recursive: true });

  const outputPath = join(videoOutputDir, `${quality}.mp4`);

  try {
    await runFfmpeg({ url, quality, dims, outputPath });

    return {
      success: true,
      rawVideoId,
      quality,
      outputPath,
      durationMs: Date.now() - startTime,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      rawVideoId,
      quality,
      outputPath,
      durationMs: Date.now() - startTime,
      error,
    };
  }
};

interface FfmpegRunOptions {
  url: string;
  quality: VideoQuality;
  dims: ResolutionDimensions;
  outputPath: string;
}

const runFfmpeg = (opts: FfmpegRunOptions): Promise<void> => {
  const { url, dims, outputPath } = opts;

  /**
   * Correct vf filter for fixed-size output with letterboxing:
   *
   *   scale=W:H:force_original_aspect_ratio=decrease
   *     → shrinks the video to fit within W×H, preserving aspect ratio
   *
   *   pad=W:H:(ow-iw)/2:(oh-ih)/2:black
   *     → adds black bars to reach exactly W×H
   *
   *   setsar=1
   *     → resets sample aspect ratio (prevents distortion during playback)
   *
   * IMPORTANT: force_original_aspect_ratio is a COLON-separated option
   * of the scale filter, NOT a separate filter.  Joining with commas was
   * the bug that caused "Error reinitializing filters!".
   */
  const vf = [
    `scale=${dims.width}:${dims.height}:force_original_aspect_ratio=decrease`,
    `pad=${dims.width}:${dims.height}:(ow-iw)/2:(oh-ih)/2:black`,
    "setsar=1",
  ].join(",");

  return new Promise((resolve, reject) => {
    ffmpeg(url)
      .videoCodec(ffmpegConfig.VIDEO_CODEC)
      .outputOptions([
        `-vf ${vf}`,
        `-crf ${ffmpegConfig.CRF}`,
        `-preset ${ffmpegConfig.PRESET}`,
        "-pix_fmt yuv420p",
        "-movflags +faststart",
      ])
      .audioCodec(ffmpegConfig.AUDIO_CODEC)
      .audioBitrate("128k")
      .output(outputPath)
      .on("end", () => resolve())
      .on("error", (err: Error) => reject(err))
      .run();
  });
};
