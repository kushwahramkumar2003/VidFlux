export type VideoQuality = "144p" | "240p" | "360p" | "480p" | "720p" | "1080p";

export interface ResolutionDimensions {
  width: number;
  height: number;
}

/** Input options for a single transcode job. */
export interface TranscodeOptions {
  /** ID of the raw video record in the database. */
  rawVideoId: string;
  /** Publicly accessible URL (or S3 pre-signed URL) of the source file. */
  url: string;
  /** Target output quality. */
  quality: VideoQuality;
  /** Override the output directory (defaults to ffmpegConfig.OUTPUT_DIR). */
  outputDir?: string;
}

export interface TranscodeResult {
  success: boolean;
  rawVideoId: string;
  quality: VideoQuality;
  /** Absolute path to the transcoded output file. */
  outputPath: string;
  /** Wall-clock time taken in milliseconds. */
  durationMs: number;
  /** Present only when success === false. */
  error?: string;
}
