/**
 * OpenAI wire-format translation for the local DSH model gateway.
 *
 * Everything in this module is pure (no HTTP, no Cordis): it turns an OpenAI
 * chat-completions body into the arguments of `ctx.llm.stream()`, and turns the
 * provider-neutral `StreamChunk` sequence back into OpenAI stream chunks and
 * completions.
 */
import { randomUUID } from 'node:crypto'

/** Default loopback port. Kept stable so clients can be pointed at it once. */
export const DEFAULT_PORT = 8787
export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
export const DEFAULT_MAX_BODY_BYTES = 24 * 1024 * 1024

/** One OpenAI-shaped request failure that is safe to show to the client. */
export class ApiError extends Error {
  /**
   * @param {number} status HTTP status code.
   * @param {string} message Client-facing message.
   * @param {object} [options] OpenAI error envelope fields.
   */
  constructor(status, message, options = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.type = options.type ?? 'invalid_request_error'
    this.param = options.param ?? null
    this.code = options.code ?? null
  }
}

/** Generate the `chatcmpl-…` identifier OpenAI clients expect to see. */
export function newCompletionId() {
  return `chatcmpl-${randomUUID().replaceAll('-', '')}`
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

/**
 * Apply defaults and bounds to the raw Loader row config.
 * @param {unknown} raw The `config:` object from cordis.patch.yml.
 * @returns Normalized settings consumed by the server.
 */
export function normalizeConfig(raw) {
  const config = isObject(raw) ? raw : {}
  const host = typeof config.host === 'string' && config.host.trim() !== '' ? config.host.trim() : DEFAULT_HOST
  // Port 0 is accepted so a test can bind an ephemeral port.
  const port =
    Number.isInteger(config.port) && config.port >= 0 && config.port <= 65535 ? config.port : DEFAULT_PORT
  const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : ''
  const defaultModel = typeof config.defaultModel === 'string' ? config.defaultModel.trim() : ''
  return {
    host,
    port,
    apiKey,
    defaultModel,
    defaultMaxTokens: positiveInteger(config.defaultMaxTokens, 0),
    timeoutMs: positiveInteger(config.timeoutMs, DEFAULT_TIMEOUT_MS),
    maxBodyBytes: positiveInteger(config.maxBodyBytes, DEFAULT_MAX_BODY_BYTES),
    cors: config.cors !== false,
    exposeReasoning: config.exposeReasoning !== false,
  }
}

/**
 * Render one thrown value as the OpenAI `{ error: … }` envelope.
 * @param {unknown} error Thrown value, usually an {@link ApiError} or an LLM failure.
 * @returns `{ status, body }` ready for `res.writeHead`/`res.end`.
 */
export function errorPayload(error) {
  if (error instanceof ApiError) {
    return {
      status: error.status,
      body: { error: { message: error.message, type: error.type, param: error.param, code: error.code } },
    }
  }
  const code = typeof error?.code === 'string' && error.code !== '' ? error.code : null
  const status = statusForCode(code)
  const message = typeof error?.message === 'string' && error.message !== '' ? error.message : 'Internal server error.'
  return { status, body: { error: { message, type: typeForStatus(status), param: null, code } } }
}

function statusForCode(code) {
  switch (code) {
    case 'AUTH':
    case 'MISSING_CREDENTIAL':
    case 'INVALID_CREDENTIAL':
      return 401
    case 'QUOTA':
    case 'ACCOUNT_QUOTA':
      return 402
    case 'RATE_LIMIT':
      return 429
    case 'INVALID_REQUEST':
    case 'UNSUPPORTED_CONTENT':
    case 'UNSUPPORTED_REASONING_EFFORT':
    case 'CONTEXT_WINDOW_EXCEEDED':
    case 'INVALID_REPLAY_STATE':
    case 'UNKNOWN_MODEL':
      return 400
    case 'TIMEOUT':
      return 504
    case 'SERVER':
    case 'TRANSPORT':
    case 'EMPTY_RESPONSE':
    case 'STREAM_CLOSED':
    case 'MALFORMED_RESPONSE':
      return 502
    default:
      return 500
  }
}

function typeForStatus(status) {
  if (status === 401) return 'authentication_error'
  if (status === 429) return 'rate_limit_error'
  if (status >= 500) return 'api_error'
  return 'invalid_request_error'
}

/**
 * Normalize `stop` from either a string or a list of strings.
 * @param {unknown} value Raw OpenAI field.
 * @returns {string[] | undefined} At most four distinct non-empty strings.
 */
function normalizeStop(value) {
  const list = typeof value === 'string' ? [value] : Array.isArray(value) ? value : null
  if (list === null) return undefined
  const stops = []
  for (const entry of list) {
    if (typeof entry !== 'string' || entry === '') {
      throw new ApiError(400, "'stop' must be a string or an array of non-empty strings", { param: 'stop' })
    }
    if (!stops.includes(entry)) stops.push(entry)
  }
  return stops.length === 0 ? undefined : stops.slice(0, 4)
}

/**
 * Flatten one OpenAI message content value into text.
 * Image parts are rejected explicitly: the gateway forwards text and tool calls.
 * @param {unknown} content `string`, `null`, or an array of content parts.
 * @param {string} path Diagnostic path for the error message.
 * @returns {string} The concatenated text.
 */
function contentToText(content, path) {
  if (content === null || content === undefined) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) {
    throw new ApiError(400, `${path} must be a string or an array of content parts`, { param: path })
  }
  let text = ''
  for (const [index, part] of content.entries()) {
    if (!isObject(part)) throw new ApiError(400, `${path}[${index}] must be an object`, { param: path })
    switch (part.type) {
      case 'text':
      case 'input_text':
        if (typeof part.text !== 'string') {
          throw new ApiError(400, `${path}[${index}].text must be a string`, { param: path })
        }
        text += part.text
        break
      case 'image_url':
      case 'input_image':
        throw new ApiError(
          400,
          'Image input is not supported by this gateway yet; send text content only.',
          { type: 'invalid_request_error', param: path, code: 'unsupported_content' },
        )
      default:
        throw new ApiError(400, `${path}[${index}].type "${String(part.type)}" is not supported`, { param: path })
    }
  }
  return text
}

/**
 * Convert OpenAI `tools` into DSH `ToolSchema` entries.
 * @param {unknown} tools Raw OpenAI tools array.
 * @returns {object[] | undefined} Tool declarations, or undefined when none were supplied.
 */
function convertTools(tools) {
  if (tools === undefined || tools === null) return undefined
  if (!Array.isArray(tools)) throw new ApiError(400, "'tools' must be an array", { param: 'tools' })
  const converted = []
  for (const [index, tool] of tools.entries()) {
    if (!isObject(tool)) throw new ApiError(400, `tools[${index}] must be an object`, { param: 'tools' })
    if (tool.type !== undefined && tool.type !== 'function') {
      throw new ApiError(400, `tools[${index}].type must be "function"`, { param: 'tools' })
    }
    const fn = tool.function
    if (!isObject(fn) || typeof fn.name !== 'string' || fn.name === '') {
      throw new ApiError(400, `tools[${index}].function.name is required`, { param: 'tools' })
    }
    const parameters = isObject(fn.parameters) ? fn.parameters : { type: 'object', properties: {} }
    converted.push({
      name: fn.name,
      description: typeof fn.description === 'string' ? fn.description : '',
      parameters,
    })
  }
  return converted.length === 0 ? undefined : converted
}

/**
 * Apply `tool_choice` to the declared tools.
 * @param {object[] | undefined} tools Declarations produced by {@link convertTools}.
 * @param {unknown} choice Raw OpenAI `tool_choice`.
 * @returns {object[] | undefined} The tools the model may call.
 */
function applyToolChoice(tools, choice) {
  if (tools === undefined || choice === undefined || choice === null) return tools
  if (choice === 'none') return undefined
  if (choice === 'auto' || choice === 'required') return tools
  if (isObject(choice) && isObject(choice.function) && typeof choice.function.name === 'string') {
    const name = choice.function.name
    const selected = tools.filter((tool) => tool.name === name)
    if (selected.length === 0) {
      throw new ApiError(400, `tool_choice names unknown tool "${name}"`, { param: 'tool_choice' })
    }
    return selected
  }
  throw new ApiError(400, "'tool_choice' must be \"none\", \"auto\", \"required\", or a function selector", {
    param: 'tool_choice',
  })
}

/**
 * Build the `ctx.llm.stream()` arguments for one `/v1/chat/completions` body.
 *
 * System and developer messages collapse into the single `system` string the
 * provider-neutral call config exposes; every other message becomes a durable
 * DSH message shape (text blocks, assistant tool-call blocks, tool results).
 * @param {unknown} body Parsed OpenAI request body.
 * @param {{ provider: string, model: string }} route Resolved provider route.
 * @returns Normalized call description.
 */
export function buildChatRequest(body, route) {
  if (!isObject(body)) throw new ApiError(400, 'Request body must be a JSON object')
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new ApiError(400, "'messages' must be a non-empty array", { param: 'messages' })
  }

  const systemParts = []
  const messages = []

  for (const [index, message] of body.messages.entries()) {
    if (!isObject(message)) throw new ApiError(400, `messages[${index}] must be an object`, { param: 'messages' })
    const path = `messages[${index}]`
    const role = message.role

    if (role === 'system' || role === 'developer') {
      const text = contentToText(message.content, `${path}.content`)
      if (text !== '') systemParts.push(text)
      continue
    }

    if (role === 'user') {
      const text = contentToText(message.content, `${path}.content`)
      messages.push({ role: 'user', content: text === '' ? [] : [{ type: 'text', text }] })
      continue
    }

    if (role === 'assistant') {
      const blocks = []
      const text = contentToText(message.content, `${path}.content`)
      if (text !== '') blocks.push({ type: 'text', text })
      const calls = message.tool_calls
      if (calls !== undefined && calls !== null) {
        if (!Array.isArray(calls)) throw new ApiError(400, `${path}.tool_calls must be an array`, { param: path })
        for (const [callIndex, call] of calls.entries()) {
          if (!isObject(call)) throw new ApiError(400, `${path}.tool_calls[${callIndex}] must be an object`, { param: path })
          const fn = call.function
          if (!isObject(fn) || typeof fn.name !== 'string' || fn.name === '') {
            throw new ApiError(400, `${path}.tool_calls[${callIndex}].function.name is required`, { param: path })
          }
          const id = typeof call.id === 'string' && call.id !== '' ? call.id : `call_${index}_${callIndex}`
          const args =
            typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {})
          blocks.push({ type: 'tool-call', id, name: fn.name, arguments: args })
        }
      }
      if (blocks.length === 0) continue
      messages.push({
        role: 'assistant',
        content: blocks,
        source: { kind: 'model', provider: route.provider, model: route.model },
      })
      continue
    }

    if (role === 'tool' || role === 'function') {
      if (typeof message.tool_call_id !== 'string' || message.tool_call_id === '') {
        throw new ApiError(400, `${path}.tool_call_id is required for a tool result`, { param: path })
      }
      const text = contentToText(message.content, `${path}.content`)
      messages.push({
        role: 'tool',
        toolCallId: message.tool_call_id,
        content: [{ type: 'text', text }],
        ...(message.is_error === true ? { isError: true } : {}),
      })
      continue
    }

    throw new ApiError(400, `${path}.role "${String(role)}" is not supported`, { param: path })
  }

  if (messages.length === 0) {
    throw new ApiError(400, "'messages' must contain at least one user, assistant, or tool message", {
      param: 'messages',
    })
  }

  const tools = applyToolChoice(convertTools(body.tools), body.tool_choice)
  const maxTokens =
    positiveInteger(body.max_completion_tokens, 0) || positiveInteger(body.max_tokens, 0) || undefined
  const temperature =
    typeof body.temperature === 'number' && Number.isFinite(body.temperature) ? body.temperature : undefined
  const reasoningEffort =
    typeof body.reasoning_effort === 'string' && body.reasoning_effort !== '' ? body.reasoning_effort : undefined
  const n = body.n === undefined || body.n === null ? 1 : body.n
  if (n !== 1) {
    throw new ApiError(400, 'Only n=1 is supported by this gateway', { param: 'n' })
  }

  return {
    messages,
    system: systemParts.length === 0 ? undefined : systemParts.join('\n\n'),
    tools,
    maxTokens,
    temperature,
    stop: normalizeStop(body.stop),
    reasoningEffort,
  }
}

/**
 * Build the call description for the legacy `/v1/completions` endpoint.
 * @param {unknown} body Parsed completion request body.
 * @param {{ provider: string, model: string }} route Resolved provider route.
 * @returns Normalized call description plus the requested prompt count check.
 */
export function buildTextCompletionRequest(body, route) {
  if (!isObject(body)) throw new ApiError(400, 'Request body must be a JSON object')
  const prompts = Array.isArray(body.prompt) ? body.prompt : [body.prompt]
  if (prompts.length !== 1 || typeof prompts[0] !== 'string') {
    throw new ApiError(400, "Only a single string 'prompt' is supported", { param: 'prompt' })
  }
  const chat = buildChatRequest(
    {
      messages: [{ role: 'user', content: prompts[0] }],
      max_tokens: body.max_tokens,
      temperature: body.temperature,
      stop: body.stop,
      reasoning_effort: body.reasoning_effort,
    },
    route,
  )
  return { ...chat, prompt: prompts[0] }
}

/**
 * Map a DSH finish reason onto the OpenAI vocabulary.
 * @param {{ kind?: string } | null} reason Terminal reason from the stream.
 * @returns {'stop' | 'tool_calls' | 'length'} OpenAI finish reason.
 */
export function mapFinishReason(reason) {
  switch (reason?.kind) {
    case 'tool-calls':
      return 'tool_calls'
    case 'max-tokens':
      return 'length'
    default:
      return 'stop'
  }
}

/**
 * Turn a terminal error/aborted finish into a client-facing failure.
 * @param {{ kind?: string, failure?: object } | null} reason Terminal reason.
 * @returns {ApiError | null} The failure, or null for a normal finish.
 */
export function finishFailure(reason) {
  if (reason?.kind !== 'error' && reason?.kind !== 'aborted') return null
  const failure = isObject(reason.failure) ? reason.failure : {}
  const status = Number.isInteger(failure.status) && failure.status >= 400 ? failure.status : 502
  return new ApiError(status, failure.message || 'The upstream model request failed.', {
    type: 'upstream_error',
    code: failure.code ?? 'upstream_error',
  })
}

/**
 * Map DSH token accounting onto the OpenAI usage object.
 * @param {object | null} usage Token usage from the `usage` chunk.
 * @returns OpenAI usage object.
 */
export function mapUsage(usage) {
  const cacheRead = usage?.cacheReadTokens ?? 0
  const cacheWrite = usage?.cacheWriteTokens ?? 0
  const prompt = (usage?.inputTokens ?? 0) + cacheRead + cacheWrite
  const completion = usage?.outputTokens ?? 0
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: usage?.totalTokens ?? prompt + completion,
    ...(cacheRead > 0 ? { prompt_tokens_details: { cached_tokens: cacheRead } } : {}),
    ...(usage?.reasoningTokens ? { completion_tokens_details: { reasoning_tokens: usage.reasoningTokens } } : {}),
  }
}

/**
 * Fold a chunk stream into one complete assistant message.
 * Used for non-streaming responses so both paths share one chunk interpretation.
 */
export class CompletionCollector {
  /** @param {{ exposeReasoning?: boolean }} [options] Presentation options. */
  constructor(options = {}) {
    this.exposeReasoning = options.exposeReasoning !== false
    this.content = ''
    this.reasoning = ''
    this.usage = null
    this.finish = null
    /** @type {Map<number, { index: number, id: string, name: string, arguments: string }>} */
    this.toolCalls = new Map()
  }

  /** @param {object} chunk One `StreamChunk` from `ctx.llm.stream()`. */
  accept(chunk) {
    switch (chunk.type) {
      case 'text-delta':
        this.content += chunk.text
        break
      case 'reasoning-delta':
        this.reasoning += chunk.text
        break
      case 'tool-call-delta': {
        const key = chunk.index ?? this.toolCalls.size
        let call = this.toolCalls.get(key)
        if (call === undefined) {
          call = { index: this.toolCalls.size, id: chunk.id ?? `call_${key}`, name: '', arguments: '' }
          this.toolCalls.set(key, call)
        }
        if (typeof chunk.id === 'string' && chunk.id !== '') call.id = chunk.id
        if (typeof chunk.name === 'string' && chunk.name !== '') call.name = chunk.name
        call.arguments += chunk.argumentsDelta ?? ''
        break
      }
      case 'usage':
        this.usage = chunk.usage
        break
      case 'finish':
        this.finish = chunk.reason
        break
      default:
        break
    }
  }

  /** @returns {object[]} Tool calls in first-seen order. */
  orderedToolCalls() {
    return [...this.toolCalls.values()].sort((left, right) => left.index - right.index)
  }

  /**
   * Build the OpenAI `chat.completion` object.
   * @param {{ id: string, created: number, model: string }} header Response identity.
   * @returns Complete response body.
   */
  toCompletion(header) {
    const calls = this.orderedToolCalls()
    const message = {
      role: 'assistant',
      content: calls.length > 0 ? (this.content === '' ? null : this.content) : this.content,
    }
    if (this.exposeReasoning && this.reasoning !== '') message.reasoning_content = this.reasoning
    if (calls.length > 0) {
      message.tool_calls = calls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments === '' ? '{}' : call.arguments },
      }))
    }
    return {
      id: header.id,
      object: 'chat.completion',
      created: header.created,
      model: header.model,
      choices: [{ index: 0, message, finish_reason: mapFinishReason(this.finish), logprobs: null }],
      usage: mapUsage(this.usage),
    }
  }
}

/**
 * Translate `StreamChunk`s into OpenAI `chat.completion.chunk` payloads.
 *
 * Tool calls are re-indexed to the dense 0..n order OpenAI specifies, and the
 * provider `index` only keys the mapping.
 */
export class StreamTranslator {
  /** @param {{ id: string, created: number, model: string, includeUsage?: boolean, exposeReasoning?: boolean }} header */
  constructor(header) {
    this.id = header.id
    this.created = header.created
    this.model = header.model
    this.includeUsage = header.includeUsage === true
    this.exposeReasoning = header.exposeReasoning !== false
    /** @type {Map<number, { index: number, id: string, name: string, started: boolean }>} */
    this.toolCalls = new Map()
    this.usage = null
    this.finish = null
  }

  /** @returns {object} The opening chunk that announces the assistant role. */
  roleChunk() {
    return this.#chunk({ role: 'assistant', content: '' }, null)
  }

  /**
   * @param {object} chunk One `StreamChunk`.
   * @returns {object[]} Zero or more OpenAI stream chunks.
   */
  accept(chunk) {
    switch (chunk.type) {
      case 'text-delta':
        return chunk.text === '' ? [] : [this.#chunk({ content: chunk.text }, null)]
      case 'reasoning-delta':
        return !this.exposeReasoning || chunk.text === ''
          ? []
          : [this.#chunk({ reasoning_content: chunk.text }, null)]
      case 'tool-call-delta':
        return this.#toolChunk(chunk)
      case 'usage':
        this.usage = chunk.usage
        return []
      case 'finish':
        this.finish = chunk.reason
        return []
      default:
        return []
    }
  }

  /** @returns {object[]} The closing chunk(s), including usage when requested. */
  finishChunks() {
    const chunks = [this.#chunk({}, mapFinishReason(this.finish))]
    if (this.includeUsage) {
      chunks.push({
        id: this.id,
        object: 'chat.completion.chunk',
        created: this.created,
        model: this.model,
        choices: [],
        usage: mapUsage(this.usage),
      })
    }
    return chunks
  }

  #toolChunk(chunk) {
    const key = chunk.index ?? this.toolCalls.size
    let slot = this.toolCalls.get(key)
    if (slot === undefined) {
      slot = { index: this.toolCalls.size, id: chunk.id ?? `call_${key}`, name: '', started: false }
      this.toolCalls.set(key, slot)
    }
    if (typeof chunk.id === 'string' && chunk.id !== '') slot.id = chunk.id
    if (typeof chunk.name === 'string' && chunk.name !== '') slot.name = chunk.name
    const delta = chunk.argumentsDelta ?? ''
    if (!slot.started) {
      slot.started = true
      return [
        this.#chunk(
          {
            tool_calls: [
              {
                index: slot.index,
                id: slot.id,
                type: 'function',
                function: { name: slot.name, arguments: delta },
              },
            ],
          },
          null,
        ),
      ]
    }
    if (delta === '') return []
    return [this.#chunk({ tool_calls: [{ index: slot.index, function: { arguments: delta } }] }, null)]
  }

  #chunk(delta, finishReason) {
    return {
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    }
  }
}
