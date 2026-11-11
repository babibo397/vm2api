import { DatabaseSync } from 'node:sqlite'
import { queryKeyUsageRange } from './repos/key-usage-range-repo.mjs'

const MAX_RESPONSE_BYTES = 1024 * 1024
const CURSOR_RESERVE_BYTES = 8 * 1024

export function openReadOnlyUsageDb(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true, enableForeignKeyConstraints: false })
  try {
    db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 1000; PRAGMA trusted_schema = OFF')
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

if (process.send)
  process.once('message', (job) => {
    let db
    let message
    try {
      db = openReadOnlyUsageDb(job.dbPath)
      const result = queryKeyUsageRange(db, job)
      // Bound JSON work in the isolated process before any result reaches gateway IPC.
      // Count the entire envelope; reject rather than truncate identities or partial statistics.
      const bytes = Buffer.byteLength(JSON.stringify({ ok: true, result }), 'utf8')
      message = bytes <= MAX_RESPONSE_BYTES - CURSOR_RESERVE_BYTES ? { ok: true, result } : { ok: false }
    } catch {
      // No SQL, paths, internal names or user-supplied input crosses this boundary.
      message = { ok: false }
    } finally {
      db?.close()
    }
    process.send(message, () => process.disconnect())
  })
