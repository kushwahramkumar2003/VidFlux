# System Architecture

This document explains the architecture as a set of flows and decisions. Do not treat it as implementation code. Treat it as the map you use before building.

## Architecture Principles

Use these principles whenever you are unsure where logic belongs:

- Keep HTTP request handling separate from video processing.
- Store large binary files in object storage, not in the database and not on long-lived app disks.
- Use queues for work that takes seconds or minutes.
- Make every job safe to retry.
- Keep each service responsible for one business capability.
- Prefer a simple local version first, then scale the same design.

## The Most Important Architecture Idea

This system has two separate paths:

- The request path.
- The background work path.

The request path is what the user is waiting for in the browser. It must be fast. Examples are login, asking for an upload URL, listing videos, and asking for a playback URL.

The background work path is what happens after the user has already received a response. It can take minutes. Examples are probing, transcoding, thumbnail generation, and assembly.

If you mix these paths, the system becomes unreliable. For example, if the API route waits for FFmpeg to finish, the browser request can time out and the API server can become overloaded. Instead, the API should create durable state and enqueue work.

## High-Level Component Diagram

```text
                         +----------------------+
                         |      Web App         |
                         | Next.js Dashboard    |
                         +----------+-----------+
                                    |
                                    | HTTP/SSE/WebSocket
                                    v
+----------------------+    +-------+-------+       +----------------------+
| Object Storage       |<---| API Service   |------>| PostgreSQL           |
| MinIO / R2 / S3      |    | Auth, uploads |       | metadata/state       |
+----------+-----------+    +-------+-------+       +----------------------+
           ^                        |
           |                        | durable event / queue job
           |                        v
           |                +-------+-------+
           |                | Redis/BullMQ  |
           |                | queues/events |
           |                +-------+-------+
           |                        |
           |                        v
           |                +-------+-------+
           |                | Orchestrator  |
           |                | plans jobs    |
           |                +-------+-------+
           |                        |
           |                        v
           |                +-------+-------+
           +----------------| Transcoders   |
           |                | FFmpeg workers|
           |                +-------+-------+
           |                        |
           |                        v
           |                +-------+-------+
           +----------------| Assembler     |
                            | finalizes HLS |
                            +-------+-------+
                                    |
                                    v
                            +-------+-------+
                            | CDN          |
                            | video output |
                            +--------------+
```

Read the diagram from left to right:

- The web app talks to the API for control actions.
- The browser uploads video bytes directly to object storage.
- PostgreSQL stores metadata and lifecycle state.
- Redis/BullMQ stores background work and short-lived progress events.
- The orchestrator turns an uploaded video into planned jobs.
- Transcoders perform CPU-heavy encoding.
- The assembler creates final playback entry points.
- The CDN serves video output to viewers.

The API is intentionally not in the playback file path. This is critical. API servers are good at authorization and metadata. CDNs and object storage are good at serving files.

## End-To-End Flow

### Phase 1: Upload Initialization

```text
Browser -> API: "I want to upload a video"
API -> PostgreSQL: create Video row with status INITIATED or UPLOADING
API -> Object Storage: create a temporary upload URL
API -> Browser: return videoId and upload URL
Browser -> Object Storage: upload raw video bytes directly
```

Why this matters:

- The API does not receive the large file.
- Upload bandwidth does not consume API server capacity.
- A failed upload can be retried by the browser without starting transcoding.

What can go wrong in this phase:

- The user requests an upload URL but never uploads the file.
- The browser upload fails halfway.
- The user refreshes the page.
- The object storage service is unavailable.

How to think about it:

- Creating a video row does not mean a valid video exists yet.
- The system should not start transcoding until upload completion is confirmed.
- Old unfinished uploads need a cleanup policy later.

### Phase 2: Upload Completion

```text
Browser -> API: "Upload completed for videoId"
API -> PostgreSQL: mark video as UPLOADED
API -> Queue/Event Stream: publish video.uploaded
API -> Browser: return processing status
```

The API should not call the orchestrator directly. A durable queue/event means the orchestrator can be restarted without losing the upload event.

Important detail:

- Upload completion should verify that the object exists in storage, or at least trust only a storage key that the API originally issued.
- Do not let the browser submit any random storage key and process someone else's file.
- If upload completion is called twice, the final state should still be one uploaded video and one processing workflow.

### Phase 3: Orchestration

```text
Orchestrator -> Queue/Event Stream: consume video.uploaded
Orchestrator -> Object Storage: read/probe source metadata
Orchestrator -> PostgreSQL: store duration, codec, width, height
Orchestrator -> PostgreSQL: create one TranscodingJob per target rendition
Orchestrator -> BullMQ: enqueue rendition jobs
Orchestrator -> Redis Pub/Sub: publish progress update
```

The orchestrator decides what work should exist. It should not do the actual heavy encoding.

Why orchestration is separate:

- Planning work and doing work are different responsibilities.
- The orchestrator is lightweight and decision-heavy.
- The transcoder is CPU-heavy and execution-heavy.
- Keeping them separate lets you scale expensive FFmpeg workers without duplicating workflow-planning logic everywhere.

Example:

```text
Source video is 720p
  |
  +-- orchestrator decides 720p, 480p, 360p are needed
  |
  +-- orchestrator creates three jobs
  |
  +-- three workers may process them in parallel
```

### Phase 4: Transcoding

```text
Transcoder -> BullMQ: claim one job
Transcoder -> PostgreSQL: mark job PROCESSING
Transcoder -> Object Storage: download source file or stream input
Transcoder -> local temp disk: run FFmpeg output
Transcoder -> Object Storage: upload HLS segments and variant playlist
Transcoder -> PostgreSQL: mark job COMPLETED and create Rendition
Transcoder -> Event Stream: publish rendition.completed
```

Transcoder instances should be stateless. If one crashes, another worker should be able to retry the same job.

Stateless does not mean "no local files ever." A transcoder can use local temp files while processing. Stateless means the important durable state is not only on that worker machine. If the machine dies, another worker can get the source from object storage, read the job from the queue/database, and produce the output again.

### Phase 5: Assembly

```text
Assembler -> Event Stream: consume rendition.completed
Assembler -> PostgreSQL: check if all expected jobs are complete
Assembler -> Object Storage: write master playlist and thumbnails
Assembler -> PostgreSQL: mark video READY
Assembler -> Pub/Sub: publish video.ready
```

The assembler is a coordinator. It turns many completed rendition outputs into one playable video asset.

The assembler should always check database state before marking a video ready. Completion events are useful triggers, but events alone are not enough. Events can be duplicated, delayed, or missed during restarts. PostgreSQL should answer the final question: "Are all required jobs complete?"

### Phase 6: Playback

```text
Browser -> API: request playable URL
API -> Browser: return signed or public CDN URL
Browser -> CDN: fetch master playlist
CDN -> Object Storage: fetch on cache miss
Browser video player: adapt between qualities
```

The API should not stream segments. It should only authorize and return URLs.

Playback is a read-heavy workload. One popular video can create thousands of segment requests. If those requests hit your API server, you pay for unnecessary compute and risk taking down your application. If they hit the CDN, edge caches absorb most of the load.

## Detailed Sequence Diagram

This diagram shows the normal happy path with service ownership.

```text
Browser
  |
  | 1. Start upload
  v
API
  |
  | 2. Create Video row
  v
PostgreSQL
  |
  | 3. API returns presigned URL
  v
Browser
  |
  | 4. Upload bytes
  v
Object Storage
  |
  | 5. Confirm upload
  v
API
  |
  | 6. Mark UPLOADED and publish event
  v
Queue/Event Stream
  |
  | 7. Consume upload event
  v
Orchestrator
  |
  | 8. Probe file and create jobs
  v
PostgreSQL + Queue
  |
  | 9. Workers claim jobs
  v
Transcoder Workers
  |
  | 10. Upload encoded outputs
  v
Object Storage
  |
  | 11. Completion events
  v
Assembler
  |
  | 12. Master playlist and READY state
  v
PostgreSQL + Object Storage
  |
  | 13. User plays through CDN
  v
CDN
```

If you cannot explain this sequence clearly, do not start coding yet. Most implementation bugs come from not knowing who owns each step.

## Communication Pattern Decisions

| Communication | Pattern | Why |
|---|---|---|
| Browser -> API | Synchronous HTTP | User needs immediate response |
| Browser -> Object Storage | Presigned direct upload | Avoid API bandwidth bottleneck |
| API -> Orchestrator | Durable event/queue | Orchestrator can fail without losing work |
| Orchestrator -> Transcoder | Work queue | Need retries, concurrency, backoff, progress |
| Transcoder -> Assembler | Completion event plus DB state | Assembler reacts when all jobs finish |
| Services -> Browser progress | Pub/Sub plus SSE/WebSocket | Low-latency updates; persistence not required |
| Browser -> CDN | HTTP segment fetching | Standard video delivery path |

## Sync vs Async Communication

Synchronous communication means one service waits for another service to respond immediately. HTTP requests are usually synchronous.

Asynchronous communication means one service leaves a message or job somewhere and another service handles it later. Queues and streams are asynchronous.

Use synchronous communication when:

- The user needs an immediate answer.
- The operation is fast.
- Failure can be shown immediately.

Use asynchronous communication when:

- The work takes a long time.
- The work should survive service restarts.
- The work needs retries.
- The work can be processed by a pool of workers.

In this project:

- Login is synchronous.
- Upload URL generation is synchronous.
- Transcoding is asynchronous.
- Assembly is asynchronous.
- Progress notification is near-realtime but not durable source-of-truth.

## Service Ownership Model

Each service owns decisions in its domain.

| Domain Question | Owner |
|---|---|
| Is the user allowed to access this video? | API |
| Which renditions should be created? | Orchestrator |
| How is one rendition encoded? | Transcoder |
| Is the whole video ready? | Assembler |
| How does the user see progress? | Notification |
| Where are files stored? | Storage package plus service callers |
| What is the source of truth for state? | PostgreSQL |

## State Machine

Video state:

```text
INITIATED
  |
  v
UPLOADING
  |
  v
UPLOADED
  |
  v
PROBING
  |
  v
PROCESSING
  |
  v
ASSEMBLING
  |
  v
READY

Any state after UPLOADED can also move to FAILED.
Deleted videos move to DELETING, then DELETED or FAILED_DELETE.
```

State explanation:

- `INITIATED` means the system knows the user intends to upload, but the file may not exist yet.
- `UPLOADING` means the browser has an upload URL and is expected to upload bytes.
- `UPLOADED` means the raw file exists and processing can begin.
- `PROBING` means the system is reading metadata like duration and resolution.
- `PROCESSING` means one or more encoding jobs exist.
- `ASSEMBLING` means encoding is complete and final playback metadata is being created.
- `READY` means the user can watch the video.
- `FAILED` means the system reached a clear failure state.

Good systems avoid vague states like `IN_PROGRESS` for everything. Specific states make debugging easier.

Job state:

```text
PENDING -> PROCESSING -> COMPLETED
    |          |
    |          v
    +-------> RETRYING -> PROCESSING
               |
               v
             FAILED
```

Job state explanation:

- `PENDING` means the job exists but no worker is actively doing it.
- `PROCESSING` means a worker has claimed it.
- `RETRYING` means the job failed temporarily and is waiting before another attempt.
- `COMPLETED` means the expected output exists.
- `FAILED` means the system will not keep retrying automatically.

Do not mark a job completed just because FFmpeg finished. It should be completed only after output is uploaded and durable state is updated.

## Key Trade-Offs

### BullMQ/Redis vs Kafka

Start with BullMQ/Redis.

Why:

- Easier local development.
- Built-in retry and job progress concepts.
- Lower operational burden.
- Good enough for a learning and early production system.

Revisit Kafka when:

- Many independent downstream services need the same event history.
- You need long event retention and replay.
- Redis queue memory pressure becomes a serious operational limit.

### Separate Services vs One Backend

Use separate apps/processes in the monorepo, but do not over-engineer deployment on day one.

Why:

- You learn service boundaries.
- You can scale transcoders independently.
- You avoid putting FFmpeg inside the API.
- Shared packages reduce duplication while services remain independently runnable.

### HLS First vs DASH Too

Start with HLS only.

Why:

- Browser support is practical with hls.js.
- CDN behavior is straightforward.
- Fewer packaging formats means fewer bugs.

Add DASH only after HLS is reliable.

### One Queue vs Multiple Queues

You can start with one transcoding queue, but later multiple queues may help.

One queue is simpler:

- Easier to understand.
- Easier local development.
- Fewer moving parts.

Multiple queues are useful when:

- 1080p jobs are much slower than 360p jobs.
- Thumbnail jobs should not wait behind long video jobs.
- High-priority users should be processed faster.
- You want different worker machine types for different work.

Recommended first version:

- One upload/planning event stream.
- One transcoding queue.
- One assembly/completion flow.

Revisit once the basic pipeline is reliable.

## Request Path vs Work Path

This is the most important architecture distinction.

Request path:

```text
User waits for this.
Keep it fast.

Browser -> API -> DB/storage URL -> Browser
```

Work path:

```text
User does not wait for this.
Make it reliable and retryable.

Queue -> Orchestrator -> Queue -> Transcoder -> Assembler
```

If you accidentally put work-path logic into the request path, the system becomes fragile.

## First Version Scope

Version 1 should support:

- One user uploading videos.
- Basic auth.
- Direct upload to MinIO.
- HLS output for H.264/AAC.
- 360p, 480p, 720p, 1080p renditions based on source height.
- Simple progress status.
- Manual retry of failed jobs.
- Local Docker Compose infrastructure.

Version 1 should not require:

- Kubernetes.
- Multi-region deployment.
- Multiple codecs.
- Live streaming.
- Payment/subscription logic.
- Advanced analytics.
