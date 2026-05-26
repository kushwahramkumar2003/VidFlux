# Video Transcoding Platform - Project Handoff Overview

This plan is for building a video transcoding platform in a monorepo. The goal is not only to build a working app, but to learn how production backend systems are designed: async processing, queues, object storage, worker services, retries, observability, and scaling.

Read this as a senior engineer handoff. You are not expected to understand every detail on day one. Your job is to build the system in small, verifiable steps and keep the service boundaries clean.

## What We Are Building

Users upload one raw video file. The system converts it into streaming-friendly outputs so viewers can watch smoothly on different devices and network speeds.

The final user experience:

- A user signs in.
- The user uploads a video from the browser.
- The browser uploads the file directly to object storage.
- Backend workers transcode the video into multiple qualities.
- The dashboard shows processing progress.
- When processing is complete, the user can play the video through an HLS player.
- The video is served through a CDN, not directly from the API server.

## Why This Is Not A Simple File Upload App

Video is large, slow, and expensive to process. A normal request/response API is the wrong place to do video work.

If the API accepts a 2 GB upload and runs FFmpeg inside the request, several things go wrong:

- The API server becomes a bandwidth bottleneck.
- HTTP requests time out.
- One heavy video can block other users.
- Failed processing is hard to retry safely.
- Scaling the API also scales expensive CPU work, even when you only need more workers.

The correct design is asynchronous:

```text
Browser uploads file -> API records metadata -> Queue stores work -> Workers process video -> CDN serves output
```

## Core Requirements

Functional requirements:

- Users can register, log in, upload videos, list their videos, delete videos, and watch completed videos.
- The system creates multiple renditions such as 360p, 480p, 720p, and 1080p when the source quality supports them.
- The system creates HLS playlists and segments for adaptive bitrate playback.
- The frontend can show status such as uploaded, probing, processing, assembling, ready, and failed.
- Failed jobs can be retried or inspected.

Non-functional requirements:

- API requests should stay fast because heavy work happens in workers.
- Video files should never be stored in PostgreSQL.
- Raw and processed video files should live in S3-compatible object storage.
- Processing must be retryable and idempotent.
- Workers must be horizontally scalable.
- The system should be understandable and runnable locally before production deployment.

## Beginner Mental Model

Think of the system like a factory.

```text
User              API              Queue             Workers              Storage/CDN
 |                |                 |                 |                    |
 | asks to upload |                 |                 |                    |
 |--------------->|                 |                 |                    |
 | gets upload URL|                 |                 |                    |
 |<---------------|                 |                 |                    |
 | uploads file directly to storage |                 |                    |
 |--------------------------------------------------->| object storage     |
 | confirms upload|                 |                 |                    |
 |--------------->| creates record  | publishes work  |                    |
 |                |---------------->|                 |                    |
 |                |                 | workers pull jobs and encode video   |
 |                |                 |---------------->|                    |
 |                |                 |                 | writes output      |
 |                |                 |                 |------------------->|
 | watches later through CDN        |                 |                    |
 |----------------------------------------------------------------------- >|
```

The API is the front desk. It should not do factory work.

The queue is the task board. It remembers what needs to happen.

The workers are the machines. They do slow CPU-heavy jobs.

Object storage is the warehouse. It stores large files.

The CDN is the delivery network. It serves finished videos fast.

## Senior Engineer Mental Model

When designing this project, do not start by thinking about routes, folders, or UI components. Start by thinking about the lifecycle of one video.

One video moves through the system like this:

```text
Raw idea from user
  |
  v
Upload intent
  |
  v
Raw file stored
  |
  v
Processing planned
  |
  v
Encoding jobs running
  |
  v
Playable outputs created
  |
  v
User watches through CDN
```

Every service exists because one step in this lifecycle needs a clear owner. If two services both think they own the same step, the system becomes confusing. If no service owns a step, the system gets bugs.

As a junior developer, your main job is to keep asking:

- What state is the video in right now?
- Which service owns the next state transition?
- If this step fails, where is the failure recorded?
- If this event happens twice, do we create duplicate work?
- If the server restarts, can the system continue?

These questions are more important than framework details.

## What This Project Teaches You

This project is valuable because it touches many real backend patterns in one understandable product.

| Skill | Where You Learn It |
|---|---|
| API design | Upload, video listing, playback URL, retry routes |
| Async processing | Upload completion triggers background work |
| Queues | Transcoding jobs wait for workers |
| Worker design | FFmpeg work happens outside the API |
| Service boundaries | API, orchestrator, transcoder, assembler, notification |
| Data modeling | Users, videos, jobs, renditions, attempts |
| Object storage | Raw and encoded video files live outside the database |
| Idempotency | Duplicate events and retries do not corrupt state |
| Fault tolerance | Failed workers and failed jobs are recoverable |
| Observability | Logs and metrics explain what happened to a video |
| Scaling | Add more transcoders when queue grows |

The important point: this is not just a video app. It is a miniature distributed system.

## MVP vs Production

You should separate "first working version" from "production-grade version." If you try to build the production version first, you will get stuck.

MVP means:

- One user can upload one small video.
- The file reaches object storage.
- One worker can produce HLS output.
- The video can be played.
- Failures are visible enough for you to debug manually.

Production means:

- Many users can upload.
- Workers can crash and recover.
- Jobs can retry safely.
- Storage cleanup exists.
- CDN serves playback.
- Logs and metrics help you debug without guessing.
- You have deployment, backups, and alerting.

Think of the MVP as proving the shape of the pipeline. Think of production as making that pipeline safe under real-world conditions.

## Proposed Service Boundaries

This is a microservices-style architecture, but we should start pragmatically: same monorepo, shared packages, separate apps/processes. Do not start with Kubernetes or too many abstractions.

| Service | Main Responsibility | What It Must Not Do |
|---|---|---|
| Web app | User interface, upload flow, playback | Run backend jobs |
| API service | Auth, video metadata, presigned URLs, user-facing HTTP routes | Run FFmpeg |
| Orchestrator | Convert upload events into concrete processing jobs | Serve frontend traffic |
| Transcoder worker | Run FFmpeg work for one rendition/job | Decide global workflow |
| Assembler | Finalize HLS master playlist, thumbnails, ready status | Encode all renditions itself |
| Notification service | Push progress updates to browser | Own business state |
| Shared packages | DB, queue, storage, logger, types | Hide business logic that belongs to services |

## Technology Choices

| Area | Recommended Starting Choice | Reason |
|---|---|---|
| Runtime | Bun + TypeScript | Matches current project direction and keeps language consistent |
| API | Express | Simple and familiar for HTTP APIs |
| Database | PostgreSQL + Prisma | Strong relational model for users, videos, jobs, renditions |
| Queue | BullMQ on Redis | Good local developer experience, retries, progress, delayed jobs |
| Durable events | Redis Streams or BullMQ flows | Enough for this project before Kafka-level complexity |
| Object storage | MinIO locally, Cloudflare R2 or S3 in production | S3-compatible API, avoids storing large files in app servers |
| Video engine | FFmpeg and FFprobe | Industry standard for encoding and metadata extraction |
| Frontend | Next.js + React | Existing monorepo shape and good dashboard experience |
| Delivery | Cloudflare/CDN | Video segments should be cached near viewers |

Important correction: Kafka is not Redis-based. Kafka is a separate distributed event streaming platform. For this project, start with Redis/BullMQ unless you have a real need for Kafka later.

## Glossary For A Junior Developer

| Term | Meaning In This Project |
|---|---|
| Raw video | The original file uploaded by the user |
| Transcoding | Converting the raw video into streaming-friendly versions |
| Rendition | One output quality, such as 720p HLS |
| HLS | A streaming format made of playlists and small media segments |
| Master playlist | The HLS file that lists all available qualities |
| Variant playlist | The HLS file for one specific quality |
| Segment | A small video chunk, usually a few seconds long |
| Object storage | S3/R2/MinIO style storage for files |
| Presigned URL | Temporary URL that lets browser upload directly to storage |
| Queue | A place where background work waits |
| Worker | A process that takes work from the queue and performs it |
| Idempotency | Safe behavior when the same operation happens more than once |
| DLQ | Dead Letter Queue, where failed jobs go for investigation |
| CDN | Caching network that serves video files near viewers |

If a term feels unclear while reading the later docs, come back to this table.

## What Success Looks Like

Milestone success means the system works end to end for one small video before it handles scale.

```text
1. User uploads video
2. File appears in local object storage
3. Video record appears in PostgreSQL
4. Jobs appear in the queue
5. Worker creates HLS output
6. Assembler marks video ready
7. Frontend plays the final HLS stream
8. Logs can trace the same videoId across all services
```

## What Not To Build First

Do not start with these:

- Multi-region deployment.
- Kubernetes.
- Kafka.
- AV1/H.265 multi-codec ladders.
- Payment features.
- Advanced recommendation/search systems.
- Complex admin dashboards.

These are later scaling concerns. First build one reliable path: upload -> transcode -> play.

## Handoff Expectations

If I were handing this to you as a 6-month-experience developer, I would expect you to build it in layers, not all at once.

Layer 1:

- Understand the video lifecycle.
- Understand why the API does not process video.
- Understand why files go to object storage.

Layer 2:

- Build the upload metadata flow.
- Build direct upload to local object storage.
- Confirm that files and database rows line up.

Layer 3:

- Add queue-based processing.
- Add one worker.
- Produce one simple output.

Layer 4:

- Add multiple renditions.
- Add assembler.
- Add playback from master playlist.

Layer 5:

- Add reliability: retries, idempotency, failure states, cleanup, observability.

You should not skip layers. Each layer teaches one new system-design concept.

## Reading Order

Read the files in this order:

| File | Purpose |
|---|---|
| `01-overview.md` | Project goals, mental model, success criteria |
| `02-architecture.md` | End-to-end architecture and data flow |
| `03-services-deep-dive.md` | Each service boundary and responsibility |
| `04-database-schema.md` | Data model and storage keys |
| `05-video-concepts.md` | Video, HLS, renditions, codecs, FFmpeg concepts |
| `06-fault-tolerance.md` | Retries, idempotency, DLQ, shutdown, monitoring |
| `07-scaling-and-deployment.md` | Local setup, scaling path, deployment phases |
