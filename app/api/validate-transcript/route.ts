import mammoth from "mammoth";
import { validateTranscript } from "@/lib/validate-transcript";

export const runtime = "nodejs";

/**
 * POST /api/validate-transcript
 * Accepts a .docx file, extracts text, validates format.
 * Returns { valid: true } or { valid: false, error: string }
 */
export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file");

    if (!(file instanceof File)) {
      return new Response(
        JSON.stringify({ valid: false, error: "Missing file (field name must be 'file')" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    if (!file.name.toLowerCase().endsWith(".docx")) {
      return new Response(
        JSON.stringify({ valid: false, error: "Only .docx files are supported." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const buf = Buffer.from(arrayBuffer);
    const extracted = await mammoth.extractRawText({ buffer: buf });
    const rawText = extracted.value ?? "";

    const result = validateTranscript(rawText);

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: unknown) {
    console.error("VALIDATE TRANSCRIPT ERROR:", err);
    const message =
      err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);
    return new Response(
      JSON.stringify({
        valid: false,
        error: `Could not read document: ${message}`,
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
