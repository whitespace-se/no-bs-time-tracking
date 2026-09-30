/**
 * Harvest's API v2, answered from this instance. See lib/harvest-api/serve.ts.
 */

import type { APIRoute } from 'astro';
import { db } from '../../lib/db/index.ts';
import { serveHarvest } from '../../lib/harvest-api/serve.ts';

export const ALL: APIRoute = ({ request, url, params }) => serveHarvest(db(), request, url, params.path ?? '');
