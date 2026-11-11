const summaryFields = [
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
const recentFields = [
  'request_id',
  'created_at',
  'model',
  'status',
  'outcome',
  'error_code',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_creation_tokens',
  'cost',
  'duration_ms',
]
const limitFields = ['limit', 'used', 'remaining', 'exceeded', 'window_start', 'reset_at']
const pick = (value, fields) => {
  const out = {}
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const k of fields) if (Object.hasOwn(value, k)) out[k] = value[k]
  }
  return out
}

export function projectQuota(value) {
  const windows = {}
  for (const id of ['5h', '1d', '7d']) if (value.windows?.[id]) windows[id] = pick(value.windows[id], limitFields)
  return {
    key: pick(value.key, ['name', 'masked_key', 'status', 'expires_at', 'expired', 'created_at', 'last_used_at']),
    usd: pick(value.usd, limitFields),
    windows,
    requests: pick(value.requests, limitFields),
  }
}

export function projectUsage(value) {
  if (value.object !== 'api_key_usage_range' || !value.range || !value.summary || !value.recent)
    throw new Error('Invalid response')
  return {
    object: 'api_key_usage_range',
    range: pick(value.range, ['start', 'end', 'timezone', 'bucket']),
    as_of: value.as_of,
    coverage: pick(value.coverage, ['status', 'available_from', 'missing_before', 'reason']),
    summary: pick(value.summary, summaryFields),
    series: (Array.isArray(value.series) ? value.series : [])
      .slice(0, 200)
      .map((row) => pick(row, ['bucket', ...summaryFields])),
    models: {
      items: (Array.isArray(value.models?.items) ? value.models.items : [])
        .slice(0, 50)
        .map((row) => pick(row, ['model', ...summaryFields])),
      truncated: value.models?.truncated === true,
      other: value.models?.other ? pick(value.models.other, summaryFields) : null,
    },
    recent: {
      items: (Array.isArray(value.recent.items) ? value.recent.items : [])
        .slice(0, 100)
        .map((row) => pick(row, recentFields)),
      has_more: value.recent.has_more === true,
      next_cursor: typeof value.recent.next_cursor === 'string' ? value.recent.next_cursor : null,
    },
  }
}

export class PortalError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

const errors = {
  400: ['invalid_query', '查询参数无效，请检查时间范围。'],
  401: ['invalid_key', 'Key 无效、已停用或已删除。'],
  403: ['key_not_allowed', '该 Key 无法使用自助查询。'],
  429: ['rate_limited', '查询过于频繁，请稍后再试。'],
  503: ['query_unavailable', '查询服务繁忙，请稍后重试。'],
  504: ['query_timeout', '查询超时，请缩小时间范围后重试。'],
}

async function readJson(response, maxBytes, signal) {
  if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('Oversized response')
  if (!response.body) throw new Error('Empty response')
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  const cancel = () => {
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    if (signal.aborted) throw signal.reason
    while (true) {
      const { done, value } = await reader.read()
      if (signal.aborted) throw signal.reason
      if (done) break
      size += value.byteLength
      if (size > maxBytes) throw new Error('Oversized response')
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally {
    signal.removeEventListener('abort', cancel)
    void reader.cancel().catch(() => {})
  }
}

export async function queryUpstream({
  upstream,
  kind,
  search,
  authorization,
  fetchImpl = fetch,
  timeoutMs = 10000,
  maxResponseBytes = 1024 * 1024,
  signal,
}) {
  const timeout = new AbortController()
  const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal
  const timer = setTimeout(() => timeout.abort(new Error('Deadline')), timeoutMs)
  try {
    const target = new URL(kind === 'quota' ? '/v1/me/quota' : '/v1/me/usage/range', upstream)
    target.search = search
    // No user-controlled host, path, Cookie, panel token, or other forwarded header.
    const response = await fetchImpl(target, {
      headers: { authorization, accept: 'application/json' },
      redirect: 'error',
      signal: combined,
    })
    if (!response.ok) {
      void response.body?.cancel().catch(() => {})
      const [code, message] = errors[response.status] || ['upstream_error', '暂时无法获取用量，请稍后重试。']
      throw new PortalError(errors[response.status] ? response.status : 502, code, message)
    }
    const value = await readJson(response, maxResponseBytes, combined)
    return kind === 'quota' ? projectQuota(value) : projectUsage(value)
  } catch (error) {
    if (timeout.signal.aborted) throw new PortalError(504, ...errors[504])
    if (error instanceof PortalError) throw error
    throw new PortalError(502, 'upstream_error', '暂时无法获取用量，请稍后重试。')
  } finally {
    clearTimeout(timer)
    timeout.abort()
  }
}
