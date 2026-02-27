import { put } from "@vercel/blob";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file");

    if (!(file instanceof File)) {
      return new Response(JSON.stringify({ error: "Missing file (field name must be 'file')" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!file.name.toLowerCase().endsWith(".docx")) {
      return new Response(JSON.stringify({ error: "Only .docx allowed" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // ✅ PUBLIC store => must use access: "public"
    const blob = await put(`uploads/${crypto.randomUUID()}-${file.name}`, file, {
      access: "public",
    });

    return new Response(JSON.stringify({ blobUrl: blob.url, filename: file.name }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: unknown) {
    console.error("UPLOAD ROUTE ERROR:", err);
    const message = err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);

    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}