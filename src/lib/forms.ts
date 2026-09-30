/**
 * Zod helpers for HTML form semantics.
 *
 * Two traps this exists to close, both found by testing rather than by reading:
 *
 *   1. Astro hands absent form fields to the action as `null`, not `undefined`, so a plain
 *      `z.string().optional()` rejects them.
 *   2. `z.coerce.boolean()` is wrong for checkboxes. An unchecked box sends *nothing*, and
 *      `Boolean("false")` is `true` — so a coerced boolean with `.default(true)` can never
 *      become false, which made archiving impossible.
 */

import { z } from 'astro:schema';
import { toMinorUnits } from './db/index.ts';

/**
 * A text field that may arrive blank, absent, or as Astro's `null`, and means "" in all three.
 *
 * `z.string().default('')` looks like it covers this and does not: a default only applies to
 * `undefined`, so the `null` Astro sends for an empty input fails validation before the
 * handler runs. That is what broke starting a timer, which is signalled by submitting the
 * hours box empty.
 */
export const blankableText = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((value) => value ?? '');

/** An unchecked checkbox sends no field at all. Absent means false — never "keep the default". */
export const checkbox = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((value) => value === 'true' || value === 'on' || value === '1');

/** Optional free text: absent, null or blank all collapse to null. */
export const optionalText = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((value) => {
    const text = typeof value === 'string' ? value.trim() : '';
    return text === '' ? null : text;
  });

/** A money field typed by a human. Accepts `1250`, `1250.50` and `1250,50`; stores minor units. */
export const optionalRate = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((value) => {
    if (typeof value !== 'string' || value.trim() === '') return null;
    const parsed = Number(value.replace(',', '.').trim());
    return Number.isFinite(parsed) ? toMinorUnits(parsed) : null;
  });

/** `<input type="date">`: absent or blank is null; anything else must be a real ISO date. */
export const optionalDate = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((value) => {
    const text = typeof value === 'string' ? value.trim() : '';
    return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
  });

/** A whole percentage, clamped to 0–100 — Harvest's over-budget notification threshold. */
export const optionalPercent = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((value) => {
    if (typeof value !== 'string' || value.trim() === '') return null;
    const parsed = Number(value.replace(',', '.').trim());
    return Number.isFinite(parsed) ? Math.min(100, Math.max(0, Math.round(parsed))) : null;
  });

/** Decimal hours typed by a human → integer seconds. */
export const optionalHours = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((value) => {
    if (typeof value !== 'string' || value.trim() === '') return null;
    const parsed = Number(value.replace(',', '.').trim());
    return Number.isFinite(parsed) ? Math.round(parsed * 3600) : null;
  });
