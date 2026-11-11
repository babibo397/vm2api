import { usageBucketLabel } from '../../protocol/key-usage-range.mjs'
import { ERROR_PRED, SUCCESS_PRED, TOTAL_TOKENS_SQL } from './usage-log-preds.mjs'

// requested_model is the original client request. model can be rewritten by protocol mapping.
const MODEL = "NULLIF(requested_model, '')"
// In-flight, disconnected and unknown outcomes are not completed successes.
const OUTCOME = `CASE WHEN error_code IN ('client_cancelled','request_cancelled','client_aborted','selection_cancelled','client_disconnected','request_pending','pending') THEN 'other' WHEN ${ERROR_PRED} THEN 'error' WHEN status >= 200 AND ${SUCCESS_PRED} THEN 'success' ELSE 'other' END`
const AGG = `COUNT(*) AS requests,
  SUM(CASE WHEN ${OUTCOME} = 'success' THEN 1 ELSE 0 END) AS success,
  SUM(CASE WHEN ${OUTCOME} = 'error' THEN 1 ELSE 0 END) AS errors,
  SUM(CASE WHEN ${OUTCOME} = 'other' THEN 1 ELSE 0 END) AS other,
  COALESCE(SUM(input_tokens),0) AS input_tokens,
  COALESCE(SUM(output_tokens),0) AS output_tokens,
  COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens,
  COALESCE(SUM(cache_creation_tokens),0) AS cache_creation_tokens,
  COALESCE(SUM(${TOTAL_TOKENS_SQL}),0) AS total_tokens,
  COALESCE(SUM(actual_cost),0) AS cost,
  SUM(CASE WHEN actual_cost IS NULL THEN 1 ELSE 0 END) AS unpriced_requests`
const FIELDS = [
  'requests',
  'success',
  'errors',
  'other',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_creation_tokens',
  'total_tokens',
  'cost',
  'unpriced_requests',
]
const totals = (row = {}) => Object.fromEntries(FIELDS.map((name) => [name, Number(row[name]) || 0]))

function coverage(db, range) {
  const created = Date.parse(
    db.prepare("SELECT MIN(applied_at) AS t FROM schema_migrations WHERE version = '001'").get()?.t || '',
  )
  let pruned = NaN
  try {
    pruned = Date.parse(
      JSON.parse(
        db.prepare("SELECT value FROM settings WHERE key = 'usage_logs_pruned_through'").get()?.value ?? 'null',
      ),
    )
  } catch {}
  const boundary = Math.max(
    Number.isFinite(created) ? created : -Infinity,
    Number.isFinite(pruned) ? pruned : -Infinity,
  )
  const available = Number.isFinite(boundary) ? new Date(boundary).toISOString() : null
  const partial = available !== null && Date.parse(range.start) < boundary
  return {
    status: partial ? 'partial' : 'unknown',
    available_from: available,
    missing_before: partial ? available : null,
    reason: 'retained_logs_only',
  }
}

/** All sections use the same key/bounds and a single read snapshot; no payload/debug columns selected. */
export function queryKeyUsageRange(db, { apiKeyId, range, limit = 20, before = null, now = Date.now() }) {
  const where = 'api_key_id = ? AND created_at >= ? AND created_at < ?'
  const params = [apiKeyId, range.start, range.end]
  db.function('usage_bucket', { deterministic: true }, (value) => usageBucketLabel(value, range.timezone, range.bucket))
  db.exec('BEGIN')
  try {
    const summary = totals(db.prepare(`SELECT ${AGG} FROM usage_logs WHERE ${where}`).get(...params))
    const series = db
      .prepare(
        `SELECT usage_bucket(created_at) AS bucket, ${AGG} FROM usage_logs WHERE ${where} GROUP BY 1 ORDER BY MIN(created_at)`,
      )
      .all(...params)
      .map((row) => ({ bucket: row.bucket, ...totals(row) }))
    const models = { items: [], truncated: false, other: null }
    // Iterate groups rather than materializing an unbounded model list in JS.
    for (const row of db
      .prepare(
        `SELECT ${MODEL} AS model, ${AGG} FROM usage_logs WHERE ${where} GROUP BY 1 ORDER BY cost DESC, requests DESC, model ASC`,
      )
      .iterate(...params)) {
      if (models.items.length < 50) models.items.push({ model: row.model ?? null, ...totals(row) })
      else {
        models.truncated = true
        models.other ??= totals()
        for (const field of FIELDS) models.other[field] += Number(row[field]) || 0
      }
    }
    const seek = before ? ' AND created_at <= ? AND (created_at < ? OR (created_at = ? AND id < ?))' : ''
    const rows = db
      .prepare(
        `SELECT id, request_id, created_at, ${MODEL} AS model, status, ${OUTCOME} AS outcome, error_code, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, actual_cost, duration_ms FROM usage_logs WHERE ${where}${seek} ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(
        ...params,
        ...(before ? [before.created_at, before.created_at, before.created_at, before.id] : []),
        limit + 1,
      )
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    const recent = {
      items: page.map((row) => ({
        request_id: row.request_id ?? null,
        created_at: row.created_at,
        model: row.model ?? null,
        status: row.status ?? null,
        outcome: row.outcome,
        error_code: row.error_code || null,
        input_tokens: Number(row.input_tokens) || 0,
        output_tokens: Number(row.output_tokens) || 0,
        cache_read_tokens: Number(row.cache_read_tokens) || 0,
        cache_creation_tokens: Number(row.cache_creation_tokens) || 0,
        cost: row.actual_cost == null ? null : Number(row.actual_cost),
        duration_ms: row.duration_ms ?? null,
      })),
      has_more: rows.length > limit,
      next: rows.length > limit ? { created_at: last.created_at, id: last.id } : null,
    }
    const result = {
      object: 'api_key_usage_range',
      range,
      as_of: new Date(now).toISOString(),
      coverage: coverage(db, range),
      summary,
      series,
      models,
      recent,
    }
    db.exec('COMMIT')
    return result
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {}
    throw error
  }
}
