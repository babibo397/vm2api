import { validTimezone, zonedParts } from '../core/timezone.mjs'

const DAY = 86_400_000
const PARAMS = new Set(['start', 'end', 'tz', 'bucket', 'limit', 'cursor'])

export function usageRangeError(status, code, message) {
  return Object.assign(new Error(message), { status, code })
}

function invalid(message = 'Invalid usage range parameters', code = 'invalid_range') {
  return usageRangeError(400, code, message)
}

/** Parse only offset-bearing ISO datetimes; Date.parse alone normalizes invalid calendar days. */
function instant(raw) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(raw || '')
  if (!m) throw invalid('start and end require ISO timestamps with an explicit UTC offset')
  const [, year, month, day, hour, minute, second = '0', , offset] = m
  const y = Number(year)
  const mo = Number(month)
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (
    mo < 1 ||
    mo > 12 ||
    Number(day) < 1 ||
    Number(day) > days[mo - 1] ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59
  )
    throw invalid()
  if (offset !== 'Z' && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4, 6)) > 59)) throw invalid()
  const ms = Date.parse(raw)
  if (!Number.isFinite(ms)) throw invalid()
  return ms
}

export function parseUsageRangeQuery(q, now = Date.now()) {
  for (const name of q.keys()) if (!PARAMS.has(name) || q.getAll(name).length !== 1) throw invalid()
  const start = instant(q.get('start'))
  const requestedEnd = instant(q.get('end'))
  const end = Math.min(requestedEnd, now)
  const bucket = q.get('bucket') ?? 'day'
  const timezone = validTimezone(q.get('tz') ?? 'Asia/Shanghai')
  if (
    !timezone ||
    !['hour', 'day'].includes(bucket) ||
    start >= end ||
    requestedEnd - start > 90 * DAY ||
    end - start > (bucket === 'hour' ? 7 : 90) * DAY
  )
    throw invalid()
  const rawLimit = q.get('limit') ?? '20'
  const limit = Number(rawLimit)
  if (!/^\d+$/.test(rawLimit) || !Number.isInteger(limit) || limit < 1 || limit > 100)
    throw invalid('limit must be an integer from 1 to 100')
  const cursor = q.get('cursor')
  if (cursor !== null && (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor) || cursor.length > 2048))
    throw invalid('Invalid cursor', 'invalid_cursor')
  return {
    range: { start: new Date(start).toISOString(), end: new Date(end).toISOString(), timezone, bucket },
    limit,
    cursor,
  }
}

/** A local hour carries its actual offset so repeated DST hours never collapse. */
export function usageBucketLabel(value, timezone, bucket) {
  const ms = Date.parse(value)
  const p = zonedParts(ms, timezone)
  const pad = (n) => String(n).padStart(2, '0')
  const day = `${String(p.year).padStart(4, '0')}-${pad(p.month)}-${pad(p.day)}`
  if (bucket === 'day') return day
  const wall = new Date(0)
  wall.setUTCFullYear(p.year, p.month - 1, p.day)
  wall.setUTCHours(p.hour, p.minute, p.second, 0)
  const offset = Math.round((wall.getTime() - Math.floor(ms / 1000) * 1000) / 60000)
  const abs = Math.abs(offset)
  return `${day}T${pad(p.hour)}:00:00${offset >= 0 ? '+' : '-'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}
