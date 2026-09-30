/**
 * The OpenAPI document, generated from the same declarations the handlers run.
 *
 * A spec maintained by hand is a spec that is wrong within a month: someone adds a filter,
 * renames a field, tightens a permission, and the document keeps promising the old shape.
 * Here there is nothing to keep in step — every path, parameter and property below is read
 * out of `resources.ts` at request time, so the description cannot disagree with the
 * behaviour without the behaviour changing too.
 *
 * 3.0.3 rather than 3.1: the newer version is better specified, and the tools people actually
 * point at a spec — generators, Postman, older Swagger builds — still handle 3.0 best. The
 * cost is `nullable: true` instead of a type union, which is a fair trade for a document
 * whose whole purpose is to be consumed by other software.
 */

import { DEFAULT_LIMIT, MAX_LIMIT, RATE_LIMIT_PER_MINUTE } from './http.ts';
import { RESOURCES, type Field, type Resource } from './resources.ts';

type Json = Record<string, unknown>;

/** "Time entry" → "TimeEntry", so the schema name is what a generated client will be called. */
function schemaName(singular: string): string {
  return singular
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('')
    .replace(/[^A-Za-z0-9]/g, '');
}

function property(field: Field): Json {
  if (field.json) {
    return {
      type: 'array',
      items: { type: 'string' },
      nullable: true,
      description: field.description,
    };
  }

  const schema: Json = {
    type: field.boolean ? 'boolean' : field.type,
    nullable: true,
    description: field.privileged
      ? `${field.description} Omitted unless the token belongs to a manager or an administrator.`
      : field.description,
  };
  if (field.format) schema.format = field.format;
  // An id is the one thing every record has.
  if (field.name === 'id') {
    schema.nullable = false;
    schema.example = 52786720;
  }
  return schema;
}

function objectSchema(fields: readonly Field[], description: string): Json {
  return {
    type: 'object',
    description,
    properties: Object.fromEntries(fields.map((f) => [f.name, property(f)])),
    required: ['id'],
  };
}

function parameters(resource: Resource): Json[] {
  return resource.filters.map((filter) => ({
    name: filter.name,
    in: 'query',
    required: false,
    description: filter.description,
    schema:
      filter.type === 'integer'
        ? { type: 'integer' }
        : filter.type === 'boolean'
          ? { type: 'boolean' }
          : filter.type === 'date'
            ? { type: 'string', format: 'date' }
            : { type: 'string' },
  }));
}

export function buildOpenApi(origin: string, companyName: string): Json {
  const schemas: Json = {
    Error: {
      type: 'object',
      description: 'Every failure has this shape. Branch on `code`; show `message` to a person.',
      properties: {
        error: {
          type: 'object',
          properties: {
            code: {
              type: 'string',
              description: 'Stable identifier for the failure.',
              enum: ['bad_request', 'unauthorized', 'forbidden', 'not_found', 'rate_limited'],
            },
            message: { type: 'string', description: 'What went wrong, in a sentence.' },
          },
          required: ['code', 'message'],
        },
      },
      required: ['error'],
    },
    Pagination: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'How many records this page holds at most.' },
        offset: { type: 'integer', description: 'How many were skipped.' },
        total: { type: 'integer', description: 'How many match the filters in total.' },
        next: {
          type: 'string',
          nullable: true,
          description: 'The URL of the next page, or null on the last one. Follow it rather than building it.',
        },
      },
      required: ['limit', 'offset', 'total', 'next'],
    },
    Identity: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        email: { type: 'string' },
        name: { type: 'string' },
        role: { type: 'string', enum: ['admin', 'manager', 'member'] },
        privileged: { type: 'boolean', description: 'True for an administrator or a manager.' },
        token: {
          type: 'object',
          nullable: true,
          description: 'The token used, when one was. Null if a browser session was used instead.',
          properties: { id: { type: 'integer' }, name: { type: 'string' } },
        },
        rate_limit_per_minute: { type: 'integer' },
      },
    },
  };

  const paths: Json = {
    '/me': {
      get: {
        tags: ['Identity'],
        summary: 'Who this token belongs to',
        description:
          'The cheapest call there is, and the one to make first: it confirms the token is live ' +
          'and says which permissions it carries.',
        operationId: 'getMe',
        responses: {
          200: {
            description: 'The token’s owner.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { data: { $ref: '#/components/schemas/Identity' } },
                },
              },
            },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
        },
      },
    },
  };

  const tags: Json[] = [{ name: 'Identity', description: 'The token and its owner.' }];

  for (const resource of RESOURCES) {
    const name = schemaName(resource.singular);
    schemas[name] = objectSchema(resource.fields, resource.description);

    // A single record carries its sub-collections; the list does not, so the two schemas
    // differ and are named apart rather than one pretending to be the other.
    let detailSchema: Json = { $ref: `#/components/schemas/${name}` };
    if (resource.expand?.length) {
      for (const expand of resource.expand) {
        const childName = `${name}${schemaName(expand.name.replace(/_/g, ' '))}`;
        schemas[childName] = objectSchema(expand.fields, `A ${expand.name.replace(/_/g, ' ')} of one ${resource.singular.toLowerCase()}.`);
      }
      schemas[`${name}Detail`] = {
        allOf: [
          { $ref: `#/components/schemas/${name}` },
          {
            type: 'object',
            properties: Object.fromEntries(
              resource.expand.map((expand) => [
                expand.name,
                {
                  type: 'array',
                  items: { $ref: `#/components/schemas/${name}${schemaName(expand.name.replace(/_/g, ' '))}` },
                },
              ]),
            ),
          },
        ],
      };
      detailSchema = { $ref: `#/components/schemas/${name}Detail` };
    }

    tags.push({ name: resource.summary, description: resource.description });

    const guarded =
      resource.access === 'privileged'
        ? { 403: { $ref: '#/components/responses/Forbidden' } }
        : {};

    paths[`/${resource.name}`] = {
      get: {
        tags: [resource.summary],
        summary: `List ${resource.summary.toLowerCase()}`,
        description:
          resource.description +
          (resource.viewerColumn
            ? ' A token belonging to a member is confined to their own records, whatever the query says.'
            : ''),
        operationId: `list${schemaName(resource.summary)}`,
        parameters: [
          ...parameters(resource),
          { $ref: '#/components/parameters/limit' },
          { $ref: '#/components/parameters/offset' },
        ],
        responses: {
          200: {
            description: `A page of ${resource.summary.toLowerCase()}.`,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: `#/components/schemas/${name}` } },
                    pagination: { $ref: '#/components/schemas/Pagination' },
                  },
                  required: ['data', 'pagination'],
                },
              },
            },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          ...guarded,
          429: { $ref: '#/components/responses/RateLimited' },
        },
      },
    };

    paths[`/${resource.name}/{id}`] = {
      get: {
        tags: [resource.summary],
        summary: `Fetch one ${resource.singular.toLowerCase()}`,
        description: resource.expand?.length
          ? `Includes ${resource.expand.map((e) => e.name.replace(/_/g, ' ')).join(' and ')}.`
          : `One ${resource.singular.toLowerCase()} by id.`,
        operationId: `get${schemaName(resource.singular)}`,
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: "The record's id.",
            schema: { type: 'integer' },
          },
        ],
        responses: {
          200: {
            description: `One ${resource.singular.toLowerCase()}.`,
            content: {
              'application/json': {
                schema: { type: 'object', properties: { data: detailSchema }, required: ['data'] },
              },
            },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          ...guarded,
          404: { $ref: '#/components/responses/NotFound' },
          429: { $ref: '#/components/responses/RateLimited' },
        },
      },
    };
  }

  const errorContent = { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } };

  return {
    openapi: '3.0.3',
    info: {
      title: `${companyName} time tracking API`,
      version: '1.0.0',
      description: [
        'Read-only access to this instance: time, expenses, projects, clients, people, invoices,',
        'estimates and contacts.',
        '',
        '### Authentication',
        'Send a personal access token as `Authorization: Bearer <token>`. Create one on the',
        'Tokens page of this instance. A token carries exactly the permissions of the person who',
        'made it: a member reads only their own time and expenses and cannot read invoices,',
        'estimates or contacts at all, and rate fields are omitted from every response.',
        '',
        '### Units',
        'Money is an integer in **minor units** — öre, cents — never a decimal, and the currency',
        'travels with it. Durations are integers in **seconds**. `duration_seconds` is what was',
        'entered; `rounded_seconds` is what the account bills after its rounding rule.',
        '',
        '### Dates',
        '`spent_date`, `issue_date` and their kind are plain `YYYY-MM-DD` dates with no timezone,',
        'because an entry logged at 23:30 belongs to that day. Timestamps such as `updated_at` are',
        'UTC and end in `Z`.',
        '',
        '### Paging',
        `\`limit\` defaults to ${DEFAULT_LIMIT} and stops at ${MAX_LIMIT}. Follow \`pagination.next\` rather than`,
        'building the next URL yourself; it is null on the last page.',
        '',
        '### Rate limit',
        `${RATE_LIMIT_PER_MINUTE} requests a minute per token. Every response carries \`RateLimit-Limit\`,`,
        '`RateLimit-Remaining` and `RateLimit-Reset`; over the line you get `429`.',
        '',
        '### Ids',
        'An imported record keeps the id its source system gave it, so links and references from',
        'a Harvest-era system still resolve here. Records created in this instance are numbered',
        'above that range, so the two can never collide.',
      ].join('\n'),
    },
    servers: [{ url: `${origin}/api/v1`, description: 'This instance' }],
    security: [{ bearerAuth: [] }],
    tags,
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'A personal access token from the Tokens page. It begins with `tt_`.',
        },
      },
      parameters: {
        limit: {
          name: 'limit',
          in: 'query',
          required: false,
          description: `How many records to return, 1 to ${MAX_LIMIT}.`,
          schema: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
        },
        offset: {
          name: 'offset',
          in: 'query',
          required: false,
          description: 'How many records to skip.',
          schema: { type: 'integer', minimum: 0, default: 0 },
        },
      },
      responses: {
        BadRequest: { description: 'A parameter was missing, misspelled or the wrong type.', content: errorContent },
        Unauthorized: { description: 'No token, or the token is expired, revoked or unknown.', content: errorContent },
        Forbidden: { description: 'The token is valid but its owner may not read this.', content: errorContent },
        NotFound: { description: 'No such record, or not one this token may see.', content: errorContent },
        RateLimited: { description: 'Too many requests in a minute.', content: errorContent },
      },
      schemas,
    },
  };
}
