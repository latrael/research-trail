import type {
  ContextNodeView,
  ContextView,
  LinkCandidate,
  LiveSnapshot,
  LiveTabBinding,
  TabContext,
} from './shared/types'

export const LINK_CANDIDATE_TTL_MS = 30_000
export const LINK_CANDIDATE_FALLBACK_MS = 1_500

export function isEligibleUrl(url: string | undefined): url is string {
  if (!url) return false

  try {
    const protocol = new URL(url).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/** Canonicalizes an HTTP(S) URL without changing its fragment or query. */
export function normalizeUrl(url: string | undefined): string | undefined {
  if (!isEligibleUrl(url)) return undefined

  try {
    return new URL(url).href
  } catch {
    return undefined
  }
}

export function normalizeText(value: string | null | undefined): string {
  return value?.replace(/\s+/g, ' ').trim() ?? ''
}

/**
 * Clips a readable block around the first occurrence of the link text. The
 * returned string is never longer than maxLength, including ellipses.
 */
export function clipExcerpt(
  value: string | null | undefined,
  linkText?: string,
  maxLength = 300,
): string {
  const text = normalizeText(value)
  if (maxLength <= 0) return ''
  if (text.length <= maxLength) return text
  if (maxLength === 1) return '…'

  const focus = normalizeText(linkText)
  const focusIndex = focus ? text.toLocaleLowerCase().indexOf(focus.toLocaleLowerCase()) : -1
  const focusCenter = focusIndex >= 0 ? focusIndex + focus.length / 2 : 0

  let start = focusIndex >= 0 ? Math.max(0, Math.round(focusCenter - maxLength / 2)) : 0
  let end = Math.min(text.length, start + maxLength)

  // Reserve space for the leading/trailing ellipses and keep the slice centered.
  if (start > 0) {
    start += 1
  }
  if (end < text.length) {
    end -= 1
  }

  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  return `${prefix}${text.slice(start, end).trim()}${suffix}`.slice(0, maxLength)
}

function compareContexts(left: TabContext, right: TabContext): number {
  return left.createdAt - right.createdAt || left.id.localeCompare(right.id)
}

export function buildContextView(
  contexts: TabContext[],
  bindings: LiveTabBinding[],
  currentContextId?: string,
  unsupportedReason?: string,
): ContextView {
  const contextById = new Map(contexts.map((context) => [context.id, context]))
  const bindingByContextId = new Map(bindings.map((binding) => [binding.contextId, binding]))

  const toNode = (context: TabContext | undefined): ContextNodeView | undefined => {
    if (!context) return undefined
    const binding = bindingByContextId.get(context.id)
    return {
      ...context,
      isLive: binding !== undefined,
      ...(binding ? { browserTabId: binding.tabId } : {}),
    }
  }

  const currentContext = currentContextId ? contextById.get(currentContextId) : undefined
  if (!currentContext) {
    return {
      siblings: [],
      children: [],
      ...(unsupportedReason ? { unsupportedReason } : {}),
    }
  }

  const siblings = currentContext.parentId
    ? contexts
        .filter(
          (context) =>
            context.id !== currentContext.id && context.parentId === currentContext.parentId,
        )
        .sort(compareContexts)
        .map((context) => toNode(context) as ContextNodeView)
    : []
  const children = contexts
    .filter((context) => context.parentId === currentContext.id)
    .sort(compareContexts)
    .map((context) => toNode(context) as ContextNodeView)

  return {
    current: toNode(currentContext),
    parent: toNode(
      currentContext.parentId ? contextById.get(currentContext.parentId) : undefined,
    ),
    siblings,
    children,
    ...(unsupportedReason ? { unsupportedReason } : {}),
  }
}

export const deriveContextView = buildContextView

export type CandidateMatchInput = {
  openerTabId?: number
  url?: string
  createdAt?: number
}

/**
 * Finds at most one candidate. An exact opener + destination match wins; the
 * fallback is intentionally narrow so an ambiguous burst of clicks is ignored.
 */
export function findMatchingCandidate(
  candidates: LinkCandidate[],
  input: CandidateMatchInput,
  now = Date.now(),
): LinkCandidate | undefined {
  const fresh = candidates.filter(
    (candidate) => now >= candidate.capturedAt && now - candidate.capturedAt <= LINK_CANDIDATE_TTL_MS,
  )
  const normalizedUrl = normalizeUrl(input.url)

  if (typeof input.openerTabId === 'number' && normalizedUrl) {
    const exact = fresh.filter(
      (candidate) =>
        candidate.sourceTabId === input.openerTabId &&
        normalizeUrl(candidate.targetUrl) === normalizedUrl,
    )
    if (exact.length === 1) return exact[0]
    if (exact.length > 1) return undefined
  }

  if (typeof input.openerTabId !== 'number') return undefined

  const createdAt = input.createdAt ?? now
  const fallback = fresh.filter(
    (candidate) =>
      candidate.sourceTabId === input.openerTabId &&
      createdAt >= candidate.capturedAt &&
      createdAt - candidate.capturedAt <= LINK_CANDIDATE_FALLBACK_MS,
  )

  return fallback.length === 1 ? fallback[0] : undefined
}

export const matchLinkCandidate = findMatchingCandidate

export function withoutCandidate(
  candidates: LinkCandidate[],
  matched: LinkCandidate | undefined,
  now = Date.now(),
): LinkCandidate[] {
  return candidates.filter(
    (candidate) =>
      candidate.id !== matched?.id &&
      now >= candidate.capturedAt &&
      now - candidate.capturedAt <= LINK_CANDIDATE_TTL_MS,
  )
}

export type OpenSourceDecision =
  | { type: 'focus'; tabId: number; windowId: number }
  | { type: 'open'; url: string }
  | { type: 'unsupported' }

export function decideOpenSource(
  url: string,
  bindings: LiveTabBinding[],
): OpenSourceDecision {
  const normalizedUrl = normalizeUrl(url)
  if (!normalizedUrl) return { type: 'unsupported' }

  const existing = bindings.find((binding) => normalizeUrl(binding.url) === normalizedUrl)
  return existing
    ? { type: 'focus', tabId: existing.tabId, windowId: existing.windowId }
    : { type: 'open', url: normalizedUrl }
}

export type RestoredTab = {
  tabId: number
  url: string
  title: string
}

export type ReconciliationResult = {
  matches: Array<{ tabId: number; contextId: string }>
  unmatchedTabIds: number[]
}

function reconciliationKey(url: string, title: string): string | undefined {
  const normalizedUrl = normalizeUrl(url)
  if (!normalizedUrl) return undefined
  return `${normalizedUrl}\n${normalizeText(title)}`
}

/** Reconnects only URL/title pairs that are unique on both sides. */
export function reconcileRestoredTabs(
  tabs: RestoredTab[],
  snapshots: LiveSnapshot[],
): ReconciliationResult {
  const tabsByKey = new Map<string, RestoredTab[]>()
  const snapshotsByKey = new Map<string, LiveSnapshot[]>()

  for (const tab of tabs) {
    const key = reconciliationKey(tab.url, tab.title)
    if (!key) continue
    tabsByKey.set(key, [...(tabsByKey.get(key) ?? []), tab])
  }
  for (const snapshot of snapshots) {
    const key = reconciliationKey(snapshot.url, snapshot.title)
    if (!key) continue
    snapshotsByKey.set(key, [...(snapshotsByKey.get(key) ?? []), snapshot])
  }

  const matches: ReconciliationResult['matches'] = []
  const matchedTabIds = new Set<number>()
  for (const [key, matchingTabs] of tabsByKey) {
    const matchingSnapshots = snapshotsByKey.get(key)
    if (matchingTabs.length !== 1 || matchingSnapshots?.length !== 1) continue
    const tab = matchingTabs[0]
    const snapshot = matchingSnapshots[0]
    if (!tab || !snapshot) continue
    matches.push({ tabId: tab.tabId, contextId: snapshot.contextId })
    matchedTabIds.add(tab.tabId)
  }

  return {
    matches,
    unmatchedTabIds: tabs.map((tab) => tab.tabId).filter((tabId) => !matchedTabIds.has(tabId)),
  }
}
