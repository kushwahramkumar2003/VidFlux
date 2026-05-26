# Video Concepts For This Project

This document explains the video knowledge you need before implementing the transcoder. Video can feel complex because several concepts overlap: containers, codecs, resolution, bitrate, segments, playlists, and players. Learn the mental model first.

## What A Video File Contains

A video file is a container. It usually contains at least one video stream and one audio stream.

```text
+------------------------------------------------+
| Container: MP4, MOV, MKV, WebM                 |
|                                                |
|  +------------------------------------------+  |
|  | Video stream                             |  |
|  | frames, resolution, framerate, codec     |  |
|  +------------------------------------------+  |
|                                                |
|  +------------------------------------------+  |
|  | Audio stream                             |  |
|  | samples, channels, bitrate, codec        |  |
|  +------------------------------------------+  |
|                                                |
|  +------------------------------------------+  |
|  | Metadata                                 |  |
|  | duration, timestamps, chapters, tags     |  |
|  +------------------------------------------+  |
+------------------------------------------------+
```

## Container vs Codec

This is the first common confusion.

| Concept | Meaning | Analogy |
|---|---|---|
| Container | The file format that holds streams together | A box |
| Codec | The compression method for a stream | How items inside the box are packed |

Examples:

- MP4 is a container.
- H.264 is a video codec.
- AAC is an audio codec.
- An MP4 file often contains H.264 video and AAC audio.

The file extension alone does not guarantee what codecs are inside.

## Resolution, Bitrate, Framerate

These three terms appear constantly in video systems.

Resolution:

- The width and height of the video.
- Example: 1920 x 1080 means 1080p.
- Higher resolution usually looks sharper but needs more bandwidth.

Bitrate:

- How much data is used per second of video.
- Higher bitrate usually means better quality and larger files.
- Too low bitrate creates blocky/pixelated video.

Framerate:

- How many frames are shown per second.
- Common values are 24, 25, 30, and 60 fps.
- Higher framerate can look smoother but costs more bandwidth and processing.

Simple mental model:

```text
Resolution = how many pixels
Bitrate    = how much data per second
Framerate  = how many images per second
```

For your first version, do not over-optimize these. Use a simple fixed ladder and improve later after the system works.

## Why We Transcode

Transcoding means converting media from one representation to another.

We transcode for three reasons:

- Compatibility: produce formats browsers and phones can play.
- Adaptation: create multiple qualities for different networks.
- Streaming: split large files into small pieces for fast start and smooth playback.

Important beginner point:

Transcoding is not the same as uploading. Uploading only stores the original file. Transcoding creates new files that are better suited for playback.

Example:

```text
User uploads:
  my-video.mov

System produces:
  master.m3u8
  720p playlist and segments
  480p playlist and segments
  360p playlist and segments
```

The user uploaded one file, but the platform may create hundreds of small output files.

## Adaptive Bitrate Streaming

Adaptive Bitrate Streaming means the player can switch quality while watching.

```text
One source upload
      |
      +--> 1080p high bitrate
      +--> 720p medium bitrate
      +--> 480p lower bitrate
      +--> 360p low bitrate
```

When the viewer has strong bandwidth, the player chooses a higher quality. When bandwidth drops, the player switches to a lower quality instead of buffering forever.

Example viewer behavior:

```text
Viewer starts on mobile network
  |
  player chooses 360p
  |
Viewer moves to WiFi
  |
  player detects better bandwidth
  |
  player switches to 720p or 1080p
  |
WiFi becomes unstable
  |
  player switches down to 480p
```

The backend does not decide this live for every viewer. The backend prepares the available qualities. The player chooses between them while watching.

## HLS Mental Model

HLS stands for HTTP Live Streaming. Despite the name, it is commonly used for normal uploaded videos too.

HLS output has two important file types:

| File | Purpose |
|---|---|
| Master playlist | Lists available quality levels |
| Variant playlist | Lists media segments for one quality level |
| Segment files | Small chunks of audio/video, often 2-6 seconds each |

Visual structure:

```text
master.m3u8
  |
  +-- 1080p/playlist.m3u8
  |     +-- segment_000.ts
  |     +-- segment_001.ts
  |     +-- segment_002.ts
  |
  +-- 720p/playlist.m3u8
  |     +-- segment_000.ts
  |     +-- segment_001.ts
  |
  +-- 480p/playlist.m3u8
  |
  +-- 360p/playlist.m3u8
```

The browser player starts from the master playlist, chooses a variant, and then downloads segments one by one.

How to read HLS output:

- `master.m3u8` is the entry point.
- `720p/playlist.m3u8` describes the 720p version.
- `segment_000.ts` is an actual media chunk.
- The player does not download all segments immediately.
- The player downloads only what it needs as playback progresses.

This is why CDN caching works well. Many viewers request the same segment files, and the CDN can reuse cached copies.

## Why Segments Matter

Without segments:

- The browser may need a lot of data before smooth playback.
- Seeking can be slow.
- CDN caching is less efficient.
- Quality switching is hard.

With segments:

- Playback can start quickly.
- The CDN caches small immutable files.
- The player can switch quality at segment boundaries.
- Failed segment requests are easier to retry.

Segment duration trade-off:

| Segment Length | Benefit | Cost |
|---|---|---|
| 2 seconds | Faster quality switching | More files and requests |
| 4 seconds | Good balance for VOD | Common practical default |
| 10 seconds | Fewer files | Slower switching and startup behavior |

Recommended first version:

- Use around 4-second segments.
- Keep the same segment duration across renditions.

## Keyframes

Video compression does not store every frame as a full image. Most frames store changes from nearby frames.

```text
I-frame      P-frame      P-frame      P-frame      I-frame
full image   changes      changes      changes      full image
```

An I-frame is a keyframe. Players can cleanly seek or switch quality at keyframes.

For adaptive streaming, renditions should have aligned keyframes. If the 720p stream has keyframes at different times than the 1080p stream, switching quality can produce glitches.

Simple rule:

- Segment boundaries should line up with keyframes.
- Every rendition should use the same segment duration.

Why this matters:

Imagine the player wants to switch from 360p to 720p at second 20. If 720p has a clean keyframe at second 20, the switch is smooth. If the nearest keyframe is at second 21.3, the player may stutter, show artifacts, or delay the switch.

You do not need to become a video compression expert immediately. Just remember: aligned keyframes make adaptive switching clean.

## Encoding Ladder

An encoding ladder defines which outputs to create.

Recommended starting ladder:

| Profile | Width x Height | Video Bitrate Range | Use Case |
|---|---:|---:|---|
| 1080p | 1920 x 1080 | around 5 Mbps | WiFi, large screens |
| 720p | 1280 x 720 | around 2.5-3 Mbps | Most laptops/mobile |
| 480p | 854 x 480 | around 1-1.5 Mbps | Slower mobile |
| 360p | 640 x 360 | under 1 Mbps | Weak connections |

Do not upscale by default.

Example:

- If source is 720p, create 720p, 480p, and 360p.
- Do not create fake 1080p from a 720p source.

Why not upscale:

Upscaling makes the file larger without adding real detail. A 720p source converted to 1080p is still limited by the original 720p information. It may even look worse because compression has to spend bits on fake enlarged pixels.

Better rule:

```text
Only create outputs at or below source resolution.
```

## Codec Strategy

Start with:

- Video: H.264.
- Audio: AAC.
- Packaging: HLS.

Why:

- H.264 + AAC is broadly compatible.
- It is easier to debug.
- Encoding is faster than newer codecs.
- It is the safest first production target.

Later options:

| Codec | Benefit | Trade-Off |
|---|---|---|
| H.265/HEVC | Smaller files at similar quality | Licensing/support complexity |
| VP9 | Good web compression | Slower encoding, not universal everywhere |
| AV1 | Excellent compression | Very slow encoding unless optimized/hardware-assisted |

Do not add multiple codecs until the H.264 pipeline is stable.

Codec decision as a product trade-off:

- H.264 is not the most efficient codec.
- H.264 is the safest codec.
- For a first platform, safety and compatibility matter more than storage optimization.

Later, when the pipeline is stable, you can add an advanced path:

```text
Baseline output:
  H.264 for every user/device

Advanced output:
  AV1 or VP9 for modern browsers
```

But adding this too early doubles testing complexity.

## FFprobe Role

FFprobe is used before transcoding.

It answers:

- Is this actually a video?
- What is the duration?
- What is the width and height?
- What codecs are inside?
- Does it have audio?
- Is the file corrupt or unsupported?

The orchestrator should use this information to decide the processing plan.

Probe output should influence:

- Whether the file is accepted.
- Which renditions are created.
- Whether audio handling is needed.
- How progress is calculated.
- What metadata is shown to users/admins.

If probing fails, do not blindly continue to transcoding. A failed probe often means the file is corrupt or unsupported.

## FFmpeg Role

FFmpeg does the heavy media work.

In this system, the transcoder worker uses FFmpeg to:

- Read the source file.
- Resize video.
- Encode video and audio.
- Split output into HLS segments.
- Produce a variant playlist.

The assembler may also use FFmpeg for:

- Poster thumbnail.
- Sprite sheet for timeline preview.

How to think about FFmpeg in the system:

- FFmpeg is an external tool, not your business logic.
- Your worker prepares input, chooses settings, runs FFmpeg, observes output, and records state.
- If FFmpeg fails, your worker must translate that failure into a useful system state.

Do not treat "FFmpeg exited non-zero" as enough information. Store the relevant error category and enough logs to debug.

## Progress Calculation

For a simple first version:

```text
job progress = encoded timestamp / total video duration
video progress = average progress of all expected jobs
```

Example:

```text
1080p job: 20%
720p job: 60%
480p job: 100%
360p job: 100%

overall video progress = around 70%
```

This is good enough for a dashboard. It does not need to be perfect.

Why progress is approximate:

- Some renditions are slower than others.
- 1080p may take much longer than 360p.
- FFmpeg progress output may not be perfectly smooth.
- Uploading segments after encoding also takes time.

For users, approximate progress is usually acceptable. What matters more is that the status does not get stuck forever without explanation.

## Common Mistakes

- Storing video bytes in PostgreSQL.
- Uploading large files through the API server.
- Creating 1080p output from a 480p source.
- Forgetting audio streams.
- Letting segment durations differ across renditions.
- Treating FFmpeg errors as all retryable.
- Assuming every MP4 is valid H.264/AAC.
- Serving video segments from the Express API.

## Beginner Build Path

Learn video in this order:

1. Upload one small MP4 to local object storage.
2. Probe it and print metadata.
3. Produce one 360p HLS rendition.
4. Play that rendition in a local HLS player.
5. Add 720p/480p/360p ladder.
6. Add master playlist.
7. Add thumbnails.
8. Add progress tracking.

Do not start with all profiles, thumbnails, retries, and realtime progress at once.
