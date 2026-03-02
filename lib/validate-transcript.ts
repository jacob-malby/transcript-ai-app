/**
 * Validates that raw transcript text matches the expected format.
 * Expected: [timestamp] Speaker Name: text
 *   - [HH:MM:SS] e.g. [00:00:42] David Turner: ...
 *   - or [MM:SS] e.g. [0:15] Marsha Bassily: ...
 *
 * Logic: First check for good format. If not found, check for error patterns.
 *
 * Invalid indicators:
 * 1. Minute markers - square bracket timestamps at every minute (e.g. [0:00], [1:00], [2:00])
 * 2. No timestamps before speakers - lines should start with [time] Speaker:
 */

export type ValidationResult = { valid: true } | { valid: false; error: string };

/** Match [HH:MM:SS] or [MM:SS] followed by speaker - e.g. [00:00:42] David Turner: or [0:15] Marsha: */
const GOOD_FORMAT_REGEX = /\[\d{1,2}:\d{2}(:\d{2})?\]\s+[^:]+:/gm;

/** Match [0:00], [1:00], [12:00] - minute markers (NOT [0:00:00] which has 3 parts) */
const MINUTE_MARKER_REGEX = /\[\d{1,2}:00\](?!:\d{2}\])/g;

export function validateTranscript(rawText: string): ValidationResult {
  const text = rawText.trim();
  if (!text) {
    return { valid: false, error: "The document appears to be empty or could not be read." };
  }

  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) {
    return { valid: false, error: "The document appears to be empty or could not be read." };
  }

  // 1. First check for good format - [timestamp] Speaker Name: (HH:MM:SS or MM:SS)
  const goodFormatMatches = text.match(GOOD_FORMAT_REGEX) ?? [];
  if (goodFormatMatches.length >= 1) {
    return { valid: true };
  }

  // 2. Not valid - determine which error to show
  const minuteMarkers = text.match(MINUTE_MARKER_REGEX) ?? [];
  if (minuteMarkers.length >= 2) {
    return {
      valid: false,
      error: "This transcript uses minute markers ([0:00], [1:00], [2:00]…) which indicates the wrong format. The correct format uses timestamps before each speaker line (e.g. [00:00:42] Speaker Name: text).",
    };
  }

  return {
    valid: false,
    error: "No speaker timestamps found. The transcript should have lines like [00:00:42] Speaker Name: text with timestamps in square brackets before each speaker.",
  };
}
