/**
 * Phase 59 (ROUTE-06, ROUTE-07, D-07): Discord-only RouterProvider assembly.
 *
 * assembleRouterProvider builds a semaphore-wrapped RouterProvider for Discord
 * profiles that declare routerConfig. It is the ONLY place outside
 * src/providers/ that constructs a RouterProvider instance.
 *
 * Structure (outermost → innermost):
 *
 *   semaphore(
 *     RouterProvider(
 *       classifier: bare_provider OR FallbackProvider(bare_primary, bare_fallback),
 *       simple:     bare_provider OR FallbackProvider(bare_primary, bare_fallback),
 *       complex:    bare_provider OR FallbackProvider(bare_primary, bare_fallback),
 *     )
 *   )
 *
 * Bare sub-providers deliberately DO NOT pass through createProvider() because
 * createProvider re-applies the semaphore. ROUTE-07 / Pitfall 3: exactly one
 * outer semaphore per process. Sub-providers are raw buildProvider() output
 * optionally FallbackProvider-wrapped per D-07.
 *
 * COST-04 (Phase 61): `routerConfig.fallbacks.classifier` is honored here via
 * `buildSlot` — when set and not identical to the primary classifier provider,
 * the classifier slot becomes a FallbackProvider that reuses Phase 45's
 * 429 backoff + Retry-After + `provider_switch` audit. This prevents Z.ai
 * rate-limit windows from fail-opening every classifier call to the expensive
 * `complex` path; the local `llamacpp` rig (or any configured fallback)
 * absorbs those 429 events instead.
 */
import type { Provider } from '../providers/types.js'
import type { KristosConfig, RouterConfig } from '../config/types.js'
import { RouterProvider } from '../providers/router.js'
import { FallbackProvider } from '../providers/fallback.js'
import { buildProvider, wrapWithSemaphore } from '../providers/registry.js'
import type { LLMSemaphore } from '../providers/semaphore.js'
import type { BiasCache } from '../shared/trajectory.js'

/**
 * Assemble a semaphore-wrapped RouterProvider for a Discord profile's routerConfig.
 *
 * @param kcConfig  - full KristosConfig (supplies providerConfigs + model defaults)
 * @param routerConfig - the profile-level routerConfig declaring classifier/simple/complex slots
 * @param semaphore - the process-wide LLMSemaphore (from getOrCreateSemaphore)
 * @returns semaphore-wrapped RouterProvider (name === 'router')
 */
export function assembleRouterProvider(
  kcConfig: KristosConfig,
  routerConfig: RouterConfig,
  semaphore: LLMSemaphore,
  biasCache?: BiasCache,
): Provider {
  const classifier = buildSlot(
    kcConfig,
    routerConfig.classifier,
    routerConfig.classifierModel,
    routerConfig.fallbacks?.classifier,
  )
  const simple = buildSlot(
    kcConfig,
    routerConfig.simple,
    routerConfig.simpleModel,
    routerConfig.fallbacks?.simple,
  )
  const complex = buildSlot(
    kcConfig,
    routerConfig.complex,
    routerConfig.complexModel,
    routerConfig.fallbacks?.complex,
  )

  // Phase 74 (ROUTE-02): build optional per-intent slots when model overrides are configured.
  // no orchestration slot: ROUTE-03 orchestration always uses complex.
  const code = routerConfig.codeModel
    ? buildSlot(kcConfig, routerConfig.complex, routerConfig.codeModel, routerConfig.fallbacks?.complex)
    : undefined
  const research = routerConfig.researchModel
    ? buildSlot(kcConfig, routerConfig.complex, routerConfig.researchModel, routerConfig.fallbacks?.complex)
    : undefined
  const casual = routerConfig.casualModel
    ? buildSlot(kcConfig, routerConfig.simple, routerConfig.casualModel, routerConfig.fallbacks?.simple)
    : undefined

  const router = new RouterProvider({ classifier, simple, complex, code, research, casual, config: routerConfig, biasCache, transport: 'discord' })
  return wrapWithSemaphore(router, semaphore)
}

/**
 * Build a single provider slot — bare provider or FallbackProvider-wrapped.
 * Uses buildProvider directly (NOT createProvider) to avoid double-semaphore wrapping.
 *
 * Exported for COST-04 (Phase 61) behavioral tests that need to verify the
 * classifier slot is FallbackProvider-wrapped when `fallbacks.classifier` is
 * configured. Not intended for use outside the router-assembly module +
 * router-assembly.test.ts.
 */
export function buildSlot(
  kcConfig: KristosConfig,
  providerName: KristosConfig['provider'],
  modelOverride: string | undefined,
  fallbackProviderName: KristosConfig['provider'] | undefined,
): Provider {
  const effectiveModel = modelOverride ?? kcConfig.model
  const primary = buildProvider(providerName, kcConfig.providerConfigs, effectiveModel)

  if (!fallbackProviderName || fallbackProviderName === providerName) {
    return primary
  }

  const fallback = buildProvider(fallbackProviderName, kcConfig.providerConfigs, effectiveModel)
  return new FallbackProvider(primary, fallback)
}
