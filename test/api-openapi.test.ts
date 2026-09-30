/**
 * The generated OpenAPI document.
 *
 * The point of generating it is that it cannot disagree with the handlers, so most of what
 * follows walks `RESOURCES` and insists the spec says the same thing: every resource has both
 * paths, every declared field is a property, every filter is a parameter, and every `$ref`
 * resolves to something that exists.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOpenApi } from '../src/lib/api/openapi.ts';
import { DEFAULT_LIMIT, MAX_LIMIT, RATE_LIMIT_PER_MINUTE } from '../src/lib/api/http.ts';
import { RESOURCES } from '../src/lib/api/resources.ts';

type Json = Record<string, unknown>;

const ORIGIN = 'https://tracking.example.test';
const COMPANY = 'Synthetic Studio';

const spec = buildOpenApi(ORIGIN, COMPANY) as Json;

// ── local helpers ────────────────────────────────────────────────────────────

function at(root: Json, path: string): Json {
  let node: unknown = root;
  for (const segment of path.split('.')) {
    assert.ok(node && typeof node === 'object', `missing on the way to ${path}: ${segment}`);
    node = (node as Json)[segment];
  }
  assert.ok(node && typeof node === 'object', `missing: ${path}`);
  return node as Json;
}

const paths = at(spec, 'paths');
const components = at(spec, 'components');
const schemas = at(components, 'schemas');

function operation(path: string): Json {
  const entry = paths[path];
  assert.ok(entry, `no path ${path}`);
  return at(entry as Json, 'get');
}

/** Every `$ref` string anywhere in the document. */
function refs(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) for (const item of node) refs(item, found);
  else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Json)) {
      if (key === '$ref' && typeof value === 'string') found.push(value);
      else refs(value, found);
    }
  }
  return found;
}

function listSchemaName(path: string): string {
  const items = at(
    operation(path),
    'responses.200.content.application/json.schema.properties.data.items',
  );
  return String(items.$ref).replace('#/components/schemas/', '');
}

// ── the envelope ─────────────────────────────────────────────────────────────

test('the document is OpenAPI 3.0.3 for this instance, named after the company', () => {
  assert.equal(spec.openapi, '3.0.3');
  const info = at(spec, 'info');
  assert.equal(info.title, `${COMPANY} time tracking API`);
  assert.equal(info.version, '1.0.0');
  assert.deepEqual(spec.servers, [{ url: `${ORIGIN}/api/v1`, description: 'This instance' }]);
  assert.deepEqual(spec.security, [{ bearerAuth: [] }]);
});

test('the prose quotes the real limits rather than repeating them by hand', () => {
  const description = String(at(spec, 'info').description);
  assert.match(description, new RegExp(`\`limit\` defaults to ${DEFAULT_LIMIT} and stops at ${MAX_LIMIT}`));
  assert.match(description, new RegExp(`${RATE_LIMIT_PER_MINUTE} requests a minute per token`));
  assert.match(description, /minor units/);
  assert.match(description, /Authorization: Bearer <token>/);
});

test('the only scheme is a bearer token', () => {
  const scheme = at(components, 'securitySchemes.bearerAuth');
  assert.equal(scheme.type, 'http');
  assert.equal(scheme.scheme, 'bearer');
  assert.match(String(scheme.description), /tt_/);
});

test('limit and offset are declared once, in components, with the real bounds', () => {
  const limit = at(components, 'parameters.limit');
  assert.equal(limit.in, 'query');
  assert.deepEqual(limit.schema, { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT });
  const offset = at(components, 'parameters.offset');
  assert.deepEqual(offset.schema, { type: 'integer', minimum: 0, default: 0 });
});

test('the error schema enumerates exactly the codes the helpers emit', () => {
  const code = at(schemas, 'Error.properties.error.properties.code');
  assert.deepEqual(code.enum, ['bad_request', 'unauthorized', 'forbidden', 'not_found', 'rate_limited']);
  assert.deepEqual(at(schemas, 'Error.properties.error').required, ['code', 'message']);
});

test('the pagination schema promises the four keys the page envelope sends', () => {
  const pagination = at(schemas, 'Pagination');
  assert.deepEqual(Object.keys(at(pagination, 'properties')), ['limit', 'offset', 'total', 'next']);
  assert.deepEqual(pagination.required, ['limit', 'offset', 'total', 'next']);
  assert.equal(at(schemas, 'Pagination.properties.next').nullable, true);
});

test('/me is documented and needs no parameters', () => {
  const me = operation('/me');
  assert.equal(me.operationId, 'getMe');
  assert.equal(me.parameters, undefined);
  assert.ok(at(me, 'responses.401'));
  assert.equal(
    at(me, 'responses.200.content.application/json.schema.properties.data').$ref,
    '#/components/schemas/Identity',
  );
});

// ── one entry per resource ───────────────────────────────────────────────────

test('every resource has a collection path and a single-record path, and nothing else does', () => {
  const expected = ['/me', ...RESOURCES.flatMap((r) => [`/${r.name}`, `/${r.name}/{id}`])];
  assert.deepEqual(Object.keys(paths).sort(), expected.sort());
});

test('every path is a GET only — the API is read-only by design', () => {
  for (const [path, entry] of Object.entries(paths)) {
    assert.deepEqual(Object.keys(entry as Json), ['get'], path);
  }
});

test('every operationId is unique, so a generated client has no name collisions', () => {
  const operationIds = Object.values(paths).map((entry) => String(at(entry as Json, 'get').operationId));
  assert.equal(new Set(operationIds).size, operationIds.length);
  assert.equal(operation('/time-entries').operationId, 'listLoggedTime');
  assert.equal(operation('/time-entries/{id}').operationId, 'getTimeEntry');
  assert.equal(operation('/invoices/{id}').operationId, 'getInvoice');
});

test("each resource's schema carries exactly its declared fields", () => {
  for (const resource of RESOURCES) {
    const name = listSchemaName(`/${resource.name}`);
    const properties = at(schemas, `${name}.properties`);
    assert.deepEqual(
      Object.keys(properties),
      resource.fields.map((f) => f.name),
      `${resource.name} → ${name}`,
    );
    assert.deepEqual(at(schemas, name).required, ['id'], name);

    for (const field of resource.fields) {
      const property = at(properties, field.name) as Json;
      const expectedType = field.json ? 'array' : field.boolean ? 'boolean' : field.type;
      assert.equal(property.type, expectedType, `${name}.${field.name} type`);
      if (field.format) assert.equal(property.format, field.format, `${name}.${field.name} format`);
      if (field.name === 'id') assert.equal(property.nullable, false, `${name}.id is never null`);
      else assert.equal(property.nullable, true, `${name}.${field.name} may be null`);
      assert.ok(String(property.description).startsWith(field.description), `${name}.${field.name}`);
      if (field.privileged) {
        assert.match(String(property.description), /Omitted unless the token belongs to a manager/);
      }
    }
  }
});

test("each resource's filters are its query parameters, plus the shared limit and offset", () => {
  for (const resource of RESOURCES) {
    const parameters = operation(`/${resource.name}`).parameters as Json[];
    const declared = parameters.filter((p) => !p.$ref);
    assert.deepEqual(
      declared.map((p) => p.name),
      resource.filters.map((f) => f.name),
      resource.name,
    );
    for (const [index, filter] of resource.filters.entries()) {
      const parameter = declared[index]!;
      assert.equal(parameter.in, 'query', `${resource.name}?${filter.name}`);
      assert.equal(parameter.required, false);
      assert.equal(parameter.description, filter.description);
      const schema = parameter.schema as Json;
      if (filter.type === 'integer') assert.equal(schema.type, 'integer');
      else if (filter.type === 'boolean') assert.equal(schema.type, 'boolean');
      else if (filter.type === 'date') assert.deepEqual(schema, { type: 'string', format: 'date' });
      else assert.deepEqual(schema, { type: 'string' });
    }
    assert.deepEqual(
      parameters.slice(-2).map((p) => p.$ref),
      ['#/components/parameters/limit', '#/components/parameters/offset'],
      resource.name,
    );
  }
});

test('the single-record path takes one integer id in the path and nothing else', () => {
  for (const resource of RESOURCES) {
    const parameters = operation(`/${resource.name}/{id}`).parameters as Json[];
    assert.equal(parameters.length, 1, resource.name);
    assert.equal(parameters[0]!.name, 'id');
    assert.equal(parameters[0]!.in, 'path');
    assert.equal(parameters[0]!.required, true);
    assert.deepEqual(parameters[0]!.schema, { type: 'integer' });
  }
});

test('a privileged resource documents 403, and an open one does not', () => {
  for (const resource of RESOURCES) {
    for (const path of [`/${resource.name}`, `/${resource.name}/{id}`]) {
      const responses = at(operation(path), 'responses');
      const has403 = '403' in responses;
      assert.equal(has403, resource.access === 'privileged', path);
      assert.ok('401' in responses && '400' in responses && '429' in responses, path);
    }
    assert.ok('404' in at(operation(`/${resource.name}/{id}`), 'responses'), resource.name);
  }
});

test('a member-scoped list says so in its description', () => {
  for (const resource of RESOURCES) {
    const description = String(operation(`/${resource.name}`).description);
    assert.ok(description.startsWith(resource.description), resource.name);
    assert.equal(
      description.includes('A token belonging to a member is confined to their own records'),
      Boolean(resource.viewerColumn),
      resource.name,
    );
  }
});

// ── expansion ────────────────────────────────────────────────────────────────

test('a resource with sub-collections gets a separate Detail schema on the single record', () => {
  for (const resource of RESOURCES) {
    const name = listSchemaName(`/${resource.name}`);
    const detail = at(
      operation(`/${resource.name}/{id}`),
      'responses.200.content.application/json.schema.properties.data',
    );
    if (!resource.expand?.length) {
      assert.equal(detail.$ref, `#/components/schemas/${name}`, resource.name);
      assert.equal(schemas[`${name}Detail`], undefined, resource.name);
      continue;
    }

    assert.equal(detail.$ref, `#/components/schemas/${name}Detail`, resource.name);
    const allOf = at(schemas, `${name}Detail`).allOf as Json[];
    assert.equal(allOf[0]!.$ref, `#/components/schemas/${name}`, 'the detail is the record plus more');
    const extra = at(allOf[1]!, 'properties');
    assert.deepEqual(Object.keys(extra), resource.expand.map((e) => e.name), resource.name);

    for (const expand of resource.expand) {
      const array = at(extra, expand.name);
      assert.equal(array.type, 'array');
      const childName = String(at(array, 'items').$ref).replace('#/components/schemas/', '');
      assert.deepEqual(
        Object.keys(at(schemas, `${childName}.properties`)),
        expand.fields.map((f) => f.name),
        childName,
      );
    }
  }
});

test('the invoice detail names its lines and payments by their generated schema names', () => {
  assert.ok(schemas.InvoiceLineItems, 'InvoiceLineItems');
  assert.ok(schemas.InvoicePayments, 'InvoicePayments');
  assert.ok(schemas.EstimateLineItems, 'EstimateLineItems');
  assert.match(String(operation('/invoices/{id}').description), /Includes line items and payments\./);
  assert.match(String(operation('/estimates/{id}').description), /Includes line items\./);
  assert.match(String(operation('/clients/{id}').description), /^One client by id\.$/);
});

// ── internal consistency ─────────────────────────────────────────────────────

test('every $ref in the document resolves to something declared', () => {
  const all = refs(spec);
  assert.ok(all.length > 0);
  for (const ref of new Set(all)) {
    assert.match(ref, /^#\/components\/(schemas|parameters|responses)\/[A-Za-z0-9]+$/, ref);
    const [, , section, name] = ref.split('/');
    assert.ok(at(components, section!)[name!], `dangling $ref: ${ref}`);
  }
});

test('every schema is reachable, so the document carries nothing dead', () => {
  const referenced = new Set(
    refs(spec).filter((r) => r.startsWith('#/components/schemas/')).map((r) => r.split('/').pop()),
  );
  for (const name of Object.keys(schemas)) assert.ok(referenced.has(name), `${name} is never referenced`);
});

test('every tag used by an operation is described once in the tag list', () => {
  const declared = (spec.tags as Json[]).map((t) => String(t.name));
  assert.equal(new Set(declared).size, declared.length, 'no tag is described twice');
  assert.deepEqual(declared, ['Identity', ...RESOURCES.map((r) => r.summary)]);
  for (const entry of Object.values(paths)) {
    for (const tag of at(entry as Json, 'get').tags as string[]) {
      assert.ok(declared.includes(tag), `undeclared tag ${tag}`);
    }
  }
});

test('every documented error response points at the one error schema', () => {
  for (const name of ['BadRequest', 'Unauthorized', 'Forbidden', 'NotFound', 'RateLimited']) {
    const response = at(components, `responses.${name}`);
    assert.ok(String(response.description).length > 0, name);
    assert.equal(
      at(response, 'content.application/json.schema').$ref,
      '#/components/schemas/Error',
      name,
    );
  }
});

test('the document is plain JSON, with no undefined and no functions in it', () => {
  const text = JSON.stringify(spec);
  assert.deepEqual(JSON.parse(text), spec);
  assert.ok(!text.includes('undefined'));
});

test('the origin is only ever the server URL, so the spec is portable', () => {
  const other = JSON.stringify(buildOpenApi('http://localhost:4321', COMPANY));
  assert.equal(other.split('http://localhost:4321').length - 1, 1);
  assert.match(other, /"url":"http:\/\/localhost:4321\/api\/v1"/);
});
