/**
 * The Harvest API client, driven against a stubbed `fetch`.
 *
 * Nothing here touches the network: `globalThis.fetch` is replaced for the duration of each
 * case and restored in a `finally`, so a failing assertion cannot leave the stub installed.
 * The fixtures are small hand-written objects shaped like src/lib/harvest/types.ts.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HarvestClient,
  HarvestError,
  DEFAULT_API_ROOT,
  clientFromEnv,
  harvestApiRoot,
  harvestErrorMessage,
} from '../src/lib/harvest/client.ts';
import type { HarvestClientRecord, HarvestPage } from '../src/lib/harvest/types.ts';
import { NO_SECRETS_ENV, withEnv } from './support.ts';

// ── local helpers ────────────────────────────────────────────────────────────

const CREDENTIALS = {
  accountId: '123456',
  accessToken: 'pat.synthetic-token',
  contact: 'ops@example.test',
};

interface Call {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
}

interface Stub {
  calls: Call[];
}

type Handler = (url: string, call: number) => Response | Promise<Response>;

/** Run `fn` with `fetch` replaced by `handler`, and always put the real one back. */
async function withFetch<T>(handler: Handler, fn: (stub: Stub) => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method,
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
    });
    return Promise.resolve(handler(url, calls.length - 1));
  }) as typeof fetch;
  try {
    return await fn({ calls });
  } finally {
    globalThis.fetch = real;
  }
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** One page of a Harvest list response. `next` is the only pagination anyone should follow. */
function pageOf(
  resource: string,
  records: unknown[],
  next: string | null = null,
  extra: Partial<HarvestPage<unknown>> = {},
): HarvestPage<unknown> {
  return {
    per_page: 2000,
    total_pages: next ? 2 : 1,
    total_entries: records.length,
    page: 1,
    next_page: null,
    previous_page: null,
    links: { first: 'https://api.harvestapp.com/v2/clients?page=1', next, previous: null, last: null },
    [resource]: records,
    ...extra,
  };
}

function client(overrides: Partial<ConstructorParameters<typeof HarvestClient>[0]> = {}): HarvestClient {
  return new HarvestClient({ ...CREDENTIALS, maxRetries: 0, ...overrides });
}

const ALPHA: HarvestClientRecord = {
  id: 10,
  name: 'Alpha Client',
  is_active: true,
  address: null,
  currency: 'SEK',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};
const BETA: HarvestClientRecord = { ...ALPHA, id: 11, name: 'Beta Client', currency: 'EUR' };

async function rejects(fn: () => Promise<unknown>): Promise<HarvestError> {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof HarvestError, `expected a HarvestError, got ${String(error)}`);
    return error;
  }
  assert.fail('expected a rejection');
}

// ── configuration ────────────────────────────────────────────────────────────

test('a client refuses to exist without an account, a token and a contact', () => {
  assert.throws(() => new HarvestClient({ ...CREDENTIALS, accountId: '' }), /HARVEST_ACCOUNT_ID is required/);
  assert.throws(() => new HarvestClient({ ...CREDENTIALS, accessToken: '' }), /HARVEST_ACCESS_TOKEN is required/);
  assert.throws(
    () => new HarvestClient({ ...CREDENTIALS, contact: '' }),
    /HARVEST_CONTACT is required — Harvest rejects requests with no User-Agent/,
  );
});

test('clientFromEnv reads the three variables, and complains about the missing one', async () => {
  await withEnv(
    { ...NO_SECRETS_ENV, HARVEST_ACCOUNT_ID: '123456', HARVEST_ACCESS_TOKEN: 'pat.x', HARVEST_CONTACT: 'ops@example.test' },
    () => {
      assert.ok(clientFromEnv() instanceof HarvestClient);
    },
  );
  await withEnv(NO_SECRETS_ENV, () => {
    assert.throws(() => clientFromEnv(), /HARVEST_ACCOUNT_ID is required/);
  });
  // The environment is a default, not a requirement: any record will do.
  assert.ok(
    clientFromEnv({
      HARVEST_ACCOUNT_ID: '1',
      HARVEST_ACCESS_TOKEN: 't',
      HARVEST_CONTACT: 'ops@example.test',
    }) instanceof HarvestClient,
  );
});

test('the client offers no way to write — there is no post, put, patch or delete', () => {
  const surface = client() as unknown as Record<string, unknown>;
  for (const verb of ['post', 'put', 'patch', 'delete', 'create', 'update', 'destroy']) {
    assert.equal(typeof surface[verb], 'undefined', `HarvestClient.${verb} must not exist`);
  }
  const methods = Object.getOwnPropertyNames(HarvestClient.prototype).sort();
  assert.deepEqual(methods, ['constructor', 'download', 'get', 'list', 'paginate']);
});

// ── one request ──────────────────────────────────────────────────────────────

test('a request is a GET, identified by contact and account, asking for JSON', async () => {
  await withFetch(
    () => jsonResponse({ name: 'Synthetic Studio' }),
    async (stub) => {
      await client().get('/company');
      assert.equal(stub.calls.length, 1);
      const call = stub.calls[0]!;
      assert.equal(call.method, 'GET');
      assert.equal(call.headers.Authorization, `Bearer ${CREDENTIALS.accessToken}`);
      assert.equal(call.headers['Harvest-Account-Id'], CREDENTIALS.accountId);
      assert.equal(call.headers['User-Agent'], `No BS Time Tracking migration tool (${CREDENTIALS.contact})`);
      assert.equal(call.headers.Accept, 'application/json');
    },
  );
});

test('the token never appears anywhere but the Authorization header', async () => {
  await withFetch(
    () => jsonResponse({}),
    async (stub) => {
      await client().get('/company');
      const call = stub.calls[0]!;
      assert.ok(!call.url.includes(CREDENTIALS.accessToken), 'not in the URL');
      for (const [name, value] of Object.entries(call.headers)) {
        if (name === 'Authorization') continue;
        assert.ok(!String(value).includes(CREDENTIALS.accessToken), `leaked into ${name}`);
      }
    },
  );
});

test('every URL asks for the largest page Harvest allows, and carries the given filters', async () => {
  await withFetch(
    (_url) => jsonResponse(pageOf('clients', [ALPHA])),
    async (stub) => {
      await client().list('/clients', 'clients', { updated_since: '2026-01-31T09:00:00Z', page: undefined });
      const url = new URL(stub.calls[0]!.url);
      assert.equal(url.origin + url.pathname, 'https://api.harvestapp.com/v2/clients');
      assert.equal(url.searchParams.get('per_page'), '2000');
      assert.equal(url.searchParams.get('updated_since'), '2026-01-31T09:00:00Z');
      assert.equal(url.searchParams.has('page'), false, 'an undefined parameter is left out');
    },
  );
});

test('onRequest is told about each URL, for progress output', async () => {
  const seen: string[] = [];
  await withFetch(
    () => jsonResponse(pageOf('clients', [ALPHA])),
    async () => {
      await client({ onRequest: (url) => seen.push(url) }).list('/clients', 'clients');
      assert.equal(seen.length, 1);
      assert.match(seen[0]!, /^https:\/\/api\.harvestapp\.com\/v2\/clients\?/);
      assert.ok(!seen[0]!.includes(CREDENTIALS.accessToken));
    },
  );
});

// ── pagination ───────────────────────────────────────────────────────────────

test('pagination follows links.next until it is null, and ignores next_page', async () => {
  const second = 'https://api.harvestapp.com/v2/clients?per_page=2000&cursor=abc';
  await withFetch(
    (url) =>
      url.includes('cursor=abc')
        ? jsonResponse(pageOf('clients', [BETA], null, { next_page: 7 }))
        : jsonResponse(pageOf('clients', [ALPHA], second, { next_page: null })),
    async (stub) => {
      const found = await client().list<HarvestClientRecord>('/clients', 'clients');
      assert.deepEqual(found.map((c) => c.id), [10, 11]);
      assert.equal(stub.calls.length, 2);
      assert.equal(stub.calls[1]!.url, second, 'the next URL is used verbatim');
      assert.equal(stub.calls[1]!.headers['Harvest-Account-Id'], CREDENTIALS.accountId);
    },
  );
});

test('an empty page ends the walk without an error', async () => {
  await withFetch(
    () => jsonResponse(pageOf('clients', [])),
    async (stub) => {
      assert.deepEqual(await client().list('/clients', 'clients'), []);
      assert.equal(stub.calls.length, 1);
    },
  );
});

test('paginate yields record by record, so a caller can stop early', async () => {
  const second = 'https://api.harvestapp.com/v2/clients?per_page=2000&cursor=abc';
  await withFetch(
    (url) =>
      url.includes('cursor=abc')
        ? jsonResponse(pageOf('clients', [BETA]))
        : jsonResponse(pageOf('clients', [ALPHA], second)),
    async (stub) => {
      for await (const record of client().paginate<HarvestClientRecord>('/clients', 'clients')) {
        assert.equal(record.id, 10);
        break;
      }
      assert.equal(stub.calls.length, 1, 'the second page was never fetched');
    },
  );
});

test('a next link pointing back at a page already read is refused, not followed forever', async () => {
  await withFetch(
    (url) => jsonResponse(pageOf('clients', [ALPHA], url)),
    async (stub) => {
      const error = await rejects(() => client().list('/clients', 'clients'));
      assert.match(error.message, /^Pagination loop detected at https:\/\/api\.harvestapp\.com\/v2\/clients/);
      assert.equal(error.status, 0);
      assert.equal(stub.calls.length, 1);
    },
  );
});

test('a payload without the expected array says which keys it did have', async () => {
  await withFetch(
    () => jsonResponse({ message: 'not a list', links: { next: null } }),
    async () => {
      const error = await rejects(() => client().list('/clients', 'clients'));
      assert.match(error.message, /Expected an array under "clients", got undefined/);
      assert.match(error.message, /Keys present: message, links/);
    },
  );
});

// ── failures ─────────────────────────────────────────────────────────────────

test('a non-2xx answer throws, carrying the status, the URL and the body', async () => {
  await withFetch(
    () => new Response('{"error":"invalid_token"}', { status: 401, statusText: 'Unauthorized' }),
    async () => {
      const error = await rejects(() => client().get('/company'));
      assert.equal(error.name, 'HarvestError');
      assert.equal(error.status, 401);
      assert.match(error.url, /\/v2\/company/);
      assert.equal(error.body, '{"error":"invalid_token"}');
      assert.match(error.message, /^401 Unauthorized for https:/);
    },
  );
});

test('a very long error body is kept to the first 500 characters', async () => {
  await withFetch(
    () => new Response('x'.repeat(5000), { status: 500, statusText: 'Server Error' }),
    async () => {
      const error = await rejects(() => client().get('/company'));
      assert.equal(error.body.length, 500);
    },
  );
});

test('a 5xx is retried up to maxRetries and then surfaced', async () => {
  await withFetch(
    (_url, call) => (call === 0 ? new Response('down', { status: 503 }) : jsonResponse({ ok: true })),
    async (stub) => {
      // maxRetries 0 means the first failure is the last word.
      const error = await rejects(() => client({ maxRetries: 0 }).get('/company'));
      assert.equal(error.status, 503);
      assert.equal(stub.calls.length, 1);
    },
  );
});

test('a 429 waits for Retry-After and then succeeds', async () => {
  const started = Date.now();
  await withFetch(
    (_url, call) =>
      call === 0
        ? new Response('slow down', { status: 429, headers: { 'Retry-After': '1' } })
        : jsonResponse({ name: 'Synthetic Studio' }),
    async (stub) => {
      const company = await client({ maxRetries: 3 }).get<{ name: string }>('/company');
      assert.equal(company.name, 'Synthetic Studio');
      assert.equal(stub.calls.length, 2);
      assert.ok(Date.now() - started >= 1000, 'Harvest said one second, so we waited one second');
    },
  );
});

test('a 429 with no retries left is surfaced rather than swallowed', async () => {
  await withFetch(
    () => new Response('slow down', { status: 429 }),
    async (stub) => {
      const error = await rejects(() => client({ maxRetries: 0 }).get('/company'));
      assert.equal(error.status, 429);
      assert.equal(stub.calls.length, 1);
    },
  );
});

test('a dropped socket becomes a HarvestError that says how many attempts were made', async () => {
  await withFetch(
    () => Promise.reject(new Error('ECONNRESET')),
    async (stub) => {
      const error = await rejects(() => client({ maxRetries: 0 }).get('/company'));
      assert.equal(error.status, 0);
      assert.match(error.message, /Network failure after 1 attempts: Error: ECONNRESET/);
      assert.equal(stub.calls.length, 1);
    },
  );
});

// ── the message a person reads ───────────────────────────────────────────────

test('each status gets an explanation that does not guess at the cause', () => {
  const of = (status: number, body = '') =>
    harvestErrorMessage(new HarvestError('x', status, 'https://api.harvestapp.com/v2/company', body));

  assert.match(of(401), /account ID and the personal access token are two different values/);
  assert.match(of(401), /the number, not the subdomain/);
  assert.ok(!/revoked/i.test(of(401)), 'no invented cause');
  assert.match(of(403), /token may belong to a different account/);
  assert.match(of(404), /no such account \(404\)\. Check the account ID\./);
  assert.match(of(429), /rate limiting this instance \(429\)/);
  assert.equal(of(500), 'Harvest returned 500.');
});

test("Harvest's own words are quoted when the body carries them", () => {
  const of = (body: string) =>
    harvestErrorMessage(new HarvestError('x', 401, 'https://api.harvestapp.com/v2/company', body));

  assert.match(of('{"error_description":"The access token is invalid"}'), /Harvest said: The access token is invalid/);
  assert.match(of('{"message":"Nope"}'), /Harvest said: Nope/);
  assert.match(of('{"error":"invalid_token"}'), /Harvest said: invalid_token/);
  assert.match(of('  plain text\nsecond line  '), /Harvest said: plain text/);
  assert.ok(!of('').includes('Harvest said'), 'nothing to quote, nothing quoted');
  // JSON whose message is not a string falls back to the raw first line rather than to nothing.
  assert.match(of('{"error":{"nested":true}}'), /Harvest said: \{"error":\{"nested":true\}\}/);
  assert.match(of('y'.repeat(400)), /Harvest said: y+$/);
  assert.equal(of('y'.repeat(400)).endsWith('y'.repeat(200)), true, 'trimmed to 200 characters');
  assert.ok(!of('y'.repeat(400)).endsWith('y'.repeat(201)));
  // A 429 has nothing useful to add from the body, and says so in the same words every time.
  assert.equal(
    harvestErrorMessage(new HarvestError('x', 429, 'u', '{"message":"slow"}')),
    'Harvest is rate limiting this instance (429). Wait a minute and try again.',
  );
});

// ── downloads ────────────────────────────────────────────────────────────────

test('a receipt is downloaded with the same credentials and its content type', async () => {
  await withFetch(
    () => new Response(new Uint8Array([37, 80, 68, 70]), { headers: { 'content-type': 'application/pdf' } }),
    async (stub) => {
      const file = await client().download('https://cache.harvestapp.com/receipts/600.pdf');
      assert.deepEqual([...file.bytes], [37, 80, 68, 70]);
      assert.equal(file.contentType, 'application/pdf');
      assert.equal(stub.calls[0]!.headers['Harvest-Account-Id'], CREDENTIALS.accountId);
    },
  );
});

test('a download from anywhere but Harvest is refused without a request', async () => {
  await withFetch(
    () => jsonResponse({}),
    async (stub) => {
      for (const url of [
        'https://evil.example.test/receipt.pdf',
        'https://notharvestapp.com/receipt.pdf',
        'https://harvestapp.com.evil.test/receipt.pdf',
      ]) {
        const error = await rejects(() => client().download(url));
        assert.match(error.message, /^Refusing to download from /);
        assert.equal(error.status, 0);
      }
      assert.equal(stub.calls.length, 0, 'nothing was fetched');
    },
  );
});

test('a download that fails throws with its status', async () => {
  await withFetch(
    () => new Response('gone', { status: 404, statusText: 'Not Found' }),
    async () => {
      const error = await rejects(() => client().download('https://cache.harvestapp.com/receipts/1.pdf'));
      assert.equal(error.status, 404);
      assert.match(error.message, /^404 Not Found for https:\/\/cache\.harvestapp\.com/);
    },
  );
});

test('the API is Harvest\'s own unless HARVEST_API_URL names another', () => {
  assert.equal(harvestApiRoot({}), DEFAULT_API_ROOT);
  assert.equal(harvestApiRoot({ HARVEST_API_URL: '  ' }), DEFAULT_API_ROOT);
  assert.equal(harvestApiRoot({ HARVEST_API_URL: 'http://localhost:4322/v2/' }), 'http://localhost:4322/v2');
});

test('a client pointed at another API asks it, with the same credentials and paging', async () => {
  await withFetch(
    () => jsonResponse(pageOf('clients', [ALPHA])),
    async (stub) => {
      await client({ apiRoot: 'http://localhost:4322/v2' }).list('/clients', 'clients');
      const url = new URL(stub.calls[0]!.url);
      assert.equal(url.origin + url.pathname, 'http://localhost:4322/v2/clients');
      assert.equal(url.searchParams.get('per_page'), '2000');
      assert.equal(stub.calls[0]!.headers['Harvest-Account-Id'], CREDENTIALS.accountId);
    },
  );
});

test('a receipt may come from the host of the API the client was pointed at, and no other', async () => {
  await withFetch(
    () => new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } }),
    async (stub) => {
      const local = client({ apiRoot: 'http://localhost:4322/v2' });
      await local.download('http://localhost:4322/receipts/1.png');
      assert.equal(stub.calls.length, 1);
      const error = await rejects(() => local.download('http://localhost:9999/receipts/1.png'));
      assert.match(error.message, /^Refusing to download from localhost:9999/);
    },
  );
});
