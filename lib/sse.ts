// lib/sse.ts

export function sseHeaders() {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  };
}

export function sseEvent(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// Comment lines in SSE are allowed and useful as heartbeat.
export function sseComment(text: string) {
  return `: ${text}\n\n`;
}

// Tells the browser how long (ms) to wait before reconnecting after a dropped connection.
export function sseRetry(ms: number) {
  return `retry: ${ms}\n\n`;
}