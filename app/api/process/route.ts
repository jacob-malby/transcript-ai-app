import mammoth from "mammoth";
import { put } from "@vercel/blob";
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
import { sseEvent, sseHeaders } from "@/lib/sse";

export const runtime = "nodejs";

async function ask(model: string, input: string) {
  const r = await openai.responses.create({
    model,
    input,
  });
  return r.output_text?.trim() ?? "";
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);

  const blobUrl = searchParams.get("blobUrl");
  const baseName = searchParams.get("baseName") ?? "Outputs";
  const blogTopic = searchParams.get("blogTopic") ?? "";
  const infographicTitle = searchParams.get("infographicTitle") ?? "";
  const targetAudience = searchParams.get("targetAudience") ?? "";

  if (!blobUrl) return new Response("Missing blobUrl", { status: 400 });

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(sseEvent(event, data)));

      // ✅ Immediately notify client the stream is alive
      send("stage", { key: "connected", label: "Connected", current: 0, total: 1 });

      // ✅ Heartbeat every 15s to prevent buffering/timeouts
      const heartbeat = setInterval(() => {
        controller.enqueue(encoder.encode(`: ping ${Date.now()}\n\n`));
      }, 15000);

      try {
        send("stage", { key: "download", label: "Downloading transcript", current: 0, total: 1 });

        const fileRes = await fetch(blobUrl);
        if (!fileRes.ok) {
          throw new Error(`Failed to fetch transcript: ${fileRes.status} ${fileRes.statusText}`);
        }

        const arrayBuffer = await fileRes.arrayBuffer();
        const buf = Buffer.from(arrayBuffer);

        send("stage", { key: "extract", label: "Extracting text", current: 0, total: 1 });

        // ✅ Mammoth in Node expects { buffer: Buffer }
        const extracted = await mammoth.extractRawText({ buffer: buf });
        const rawText = extracted.value ?? "";

        send("stage", { key: "parse", label: "Parsing transcript", current: 0, total: 1 });

        const rows = parseTranscript(rawText);
        const loopRows = rows.filter((r) => (r.speaker || "").toUpperCase().indexOf("DT") === -1);
        const totalRows = loopRows.length || 1;

        // ✅ Initialize progress bars immediately
        send("progress", { key: "transcript", label: "Transcript Table", current: 0, total: 1 });
        send("progress", { key: "quiz", label: "Quiz Questions", current: 0, total: totalRows });
        send("progress", { key: "summary", label: "Summary", current: 0, total: totalRows });
        send("progress", { key: "interview", label: "Virtual Interview", current: 0, total: totalRows });
        send("progress", { key: "infographic", label: "Infographic", current: 0, total: 1 });
        send("progress", { key: "blog", label: "Blog Post", current: 0, total: 1 });

        // 1) Transcript table
        const transcriptDoc = await buildTranscriptTableDoc(rows);
        send("progress", { key: "transcript", label: "Transcript Table", current: 1, total: 1 });

        // 2) Quiz questions
        const quizItems: { q: string; wrong: string; torf: string }[] = [];
        for (let i = 0; i < loopRows.length; i++) {
          const text = loopRows[i].text;
          if (text.length > 50) {
            const q = await ask("gpt-4o", prompts.quizQuestion(text));
            const torf = await ask("gpt-4o", prompts.quizTorF(text));
            const wrong = await ask("gpt-4o", prompts.quizWrongAnswers(q));
            quizItems.push({ q, torf, wrong });
          }
          send("progress", { key: "quiz", label: "Quiz Questions", current: i + 1, total: totalRows });
        }
        const quizDoc = await buildQuizDoc(quizItems);

        // 3) Summary
        const summaryLines: string[] = [];
        for (let i = 0; i < loopRows.length; i++) {
          const text = loopRows[i].text;
          if (text.length > 50) {
            const s = await ask("gpt-4o-mini", prompts.summarize2Sentences(text));
            summaryLines.push(s);
          }
          send("progress", { key: "summary", label: "Summary", current: i + 1, total: totalRows });
        }
        const summaryDoc = await buildSummaryDoc(summaryLines);
        const summaryText = summaryLines.join("\n");

        // 4) Virtual Interview
        const interviewItems: { question: string; summary: string }[] = [];
        for (let i = 0; i < loopRows.length; i++) {
          const text = loopRows[i].text;
          if (text.length > 50) {
            const question = await ask("gpt-4o-mini", prompts.interviewQuestion(text));
            const summary = await ask("gpt-4o-mini", prompts.interviewSummaryFromQuestion(question, text));
            interviewItems.push({ question, summary });
          }
          send("progress", { key: "interview", label: "Virtual Interview", current: i + 1, total: totalRows });
        }
        const interviewDoc = await buildVirtualInterviewDoc(interviewItems);

        // 5) Infographic
        const infographicBody = await ask(
          "gpt-4o",
          prompts.infographicTips(infographicTitle || "Infographic", targetAudience || "...", summaryText)
        );
        const infographicDoc = await buildSimpleParagraphDoc("Infographic", infographicBody);
        send("progress", { key: "infographic", label: "Infographic", current: 1, total: 1 });

        // 6) Blog Post
        const combinedText = combinedTextFromRows(rows);
        const blogBody = await ask("gpt-4o", prompts.blogPost(blogTopic || "Blog topic", combinedText));
        const blogDoc = await buildSimpleParagraphDoc("Blog Post", blogBody);
        send("progress", { key: "blog", label: "Blog Post", current: 1, total: 1 });

        // Zip + upload
        send("stage", { key: "zip", label: "Creating ZIP", current: 0, total: 1 });

        const zip = await makeZip([
          { name: `${baseName} - Transcript Table.docx`, data: Buffer.from(transcriptDoc) },
          { name: `${baseName} - Quiz Questions.docx`, data: Buffer.from(quizDoc) },
          { name: `${baseName} - Summary.docx`, data: Buffer.from(summaryDoc) },
          { name: `${baseName} - Virtual Interview.docx`, data: Buffer.from(interviewDoc) },
          { name: `${baseName} - Infographic.docx`, data: Buffer.from(infographicDoc) },
          { name: `${baseName} - Blog Post.docx`, data: Buffer.from(blogDoc) },
        ]);

        const out = await put(`outputs/${crypto.randomUUID()}-${baseName}.zip`, zip, {
          access: "public",
          contentType: "application/zip",
        });

        send("stage", { key: "zip", label: "Creating ZIP", current: 1, total: 1 });
        send("done", { downloadUrl: out.url, filename: `${baseName}.zip` });

        clearInterval(heartbeat);
        controller.close();
      } catch (err: unknown) {
        console.error("PROCESS ROUTE ERROR:", err);

        const message =
          err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);
        const stack = err instanceof Error ? err.stack ?? "" : "";

        send("server_error", {
          message,
          stack,
          time: new Date().toISOString(),
        });

        clearInterval(heartbeat);
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: sseHeaders() });
}