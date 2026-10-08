/** Shaping a check command's output for a block reason, which enters the model's context. */

// CSI and OSC escape sequences (colours, cursor moves, hyperlinks).
const ansi = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/** The UTF-8 prefix or suffix of `buffer` of at most `bytes` bytes, never splitting a character. */
function slice(buffer: Buffer, bytes: number, from: "start" | "end"): string {
  let start = from === "start" ? 0 : buffer.length - bytes;
  let end = from === "start" ? bytes : buffer.length;
  // Continuation bytes look like 10xxxxxx: step past them to a character boundary.
  while (from === "end" && start < end && (buffer[start]! & 0xc0) === 0x80) start++;
  while (from === "start" && end > 0 && end < buffer.length && (buffer[end]! & 0xc0) === 0x80) end--;
  return buffer.subarray(start, end).toString("utf8");
}

/**
 * The output with escape codes removed, cut to at most about `budget` bytes.
 * Long output keeps its start (first errors) and end (summary) around a marker.
 */
export function truncateOutput(output: string, budget: number): string {
  const clean = output.replace(ansi, "").replace(/\r\n/g, "\n").trim();
  const buffer = Buffer.from(clean, "utf8");
  if (buffer.length <= budget) return clean;
  const half = Math.floor(budget / 2);
  const head = slice(buffer, half, "start");
  const tail = slice(buffer, half, "end");
  const omitted = buffer.length - Buffer.byteLength(head) - Buffer.byteLength(tail);
  return `${head}\n[... ${omitted} bytes omitted ...]\n${tail}`;
}
