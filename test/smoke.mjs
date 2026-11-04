/**
 * End-to-end smoke test with a fake `llm` service.
 *
 * It exercises the real HTTP server, the catalog, the request translation, and
 * both response paths, without needing the Harness runtime. Run with
 * `node test/smoke.mjs`.
 */
import assert from 'node:assert/strict'
import { createOpenAiServer } from '../lib/server.js'

const USAGE = { inputTokens: 7, outputTokens: 3, totalTokens: 10 }

/** Build the provider-neutral chunk sequence a real adapter would emit. */
async function* textStream() {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: 'Hello' }
  yield { type: 'text-delta', index: 0, text: ', world' }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello, world' } }
  yield { type: 'usage', usage: USAGE }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

async function* toolStream() {
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id: 'call_abc', name: 'get_weather', argumentsDelta: '{"city"' }
  yield { type: 'tool-call-delta', index: 0, id: 'call_abc', argumentsDelta: ':"Paris"}' }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_abc', name: 'get_weather', arguments: '{"city":"Paris"}' } }
  yield { type: 'usage', usage: USAGE }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

async function* failureStream() {
  yield { type: 'finish', reason: { kind: 'error', failure: { message: 'upstream exploded', code: 'SERVER' } } }
}

function lastUserText(options) {
  for (let index = options.messages.length - 1; index >= 0; index -= 1) {
    const message = options.messages[index]
    if (message.role !== 'user') continue
    return (message.content ?? []).map((block) => block.text ?? '').join('')
  }
  return ''
}

function createFakeLlm() {
  return {
    listProviders: () => [{ id: 'fake', name: 'Fake Provider' }],
    listModels: async (provider) => [
      { provider, id: 'fake-chat', name: 'Fake Chat' },
      { provider, id: 'fake-tool', name: 'Fake Tool' },
    ],
    resolveModelInfo: async (provider, model) => ({
      provider,
      id: model,
      name: model,
      reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] },
    }),
    stream(options) {
      const text = lastUserText(options)
      if (text.includes('FAIL')) return failureStream()
      if (text.includes('TOOL')) return toolStream()
      return textStream()
    },
  }
}

const results = []
function check(name, fn) {
  results.push({ name, fn })
}

async function readSse(response) {
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)
  const text = await response.text()
  return text
    .split('\n\n')
    .map((frame) => frame.trim())
    .filter((frame) => frame !== '')
    .map((frame) => {
      assert.ok(frame.startsWith('data: '), `unexpected SSE frame: ${frame}`)
      const payload = frame.slice('data: '.length)
      return payload === '[DONE]' ? '[DONE]' : JSON.parse(payload)
    })
}

async function main() {
  const llm = createFakeLlm()
  const server = createOpenAiServer({ llm, config: { port: 0 } })
  await server.start()
  const base = server.address()

  const authed = createOpenAiServer({ llm, config: { port: 0, apiKey: 'secret-key' } })
  await authed.start()
  const authBase = authed.address()

  let failed = 0
  try {
    check('GET /v1/models lists provider/model ids', async () => {
      const response = await fetch(`${base}/v1/models`)
      assert.equal(response.status, 200)
      const body = await response.json()
      assert.equal(body.object, 'list')
      assert.deepEqual(
        body.data.map((entry) => entry.id),
        ['fake/fake-chat', 'fake/fake-tool'],
      )
      assert.equal(body.data[0].owned_by, 'fake')
    })

    check('POST /v1/chat/completions returns an OpenAI completion', async () => {
      const response = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'fake/fake-chat',
          messages: [
            { role: 'system', content: 'Be nice.' },
            { role: 'user', content: 'Say hello' },
          ],
        }),
      })
      assert.equal(response.status, 200)
      const body = await response.json()
      assert.equal(body.object, 'chat.completion')
      assert.equal(body.choices[0].message.content, 'Hello, world')
      assert.equal(body.choices[0].finish_reason, 'stop')
      assert.equal(body.usage.prompt_tokens, 7)
      assert.equal(body.usage.completion_tokens, 3)
    })

    check('bare model ids resolve through the catalog', async () => {
      const response = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'fake-chat', messages: [{ role: 'user', content: 'hi' }] }),
      })
      assert.equal(response.status, 200)
      assert.equal((await response.json()).choices[0].message.content, 'Hello, world')
    })

    check('stream=true emits OpenAI chunks and terminates with [DONE]', async () => {
      const response = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'fake/fake-chat',
          stream: true,
          stream_options: { include_usage: true },
          messages: [{ role: 'user', content: 'Say hello' }],
        }),
      })
      const events = await readSse(response)
      assert.equal(events.at(-1), '[DONE]')
      const chunks = events.slice(0, -1)
      assert.equal(chunks[0].choices[0].delta.role, 'assistant')
      const text = chunks.map((chunk) => chunk.choices[0]?.delta?.content ?? '').join('')
      assert.equal(text, 'Hello, world')
      const usageChunk = chunks.find((chunk) => Array.isArray(chunk.choices) && chunk.choices.length === 0)
      assert.equal(usageChunk.usage.total_tokens, 10)
    })

    check('tool calls are translated into OpenAI tool_calls', async () => {
      const response = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'fake/fake-tool',
          messages: [{ role: 'user', content: 'TOOL please' }],
          tools: [
            {
              type: 'function',
              function: {
                name: 'get_weather',
                description: 'Read the weather',
                parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
              },
            },
          ],
        }),
      })
      assert.equal(response.status, 200)
      const body = await response.json()
      assert.equal(body.choices[0].finish_reason, 'tool_calls')
      assert.equal(body.choices[0].message.tool_calls[0].id, 'call_abc')
      assert.equal(body.choices[0].message.tool_calls[0].function.name, 'get_weather')
      assert.deepEqual(JSON.parse(body.choices[0].message.tool_calls[0].function.arguments), { city: 'Paris' })
    })

    check('streaming tool calls re-index deltas from zero', async () => {
      const response = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'fake/fake-tool',
          stream: true,
          messages: [{ role: 'user', content: 'TOOL please' }],
        }),
      })
      const events = (await readSse(response)).slice(0, -1)
      const deltas = events.flatMap((chunk) => chunk.choices[0]?.delta?.tool_calls ?? [])
      assert.equal(deltas[0].index, 0)
      assert.equal(deltas[0].id, 'call_abc')
      assert.equal(deltas[0].function.name, 'get_weather')
      assert.equal(deltas.map((delta) => delta.function.arguments ?? '').join(''), '{"city":"Paris"}')
    })

    check('unknown endpoints and bodies return OpenAI error envelopes', async () => {
      const missing = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'fake/fake-chat', messages: [] }),
      })
      assert.equal(missing.status, 400)
      assert.equal((await missing.json()).error.type, 'invalid_request_error')

      const unknownModel = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'nope', messages: [{ role: 'user', content: 'hi' }] }),
      })
      assert.equal(unknownModel.status, 404)

      const unknownPath = await fetch(`${base}/v1/nope`)
      assert.equal(unknownPath.status, 404)
    })

    check('upstream failures become 502 with the provider message', async () => {
      const response = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'fake/fake-chat', messages: [{ role: 'user', content: 'FAIL' }] }),
      })
      assert.equal(response.status, 502)
      const body = await response.json()
      assert.equal(body.error.message, 'upstream exploded')
      assert.equal(body.error.type, 'upstream_error')
    })

    check('apiKey requires a matching bearer token', async () => {
      const denied = await fetch(`${authBase}/v1/models`)
      assert.equal(denied.status, 401)
      const allowed = await fetch(`${authBase}/v1/models`, {
        headers: { authorization: 'Bearer secret-key' },
      })
      assert.equal(allowed.status, 200)
    })

    check('legacy /v1/completions is served', async () => {
      const response = await fetch(`${base}/v1/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'fake/fake-chat', prompt: 'Say hello' }),
      })
      assert.equal(response.status, 200)
      const body = await response.json()
      assert.equal(body.object, 'text_completion')
      assert.equal(body.choices[0].text, 'Hello, world')
    })

    check('UTF-8 BOM prefixed bodies are accepted', async () => {
      const response = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: `\uFEFF${JSON.stringify({ model: 'fake/fake-chat', messages: [{ role: 'user', content: 'hi' }] })}`,
      })
      assert.equal(response.status, 200)
      assert.equal((await response.json()).choices[0].message.content, 'Hello, world')
    })

    check('a late-registering adapter appears without waiting for the cache TTL', async () => {
      const late = createFakeLlm()
      const lateServer = createOpenAiServer({ llm: late, config: { port: 0 } })
      await lateServer.start()
      try {
        // Simulate a provider whose adapter registers after the first read.
        late.listProviders = () => []
        const before = await (await fetch(`${lateServer.address()}/v1/models`)).json()
        assert.equal(before.data.length, 0)

        late.listProviders = () => [{ id: 'late', name: 'Late Provider' }]
        late.listModels = async (provider) => [{ provider, id: 'late-chat', name: 'Late Chat' }]
        lateServer.invalidateCatalog()

        const after = await (await fetch(`${lateServer.address()}/v1/models`)).json()
        assert.deepEqual(after.data.map((entry) => entry.id), ['late/late-chat'])
      } finally {
        await lateServer.stop()
      }
    })

    check('the runtime can rebind to another port and stop/start on demand', async () => {
      const live = createOpenAiServer({ llm, config: { port: 0 } })
      await live.start()
      try {
        assert.equal(live.status().running, true)

        const next = await live.applySettings({ port: 0 }, { running: true })
        assert.equal(next.running, true)
        assert.equal((await fetch(`${next.address}/v1/models`)).status, 200)

        const stopped = await live.applySettings({}, { running: false })
        assert.equal(stopped.running, false)
        await assert.rejects(fetch(`${next.address}/v1/models`))

        const restarted = await live.applySettings({}, { running: true })
        assert.equal(restarted.running, true)
        assert.equal((await fetch(`${restarted.address}/v1/models`)).status, 200)
      } finally {
        await live.stop()
      }
    })

    for (const { name, fn } of results) {
      try {
        await fn()
        console.log(`ok   ${name}`)
      } catch (error) {
        failed += 1
        console.error(`FAIL ${name}\n${error?.stack ?? error}`)
      }
    }
  } finally {
    await server.stop()
    await authed.stop()
  }

  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  if (failed > 0) process.exitCode = 1
}

await main()
