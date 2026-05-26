# Services Deep Dive

This document explains each service as if you are about to build it. For every service, understand the responsibility, input, output, dependencies, and failure behavior before writing code.

## Service Boundary Rule

A service should have one reason to change.

If a change is about user-facing HTTP behavior, it belongs near the API.

If a change is about deciding the processing plan, it belongs near the orchestrator.

If a change is about FFmpeg execution, it belongs near the transcoder.

If a change is about final playable assets, it belongs near the assembler.

## How To Read A Service Boundary

For each service, identify five things:

- What event or request starts its work?
- What data does it read?
- What data does it write?
- What does it publish or return?
- What must still be true if it crashes halfway?

This is how senior engineers reason about backend services. They do not start by asking "which file should I create?" They start by asking "what responsibility does this process own?"

## `apps/web` - Dashboard

Primary job:

- Give users a clean interface to upload, monitor, manage, and watch videos.

Responsibilities:

- Login and registration screens.
- Upload screen with direct-to-storage upload.
- Video list with status badges.
- Progress display while processing.
- HLS playback for ready videos.
- Delete and retry actions when supported by the API.

Inputs:

- API responses.
- Upload progress from browser-to-storage transfer.
- Processing progress from SSE or WebSocket.

Outputs:

- HTTP requests to the API.
- Direct file upload to object storage using a presigned URL.

Must not do:

- Store secret keys.
- Talk directly to PostgreSQL or Redis.
- Decide transcoding profiles.

Junior developer checkpoint:

- If you can upload a file directly to MinIO from the browser and then see a video row in the dashboard, this service is doing its first job.

Beginner explanation:

- The web app is not trusted with secrets.
- The web app can hold a temporary upload URL, because that URL is limited.
- The web app should not know how FFmpeg works.
- The web app should display backend state instead of inventing its own state.

Example user flow:

```text
User selects file
  |
  v
Web asks API for upload URL
  |
  v
Web uploads file to storage
  |
  v
Web tells API upload is complete
  |
  v
Web shows "processing"
  |
  v
Web listens for updates or polls status
  |
  v
Web shows player when status is READY
```

Common mistake:

- Showing "ready" in the UI just because upload finished. Upload completion only means the raw file exists. It does not mean the video is playable.

## `apps/api` - User-Facing Backend

Primary job:

- Own the public HTTP contract for users and the frontend.

Responsibilities:

- Authentication and authorization.
- Video metadata routes.
- Presigned upload URL generation.
- Upload completion endpoint.
- Playback URL generation.
- Delete/retry actions.
- Validate user ownership before returning video data.

Important endpoints conceptually:

| Capability | Purpose |
|---|---|
| Auth | Register/login and issue session/JWT |
| Start upload | Create video record and return presigned upload URL |
| Complete upload | Confirm object exists and enqueue processing |
| List videos | Return user's video library |
| Get video | Return metadata, renditions, and status |
| Playback URL | Return CDN URL or signed URL for ready video |
| Delete video | Start deletion of DB state and object storage prefixes |
| Retry video/job | Requeue failed processing safely |

Dependencies:

- PostgreSQL through the DB package.
- Object storage through the storage package.
- Queue/event package for publishing upload events.
- Logger/tracing utilities.

Must not do:

- Run FFmpeg.
- Download full video files.
- Block the request until transcoding finishes.
- Trust a videoId without checking ownership.

Failure behavior:

- If object storage is unavailable during upload URL generation, return a clear temporary failure.
- If queue publish fails after upload completion, do not pretend processing started. Either retry internally or mark the video as needing enqueue recovery.
- If the user retries upload completion, the endpoint must be idempotent.

Junior developer checkpoint:

- The API should still respond quickly even if no transcoder workers are running.

How to think about the API:

The API is a control plane. It controls metadata, permissions, and workflow triggers. It is not the data plane for large video bytes.

Control plane examples:

- "Can this user upload?"
- "Which videos belong to this user?"
- "Is this video ready?"
- "What URL should the browser use?"

Data plane examples:

- Raw video file bytes.
- HLS segment bytes.
- Thumbnail image bytes.

The API should handle control plane work. Object storage and CDN should handle data plane work.

Important API design questions:

- What should happen if the user asks for a playback URL before the video is ready?
- What should happen if the user deletes a video while jobs are running?
- What should happen if upload completion is called for a video owned by another user?
- What should happen if queue publishing fails after the DB status changed?

Senior guidance:

- Design API responses around clear states, not vague messages.
- Prefer explicit errors such as "video is still processing" over generic failure.
- Always check ownership using authenticated user context.

## `apps/orchestrator` - Workflow Planner

Primary job:

- Convert an uploaded video into a set of concrete jobs.

Responsibilities:

- Consume `video.uploaded` events.
- Probe video metadata with FFprobe.
- Validate that the file is a supported video.
- Decide the rendition ladder.
- Create job records.
- Enqueue worker jobs.
- Publish status updates.

Decision example:

| Source Height | Renditions |
|---|---|
| 2160p or higher | 1080p, 720p, 480p, 360p |
| 1080p | 1080p, 720p, 480p, 360p |
| 720p | 720p, 480p, 360p |
| 480p | 480p, 360p |
| Below 480p | Source-compatible low rendition only |

Dependencies:

- PostgreSQL.
- Queue package.
- Object storage package.
- FFprobe availability.
- Logger/tracing.

Must not do:

- Encode the video.
- Serve HTTP traffic.
- Create duplicate jobs for the same video and resolution.

Failure behavior:

- Invalid/corrupt video should become a permanent failure, not retry forever.
- Temporary object storage or Redis errors can retry.
- Duplicate upload events should not create duplicate job rows.

Junior developer checkpoint:

- Given one uploaded video, the orchestrator should create predictable job rows and queue messages. You should be able to inspect this in the database and queue dashboard.

How to think about the orchestrator:

The orchestrator is the planner. It answers: "What work should exist for this video?"

It should make deterministic decisions. The same source metadata should produce the same planned jobs. This is what makes duplicate events safe.

Planning example:

```text
Input:
  source height = 1080
  duration = 120 seconds
  codec = h264

Decision:
  create 1080p job
  create 720p job
  create 480p job
  create 360p job

Do not:
  create 4K job
  create duplicate 720p job
  start FFmpeg directly inside orchestrator
```

Important edge cases:

- Source has no audio.
- Source is lower than 360p.
- Source metadata cannot be read.
- Source file exists but is corrupt.
- Upload event arrives twice.

Senior guidance:

- Store probe results before creating jobs.
- Use database uniqueness to protect against duplicate planning.
- Make the orchestrator restart-safe.

## `apps/transcoder` - Encoding Worker

Primary job:

- Take one job and produce one encoded rendition.

Responsibilities:

- Claim a job from the queue.
- Mark the job as processing.
- Prepare local temp workspace.
- Read source video from object storage.
- Run FFmpeg for the requested profile.
- Upload the variant playlist and media segments.
- Create or update the rendition record.
- Publish completion/progress.
- Clean temp files.

Inputs:

- One queue job containing videoId, jobId, input key, output prefix, and encoding profile.

Outputs:

- HLS segments and variant playlist in object storage.
- Job status update in PostgreSQL.
- Rendition row.
- Progress/completion event.

Must not do:

- Decide which renditions exist.
- Mark the whole video as ready.
- Keep important state only on local disk.

Resource warnings:

- This is the CPU bottleneck.
- This service can fill disk with temp files if cleanup is wrong.
- Running too many jobs per machine can make every job slower or fail.

Failure behavior:

- If FFmpeg fails because the input is invalid, classify as permanent failure.
- If upload/download times out, retry with backoff.
- If the worker crashes mid-job, the queue must be able to retry the job.
- If output already exists, the job should safely overwrite or skip based on database state.

Junior developer checkpoint:

- Start with one small video and one low-resolution output. Once that works, add the full rendition ladder.

How to think about the transcoder:

The transcoder is a worker, not a decision maker. It should receive a clear job and execute it.

One job should be narrow:

```text
Take this source video
Produce this profile
Write output to this prefix
Report progress and final status
```

The transcoder should not ask:

- "Should this video have 1080p?"
- "Is the whole video ready?"
- "Should the user be notified?"

Those questions belong to other services.

Resource thinking:

- FFmpeg uses CPU heavily.
- FFmpeg may use memory heavily for large files.
- HLS output creates many small files.
- Temp directories must be cleaned.
- Worker concurrency must be controlled.

Practical first milestone:

- Do not start with four renditions.
- Start with one 360p or source-compatible output.
- Confirm the output can play.
- Then add the full ladder.

Senior guidance:

- Treat every job as retryable.
- Make output paths deterministic.
- Update progress often enough for visibility, but not so often that you overload Redis or the database.

## `apps/assembler` - Finalization Coordinator

Primary job:

- Turn completed renditions into a final playable video.

Responsibilities:

- Consume rendition completion events.
- Check whether all expected jobs for a video are complete.
- Generate or write the master HLS playlist.
- Generate thumbnails/poster/sprite metadata when included in scope.
- Mark the video as ready.
- Publish ready/failed status.

Inputs:

- Rendition completion events.
- Database state for video, jobs, and renditions.
- Object storage keys for variant playlists and segments.

Outputs:

- Master playlist key.
- Thumbnail/sprite keys.
- Video status update.
- Notification event.

Must not do:

- Encode normal video renditions.
- Assume one completion event means the entire video is ready.
- Trust only Redis counters as the source of truth.

Important design point:

- Redis counters can speed up coordination, but PostgreSQL should be the source of truth. If Redis loses a counter, the assembler should still be able to recalculate readiness from job rows.

Failure behavior:

- If one rendition fails permanently, decide whether the video fails entirely or can be ready with fewer qualities. For version 1, prefer failing the video clearly to keep behavior simple.
- If master playlist generation fails, retry. This is usually cheap and safe.

Junior developer checkpoint:

- When all job rows are complete, one master playlist should exist and the video status should become READY exactly once.

How to think about the assembler:

The assembler is not there because generating a playlist is hard. It exists because coordination is hard.

Imagine a video has four jobs:

```text
1080p job: completed
720p job: completed
480p job: still processing
360p job: completed
```

The video is not ready yet. If the assembler marks it ready too early, the player may load a master playlist that points to missing output. That creates a bad user experience and difficult bugs.

The assembler should ask:

- How many jobs were expected?
- How many completed successfully?
- Did any fail permanently?
- Do all completed jobs have rendition records?
- Are the playlist keys present?
- Has this video already been assembled?

Senior guidance:

- Use the database as final truth.
- Completion events should wake the assembler up, not replace database checks.
- Make assembly idempotent so running it twice is safe.

## `apps/notification` - Realtime Progress Gateway

Primary job:

- Push processing status to connected browsers.

Responsibilities:

- Accept SSE or WebSocket connections.
- Authenticate the connected user.
- Subscribe to progress/status events.
- Send only events the user is allowed to see.
- Handle reconnects.

SSE vs WebSocket:

| Option | Good For | Trade-Off |
|---|---|---|
| SSE | Server-to-browser progress updates | Simpler, one-way only |
| WebSocket | Two-way realtime features | More moving parts |

Recommendation:

- Start with SSE unless you need true two-way realtime communication.

Must not do:

- Own durable video state.
- Trust client-provided video ownership.
- Replace database status.

Failure behavior:

- If the notification service is down, processing should continue.
- Browser can reconnect and fetch latest status from API.
- Lost realtime messages are acceptable because DB state is authoritative.

Junior developer checkpoint:

- Realtime progress is a convenience layer. The app must still work if the user refreshes the page.

How to think about notifications:

Notifications are not the source of truth. They are a fast delivery mechanism for state changes.

If the browser misses an event, it should recover by calling the API and reading the current database-backed status.

Example:

```text
Worker publishes "720p is 60%"
  |
  v
Notification service sends update to browser
  |
  v
Browser progress bar moves

If the message is missed:
  |
  v
Browser refreshes or polls API
  |
  v
API returns latest stored job progress
```

SSE is recommended first because your use case is mostly server-to-client updates. WebSocket is useful when the client also needs to send frequent realtime messages back to the server.

## Shared Packages

Use shared packages to avoid duplicate infrastructure code, not to hide service ownership.

Recommended packages:

| Package | Purpose |
|---|---|
| `packages/db` | Prisma schema/client and database helpers |
| `packages/storage` | S3/R2/MinIO client helpers and key conventions |
| `packages/queue` | Queue names, producers, workers, event contracts |
| `packages/logger` or `packages/services` | Structured logging, config loading, Redis client |
| `packages/types` | Shared DTO/event types where useful |

Warning:

- Do not put all business logic into shared packages. If everything is shared, the services become fake boundaries.

## Service Interaction Cheat Sheet

```text
API publishes upload event.
Orchestrator consumes upload event and creates jobs.
Transcoder consumes jobs and creates renditions.
Assembler consumes completion events and marks video ready.
Notification consumes status events and updates browser.
Web calls API and displays current state.
```

## Build Order For Services

Build in this order to reduce confusion:

1. API + DB video records.
2. Storage direct upload.
3. Queue publish from API.
4. Orchestrator creates jobs.
5. Transcoder handles one job.
6. Assembler marks video ready.
7. Web playback.
8. Realtime notifications.

This order gives you visible progress at each step and avoids building frontend polish before the backend pipeline works.

## Service Handoff Checklist

Before implementing any service, fill this mentally:

| Question | Why It Matters |
|---|---|
| What starts this service's work? | Prevents unclear triggers |
| What table rows does it read? | Makes data dependencies explicit |
| What table rows does it write? | Prevents hidden ownership conflicts |
| What object storage keys does it read/write? | Prevents file layout confusion |
| What queue/event does it consume? | Defines async contract |
| What queue/event does it publish? | Defines downstream behavior |
| What happens if it crashes halfway? | Forces reliability thinking |
| What happens if it receives the same event twice? | Forces idempotency thinking |

If you cannot answer these questions, pause before coding.
