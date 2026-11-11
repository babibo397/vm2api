// Deterministic synthetic data for tests / browser mocks only. Not imported by src.
export const summary = { requests: 1284, success: 1260, errors: 20, other: 4, input_tokens: 1864500, output_tokens: 428600, cache_read_tokens: 927400, cache_creation_tokens: 85600, total_tokens: 3306100, cost: 12.4268, unpriced_requests: 2 };
export const quotaFixture = {
  key: { name: '开发测试 Key', masked_key: 'sk-demo…0000', status: 'active', expires_at: null, expired: false, created_at: '2026-11-01T00:00:00Z', last_used_at: '2026-11-11T03:25:00Z' },
  usd: { limit: 100, used: 24.8, remaining: 75.2, exceeded: false },
  windows: {}, requests: { limit: null, used: 2048, remaining: null, exceeded: false },
};
export const usageFixture = {
  object: 'api_key_usage_range',
  range: { start: '2026-11-04T16:00:00Z', end: '2026-11-11T03:30:00Z', timezone: 'Asia/Shanghai', bucket: 'day' },
  as_of: '2026-11-11T03:30:00Z',
  coverage: { status: 'unknown', available_from: '2026-11-01T00:00:00Z', missing_before: null, reason: 'retained_logs_only' },
  summary,
  series: [110, 184, 162, 220, 156, 258, 194].map((requests, i) => ({ ...summary, bucket: `2026-11-${String(5 + i).padStart(2, '0')}`, requests, total_tokens: requests * 2300, cost: requests / 100 })),
  models: { items: [
    { ...summary, model: 'claude-sonnet-4-5', requests: 780, cost: 8.1, unpriced_requests: 0 },
    { ...summary, model: 'gpt-5.1', requests: 420, cost: 4.2, unpriced_requests: 0 },
    { ...summary, model: null, requests: 84, cost: 0.1268, unpriced_requests: 2 },
  ], truncated: false, other: null },
  recent: { items: Array.from({ length: 8 }, (_, i) => ({ request_id: `synthetic-request-${String(i + 1).padStart(4, '0')}`, created_at: `2026-11-11T03:${String(25 - i).padStart(2, '0')}:02Z`, model: i % 2 ? 'gpt-5.1' : 'claude-sonnet-4-5', status: i === 3 ? 429 : 200, outcome: i === 3 ? 'error' : 'success', error_code: i === 3 ? 'rate_limit_exceeded' : null, input_tokens: 2300 + i * 100, output_tokens: 640, cache_read_tokens: 1200, cache_creation_tokens: 0, cost: i === 2 ? null : 0.0348, duration_ms: 1240 + i * 37 })), has_more: true, next_cursor: 'synthetic-next-page' },
};
