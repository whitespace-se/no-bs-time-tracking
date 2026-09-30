/**
 * CSV writing.
 *
 * This is the instance owner's exit hatch, available from day one without their having to
 * ask — the honest answer to "what if this project goes away". So it has to work on real
 * data, not on the happy path.
 *
 * Two details that decide whether Excel opens it correctly:
 *   · a UTF-8 BOM, or Excel mangles every non-ASCII name in the account
 *   · CRLF line endings, which the RFC 4180 dialect Excel expects
 */

/** Quote a field when it contains a delimiter, quote, or newline. Quotes double up. */
function escape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(headers: readonly string[], rows: readonly unknown[][]): string {
  const lines = [headers.map(escape).join(','), ...rows.map((row) => row.map(escape).join(','))];
  return `﻿${lines.join('\r\n')}\r\n`;
}

export function csvResponse(filename: string, body: string): Response {
  return new Response(body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      // Quoted, because a company name in the filename may contain a space.
      'Content-Disposition': `attachment; filename="${filename.replaceAll('"', '')}"`,
      'Cache-Control': 'no-store',
    },
  });
}

/** `time-entries-2026-08-26.csv` */
export function stamped(prefix: string, extension = 'csv'): string {
  const today = new Date().toISOString().slice(0, 10);
  return `${prefix}-${today}.${extension}`;
}
