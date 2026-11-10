import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import test from 'node:test'
import { codexKernelHealth } from '../../src/lib/transport/codex-kernel-client.mjs'
import {
  ensureCodexKernel,
  codexKernelTracked,
  finishCodexRecycle,
  stopCodexKernel,
  stopCodexKernelAndWait,
  writeCodexKernelConfig,
} from '../../src/lib/transport/codex-kernel-supervisor.mjs'
import { destroySlot, reloadSlotReady, startSlotReady } from '../../src/lib/vm/slot-runtime.mjs'
import { recreateVmFiles } from '../../src/lib/vm/vm-recreate.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'

async function fixture(t, { exitDelayMs = 0 } = {}) {
  // Keep the Unix-socket path below macOS's length limit.
  const root = fs.mkdtempSync('/tmp/ck-reload-')
  const previousPath = process.env.PATH
  const mockBin = path.join(root, 'bin')
  fs.mkdirSync(mockBin)
  // No lifecycle test may contact the developer's real Docker daemon.
  fs.writeFileSync(path.join(mockBin, 'docker'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  process.env.PATH = `${mockBin}:${previousPath}`
  const bin = path.join(root, 'kernel')
  fs.writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require('node:fs')
const http = require('node:http')
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ ok: true, pid: process.pid, proxy: config.proxy_url }))
})
server.listen(config.socket_path)
process.on('SIGTERM', () => {
  setTimeout(() => server.close(() => {
    fs.writeFileSync(config.socket_path + '.closed', String(process.pid))
    setTimeout(() => process.exit(0), ${exitDelayMs})
  }), 100)
})
`,
    { mode: 0o755 },
  )
  const previousBin = process.env.KIN_CODEX_KERNEL_BIN
  process.env.KIN_CODEX_KERNEL_BIN = bin
  const slots = []
  t.after(async () => {
    for (const { exec } of slots) {
      const child = stopCodexKernel(exec.vmId)
      if (child) await finishCodexRecycle(child)
    }
    if (previousBin === undefined) delete process.env.KIN_CODEX_KERNEL_BIN
    else process.env.KIN_CODEX_KERNEL_BIN = previousBin
    process.env.PATH = previousPath
    fs.rmSync(root, { recursive: true, force: true })
  })
  return {
    root,
    async slot(id) {
      const vm = { id, platform: 'openai', proxy: { url: 'socks5h://127.0.0.1:1080' }, runtime: { type: 'docker' } }
      const exec = { vmId: id, vm, homeDir: path.join(root, 'vms', id, 'cli-home') }
      slots.push({ exec })
      fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
      fs.writeFileSync(path.join(root, 'vms', `${id}.json`), JSON.stringify(vm))
      writeCodexKernelConfig(root, vm)
      assert.equal((await ensureCodexKernel(exec)).ok, true)
      return { vm, exec, health: await codexKernelHealth(exec) }
    },
  }
}

const reloadContainer = async (vm) => ({ ok: true, action: 'reloaded', runtime: vm.runtime })

test('GPT reload replaces the host kernel and adopts the new proxy without touching another slot', async (t) => {
  const f = await fixture(t)
  const first = await f.slot('vm-a')
  const peer = await f.slot('vm-b')
  first.vm.proxy.url = 'socks5h://127.0.0.1:2080'

  const result = await reloadSlotReady(first.vm, f.root, { ops: { reloadSlot: reloadContainer } })

  assert.equal(result.ok, true)
  const current = await codexKernelHealth(first.exec)
  assert.notEqual(current.pid, first.health.pid, 'a container reload must not reuse the old host kernel')
  assert.equal(current.proxy, first.vm.proxy.url, 'the process must read the new proxy at startup')
  assert.equal((await codexKernelHealth(peer.exec)).pid, peer.health.pid)
})

test('GPT reload with eager_start disabled stops the old kernel and leaves lazy startup enabled', async (t) => {
  const f = await fixture(t)
  const first = await f.slot('vm-lazy')

  const result = await reloadSlotReady(first.vm, f.root, {
    routing: { inference: { eager_start: false } },
    ops: { reloadSlot: reloadContainer },
  })

  assert.equal(result.ok, true)
  assert.equal((await codexKernelHealth(first.exec)).ok, false)
})

test('a failed container reload leaves its running Codex kernel alone', async (t) => {
  const f = await fixture(t)
  const first = await f.slot('vm-failed')

  const result = await reloadSlotReady(first.vm, f.root, {
    ops: { reloadSlot: async () => ({ ok: false, error: 'container unavailable' }) },
  })

  assert.equal(result.ok, false)
  assert.equal((await codexKernelHealth(first.exec)).pid, first.health.pid)
})

test('GPT reload reports failure when the replacement kernel cannot become ready', async (t) => {
  const f = await fixture(t)
  const first = await f.slot('vm-start-fail')

  const result = await reloadSlotReady(first.vm, f.root, {
    ops: {
      reloadSlot: reloadContainer,
      ensureCodexKernel: async () => ({ ok: false, reason: 'health_timeout' }),
    },
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'health_timeout')
})

test('a concurrent ensure waits for the exiting kernel before starting its replacement', async (t) => {
  const f = await fixture(t)
  const first = await f.slot('vm-overlap')

  const stopping = stopCodexKernelAndWait(first.exec)
  const starting = ensureCodexKernel(first.exec)
  assert.equal((await stopping).ok, true)
  assert.equal((await starting).ok, true)
  assert.notEqual((await codexKernelHealth(first.exec)).pid, first.health.pid)
})

test('a stop timeout preserves the tracked process and its socket', async (t) => {
  const f = await fixture(t)
  const first = await f.slot('vm-timeout')

  const stopped = await stopCodexKernelAndWait(first.exec, { termMs: 0, killMs: 0 })

  assert.equal(stopped.ok, false)
  assert.equal(stopped.reason, 'recycle_timeout')
  assert.equal(codexKernelTracked(first.vm.id), true)
  assert.equal(fs.existsSync(path.join(f.root, 'vms', first.vm.id, 'run', 'codex-kernel.sock')), true)
})

test('an untracked listener is reported instead of unlinking its live socket', async (t) => {
  const f = await fixture(t)
  const vm = { id: 'vm-untracked', platform: 'openai', proxy: { url: 'socks5h://127.0.0.1:1080' } }
  const exec = { vmId: vm.id, vm, homeDir: path.join(f.root, 'vms', vm.id, 'cli-home') }
  const written = writeCodexKernelConfig(f.root, vm)
  const server = http.createServer((_req, res) => res.end(JSON.stringify({ ok: true })))
  await new Promise((resolve) => server.listen(written.socketPath, resolve))
  try {
    const stopped = await stopCodexKernelAndWait(exec)
    assert.equal(stopped.ok, false)
    assert.equal(stopped.reason, 'untracked_kernel')
    assert.equal((await codexKernelHealth(exec)).ok, true)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('GPT reload reports a failed stop without starting another kernel', async (t) => {
  const f = await fixture(t)
  const first = await f.slot('vm-stop-fail')
  let starts = 0

  const result = await reloadSlotReady(first.vm, f.root, {
    ops: {
      reloadSlot: reloadContainer,
      stopCodexKernelAndWait: async () => ({ ok: false, reason: 'recycle_timeout' }),
      ensureCodexKernel: async () => {
        starts += 1
        return { ok: true }
      },
    },
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'codex_kernel_reload_failed')
  assert.equal(starts, 0)
  assert.equal((await codexKernelHealth(first.exec)).pid, first.health.pid)
})

test('Codex destruction waits for the host kernel before home recreation and a replacement stays reachable', async (t) => {
  const f = await fixture(t)
  const first = await f.slot('vm-reset')
  const peer = await f.slot('vm-peer')
  let destroyed = false
  let rebuilt
  const gone = await destroySlot(first.vm, f.root, {
    afterDestroy: () => {
      rebuilt = recreateVmFiles(f.root, first.vm, { mode: 'keep' })
    },
    ops: {
      destroySlot: async () => {
        assert.equal(codexKernelTracked(first.vm.id), false, 'host exit must precede container destruction')
        assert.throws(() => process.kill(first.health.pid, 0), { code: 'ESRCH' })
        destroyed = true
        return { ok: true, action: 'removed' }
      },
    },
  })
  assert.equal(gone.ok, true)
  assert.equal(codexKernelTracked(first.vm.id), false, 'destruction must not leave the old host process alive')
  assert.equal(destroyed, true)
  const boot = await startSlotReady(rebuilt.vm, f.root, {
    ops: { startSlot: async () => ({ ok: true, action: 'created', runtime: rebuilt.vm.runtime }) },
  })
  assert.equal(boot.ok, true)
  const current = await codexKernelHealth(first.exec)
  assert.equal(current.ok, true)
  assert.notEqual(current.pid, first.health.pid)
  assert.equal(fs.existsSync(path.join(f.root, 'vms', first.vm.id, 'run', 'codex-kernel.sock')), true)
  assert.equal((await codexKernelHealth(peer.exec)).pid, peer.health.pid)
})

test('destruction blocks concurrent ensure until the host and local home have both been removed', async (t) => {
  const f = await fixture(t)
  const first = await f.slot('vm-held')
  let entered
  const inDestroy = new Promise((resolve) => {
    entered = resolve
  })
  let finishDestroy
  const gate = new Promise((resolve) => {
    finishDestroy = resolve
  })
  let wiped = false
  const deleting = destroySlot(first.vm, f.root, {
    ops: {
      destroySlot: async () => {
        entered()
        await gate
        return { ok: true }
      },
    },
    afterDestroy: async () => {
      assert.deepEqual(await ensureCodexKernel(first.exec), { ok: false, reason: 'teardown_in_progress' })
      fs.rmSync(path.join(f.root, 'vms', first.vm.id, 'run'), { recursive: true, force: true })
      wiped = true
    },
  })
  await inDestroy
  try {
    assert.deepEqual(await ensureCodexKernel(first.exec), { ok: false, reason: 'teardown_in_progress' })
    let duplicateDestroys = 0
    const duplicate = await destroySlot(first.vm, f.root, {
      ops: {
        destroySlot: async () => {
          duplicateDestroys += 1
          return { ok: true }
        },
      },
      afterDestroy: () => {
        duplicateDestroys += 1
      },
    })
    assert.equal(duplicate.ok, false)
    assert.equal(duplicate.code, 'codex_kernel_destroy_failed')
    assert.equal(duplicateDestroys, 0, 'a second teardown must not run destructive callbacks')
  } finally {
    finishDestroy()
    await deleting
  }
  assert.equal(wiped, true)
  assert.equal(codexKernelTracked(first.vm.id), false)
  writeCodexKernelConfig(f.root, first.vm)
  assert.equal((await ensureCodexKernel(first.exec)).ok, true)
  assert.notEqual((await codexKernelHealth(first.exec)).pid, first.health.pid)
})

test('an ensure already waiting on health cannot spawn after a completed teardown', async (t) => {
  const f = await fixture(t)
  const vm = { id: 'vm-old-ensure', platform: 'openai' }
  const exec = { vmId: vm.id, vm, homeDir: path.join(f.root, 'vms', vm.id, 'cli-home') }
  writeCodexKernelConfig(f.root, vm)
  t.after(async () => {
    const child = stopCodexKernel(vm.id)
    if (child) await finishCodexRecycle(child)
  })
  // With no socket, ensure waits for its health deadline before attempting a spawn.
  const pending = ensureCodexKernel(exec, { timeoutMs: 300 })
  const gone = await destroySlot(vm, f.root, {
    ops: { destroySlot: async () => ({ ok: true }) },
    afterDestroy: () => fs.rmSync(path.join(f.root, 'vms', vm.id), { recursive: true, force: true }),
  })
  assert.equal(gone.ok, true)
  const result = await pending
  assert.deepEqual(result, { ok: false, reason: 'teardown_in_progress' })
  assert.equal(codexKernelTracked(vm.id), false)
})

test('destruction joins a body-limit recycle until its old process exits and cannot unlink the replacement socket', async (t) => {
  const f = await fixture(t, { exitDelayMs: 1400 })
  const first = await f.slot('vm-recycle-delete')
  const runDir = path.join(f.root, 'vms', first.vm.id, 'run')
  const configPath = path.join(runDir, 'codex-kernel.json')
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  config.max_request_bytes *= 2
  fs.writeFileSync(configPath, JSON.stringify(config))
  const recycling = ensureCodexKernel(first.exec)
  const closedMarker = path.join(runDir, 'codex-kernel.sock.closed')
  const deadline = Date.now() + 3000
  while (!fs.existsSync(closedMarker) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(fs.existsSync(closedMarker), true, 'the old kernel must close its listener before teardown starts')
  assert.doesNotThrow(() => process.kill(first.health.pid, 0), 'the old kernel must still be exiting')
  let destroyedWhileRunning = false
  const gone = await destroySlot(first.vm, f.root, {
    ops: {
      destroySlot: async () => {
        try {
          process.kill(first.health.pid, 0)
          destroyedWhileRunning = true
        } catch (error) {
          assert.equal(error.code, 'ESRCH')
        }
        return { ok: true }
      },
    },
    afterDestroy: () => fs.rmSync(runDir, { recursive: true, force: true }),
  })
  assert.equal(gone.ok, true)
  writeCodexKernelConfig(f.root, first.vm)
  assert.equal((await ensureCodexKernel(first.exec, { timeoutMs: 500 })).ok, true)
  const replacement = await codexKernelHealth(first.exec)
  assert.notEqual(replacement.pid, first.health.pid)
  assert.deepEqual(await recycling, { ok: false, reason: 'teardown_in_progress' })
  const current = await codexKernelHealth(first.exec)
  assert.equal(current.ok, true, 'old recycle cleanup must not unlink the replacement socket')
  assert.equal(current.pid, replacement.pid)
  assert.equal(destroyedWhileRunning, false, 'host destruction must wait for the old process to exit')
})

test('a failed Codex stop prevents host destruction and preserves its live socket', async (t) => {
  const f = await fixture(t)
  const first = await f.slot('vm-no-stop')
  let destroys = 0
  const gone = await destroySlot(first.vm, f.root, {
    ops: {
      stopCodexKernelAndWait: async () => ({ ok: false, reason: 'recycle_timeout' }),
      destroySlot: async () => {
        destroys += 1
        return { ok: true }
      },
    },
  })
  assert.equal(gone.ok, false)
  assert.equal(gone.code, 'codex_kernel_destroy_failed')
  assert.equal(destroys, 0)
  assert.equal((await codexKernelHealth(first.exec)).pid, first.health.pid)
  assert.equal((await ensureCodexKernel(first.exec)).ok, true, 'a failed stop must release the teardown hold')
})

test('Codex destruction without a project root refuses to destroy an unverifiable kernel', async (t) => {
  const f = await fixture(t)
  const first = await f.slot('vm-no-root')
  const gone = await destroySlot(first.vm)
  assert.equal(gone.ok, false)
  assert.equal(gone.code, 'codex_kernel_destroy_failed')
  assert.equal((await codexKernelHealth(first.exec)).pid, first.health.pid)
})

test('Claude destruction retains the ordinary container-only result', async (t) => {
  await fixture(t)
  const gone = await destroySlot({ id: 'vm-claude', platform: 'anthropic' }, null, {
    ops: {
      stopCodexKernelAndWait: () => {
        throw new Error('Claude must not stop a Codex kernel')
      },
    },
  })
  assert.equal(gone.ok, true)
  assert.equal(gone.action, 'absent')
})

for (const action of ['reset', 'delete']) {
  test(`panel ${action} preserves the record and home when a Codex listener cannot be stopped`, async (t) => {
    const f = await fixture(t)
    const vm = { id: 'vm-owned', platform: 'openai', runtime: { type: 'docker' } }
    const vmPath = path.join(f.root, 'vms', `${vm.id}.json`)
    fs.mkdirSync(path.dirname(vmPath), { recursive: true })
    fs.writeFileSync(vmPath, JSON.stringify(vm))
    const written = writeCodexKernelConfig(f.root, vm)
    const marker = path.join(f.root, 'vms', vm.id, 'must-survive')
    fs.writeFileSync(marker, 'fixture-data')
    const server = http.createServer((_req, res) => res.end(JSON.stringify({ ok: true })))
    await new Promise((resolve) => server.listen(written.socketPath, resolve))
    let unbound = false
    const response = {}
    const handle = createPanelHandler({
      cfg: { paths: { project: f.root } },
      requireAuth(req) {
        req.apiKeyKind = 'master'
        req.panelRole = 'admin'
        return true
      },
      json(_res, status, body) {
        response.status = status
        response.body = body
        return true
      },
      readBody: async () => ({ mode: 'keep' }),
      proxyPool: {
        unbindVm() {
          unbound = true
        },
        allocateForVm() {
          return null
        },
      },
    })
    try {
      await handle(
        { method: action === 'reset' ? 'POST' : 'DELETE' },
        {},
        new URL(`http://localhost/api/panel/vms/${vm.id}${action === 'reset' ? '/reset' : ''}`),
      )
      assert.equal(response.status, action === 'reset' ? 500 : 409)
      assert.equal(response.body.error.code, 'codex_kernel_destroy_failed')
      assert.equal(fs.readFileSync(marker, 'utf8'), 'fixture-data')
      assert.equal(fs.existsSync(vmPath), true)
      assert.equal(fs.existsSync(written.socketPath), true)
      assert.equal(unbound, false)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
}
