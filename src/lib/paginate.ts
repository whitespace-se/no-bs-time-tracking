/**
 * Offset pagination for the admin lists.
 *
 * A mature account holds thousands of projects and hundreds of clients. A hard LIMIT with
 * "narrow the search" hides rows and offers no way to reach them; this pages through the
 * whole set instead.
 *
 * Offset paging is right here because the sets are small, sorted server-side, and the user
 * wants numbered pages. Cursor paging would be the answer at a scale this product will not
 * reach inside one instance.
 */

export interface Page {
  page: number;
  perPage: number;
  offset: number;
  total: number;
  pages: number;
  from: number;
  to: number;
  hasPrev: boolean;
  hasNext: boolean;
}

export const PER_PAGE_OPTIONS = [25, 50, 100, 250] as const;
const DEFAULT_PER_PAGE = 50;

export function readPageParams(url: URL): { page: number; perPage: number } {
  const rawPer = Number(url.searchParams.get('per'));
  const perPage = PER_PAGE_OPTIONS.includes(rawPer as (typeof PER_PAGE_OPTIONS)[number])
    ? rawPer
    : DEFAULT_PER_PAGE;
  const rawPage = Number(url.searchParams.get('page'));
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  return { page, perPage };
}

export function paginate(total: number, page: number, perPage: number): Page {
  const pages = Math.max(1, Math.ceil(total / perPage));
  // A page number past the end (bookmark, deleted rows) lands on the last page rather than
  // showing an empty table.
  const current = Math.min(page, pages);
  const offset = (current - 1) * perPage;
  return {
    page: current,
    perPage,
    offset,
    total,
    pages,
    from: total === 0 ? 0 : offset + 1,
    to: Math.min(offset + perPage, total),
    hasPrev: current > 1,
    hasNext: current < pages,
  };
}

/** Rebuild the current query string with some params replaced. Keeps filters while paging. */
export function pageHref(url: URL, changes: Record<string, string | number | null>): string {
  const params = new URLSearchParams(url.search);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === '') params.delete(key);
    else params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `${url.pathname}?${query}` : url.pathname;
}

/**
 * Page numbers to render: always the first and last, plus a window around the current one,
 * with nulls marking gaps. `[1, null, 7, 8, 9, null, 41]`
 */
export function pageNumbers(current: number, pages: number, window = 2): (number | null)[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);

  const shown = new Set<number>([1, pages]);
  for (let i = current - window; i <= current + window; i++) {
    if (i > 0 && i <= pages) shown.add(i);
  }

  const sorted = [...shown].sort((a, b) => a - b);
  const out: (number | null)[] = [];
  let previous = 0;
  for (const number of sorted) {
    if (previous && number - previous > 1) out.push(null);
    out.push(number);
    previous = number;
  }
  return out;
}
