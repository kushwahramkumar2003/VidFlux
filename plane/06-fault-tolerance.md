# Fault Tolerance And Reliability

Video processing is slow and failure-prone. A reliable system does not assume everything works. It assumes failures will happen and makes them safe.

## Reliability Goals

The system should handle:

- Worker crashes.
- Duplicate events.
- Temporary Redis/PostgreSQL/object-storage errors.
- Invalid video uploads.
- FFmpeg failures.
- Disk cleanup issues.
- Deployments while jobs are running.
- Browser refreshes during processing.

The user should see a clear final state: ready, processing, or failed. The system should not silently lose videos.

## Reliability Mindset

A beginner often thinks: "How do I make this work?"

A senior engineer also asks: "How does this fail, and what state is left behind?"

For this project, every important step should have an answer to these questions:

- What if this operation is executed twice?
- What if the process dies after doing the external work but before updating the database?
- What if the database update succeeds but event publishing fails?
- What if object storage has partial output?
- What if the user refreshes the page?
- What if the worker is deployed while encoding?

You do not need perfect answers on day one. But you must know where the risky points are.

## Failure Map

| Failure | Example | Expected Behavior |
|---|---|---|
| Browser upload interrupted | Laptop sleeps mid-upload | User retries upload; no processing starts until completion |
| API queue publish fails | Redis unavailable | Video does not falsely appear processing; recovery path exists |
| Duplicate upload event | Client retries completion | Orchestrator does not create duplicate jobs |
| Worker crash | Machine restarts during FFmpeg | Queue retries job after lock expires |
| Object storage timeout | Segment upload fails | Retry with backoff |
| Invalid video | File is not playable | Mark failed without retry loop |
| Temp disk full | Worker cannot write segments | Fail job, alert, clean temp space |
| Assembler crash | Crash after some final files written | Retry safely and produce same final state |
| Notification service down | SSE/WebSocket unavailable | Processing continues; browser can refresh API status |

## Failure Timeline Example

This is a realistic failure:

```text
1. Worker claims 720p job
2. Worker downloads source file
3. Worker runs FFmpeg successfully
4. Worker uploads 720p segments
5. Worker crashes before updating PostgreSQL
6. Queue eventually retries the job
7. New worker sees the same job
8. New worker writes to same output prefix
9. New worker updates PostgreSQL
10. Final state is one completed 720p rendition
```

This is why deterministic output keys and idempotent database writes matter.

## Retry Strategy

Retries are for temporary failures, not permanent failures.

Retry examples:

- Object storage timeout.
- Redis connection reset.
- PostgreSQL transient connection error.
- Worker killed by machine restart.
- Temporary DNS/network issue.

Do not retry forever.

Recommended starting policy:

| Job Type | Attempts | Backoff |
|---|---:|---|
| Upload completion recovery | 3-5 | Short exponential |
| FFprobe/probing | 3 | Exponential |
| Transcoding | 3-5 | Exponential with jitter |
| Assembly | 5 | Exponential |
| Storage cleanup | Many delayed retries | Longer backoff |

Jitter matters. If 100 jobs fail at the same time and all retry after exactly 10 seconds, they can overload the same dependency again.

Retry decision tree:

```text
Operation failed
  |
  +-- Is the input invalid?
  |     |
  |     +-- yes -> permanent failure
  |
  +-- Is the user/video deleted?
  |     |
  |     +-- yes -> cancel job
  |
  +-- Is the dependency temporarily unavailable?
  |     |
  |     +-- yes -> retry with backoff
  |
  +-- Is the worker out of local resources?
        |
        +-- retry only after alerting or reducing pressure
```

Do not retry because you are unsure. Classify the error as clearly as possible.

## Permanent vs Transient Errors

Classify errors before deciding retry behavior.

| Error | Type | Action |
|---|---|---|
| Corrupt input file | Permanent | Mark video failed |
| Unsupported media format | Permanent | Mark video failed |
| User deleted video | Permanent/cancelled | Cancel outstanding jobs |
| Object storage timeout | Transient | Retry |
| Redis unavailable | Transient | Retry or pause |
| Worker out of memory | Usually transient, sometimes capacity issue | Retry with alert if repeated |
| FFmpeg cannot decode stream | Permanent | Mark failed |
| Temp disk full | Infrastructure failure | Fail/retry after cleanup and alert |

As a junior developer, do not hide all errors behind "something failed." Store enough context to debug.

Good failure records include:

- Error category.
- Short user-safe message.
- Technical message for logs/admins.
- Service where it failed.
- Job/video identifiers.
- Attempt number.
- Timestamp.

Bad failure record:

```text
error = failed
```

Good failure record:

```text
errorCategory = INVALID_INPUT
service = transcoder
message = FFmpeg could not decode video stream
videoId = video-123
jobId = job-456
attempt = 1
```

## Idempotency

Idempotency means repeating the same operation gives the same final result.

This is essential because queues can deliver work more than once and clients can retry requests.

Required idempotency rules:

- Calling upload complete twice should not publish unlimited duplicate work.
- Orchestrator should not create duplicate jobs for the same video/profile.
- Transcoder should write deterministic output keys.
- Creating a rendition should use uniqueness rules.
- Assembler should be safe to run multiple times.
- Delete cleanup should be safe if some files are already gone.

Visual example:

```text
Worker completes 720p
  |
  +--> uploads output successfully
  |
  +--> DB update times out
  |
  +--> queue retries job
  |
  +--> worker sees output/rendition already exists or overwrites same keys safely
  |
  +--> final state is still one 720p rendition
```

Idempotency by service:

| Service | Idempotency Rule |
|---|---|
| API upload completion | Same video should not enqueue infinite workflows |
| Orchestrator | Same uploaded video should produce same job set once |
| Transcoder | Same job should write same output and one rendition |
| Assembler | Same video should produce same master playlist and READY state |
| Cleanup | Deleting missing files should not fail the whole cleanup |

Idempotency is not optional in queue-based systems. It is the difference between safe retries and corrupted state.

## Dead Letter Queue

A Dead Letter Queue is where jobs go after retries are exhausted.

It is not a trash bin. It is an investigation queue.

DLQ record should include:

- jobId.
- videoId.
- service name.
- error type.
- error message.
- attempt count.
- last failure time.
- whether retry is allowed manually.

Operational flow:

```text
Job fails -> retries exhausted -> DLQ -> alert/admin view -> inspect -> retry or mark final failed
```

Version 1 can use BullMQ failed jobs plus database status as the DLQ view. Later you can add a dedicated admin page.

How to use DLQ during development:

- Do not ignore failed jobs.
- Pick one failed job.
- Read its videoId and jobId.
- Check database state.
- Check object storage output.
- Check worker logs.
- Decide whether retry makes sense.

This habit will make you much better at debugging distributed systems.

## Graceful Shutdown

Workers must handle shutdown carefully.

Expected behavior:

```text
SIGTERM received
  |
  +-- stop accepting new jobs
  |
  +-- let current job finish if within grace period
  |
  +-- update database and publish status
  |
  +-- cleanup temp files
  |
  +-- exit
```

If the job cannot finish before the grace period:

- The process exits.
- Queue lock expires.
- Another worker retries the job.
- Idempotency protects partial output.

For local development, you can keep this simple. For production, shutdown behavior becomes important during deploys.

Why shutdown matters:

Deployments are planned failures. When you deploy a new version, old processes are stopped. If workers die immediately during FFmpeg, you waste work and increase retries.

For API services, fast shutdown is usually fine.

For transcoders, shutdown needs more care because jobs can be long-running.

## Health Checks

Every backend service should expose or support a health check appropriate to its role.

API health:

- Process is alive.
- Database reachable.
- Redis reachable.
- Storage client can be initialized.

Worker health:

- Process is alive.
- Redis reachable.
- Database reachable.
- Object storage reachable.
- FFmpeg/FFprobe available.
- Temp directory writable and has enough space.

Notification health:

- Process is alive.
- Redis subscription works.
- Database reachable if ownership checks happen there.

Do not make health checks too expensive. They should be fast and safe.

Health check vs readiness:

- Liveness asks: "Is the process alive?"
- Readiness asks: "Should traffic/work be sent here?"

A worker may be alive but not ready if Redis is unreachable or FFmpeg is missing. An API may be alive but not ready if the database is down.

## Circuit Breakers

A circuit breaker prevents repeated calls to a broken dependency.

Mental model:

```text
CLOSED: calls are allowed
  |
  | too many failures
  v
OPEN: fail fast temporarily
  |
  | wait
  v
HALF-OPEN: test with limited call
  |
  +-- success -> CLOSED
  +-- failure -> OPEN
```

Use this for dependencies such as object storage or external APIs. Do not overuse it in the first version, but understand the pattern.

When not to use a circuit breaker:

- Do not add it before you have basic timeouts and retries.
- Do not use it to hide permanent data errors.
- Do not let it make debugging harder with unclear behavior.

First version priority:

1. Timeouts.
2. Retries with backoff.
3. Clear failure states.
4. Circuit breakers later if dependency failures cause cascading problems.

## Timeouts

Every network call needs a timeout.

Without timeouts:

- Workers hang forever.
- Queue slots stay occupied.
- Deployments become stuck.
- Users see processing forever.

Timeout examples:

| Operation | Timeout Thinking |
|---|---|
| API request to DB | Short |
| Presigned URL generation | Short |
| Object storage upload/download | Longer, but bounded |
| FFmpeg process | Based on input duration and size |
| Queue job lock | Longer than normal processing heartbeat |

## Stuck Job Detection

Some jobs may never finish due to crashes or bad lock handling.

Add an operational check:

```text
Find jobs with status PROCESSING
where updatedAt is older than expected
and queue does not show active ownership.
```

Then either:

- Requeue if safe.
- Mark failed if repeated.
- Alert if many jobs are stuck.

## Observability

You need three types of visibility.

Logs:

- Structured logs.
- Include videoId, jobId, userId where safe, service name, and event name.

Metrics:

- Queue depth.
- Active jobs.
- Failed jobs.
- Average encode duration.
- Storage upload/download failures.
- Worker CPU/memory/disk usage.
- API latency.

Tracing/debug correlation:

- A single videoId should let you follow the full journey across API, orchestrator, transcoder, assembler, and notification.

## Alert Thresholds

Start with simple alerts:

| Signal | Alert When |
|---|---|
| DLQ/failed jobs | More than 0 in production |
| Queue depth | Growing for a sustained period |
| Worker errors | Repeated failures in short window |
| Disk usage | Above 80% |
| Redis memory | Above 80% |
| API error rate | Above normal baseline |
| Processing stuck | Video processing longer than expected maximum |

## Recovery Scenarios

### Redis Restart

Expected:

- Active queue jobs may retry.
- Pub/Sub progress messages may be lost.
- Database still has durable state.
- Browser can refresh and fetch latest state.

### Worker Machine Dies

Expected:

- Queue lock eventually expires.
- Job retries.
- Partial local temp files are lost, which is acceptable.
- Partial object storage output is overwritten or cleaned.

### Assembler Runs Twice

Expected:

- Same master playlist key.
- Same video READY status.
- No duplicate renditions.

### User Deletes Video During Processing

Expected:

- Video status becomes DELETING or CANCELLED.
- Pending jobs are cancelled when possible.
- Active jobs stop or finish but should not mark video READY.
- Cleanup removes object storage prefixes.

## Reliability Checklist Before Production

- Upload completion is idempotent.
- Job creation has uniqueness constraints.
- Worker jobs have retry limits.
- Permanent errors do not retry forever.
- Failed jobs are visible.
- Temp files are cleaned.
- Logs include videoId and jobId.
- Health checks exist.
- Processing can recover after restarting each service.
- Browser refresh does not lose status.
