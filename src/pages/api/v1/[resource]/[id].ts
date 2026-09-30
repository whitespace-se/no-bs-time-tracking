/**
 * One record: GET /api/v1/<resource>/<id>
 *
 * The same declaration as the collection, plus whatever that resource says travels with a
 * single record — an invoice's lines and payments, an estimate's lines.
 */

import type { APIRoute } from 'astro';
import { db, row as sqlRow } from '../../../../lib/db/index.ts';
import { badRequest, forbidden, json, notFound } from '../../../../lib/api/http.ts';
import {
  expandRows,
  findResource,
  isPrivileged,
  selectList,
  shape,
  visibleFields,
} from '../../../../lib/api/resources.ts';

export const GET: APIRoute = (context) => {
  const viewer = context.locals.user!;
  const resource = findResource(context.params.resource ?? '');
  if (!resource) return notFound('endpoint');

  if (resource.access === 'privileged' && !isPrivileged(viewer)) {
    return forbidden(`Reading ${resource.name} needs a manager or administrator token.`);
  }

  const id = Number(context.params.id);
  if (!Number.isInteger(id) || id <= 0) return badRequest('The id must be a positive whole number.');

  // The id column is the first declared field on every resource, and a member is still held
  // to their own rows here — an id is guessable, so the scope has to hold on this path too.
  const idColumn = resource.fields[0]!.column;
  const scope = resource.viewerColumn && !isPrivileged(viewer) ? ` AND ${resource.viewerColumn} = ?` : '';
  const args: (string | number)[] = scope ? [id, viewer.id] : [id];

  const fields = visibleFields(resource, viewer);
  const found = sqlRow<Record<string, unknown>>(
    db()
      .prepare(
        `SELECT ${selectList(fields)} ${resource.from}
          WHERE ${idColumn} = ?${scope}${resource.where ? ` AND ${resource.where}` : ''} LIMIT 1`,
      )
      .get(...args),
  );

  if (!found) return notFound(resource.singular.toLowerCase());

  const record = shape(found, fields);
  for (const expand of resource.expand ?? []) {
    record[expand.name] = expandRows(db(), expand, id);
  }

  return json({ data: record });
};
