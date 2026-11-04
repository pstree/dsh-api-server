/**
 * Host half of the `dsh-openai-api` bundle.
 *
 * The plugin only needs the `llm` service: it starts a loopback HTTP server
 * that translates the OpenAI wire format into provider-neutral
 * `ctx.llm.stream()` calls. No session or agent is created, so gateway traffic
 * never touches the user's chat history.
 *
 * `webServer` and `configEditor` are optional: they back the settings card, and
 * the gateway itself still works when either is absent.
 */
import { createOpenAiServer } from './lib/server.js'
import { SETTINGS_PATH, createSettingsHandler } from './lib/settings-route.js'

export const name = 'dsh-openai-api'

/** The model service is the whole capability; without it there is nothing to serve. */
export const inject = ['llm']

/** This bundle's own row id, used to address its config in the profile patch. */
const ROW_ID = 'dsh-openai-api'

/**
 * The instance currently owning the gateway.
 *
 * Persisting a new address through `configEditor` makes the Loader reconcile
 * this row, which disposes the old fiber and runs `apply()` again. The settings
 * route therefore resolves the live instance at request time instead of
 * capturing the one that registered it — otherwise the card would keep
 * reporting a stopped server after every save.
 */
let activeServer = null

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx Owning plugin context.
 * @param {object} config Bundle config from `cordis.patch.yml`.
 */
export async function apply(ctx, config) {
  const server = createOpenAiServer({
    llm: ctx.llm,
    logger: ctx.logger,
    config,
    getDefaultSelection: () => {
      try {
        return ctx.get('agentDefaultModel')?.currentSelection?.()
      } catch {
        // The default-model service is optional; the catalog falls back to it.
        return undefined
      }
    },
  })

  // A bind failure (usually EADDRINUSE) must mark this plugin failed with the
  // remedy in the message instead of leaving a silently dead endpoint.
  await server.start()
  activeServer = server

  // Provider adapters (trae, codebuddy, …) register their routes after their
  // own activation, which can land after the first catalog read. Refreshing on
  // this event keeps `/v1/models` from serving a stale, partial list.
  ctx.effect(() => ctx.on('llm/adapters-updated', () => server.invalidateCatalog()))

  ctx.inject(['webServer'], (webCtx) => {
    const persist = createPersister(webCtx, ctx)
    const dispose = webCtx.webServer.register({
      kind: 'exact',
      path: SETTINGS_PATH,
      handler: createSettingsHandler({
        getServer: () => activeServer,
        persist,
        warn: (message) => ctx.logger?.warn?.(message),
      }),
    })
    webCtx.effect(() => dispose, 'dsh-openai-api: settings route')
  })

  ctx.effect(() => () => {
    if (activeServer === server) activeServer = null
    server.stop().catch((error) => {
      ctx.logger?.warn?.(`[dsh-openai-api] shutdown failed: ${error?.message ?? error}`)
    })
  })

  ctx.logger?.info?.(`[dsh-openai-api] OpenAI-compatible API listening at ${server.address()}/v1`)
}

/**
 * Write the gateway's address fields back to this row in the profile patch.
 *
 * `configEditor` owns the Loader reconciliation, so the persisted value is the
 * same one a restart would read — and the same one that reloads this plugin.
 *
 * @param {import('@deepseek-ai/cordis').Context} webCtx Context carrying `webServer`.
 * @param {import('@deepseek-ai/cordis').Context} ctx Plugin context.
 * @returns {(patch: object) => Promise<boolean>} Persist function; false when no editor exists.
 */
function createPersister(webCtx, ctx) {
  return async function persist(patch) {
    const editor = webCtx.get('configEditor')
    if (editor === undefined) return false
    const entry = editor
      .entries()
      .find((candidate) => candidate?.options?.id === ROW_ID || candidate?.id === ROW_ID)
    if (entry === undefined) {
      ctx.logger?.warn?.(`[dsh-openai-api] no "${ROW_ID}" row to persist settings into`)
      return false
    }
    await editor.edit(entry, (current) => ({ ...current, ...patch }))
    return true
  }
}
