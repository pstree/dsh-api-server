/**
 * The settings card's Host endpoints.
 *
 * The card lives in the Web GUI, which cannot reach the gateway's own port
 * directly from the Client (and must not: the gateway may be bound to a
 * different interface). These routes ride the Web GUI's `webServer` instead and
 * drive the same `createOpenAiServer` instance the plugin owns.
 *
 * Reads are GET, mutations are POST with a JSON body, and every mutation is
 * gated to loopback origins so a remote browser session cannot silently
 * rebind the gateway.
 *
 * Two kinds of mutation exist on purpose:
 *
 * - `save` persists through `configEditor`, which reloads this plugin row and
 *   therefore rebinds the listener on the new address. It must NOT also rebind
 *   in-process: the reload owns the new listener, and a second bind competes
 *   with it for the same port.
 * - `start` / `stop` change only the current process's run state. Nothing is
 *   persisted, so a restart returns to whatever the config says.
 */
import { ApiError } from './openai.js'

/** Route prefix owned by this bundle. */
export const SETTINGS_PATH = '/plugins/dsh-openai-api/settings'

/**
 * @param {object} options Wiring.
 * @param {() => object | null} options.getServer Resolves the live gateway instance.
 * @param {(patch: object) => Promise<boolean>} options.persist Write host/port/apiKey to the profile patch.
 * @param {(message: string) => void} [options.warn] Logger.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createSettingsHandler({ getServer, persist, warn }) {
  return async function handleSettings(req, res) {
    const method = req.method ?? 'GET'
    try {
      const server = getServer()
      if (server === null) {
        sendJson(res, 200, {
          running: false,
          host: '127.0.0.1',
          port: 8787,
          address: null,
          apiKey: '',
          configured: { host: '127.0.0.1', port: 8787 },
          unavailable: true,
        })
        return
      }

      if (method === 'GET') {
        sendJson(res, 200, snapshot(server))
        return
      }
      if (method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      if (!isLoopbackRequest(req)) {
        sendJson(res, 403, { error: 'forbidden', message: 'Settings can only be changed from this machine.' })
        return
      }

      const body = await readJson(req)
      const action = typeof body.action === 'string' ? body.action : 'save'

      if (action === 'stop') {
        await server.stop()
        sendJson(res, 200, snapshot(server))
        return
      }
      if (action === 'start') {
        await server.start()
        sendJson(res, 200, snapshot(server))
        return
      }
      if (action !== 'save') {
        throw new ApiError(400, `Unknown action "${action}".`, { code: 'invalid_action' })
      }

      const patch = {
        host: typeof body.host === 'string' && body.host.trim() !== '' ? body.host.trim() : '127.0.0.1',
        port: normalizePort(body.port),
        apiKey: typeof body.apiKey === 'string' ? body.apiKey.trim() : '',
      }
      const persisted = await persist(patch)
      if (!persisted) {
        // No config editor in this composition: apply in-process so the card
        // still works, and say the change will not survive a restart.
        const next = await server.applySettings(patch, { running: body.running !== false })
        sendJson(res, 200, { ...next, persisted: false })
        return
      }
      // The Loader reload owns the rebind. Report the address the card asked for
      // so it does not render a stale value while the row reconciles.
      sendJson(res, 200, {
        running: body.running !== false,
        host: patch.host,
        port: patch.port,
        address: `http://${patch.host}:${patch.port}`,
        apiKey: patch.apiKey === '' ? '' : '••••••',
        configured: { host: patch.host, port: patch.port },
        persisted: true,
      })
    } catch (error) {
      const status = error instanceof ApiError ? error.status : error?.code === 'EADDRINUSE' ? 409 : 500
      const message = error?.message ?? String(error)
      if (status >= 500) warn?.(`[dsh-openai-api] settings request failed: ${error?.stack ?? error}`)
      sendJson(res, status, {
        error: error?.code ?? 'settings_failed',
        message,
        ...(error?.code === 'EADDRINUSE'
          ? { hint: 'That port is already in use. Pick another port, or stop the program holding it.' }
          : {}),
      })
    }
  }
}

/**
 * @param {object} server Gateway instance.
 * @returns {object} Everything the card renders.
 */
function snapshot(server) {
  const state = server.status()
  return {
    running: state.running,
    host: state.host,
    port: state.port,
    address: state.address,
    apiKey: server.config.apiKey === '' ? '' : '••••••',
    configured: { host: server.config.host, port: server.config.port },
  }
}

/**
 * @param {unknown} value Port from the card.
 * @returns {number} A usable TCP port.
 */
function normalizePort(value) {
  const port = typeof value === 'string' ? Number(value.trim()) : Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ApiError(400, 'Port must be a whole number between 1 and 65535.', { code: 'invalid_port' })
  }
  return port
}

/**
 * A remote Web GUI session reaches the Host over the same listener, so origin
 * and host headers are the only trustworthy local-vs-remote signal here.
 *
 * @param {import('node:http').IncomingMessage} req Request.
 * @returns {boolean} True when the caller is on this machine.
 */
function isLoopbackRequest(req) {
  const remote = req.socket?.remoteAddress ?? ''
  const local =
    remote === '' ||
    remote === '127.0.0.1' ||
    remote === '::1' ||
    remote === '::ffff:127.0.0.1' ||
    remote.startsWith('127.')
  if (!local) return false
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  try {
    const { hostname } = new URL(origin)
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1'
  } catch {
    return false
  }
}

/**
 * @param {import('node:http').IncomingMessage} req Request.
 * @returns {Promise<object>} Parsed body.
 */
function readJson(req) {
  return new Promise((resolve, reject) => {
    const limit = 64 * 1024
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new ApiError(413, 'Request body is too large.', { code: 'payload_too_large' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (size === 0) {
        resolve({})
        return
      }
      let text = Buffer.concat(chunks).toString('utf8')
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new ApiError(400, 'Request body is not valid JSON.', { code: 'invalid_json' }))
      }
    })
    req.on('error', reject)
  })
}

/**
 * @param {import('node:http').ServerResponse} res Response.
 * @param {number} status Status code.
 * @param {unknown} body JSON body.
 */
function sendJson(res, status, body) {
  if (res.headersSent) {
    if (!res.writableEnded) res.end()
    return
  }
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}
