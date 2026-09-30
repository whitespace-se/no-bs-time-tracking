/**
 * What the JSON API exposes: the declarations in lib/api/resources.ts, and the SQL they
 * generate, run against a real database.
 *
 * The two handlers (pages/api/v1/[resource].ts and its [id].ts) are four lines of glue over
 * these helpers, so the queries are assembled here the same way and executed for every
 * declared resource — a renamed column or a typo in a JOIN fails here rather than in
 * production.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionUser } from '../src/lib/auth/session.ts';
import type { Db } from '../src/lib/db/index.ts';
import { rows } from '../src/lib/db/index.ts';
import { buildWhere, readPaging } from '../src/lib/api/http.ts';
import type { Field, Resource } from '../src/lib/api/resources.ts';
import {
  RESOURCES,
  expandRows,
  findResource,
  isPrivileged,
  selectList,
  shape,
  visibleFields,
} from '../src/lib/api/resources.ts';
import { STAMP, addEntry, plain, seedBasics, tempDb } from './fixture.ts';

// ── viewers ──────────────────────────────────────────────────────────────────

const ADMIN: SessionUser = { id: 1, email: 'ada@example.test', name: 'Ada Example', role: 'admin' };
const MANAGER: SessionUser = { id: 3, email: 'mia@example.test', name: 'Mia Example', role: 'manager' };
/** Bob, id 2 in seedBasics. */
const MEMBER: SessionUser = { id: 2, email: 'bob@example.test', name: 'Bob Example', role: 'member' };

// ── the account under test ───────────────────────────────────────────────────

/**
 * seedBasics, plus one of everything the privileged resources read. Ids stay in the
 * fixture's range: clients 10/11, projects 100/101, tasks 200/201, users 1/2.
 */
function seedAll(db: Db): void {
  seedBasics(db);
  db.exec(`
    INSERT INTO users (id, email, first_name, last_name, role, is_active, access_roles,
                       default_billable_rate, cost_rate, created_at, updated_at)
    VALUES (3, 'mia@example.test', 'Mia', 'Example', 'manager', 1, '["manager"]',
            95000, 60000, '${STAMP}', '${STAMP}');
    -- Ada's grants are stored as text that is not JSON, to prove shape() survives it.
    UPDATE users SET access_roles = 'administrator' WHERE id = 1;

    INSERT INTO contacts (id, client_id, title, first_name, last_name, email,
                          invoice_recipient_status, created_at, updated_at)
    VALUES (400, 10, 'Head of Ops', 'Cleo', 'Buyer', 'cleo@alpha.example.test', 'primary',
            '${STAMP}', '${STAMP}');

    INSERT INTO expense_categories (id, name, unit_name, unit_price, is_active, created_at, updated_at)
    VALUES (500, 'Travel', 'km', 250, 1, '${STAMP}', '${STAMP}');

    INSERT INTO expenses (id, spent_date, user_id, project_id, client_id, expense_category_id,
                          notes, units, total_cost, billable, reimbursement, is_billed,
                          receipt_file_name, receipt_path, created_at, updated_at)
    VALUES (600, '2026-01-05', 1, 100, 10, 500, 'Train', 120, 30000, 1, 1, 0,
            'ticket.pdf', '600.pdf', '${STAMP}', '${STAMP}'),
           (601, '2026-01-06', 2, 101, 11, 500, 'Taxi', 12, 25000, 0, 1, 0,
            NULL, NULL, '${STAMP}', '${STAMP}');

    INSERT INTO invoices (id, client_id, number, state, currency, amount, due_amount,
                          tax_rate, tax_amount, issue_date, due_date, creator_name,
                          created_at, updated_at)
    VALUES (700, 10, 'A-1', 'open', 'SEK', 125000, 125000, 25, 25000, '2026-01-31',
            '2026-02-28', 'Ada Example', '${STAMP}', '${STAMP}'),
           (701, 11, 'A-2', 'paid', 'EUR', 50000, 0, NULL, 0, '2026-02-28',
            NULL, NULL, '${STAMP}', '${STAMP}');

    INSERT INTO invoice_line_items (id, invoice_id, project_id, position, kind, description,
                                    quantity, unit_price, amount, taxed)
    VALUES (710, 700, 100, 1, 'Service', 'Second line', 1, 25000, 25000, 1),
           (711, 700, NULL, 0, 'Service', 'First line', 4, 25000, 100000, 1);

    INSERT INTO invoice_payments (id, invoice_id, amount, paid_at, paid_date, recorded_by,
                                  transaction_reference, created_at, updated_at)
    VALUES (720, 701, 20000, '2026-03-02T10:00:00Z', '2026-03-02', 'Ada Example', 'ref-2',
            '${STAMP}', '${STAMP}'),
           (721, 701, 30000, '2026-03-01T10:00:00Z', '2026-03-01', 'Ada Example', 'ref-1',
            '${STAMP}', '${STAMP}');

    INSERT INTO estimates (id, client_id, number, state, currency, amount, issue_date,
                           created_at, updated_at)
    VALUES (800, 10, 'E-1', 'accepted', 'SEK', 400000, '2026-01-02', '${STAMP}', '${STAMP}');

    INSERT INTO estimate_line_items (id, estimate_id, position, kind, description, quantity,
                                     unit_price, amount)
    VALUES (810, 800, 0, 'Service', 'Discovery', 10, 40000, 400000);
  `);
  addEntry(db, { id: 900, date: '2026-01-05', user: 1, project: 100, task: 200, seconds: 3600, billableRate: 120000 });
  addEntry(db, { id: 901, date: '2026-01-06', user: 2, project: 100, task: 201, seconds: 1800, billable: false });
  addEntry(db, { id: 902, date: '2026-01-07', user: 2, project: 101, task: 200, seconds: 5400, notes: 'Retainer work' });
}

function withAccount<T>(fn: (db: Db) => T): T {
  const fixture = tempDb();
  try {
    seedAll(fixture.db);
    return fn(fixture.db);
  } finally {
    fixture.cleanup();
  }
}

// ── the handlers, in miniature ───────────────────────────────────────────────

interface Listing {
  data: Record<string, unknown>[];
  total: number;
}

/** The body of pages/api/v1/[resource].ts, minus the HTTP. */
function list(db: Db, resource: Resource, viewer: SessionUser, query = ''): Listing {
  const url = new URL(`https://x.test/api/v1/${resource.name}${query}`);
  const paging = readPaging(url);
  assert.ok(!(paging instanceof Response), 'paging was refused');
  const where = buildWhere(resource, url, viewer);
  assert.ok(!(where instanceof Response), 'the filters were refused');

  const total = (
    db.prepare(`SELECT COUNT(*) AS n ${resource.from} WHERE ${where.clause}`).get(...where.args) as { n: number }
  ).n;
  const fields = visibleFields(resource, viewer);
  const found = rows<Record<string, unknown>>(
    db
      .prepare(
        `SELECT ${selectList(fields)} ${resource.from}
          WHERE ${where.clause} ORDER BY ${resource.order} LIMIT ? OFFSET ?`,
      )
      .all(...where.args, paging.limit, paging.offset),
  );
  return { data: found.map((r) => shape(r, fields)), total };
}

/** The body of pages/api/v1/[resource]/[id].ts, minus the HTTP. */
function get(db: Db, resource: Resource, viewer: SessionUser, id: number): Record<string, unknown> | null {
  const idColumn = resource.fields[0]!.column;
  const scope = resource.viewerColumn && !isPrivileged(viewer) ? ` AND ${resource.viewerColumn} = ?` : '';
  const args: (string | number)[] = scope ? [id, viewer.id] : [id];
  const fields = visibleFields(resource, viewer);
  const found = db
    .prepare(
      `SELECT ${selectList(fields)} ${resource.from}
        WHERE ${idColumn} = ?${scope}${resource.where ? ` AND ${resource.where}` : ''} LIMIT 1`,
    )
    .get(...args) as Record<string, unknown> | undefined;
  if (!found) return null;
  const record = shape(found, fields);
  for (const expand of resource.expand ?? []) record[expand.name] = expandRows(db, expand, id);
  return record;
}

function resource(name: string): Resource {
  const found = findResource(name);
  assert.ok(found, `${name} must be declared`);
  return found;
}

function ids(listing: Listing): unknown[] {
  return listing.data.map((r) => r.id);
}

// ── the declaration itself ───────────────────────────────────────────────────

test('the declared resources are the nine the API documents, each named once', () => {
  assert.deepEqual(
    RESOURCES.map((r) => r.name),
    ['time-entries', 'expenses', 'clients', 'projects', 'tasks', 'users', 'invoices', 'estimates', 'contacts'],
  );
  assert.equal(new Set(RESOURCES.map((r) => r.name)).size, RESOURCES.length);
  assert.equal(new Set(RESOURCES.map((r) => r.singular)).size, RESOURCES.length);
});

test('every resource is coherent: an id first, unique field and filter names, real access', () => {
  for (const r of RESOURCES) {
    assert.equal(r.fields[0]?.name, 'id', `${r.name} must lead with its id`);
    assert.ok(r.from.trimStart().startsWith('FROM '), `${r.name}.from must start with FROM`);
    assert.ok(r.order.length > 0, `${r.name} must declare an order`);
    assert.ok(['everyone', 'privileged'].includes(r.access), `${r.name} access`);
    assert.ok(r.description.length > 0 && r.summary.length > 0, `${r.name} is described`);

    const fieldNames = r.fields.map((f) => f.name);
    assert.equal(new Set(fieldNames).size, fieldNames.length, `${r.name} has unique field names`);
    const filterNames = r.filters.map((f) => f.name);
    assert.equal(new Set(filterNames).size, filterNames.length, `${r.name} has unique filter names`);
    assert.ok(!filterNames.includes('limit') && !filterNames.includes('offset'), `${r.name} filters`);

    for (const f of r.fields) {
      assert.ok(f.column.length > 0 && f.description.length > 0, `${r.name}.${f.name}`);
      assert.ok(['integer', 'number', 'string', 'boolean'].includes(f.type), `${r.name}.${f.name} type`);
    }
    for (const f of r.filters) {
      assert.ok(['=', '>=', '<=', 'like'].includes(f.op), `${r.name}?${f.name} op`);
    }
  }
});

test('a privileged-only resource never also scopes by viewer, and vice versa', () => {
  for (const r of RESOURCES) {
    if (r.access === 'privileged') {
      assert.equal(r.viewerColumn, undefined, `${r.name} refuses a member outright`);
    }
  }
  assert.equal(resource('time-entries').viewerColumn, 't.user_id');
  assert.equal(resource('expenses').viewerColumn, 'e.user_id');
  assert.deepEqual(
    RESOURCES.filter((r) => r.access === 'privileged').map((r) => r.name),
    ['invoices', 'estimates', 'contacts'],
  );
});

test('an unknown resource name simply is not found', () => {
  for (const name of ['', 'nope', 'time_entries', 'Time-Entries', 'users/1', 'openapi']) {
    assert.equal(findResource(name), undefined, name);
  }
  assert.equal(findResource('users')?.singular, 'Person');
});

test('isPrivileged is true for an admin and a manager only', () => {
  assert.equal(isPrivileged(ADMIN), true);
  assert.equal(isPrivileged(MANAGER), true);
  assert.equal(isPrivileged(MEMBER), false);
});

// ── field selection and shaping ──────────────────────────────────────────────

test('selectList aliases each column to the JSON name, quoted', () => {
  const fields: Field[] = [
    { name: 'id', column: 't.id', type: 'integer', description: 'Id.' },
    { name: 'user_name', column: "TRIM(u.first_name || ' ' || u.last_name)", type: 'string', description: 'Name.' },
  ];
  assert.equal(selectList(fields), `t.id AS "id", TRIM(u.first_name || ' ' || u.last_name) AS "user_name"`);
});

test('a member never sees a rate or a cost, on any resource', () => {
  for (const r of RESOURCES) {
    const privileged = r.fields.filter((f) => f.privileged).map((f) => f.name);
    const forMember = visibleFields(r, MEMBER).map((f) => f.name);
    const forAdmin = visibleFields(r, ADMIN).map((f) => f.name);
    assert.deepEqual(forAdmin, r.fields.map((f) => f.name), `${r.name}: an admin sees everything`);
    for (const name of privileged) assert.ok(!forMember.includes(name), `${r.name}.${name} leaked to a member`);
    assert.equal(forMember.length + privileged.length, r.fields.length, r.name);
  }
  assert.deepEqual(
    resource('time-entries').fields.filter((f) => f.privileged).map((f) => f.name),
    ['billable_rate', 'cost_rate'],
  );
  assert.deepEqual(
    resource('projects').fields.filter((f) => f.privileged).map((f) => f.name),
    ['hourly_rate', 'fee', 'budget_seconds', 'budget_amount', 'budget_is_monthly'],
  );
});

test('shape fills in every declared field, turns 0/1 into booleans and parses JSON', () => {
  const fields: Field[] = [
    { name: 'id', column: 'x.id', type: 'integer', description: 'Id.' },
    { name: 'flag', column: 'x.flag', type: 'boolean', boolean: true, description: 'Flag.' },
    { name: 'off', column: 'x.off', type: 'boolean', boolean: true, description: 'Flag.' },
    { name: 'grants', column: 'x.grants', type: 'string', json: true, description: 'Grants.' },
    { name: 'missing', column: 'x.missing', type: 'string', description: 'Absent from the row.' },
  ];
  const shaped = shape({ id: 7, flag: 1, off: 0, grants: '["administrator"]' }, fields);
  assert.deepEqual(plain(shaped), {
    id: 7,
    flag: true,
    off: false,
    grants: ['administrator'],
    missing: null,
  });
  assert.ok(Object.values(shaped).every((v) => v !== undefined), 'no undefined reaches JSON');
});

test('shape answers null rather than throwing on a null or unparseable JSON column', () => {
  const fields: Field[] = [
    { name: 'grants', column: 'x.grants', type: 'string', json: true, description: 'Grants.' },
  ];
  assert.deepEqual(plain(shape({ grants: null }, fields)), { grants: null });
  assert.deepEqual(plain(shape({ grants: 'administrator' }, fields)), { grants: null });
  assert.deepEqual(plain(shape({}, fields)), { grants: null });
});

// ── every resource, executed ─────────────────────────────────────────────────

test('every resource lists for an admin, with exactly its declared fields', () =>
  withAccount((db) => {
    for (const r of RESOURCES) {
      const listing = list(db, r, ADMIN);
      assert.ok(listing.total > 0, `${r.name} should have seeded rows`);
      assert.equal(listing.data.length, listing.total, `${r.name} fits on one page`);
      for (const record of listing.data) {
        assert.deepEqual(
          Object.keys(record),
          r.fields.map((f) => f.name),
          `${r.name} answers exactly what it declares, in order`,
        );
      }
    }
  }));

test('every resource lists for a member without its privileged fields', () =>
  withAccount((db) => {
    for (const r of RESOURCES) {
      // The handler refuses a member on a privileged resource before any SQL runs.
      if (r.access === 'privileged') continue;
      const listing = list(db, r, MEMBER);
      for (const record of listing.data) {
        assert.deepEqual(Object.keys(record), visibleFields(r, MEMBER).map((f) => f.name), r.name);
        for (const field of r.fields.filter((f) => f.privileged)) {
          assert.ok(!(field.name in record), `${r.name}.${field.name} leaked`);
        }
      }
    }
  }));

test('every resource fetches one record by id, and answers nothing for an unknown one', () =>
  withAccount((db) => {
    for (const r of RESOURCES) {
      const first = list(db, r, ADMIN).data[0]!;
      const one = get(db, r, ADMIN, Number(first.id));
      assert.ok(one, `${r.name} by id`);
      assert.equal(one.id, first.id);
      assert.equal(get(db, r, ADMIN, 999_999), null, `${r.name} unknown id`);
    }
  }));

test('a time entry carries the shape the API documents', () =>
  withAccount((db) => {
    const entry = get(db, resource('time-entries'), ADMIN, 900);
    assert.ok(entry);
    assert.deepEqual(plain(entry), {
      id: 900,
      spent_date: '2026-01-05',
      user_id: 1,
      user_name: 'Ada Example',
      client_id: 10,
      client_name: 'Alpha Client',
      project_id: 100,
      project_code: 'WEB',
      project_name: 'Website',
      task_id: 200,
      task_name: 'Development',
      duration_seconds: 3600,
      rounded_seconds: 3600,
      notes: null,
      billable: true,
      billable_rate: 120000,
      cost_rate: null,
      is_billed: false,
      invoice_id: null,
      is_locked: false,
      locked_reason: null,
      approval_status: 'unsubmitted',
      is_running: false,
      created_at: STAMP,
      updated_at: STAMP,
    });
  }));

test('a project without a code answers null there rather than omitting it', () =>
  withAccount((db) => {
    const project = get(db, resource('projects'), ADMIN, 101);
    assert.ok(project);
    assert.equal(project.code, null);
    assert.equal(project.client_name, 'Beta Client');
    assert.equal(project.is_active, true);
    assert.equal(project.is_fixed_fee, false, '0 becomes false, not 0');
  }));

test("a person's Harvest grants come back as an array, and unparseable text as null", () =>
  withAccount((db) => {
    const mia = get(db, resource('users'), ADMIN, 3);
    assert.ok(mia);
    assert.deepEqual(mia.access_roles, ['manager']);
    assert.equal(mia.default_billable_rate, 95000);

    const ada = get(db, resource('users'), ADMIN, 1);
    assert.equal(ada?.access_roles, null, 'text that is not JSON is null, never a crash');
  }));

test('an expense says where its receipt is served, and null when there is none', () =>
  withAccount((db) => {
    const withFile = get(db, resource('expenses'), ADMIN, 600);
    assert.equal(withFile?.receipt_url, '/expenses/600/receipt');
    assert.equal(withFile?.receipt_file_name, 'ticket.pdf');
    assert.equal(withFile?.category_name, 'Travel');
    assert.equal(withFile?.units, 120);

    const withoutFile = get(db, resource('expenses'), ADMIN, 601);
    assert.equal(withoutFile?.receipt_url, null);
    assert.equal(withoutFile?.billable, false);
  }));

// ── scoping ──────────────────────────────────────────────────────────────────

test("a member's list holds only their own time and expenses", () =>
  withAccount((db) => {
    const entries = list(db, resource('time-entries'), MEMBER);
    assert.deepEqual(ids(entries), [902, 901], 'newest day first');
    assert.equal(entries.total, 2, 'the total is scoped too, or paging would lie');

    const expenses = list(db, resource('expenses'), MEMBER);
    assert.deepEqual(ids(expenses), [601]);
  }));

test('a member cannot widen the scope with a filter', () =>
  withAccount((db) => {
    const entries = list(db, resource('time-entries'), MEMBER, '?user_id=1');
    assert.deepEqual(ids(entries), [], 'asking for someone else answers nothing');
    assert.equal(entries.total, 0);
  }));

test("a member cannot fetch another person's record by guessing its id", () =>
  withAccount((db) => {
    assert.equal(get(db, resource('time-entries'), MEMBER, 900), null, "Ada's entry");
    assert.ok(get(db, resource('time-entries'), MEMBER, 901), 'their own entry');
    assert.equal(get(db, resource('expenses'), MEMBER, 600), null);
    assert.ok(get(db, resource('expenses'), MEMBER, 601));
  }));

test('an admin and a manager see everyone', () =>
  withAccount((db) => {
    for (const viewer of [ADMIN, MANAGER]) {
      assert.deepEqual(ids(list(db, resource('time-entries'), viewer)), [902, 901, 900]);
      assert.equal(list(db, resource('expenses'), viewer).total, 2);
    }
  }));

test('an unscoped resource is the same list for everyone', () =>
  withAccount((db) => {
    for (const name of ['clients', 'projects', 'tasks', 'users']) {
      assert.deepEqual(
        ids(list(db, resource(name), MEMBER)),
        ids(list(db, resource(name), ADMIN)),
        name,
      );
    }
  }));

// ── filters and paging, through real SQL ─────────────────────────────────────

test('filters narrow the list and the total together', () =>
  withAccount((db) => {
    const entries = resource('time-entries');
    assert.deepEqual(ids(list(db, entries, ADMIN, '?project_id=100')), [901, 900]);
    assert.deepEqual(ids(list(db, entries, ADMIN, '?client_id=11')), [902]);
    assert.deepEqual(ids(list(db, entries, ADMIN, '?billable=false')), [901]);
    assert.deepEqual(ids(list(db, entries, ADMIN, '?from=2026-01-06&to=2026-01-06')), [901]);
    assert.deepEqual(ids(list(db, entries, ADMIN, '?task_id=201&user_id=2')), [901]);
    assert.equal(list(db, entries, ADMIN, '?project_id=100').total, 2);
    assert.equal(list(db, entries, ADMIN, '?from=2027-01-01').total, 0);
  }));

test('a LIKE filter matches a substring, not a prefix', () =>
  withAccount((db) => {
    assert.deepEqual(ids(list(db, resource('clients'), ADMIN, '?name=lpha')), [10]);
    assert.deepEqual(ids(list(db, resource('projects'), ADMIN, '?code=EB')), [100]);
    assert.deepEqual(ids(list(db, resource('users'), ADMIN, '?email=bob@')), [2]);
  }));

test('updated_since answers only what changed at or after the moment given', () =>
  withAccount((db) => {
    db.prepare("UPDATE clients SET updated_at = '2026-06-01T12:00:00Z' WHERE id = 11").run();
    const clients = resource('clients');
    assert.deepEqual(ids(list(db, clients, ADMIN, '?updated_since=2026-06-01T12:00:00Z')), [11], 'inclusive');
    assert.deepEqual(ids(list(db, clients, ADMIN, '?updated_since=2026-06-02')), []);
    assert.equal(list(db, clients, ADMIN, '?updated_since=2020-01-01').total, 2);
  }));

test('paging walks the list without repeating or skipping a record', () =>
  withAccount((db) => {
    const entries = resource('time-entries');
    const all = ids(list(db, entries, ADMIN));
    const seen: unknown[] = [];
    for (let offset = 0; offset < all.length; offset += 2) {
      const chunk = list(db, entries, ADMIN, `?limit=2&offset=${offset}`);
      assert.equal(chunk.total, all.length, 'the total ignores the window');
      seen.push(...ids(chunk));
    }
    assert.deepEqual(seen, all);
    assert.deepEqual(ids(list(db, entries, ADMIN, '?limit=2&offset=99')), []);
  }));

test('the declared order is what comes back', () =>
  withAccount((db) => {
    // clients: active first, then by name; projects: active first, then client, then name.
    db.prepare('UPDATE clients SET is_active = 0 WHERE id = 10').run();
    assert.deepEqual(ids(list(db, resource('clients'), ADMIN)), [11, 10]);
    assert.deepEqual(ids(list(db, resource('tasks'), ADMIN)), [200, 201]);
    assert.deepEqual(ids(list(db, resource('invoices'), ADMIN)), [701, 700], 'newest issue date first');
  }));

// ── expansion ────────────────────────────────────────────────────────────────

test('an invoice arrives with its lines in position order and its payments by date', () =>
  withAccount((db) => {
    const invoice = get(db, resource('invoices'), ADMIN, 700);
    assert.ok(invoice);
    assert.equal(invoice.number, 'A-1');
    assert.equal(invoice.client_name, 'Alpha Client');
    assert.equal(invoice.tax_rate, 25);
    const lines = invoice.line_items as Record<string, unknown>[];
    assert.deepEqual(lines.map((l) => l.description), ['First line', 'Second line']);
    assert.deepEqual(lines.map((l) => l.id), [711, 710]);
    assert.equal(lines[0]!.project_name, null, 'a line need not name a project');
    assert.equal(lines[1]!.project_name, 'Website');
    assert.equal(lines[1]!.taxed, true);
    assert.deepEqual(invoice.payments, [], 'this invoice was never paid');

    const paid = get(db, resource('invoices'), ADMIN, 701);
    const payments = paid!.payments as Record<string, unknown>[];
    assert.deepEqual(payments.map((p) => p.id), [721, 720], 'oldest payment first');
    assert.equal(payments[0]!.transaction_reference, 'ref-1');
  }));

test('an estimate arrives with its lines, and nothing else expands', () =>
  withAccount((db) => {
    const estimate = get(db, resource('estimates'), ADMIN, 800);
    assert.ok(estimate);
    const lines = estimate.line_items as Record<string, unknown>[];
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.description, 'Discovery');
    assert.equal(lines[0]!.amount, 400000);
    assert.equal('payments' in estimate, false);

    for (const r of RESOURCES) {
      if (r.name === 'invoices' || r.name === 'estimates') assert.ok(r.expand?.length, r.name);
      else assert.equal(r.expand, undefined, `${r.name} expands nothing`);
    }
  }));

test('expandRows answers an empty list for a parent with no children', () =>
  withAccount((db) => {
    const invoices = resource('invoices');
    const lines = invoices.expand![0]!;
    assert.deepEqual(expandRows(db, lines, 701), []);
    assert.equal(expandRows(db, lines, 700).length, 2);
    assert.deepEqual(
      Object.keys(expandRows(db, lines, 700)[0]!),
      lines.fields.map((f) => f.name),
    );
  }));

test('a contact belongs to its client and says whether it is invoiced', () =>
  withAccount((db) => {
    const contact = get(db, resource('contacts'), ADMIN, 400);
    assert.equal(contact?.client_name, 'Alpha Client');
    assert.equal(contact?.invoice_recipient_status, 'primary');
    assert.deepEqual(ids(list(db, resource('contacts'), ADMIN, '?client_id=11')), []);
  }));
