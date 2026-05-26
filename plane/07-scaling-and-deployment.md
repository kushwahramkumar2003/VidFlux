# Scaling And Deployment Plan

This document explains how to run the system locally, how to deploy it simply, and how to scale it later. Do not start with the final architecture. Build the smallest reliable version first.

## Scaling Philosophy

Scale the bottleneck, not everything.

In this system, the bottleneck is almost always transcoding. API, orchestrator, assembler, and web are lightweight compared to FFmpeg workers.

```text
More users uploading metadata? Scale API.
More videos waiting? Scale transcoders.
More viewers watching? Scale CDN/storage delivery.
More realtime connections? Scale notification service.
```

## Beginner Scaling Mental Model

Scaling does not mean "use Kubernetes." Scaling means adding capacity where the system is constrained.

Common bottlenecks in this project:

| Bottleneck | Symptom | Likely Fix |
|---|---|---|
| API CPU | API latency increases | Add API replicas or optimize routes |
| Transcoder CPU | Queue depth grows | Add workers or stronger CPU machines |
| Worker disk | Jobs fail during FFmpeg | Increase temp disk or cleanup better |
| Redis memory | Queue becomes unstable | Clean old jobs, tune retention, scale Redis |
| PostgreSQL connections | DB errors under traffic | Pool connections, managed DB, optimize queries |
| Storage bandwidth | Upload/download slow | Use regional storage, tune workers, CDN |
| CDN cache miss rate | Playback slow and origin overloaded | Fix cache headers and asset immutability |

Do not scale blindly. Measure first, then change one thing.

## Local Development Target

Local development should prove the full pipeline on your machine.

Local infrastructure:

- PostgreSQL for metadata.
- Redis for queues/events.
- MinIO as S3-compatible object storage.
- FFmpeg and FFprobe installed on the machine or worker container.

Local app processes:

- Web app.
- API service.
- Orchestrator.
- One transcoder worker.
- Assembler.
- Notification service, after basic pipeline works.

Local success path:

```text
Start infra
  |
Start API and web
  |
Upload one small video to MinIO
  |
Orchestrator creates jobs
  |
Transcoder creates one HLS output
  |
Assembler marks video ready
  |
Web app plays the video
```

Local development rule:

- Local should be boring and repeatable.
- If local setup is fragile, production will be worse.
- Every service should be startable independently.
- You should be able to delete local data and run the pipeline again.

Recommended local learning order:

```text
1. Confirm PostgreSQL works
2. Confirm Redis works
3. Confirm MinIO bucket works
4. Confirm API can create metadata
5. Confirm browser can upload to MinIO
6. Confirm orchestrator can read uploaded event
7. Confirm worker can produce one output
8. Confirm player can play output
```

## Environment Groups

Organize configuration by responsibility.

Database:

- Database URL.
- Migration environment.

Redis/queue:

- Redis URL.
- Queue names.
- Worker concurrency.

Storage:

- Endpoint.
- Bucket.
- Region.
- Access key.
- Secret key.
- Public/CDN base URL.

Auth/API:

- JWT/session secret.
- API port.
- Allowed origins.

Video worker:

- FFmpeg path.
- FFprobe path.
- Temp directory.
- Max concurrent jobs.
- Max input file size.

Do not hardcode environment-specific URLs into business logic.

Configuration principle:

The same code should run in local development and production. Only environment values should change.

Example:

```text
Local:
  storage endpoint = MinIO
  CDN base URL = local/public storage URL

Production:
  storage endpoint = R2 or S3
  CDN base URL = Cloudflare or CloudFront URL
```

If you hardcode local URLs into services, deployment becomes painful.

## Capacity Model

Start with rough thinking. You do not need perfect math.

Important variables:

- Average upload size.
- Average video duration.
- Average number of renditions.
- Encoding speed per worker.
- Number of concurrent uploads.
- Storage growth per day.
- Expected viewers per video.

Example mental model:

```text
If one 10-minute video creates 4 renditions,
and one worker takes 20 minutes to process all work,
then 10 videos can create hours of queue backlog unless workers scale.
```

Queue depth tells you when transcoding capacity is behind demand.

More detailed example:

```text
Assume:
  average video duration = 5 minutes
  each video creates 3 renditions
  one worker can process one rendition in about 5 minutes

One uploaded video creates:
  3 worker jobs

Ten uploaded videos create:
  30 worker jobs

If you have 2 workers:
  only 2 jobs run at a time
  28 jobs wait
```

This is why queue depth and oldest job age matter. Queue depth tells you how much work is waiting. Oldest job age tells you how long users are waiting.

## Service Scaling Guide

| Service | First Version | When To Scale | How To Scale |
|---|---:|---|---|
| Web | 1 instance | More frontend traffic | More replicas/CDN |
| API | 1 instance | High API latency or CPU | More stateless replicas |
| Orchestrator | 1 instance | Upload events lag | More consumers with safe idempotency |
| Transcoder | 1 worker | Queue depth grows | More workers/machines |
| Assembler | 1 instance | Completion events lag | More consumers with DB locking/idempotency |
| Notification | 1 instance | Many open connections | More replicas, sticky sessions or shared pub/sub |
| PostgreSQL | Single local/managed | CPU, connections, storage | Managed DB, indexes, read replicas later |
| Redis | Single local/managed | Memory/CPU/latency | Managed Redis, queue cleanup, partition later |
| Storage/CDN | MinIO/R2/S3 | Viewer traffic or storage growth | CDN cache tuning, lifecycle policies |

## Scaling Order

Recommended order as the product grows:

1. Keep one API and one worker until the pipeline works.
2. Add more transcoder workers on the same machine if CPU allows.
3. Move transcoders to a separate CPU-heavy machine.
4. Use managed PostgreSQL and Redis.
5. Put playback behind CDN.
6. Add API replicas if user traffic grows.
7. Add notification replicas if realtime connections grow.
8. Consider container orchestration only after manual deployment becomes painful.

This order avoids premature complexity.

## Worker Concurrency

Transcoder concurrency must match machine capacity.

Bad approach:

```text
8 CPU machine -> run 20 FFmpeg jobs -> all jobs become slow and unstable
```

Better approach:

```text
8 CPU machine -> run 1-3 concurrent FFmpeg jobs depending on profile and CPU usage
```

Start conservative. Measure CPU, memory, temp disk, and encode time before increasing concurrency.

Worker sizing questions:

- How many CPU cores does the machine have?
- How much memory does one FFmpeg job use?
- How much temp disk does one job need?
- Does one high-resolution job starve smaller jobs?
- Does increasing concurrency improve throughput or just make every job slower?

A common beginner mistake is increasing concurrency because the queue is long. If the machine is already CPU-saturated, higher concurrency can reduce total throughput.

## Deployment Phases

### Phase 1: Single Machine

Use this when learning and proving the system.

```text
One VPS
  |
  +-- API
  +-- Web
  +-- Orchestrator
  +-- Transcoder
  +-- Assembler
  +-- Notification
  +-- PostgreSQL
  +-- Redis
  +-- MinIO or external R2/S3
```

Benefits:

- Simple to understand.
- Cheap.
- Easy logs.
- Good for first demo.

Limitations:

- Transcoding competes with database/API CPU.
- Disk and CPU are limited.
- One machine failure affects everything.

When this phase is acceptable:

- You are learning.
- You are building a demo.
- You have low upload volume.
- You can tolerate manual recovery.

When to move on:

- API becomes slow during transcoding.
- Worker CPU usage is constantly high.
- You need safer backups.
- One restart disrupts everything.

### Phase 2: Separate Heavy Compute

Use this when transcodes slow down the rest of the app.

```text
App server
  +-- API
  +-- Web
  +-- Orchestrator
  +-- Assembler
  +-- Notification

Worker server
  +-- Transcoder workers

Managed services
  +-- PostgreSQL
  +-- Redis
  +-- R2/S3
  +-- CDN
```

Benefits:

- FFmpeg no longer starves API.
- Worker machines can be CPU optimized.
- Easier to add more workers.

This is the most important practical scaling step. Most video platforms become easier to operate once FFmpeg work is isolated from user-facing services.

### Phase 3: Container Orchestration

Use this only after the app is real enough to justify operational complexity.

```text
Container platform
  +-- API replicas
  +-- Web replicas
  +-- Orchestrator consumers
  +-- Transcoder worker pool
  +-- Assembler consumers
  +-- Notification replicas
  +-- Managed PostgreSQL
  +-- Managed Redis
  +-- Object storage
  +-- CDN
```

Autoscaling signal:

- Transcoder replicas should scale primarily from queue depth and job age.

Do not jump here too early:

- Kubernetes does not fix unclear service boundaries.
- Kubernetes does not fix non-idempotent jobs.
- Kubernetes does not fix missing observability.
- Kubernetes adds operational complexity.

Use orchestration after the application design is already sound.

## CDN Strategy

Video playback should go through a CDN.

Why:

- Segments are requested frequently.
- Viewers may be far from storage region.
- CDN caches immutable files near users.
- API servers should not handle video bandwidth.

Recommended cache behavior:

| Asset | Cache Strategy |
|---|---|
| HLS segments | Long cache; immutable after creation |
| Variant playlists | Long cache for VOD if immutable |
| Master playlist | Medium/long cache after ready |
| Thumbnails | Long cache |
| Private signed URLs | Expire based on product/security needs |

For version 1, public or simple signed playback is enough. Do not build complex DRM.

CDN beginner explanation:

Without CDN:

```text
Every viewer asks your storage origin for every segment.
Origin bandwidth and latency become a bottleneck.
```

With CDN:

```text
First viewer asks CDN for segment_001.ts
CDN fetches it from origin and caches it
Next viewers near that edge get the cached segment quickly
```

Video is a perfect CDN use case because finished HLS segments are immutable.

## Storage Lifecycle

Plan storage cleanup early.

When a user deletes a video:

```text
API marks video DELETING
  |
Cancel pending jobs where possible
  |
Cleanup worker removes raw, output, thumbnails
  |
Database marks DELETED or removes rows
```

Object storage lifecycle policies can later remove:

- Old raw uploads after successful transcode.
- Failed temporary outputs.
- Abandoned upload prefixes.

Decision to make:

- Keep raw originals for future re-transcoding, or delete them after successful processing to save storage.

Recommended first version:

- Keep raw originals while learning.
- Add a documented cleanup policy before production.

Storage cost thinking:

One uploaded video can produce multiple outputs. If the raw file is 500 MB, final storage might be much larger depending on renditions and thumbnails.

Storage grows quietly. If you do not plan cleanup, costs increase even when traffic is low.

Useful lifecycle decisions:

- How long do you keep raw originals?
- Do failed uploads expire after a day?
- Do failed transcode outputs get deleted?
- Do deleted videos get hard-deleted immediately or after a grace period?

## Implementation Roadmap

Build one thin vertical slice first, then deepen it.

Important roadmap rule:

At every stage, produce something observable.

Do not spend a week building hidden abstractions with no end-to-end proof. A junior developer learns faster when each stage has a visible result.

### Stage 1: Foundation

Goal:

- The project can store users/videos and talk to local infrastructure.

Tasks:

- Set up PostgreSQL, Redis, and MinIO locally.
- Define database schema.
- Create shared DB, storage, queue, and logger packages.
- Add health checks.

Done when:

- API can create a video metadata row.
- Services can connect to DB/Redis/storage.

What you should understand before moving on:

- What PostgreSQL stores.
- What Redis is used for.
- What MinIO represents.
- How environment variables are shared.

### Stage 2: Upload Pipeline

Goal:

- A browser can upload a file directly to object storage.

Tasks:

- API creates upload sessions/presigned URLs.
- Web uploads file directly.
- API confirms upload completion.
- Upload completion publishes durable work.

Done when:

- A raw video exists in MinIO and a video row is `UPLOADED`.

What you should understand before moving on:

- Why upload does not go through API.
- What a presigned URL does.
- Why upload complete is a separate step.

### Stage 3: Job Planning

Goal:

- An uploaded video becomes predictable jobs.

Tasks:

- Orchestrator consumes upload events.
- FFprobe metadata is stored.
- Rendition profiles are selected.
- Job rows and queue jobs are created idempotently.

Done when:

- One upload creates the expected job list.

What you should understand before moving on:

- How source resolution maps to output profiles.
- Why duplicate events must not create duplicate jobs.
- Why the orchestrator does not encode video.

### Stage 4: First Transcode

Goal:

- One worker creates one playable HLS rendition.

Tasks:

- Worker consumes one job.
- Worker runs FFmpeg.
- Worker uploads variant playlist and segments.
- Job becomes complete.

Done when:

- You can play the produced variant playlist directly.

What you should understand before moving on:

- What FFmpeg produced.
- Where the playlist and segments live.
- How the worker updates durable state.

### Stage 5: Full Rendition Ladder

Goal:

- One upload creates multiple qualities.

Tasks:

- Add 360p/480p/720p/1080p rules.
- Track progress per job.
- Create renditions.

Done when:

- MinIO contains multiple quality folders for one video.

What you should understand before moving on:

- Why some source videos produce fewer profiles.
- Why each profile is a separate job.
- How progress is calculated across jobs.

### Stage 6: Assembly And Playback

Goal:

- The app plays from a master playlist.

Tasks:

- Assembler detects all jobs complete.
- Master playlist is generated.
- Video status becomes READY.
- Web player loads final playback URL.

Done when:

- Upload -> process -> play works from the dashboard.

What you should understand before moving on:

- Difference between variant playlist and master playlist.
- Why the video is not ready until all required outputs exist.
- Why playback URL should point to CDN/storage, not API.

### Stage 7: Reliability

Goal:

- The pipeline survives common failures.

Tasks:

- Add retry/backoff.
- Add permanent error classification.
- Add failed job visibility.
- Add idempotency checks.
- Add graceful shutdown.

Done when:

- Restarting services during processing does not corrupt final state.

What you should understand before moving on:

- Difference between retryable and permanent failures.
- Why idempotency protects retries.
- How to inspect failed jobs.

### Stage 8: Realtime And Operations

Goal:

- Users and operators can see what is happening.

Tasks:

- Add SSE/WebSocket progress.
- Add queue dashboard/admin visibility.
- Add structured logs and metrics.
- Add stuck job detection.

Done when:

- You can diagnose a failed video using videoId/jobId.

What you should understand before moving on:

- Realtime notifications are not source-of-truth.
- Logs must include correlation identifiers.
- Queue dashboard and database state should agree.

### Stage 9: Production Deployment

Goal:

- The system can run outside your laptop.

Tasks:

- Move storage to R2/S3.
- Put video delivery behind CDN.
- Use managed PostgreSQL/Redis or reliable backups.
- Deploy app and worker processes.
- Add alerts.

Done when:

- A fresh production upload can be processed and played through CDN.

## Pre-Production Checklist

- Direct uploads work for large files.
- API never receives video bytes.
- Workers can be restarted safely.
- Duplicate events do not duplicate jobs.
- Failed jobs are visible.
- Object storage keys are deterministic.
- CDN serves finished HLS assets.
- Database backups exist.
- Secrets are not committed.
- Logs include correlation IDs.
- There is a manual retry path.
- There is a deletion/cleanup path.

## What To Measure First

Before optimizing, measure:

- Average upload size.
- Average transcode time by profile.
- Queue wait time.
- Worker CPU usage.
- Worker memory usage.
- Temp disk usage.
- Storage size per completed video.
- Playback CDN cache hit rate.

Without measurements, scaling decisions are guesses.
