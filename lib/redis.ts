// lib/redis.ts
import { Redis } from "@upstash/redis";

function pickEnv(...names: string[]) {
  for (const n of names) {
    const v = process.env[n];
    if (v && String(v).trim().length > 0) return String(v).trim();
  }
  throw new Error(`Missing env var. Tried: ${names.join(", ")}`);
}

export const redis = new Redis({
  url: pickEnv("UPSTASH_REDIS_REST_URL", "KV_REST_API_URL"),
  token: pickEnv("UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_TOKEN"),
});

export type JobStatus = "queued" | "processing" | "done" | "error";

export type OutputKey = "transcript" | "quiz" | "summary" | "interview" | "infographic" | "blog";

export type OutputSelections = Record<OutputKey, boolean>;

export type JobProgressItem = {
  key: string;
  label: string;
  current: number;
  total: number;
};

export type JobState = {
  jobId: string;
  status: JobStatus;

  createdAt: string;
  updatedAt: string;

  // inputs
  blobUrl?: string;
  baseName?: string;
  blogTopic?: string;
  infographicTitle?: string;
  targetAudience?: string;

  // selections
  selections?: OutputSelections;

  // progress
  stage?: JobProgressItem;
  progress?: Record<string, JobProgressItem>;

  // result
  downloadUrl?: string;
  filename?: string;

  // error
  error?: {
    message: string;
    stack?: string;
    time: string;
  };
};

export function jobKey(jobId: string) {
  return `job:process:${jobId}`;
}

export async function getJob(jobId: string): Promise<JobState | null> {
  const v = await redis.get<JobState>(jobKey(jobId));
  return v ?? null;
}

export async function setJob(jobId: string, next: JobState, ttlSeconds = 60 * 60 * 24) {
  await redis.set(jobKey(jobId), next, { ex: ttlSeconds });
}

export async function patchJob(jobId: string, patch: Partial<JobState>, ttlSeconds = 60 * 60 * 24) {
  const prev = (await getJob(jobId)) ?? null;
  if (!prev) {
    const now = new Date().toISOString();
    const created: JobState = {
      jobId,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      ...patch,
    };
    await setJob(jobId, created, ttlSeconds);
    return created;
  }

  const updated: JobState = {
    ...prev,
    ...patch,
    updatedAt: new Date().toISOString(),
  };

  await setJob(jobId, updated, ttlSeconds);
  return updated;
}

export function progressInit(): Record<string, JobProgressItem> {
  return {};
}

export function upsertProgress(
  progress: Record<string, JobProgressItem> | undefined,
  item: JobProgressItem
) {
  const p = progress ?? {};
  p[item.key] = item;
  return p;
}

// ---------- Per-row checkpoint storage (used for resumable processing) ----------

function checkpointKey(jobId: string, type: string) {
  return `job:process:${jobId}:cp:${type}`;
}

/**
 * Save a single row's result as a checkpoint so the job can resume after a
 * timeout without reprocessing already-completed rows.
 * @param value  JSON-serialisable result; pass an empty string for skipped rows.
 */
export async function saveRowCheckpoint(
  jobId: string,
  type: string,
  index: number,
  value: string,
  ttlSeconds = 60 * 60 * 24
) {
  const key = checkpointKey(jobId, type);
  await redis.hset(key, { [String(index)]: value });
  await redis.expire(key, ttlSeconds);
}

/**
 * Load all previously saved row checkpoints for a given output type.
 * Returns a map of row-index → saved value string (may be "" for skipped rows).
 */
export async function loadRowCheckpoints(
  jobId: string,
  type: string
): Promise<Record<string, string>> {
  const key = checkpointKey(jobId, type);
  const result = await redis.hgetall<Record<string, string>>(key);
  return result ?? {};
}

/** Remove checkpoint data for a job/type (called after successful completion). */
export async function deleteRowCheckpoints(jobId: string, type: string) {
  await redis.del(checkpointKey(jobId, type));
}