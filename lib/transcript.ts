// lib/transcript.ts
export type TranscriptRow = { time: string; speaker: string; text: string };

function initialsWithColon(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const initials = parts.map(p => p[0]?.toUpperCase() ?? "").join("");
  return initials ? `${initials}:` : "SPK:";
}

export function parseTranscript(rawText: string): TranscriptRow[] {
  const lines = rawText
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  const rows: TranscriptRow[] = [];
  let buffer: string[] = [];
  let currentTime = "";
  let currentSpeaker = "";

  const flush = () => {
    if (!buffer.length) return;
    rows.push({
      time: currentTime,
      speaker: currentSpeaker,
      text: buffer.join(" ").replace(/\s+/g, " ").trim(),
    });
    buffer = [];
  };

  for (const line of lines) {
    const m = line.match(/^\[(.+?)\]\s*(.*)$/);
    if (m) {
      flush();
      currentTime = m[1] ?? "";
      const rest = m[2] ?? "";
      const parts = rest.split(/:\s+/, 2);
      if (parts.length === 2) {
        currentSpeaker = initialsWithColon(parts[0] ?? "");
        buffer.push(parts[1] ?? "");
      } else {
        currentSpeaker = initialsWithColon(parts[0] ?? "");
      }
    } else {
      buffer.push(line);
    }
  }

  flush();
  return rows;
}

export function combinedTextFromRows(rows: TranscriptRow[]) {
  return rows.map(r => r.text).join("\n");
}