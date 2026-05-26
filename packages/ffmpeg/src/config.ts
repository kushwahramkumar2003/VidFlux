/**
 * @repo/ffmpeg — configuration
 * All values can be overridden via environment variables.
 */
export const ffmpegConfig = {
  /**
   * Directory where transcoded output files are written.
   * e.g. /tmp/transcoded/{rawVideoId}/{quality}.mp4
   */
  OUTPUT_DIR:
    process.env["FFMPEG_OUTPUT_DIR"] ??
    `${process.cwd()}/tmp/transcoded`,

  /**
   * Codec used for video encoding.
   * libx264 is broadly compatible; swap to libx265 for better compression.
   */
  VIDEO_CODEC: process.env["FFMPEG_VIDEO_CODEC"] ?? "libx264",

  /**
   * Codec used for audio encoding.
   */
  AUDIO_CODEC: process.env["FFMPEG_AUDIO_CODEC"] ?? "aac",

  /**
   * Constant Rate Factor for libx264/libx265 (lower = better quality, larger file).
   * 23 is the ffmpeg default; 18-28 is a sensible range.
   */
  CRF: process.env["FFMPEG_CRF"] ?? "23",

  /**
   * Encoding preset (ultrafast → veryslow).
   * Faster presets produce larger files; slower presets use more CPU.
   */
  PRESET: process.env["FFMPEG_PRESET"] ?? "fast",
} as const;
