import { BlockList, isIP } from 'node:net'

export function createLimiter({ limit, windowMs = 60000, maxEntries = 4096, now = Date.now }) {
  const entries = new Map()
  let nextSweep = 0
  return (id) => {
    const time = now()
    if (time >= nextSweep) {
      for (const [key, entry] of entries) if (entry.until <= time) entries.delete(key)
      nextSweep = time + 10000
    }
    let entry = entries.get(id)
    if (!entry || entry.until <= time) {
      if (!entry && entries.size >= maxEntries) return false
      entry = { count: 0, until: time + windowMs }
      entries.set(id, entry)
    }
    if (entry.count >= limit) return false
    entry.count += 1
    return true
  }
}

const normalizedIp = (ip = '') => (ip.startsWith('::ffff:') ? ip.slice(7) : ip)

export function createClientIp(trustedProxyCidrs = []) {
  const block = new BlockList()
  for (const cidr of trustedProxyCidrs) {
    const [address, bits] = cidr.split('/')
    const family = isIP(address)
    const max = family === 6 ? 128 : 32
    const prefix = bits === undefined ? max : Number(bits)
    if (!family || !Number.isInteger(prefix) || prefix < 0 || prefix > max)
      throw new Error('Invalid trusted proxy CIDR')
    block.addSubnet(address, prefix, family === 6 ? 'ipv6' : 'ipv4')
  }
  const trusted = (ip) => isIP(ip) && block.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4')
  return (req) => {
    const peer = normalizedIp(req.socket.remoteAddress)
    if (!trusted(peer)) return peer
    const parts = String(req.headers['x-forwarded-for'] || '')
      .split(',')
      .map((p) => normalizedIp(p.trim()))
    if (parts.length > 16 || parts.some((p) => !isIP(p))) return peer
    for (let i = parts.length - 1; i >= 0; i--) if (!trusted(parts[i])) return parts[i]
    return parts[0] || peer
  }
}
