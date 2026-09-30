/**
 * The instance log: `<instance>/log/app.jsonl`, one JSON object per line.
 *
 * `startInstanceLog` is once-per-process — it latches a flag and wraps `process.stdout.write`
 * — so every case here runs in its own child process driven by a tiny generated script. That
 * also keeps the tee from swallowing this runner's own output.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { tempDir } from './fixture.ts';
import { withEnv } from './support.ts';

const LOG_MODULE = new URL('../src/lib/instance-log.ts', import.meta.url).href;

/** The documented rollover point, from `.env.example` and the module's own comment. */
const MAX_BYTES = 8 * 1024 * 1024;

const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

interface Record_ {
  ts: string;
  level: string;
  msg: string;
  instance: string;
  [key: string]: unknown;
}

interface Run {
  /** The instance folder the child logged into. */
  dir: string;
  logFile: string;
  /** What `startInstanceLog` returned, as the child saw it. */
  started: string | null;
  stdout: string;
  stderr: string;
  status: number | null;
  lines: () => Record_[];
}

/**
 * Run `body` in a child process that has just started the instance log.
 *
 * `prepare` gets the instance folder before the child starts, for the cases that need a log
 * file to already be there.
 */
async function drive(
  body: string,
  options: { env?: Record<string, string | undefined>; prepare?: (dir: string) => void } = {},
): Promise<Run> {
  const root = tempDir('no-bs-instance-log-test-');
  made.push(root);
  const dir = join(root, 'acme');
  mkdirSync(dir, { recursive: true });
  options.prepare?.(dir);

  const driver = join(root, 'driver.ts');
  writeFileSync(
    driver,
    `import { writeFileSync } from 'node:fs';\n` +
      `import { log, startInstanceLog } from ${JSON.stringify(LOG_MODULE)};\n` +
      `const instance = { dir: ${JSON.stringify(dir)}, ` +
      `databasePath: ${JSON.stringify(join(dir, 'timetrack.db'))}, adopted: false };\n` +
      `const started = startInstanceLog(instance);\n` +
      // Written with fs rather than printed: stdout is teed into the log under test.
      `const report = (extra = {}) => writeFileSync(${JSON.stringify(join(root, 'result.json'))}, ` +
      `JSON.stringify({ started, ...extra }));\n` +
      `report();\n${body}\n`,
  );

  // The child's environment is this process's, so INSTANCE_LOG goes through withEnv.
  const result = await withEnv({ INSTANCE_LOG: undefined, ...options.env }, () =>
    spawnSync(process.execPath, ['--experimental-strip-types', driver], {
      encoding: 'utf8',
      env: process.env,
    }),
  );

  assert.equal(result.status, 0, `driver failed:\n${result.stderr}`);
  const report = JSON.parse(readFileSync(join(root, 'result.json'), 'utf8')) as { started: string | null };
  const logFile = join(dir, 'log', 'app.jsonl');

  return {
    dir,
    logFile,
    started: report.started,
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
    lines: () =>
      readFileSync(logFile, 'utf8')
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as Record_),
  };
}

// ── The format ───────────────────────────────────────────────────────────────

test('every record carries ts, level, msg and instance, in that order', async () => {
  const run = await drive(`log.info('started up');`);
  assert.equal(run.started, run.logFile);

  const [record] = run.lines();
  assert.ok(record);
  assert.deepEqual(Object.keys(record).slice(0, 4), ['ts', 'level', 'msg', 'instance']);
  assert.equal(record.level, 'info');
  assert.equal(record.msg, 'started up');
  assert.equal(record.instance, 'acme', 'the instance is named by its folder');
  assert.match(record.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('one JSON object per line, and extra fields ride along', async () => {
  const run = await drive(
    `log.info('first', { http: { status: 200 } });\nlog.warn('second', { count: 2 });`,
  );
  const records = run.lines();
  assert.equal(records.length, 2);
  assert.deepEqual(records[0]?.http, { status: 200 });
  assert.equal(records[1]?.count, 2);
});

test('the four levels are recorded, and split across stdout and stderr', async () => {
  const run = await drive(
    `log.debug('d');\nlog.info('i');\nlog.warn('w');\nlog.error('e');`,
  );
  assert.deepEqual(
    run.lines().filter((r) => r.msg.length === 1).map((r) => [r.level, r.msg]),
    [['debug', 'd'], ['info', 'i'], ['warn', 'w'], ['error', 'e']],
  );
  // The human line goes to the terminal unchanged: warnings and errors on stderr.
  assert.match(run.stdout, /^d\ni\n$/);
  assert.match(run.stderr, /^w\ne\n$/);
});

test('a field that cannot be serialised costs the record, not the process', async () => {
  const cyclic = `const loop = {}; loop.self = loop; log.info('cyclic', { loop });`;
  const run = await drive(`${cyclic}\nlog.info('after');`);
  assert.deepEqual(run.lines().map((r) => r.msg), ['after']);
  assert.match(run.stdout, /cyclic/, 'the terminal still saw it');
});

// ── Switching it off ─────────────────────────────────────────────────────────

test('INSTANCE_LOG=off leaves no trace in the customer folder', async () => {
  const run = await drive(`log.info('nothing to see');`, { env: { INSTANCE_LOG: 'off' } });
  assert.equal(run.started, null);
  assert.equal(existsSync(join(run.dir, 'log')), false);
  assert.match(run.stdout, /nothing to see/, 'stdout is unchanged');
});

test('any other INSTANCE_LOG value leaves logging on', async () => {
  const run = await drive(`log.info('on');`, { env: { INSTANCE_LOG: 'on' } });
  assert.equal(run.started, run.logFile);
  assert.equal(run.lines().at(-1)?.msg, 'on');
});

test('an unwritable log folder degrades to stdout rather than taking the process down', async () => {
  const run = await drive(`log.info('still running');`, {
    // A *file* where the log directory should be: mkdirSync fails, and that must be survivable.
    prepare: (dir) => writeFileSync(join(dir, 'log'), 'not a directory'),
  });
  assert.equal(run.started, null);
  assert.match(run.stdout, /still running/);
});

// ── Rotation ─────────────────────────────────────────────────────────────────

test('the log rotates once at 8 MB', async () => {
  const run = await drive(`log.info('after rotation');`, {
    prepare: (dir) => {
      mkdirSync(join(dir, 'log'), { recursive: true });
      writeFileSync(join(dir, 'log', 'app.jsonl'), Buffer.alloc(MAX_BYTES, 'x'));
    },
  });

  const rolled = `${run.logFile}.1`;
  assert.ok(existsSync(rolled), 'the full file was moved aside');
  assert.equal(readFileSync(rolled).length, MAX_BYTES);
  assert.equal(run.lines().at(-1)?.msg, 'after rotation');
  assert.ok(readFileSync(run.logFile).length < MAX_BYTES, 'the live file starts fresh');
});

test('a log below the limit is appended to, not rotated', async () => {
  const existing = `{"ts":"2026-01-01T00:00:00.000Z","level":"info","msg":"earlier","instance":"acme"}\n`;
  const run = await drive(`log.info('later');`, {
    prepare: (dir) => {
      mkdirSync(join(dir, 'log'), { recursive: true });
      // One byte short of the rollover point, and a whole number of lines.
      writeFileSync(
        join(dir, 'log', 'app.jsonl'),
        `${existing}${'x'.repeat(MAX_BYTES - existing.length - 2)}\n`,
      );
    },
  });

  assert.equal(existsSync(`${run.logFile}.1`), false);
  const contents = readFileSync(run.logFile, 'utf8');
  assert.ok(contents.startsWith(existing), 'what was already there is still there');
  const last = JSON.parse(contents.trimEnd().split('\n').at(-1)!) as Record_;
  assert.equal(last.msg, 'later', 'the new record was appended');
});

// ── Secrets ──────────────────────────────────────────────────────────────────

test('fields whose name suggests a secret never reach the disk', async () => {
  const run = await drive(
    `log.info('login', { token: 'abc', secret: 'abc', password: 'abc', authorization: 'Bearer abc',` +
      ` api_key: 'abc', credential: 'abc', cookie: 'abc', session: 'abc', user: 'ada@example.test' });`,
  );
  const record = run.lines().at(-1)!;
  for (const key of ['token', 'secret', 'password', 'authorization', 'api_key', 'credential', 'cookie', 'session']) {
    assert.equal(record[key], '[redacted]', `${key} was written in the clear`);
  }
  assert.equal(record.user, 'ada@example.test', 'ordinary fields are untouched');
});

test('the shape a token takes inside a message is redacted, on disk and on the terminal', async () => {
  const run = await drive(
    `log.info('GET /x failed: authorization: Bearer sk-0123456789abcdef');`,
  );
  const record = run.lines().at(-1)!;
  assert.doesNotMatch(record.msg, /sk-0123456789abcdef/);
  assert.match(record.msg, /\[redacted\]/);
  assert.doesNotMatch(run.stdout, /sk-0123456789abcdef/, 'nor into journald or a pasted scrollback');
});

test('what the token actions log is a name and a prefix, and the fields are redacted wholesale', async () => {
  // src/actions/tokens.ts logs exactly this shape when a personal access token is created.
  const run = await drive(
    `log.info('[api] token "CI" (tt_abcd…) created for ada@example.test', ` +
      `{ api_token: { id: 7, prefix: 'tt_abcd', user: 1, expires_at: null } });`,
  );
  const record = run.lines().at(-1)!;
  assert.equal(record.api_token, '[redacted]', 'a field named like a secret goes whole');
  assert.match(record.msg, /token "CI" \(tt_abcd…\) created/, 'the human line keeps its meaning');
  assert.doesNotMatch(JSON.stringify(record), /[A-Za-z0-9._~+/=-]{20,}/, 'nothing token-shaped got through');
});

test('redaction reaches nested fields', async () => {
  const run = await drive(`log.error('boom', { request: { headers: { cookie: 'tt_session=x' } } });`);
  const record = run.lines().at(-1)!;
  assert.deepEqual(record.request, { headers: { cookie: '[redacted]' } });
});

// ── Output the app did not write itself ──────────────────────────────────────

test('anything written to stdout or stderr is teed into the file', async () => {
  const run = await drive(`console.log('a library said something');\nconsole.error('and complained');`);
  const records = run.lines();
  assert.deepEqual(
    records.filter((r) => r.msg.includes('said') || r.msg.includes('complained')).map((r) => [r.level, r.msg]),
    [['info', 'a library said something'], ['error', 'and complained']],
  );
  assert.match(run.stdout, /a library said something/, 'the original write still happens');
});

test('a request line is parsed into fields, not left as prose', async () => {
  const run = await drive(`console.log('08:28:48 [200] POST /api/login 25ms');`);
  const record = run.lines().at(-1)!;
  assert.deepEqual(record.http, { method: 'POST', path: '/api/login', status: 200, ms: 25 });
});

test('a request line with no method defaults to GET; an unrecognised line stays prose', async () => {
  const run = await drive(
    `console.log('08:28:48 [404] /missing 3ms');\nconsole.log('just a line');`,
  );
  const records = run.lines();
  assert.deepEqual(records.at(-2)?.http, { method: 'GET', path: '/missing', status: 404, ms: 3 });
  assert.equal(records.at(-1)?.http, undefined);
});

test('colour codes and blank lines do not reach the file', async () => {
  const run = await drive(`console.log('\\u001B[32mgreen\\u001B[39m\\n\\n  \\nplain');`);
  const msgs = run.lines().map((r) => r.msg);
  assert.ok(msgs.includes('green'), `expected a plain "green" among ${JSON.stringify(msgs)}`);
  assert.ok(msgs.includes('plain'));
  assert.equal(msgs.filter((m) => m === '').length, 0);
});

test('starting twice is the same as starting once', async () => {
  const run = await drive(
    `const again = startInstanceLog(instance);\nlog.info('once');\nreport({ again });`,
  );
  const report = JSON.parse(readFileSync(join(run.dir, '..', 'result.json'), 'utf8')) as {
    started: string | null;
    again: string | null;
  };
  assert.equal(report.again, report.started);
  assert.equal(run.lines().filter((r) => r.msg === 'once').length, 1);
});
