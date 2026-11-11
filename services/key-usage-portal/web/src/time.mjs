const DAY = 86_400_000;
export const TIMEZONE = 'Asia/Shanghai';

function calendarMs(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('请选择完整的起止日期。');
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) throw new Error('日期无效。');
  return ms;
}
export function calendarRange(from, to) {
  const start = calendarMs(from);
  const end = calendarMs(to) + DAY;
  if (end <= start) throw new Error('结束日期不能早于开始日期。');
  if (end - start > 90 * DAY) throw new Error('单次最多查询 90 天，请缩短日期范围。');
  return { start: `${from}T00:00:00+08:00`, end: `${new Date(end).toISOString().slice(0, 10)}T00:00:00+08:00`, tz: TIMEZONE };
}
export function presetRange(preset, now = new Date()) {
  const today = new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
  const date = calendarMs(today);
  const days = { today: 1, yesterday: 1, '7d': 7, '30d': 30 }[preset];
  if (!days) throw new Error('请选择有效时间范围。');
  const end = date - (preset === 'yesterday' ? DAY : 0);
  return { from: new Date(end - (days - 1) * DAY).toISOString().slice(0, 10), to: new Date(end).toISOString().slice(0, 10) };
}
export function effectiveBucket(bucket, from, to) {
  return bucket === 'hour' && calendarMs(to) - calendarMs(from) < 7 * DAY ? 'hour' : 'day';
}
export function usageQuery(range, cursor) {
  for (const value of [range.start, range.end]) {
    if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('时间必须包含时区。');
  }
  const query = new URLSearchParams({ start: range.start, end: range.end, tz: range.timezone || range.tz || TIMEZONE, bucket: range.bucket, limit: '20' });
  if (cursor) query.set('cursor', cursor);
  return query.toString();
}
export function money(value) {
  return value === null || value === undefined || !Number.isFinite(Number(value)) ? '待定价' : `$${Number(value).toFixed(4)}`;
}
export function number(value) { return new Intl.NumberFormat('zh-CN').format(value ?? 0); }
export function dateTime(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return '—';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value));
}

/** Return each sparse series bucket's elapsed-time ratio in [0, 1].
 * Missing buckets remain gaps in the x-axis; they are never synthesized as zeroes.
 */
export function seriesTimePositions(series, range) {
  const start = Date.parse(range?.start || '');
  const end = Date.parse(range?.end || '');
  const span = end - start;
  if (!Number.isFinite(start) || !Number.isFinite(end) || span <= 0 || !Array.isArray(series) || !series.length) return [];
  const parseBucket = bucket => {
    if (typeof bucket !== 'string') return NaN;
    const value = /^\d{4}-\d{2}-\d{2}$/.test(bucket) ? `${bucket}T00:00:00+08:00` : bucket;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  };
  return series.map(item => {
    const parsed = parseBucket(item?.bucket);
    if (!Number.isFinite(parsed)) return null;
    return Math.max(0, Math.min(1, (parsed - start) / span));
  });
}
