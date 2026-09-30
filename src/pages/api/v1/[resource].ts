/**
 * A collection: GET /api/v1/<resource>
 *
 * One handler for every resource, because the differences between them are data, declared in
 * lib/api/resources.ts, rather than code. The alternative is a file per resource, each a copy
 * of this one, and the copies drift.
 */

import type { APIRoute } from 'astro';
import { db, rows as sqlRows } from '../../../lib/db/index.ts';
import { buildWhere, notFound, forbidden, page, readPaging } from '../../../lib/api/http.ts';
import { findResource, isPrivileged, selectList, shape, visibleFields } from '../../../lib/api/resources.ts';

export const GET: APIRoute = (context) => {
  const viewer = context.locals.user!;
  const resource = findResource(context.params.resource ?? '');
  if (!resource) return notFound('endpoint');

  if (resource.access === 'privileged' && !isPrivileged(viewer)) {
    return forbidden(`Reading ${resource.name} needs a manager or administrator token.`);
  }

  const paging = readPaging(context.url);
  if (paging instanceof Response) return paging;

  const where = buildWhere(resource, context.url, viewer);
  if (where instanceof Response) return where;

  const database = db();
  const total = (
    database.prepare(`SELECT COUNT(*) AS n ${resource.from} WHERE ${where.clause}`).get(...where.args) as { n: number }
  ).n;

  const fields = visibleFields(resource, viewer);
  const found = sqlRows<Record<string, unknown>>(
    database
      .prepare(
        `SELECT ${selectList(fields)} ${resource.from}
          WHERE ${where.clause} ORDER BY ${resource.order} LIMIT ? OFFSET ?`,
      )
      .all(...where.args, paging.limit, paging.offset),
  );

  return page(context, found.map((r) => shape(r, fields)), paging, total);
};
