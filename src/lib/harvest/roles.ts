/**
 * Harvest access grants → our permission level.
 *
 * Harvest models access as a *set of grants*, not a single role. Real accounts use
 * nine distinct combinations. This product enforces three levels, so the mapping has to be
 * declared rather than guessed.
 *
 * Every grant is listed explicitly. Substring matching would be wrong: it maps
 * `billable_rates_manager` to manager by accident of spelling rather than by decision, and it
 * would silently mis-map any future grant that happens to contain the word.
 */

export type Level = 'admin' | 'manager' | 'member';

/** Higher wins when a user holds several grants. */
const RANK: Record<Level, number> = { member: 0, manager: 1, admin: 2 };

/**
 * Grants seen in practice, plus the rest of Harvest's documented set.
 * A grant absent from here is treated as member level and reported, so a new Harvest grant
 * surfaces as a decision to make instead of a silent demotion.
 */
export const GRANT_LEVEL: Readonly<Record<string, Level>> = {
  administrator: 'admin',

  manager: 'manager',
  project_manager: 'manager',
  project_creator: 'manager',
  client_and_task_manager: 'manager',
  time_and_expenses_manager: 'manager',
  billable_rates_manager: 'manager',
  managed_projects_invoice_drafter: 'manager',

  member: 'member',
};

export interface RoleMapping {
  level: Level;
  /** Grants we did not recognise. Worth reporting rather than swallowing. */
  unknown: string[];
}

export function mapAccessRoles(grants: readonly string[] | null | undefined): RoleMapping {
  let level: Level = 'member';
  const unknown: string[] = [];

  for (const raw of grants ?? []) {
    const grant = String(raw).toLowerCase().trim();
    if (!grant) continue;

    const mapped = GRANT_LEVEL[grant];
    if (!mapped) {
      unknown.push(grant);
      continue;
    }
    if (RANK[mapped] > RANK[level]) level = mapped;
  }

  return { level, unknown };
}
