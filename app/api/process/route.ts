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
  JobState,
  JobProgressItem,
  OutputSelections,
} from "@/lib/redis";

export const runtime = "nodejs";

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

async function runJob(jobId: string) {
  const state = await getJob(jobId);
  if (!state) return;

  if (state.status === "done") return;
  if (state.status === "processing") return;

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
      const quizItems: { q: string; wrong: string; torf: string }[] = [];
      for (let i = 0; i < loopRows.length; i++) {
        const text = loopRows[i].text;
        if (text.length > 50) {
          const q = await ask("gpt-4o", prompts.quizQuestion(text), jobId, `Quiz question ${i + 1}/${totalRows}`);
          const torf = await ask("gpt-4o", prompts.quizTorF(text), jobId, `True/False ${i + 1}/${totalRows}`);
          const wrong = await ask("gpt-4o", prompts.quizWrongAnswers(q), jobId, `Wrong answers ${i + 1}/${totalRows}`);
          quizItems.push({ q, torf, wrong });
        }
        await setProgress(jobId, jobStage("quiz", "Quiz Questions", i + 1, totalRows));
      }
      const quizDoc = await buildQuizDoc(quizItems);
      zipEntries.push({ name: `${baseName} - Quiz Questions.docx`, data: Buffer.from(quizDoc) });
    }

    let summaryText = "";
    if (sel.summary || sel.infographic) {
      await setStage(jobId, "summary", "Generating Summary", 0, 1);
      const summaryLines: string[] = [];
      for (let i = 0; i < loopRows.length; i++) {
        const text = loopRows[i].text;
        if (text.length > 50) {
          const s = await ask("gpt-4o-mini", prompts.summarize2Sentences(text), jobId, `Summary ${i + 1}/${totalRows}`);
          summaryLines.push(s);
        }
        await setProgress(jobId, jobStage("summary", "Summary", i + 1, totalRows));
      }
      summaryText = summaryLines.join("\n");
      if (sel.summary) {
        const summaryDoc = await buildSummaryDoc(summaryLines);
        zipEntries.push({ name: `${baseName} - Summary.docx`, data: Buffer.from(summaryDoc) });
      }
    }

    if (sel.interview) {
      await setStage(jobId, "interview", "Generating Virtual Interview", 0, 1);
      const interviewItems: { question: string; summary: string }[] = [];
      for (let i = 0; i < loopRows.length; i++) {
        const text = loopRows[i].text;
        if (text.length > 50) {
          const question = await ask("gpt-4o-mini", prompts.interviewQuestion(text), jobId, `Interview question ${i + 1}/${totalRows}`);
          const summary = await ask(
            "gpt-4o-mini",
            prompts.interviewSummaryFromQuestion(question, text),
            jobId,
            `Interview summary ${i + 1}/${totalRows}`
          );
          interviewItems.push({ question, summary });
        }
        await setProgress(jobId, jobStage("interview", "Virtual Interview", i + 1, totalRows));
      }
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
    if (existing?.status === "processing") {
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