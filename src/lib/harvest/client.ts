/**
 * Harvest API v2 client — READ ONLY.
 *
 * There are deliberately no create/update/delete methods on this class. It is pointed at
 * live timesheets in the source account during migration, and a write verb that exists is a write verb
 * that can fire by accident. Adding one is a decision, not a convenience.
 *
 * Three migration requirements are implemented directly here:
 *
 *   1. Pagination follows `links.next` until null. The `page` parameter is deprecated, and
 *      on cursor-based responses `next_page` is null for all but the first and last pages —
 *      so page-walking doesn't error, it just silently stops early. That is how you lose
 *      four years of timesheets and never see a stack trace.
 *   2. 429 is honoured via `Retry-After`. The limit is 100 requests / 15 s.
 *   3. Non-2xx throws. A 401 that resolves as a JSON body is indistinguishable from an
 *      empty account.
 */

import type { HarvestPage } from './types.ts';

export const DEFAULT_API_ROOT = 'https://api.harvestapp.com/v2';

/**
 * Where the Harvest API is. Harvest's own, unless HARVEST_API_URL names another server that
 * answers the same way — a stand-in serving an account exported earlier, for testing an
 * import once the real API is out of reach.
 */
export function harvestApiRoot(env: NodeJS.ProcessEnv = process.env): string {
  return (env.HARVEST_API_URL?.trim() || DEFAULT_API_ROOT).replace(/\/+$/, '');
}

/** 100 req / 15 s → 150ms. Rounded up for headroom; the importer is not latency-bound. */
const MIN_REQUEST_INTERVAL_MS = 200;

export interface HarvestConfig {
  accountId: string;
  accessToken: string;
  /** Contact address for the User-Agent header. Harvest 400s if User-Agent is absent. */
  contact: string;
  maxRetries?: number;
  /** Called before each request. Useful for progress output in long imports. */
  onRequest?: (url: string) => void;
  /** The API's address, e.g. `https://api.harvestapp.com/v2`. Defaults to harvestApiRoot(). */
  apiRoot?: string;
}

export class HarvestError extends Error {
  // Declared as fields rather than constructor parameter properties: parameter properties
  // are not erasable, so they break Node's native TypeScript stripping.
  readonly status: number;
  readonly url: string;
  readonly body: string;

  constructor(message: string, status: number, url: string, body: string) {
    super(message);
    this.name = 'HarvestError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

/**
 * What to put on screen when Harvest says no.
 *
 * Harvest's own words, plus what the status code actually means. The two forms in this app
 * used to guess at causes — "the token may have been revoked" — which is one possibility out
 * of several and no help when the real answer is that the account ID field has a subdomain in
 * it. A 401 does not distinguish a bad token from a bad account ID, so neither does this.
 */
export function harvestErrorMessage(error: HarvestError): string {
  const detail = describeBody(error.body);
  const suffix = detail ? ` Harvest said: ${detail}` : '';

  switch (error.status) {
    case 401:
      return (
        'Harvest rejected the credentials (401). The account ID and the personal access ' +
        'token are two different values from id.getharvest.com/developers — the account ID ' +
        `is the number, not the subdomain.${suffix}`
      );
    case 403:
      return `Harvest refused access to that account (403). The token may belong to a different account.${suffix}`;
    case 404:
      return `Harvest has no such account (404). Check the account ID.${suffix}`;
    case 429:
      return 'Harvest is rate limiting this instance (429). Wait a minute and try again.';
    default:
      return `Harvest returned ${error.status}.${suffix}`;
  }
}

/** Harvest answers errors as JSON more often than not; fall back to the raw first line. */
function describeBody(body: string): string {
  if (!body) return '';
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const message = parsed.error_description ?? parsed.message ?? parsed.error;
    if (typeof message === 'string' && message) return message.slice(0, 200);
  } catch {
    // not JSON
  }
  return body.trim().split('\n')[0]?.slice(0, 200) ?? '';
}

export class HarvestClient {
  readonly #config: Required<Pick<HarvestConfig, 'maxRetries' | 'apiRoot'>> & HarvestConfig;
  #nextAllowedAt = 0;

  constructor(config: HarvestConfig) {
    if (!config.accountId) throw new Error('HARVEST_ACCOUNT_ID is required');
    if (!config.accessToken) throw new Error('HARVEST_ACCESS_TOKEN is required');
    if (!config.contact) {
      throw new Error('HARVEST_CONTACT is required — Harvest rejects requests with no User-Agent');
    }
    this.#config = { maxRetries: 5, ...config, apiRoot: (config.apiRoot ?? harvestApiRoot()).replace(/\/+$/, '') };
  }

  #headers(): HeadersInit {
    return {
      Authorization: `Bearer ${this.#config.accessToken}`,
      'Harvest-Account-Id': this.#config.accountId,
      'User-Agent': `No BS Time Tracking migration tool (${this.#config.contact})`,
      Accept: 'application/json',
    };
  }

  /** Space requests so we stay under the rate limit rather than relying on 429 recovery. */
  async #throttle(): Promise<void> {
    const wait = this.#nextAllowedAt - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.#nextAllowedAt = Date.now() + MIN_REQUEST_INTERVAL_MS;
  }

  /** One GET, with retry on 429 and 5xx. Throws HarvestError on anything else non-2xx. */
  async #get(url: string): Promise<unknown> {
    const { maxRetries, onRequest } = this.#config;

    for (let attempt = 0; ; attempt++) {
      await this.#throttle();
      onRequest?.(url);

      let response: Response;
      try {
        response = await fetch(url, { method: 'GET', headers: this.#headers() });
      } catch (cause) {
        // Network-level failure. Retry, because a five-year import shouldn't die on one
        // dropped socket.
        if (attempt >= maxRetries) {
          throw new HarvestError(`Network failure after ${attempt + 1} attempts: ${String(cause)}`, 0, url, '');
        }
        await this.#backoff(attempt);
        continue;
      }

      if (response.ok) return await response.json();

      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < maxRetries) {
        // Harvest sends Retry-After in seconds on 429. Trust it over our own backoff.
        const retryAfter = Number(response.headers.get('Retry-After'));
        if (Number.isFinite(retryAfter) && retryAfter > 0) {
          await new Promise((r) => setTimeout(r, retryAfter * 1000));
        } else {
          await this.#backoff(attempt);
        }
        continue;
      }

      const body = await response.text().catch(() => '');
      throw new HarvestError(
        `${response.status} ${response.statusText} for ${url}`,
        response.status,
        url,
        body.slice(0, 500),
      );
    }
  }

  #backoff(attempt: number): Promise<void> {
    const ms = Math.min(1000 * 2 ** attempt, 30_000);
    return new Promise((r) => setTimeout(r, ms));
  }

  #url(path: string, params: Record<string, string | number | undefined> = {}): string {
    const url = new URL(`${this.#config.apiRoot}${path}`);
    // per_page defaults to 2000, which is also the maximum. Ask for it explicitly so the
    // behaviour is visible rather than inherited.
    url.searchParams.set('per_page', '2000');
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  /**
   * Yield every record from a list endpoint, following `links.next` until it is null.
   *
   * @param path     e.g. `/time_entries`
   * @param resource the key the records sit under, e.g. `time_entries`
   */
  async *paginate<T>(
    path: string,
    resource: string,
    params: Record<string, string | number | undefined> = {},
  ): AsyncGenerator<T, void, undefined> {
    let url: string | null = this.#url(path, params);
    const seen = new Set<string>();

    while (url) {
      // A server bug that pointed `next` back at a page we've already read would otherwise
      // spin forever against a rate-limited API.
      if (seen.has(url)) {
        throw new HarvestError(`Pagination loop detected at ${url}`, 0, url, '');
      }
      seen.add(url);

      const page = (await this.#get(url)) as HarvestPage<T>;
      const records = page[resource];

      if (!Array.isArray(records)) {
        throw new HarvestError(
          `Expected an array under "${resource}", got ${typeof records}. ` +
            `Keys present: ${Object.keys(page).join(', ')}`,
          0,
          url,
          '',
        );
      }

      yield* records as T[];

      // The only pagination source we trust. Never increment `page`.
      url = page.links?.next ?? null;
    }
  }

  /** Collect a whole list endpoint into memory. Fine at agency scale — */
  async list<T>(
    path: string,
    resource: string,
    params: Record<string, string | number | undefined> = {},
  ): Promise<T[]> {
    const out: T[] = [];
    for await (const record of this.paginate<T>(path, resource, params)) out.push(record);
    return out;
  }

  /**
   * Fetch a file Harvest serves behind the same credentials — a receipt. Only from Harvest's
   * own hosts, or the host of the API this client was pointed at: the URL comes out of an API
   * payload, and a payload is data, not an instruction to fetch from anywhere it names.
   */
  async download(url: string): Promise<{ bytes: Uint8Array; contentType: string | null }> {
    const host = new URL(url).host;
    if (!host.endsWith('.harvestapp.com') && host !== new URL(this.#config.apiRoot).host) {
      throw new HarvestError(`Refusing to download from ${host}`, 0, url, '');
    }
    await this.#throttle();
    this.#config.onRequest?.(url);
    // The host check above is worth nothing if a redirect can walk us off it, and a redirect
    // chain is not something a receipt download needs.
    const response = await fetch(url, { headers: this.#headers(), redirect: 'error' });
    if (!response.ok) {
      throw new HarvestError(`${response.status} ${response.statusText} for ${url}`, response.status, url, '');
    }
    return { bytes: new Uint8Array(await response.arrayBuffer()), contentType: response.headers.get('content-type') };
  }

  /** Fetch a single (non-list) resource, e.g. `/company`. */
  async get<T>(path: string): Promise<T> {
    return (await this.#get(this.#url(path))) as T;
  }
}

/** Build a client from environment variables. Never logs the token. */
export function clientFromEnv(env: NodeJS.ProcessEnv = process.env): HarvestClient {
  return new HarvestClient({
    accountId: env.HARVEST_ACCOUNT_ID ?? '',
    accessToken: env.HARVEST_ACCESS_TOKEN ?? '',
    contact: env.HARVEST_CONTACT ?? '',
  });
}
