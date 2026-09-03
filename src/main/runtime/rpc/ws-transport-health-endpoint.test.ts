import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HEALTH_CACHE_MS, WebSocketTransport } from './ws-transport'

// Why: undici's fetch ignores NODE_TLS_REJECT_UNAUTHORIZED, so requests must opt out per call for self-signed certs.
async function getJson(
  url: string
): Promise<{ status: number; body: string; contentType: string }> {
  const res = await fetch(url)
  return {
    status: res.status,
    body: await res.text(),
    contentType: res.headers.get('content-type') ?? ''
  }
}

describe('WebSocketTransport /health endpoint', () => {
  const transports: WebSocketTransport[] = []

  afterEach(async () => {
    await Promise.all(transports.map((t) => t.stop().catch(() => {})))
    transports.length = 0
  })

  function createTransport(
    healthHandler: () => Promise<Record<string, unknown>>,
    staticRoot?: string
  ) {
    const transport = new WebSocketTransport({
      host: '127.0.0.1',
      port: 0,
      healthHandler,
      staticRoot
    })
    transports.push(transport)
    return transport
  }

  it('answers GET /health with 200 JSON from the handler', async () => {
    const transport = createTransport(async () => ({ status: 'ok', pid: 42 }))
    await transport.start()

    const res = await getJson(`http://127.0.0.1:${transport.resolvedPort}/health`)
    expect(res.status).toBe(200)
    expect(res.contentType).toContain('application/json')
    expect(JSON.parse(res.body)).toEqual({ status: 'ok', pid: 42 })
  })

  it('memoizes the handler result within HEALTH_CACHE_MS', async () => {
    const handler = vi.fn(async () => ({ ok: true }))
    const transport = createTransport(handler)
    await transport.start()
    const url = `http://127.0.0.1:${transport.resolvedPort}/health`

    await getJson(url)
    await getJson(url)

    expect(handler).toHaveBeenCalledTimes(1)
    expect(HEALTH_CACHE_MS).toBe(5_000)
  })

  it('dedupes concurrent in-flight handler calls', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const handler = vi.fn(async () => {
      await gate
      return { ok: true }
    })
    const transport = createTransport(handler)
    await transport.start()
    const url = `http://127.0.0.1:${transport.resolvedPort}/health`

    const pending = Promise.all([getJson(url), getJson(url), getJson(url)])
    release()
    const results = await pending

    expect(handler).toHaveBeenCalledTimes(1)
    for (const res of results) {
      expect(res.status).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ ok: true })
    }
  })

  it('responds 500 JSON when the handler rejects', async () => {
    const transport = createTransport(async () => {
      throw new Error('boom')
    })
    await transport.start()

    const res = await getJson(`http://127.0.0.1:${transport.resolvedPort}/health`)
    expect(res.status).toBe(500)
    expect(JSON.parse(res.body)).toEqual({ error: 'health_unavailable' })
  })

  it('still serves static files for non-health paths', async () => {
    const staticRoot = mkdtempSync(join(tmpdir(), 'ws-health-static-'))
    writeFileSync(join(staticRoot, 'web-index.html'), '<html>hi</html>')
    const transport = createTransport(async () => ({ ok: true }), staticRoot)
    await transport.start()
    const base = `http://127.0.0.1:${transport.resolvedPort}`

    const res = await getJson(`${base}/web-index.html`)
    expect(res.status).toBe(200)
    expect(res.body).toContain('hi')
  })

  it('returns 404 for unknown paths when no static root is set', async () => {
    const transport = createTransport(async () => ({ ok: true }))
    await transport.start()

    const res = await getJson(`http://127.0.0.1:${transport.resolvedPort}/nope`)
    expect(res.status).toBe(404)
  })
})
