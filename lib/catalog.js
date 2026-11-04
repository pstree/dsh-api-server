/**
 * Provider/model catalog for the gateway.
 *
 * The DSH `llm` service exposes registered provider routes and the models each
 * adapter advertises. Every model is addressed as `<provider>/<model>`; a bare
 * model id is accepted when it is unambiguous or when the profile has exactly
 * one provider, which keeps OpenAI-style clients (`model: "deepseek-flash"`)
 * working without configuration.
 */
import { ApiError } from './openai.js'

const PROVIDER_TIMEOUT_MS = 8000
const CACHE_TTL_MS = 60_000
/** Minimum gap between two forced reloads, so a typo'd model cannot hammer discovery. */
const FORCE_MIN_INTERVAL_MS = 5000

/**
 * Reject rather than hang when an adapter's discovery endpoint never answers.
 * @param {Promise<unknown>} promise Underlying discovery call.
 * @param {number} ms Budget in milliseconds.
 * @returns {Promise<unknown>} The original result.
 */
function withTimeout(promise, ms) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`model discovery timed out after ${ms}ms`)), ms)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** Cached, provider-aware view of every callable model route. */
export class ModelCatalog {
  /**
   * @param {object} options Catalog dependencies.
   * @param {object} options.llm The Host `llm` service.
   * @param {object} options.config Normalized gateway settings.
   * @param {object} [options.logger] Host logger; a no-op fallback is used.
   * @param {() => ({ provider?: string, model?: string } | undefined)} [options.getDefaultSelection]
   */
  constructor({ llm, config, logger, getDefaultSelection }) {
    this.llm = llm
    this.config = config
    this.logger = logger
    this.getDefaultSelection = getDefaultSelection
    /** @type {{ at: number, entries: object[] } | null} */
    this.cache = null
    /** Provider routes seen by the last successful listing. */
    this.providers = []
    this.inflight = null
    this.lastForceAt = 0
  }

  /**
   * Drop the cached catalog so the next read sees adapters that registered
   * after the previous load. Called on `llm/adapters-updated`.
   */
  invalidate() {
    // Keep the entries as a stale fallback for a failing discovery run.
    if (this.cache !== null) this.cache = { at: 0, entries: this.cache.entries }
  }

  /**
   * @param {{ force?: boolean }} [options] Bypass the TTL cache.
   * @returns {Promise<object[]>} Callable model entries in provider order.
   */
  async entries(options = {}) {
    const force = options.force === true
    if (force && this.cache !== null && Date.now() - this.lastForceAt < FORCE_MIN_INTERVAL_MS) {
      return this.cache.entries
    }
    const fresh = this.cache !== null && Date.now() - this.cache.at < CACHE_TTL_MS
    if (!force && fresh) return this.cache.entries
    if (force) this.lastForceAt = Date.now()
    if (this.inflight !== null) return this.inflight
    this.inflight = this.#load()
      .catch((error) => {
        this.logger?.warn?.(`[dsh-openai-api] model catalog refresh failed: ${error?.message ?? error}`)
        // Serve a stale catalog rather than no catalog at all.
        return this.cache?.entries ?? []
      })
      .finally(() => {
        this.inflight = null
      })
    return this.inflight
  }

  async #load() {
    let providers = []
    try {
      providers = this.llm.listProviders() ?? []
    } catch (error) {
      this.logger?.warn?.(`[dsh-openai-api] provider listing failed: ${error?.message ?? error}`)
    }

    const previous = new Map((this.cache?.entries ?? []).map((entry) => [entry.id, entry]))
    const entries = []
    const providerIds = []

    for (const provider of providers) {
      if (typeof provider?.id !== 'string' || provider.id === '') continue
      providerIds.push(provider.id)
      let models = []
      try {
        models = (await withTimeout(Promise.resolve(this.llm.listModels(provider.id)), PROVIDER_TIMEOUT_MS)) ?? []
      } catch (error) {
        this.logger?.warn?.(
          `[dsh-openai-api] model discovery for provider "${provider.id}" failed: ${error?.message ?? error}`,
        )
        for (const entry of previous.values()) if (entry.provider === provider.id) entries.push(entry)
        continue
      }
      for (const model of models) {
        if (typeof model?.id !== 'string' || model.id === '') continue
        entries.push({
          id: `${provider.id}/${model.id}`,
          provider: provider.id,
          providerName: typeof provider.name === 'string' && provider.name !== '' ? provider.name : provider.id,
          model: model.id,
          name: typeof model.name === 'string' && model.name !== '' ? model.name : model.id,
          ...(typeof model.description === 'string' && model.description !== ''
            ? { description: model.description }
            : {}),
          ...(Array.isArray(model.inputModalities) ? { inputModalities: [...model.inputModalities] } : {}),
        })
      }
    }

    this.providers = providerIds
    // An empty catalog is never worth caching: provider adapters register
    // asynchronously after their own activation, so a startup query can land
    // before trae/codebuddy finish registering their routes.
    this.cache = { at: entries.length === 0 ? 0 : Date.now(), entries }
    return entries
  }

  /**
   * Read the profile's default selection, without requiring the service.
   * @returns {{ provider: string, model: string, id: string } | undefined} Resolved route.
   */
  defaultSelection() {
    try {
      const selection = this.getDefaultSelection?.()
      if (typeof selection?.provider === 'string' && typeof selection?.model === 'string') {
        return { provider: selection.provider, model: selection.model, id: `${selection.provider}/${selection.model}` }
      }
    } catch {
      // The service is optional; fall through to the configured default.
    }
    if (this.config.defaultModel !== '') return parseRouteId(this.config.defaultModel)
    return undefined
  }

  /**
   * Resolve the `model` field of a request to one concrete provider route.
   * @param {unknown} requested Raw OpenAI `model` value.
   * @returns {Promise<{ provider: string, model: string, id: string }>} Resolved route.
   */
  async resolve(requested) {
    const wanted = typeof requested === 'string' ? requested.trim() : ''
    const entries = await this.entries()

    if (wanted === '') {
      const fallback = this.defaultSelection()
      if (fallback !== undefined) return fallback
      if (entries.length > 0) return routeOf(entries[0])
      throw new ApiError(
        400,
        "No 'model' was provided and this profile has no default model. Set config.defaultModel or pass provider/model.",
        { param: 'model', code: 'model_required' },
      )
    }

    const explicit = parseRouteId(wanted)
    if (explicit !== undefined) return explicit

    let matches = entries.filter((entry) => entry.model === wanted)
    if (matches.length === 0) {
      // The model may have been added by an adapter that registered after the
      // last catalog load; retry once against a forced refresh before 404ing.
      const refreshed = await this.entries({ force: true })
      matches = refreshed.filter((entry) => entry.model === wanted)
    }
    if (matches.length === 1) return routeOf(matches[0])
    if (matches.length > 1) {
      const listed = matches.map((entry) => entry.id).join(', ')
      throw new ApiError(400, `Model "${wanted}" is served by several providers (${listed}); prefix it with one.`, {
        param: 'model',
        code: 'model_ambiguous',
      })
    }

    // With no advertised catalog (discovery failed or none configured yet) an
    // unprefixed id can only be routed by trusting the single known provider.
    if (entries.length === 0) {
      if (this.providers.length === 1) {
        return { provider: this.providers[0], model: wanted, id: `${this.providers[0]}/${wanted}` }
      }
      const fallback = this.defaultSelection()
      if (fallback !== undefined) {
        return { provider: fallback.provider, model: wanted, id: `${fallback.provider}/${wanted}` }
      }
      throw new ApiError(404, `The model "${wanted}" does not exist or is not registered.`, {
        param: 'model',
        code: 'model_not_found',
      })
    }

    const known = entries.slice(0, 8).map((entry) => entry.id)
    throw new ApiError(
      404,
      `The model "${wanted}" does not exist or is not registered.${known.length > 0 ? ` Available: ${known.join(', ')}.` : ''}`,
      { param: 'model', code: 'model_not_found' },
    )
  }
}

/**
 * Parse `provider/model` without assuming the model id is slash-free.
 * @param {string} value Candidate route id.
 * @returns {{ provider: string, model: string, id: string } | undefined} Route, or undefined when bare.
 */
function parseRouteId(value) {
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) return undefined
  return { provider: value.slice(0, slash), model: value.slice(slash + 1), id: value }
}

/**
 * @param {object} entry Catalog entry.
 * @returns {{ provider: string, model: string, id: string }} Route for that entry.
 */
function routeOf(entry) {
  return { provider: entry.provider, model: entry.model, id: entry.id }
}
