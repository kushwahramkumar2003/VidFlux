# VidFlux

VidFlux is a distributed video transcoding platform built as a TypeScript monorepo. It accepts raw video uploads and automatically transcodes them into multiple resolutions using a pipeline of decoupled background services communicating over Redis Streams.

---

![Architecture](./archetecture.svg)

---

## How It Works

When a user uploads a video through the API, the raw file URL is pushed onto a Redis stream. The **Orchestrator** periodically polls this stream, picks up pending raw videos, and fans out one transcoding job per resolution — 144p through 1080p — back onto a separate stream.

Each **Transcoder** instance reads a single job at a time from that stream, runs the video through FFmpeg to produce the target resolution, uploads the output to S3, and then publishes the result onto a third stream. Running multiple Transcoder processes in parallel is safe because each instance is identified by its hostname and PID, and the consumer group in Redis ensures no two workers claim the same job.

The **DB Writer** listens on the transcoded-videos stream. For each completed job it receives, it writes the S3 URL into the database as a `TranscodedVideo` record and marks the parent `RawVideo` as `PROCESSED` — both inside a single atomic transaction.

## Monorepo Layout

The project is managed with Turborepo and Bun workspaces.

**Apps**

- `api` — REST API that handles uploads and exposes video data
- `orchestrator` — Polls raw-video events and distributes transcode jobs
- `transcoder` — FFmpeg worker; processes one job at a time per instance
- `db-writter` — Persists transcoded results and updates video status
- `web` — Next.js frontend

**Packages**

- `@repo/ffmpeg` — Wrapper around `fluent-ffmpeg` for resolution-aware transcoding
- `@repo/redis` — Shared Redis client, stream helpers, and typed message interfaces
- `@repo/s3` — AWS S3 upload utility
- `@repo/db` — Prisma client and generated types (PostgreSQL)
- `@repo/common` — Shared logger and async error handler

## Tech Stack

VidFlux is built on Node.js / Bun, TypeScript, PostgreSQL (via Prisma), Redis Streams, AWS S3, and FFmpeg. The monorepo tooling is Turborepo with Bun as the package manager and runtime.

## License

MIT
