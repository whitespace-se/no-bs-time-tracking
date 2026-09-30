/**
 * The instance's log: JSON Lines in the instance's folder.
 *
 * If an instance is a directory, then what happened to that instance belongs in the directory.
 * You copy the folder, you have its history; you hand it to whoever is debugging, they have
 * everything — without a detour through journald on a host nobody kept.
 *
 * Two audiences, two formats, one stream. **stdout stays exactly as it was**: coloured,
 * human, whatever systemd and Docker already capture. The **file gets one JSON object per
 * line** — the format every log shipper, `jq` and search backend already understands, so an
 * instance's log can be tailed by a person today and pointed at Loki tomorrow without either
 * side being rewritten.
 *
 *     {"ts":"2026-08-28T07:13:25.412Z","level":"info","msg":"GET /login 200 30ms",
 *      "instance":"trial","http":{"method":"GET","path":"/login","status":200,"ms":30}}
 *
 * Every record carries `ts` (RFC 3339, UTC, milliseconds), `level`, `msg` and `instance`.
 * Anything else is per-event and optional — which is the whole point of the format: fields
 * are added where they are known instead of being crammed into prose and grepped back out.
 *
 * Output the app does not produce itself — Astro's request lines, a library writing to
 * stderr — is teed into the same file rather than lost, wrapped as a record with its level
 * taken from the stream it came from. Request lines are parsed into `http` fields, because a
 * status code you can filter on is worth more than one you can only read.
 *
 * Secrets are redacted by field name and by shape before anything is written, in both
 * directions — see `redact` below for what that does and does not cover.
 *
 * Logging must never be what takes an instance down: an unwritable folder, a full disk or a
 * failed rotation all degrade to "no file, stdout as usual".
 */

import { createWriteStream, mkdirSync, renameSync, statSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { Instance } from './instance.ts';

export type Level = 'debug' | 'info' | 'warn' | 'error';

/** One rollover, kept small enough to open in an editor and read on a bad day. */
const MAX_BYTES = 8 * 1024 * 1024;

const ANSI = /\x1B\[[0-9;]*[A-Za-z]/g;

/**
 * Astro's dev-server request line: `08:28:48 [200] POST /api/login 25ms`.
 *
 * Parsed rather than passed through as prose, so the file can answer "every 5xx today" as a
 * filter rather than a regex over free text. A line that does not match stays a plain message
 * — an unrecognised format must not cost the line.
 */
const REQUEST_LINE = /\[(\d{3})\]\s+(?:([A-Z]+)\s+)?(\S+)\s+(\d+)ms/;

let stream: WriteStream | null = null;
let started = false;
let instanceName = '';

/** Captured before the tee is installed, so the logger's own output never re-enters it. */
let writeOut: ((chunk: string) => void) | null = null;
let writeErr: ((chunk: string) => void) | null = null;

function rotate(file: string): void {
  try {
    if (statSync(file).size >= MAX_BYTES) renameSync(file, `${file}.1`);
  } catch {
    // No file yet, or it cannot be moved. Either way, carry on and append.
  }
}

/**
 * Field names whose values never reach the disk.
 *
 * Nothing logs a credential today — the Harvest client keeps the token in a header, never in
 * a URL, and the only writers are our own lines and Astro's request lines. But a log file is
 * exactly where a secret ends up eventually: someone dumps a config object, or an error
 * carries the request that caused it, and it lands in a folder that gets copied to a laptop
 * and attached to a support thread. This costs one regex per field and removes the class.
 *
 * What it does not do: guess. A secret in a field called `value`, or split across two writes
 * by a library we do not control, goes through. This is a floor, not a guarantee — the actual
 * guarantee is that the app never puts a credential in a log call in the first place.
 */
const SECRET_KEY_NAME = /token|secret|password|passwd|authorization|api[-_]?key|credential|cookie|session/i;

/** `Authorization: Bearer …`, `token=…` — the shapes a secret takes inside a message string. */
const SECRET_IN_TEXT = /\b(bearer\s+|(?:access[_-]?token|token|api[-_]?key|password|secret)["'\s:=]+)([A-Za-z0-9._~+/=-]{12,})/gi;

const REDACTED = '[redacted]';

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return value; // deep enough for any record we write; no unbounded recursion
  if (typeof value === 'string') return value.replace(SECRET_IN_TEXT, (_, label) => `${label}${REDACTED}`);
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_NAME.test(key) ? REDACTED : redact(inner, depth + 1);
    }
    return out;
  }
  return value;
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (!stream) return;
  try {
    // Key order is deliberate: the four every record has come first, so a raw file stays
    // readable by eye and `cut`/`grep` remain useful on it.
    const record = {
      ts: new Date().toISOString(),
      level,
      msg: redact(msg) as string,
      instance: instanceName,
      ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
    };
    stream.write(`${JSON.stringify(record)}\n`);
  } catch {
    // A field that cannot be serialised must not cost the process.
  }
}

/**
 * The app's own logger.
 *
 * Writes the human line to the terminal and the structured record to the file, so neither
 * audience is served the other's format.
 */
export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => write('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => write('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write('error', msg, fields),
};

function write(level: Level, msg: string, fields?: Record<string, unknown>): void {
  // Redacted on the way to the terminal as well, not only into the file. A secret printed to
  // stdout is a secret in journald and in whatever scrollback someone pastes into a ticket;
  // there is no audience for whom the real value is the useful one.
  const line = `${redact(msg) as string}\n`;
  if (level === 'error' || level === 'warn') (writeErr ?? ((c: string) => process.stderr.write(c)))(line);
  else (writeOut ?? ((c: string) => process.stdout.write(c)))(line);
  emit(level, msg, fields);
}

/**
 * Begin logging into the instance folder.
 *
 * Idempotent, and safe to call from anything that opens an instance — the server, a script, a
 * one-off migration. `INSTANCE_LOG=off` opts out for a run that should leave no trace in the
 * instance's folder.
 */
export function startInstanceLog(instance: Instance): string | null {
  if (started) return stream ? logPath(instance) : null;
  started = true;

  if (process.env.INSTANCE_LOG === 'off') return null;

  const file = logPath(instance);
  instanceName = instance.dir.split('/').filter(Boolean).pop() ?? '';

  try {
    mkdirSync(join(instance.dir, 'log'), { recursive: true });
    rotate(file);
    stream = createWriteStream(file, { flags: 'a' });
    // An EPIPE or a disk filling up must not become an unhandled error event.
    stream.on('error', () => {
      stream = null;
    });
  } catch {
    stream = null;
    return null;
  }

  writeOut = tee(process.stdout, 'info');
  writeErr = tee(process.stderr, 'error');

  return file;
}

function logPath(instance: Instance): string {
  return join(instance.dir, 'log', 'app.jsonl');
}

/**
 * Wrap one stream's `write` so everything passing through it is also recorded.
 *
 * Returns the original writer, which the logger above uses to reach the terminal without
 * being teed a second time.
 */
function tee(target: NodeJS.WriteStream, level: Level): (chunk: string) => void {
  const original = target.write.bind(target);

  target.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (stream) {
      try {
        const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        for (const line of text.replace(ANSI, '').replace(/\n$/, '').split('\n')) {
          if (line.trim()) emit(level, line.trim(), httpFields(line));
        }
      } catch {
        // Never let the copy break the original write.
      }
    }
    return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof target.write;

  return (chunk: string) => {
    original(chunk);
  };
}

function httpFields(line: string): Record<string, unknown> | undefined {
  const match = REQUEST_LINE.exec(line);
  if (!match) return undefined;
  return {
    http: {
      method: match[2] ?? 'GET',
      path: match[3],
      status: Number(match[1]),
      ms: Number(match[4]),
    },
  };
}
