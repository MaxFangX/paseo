import type { Dirent, Stats } from "node:fs";
import { open, readdir, stat, type FileHandle } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import { responseCost, UsageSchema } from "./prices.js";

/**
 * PATCH(usage-spend-share): what each Claude Code session spent, read from its transcripts under
 * `<claude home>/projects`. A session is `<project>/<sessionId>.jsonl`; its subagents write
 * `<project>/<sessionId>/subagents/*.jsonl`, whose lines carry the parent's `sessionId`.
 *
 * Reads only usage fields. Transcripts reach hundreds of MB, so files are streamed, and a later
 * scan reads only the bytes appended since the last one.
 */

export interface SpendPoint {
  timestampMs: number;
  /** USD at API list prices. */
  cost: number;
}

export interface ScanStats {
  /** Transcripts modified since the scan's start. */
  files: number;
  /** Bytes read, appended or re-read. */
  bytes: number;
}

const AssistantLineSchema = z.object({
  type: z.literal("assistant"),
  timestamp: z.string(),
  sessionId: z.string().min(1).optional(),
  /** Set on a line a forked session copied from its source; the source counts it. */
  forkedFrom: z.unknown().optional(),
  message: z.object({ id: z.string().min(1), model: z.string(), usage: UsageSchema }),
});

/** Every response's line has this; parsing the rest would cost far more than the search. */
const ASSISTANT_MARKER = Buffer.from('"type":"assistant"');
const NEWLINE = 0x0a;
/** A first scan reads gigabytes; small reads multiply the calls. */
const READ_CHUNK_BYTES = 1024 * 1024;

interface Transcript {
  path: string;
  /** The session the path names; a line's own `sessionId` wins. */
  sessionId: string;
}

interface Response extends SpendPoint {
  sessionId: string;
  outputTokens: number;
}

interface FileState {
  dev: number;
  ino: number;
  /** Bytes consumed: up to the end of the last complete line. */
  offset: number;
  /** Responses from before this were dropped; a scan from earlier must read the file again. */
  since: number;
  /** By message id: a response repeats on one line per content block. */
  responses: Map<string, Response>;
}

export class TranscriptSpend {
  private readonly projectsDir: string;
  private readonly files = new Map<string, FileState>();

  constructor(claudeHome: string) {
    this.projectsDir = join(claudeHome, "projects");
  }

  /** Brings every transcript modified since `since` up to date, and forgets the rest. */
  async scan(since: number): Promise<ScanStats> {
    const stats: ScanStats = { files: 0, bytes: 0 };
    const reader = new LineReader();
    const current = new Set<string>();
    for (const transcript of await listTranscripts(this.projectsDir)) {
      const info = await statIfExists(transcript.path);
      if (!info || info.mtimeMs < since) continue;
      current.add(transcript.path);
      stats.files += 1;
      stats.bytes += await this.update(transcript, info, since, reader);
    }
    for (const path of this.files.keys()) {
      if (!current.has(path)) this.files.delete(path);
    }
    return stats;
  }

  /** Spend by session, each response counted once across all files. */
  bySession(): Map<string, SpendPoint[]> {
    const sessions = new Map<string, SpendPoint[]>();
    const counted = new Set<string>();
    for (const state of this.files.values()) {
      for (const [id, response] of state.responses) {
        if (counted.has(id)) continue;
        counted.add(id);
        const points = sessions.get(response.sessionId) ?? [];
        points.push({ timestampMs: response.timestampMs, cost: response.cost });
        sessions.set(response.sessionId, points);
      }
    }
    return sessions;
  }

  /** Reads what was appended to one transcript; returns the bytes read. */
  private async update(
    transcript: Transcript,
    info: Stats,
    since: number,
    reader: LineReader,
  ): Promise<number> {
    const known = this.files.get(transcript.path);
    let state =
      known && isSameFile(known, info) && info.size >= known.offset && since >= known.since
        ? known
        : freshState(info, since);
    let bytes = 0;
    if (info.size > state.offset) {
      const handle = await openIfExists(transcript.path);
      if (!handle) return 0;
      try {
        // Rewritten in place: the bytes before the offset no longer end a line.
        if (state.offset > 0 && !(await endsLineAt(handle, state.offset))) {
          state = freshState(info, since);
        }
        const target = state;
        const read = await reader.read(handle, target.offset, (line) =>
          addLine(target, transcript.sessionId, line),
        );
        target.offset = read.end;
        bytes = read.bytes;
      } finally {
        await handle.close();
      }
    }

    for (const [id, response] of state.responses) {
      if (response.timestampMs < since) state.responses.delete(id);
    }
    state.since = since;
    this.files.set(transcript.path, state);
    return bytes;
  }
}

function freshState(info: Stats, since: number): FileState {
  return { dev: info.dev, ino: info.ino, offset: 0, since, responses: new Map() };
}

function isSameFile(state: FileState, info: Stats): boolean {
  return state.dev === info.dev && state.ino === info.ino;
}

function addLine(state: FileState, fileSessionId: string, line: Buffer): void {
  if (line.indexOf(ASSISTANT_MARKER) === -1) return;
  const parsed = AssistantLineSchema.safeParse(parseJson(line));
  if (!parsed.success || parsed.data.forkedFrom !== undefined) return;

  const { message, timestamp, sessionId } = parsed.data;
  const outputTokens = message.usage.output_tokens ?? 0;
  const known = state.responses.get(message.id);
  // A response's later lines can carry a larger output count than its first.
  if (known && known.outputTokens >= outputTokens) return;
  const cost = responseCost(message.model, message.usage);
  const timestampMs = known?.timestampMs ?? Date.parse(timestamp);
  if (cost === 0 || Number.isNaN(timestampMs)) return;
  state.responses.set(message.id, {
    sessionId: known?.sessionId ?? sessionId ?? fileSessionId,
    timestampMs,
    cost,
    outputTokens,
  });
}

function parseJson(line: Buffer): unknown {
  try {
    return JSON.parse(line.toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * Reads complete lines into one buffer, grown to fit the longest line, so a first scan over
 * gigabytes allocates almost nothing.
 */
class LineReader {
  private buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);

  /**
   * Calls `onLine` with each complete line from `start`; `end` is the offset after the last one. A
   * line is a view into the buffer, valid only during the call.
   */
  async read(
    handle: FileHandle,
    start: number,
    onLine: (line: Buffer) => void,
  ): Promise<{ end: number; bytes: number }> {
    let end = start;
    let bytes = 0;
    // The buffer holds `filled` bytes of the file from `end`, none of them a whole line.
    let filled = 0;
    for (;;) {
      if (filled === this.buffer.length) this.grow(filled);
      const free = this.buffer.length - filled;
      const { bytesRead } = await handle.read(this.buffer, filled, free, end + filled);
      if (bytesRead === 0) return { end, bytes };
      bytes += bytesRead;
      filled += bytesRead;

      const data = this.buffer.subarray(0, filled);
      let lineStart = 0;
      for (let at = data.indexOf(NEWLINE); at !== -1; at = data.indexOf(NEWLINE, lineStart)) {
        onLine(data.subarray(lineStart, at));
        lineStart = at + 1;
      }
      // Move the unfinished line to the front for the next read.
      if (lineStart > 0) this.buffer.copy(this.buffer, 0, lineStart, filled);
      filled -= lineStart;
      end += lineStart;
    }
  }

  private grow(filled: number): void {
    const larger = Buffer.allocUnsafe(this.buffer.length * 2);
    this.buffer.copy(larger, 0, 0, filled);
    this.buffer = larger;
  }
}

async function endsLineAt(handle: FileHandle, offset: number): Promise<boolean> {
  const byte = Buffer.alloc(1);
  const { bytesRead } = await handle.read(byte, 0, 1, offset - 1);
  return bytesRead === 1 && byte[0] === NEWLINE;
}

async function listTranscripts(projectsDir: string): Promise<Transcript[]> {
  const transcripts: Transcript[] = [];
  for (const project of await readDirIfExists(projectsDir)) {
    if (project.isDirectory()) {
      transcripts.push(...(await projectTranscripts(join(projectsDir, project.name))));
    }
  }
  return transcripts;
}

async function projectTranscripts(projectDir: string): Promise<Transcript[]> {
  const transcripts: Transcript[] = [];
  for (const entry of await readDirIfExists(projectDir)) {
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      transcripts.push({
        path: join(projectDir, entry.name),
        sessionId: basename(entry.name, ".jsonl"),
      });
    } else if (entry.isDirectory()) {
      const subagentsDir = join(projectDir, entry.name, "subagents");
      for (const file of await readDirIfExists(subagentsDir)) {
        if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
        transcripts.push({ path: join(subagentsDir, file.name), sessionId: entry.name });
      }
    }
  }
  return transcripts;
}

// A transcript or directory can disappear between listing it and reading it.
function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function readDirIfExists(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

async function statIfExists(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function openIfExists(path: string): Promise<FileHandle | null> {
  try {
    return await open(path, "r");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}
