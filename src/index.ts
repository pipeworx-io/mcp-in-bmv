interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Runtime helpers for packs that wrap government open-data platforms.
 *
 * Socrata (SODA), CKAN, and ArcGIS FeatureServer/MapServer between them back a large share
 * of US state and municipal data, and every pack over them re-implements the same fetch,
 * timeout, retry, and shaping code. These helpers are deliberately small and dependency-free
 * so `scripts/publish-pack.sh` can inline them into a standalone published pack.
 *
 * State agency servers are slow and occasionally hostile: expect stalls, WAF interstitials
 * served with a 200 or 403, and columns whose names disagree between two datasets on the same
 * portal. `govFetchJson` therefore retries once by default and raises a message the caller can
 * turn into a `{ found: false, reason, hint }` rather than a bare throw.
 */

const DEFAULT_UA = 'pipeworx-mcp/1.0 (+https://pipeworx.io)';
const DEFAULT_TIMEOUT_MS = 15_000;

interface GovFetchOpts {
  /** Sent as Accept; defaults to application/json. */
  accept?: string;
  /** Socrata app token, sent as X-App-Token. Public endpoints work without one. */
  appToken?: string;
  /** Per-attempt budget. State ArcGIS servers routinely need >12s under load. */
  timeoutMs?: number;
  /** Extra attempts after the first. Defaults to 1. */
  retries?: number;
  userAgent?: string;
}

async function govFetchText(url: string, opts: GovFetchOpts = {}): Promise<string> {
  const retries = opts.retries ?? 1;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const headers: Record<string, string> = {
        'User-Agent': opts.userAgent ?? DEFAULT_UA,
        Accept: opts.accept ?? 'application/json',
      };
      if (opts.appToken) headers['X-App-Token'] = opts.appToken;
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`upstream ${res.status}${body ? `: ${body.slice(0, 180)}` : ''}`);
      }
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function govFetchJson<T = unknown>(url: string, opts: GovFetchOpts = {}): Promise<T> {
  const text = await govFetchText(url, opts);
  try {
    return JSON.parse(text) as T;
  } catch {
    // A WAF interstitial arrives as HTML on the JSON path; say so plainly, because the
    // alternative reads to a caller as our own parsing bug.
    const looksLikeChallenge = /<html|just a moment|captcha/i.test(text.slice(0, 400));
    throw new Error(
      looksLikeChallenge
        ? `upstream returned an HTML challenge page instead of JSON (${text.slice(0, 90).replace(/\s+/g, ' ')})`
        : `upstream returned non-JSON (${text.slice(0, 120)})`,
    );
  }
}

// ── Socrata (SODA 2.x) ──────────────────────────────────────────────

interface SoqlQuery {
  select?: string;
  where?: string;
  group?: string;
  order?: string;
  limit?: number;
  offset?: number;
}

/** Escape a value for interpolation into a SoQL string literal. */
function soqlEscape(v: string): string {
  return v.replace(/'/g, "''");
}

function soqlUrl(domain: string, resource: string, q: SoqlQuery): string {
  const p = new URLSearchParams();
  if (q.select) p.set('$select', q.select);
  if (q.where) p.set('$where', q.where);
  if (q.group) p.set('$group', q.group);
  if (q.order) p.set('$order', q.order);
  p.set('$limit', String(q.limit ?? 1000));
  if (q.offset) p.set('$offset', String(q.offset));
  return `https://${domain}/resource/${resource}.json?${p.toString()}`;
}

async function soqlRows<T = Record<string, string>>(
  domain: string,
  resource: string,
  q: SoqlQuery,
  opts: GovFetchOpts = {},
): Promise<T[]> {
  return govFetchJson<T[]>(soqlUrl(domain, resource, q), opts);
}

/**
 * A Socrata dataset's last row update, as YYYY-MM-DD, for an `as_of` field. Best-effort:
 * resolves to null rather than failing a call that otherwise has data.
 */
async function soqlUpdatedAt(
  domain: string,
  resource: string,
  opts: GovFetchOpts = {},
): Promise<string | null> {
  try {
    const meta = await govFetchJson<{ rowsUpdatedAt?: number }>(
      `https://${domain}/api/views/${resource}.json`,
      { ...opts, retries: 0 },
    );
    return meta.rowsUpdatedAt ? new Date(meta.rowsUpdatedAt * 1000).toISOString().slice(0, 10) : null;
  } catch {
    return null;
  }
}

/** Largest value of a column, e.g. the latest `year_month` a dataset carries. */
async function soqlMax(
  domain: string,
  resource: string,
  column: string,
  opts: GovFetchOpts = {},
): Promise<string | null> {
  try {
    const rows = await soqlRows<Record<string, string>>(
      domain,
      resource,
      { select: `max(${column}) as mx` },
      opts,
    );
    return rows[0]?.mx ?? null;
  } catch {
    return null;
  }
}

// ── CKAN ────────────────────────────────────────────────────────────

/** CKAN's read-only SQL endpoint (datastore_search_sql). */
async function ckanSql<T = Record<string, string>>(
  domain: string,
  sql: string,
  opts: GovFetchOpts = {},
): Promise<T[]> {
  const body = await govFetchJson<{
    success?: boolean;
    result?: { records?: T[] };
    error?: unknown;
  }>(`https://${domain}/api/3/action/datastore_search_sql?sql=${encodeURIComponent(sql)}`, opts);
  if (!body.success || !body.result?.records) {
    throw new Error(`CKAN rejected the query: ${JSON.stringify(body.error ?? {}).slice(0, 200)}`);
  }
  return body.result.records;
}

async function ckanRows<T = Record<string, unknown>>(
  domain: string,
  resourceId: string,
  limit: number,
  opts: GovFetchOpts = {},
): Promise<T[]> {
  const body = await govFetchJson<{ result?: { records?: T[] } }>(
    `https://${domain}/api/3/action/datastore_search?resource_id=${resourceId}&limit=${limit}`,
    opts,
  );
  return body.result?.records ?? [];
}

// ── ArcGIS (FeatureServer / MapServer) ──────────────────────────────

interface ArcgisFeature {
  attributes: Record<string, unknown>;
  geometry?: { x?: number; y?: number };
}

interface ArcgisQueryOpts extends GovFetchOpts {
  where?: string;
  outFields?: string;
  orderBy?: string;
  limit?: number;
  /** Request geometry in WGS84. Many layers store State Plane, so read lat/lng from here
   *  rather than from XCOORD/YCOORD attribute columns. */
  geometry?: boolean;
  distinct?: boolean;
}

async function arcgisQuery(layerUrl: string, o: ArcgisQueryOpts = {}): Promise<ArcgisFeature[]> {
  const p = new URLSearchParams({
    where: o.where ?? '1=1',
    outFields: o.outFields ?? '*',
    returnGeometry: o.geometry ? 'true' : 'false',
    f: 'json',
  });
  if (o.geometry) p.set('outSR', '4326');
  if (o.orderBy) p.set('orderByFields', o.orderBy);
  if (o.limit) p.set('resultRecordCount', String(o.limit));
  if (o.distinct) p.set('returnDistinctValues', 'true');
  const body = await govFetchJson<{ features?: ArcgisFeature[]; error?: { message?: string } }>(
    `${layerUrl}/query?${p.toString()}`,
    o,
  );
  if (body.error) throw new Error(`ArcGIS: ${body.error.message ?? 'query rejected'}`);
  return body.features ?? [];
}

/** Turn "Y"/"Yes"/"true" flag columns into a list of human-readable service labels. */
function arcgisFlagLabels(
  attrs: Record<string, unknown>,
  labelByField: Record<string, string>,
): string[] {
  return Object.entries(labelByField)
    .filter(([field]) => /^(y|yes|true)$/i.test(String(attrs[field] ?? '')))
    .map(([, label]) => label);
}

// ── Small shaping utilities ─────────────────────────────────────────

/** A recoverable "no answer" result. The hint should name something that does work. */
function govNotFound(
  reason: string,
  hint: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { found: false, reason, hint, ...extra };
}

function govNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (s === '') return null;
  // Parse as-is first. Socrata returns an all-zero aggregate as "0E-24", and stripping
  // non-numeric characters turns that into "0-24" → NaN, i.e. a real zero reported as
  // unknown. Number() understands scientific notation, so only fall back to stripping
  // for values carrying formatting (currency symbols, thousands separators).
  const direct = Number(s);
  if (Number.isFinite(direct)) return direct;
  // Require a digit before stripping: otherwise "abc" reduces to "" and Number("") is 0,
  // reporting a parse failure as a real zero.
  if (!/\d/.test(s)) return null;
  const stripped = Number(s.replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(stripped) ? stripped : null;
}

/** Trimmed string argument, or undefined when absent or blank. */
function govString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
}

function govLimit(raw: unknown, def: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

/** Case-insensitive substring test that tolerates a missing haystack. */
function govContains(hay: unknown, needle: string): boolean {
  return typeof hay === 'string' && hay.toLowerCase().includes(needle.toLowerCase());
}

/** Join day/hours pairs into one line, dropping closed and empty days. */
function govJoinHours(parts: Array<[string, unknown]>): string | null {
  const out = parts
    .filter(([, v]) => v && String(v).trim() && !/^closed$/i.test(String(v).trim()))
    .map(([day, v]) => `${day} ${String(v).trim()}`);
  return out.length ? out.join('; ') : null;
}


/**
 * Indiana BMV MCP — Bureau of Motor Vehicles branches, self-service kiosks, BMV Connect
 * locations, motorcycle rider-training (RSI) courses and skills-test sites. Keyless.
 *
 * One pack per state agency: Indiana publishes every location type in a single static JSON
 * file behind its branch map, and the interesting axis is `typeLabel` — a full branch, a
 * kiosk, an RSI training course, a skills-test site — which no other state's office file has.
 * A union schema across states would flatten that away.
 *
 * Source (verified live 2026-07-30):
 *   in.gov BMV branch map — https://www.in.gov/bmv/branch-locations-and-hours/bmv-branch-map/
 *   bmv-branchmap-locations.json. Plain static JSON, no key, no query parameters: the whole
 *   file (160 locations) is fetched and filtered in code.
 *
 * Every tool resolves to a shaped object and never throws; a query that cannot be answered
 * comes back as { found: false, reason, hint }.
 */


const UA = 'pipeworx-mcp-in-bmv/1.0 (+https://pipeworx.io)';
const LOCATIONS_URL =
  'https://www.in.gov/bmv/branch-locations-and-hours/bmv-branch-map/bmv-branchmap-locations.json';

/** Exact `typeLabel` values Indiana publishes, verified live. */
const LOCATION_TYPES = [
  'BMV Branch',
  'BMV Branch + Kiosk',
  'BMV Connect Location',
  'RSI Training Course',
  'RSI Training Course & Skills Test',
  'Skills Test',
];

/** Plain words agents actually pass → a substring that matches Indiana's own labels. */
const TYPE_ALIASES: Record<string, string> = {
  branch: 'BMV Branch',
  branches: 'BMV Branch',
  office: 'BMV Branch',
  kiosk: 'Kiosk',
  'self service': 'Kiosk',
  'self-service': 'Kiosk',
  connect: 'BMV Connect',
  'bmv connect': 'BMV Connect',
  rsi: 'RSI',
  motorcycle: 'RSI',
  'rider training': 'RSI',
  'training course': 'RSI Training Course',
  'skills test': 'Skills Test',
  'road test': 'Skills Test',
};

interface RawLocation {
  id?: string;
  type?: string;
  lat?: number;
  lng?: number;
  name?: string;
  typeLabel?: string;
  address?: { street?: string; city?: string; state?: string; zip?: string };
  website?: string;
  phone?: string;
  hours?: string | null;
  hasKiosk?: boolean;
  courses?: unknown[];
}

const tools: McpToolExport['tools'] = [
  {
    name: 'in_bmv_branches',
    description:
      'Find an Indiana BMV location — the Bureau of Motor Vehicles branches Hoosiers use as the DMV, plus self-service kiosks, BMV Connect locations, motorcycle rider-training (RSI) courses and skills-test sites. Returns street address, phone, opening hours, coordinates, whether the site has a self-service kiosk, and which rider-training courses it runs. Answers "BMV branch in Indianapolis", "closest BMV kiosk to ZIP 46204", "where can I take a motorcycle skills test in Indiana", "BMV hours in Fort Wayne", and "which Indiana BMV branches have self-service kiosks". Covers all 160 published locations in one file.',
    inputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City name, matched as a substring, e.g. "Indianapolis", "Fort Wayne", "Bloomington".' },
        name: { type: 'string', description: 'Location-name substring, e.g. "Greenwood", "ABATE".' },
        zip: { type: 'string', description: 'Five-digit Indiana ZIP code, or a prefix, e.g. "46204" or "462".' },
        location_type: {
          type: 'string',
          description:
            `Location category. Exact labels are ${LOCATION_TYPES.map((t) => `"${t}"`).join(', ')}; plain words also work — "branch", "kiosk", "connect", "motorcycle", "rider training", "skills test".`,
        },
        kiosk_only: { type: ['boolean', 'string'], description: 'Set true to keep only sites with a self-service kiosk (72 of the 160).' },
        limit: { type: ['number', 'string'], description: 'Max locations to return (default 50, max 200).' },
      },
    },
  },
];

async function loadLocations(): Promise<RawLocation[]> {
  const body = await govFetchJson<{ locations?: RawLocation[] }>(LOCATIONS_URL, { userAgent: UA });
  return Array.isArray(body.locations) ? body.locations : [];
}

function truthy(v: unknown): boolean {
  return v === true || /^(1|true|yes|y)$/i.test(String(v ?? ''));
}

async function branches(args: Record<string, unknown>): Promise<unknown> {
  const raw = await loadLocations();
  if (!raw.length) {
    return govNotFound(
      'upstream_empty',
      'in.gov returned no BMV locations; retry once — the branch-map file is static and is not normally empty.',
    );
  }

  const city = govString(args, 'city');
  const name = govString(args, 'name');
  const zip = govString(args, 'zip');
  const rawType = govString(args, 'location_type');
  const typeNeedle = rawType ? TYPE_ALIASES[rawType.toLowerCase()] ?? rawType : undefined;
  const kioskOnly = args.kiosk_only !== undefined && truthy(args.kiosk_only);

  let list = raw;
  if (city) list = list.filter((l) => govContains(l.address?.city, city));
  if (name) list = list.filter((l) => govContains(l.name, name));
  if (zip) list = list.filter((l) => (l.address?.zip ?? '').startsWith(zip));
  if (typeNeedle) list = list.filter((l) => govContains(l.typeLabel, typeNeedle));
  if (kioskOnly) list = list.filter((l) => l.hasKiosk === true);

  if (!list.length) {
    return govNotFound(
      'no_matching_locations',
      `No Indiana BMV location matched those filters. Drop the narrowest one — location_type and zip are the usual culprits — or call with city="Indianapolis" for the 12 locations there. Published categories are ${LOCATION_TYPES.join(', ')}.`,
      {
        filters_applied: { city, name, zip, location_type: typeNeedle, kiosk_only: kioskOnly },
        total_locations: raw.length,
        location_types: LOCATION_TYPES,
      },
    );
  }

  const limit = govLimit(args.limit, 50, 200);
  return {
    state: 'IN',
    agency: 'Indiana Bureau of Motor Vehicles (BMV)',
    source: 'in.gov BMV branch map — bmv-branchmap-locations.json',
    total_locations: raw.length,
    office_count: list.length,
    truncated: list.length > limit,
    location_types: LOCATION_TYPES,
    offices: list.slice(0, limit).map((l) => {
      const services: string[] = [];
      if (l.hasKiosk) services.push('self-service kiosk');
      for (const c of Array.isArray(l.courses) ? l.courses : []) {
        services.push(`rider training: ${String(c)}`);
      }
      return {
        state: 'IN',
        name: String(l.name ?? ''),
        office_type: l.typeLabel ?? null,
        address: l.address?.street ?? null,
        city: l.address?.city ?? null,
        // Indiana publishes no county on this file; the map keys off coordinates.
        county: null,
        zip: l.address?.zip ?? null,
        phone: l.phone ?? null,
        // `hours` is null for 43 of the 160 — RSI courses and skills-test sites schedule
        // by appointment rather than posting counter hours.
        hours: typeof l.hours === 'string' && l.hours.trim() ? l.hours : null,
        latitude: govNumber(l.lat),
        longitude: govNumber(l.lng),
        services,
        // 127 of 160 carry an empty-string website; normalise to null so a caller can
        // test for absence instead of comparing against "".
        url: l.website && String(l.website).trim() ? String(l.website) : null,
        has_kiosk: l.hasKiosk === true,
        courses: (Array.isArray(l.courses) ? l.courses : []).map(String),
        location_id: l.id ?? null,
      };
    }),
    note: 'One file covers full BMV branches, self-service kiosks, BMV Connect locations, motorcycle rider-training (RSI) courses and skills-test sites; filter with location_type. RSI and skills-test sites are run by partner organisations, so their hours are usually absent and their url points at the partner.',
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'in_bmv_branches': return await branches(args);
      default:
        return govNotFound('unknown_tool', `in-bmv exposes ${tools.map((t) => t.name).join(', ')}.`, { requested_tool: name });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      error: `in-bmv/${name}: ${message}`,
      hint: /timeout|abort/i.test(message)
        ? 'in.gov timed out. Retry once — the branch-map file is a single small static JSON, so a stall is transient.'
        : 'in.gov refused the request or changed shape. Retry once; if it persists the BMV branch map may have been republished at a new path.',
    };
  }
}

export default { tools, callTool } satisfies McpToolExport;
export { tools, callTool };
