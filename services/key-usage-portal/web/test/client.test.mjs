import test from 'node:test';
import assert from 'node:assert/strict';
import { createUsageClient } from '../src/client.mjs';

const range = { from: '2026-11-01', to: '2026-11-01', bucket: 'hour' };
const empty = { requests: 0, success: 0, errors: 0, other: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, total_tokens: 0, cost: 0, unpriced_requests: 0 };
const usage = (name = 'first') => ({ object: 'api_key_usage_range', range: { start: '2026-10-31T16:00:00Z', end: '2026-11-01T03:00:00Z', timezone: 'Asia/Shanghai', bucket: 'hour' }, as_of: '2026-11-01T03:00:00Z', coverage: { status: 'unknown', available_from: null, missing_before: null, reason: 'retained_logs_only' }, summary: empty, series: [], models: { items: [], truncated: false, other: null }, recent: { items: [{ request_id: name, cost: null }], has_more: true, next_cursor: 'cursor-1' } });
const response = body => ({ ok: true, json: async () => body });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('changing Key synchronously clears quota, results, cursor and aborts pending requests', async () => {
  const pending = deferred(); let signal;
  const client = createUsageClient({ initialRange: range, fetchImpl: (url, options) => { signal = options.signal; return pending.promise; } });
  client.setKey('key-A');
  const work = client.query();
  client.setKey('key-B');
  assert.equal(signal.aborted, true);
  assert.equal(client.getSnapshot().usage, null);
  assert.equal(client.getSnapshot().quota, null);
  assert.equal(client.getSnapshot().loading, false);
  pending.resolve(response(usage()));
  await work;
  assert.equal(client.getSnapshot().usage, null);
  assert.equal(client.getSnapshot().quota, null);
});
test('late earlier response cannot overwrite new Key results even if fetch ignores abort', async () => {
  const old = deferred();
  const client = createUsageClient({ initialRange: range, fetchImpl: (url, options) => options.headers.Authorization === 'Bearer key-A' ? old.promise : Promise.resolve(response(url.startsWith('/api/usage') ? usage('new-key') : { key: { name: 'B' } })) });
  client.setKey('key-A'); const earlier = client.query();
  client.setKey('key-B'); await client.query();
  old.resolve(response(usage('old-key'))); await earlier;
  assert.equal(client.getSnapshot().usage.recent.items[0].request_id, 'new-key');
  assert.equal(client.getSnapshot().quota.key.name, 'B');
});
test('range change clears successful data immediately and forces valid granularity', async () => {
  const client = createUsageClient({ initialRange: range, fetchImpl: async url => response(url.startsWith('/api/usage') ? usage() : { key: { name: 'A' } }) });
  client.setKey('key-A'); await client.query();
  client.setRange({ from: '2026-11-01', to: '2026-11-30', bucket: 'hour' });
  assert.equal(client.getSnapshot().usage, null);
  assert.equal(client.getSnapshot().quota, null);
  assert.equal(client.getSnapshot().range.bucket, 'day');
});
test('pagination uses exact normalized range, appends rows and preserves the summary', async () => {
  const urls = [];
  const client = createUsageClient({ initialRange: range, fetchImpl: async url => { urls.push(url); return response(url === '/api/quota' ? { key: { name: 'A' } } : usage(url.includes('cursor=') ? 'second' : 'first')); } });
  client.setKey('key-A'); await client.query(); await client.loadMore();
  const last = new URL(urls.at(-1), 'http://localhost');
  assert.equal(last.searchParams.get('end'), '2026-11-01T03:00:00Z');
  assert.equal(last.searchParams.get('cursor'), 'cursor-1');
  assert.deepEqual(client.getSnapshot().usage.recent.items.map(r => r.request_id), ['first', 'second']);
  assert.equal(client.getSnapshot().usage.summary.requests, 0);
});
test('failed queries do not reuse successful results and use safe local errors', async () => {
  let reject = false;
  const client = createUsageClient({ initialRange: range, fetchImpl: async url => reject ? { ok: false, status: 401, json: async () => ({ error: { message: 'private key contents' } }) } : response(url.startsWith('/api/usage') ? usage() : { key: { name: 'A' } }) });
  client.setKey('key-A'); await client.query(); reject = true; await client.query();
  assert.equal(client.getSnapshot().usage, null);
  assert.equal(client.getSnapshot().quota, null);
  assert.match(client.getSnapshot().error, /Key/);
  assert.doesNotMatch(client.getSnapshot().error, /private/);
});

test('mounted portal sends both APIs under configured base without putting Key in URLs', async () => {
  const requests = [];
  const client = createUsageClient({ basePath: '/usage/', initialRange: range, fetchImpl: async (url, options) => { requests.push({ url, options }); return response(url.includes('/quota') ? { key: { name: 'A' } } : usage()); } });
  client.setKey('secret-synthetic-key'); await client.query();
  assert.equal(requests[0].url.startsWith('/usage/api/usage?'), true);
  assert.equal(requests[1].url, '/usage/api/quota');
  assert.equal(requests.every(item => !item.url.includes('secret-synthetic-key')), true);
  assert.equal(requests[0].options.headers.Authorization, 'Bearer secret-synthetic-key');
  assert.equal(requests[0].options.credentials, 'omit');
  assert.equal(requests[0].options.cache, 'no-store');
});

test('changing range cancels a delayed request page before it can append old rows', async () => {
  const pending = deferred();
  const client = createUsageClient({ initialRange: range, fetchImpl: async url => url.includes('cursor=') ? pending.promise : response(url.includes('/quota') ? { key: { name: 'A' } } : usage()) });
  client.setKey('key-A'); await client.query();
  const page = client.loadMore();
  client.setRange({ from: '2026-11-02', to: '2026-11-02', bucket: 'hour' });
  assert.equal(client.getSnapshot().usage, null);
  assert.equal(client.getSnapshot().loadingMore, false);
  pending.resolve(response(usage('old-page'))); await page;
  assert.equal(client.getSnapshot().usage, null);
});

test('clearing Key removes already loaded usage and quota synchronously', async () => {
  const client = createUsageClient({ initialRange: range, fetchImpl: async url => response(url.includes('/quota') ? { key: { name: 'A' } } : usage()) });
  client.setKey('key-A'); await client.query();
  client.clear();
  assert.equal(client.getSnapshot().usage, null);
  assert.equal(client.getSnapshot().quota, null);
  await client.query();
  assert.match(client.getSnapshot().error, /Key/);
});
