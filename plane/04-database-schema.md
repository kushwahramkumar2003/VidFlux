# Database And Storage Design

This document describes the data model. It intentionally avoids implementation code. Use it to understand what each table represents and why the relationships exist.

## Database Design Principles

- PostgreSQL stores metadata and state, not video bytes.
- Object storage stores raw files, encoded segments, playlists, and thumbnails.
- Every long-running operation must have a durable database record.
- State transitions should be explicit.
- Unique constraints should prevent duplicate processing.
- Indexes should match the queries services actually run.

## Beginner Mental Model

The database is not just for storing data. In this project, the database is the system's memory.

Redis queues can lose short-lived progress. Workers can crash. Browsers can refresh. Local temp files can disappear. But PostgreSQL should still tell you:

- Which videos exist.
- Who owns each video.
- Whether the raw file was uploaded.
- Which jobs should exist.
- Which jobs completed.
- Which outputs are official.
- Why something failed.

Think of PostgreSQL as the notebook that every service can use to understand the truth.

Object storage is different. Object storage stores bytes. PostgreSQL stores meaning.

Example:

```text
Object storage says:
  videos/video-123/720p/segment_004.ts exists

PostgreSQL says:
  video-123 belongs to user-9
  720p rendition is official
  video status is READY
```

Both are needed.

## Entity Relationship Diagram

```text
+----------------+        +----------------+        +--------------------+
| User           |  1..N  | Video          |  1..N  | TranscodingJob     |
+----------------+------->+----------------+------->+--------------------+
| id             |        | id             |        | id                 |
| email          |        | userId         |        | videoId            |
| passwordHash   |        | title          |        | renditionProfile   |
| name           |        | status         |        | status             |
| createdAt      |        | originalKey    |        | progress           |
| updatedAt      |        | duration       |        | attempts           |
+----------------+        | sourceWidth    |        | errorCode          |
                          | sourceHeight   |        | errorMessage       |
                          | masterKey      |        | startedAt          |
                          | thumbnailKey   |        | completedAt        |
                          | createdAt      |        | createdAt          |
                          | updatedAt      |        | updatedAt          |
                          +-------+--------+        +---------+----------+
                                  |                           |
                                  | 1..N                      | 0..1
                                  v                           v
                          +----------------+        +--------------------+
                          | Rendition      |        | JobAttempt         |
                          +----------------+        +--------------------+
                          | id             |        | id                 |
                          | videoId        |        | jobId              |
                          | jobId          |        | attemptNumber      |
                          | resolution     |        | status             |
                          | playlistKey    |        | errorMessage       |
                          | segmentPrefix  |        | startedAt          |
                          | codec          |        | finishedAt         |
                          | bitrate        |        +--------------------+
                          | segmentCount   |
                          | createdAt      |
                          +----------------+
```

`JobAttempt` can be optional in version 1. It becomes useful when you want detailed debugging of retries.

## Lifecycle Example: One Video Through The Tables

This example shows how records appear over time.

Step 1: User starts upload.

```text
User row:
  already exists

Video row:
  status = INITIATED or UPLOADING
  originalKey = planned raw storage key
  duration = empty
  masterPlaylistKey = empty

Jobs:
  none yet

Renditions:
  none yet
```

Step 2: Upload completes.

```text
Video row:
  status = UPLOADED
  originalSizeBytes = known
  originalKey = raw object key
```

Step 3: Orchestrator probes source.

```text
Video row:
  status = PROBING, then PROCESSING
  durationSeconds = known
  sourceWidth = known
  sourceHeight = known
  sourceCodec = known

TranscodingJob rows:
  one row for 1080p if needed
  one row for 720p if needed
  one row for 480p if needed
  one row for 360p if needed
```

Step 4: Workers complete jobs.

```text
TranscodingJob:
  status = COMPLETED
  progress = 100
  completedAt = timestamp

Rendition:
  playlistKey = videos/video-123/720p/playlist.m3u8
  segmentPrefix = videos/video-123/720p/
  bitrate = known
```

Step 5: Assembler finishes.

```text
Video:
  status = READY
  masterPlaylistKey = videos/video-123/master.m3u8
  thumbnailKey = optional poster image
```

This is the core lifecycle. If you can trace a video through these states, you can debug most of the system.

## Main Tables

### User

Purpose:

- Represents an account that owns videos.

Important fields:

| Field | Why It Exists |
|---|---|
| `id` | Stable internal identifier |
| `email` | Login identity and unique account key |
| `passwordHash` | Store a hash, never a plain password |
| `name` | Optional display name |
| `createdAt`, `updatedAt` | Auditing and debugging |

Important constraints:

- Unique email.

Senior notes:

- Do not use email as the primary key. Users can change email addresses.
- Do not store plain passwords. Store password hashes.
- In a future team/workspace model, videos may belong to a workspace instead of directly to one user.

### Video

Purpose:

- Master record for one uploaded video. This is the entity the user understands.

Important fields:

| Field | Why It Exists |
|---|---|
| `id` | Stable video identifier |
| `userId` | Ownership and authorization |
| `title`, `description` | User-facing metadata |
| `status` | Overall lifecycle state |
| `originalFileName` | Display/debugging |
| `originalKey` | Object storage key for raw upload |
| `originalSizeBytes` | Validation, billing, display |
| `durationSeconds` | Progress calculation and UI |
| `sourceWidth`, `sourceHeight` | Rendition planning |
| `sourceCodec`, `sourceContainer` | Debugging and compatibility |
| `masterPlaylistKey` | Final HLS entry point |
| `thumbnailKey`, `spriteKey`, `spriteVttKey` | Playback UI assets |
| `failureReason` | User/admin debugging |

Recommended indexes:

- `userId, createdAt` for listing a user's videos.
- `status` for operational queries.
- `userId, status` if dashboards filter by processing state.

Senior notes:

- `Video` is the user's main object. Keep it stable and easy to query.
- Do not overload `Video` with every technical detail from every output. That belongs in `Rendition`.
- Store enough original metadata to explain why certain renditions were or were not created.
- A `READY` video should always have a master playlist key.

### TranscodingJob

Purpose:

- Tracks one unit of encoding work, usually one rendition such as 720p.

Important fields:

| Field | Why It Exists |
|---|---|
| `id` | Stable job identifier |
| `videoId` | Parent video |
| `profileName` | Human-readable profile such as 720p |
| `targetWidth`, `targetHeight` | Output size |
| `videoBitrate`, `audioBitrate` | Encoding profile |
| `codec` | Output codec |
| `status` | Worker state |
| `progress` | UI progress |
| `attempts` | Retry count |
| `errorCode`, `errorMessage` | Failure diagnosis |
| `startedAt`, `completedAt` | Runtime measurement |

Important constraints:

- Unique `videoId + profileName`. This prevents duplicate 720p jobs for the same video.

Recommended indexes:

- `status` for worker/admin queries.
- `videoId` for assembling and detail pages.
- `status, createdAt` for picking old pending jobs or dashboards.

Senior notes:

- Jobs are operational records. They explain work that has to happen.
- A job should be retryable without creating a new logical output every time.
- Do not store only queue state. Queue state is not enough for long-term debugging.
- Unique `videoId + profileName` is one of the most important protections in the system.

### Rendition

Purpose:

- Represents a successfully produced playable variant.

Important fields:

| Field | Why It Exists |
|---|---|
| `id` | Stable rendition identifier |
| `videoId` | Parent video |
| `jobId` | The job that produced this rendition |
| `profileName` | 720p, 480p, etc. |
| `width`, `height` | Player metadata |
| `codec` | Compatibility/debugging |
| `bitrate` | HLS master playlist bandwidth |
| `playlistKey` | Variant playlist location |
| `segmentPrefix` | Segment directory/prefix |
| `segmentCount` | Debugging and validation |
| `totalSizeBytes` | Storage/billing visibility |

Important constraints:

- Unique `jobId`.
- Unique `videoId + profileName`.

Senior notes:

- A rendition is user-facing playback output.
- A completed job without a rendition means something went wrong after encoding.
- A rendition without a valid playlist key is not useful.
- The master playlist is built from renditions.

### JobAttempt Optional Table

Purpose:

- Stores each individual try of a job. Useful when debugging retries.

Add this when:

- You need to know whether the same job failed for different reasons.
- You want admin screens for operational support.
- You want metrics about retry causes.

Skip this in the first version if it slows you down.

When this becomes useful:

- A job failed first because of an S3 timeout, then later because FFmpeg could not decode the file.
- You want to know whether failures are mostly infrastructure or user-upload issues.
- You want to show admins a timeline of attempts.
- You need better production debugging.

## State Enums

Video statuses:

| Status | Meaning |
|---|---|
| `INITIATED` | DB row exists but upload may not be complete |
| `UPLOADING` | Browser has an upload URL and may be sending bytes |
| `UPLOADED` | Raw object exists and is ready for processing |
| `PROBING` | Orchestrator is reading metadata |
| `PROCESSING` | One or more transcoding jobs are running |
| `ASSEMBLING` | Renditions are complete and final assets are being created |
| `READY` | User can watch the video |
| `FAILED` | Processing failed |
| `DELETING` | Cleanup is in progress |
| `DELETED` | Logical deletion complete |

State transition rules:

- `INITIATED` should not jump directly to `PROCESSING`.
- `READY` should not go back to `PROCESSING` unless you explicitly support reprocessing.
- `FAILED` should require a stored reason.
- `DELETING` should prevent new playback URLs from being issued.
- Deleted videos should not be accidentally assembled into `READY`.

Job statuses:

| Status | Meaning |
|---|---|
| `PENDING` | Waiting in queue |
| `PROCESSING` | Claimed by a worker |
| `RETRYING` | Failed transiently and waiting to retry |
| `COMPLETED` | Rendition exists |
| `FAILED` | No more retries or permanent error |
| `CANCELLED` | Parent video was deleted or cancelled |

Job transition rules:

- `PENDING` can become `PROCESSING` or `CANCELLED`.
- `PROCESSING` can become `COMPLETED`, `RETRYING`, `FAILED`, or `CANCELLED`.
- `RETRYING` can become `PROCESSING` or `FAILED`.
- `COMPLETED` should be terminal for that job unless you add explicit reprocessing.

## Storage Key Layout

Use predictable keys. This makes debugging and cleanup much easier.

```text
bucket/
  raw/
    user-{userId}/
      video-{videoId}/
        original.{ext}

  videos/
    video-{videoId}/
      master.m3u8
      1080p/
        playlist.m3u8
        segment_000.ts
        segment_001.ts
      720p/
        playlist.m3u8
        segment_000.ts
      480p/
      360p/

  thumbnails/
    video-{videoId}/
      poster.jpg
      sprite.jpg
      sprite.vtt
```

Rules:

- Raw uploads and encoded outputs should be separate prefixes.
- Everything for a video should be easy to delete by `videoId`.
- Do not use the original filename as the primary storage key. User filenames can contain unsafe characters and duplicates.
- Store the original filename only as metadata.

Why deterministic keys matter:

Deterministic keys make retries safe.

If the 720p job always writes to:

```text
videos/video-123/720p/
```

then retrying the same job writes to the same logical place. If every retry writes to a random folder, cleanup and playlist generation become much harder.

Object storage is eventually a cost center. A messy key design becomes expensive later.

## Source Of Truth

PostgreSQL is the source of truth for:

- Who owns a video.
- What status a video is in.
- Which jobs should exist.
- Which renditions are complete.
- Which object keys are official.

Redis/BullMQ is the source of truth for:

- Work waiting to be processed.
- Active retry/backoff state.
- Short-lived progress signals.

Object storage is the source of truth for:

- Actual raw and encoded media bytes.

The system should be able to recover if Redis loses temporary progress, as long as PostgreSQL and object storage are intact.

## Transaction Boundaries

A transaction means a group of database changes succeeds or fails together.

Use transactions when:

- Creating a video row and related upload metadata together.
- Creating all planned jobs for a video.
- Marking a job completed and creating/updating its rendition.
- Marking a video ready after validating all renditions.

Be careful:

- Do not keep database transactions open while running FFmpeg.
- Do not keep database transactions open while uploading large files.
- Long transactions can lock rows and hurt performance.

Good pattern:

```text
Do slow external work outside transaction
  |
  v
Open short DB transaction
  |
  v
Write final durable state
  |
  v
Close transaction
```

## Common Queries To Design For

User dashboard:

- Get recent videos by user.
- Filter user's videos by status.
- Get one video with jobs and renditions.

Worker/orchestrator:

- Find video by id.
- Create jobs only if they do not already exist.
- Update job status and progress.
- Find all jobs for a video.

Assembler:

- Count expected jobs for a video.
- Count completed jobs for a video.
- Load renditions for master playlist generation.

Operations:

- Find failed videos.
- Find failed jobs by error type.
- Find jobs stuck in processing too long.

## Data Integrity Rules

- A video cannot be READY unless it has a master playlist key.
- A completed job should have exactly one rendition.
- A failed job should have an error code or message.
- A rendition should not exist without a completed job.
- A user should not be deleted without handling their videos and storage cleanup.
- Deleting database rows does not automatically delete object storage files; plan cleanup explicitly.

## Idempotency Rules

These rules protect the system from duplicate events and retries:

- Upload completion can be called more than once for the same video.
- Orchestrator can receive the same upload event more than once.
- Job creation uses uniqueness by `videoId + profileName`.
- Rendition creation uses uniqueness by `videoId + profileName` and `jobId`.
- Storage output keys are deterministic, so retrying a job writes to the same location.
- Assembler can run more than once and produce the same master playlist key.

## What To Revisit Later

Revisit the schema when adding:

- Team/workspace accounts.
- Public/private sharing permissions.
- Subtitles and captions.
- Multiple codecs per resolution.
- Per-video analytics.
- Billing by storage and processing minutes.
- Webhooks for external integrations.
