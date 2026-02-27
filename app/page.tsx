"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useDropzone } from "react-dropzone";
import {
  UploadCloud,
  FileText,
  Sparkles,
  CheckCircle2,
  Loader2,
  Download,
  PenLine,
  ClipboardList,
  Presentation,
  Users,
  BookOpen,
  Mail,
} from "lucide-react";

type Progress = {
  label: string;
  current: number;
  total: number;
};

function pct(current: number, total: number) {
  if (!total) return 0;
  return Math.max(0, Math.min(100, Math.round((current / total) * 100)));
}

const EMAIL_SUGGESTIONS = ["taylor.harding@htlp.com.au", "jacob.malby@htlp.com.au"] as const;

const LS_KEY = "transcript-ai:lastJob";

type LastJob = {
  jobId: string;
  email: string;
  baseName: string;
  blogTopic: string;
  infographicTitle: string;
  targetAudience: string;
  blobUrl?: string | null;
  createdAt: string;
};

function isValidEmail(v: string) {
  if (!v) return false;
  // Simple, pragmatic validation
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
}

export default function Page() {
  const [file, setFile] = useState<File | null>(null);

  const [email, setEmail] = useState<string>(EMAIL_SUGGESTIONS[0]);

  const [baseName, setBaseName] = useState("Episode Outputs");
  const [blogTopic, setBlogTopic] = useState("");
  const [infographicTitle, setInfographicTitle] = useState("");
  const [targetAudience, setTargetAudience] = useState("");

  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  const [running, setRunning] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);

  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [statusText, setStatusText] = useState<string>("");

  const [progress, setProgress] = useState<Record<string, Progress>>({});
  const progressList = useMemo(() => Object.entries(progress), [progress]);

  const esRef = useRef<EventSource | null>(null);
  const downloadedOnceRef = useRef(false);

  const onDrop = (accepted: File[]) => {
    const f = accepted[0];
    if (f) {
      // New file = new run
      setFile(f);
      setBlobUrl(null);
      setDownloadUrl(null);
      setProgress({});
      setStatusText("File selected. Ready to generate.");
      setRunning(false);
      setJobId(null);
      downloadedOnceRef.current = false;

      // Kill any previous SSE
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }

      // Clear last job since we’re starting over with a new file
      localStorage.removeItem(LS_KEY);
    }
  };

  const { getRootProps, getInputProps, isDragActive, fileRejections } = useDropzone({
    onDrop,
    multiple: false,
    accept: {
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
    },
  });

  async function upload(): Promise<{ blobUrl: string; filename: string; jobId?: string } | null> {
    if (!file) return null;

    setStatusText("Uploading transcript…");

    const fd = new FormData();
    fd.append("file", file);

    const res = await fetch("/api/upload", { method: "POST", body: fd });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error("Upload failed:", res.status, res.statusText, text);
      throw new Error(`Upload failed (${res.status}) ${text}`);
    }

    const json = await res.json();
    setBlobUrl(json.blobUrl);
    setStatusText("Upload complete.");
    return json as { blobUrl: string; filename: string; jobId?: string };
  }

  function saveLastJob(next: LastJob) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  }

  function loadLastJob(): LastJob | null {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      return JSON.parse(raw) as LastJob;
    } catch {
      return null;
    }
  }

  async function startJob(url: string, preferredJobId?: string) {
    setStatusText("Starting server job…");

    const body = {
      jobId: preferredJobId, // optional
      blobUrl: url,
      baseName,
      blogTopic,
      infographicTitle,
      targetAudience,
      // NOTE: The server currently ignores email unless you add it to the job state.
      // We'll keep sending it so it's ready when you add server-side email later.
      email: email.trim(),
    };

    const res = await fetch("/api/process", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Failed to start job (${res.status}) ${text}`);
    }

    const json = await res.json();
    if (!json?.jobId) throw new Error("Server did not return a jobId");
    return String(json.jobId) as string;
  }

  function closeStream() {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
  }

  function connectStream(jobIdToUse: string) {
    closeStream();

    const es = new EventSource(`/api/process?jobId=${encodeURIComponent(jobIdToUse)}&stream=1`);
    esRef.current = es;

    es.onopen = () => {
      setStatusText("Connected. Processing…");
    };

    es.onerror = () => {
      // EventSource errors can be transient; keep UI calm unless a server_error arrives.
      console.error("SSE connection issue; readyState=", es.readyState);
    };

    es.addEventListener("stage", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        if (data?.label) setStatusText(String(data.label));
      } catch {
        // ignore
      }
    });

    es.addEventListener("progress", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        if (!data?.key) return;
        setProgress((prev) => ({
          ...prev,
          [data.key]: { label: data.label, current: data.current, total: data.total },
        }));
      } catch {
        // ignore
      }
    });

    es.addEventListener("server_error", (e: MessageEvent) => {
      console.error("Server error raw event.data:", e.data);
      try {
        const data = JSON.parse(e.data);
        console.error("Server error parsed:", data);
        setStatusText(`Server error: ${data.message ?? "Unknown error"}`);
        alert(`Server error: ${data.message ?? "Unknown error"}`);
      } catch {
        setStatusText("Server error (see console)");
        alert("Server error (see console)");
      }
      closeStream();
      setRunning(false);
    });

    es.addEventListener("done", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        const dl = String(data.downloadUrl || "");
        const fn = String(data.filename || "Outputs.zip");

        if (dl) {
          setDownloadUrl(dl);
          setStatusText("Done! Downloading ZIP…");

          // Download immediately if tab is open and we haven't already done so.
          if (!downloadedOnceRef.current) {
            downloadedOnceRef.current = true;
            const a = document.createElement("a");
            a.href = dl;
            a.download = fn;
            document.body.appendChild(a);
            a.click();
            a.remove();
          }

          setStatusText("All done. If the download didn’t start, use the button below.");
        } else {
          setStatusText("Done, but missing download URL.");
        }
      } catch (err) {
        console.error("done event parse error:", err);
        setStatusText("Done, but failed to parse result.");
      }

      closeStream();
      setRunning(false);
    });
  }

  async function fetchJobState(jobIdToUse: string) {
    const res = await fetch(`/api/process?jobId=${encodeURIComponent(jobIdToUse)}`, {
      method: "GET",
      headers: { "Accept": "application/json" },
    });

    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    return json as any;
  }

  async function resumeIfPossible() {
    const last = loadLastJob();
    if (!last?.jobId) return;

    setJobId(last.jobId);
    setEmail(last.email || EMAIL_SUGGESTIONS[0]);
    setBaseName(last.baseName || "Episode Outputs");
    setBlogTopic(last.blogTopic || "");
    setInfographicTitle(last.infographicTitle || "");
    setTargetAudience(last.targetAudience || "");
    setBlobUrl(last.blobUrl ?? null);

    setStatusText("Resuming previous job…");

    // Try to pull current state
    const state = await fetchJobState(last.jobId);
    if (!state) {
      setStatusText("Previous job not found (it may have expired).");
      localStorage.removeItem(LS_KEY);
      return;
    }

    // Hydrate progress if available
    if (state.progress && typeof state.progress === "object") {
      const p: Record<string, Progress> = {};
      for (const k of Object.keys(state.progress)) {
        const it = state.progress[k];
        if (it?.key) {
          p[it.key] = { label: it.label, current: it.current, total: it.total };
        }
      }
      setProgress(p);
    }

    if (state.status === "done") {
      setRunning(false);
      setDownloadUrl(state.downloadUrl ?? null);
      setStatusText("Job complete. Download ready.");

      // If user reopened the tab after completion, auto-download once.
      if (state.downloadUrl && !downloadedOnceRef.current) {
        downloadedOnceRef.current = true;
        const a = document.createElement("a");
        a.href = state.downloadUrl;
        a.download = state.filename || "Outputs.zip";
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
      return;
    }

    if (state.status === "error") {
      setRunning(false);
      setStatusText(`Server error: ${state?.error?.message ?? "Unknown error"}`);
      return;
    }

    // Otherwise, still processing — connect stream
    setRunning(true);
    connectStream(last.jobId);
  }

  useEffect(() => {
    // Attempt resume on first load
    resumeIfPossible();

    return () => {
      closeStream();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function start() {
    if (!file) return;

    if (!isValidEmail(email)) {
      alert("Please enter a valid email address.");
      return;
    }

    setRunning(true);
    setDownloadUrl(null);
    setProgress({});
    downloadedOnceRef.current = false;

    try {
      const uploadResult = blobUrl ? { blobUrl } : await upload();
      const url = uploadResult?.blobUrl;
      if (!url) throw new Error("Missing blobUrl after upload");

      // Prefer using the jobId returned by upload route (optional), else generate in /api/process.
      const preferredJobId = (uploadResult as any)?.jobId as string | undefined;

      const newJobId = await startJob(url, preferredJobId);
      setJobId(newJobId);

      // Persist job so the user can close the tab and resume later
      saveLastJob({
        jobId: newJobId,
        email: email.trim(),
        baseName,
        blogTopic,
        infographicTitle,
        targetAudience,
        blobUrl: url,
        createdAt: new Date().toISOString(),
      });

      setStatusText("Job started. Processing…");

      // Connect to SSE for live progress
      connectStream(newJobId);
    } catch (err: any) {
      console.error(err);
      setStatusText(err?.message ?? "Something went wrong");
      setRunning(false);
      closeStream();
    }
  }

  const hasFile = !!file;
  const rejected = fileRejections?.length > 0;

  return (
    <main style={{ minHeight: "100vh", background: "linear-gradient(135deg, #0b3a7a 0%, #0ea5e9 45%, #60a5fa 100%)" }}>
      <div style={{ maxWidth: 980, margin: "0 auto", padding: "44px 18px 80px" }}>
        {/* Header */}
        <header style={{ color: "white", marginBottom: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: 14,
                background: "rgba(255,255,255,0.18)",
                display: "grid",
                placeItems: "center",
                boxShadow: "0 10px 24px rgba(0,0,0,0.18)",
                backdropFilter: "blur(10px)",
              }}
            >
              <Sparkles size={22} />
            </div>
            <div>
              <h1 style={{ fontSize: 30, fontWeight: 800, margin: 0, letterSpacing: -0.2 }}>
                Transcript → AI Word Docs
              </h1>
              <p style={{ margin: "6px 0 0", opacity: 0.92 }}>
                Drop a .docx transcript, fill the fields, and generate a ZIP of all outputs.
              </p>
            </div>
          </div>

          {/* Status chip */}
          <div style={{ marginTop: 14, display: "flex", gap: 10, flexWrap: "wrap" }}>
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 12px",
                borderRadius: 999,
                background: "rgba(255,255,255,0.18)",
                border: "1px solid rgba(255,255,255,0.25)",
                backdropFilter: "blur(10px)",
              }}
            >
              {running ? <Loader2 size={16} className="spin" /> : downloadUrl ? <CheckCircle2 size={16} /> : <UploadCloud size={16} />}
              <span style={{ fontSize: 13, fontWeight: 600 }}>
                {statusText || (hasFile ? "File selected. Ready to generate." : "Waiting for a .docx transcript…")}
              </span>
            </div>

            {downloadUrl && (
              <a
                href={downloadUrl}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "8px 12px",
                  borderRadius: 999,
                  background: "rgba(255,255,255,0.95)",
                  color: "#0b3a7a",
                  textDecoration: "none",
                  fontSize: 13,
                  fontWeight: 800,
                  boxShadow: "0 10px 22px rgba(0,0,0,0.18)",
                }}
              >
                <Download size={16} />
                Download ZIP
              </a>
            )}
          </div>
        </header>

        {/* Main card */}
        <div
          style={{
            borderRadius: 20,
            background: "rgba(255,255,255,0.92)",
            boxShadow: "0 22px 60px rgba(0,0,0,0.22)",
            overflow: "hidden",
          }}
        >
          {/* Top grid */}
          <div style={{ display: "grid", gridTemplateColumns: "1.1fr 1fr", gap: 0 }}>
            {/* Left: Upload */}
            <section style={{ padding: 18, borderRight: "1px solid rgba(0,0,0,0.06)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                <div
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 12,
                    background: "#e0f2fe",
                    display: "grid",
                    placeItems: "center",
                  }}
                >
                  <UploadCloud size={18} color="#0369a1" />
                </div>
                <div>
                  <div style={{ fontWeight: 900, color: "#0f172a" }}>Upload transcript</div>
                  <div style={{ fontSize: 12, color: "#475569" }}>Only .docx is supported</div>
                </div>
              </div>

              <div
                {...getRootProps()}
                style={{
                  border: `2px dashed ${isDragActive ? "#0284c7" : "#94a3b8"}`,
                  background: isDragActive ? "#e0f2fe" : "#f8fafc",
                  borderRadius: 16,
                  padding: 18,
                  cursor: "pointer",
                  transition: "all 120ms ease",
                }}
              >
                <input {...getInputProps()} />

                <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
                  <div
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: 14,
                      background: "white",
                      display: "grid",
                      placeItems: "center",
                      border: "1px solid rgba(0,0,0,0.08)",
                    }}
                  >
                    <FileText size={20} color="#0b3a7a" />
                  </div>

                  <div style={{ flex: 1 }}>
                    {!file ? (
                      <>
                        <div style={{ fontWeight: 800, color: "#0f172a", marginBottom: 6 }}>
                          {isDragActive ? "Drop the .docx here" : "Drag & drop your transcript"}
                        </div>
                        <div style={{ fontSize: 13, color: "#475569" }}>
                          Or click to browse and select a file.
                        </div>
                      </>
                    ) : (
                      <>
                        <div style={{ fontWeight: 900, color: "#0f172a", marginBottom: 6 }}>
                          File ready
                        </div>
                        <div style={{ fontSize: 13, color: "#334155", display: "flex", alignItems: "center", gap: 8 }}>
                          <CheckCircle2 size={16} color="#16a34a" />
                          <span style={{ fontWeight: 700 }}>{file.name}</span>
                        </div>
                        <div style={{ marginTop: 8, fontSize: 12, color: "#64748b" }}>
                          Drop a different file anytime to reset.
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </div>

              {rejected && (
                <div style={{ marginTop: 10, color: "#b91c1c", fontSize: 13, fontWeight: 700 }}>
                  Please upload a .docx file.
                </div>
              )}

              {/* Generate button */}
              <button
                onClick={start}
                disabled={!file || running || !isValidEmail(email)}
                style={{
                  marginTop: 14,
                  width: "100%",
                  padding: "12px 14px",
                  borderRadius: 14,
                  border: "1px solid rgba(2, 132, 199, 0.35)",
                  background: !file || running || !isValidEmail(email) ? "#e2e8f0" : "linear-gradient(135deg, #0284c7, #0ea5e9)",
                  color: !file || running || !isValidEmail(email) ? "#64748b" : "white",
                  fontWeight: 900,
                  cursor: !file || running || !isValidEmail(email) ? "not-allowed" : "pointer",
                  boxShadow: !file || running || !isValidEmail(email) ? "none" : "0 14px 30px rgba(2,132,199,0.28)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 10,
                }}
              >
                {running ? (
                  <>
                    <Loader2 size={18} className="spin" />
                    Generating…
                  </>
                ) : (
                  <>
                    <Sparkles size={18} />
                    Generate docs
                  </>
                )}
              </button>

              {/* Download button */}
              {downloadUrl && (
                <a
                  href={downloadUrl}
                  style={{
                    marginTop: 10,
                    width: "100%",
                    padding: "12px 14px",
                    borderRadius: 14,
                    border: "1px solid rgba(15, 23, 42, 0.10)",
                    background: "white",
                    color: "#0f172a",
                    fontWeight: 900,
                    textDecoration: "none",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 10,
                  }}
                >
                  <Download size={18} />
                  Download ZIP
                </a>
              )}

              {/* Resume chip */}
              {jobId && !running && !downloadUrl && (
                <div
                  style={{
                    marginTop: 10,
                    padding: "10px 12px",
                    borderRadius: 14,
                    background: "#f8fafc",
                    border: "1px solid rgba(0,0,0,0.06)",
                    color: "#334155",
                    fontSize: 12,
                    fontWeight: 800,
                  }}
                >
                  Saved job: <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>{jobId}</span>
                </div>
              )}
            </section>

            {/* Right: Inputs */}
            <section style={{ padding: 18 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                <div
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 12,
                    background: "#dbeafe",
                    display: "grid",
                    placeItems: "center",
                  }}
                >
                  <PenLine size={18} color="#1d4ed8" />
                </div>
                <div>
                  <div style={{ fontWeight: 900, color: "#0f172a" }}>Episode details</div>
                  <div style={{ fontSize: 12, color: "#475569" }}>These power the blog + infographic prompts</div>
                </div>
              </div>

              <div style={{ display: "grid", gap: 12 }}>
                {/* Email */}
                <EmailField
                  value={email}
                  onChange={setEmail}
                  disabled={!hasFile || running}
                />

                <Field
                  icon={<ClipboardList size={16} color="#0b3a7a" />}
                  label="Output base name"
                  hint="Used to name files inside the ZIP"
                  value={baseName}
                  onChange={setBaseName}
                  placeholder="e.g. Episode 12"
                  disabled={!hasFile || running}
                />

                <Field
                  icon={<BookOpen size={16} color="#0b3a7a" />}
                  label="Blog topic"
                  hint="Short topic/title for the generated blog post"
                  value={blogTopic}
                  onChange={setBlogTopic}
                  placeholder="e.g. Ethics & confidentiality in practice"
                  disabled={!hasFile || running}
                />

                <Field
                  icon={<Presentation size={16} color="#0b3a7a" />}
                  label="Infographic title"
                  hint="Shown at the top of the infographic content"
                  value={infographicTitle}
                  onChange={setInfographicTitle}
                  placeholder="e.g. 5 takeaways for busy lawyers"
                  disabled={!hasFile || running}
                />

                <Field
                  icon={<Users size={16} color="#0b3a7a" />}
                  label="Target audience"
                  hint="Finish the sentence: “lawyers who…”"
                  value={targetAudience}
                  onChange={setTargetAudience}
                  placeholder="e.g. work in commercial litigation and need practical tips"
                  disabled={!hasFile || running}
                />
              </div>

              {!hasFile && (
                <div
                  style={{
                    marginTop: 14,
                    padding: 12,
                    borderRadius: 14,
                    background: "#f1f5f9",
                    border: "1px solid rgba(0,0,0,0.06)",
                    color: "#475569",
                    fontSize: 13,
                    fontWeight: 700,
                  }}
                >
                  Upload a transcript to enable these fields.
                </div>
              )}

              {hasFile && !isValidEmail(email) && (
                <div style={{ marginTop: 10, color: "#b91c1c", fontSize: 13, fontWeight: 800 }}>
                  Please enter a valid email address (used for delivery if the tab is closed).
                </div>
              )}
            </section>
          </div>

          {/* Progress section */}
          <section style={{ padding: 18, borderTop: "1px solid rgba(0,0,0,0.06)", background: "#ffffff" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 12,
                    background: "#ecfeff",
                    display: "grid",
                    placeItems: "center",
                  }}
                >
                  <Sparkles size={18} color="#0891b2" />
                </div>
                <div>
                  <div style={{ fontWeight: 900, color: "#0f172a" }}>Generation progress</div>
                  <div style={{ fontSize: 12, color: "#475569" }}>
                    Each output updates live while it’s being created.
                  </div>
                </div>
              </div>

              {running && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#0f172a", fontWeight: 800 }}>
                  <Loader2 size={16} className="spin" />
                  Working…
                </div>
              )}
            </div>

            {progressList.length === 0 ? (
              <div style={{ marginTop: 12, padding: 14, borderRadius: 14, background: "#f8fafc", color: "#64748b", fontWeight: 700 }}>
                No progress yet. Upload a transcript and click <b>Generate docs</b>.
              </div>
            ) : (
              <div style={{ marginTop: 14, display: "grid", gap: 10 }}>
                {progressList.map(([key, p]) => (
                  <ProgressCard key={key} label={p.label} current={p.current} total={p.total} />
                ))}
              </div>
            )}
          </section>
        </div>

        {/* Small CSS for spinner */}
        <style>{`
          .spin { animation: spin 1s linear infinite; }
          @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        `}</style>
      </div>
    </main>
  );
}

function EmailField(props: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const valid = isValidEmail(props.value);

  return (
    <label style={{ display: "grid", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            style={{
              width: 30,
              height: 30,
              borderRadius: 12,
              background: "#f1f5f9",
              display: "grid",
              placeItems: "center",
              border: "1px solid rgba(0,0,0,0.06)",
            }}
          >
            <Mail size={16} color="#0b3a7a" />
          </span>
          <span style={{ fontWeight: 900, color: "#0f172a" }}>Email</span>
        </div>
        <span style={{ fontSize: 12, color: valid ? "#16a34a" : "#64748b", fontWeight: 800 }}>
          {valid ? "Looks good" : "Used if tab closes"}
        </span>
      </div>

      <input
        list="email-suggestions"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder="name@company.com"
        disabled={props.disabled}
        style={{
          width: "100%",
          padding: "12px 12px",
          borderRadius: 14,
          border: `1px solid ${valid ? "rgba(15,23,42,0.12)" : "rgba(185,28,28,0.35)"}`,
          background: props.disabled ? "#e2e8f0" : "white",
          color: props.disabled ? "#64748b" : "#0f172a",
          outline: "none",
          fontWeight: 700,
          boxShadow: "0 8px 18px rgba(2, 132, 199, 0.06)",
        }}
      />

      <datalist id="email-suggestions">
        {EMAIL_SUGGESTIONS.map((e) => (
          <option key={e} value={e} />
        ))}
      </datalist>
    </label>
  );
}

function Field(props: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  value: string;
  placeholder?: string;
  disabled?: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <label style={{ display: "grid", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            style={{
              width: 30,
              height: 30,
              borderRadius: 12,
              background: "#f1f5f9",
              display: "grid",
              placeItems: "center",
              border: "1px solid rgba(0,0,0,0.06)",
            }}
          >
            {props.icon}
          </span>
          <span style={{ fontWeight: 900, color: "#0f172a" }}>{props.label}</span>
        </div>
        <span style={{ fontSize: 12, color: "#64748b", fontWeight: 700 }}>{props.hint}</span>
      </div>

      <input
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        disabled={props.disabled}
        style={{
          width: "100%",
          padding: "12px 12px",
          borderRadius: 14,
          border: "1px solid rgba(15,23,42,0.12)",
          background: props.disabled ? "#e2e8f0" : "white",
          color: props.disabled ? "#64748b" : "#0f172a",
          outline: "none",
          fontWeight: 700,
          boxShadow: "0 8px 18px rgba(2, 132, 199, 0.06)",
        }}
      />
    </label>
  );
}

function ProgressCard(props: { label: string; current: number; total: number }) {
  const percent = pct(props.current, props.total);
  const done = props.total > 0 && props.current >= props.total;

  return (
    <div
      style={{
        border: "1px solid rgba(15,23,42,0.08)",
        borderRadius: 16,
        padding: 12,
        background: done ? "#f0fdf4" : "#f8fafc",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div style={{ fontWeight: 900, color: "#0f172a", display: "flex", alignItems: "center", gap: 8 }}>
          {done ? <CheckCircle2 size={16} color="#16a34a" /> : <Loader2 size={16} className="spin" />}
          {props.label}
        </div>
        <div style={{ fontWeight: 900, color: "#0f172a" }}>{percent}%</div>
      </div>

      <div style={{ marginTop: 10, height: 10, borderRadius: 999, background: "rgba(15,23,42,0.10)", overflow: "hidden" }}>
        <div
          style={{
            width: `${percent}%`,
            height: "100%",
            borderRadius: 999,
            background: done ? "linear-gradient(90deg, #16a34a, #22c55e)" : "linear-gradient(90deg, #0284c7, #0ea5e9)",
            transition: "width 140ms ease",
          }}
        />
      </div>

      <div style={{ marginTop: 8, color: "#334155", fontWeight: 800, fontSize: 12 }}>
        {props.current} / {props.total}
      </div>
    </div>
  );
}