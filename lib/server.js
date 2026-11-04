/**
 * The loopback HTTP carrier.
 *
 * A standalone `node:http` server (not the Web GUI route table) keeps the
 * OpenAI surface independent from the harness UI origin and lets clients opt in
 * by pointing at a dedicated port.
 */
import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import {
  ApiError,
  CompletionCollector,
  StreamTranslator,
  buildChatRequest,
  buildTextCompletionRequest,
  errorPayload,
  finishFailure,
  mapFinishReason,
  mapUsage,
  newCompletionId,
  normalizeConfig,
} from './openai.js'
import { ModelCatalog } from './catalog.js'

const VERSION = '1.0.0'
const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
}

/**
 * @param {object} options Server dependencies.
 * @param {object} options.llm Host `llm` service (must provide listProviders/listModels/stream).
 * @param {object} [options.logger] Host logger.
 * @param {object} [options.config] Raw bundle config.
 * @param {() => ({ provider?: string, model?: string } | undefined)} [options.getDefaultSelection] Profile default model.
 * @returns {{
 *   start: () => Promise<void>,
 *   stop: () => Promise<void>,
 *   address: () => string | undefined,
 *   status: () => { running: boolean, host: string, port: number, address: string | null },
 *   applySettings: (next: object, options?: { running?: boolean }) => Promise<object>,
 *   invalidateCatalog: () => void,
 *   config: object,
 * }}
 */
export function createOpenAiServer({ llm, logger, config, getDefaultSelection }) {
  const settings = normalizeConfig(config)
  const log = {
    info: (message) => logger?.info?.(message),
    warn: (message) => logger?.warn?.(message),
    error: (message) => logger?.error?.(message),
  }
  const catalog = new ModelCatalog({ llm, config: settings, logger: log, getDefaultSelection })

  /** @type {import('node:http').Server | null} */
  let server = null
  const sockets = new Set()

  function address() {
    const bound = server?.address()
    if (bound === null || bound === undefined || typeof bound === 'string') return undefined
    const host = settings.host.includes(':') ? `[${settings.host}]` : settings.host
    return `http://${host}:${bound.port}`
  }

  async function start() {
    if (server !== null) return
    const instance = createServer((req, res) => {
      handle(req, res).catch((error) => {
        const payload = errorPayload(error)
        if (payload.status >= 500) {
          log.error(`[dsh-openai-api] request failed: ${error?.stack ?? error}`)
        }
        if (!res.headersSent) {
          sendJson(res, payload.status, payload.body)
        } else if (!res.writableEnded && !res.destroyed) {
          // Mid-stream failure: OpenAI clients read the error as an SSE event.
          res.write(`data: ${JSON.stringify(payload.body)}\n\n`)
          res.write('data: [DONE]\n\n')
          res.end()
        }
      })
    })
    instance.on('connection', (socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    })
    instance.on('error', (error) => {
      log.error(`[dsh-openai-api] server error: ${error?.message ?? error}`)
    })

    const listen = () =>
      new Promise((resolve, reject) => {
        const onError = (error) => {
          instance.off('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          instance.off('error', onError)
          resolve()
        }
        instance.once('error', onError)
        instance.once('listening', onListening)
        instance.listen(settings.port, settings.host)
      })

    // A reload can overlap the previous instance's teardown; retry briefly.
    let lastError
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await listen()
        lastError = undefined
        break
      } catch (error) {
        lastError = error
        if (error?.code !== 'EADDRINUSE' || attempt === 3) break
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }
    if (lastError !== undefined) {
      const hint =
        lastError?.code === 'EADDRINUSE'
          ? ` Port ${settings.port} is already in use; change "port" in cordis.patch.yml.`
          : ''
      throw new Error(`[dsh-openai-api] cannot listen on ${settings.host}:${settings.port}.${hint}`, {
        cause: lastError,
      })
    }
    server = instance
  }

  async function stop() {
    const instance = server
    server = null
    if (instance === null) return
    await new Promise((resolve) => {
      instance.close(() => resolve())
      instance.closeIdleConnections?.()
      for (const socket of sockets) socket.destroy()
      sockets.clear()
    })
  }

  /**
   * Runtime state for the settings card and `/health`.
   * @returns {{ running: boolean, host: string, port: number, address: string | null }}
   */
  function status() {
    const bound = server?.address()
    return {
      running: server !== null && bound !== null && bound !== undefined,
      host: settings.host,
      port: bound !== null && bound !== undefined && typeof bound !== 'string' ? bound.port : settings.port,
      address: address() ?? null,
    }
  }

  /**
   * Rebind to a new host/port, or start/stop on demand.
   *
   * The card edits the persisted config, so this only mutates the in-memory
   * settings; the caller persists through `configEditor` first. A failed rebind
   * restores the previous listener so the gateway is never left down by an
   * invalid port.
   *
   * @param {object} next Raw config fields to merge.
   * @param {{ running?: boolean }} [options] Desired run state.
   */
  async function applySettings(next, options = {}) {
    const previous = { host: settings.host, port: settings.port, apiKey: settings.apiKey, cors: settings.cors }
    const merged = normalizeConfig({ ...settings, ...next })
    const changed = merged.host !== settings.host || merged.port !== settings.port || merged.apiKey !== settings.apiKey
    const shouldRun = options.running ?? true

    if (changed) {
      Object.assign(settings, { host: merged.host, port: merged.port, apiKey: merged.apiKey, cors: merged.cors })
      if (server !== null) {
        await stop()
        try {
          await start()
        } catch (error) {
          Object.assign(settings, previous)
          // The old port is free again; restore it so the surface stays reachable.
          try {
            await start()
          } catch {
            // Nothing else to try; the caller reports the bind error.
          }
          throw error
        }
      }
    } else {
      Object.assign(settings, { apiKey: merged.apiKey, cors: merged.cors })
    }

    if (!shouldRun) {
      await stop()
    } else if (server === null) {
      await start()
    }
    return status()
  }

  function authorized(req) {
    if (settings.apiKey === '') return true
    const header = req.headers.authorization
    const bearer =
      typeof header === 'string' && header.slice(0, 7).toLowerCase() === 'bearer ' ? header.slice(7).trim() : ''
    const fromHeader = typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'].trim() : ''
    const provided = bearer !== '' ? bearer : fromHeader
    const expected = settings.apiKey
    const left = Buffer.from(provided)
    const right = Buffer.from(expected)
    if (left.length !== right.length) return false
    return timingSafeEqual(left, right)
  }

  async function handle(req, res) {
    if (settings.cors) {
      res.setHeader('access-control-allow-origin', '*')
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
      res.setHeader('access-control-allow-headers', 'authorization, content-type, x-api-key, openai-organization')
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const path = url.pathname.length > 1 && url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname

    if (!authorized(req)) {
      sendJson(res, 401, {
        error: {
          message: 'Invalid or missing API key.',
          type: 'authentication_error',
          param: null,
          code: 'invalid_api_key',
        },
      })
      return
    }

    if (path === '/' || path === '/health') {
      sendJson(res, 200, {
        name: 'dsh-openai-api',
        version: VERSION,
        base_url: `${address() ?? `http://${settings.host}:${settings.port}`}/v1`,
        default_model: catalog.defaultSelection()?.id ?? null,
        endpoints: {
          models: '/v1/models',
          chat_completions: '/v1/chat/completions',
          completions: '/v1/completions',
        },
      })
      return
    }

    if (path === '/v1/models' || path === '/models') {
      const entries = await catalog.entries({ force: url.searchParams.get('refresh') === '1' })
      const created = Math.floor(Date.now() / 1000)
      sendJson(res, 200, {
        object: 'list',
        data: entries.map((entry) => ({
          id: entry.id,
          object: 'model',
          created,
          owned_by: entry.provider,
          name: entry.name,
          provider: entry.provider,
          provider_name: entry.providerName,
          ...(entry.description === undefined ? {} : { description: entry.description }),
          ...(entry.inputModalities === undefined ? {} : { input_modalities: entry.inputModalities }),
        })),
      })
      return
    }

    if (path.startsWith('/v1/models/') || path.startsWith('/models/')) {
      const prefix = path.startsWith('/v1/models/') ? '/v1/models/' : '/models/'
      const id = decodeURIComponent(path.slice(prefix.length))
      const entries = await catalog.entries()
      const entry = entries.find((candidate) => candidate.id === id || candidate.model === id)
      if (entry === undefined) {
        throw new ApiError(404, `The model "${id}" does not exist or is not registered.`, {
          param: 'model',
          code: 'model_not_found',
        })
      }
      sendJson(res, 200, {
        id: entry.id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: entry.provider,
        name: entry.name,
        provider: entry.provider,
        ...(entry.inputModalities === undefined ? {} : { input_modalities: entry.inputModalities }),
      })
      return
    }

    if (path === '/v1/chat/completions' || path === '/chat/completions') {
      await completions(req, res, false)
      return
    }

    if (path === '/v1/completions' || path === '/completions') {
      await completions(req, res, true)
      return
    }

    throw new ApiError(404, `Unknown endpoint: ${req.method} ${path}`, { code: 'not_found' })
  }

  async function completions(req, res, legacy) {
    if (req.method !== 'POST') throw new ApiError(405, `Use POST for ${legacy ? '/v1/completions' : '/v1/chat/completions'}`)
    const body = await readJson(req, settings.maxBodyBytes)
    const route = await catalog.resolve(body?.model)
    const request = legacy ? buildTextCompletionRequest(body, route) : buildChatRequest(body, route)
    const wantsStream = body?.stream === true || body?.stream === 'true'
    const includeUsage = body?.stream_options?.include_usage === true
    const responseModel = typeof body?.model === 'string' && body.model !== '' ? body.model : route.id
    const id = newCompletionId()
    const created = Math.floor(Date.now() / 1000)

    const controller = new AbortController()
    let timedOut = false
    const timer =
      settings.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            controller.abort()
          }, settings.timeoutMs)
        : null
    timer?.unref?.()
    const onClose = () => {
      if (!res.writableEnded) controller.abort()
    }
    res.once('close', onClose)

    try {
      const options = {
        provider: route.provider,
        model: route.model,
        messages: request.messages,
        signal: controller.signal,
        ...(request.system === undefined ? {} : { system: request.system }),
        ...(request.tools === undefined ? {} : { tools: request.tools }),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.maxTokens === undefined && settings.defaultMaxTokens === 0
          ? {}
          : { maxTokens: request.maxTokens ?? settings.defaultMaxTokens }),
        ...(request.stop === undefined ? {} : { stop: request.stop }),
        ...(request.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: await supportedReasoningEffort(route, request.reasoningEffort, controller.signal) }),
      }
      if (options.reasoningEffort === undefined) delete options.reasoningEffort

      log.info(`[dsh-openai-api] ${legacy ? 'completion' : 'chat'} ${route.id} stream=${wantsStream}`)
      const chunks = llm.stream(options)

      if (wantsStream) {
        await streamCompletion(res, chunks, { id, created, model: responseModel, includeUsage, legacy })
      } else {
        const collector = new CompletionCollector({ exposeReasoning: settings.exposeReasoning })
        for await (const chunk of chunks) collector.accept(chunk)
        if (timedOut) throw new ApiError(504, 'The model request timed out.')
        const failure = finishFailure(collector.finish)
        if (failure !== null) throw failure
        if (legacy) {
          const calls = collector.orderedToolCalls()
          if (calls.length > 0) throw new ApiError(400, 'Legacy completions do not support tool calls.', { type: 'invalid_request_error' })
          sendJson(res, 200, {
            id,
            object: 'text_completion',
            created,
            model: responseModel,
            choices: [{ text: collector.content, index: 0, logprobs: null, finish_reason: mapFinishReason(collector.finish) }],
            usage: mapUsage(collector.usage),
          })
        } else {
          sendJson(res, 200, collector.toCompletion({ id, created, model: responseModel }))
        }
      }
    } finally {
      if (timer !== null) clearTimeout(timer)
      res.removeListener('close', onClose)
    }
  }

  async function streamCompletion(res, chunks, header) {
    res.writeHead(200, SSE_HEADERS)
    const write = (payload) => {
      if (res.writableEnded || res.destroyed) return false
      res.write(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`)
      return true
    }

    if (header.legacy) {
      write({
        id: header.id,
        object: 'text_completion',
        created: header.created,
        model: header.model,
        choices: [{ text: '', index: 0, logprobs: null, finish_reason: null }],
      })
    } else {
      const translator = new StreamTranslator({
        id: header.id,
        created: header.created,
        model: header.model,
        includeUsage: header.includeUsage,
        exposeReasoning: settings.exposeReasoning,
      })
      write(translator.roleChunk())
      for await (const chunk of chunks) {
        for (const event of translator.accept(chunk)) if (!write(event)) return
      }
      const failure = finishFailure(translator.finish)
      if (failure !== null) {
        write({ error: errorPayload(failure).body.error })
        write('[DONE]')
        res.end()
        return
      }
      for (const event of translator.finishChunks()) if (!write(event)) return
      write('[DONE]')
      res.end()
      return
    }

    // Legacy streaming: same chunks, `text_completion` framing.
    let usage = null
    for await (const chunk of chunks) {
      if (chunk.type === 'usage') usage = chunk.usage
      if (chunk.type === 'text-delta' && chunk.text !== '') {
        if (
          !write({
            id: header.id,
            object: 'text_completion',
            created: header.created,
            model: header.model,
            choices: [{ text: chunk.text, index: 0, logprobs: null, finish_reason: null }],
          })
        ) {
          return
        }
      }
      if (chunk.type === 'finish') {
        const failure = finishFailure(chunk.reason)
        if (failure !== null) {
          write({ error: errorPayload(failure).body.error })
          write('[DONE]')
          res.end()
          return
        }
        write({
          id: header.id,
          object: 'text_completion',
          created: header.created,
          model: header.model,
          choices: [{ text: '', index: 0, logprobs: null, finish_reason: mapFinishReason(chunk.reason) }],
          ...(header.includeUsage ? { usage: mapUsage(usage) } : {}),
        })
      }
    }
    write('[DONE]')
    res.end()
  }

  /**
   * Keep a client-supplied `reasoning_effort` only when the route declares it.
   * @param {{ provider: string, model: string }} route Resolved route.
   * @param {string} wanted Requested effort id.
   * @param {AbortSignal} signal Caller cancellation.
   * @returns {Promise<string | undefined>} Accepted effort id.
   */
  async function supportedReasoningEffort(route, wanted, signal) {
    try {
      const info = await llm.resolveModelInfo(route.provider, route.model, signal)
      const efforts = Array.isArray(info?.reasoning?.efforts) ? info.reasoning.efforts.map((entry) => entry.id) : []
      if (efforts.length === 0) return undefined
      return efforts.includes(wanted) ? wanted : undefined
    } catch {
      return undefined
    }
  }

  return {
    start,
    stop,
    address,
    status,
    applySettings,
    config: settings,
    invalidateCatalog: () => catalog.invalidate(),
  }
}

/**
 * Read and parse a JSON request body with a hard byte limit.
 * @param {import('node:http').IncomingMessage} req Request stream.
 * @param {number} limit Maximum accepted bytes.
 * @returns {Promise<any>} Parsed body (empty object when absent).
 */
async function readJson(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new ApiError(413, `Request body exceeds ${limit} bytes.`, { code: 'payload_too_large' })
    chunks.push(chunk)
  }
  if (size === 0) return {}
  let text = Buffer.concat(chunks).toString('utf8')
  // Some Windows clients write UTF-8 with a BOM; JSON.parse rejects it.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  try {
    return JSON.parse(text)
  } catch {
    throw new ApiError(400, 'Request body is not valid JSON.', { code: 'invalid_json' })
  }
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
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}
