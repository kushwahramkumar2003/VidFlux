export interface xReadGroupResponseMessages {
  id: string;
  message: VideoTranscodeJob;
}

/**
 * Shape of a message in the "push_video" stream.
 * Fields match exactly what xAdd() writes: { RawVideoId, url }.
 * Note the capital-R capital-V casing — it must match the Redis key.
 */
export interface RawVideoPending {
  id: string;
  message: {
    RawVideoId: string;
    url: string;
  };
}

export interface VideoTranscodeJob {
  rawVideoId: string;
  url: string;
  quality: "144p" | "240p" | "360p" | "480p" | "720p" | "1080p";
}

export interface TranscodedVideoPending {
  id: string;
  message: {
    rawVideoId: string;
    url: string;
    quality: string;
  };
}

