/**
 * A receipt file, served from the instance folder.
 *
 * The row says what the file is called and what it is; the folder is `receipts/` inside the
 * instance, so the path is assembled here from a name the importer wrote — never from the
 * URL. A member may open their own receipts; administrators and managers, anyone's.
 */

import type { APIRoute } from 'astro';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { db, row } from '../../../lib/db/index.ts';
import { resolveInstance } from '../../../lib/instance.ts';

export const GET: APIRoute = async (context) => {
  const user = context.locals.user;
  if (!user) return new Response('Unauthorized', { status: 401 });

  const id = Number(context.params.id);
  if (!Number.isInteger(id) || id <= 0) return new Response('Not found', { status: 404 });

  const expense = row<{
    user_id: number;
    receipt_path: string | null;
    receipt_file_name: string | null;
    receipt_content_type: string | null;
  }>(
    db()
      .prepare('SELECT user_id, receipt_path, receipt_file_name, receipt_content_type FROM expenses WHERE id = ?')
      .get(id),
  );
  if (!expense || !expense.receipt_path) return new Response('Not found', { status: 404 });

  const privileged = user.role === 'admin' || user.role === 'manager';
  if (!privileged && expense.user_id !== user.id) {
    return new Response('Not your expense.', { status: 403 });
  }

  const file = join(resolveInstance().dir, 'receipts', basename(expense.receipt_path));
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch {
    return new Response('The receipt file is missing from this instance.', { status: 404 });
  }

  const name = (expense.receipt_file_name ?? basename(file)).replace(/["\r\n]/g, '');
  return new Response(new Uint8Array(bytes), {
    headers: {
      'Content-Type': expense.receipt_content_type ?? 'application/octet-stream',
      'Content-Disposition': `inline; filename="${name}"`,
      'Cache-Control': 'private, max-age=3600',
    },
  });
};
