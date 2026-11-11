import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fork } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import { createDatabase } from '../../src/lib/db/database.mjs'
const modulePath = new URL('../../src/lib/db/key-usage-reader.mjs', import.meta.url)
const workerPath = new URL('../../src/lib/db/key-usage-worker.mjs', import.meta.url)
const range = {
  start: '2026-11-01T00:00:00.000Z',
  end: '2026-11-02T00:00:00.000Z',
  timezone: 'Asia/Shanghai',
  bucket: 'day',
}
const opts = { dbPath: '/not-used', apiKeyId: 'k', range, limit: 20 }
function childFactory(t, source, hook = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-child-'))
  const filename = path.join(dir, 'child.mjs')
  fs.writeFileSync(filename, source.replace('__MARKER_DIR__', JSON.stringify(dir)))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const children = []
  return {
    children,
    dir,
    startProcess() {
      const child = fork(filename, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] })
      children.push(child)
      hook(child)
      return child
    },
  }
}
const longSql = `import {DatabaseSync} from 'node:sqlite';import fs from 'node:fs';process.once('message',()=>{fs.writeFileSync(__MARKER_DIR__+'/'+process.pid+'.started','');const db=new DatabaseSync(':memory:');db.prepare('WITH RECURSIVE x(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM x WHERE n < 1000000000) SELECT SUM(n) FROM x').get()})`

test('native SQLite queries are killed at deadline and four active jobs reject excess capacity', async (t) => {
  const { createKeyUsageReader } = await import(modulePath)
  const factory = childFactory(t, longSql)
  const read = createKeyUsageReader({ ...factory, deadlineMs: 800 })
  const start = Date.now()
  const jobs = Array.from({ length: 4 }, () => read(opts).catch((e) => e))
  await assert.rejects(read(opts), (e) => e.status === 503)
  const failures = await Promise.all(jobs)
  assert.ok(failures.every((e) => e.status === 504))
  assert.ok(
    fs.readdirSync(factory.dir).some((name) => name.endsWith('.started')),
    'at least one query entered real native SQL before termination',
  )
  assert.ok(Date.now() - start < 2500, 'native SQL did not continue after deadline')
  assert.ok(
    factory.children.every((child) => child.signalCode === 'SIGKILL'),
    'all executions exited before rejection',
  )
  await assert.rejects(read(opts), (e) => e.status === 504)
})

test('capacity is global across readers and remains held until confirmed child exit', async (t) => {
  const { createKeyUsageReader } = await import(modulePath)
  const releases = []
  const factory = childFactory(t, longSql, (child) => {
    const kill = child.kill.bind(child)
    child.kill = () => {
      releases.push(() => kill('SIGKILL'))
      return true
    }
  })
  const read = createKeyUsageReader({ ...factory, deadlineMs: 30 })
  const other = createKeyUsageReader({ ...factory, deadlineMs: 30 })
  const pending = Array.from({ length: 4 }, () => read(opts).catch((e) => e))
  await new Promise((resolve) => setTimeout(resolve, 100))
  await assert.rejects(other(opts), (e) => e.status === 503)
  assert.equal(releases.length, 4)
  for (const release of releases) release()
  assert.ok((await Promise.all(pending)).every((e) => e.status === 504))
})

test('success also waits for process cleanup before releasing capacity', async (t) => {
  const { createKeyUsageReader } = await import(modulePath)
  let release
  const factory = childFactory(
    t,
    `process.once('message',()=>{process.send({ok:true,result:{recent:{items:[],has_more:false,next:null}}});setInterval(()=>{},1000)})`,
    (child) => {
      const kill = child.kill.bind(child)
      child.kill = () => {
        release = () => kill('SIGKILL')
        return true
      }
    },
  )
  let settled = false
  const promise = createKeyUsageReader({ ...factory, deadlineMs: 1000 })(opts).then((value) => {
    settled = true
    return value
  })
  for (let guard = 0; guard < 100 && !release; guard++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(settled, false)
  assert.equal(typeof release, 'function')
  release()
  assert.deepEqual((await promise).recent, { items: [], has_more: false, next_cursor: null })
})

test('process start, missing DB and unexpected exit are safe 503 without main-thread fallback', async (t) => {
  const { createKeyUsageReader, readKeyUsageRange } = await import(modulePath)
  await assert.rejects(
    createKeyUsageReader({
      startProcess() {
        throw new Error('sensitive/path')
      },
    })(opts),
    (e) => e.status === 503 && !e.message.includes('sensitive'),
  )
  await assert.rejects(readKeyUsageRange(opts), (e) => e.status === 503)
  const factory = childFactory(t, 'process.exit(0)')
  await assert.rejects(createKeyUsageReader(factory)(opts), (e) => e.status === 503)
})

test('production connection forbids writes via read-only mode and query_only', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'range-readonly-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const dbPath = path.join(dir, 'kin.db')
  createDatabase({ dbPath }).close()
  const source = `import {parentPort} from 'node:worker_threads';import {openReadOnlyUsageDb} from ${JSON.stringify(workerPath.href)};const db=openReadOnlyUsageDb(${JSON.stringify(dbPath)});let blocked=false;try{db.exec('CREATE TABLE forbidden (x)')}catch{blocked=true}parentPort.postMessage({blocked,queryOnly:db.prepare('PRAGMA query_only').get().query_only});db.close()`
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`))
  const result = await new Promise((resolve, reject) => {
    worker.once('message', resolve)
    worker.once('error', reject)
  })
  await worker.terminate()
  assert.deepEqual(result, { blocked: true, queryOnly: 1 })
})

test('asynchronous spawn failure settles safely and returns admission after close', async (t) => {
  const { createKeyUsageReader } = await import(modulePath)
  const read = createKeyUsageReader({
    startProcess: () =>
      fork('/not-used', [], { execPath: '/does-not-exist', stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }),
    deadlineMs: 100,
  })
  const result = await Promise.race([
    read(opts).catch((error) => error),
    new Promise((resolve) => setTimeout(() => resolve('not settled'), 400)),
  ])
  assert.equal(result.status, 503)
})
