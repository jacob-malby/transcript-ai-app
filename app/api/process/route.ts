import mammoth from "mammoth";
import { put } from "@vercel/blob";
import { waitUntil } from "@vercel/functions";

import { openai } from "@/lib/openai";
import { prompts } from "@/lib/prompts";
import { parseTranscript, combinedTextFromRows } from "@/lib/transcript";
import {
  buildTranscriptTableDoc,
  buildQuizDoc,
  buildSummaryDoc,
  buildVirtualInterviewDoc,
  buildSimpleParagraphDoc,
} from "@/lib/docx-builders";
import { makeZip } from "@/lib/zip";
import { sseEvent, sseHeaders, sseComment, sseRetry } from "@/lib/sse";
import {
  getJob,
  patchJob,
  progressInit,
  upsertProgress,
  saveRowCheckpoint,
  loadRowCheckpoints,
  deleteRowCheckpoints,
  JobState,
  JobProgressItem,
  OutputSelections,
} from "@/lib/redis";

export const runtime = "nodejs";

/**
 * Maximum allowed duration for this Vercel function.
 * Hobby plan: 300 s max. Pro: 300 s. Enterprise: up to 900 s.
 */
export const maxDuration = 300;

/** Number of rows processed in parallel for each output section. */
const CONCURRENCY = 5;

/**
 * A job stuck in "processing" for longer than this is considered stale and
 * may be re-triggered by a new POST request or the next runJob invocation.
 */
const STALE_PROCESSING_MS = 5 * 60 * 1000; // 5 minutes

type StartBody = {
  jobId?: string;
  blobUrl: string;
  baseName?: string;
  blogTopic?: string;
  infographicTitle?: string;
  targetAudience?: string;
  selections?: OutputSelections;
};

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function nowISO() {
  return new Date().toISOString();
}

function ensureString(x: unknown): x is string {
  return typeof x === "string" && x.length > 0;
}

function jobStage(key: JobProgressItem["key"], label: string, current: number, total: number): JobProgressItem {
  return { key, label, current, total };
}

async function setStage(jobId: string, key: JobProgressItem["key"], label: string, current: number, total: number) {
  await patchJob(jobId, { stage: jobStage(key, label, current, total) });
}

async function setProgress(jobId: string, item: JobProgressItem) {
  const state = await getJob(jobId);
  const progress = upsertProgress(state?.progress ?? progressInit(), item);
  await patchJob(jobId, { progress });
}

async function failJob(jobId: string, err: unknown) {
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);
  const stack = err instanceof Error ? err.stack ?? "" : "";

  await patchJob(jobId, {
    status: "error",
    error: { message, stack, time: nowISO() },
  });
}

function isRetriableOpenAIError(err: any) {
  const status = Number(err?.status ?? err?.statusCode ?? 0);
  const code = String(err?.code ?? "");
  const message = String(err?.message ?? "").toLowerCase();

  return (
    status === 408 ||
    status === 409 ||
    status === 429 ||
    status >= 500 ||
    code === "rate_limit_exceeded" ||
    code === "api_connection_error" ||
    message.includes("rate limit") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("connection") ||
    message.includes("overloaded")
  );
}

async function ask(model: string, input: string, jobId: string, context: string) {
  const maxAttempts = 6;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const r = await openai.responses.create({
        model,
        input,
      });

      return r.output_text?.trim() ?? "";
    } catch (err: any) {
      const retriable = isRetriableOpenAIError(err);

      if (!retriable || attempt === maxAttempts) {
        throw new Error(`${context} failed after ${attempt} attempt(s): ${err?.message ?? "Unknown OpenAI error"}`);
      }

      const delay = Math.min(12000, 1000 * Math.pow(2, attempt - 1));
      await patchJob(jobId, {
        stage: jobStage(
          "connected",
          `${context} hit a temporary issue. Retrying (${attempt}/${maxAttempts})…`,
          attempt,
          maxAttempts
        ),
      });

      await sleep(delay);
    }
  }

  throw new Error(`${context} failed unexpectedly`);
}

/** Returns true when a job has been stuck in "processing" state long enough to be considered stale. */
function isStuckInProcessing(state: JobState): boolean {
  if (state.status !== "processing") return false;
  const updatedAt = new Date(state.updatedAt).getTime();
  return Date.now() - updatedAt > STALE_PROCESSING_MS;
}

/**
 * Run `fn` over every item in `items`, keeping at most `limit` invocations
 * running at any one time.  Preserves the order of results.
 */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>
): Promise<void> {
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      await fn(items[i], i);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function runJob(jobId: string) {
  const state = await getJob(jobId);
  if (!state) return;

  if (state.status === "done") return;

  // If currently processing, only allow re-run when the job has been stuck
  // (no Redis update) for longer than STALE_PROCESSING_MS.
  if (state.status === "processing" && !isStuckInProcessing(state)) return;

  if (!ensureString(state.blobUrl)) {
    await failJob(jobId, new Error("Job missing blobUrl"));
    return;
  }

  const blobUrl = state.blobUrl;
  const baseName = state.baseName ?? "Outputs";
  const blogTopic = state.blogTopic ?? "";
  const infographicTitle = state.infographicTitle ?? "";
  const targetAudience = state.targetAudience ?? "";

  const defaultSelections: OutputSelections = {
    transcript: true,
    summary: true,
    quiz: true,
    interview: true,
    infographic: true,
    blog: true,
  };
  const sel = state.selections ?? defaultSelections;

  try {
    await patchJob(jobId, { status: "processing" });

    await setStage(jobId, "download", "Downloading transcript", 0, 1);

    const fileRes = await fetch(blobUrl);
    if (!fileRes.ok) {
      throw new Error(`Failed to fetch transcript: ${fileRes.status} ${fileRes.statusText}`);
    }

    const arrayBuffer = await fileRes.arrayBuffer();
    const buf = Buffer.from(arrayBuffer);

    await setStage(jobId, "download", "Downloading transcript", 1, 1);
    await setStage(jobId, "extract", "Extracting text", 0, 1);

    const extracted = await mammoth.extractRawText({ buffer: buf });
    const rawText = extracted.value ?? "";

    await setStage(jobId, "extract", "Extracting text", 1, 1);
    await setStage(jobId, "parse", "Parsing transcript", 0, 1);

    const rows = parseTranscript(rawText);
    const loopRows = rows.filter((r) => (r.speaker || "").toUpperCase().indexOf("DT") === -1);
    const totalRows = loopRows.length || 1;

    await setStage(jobId, "parse", "Parsing transcript", 1, 1);

    if (sel.transcript) await setProgress(jobId, jobStage("transcript", "Transcript Table", 0, 1));
    if (sel.quiz) await setProgress(jobId, jobStage("quiz", "Quiz Questions", 0, totalRows));
    if (sel.summary) await setProgress(jobId, jobStage("summary", "Summary", 0, totalRows));
    if (sel.interview) await setProgress(jobId, jobStage("interview", "Virtual Interview", 0, totalRows));
    if (sel.infographic) await setProgress(jobId, jobStage("infographic", "Infographic", 0, 1));
    if (sel.blog) await setProgress(jobId, jobStage("blog", "Blog Post", 0, 1));

    const zipEntries: { name: string; data: Buffer }[] = [];

    if (sel.transcript) {
      await setStage(jobId, "transcript", "Generating Transcript Table", 0, 1);
      const transcriptDoc = await buildTranscriptTableDoc(rows);
      await setProgress(jobId, jobStage("transcript", "Transcript Table", 1, 1));
      await setStage(jobId, "transcript", "Generating Transcript Table", 1, 1);
      zipEntries.push({ name: `${baseName} - Transcript Table.docx`, data: transcriptDoc });
    }

    if (sel.quiz) {
      await setStage(jobId, "quiz", "Generating Quiz Questions", 0, 1);

      // Load previously saved checkpoints so we can resume after a timeout.
      const quizCheckpoints = await loadRowCheckpoints(jobId, "quiz");
      let quizCompleted = Object.keys(quizCheckpoints).length;

      // Pre-fill results array from checkpoints.
      const quizResults: ({ q: string; torf: string; wrong: string } | null)[] =
        new Array(loopRows.length).fill(null);
      for (const [k, v] of Object.entries(quizCheckpoints)) {
        if (v) quizResults[parseInt(k, 10)] = JSON.parse(v);
      }

      if (quizCompleted > 0) {
        await setProgress(jobId, jobStage("quiz", "Quiz Questions", quizCompleted, totalRows));
      }

      await runWithConcurrency(loopRows, CONCURRENCY, async (row, i) => {
        if (String(i) in quizCheckpoints) return; // already done

        const text = row.text;
        if (text.length > 50) {
          const q = await ask("gpt-4o", prompts.quizQuestion(text), jobId, `Quiz question ${i + 1}/${totalRows}`);
          const torf = await ask("gpt-4o", prompts.quizTorF(text), jobId, `True/False ${i + 1}/${totalRows}`);
          const wrong = await ask("gpt-4o", prompts.quizWrongAnswers(q), jobId, `Wrong answers ${i + 1}/${totalRows}`);
          const item = { q, torf, wrong };
          quizResults[i] = item;
          await saveRowCheckpoint(jobId, "quiz", i, JSON.stringify(item));
        } else {
          await saveRowCheckpoint(jobId, "quiz", i, ""); // mark short row as done
        }

        quizCompleted++;
        await setProgress(jobId, jobStage("quiz", "Quiz Questions", quizCompleted, totalRows));
      });

      const quizItems = quizResults.filter(
        (q): q is { q: string; torf: string; wrong: string } => q !== null
      );
      const quizDoc = await buildQuizDoc(quizItems);
      zipEntries.push({ name: `${baseName} - Quiz Questions.docx`, data: Buffer.from(quizDoc) });
    }

    let summaryText = "";
    if (sel.summary || sel.infographic) {
      await setStage(jobId, "summary", "Generating Summary", 0, 1);

      const summaryCheckpoints = await loadRowCheckpoints(jobId, "summary");
      let summaryCompleted = Object.keys(summaryCheckpoints).length;

      const summaryResults: (string | null)[] = new Array(loopRows.length).fill(null);
      for (const [k, v] of Object.entries(summaryCheckpoints)) {
        summaryResults[parseInt(k, 10)] = v; // may be "" for short rows
      }

      if (summaryCompleted > 0) {
        await setProgress(jobId, jobStage("summary", "Summary", summaryCompleted, totalRows));
      }

      await runWithConcurrency(loopRows, CONCURRENCY, async (row, i) => {
        if (String(i) in summaryCheckpoints) return;

        const text = row.text;
        let result = "";
        if (text.length > 50) {
          result = await ask(
            "gpt-4o-mini",
            prompts.summarize2Sentences(text),
            jobId,
            `Summary ${i + 1}/${totalRows}`
          );
        }
        summaryResults[i] = result;
        await saveRowCheckpoint(jobId, "summary", i, result);

        summaryCompleted++;
        await setProgress(jobId, jobStage("summary", "Summary", summaryCompleted, totalRows));
      });

      const summaryLines = summaryResults.filter((s): s is string => s !== null && s !== "");
      summaryText = summaryLines.join("\n");

      if (sel.summary) {
        const summaryDoc = await buildSummaryDoc(summaryLines);
        zipEntries.push({ name: `${baseName} - Summary.docx`, data: Buffer.from(summaryDoc) });
      }
    }

    if (sel.interview) {
      await setStage(jobId, "interview", "Generating Virtual Interview", 0, 1);

      const interviewCheckpoints = await loadRowCheckpoints(jobId, "interview");
      let interviewCompleted = Object.keys(interviewCheckpoints).length;

      const interviewResults: ({ question: string; summary: string } | null)[] =
        new Array(loopRows.length).fill(null);
      for (const [k, v] of Object.entries(interviewCheckpoints)) {
        if (v) interviewResults[parseInt(k, 10)] = JSON.parse(v);
      }

      if (interviewCompleted > 0) {
        await setProgress(jobId, jobStage("interview", "Virtual Interview", interviewCompleted, totalRows));
      }

      await runWithConcurrency(loopRows, CONCURRENCY, async (row, i) => {
        if (String(i) in interviewCheckpoints) return;

        const text = row.text;
        if (text.length > 50) {
          const question = await ask(
            "gpt-4o-mini",
            prompts.interviewQuestion(text),
            jobId,
            `Interview question ${i + 1}/${totalRows}`
          );
          const summary = await ask(
            "gpt-4o-mini",
            prompts.interviewSummaryFromQuestion(question, text),
            jobId,
            `Interview summary ${i + 1}/${totalRows}`
          );
          const item = { question, summary };
          interviewResults[i] = item;
          await saveRowCheckpoint(jobId, "interview", i, JSON.stringify(item));
        } else {
          await saveRowCheckpoint(jobId, "interview", i, "");
        }

        interviewCompleted++;
        await setProgress(jobId, jobStage("interview", "Virtual Interview", interviewCompleted, totalRows));
      });

      const interviewItems = interviewResults.filter(
        (it): it is { question: string; summary: string } => it !== null
      );
      const interviewDoc = await buildVirtualInterviewDoc(interviewItems);
      zipEntries.push({ name: `${baseName} - Virtual Interview.docx`, data: Buffer.from(interviewDoc) });
    }

    if (sel.infographic) {
      await setStage(jobId, "infographic", "Generating Infographic", 0, 1);
      const infographicBody = await ask(
        "gpt-4o",
        prompts.infographicTips(infographicTitle || "Infographic", targetAudience || "...", summaryText),
        jobId,
        "Infographic"
      );
      const infographicDoc = await buildSimpleParagraphDoc("Infographic", infographicBody);
      await setProgress(jobId, jobStage("infographic", "Infographic", 1, 1));
      zipEntries.push({ name: `${baseName} - Infographic.docx`, data: Buffer.from(infographicDoc) });
    }

    if (sel.blog) {
      await setStage(jobId, "blog", "Generating Blog Post", 0, 1);
      const combinedText = combinedTextFromRows(rows);
      const blogBody = await ask("gpt-4o", prompts.blogPost(blogTopic || "Blog topic", combinedText), jobId, "Blog post");
      const blogDoc = await buildSimpleParagraphDoc("Blog Post", blogBody);
      await setProgress(jobId, jobStage("blog", "Blog Post", 1, 1));
      zipEntries.push({ name: `${baseName} - Blog Post.docx`, data: Buffer.from(blogDoc) });
    }

    if (zipEntries.length === 0) {
      await failJob(jobId, new Error("At least one output must be selected"));
      return;
    }

    await setStage(jobId, "zip", "Creating ZIP", 0, 1);
    const zip = await makeZip(zipEntries);
    await setStage(jobId, "zip", "Creating ZIP", 1, 1);

    await setStage(jobId, "upload", "Uploading ZIP", 0, 1);

    const out = await put(`outputs/${jobId}-${crypto.randomUUID()}-${baseName}.zip`, zip, {
      access: "public",
      contentType: "application/zip",
    });

    await setStage(jobId, "upload", "Uploading ZIP", 1, 1);

    await patchJob(jobId, {
      status: "done",
      downloadUrl: out.url,
      filename: `${baseName}.zip`,
    });

    // Clean up checkpoint data now that the job is done (they expire in 24 h anyway).
    if (sel.summary || sel.infographic) deleteRowCheckpoints(jobId, "summary").catch((e) => console.warn("Failed to delete summary checkpoints:", e));
    if (sel.quiz) deleteRowCheckpoints(jobId, "quiz").catch((e) => console.warn("Failed to delete quiz checkpoints:", e));
    if (sel.interview) deleteRowCheckpoints(jobId, "interview").catch((e) => console.warn("Failed to delete interview checkpoints:", e));
  } catch (err: unknown) {
    console.error("PROCESS JOB ERROR:", err);
    await failJob(jobId, err);
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Partial<StartBody>;

    if (!body || !ensureString(body.blobUrl)) {
      return new Response(JSON.stringify({ error: "Missing blobUrl" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const jobId = ensureString(body.jobId) ? body.jobId : crypto.randomUUID();

    const defaultSelections: OutputSelections = {
      transcript: true,
      summary: true,
      quiz: true,
      interview: true,
      infographic: true,
      blog: true,
    };
    const selections = body.selections ?? defaultSelections;

    const createdAt = nowISO();
    const initial: JobState = {
      jobId,
      status: "queued",
      createdAt,
      updatedAt: createdAt,
      blobUrl: body.blobUrl,
      baseName: body.baseName ?? "Outputs",
      blogTopic: body.blogTopic ?? "",
      infographicTitle: body.infographicTitle ?? "",
      targetAudience: body.targetAudience ?? "",
      selections,
      stage: jobStage("connected", "Queued", 0, 1),
      progress: progressInit(),
    };

    const existing = await getJob(jobId);

    // Block re-processing only if the job is actively processing AND not stale.
    if (existing?.status === "processing" && !isStuckInProcessing(existing)) {
      return new Response(JSON.stringify({ error: "Job is already processing", jobId }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      });
    }

    await patchJob(jobId, {
      ...initial,
      createdAt: existing?.createdAt ?? initial.createdAt,
    });

    waitUntil(runJob(jobId));

    return new Response(JSON.stringify({ jobId }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: unknown) {
    console.error("PROCESS START ERROR:", err);
    const message = err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);

    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const jobId = searchParams.get("jobId") ?? "";
  const stream = searchParams.get("stream") === "1";

  if (!jobId) {
    return new Response(JSON.stringify({ error: "Missing jobId" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!stream) {
    const state = await getJob(jobId);
    if (!state) {
      return new Response(JSON.stringify({ error: "Job not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(state), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const s = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(sseEvent(event, data)));

      controller.enqueue(encoder.encode(sseRetry(3000)));
      send("stage", { key: "connected", label: "Connected", current: 0, total: 1 });

      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // ignore
        }
      };

      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(sseComment(`ping ${Date.now()}`)));
        } catch {
          close();
        }
      }, 15000);

      let lastSent = "";

      const poll = async () => {
        try {
          const state = await getJob(jobId);

          if (!state) {
            send("server_error", { message: "Job not found", time: nowISO() });
            close();
            return;
          }

          const serialized = JSON.stringify(state);
          if (serialized !== lastSent) {
            lastSent = serialized;

            if (state.stage) send("stage", state.stage);
            if (state.progress) {
              for (const k of Object.keys(state.progress)) {
                send("progress", state.progress[k]);
              }
            }

            if (state.status === "done") {
              send("done", { downloadUrl: state.downloadUrl, filename: state.filename });
              close();
              return;
            }

            if (state.status === "error") {
              send("server_error", state.error ?? { message: "Unknown error", time: nowISO() });
              close();
              return;
            }
          }

          setTimeout(poll, 1000);
        } catch (err: unknown) {
          console.error("SSE POLL ERROR:", err);
          setTimeout(poll, 1500);
        }
      };

      poll();
    },
  });

  return new Response(s, { headers: sseHeaders() });
}

