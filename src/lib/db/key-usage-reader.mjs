import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { getDbPath } from './database.mjs'
import { usageRangeError } from '../protocol/key-usage-range.mjs'

const SECRET = randomBytes(32)
const WORKER_URL = new URL('./key-usage-worker.mjs', import.meta.url)
const MAX_ACTIVE = 4
let active = 0
const unavailable = () =>
  usageRangeError(503, 'usage_unavailable', 'Usage query is temporarily unavailable; retry later')
const invalidCursor = () => usageRangeError(400, 'invalid_cursor', 'Invalid cursor for this key and range')
const signature = (text) => createHmac('sha256', SECRET).update(text).digest()
const binding = (apiKeyId, range) =>
  createHmac('sha256', SECRET)
    .update(JSON.stringify([apiKeyId, range.start, range.end, range.timezone, range.bucket]))
    .digest('base64url')

function encodeCursor(next, bind) {
  if (!next) return null
  const payload = Buffer.from(JSON.stringify([bind, next.created_at, next.id])).toString('base64url')
  const cursor = `${payload}.${signature(payload).toString('base64url')}`
  if (cursor.length > 2048) throw unavailable()
  return cursor
}

function decodeCursor(cursor, bind, range) {
  if (cursor == null) return null
  if (typeof cursor !== 'string' || cursor.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor))
    throw invalidCursor()
  const [payload, mac] = cursor.split('.')
  const expected = signature(payload)
  const received = Buffer.from(mac, 'base64url')
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw invalidCursor()
  try {
    const [bound, created_at, id] = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (
      bound !== bind ||
      typeof id !== 'string' ||
      !id ||
      typeof created_at !== 'string' ||
      created_at < range.start ||
      created_at >= range.end
    )
      throw invalidCursor()
    return { created_at, id }
  } catch {
    throw invalidCursor()
  }
}

/** Disposable query processes share one process-wide admission cap; no queue or synchronous fallback. */
export function createKeyUsageReader({
  startProcess = () =>
    fork(fileURLToPath(WORKER_URL), [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      execArgv: ['--max-old-space-size=128'],
      env: { NODE_NO_WARNINGS: '1' },
      serialization: 'advanced',
    }),
  deadlineMs = 8000,
} = {}) {
  const deadline = Math.max(1, Math.min(8000, Number(deadlineMs) || 8000))
  return async function read({ dbPath = getDbPath(), apiKeyId, range, limit = 20, cursor = null, now = Date.now() }) {
    const bind = binding(apiKeyId, range)
    const before = decodeCursor(cursor, bind, range)
    if (!dbPath || !apiKeyId || active >= MAX_ACTIVE) throw unavailable()
    active++
    let child
    let exited
    let timer
    try {
      child = startProcess()
      exited = new Promise((resolve) => {
        child.once('exit', resolve)
        child.once('close', resolve) // Failed spawns have no exit event and no running process.
      })
      const result = await new Promise((resolve, reject) => {
        timer = setTimeout(
          () => reject(usageRangeError(504, 'usage_timeout', 'Usage query timed out; retry later')),
          deadline,
        )
        child.once('message', (message) => (message?.ok ? resolve(message.result) : reject(unavailable())))
        child.once('error', () => reject(unavailable()))
        child.once('exit', () => reject(unavailable()))
        child.send({ dbPath, apiKeyId, range, limit, before, now }, (error) => {
          if (error) reject(unavailable())
        })
      })
      const { next, ...recent } = result.recent
      result.recent = { ...recent, next_cursor: encodeCursor(next, bind) }
      // IPC was bounded in the child; also cap the final JSON after cursor encoding.
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 1024 * 1024) throw unavailable()
      return result
    } catch (error) {
      if ([400, 503, 504].includes(error?.status)) throw error
      throw unavailable()
    } finally {
      clearTimeout(timer)
      // Admission is returned only after the query process has really stopped, on every outcome.
      try {
        if (child) {
          child.kill('SIGKILL')
          await exited
        }
      } finally {
        active--
      }
    }
  }
}

export const readKeyUsageRange = createKeyUsageReader()
