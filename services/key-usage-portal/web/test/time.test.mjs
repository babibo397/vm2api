import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarRange, presetRange, effectiveBucket, usageQuery, money } from '../src/time.mjs';

test('inclusive Shanghai ending day becomes the next midnight with explicit offset', () => {
  assert.deepEqual(calendarRange('2026-11-01', '2026-11-02'), { start: '2026-11-01T00:00:00+08:00', end: '2026-11-03T00:00:00+08:00', tz: 'Asia/Shanghai' });
});
test('presets use Shanghai date even when UTC date differs and cross month correctly', () => {
  const now = new Date('2026-10-31T17:00:00Z');
  assert.deepEqual(presetRange('today', now), { from: '2026-11-01', to: '2026-11-01' });
  assert.deepEqual(presetRange('yesterday', now), { from: '2026-10-31', to: '2026-10-31' });
  assert.deepEqual(presetRange('7d', now), { from: '2026-10-26', to: '2026-11-01' });
  assert.deepEqual(presetRange('30d', now), { from: '2026-10-03', to: '2026-11-01' });
});
test('invalid calendar dates, reverse dates and over 90-day spans are rejected', () => {
  for (const [from, to] of [['2026-02-30', '2026-03-01'], ['2026-11-02', '2026-11-01'], ['2026-01-01', '2026-04-01']]) {
    assert.throws(() => calendarRange(from, to));
  }
  assert.equal(calendarRange('2026-01-01', '2026-03-31').end, '2026-04-01T00:00:00+08:00');
});
test('hour buckets switch to day beyond seven inclusive days', () => {
  assert.equal(effectiveBucket('hour', '2026-11-01', '2026-11-07'), 'hour');
  assert.equal(effectiveBucket('hour', '2026-11-01', '2026-11-08'), 'day');
});
test('query preserves arbitrary explicit offsets and normalized pagination end', () => {
  const range = { start: '2026-11-01T00:00:00-04:00', end: '2026-11-02T15:23:45Z', timezone: 'America/New_York', bucket: 'hour' };
  const query = new URLSearchParams(usageQuery(range, 'opaque+cursor'));
  assert.equal(query.get('start'), '2026-11-01T00:00:00-04:00');
  assert.equal(query.get('end'), '2026-11-02T15:23:45Z');
  assert.equal(query.get('tz'), 'America/New_York');
  assert.equal(query.get('cursor'), 'opaque+cursor');
  assert.equal(query.get('limit'), '20');
  assert.throws(() => usageQuery({ ...range, start: '2026-11-01T00:00:00' }));
});
test('null cost is unknown, while actual zero remains a known amount', () => {
  assert.equal(money(null), '待定价');
  assert.equal(money(undefined), '待定价');
  assert.equal(money(0), '$0.0000');
  assert.equal(money(1.23456), '$1.2346');
});
test('sparse day buckets retain elapsed-time spacing without filling missing days', async () => {
  const { seriesTimePositions } = await import('../src/time.mjs');
  const positions = seriesTimePositions(
    [{ bucket: '2026-11-01' }, { bucket: '2026-11-02' }, { bucket: '2026-11-30' }],
    { start: '2026-10-31T16:00:00Z', end: '2026-11-30T16:00:00Z' },
  );
  assert.equal(positions.length, 3);
  assert.ok(positions[1] - positions[0] < positions[2] - positions[1], 'Nov 1→2 should be visibly shorter than Nov 2→30');
  assert.equal(positions[0], 0);
  assert.equal(positions[1], 1 / 30);
  assert.equal(positions[2], 29 / 30);
});

test('hour buckets with offsets use UTC elapsed spacing and invalid buckets remain absent', async () => {
  const { seriesTimePositions } = await import('../src/time.mjs');
  const positions = seriesTimePositions(
    [{ bucket: '2026-11-01T00:00:00+08:00' }, { bucket: '2026-11-01T03:00:00+08:00' }, { bucket: 'not-a-date' }],
    { start: '2026-10-31T16:00:00Z', end: '2026-11-01T08:00:00Z' },
  );
  assert.equal(positions[0], 0);
  assert.equal(positions[1], 3 / 16);
  assert.equal(positions[2], null);
});
