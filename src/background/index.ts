import {
  LINK_CANDIDATE_FALLBACK_MS,
  buildContextView,
  decideOpenSource,
  findMatchingCandidate,
  normalizeUrl,
  reconcileRestoredTabs,
  withoutCandidate,
} from '../core'
import { browserApi, isEligibleTab, isEligibleUrl } from '../platform/chrome'
import type {
  AppError,
  AppViewModel,
  LinkCandidate,
  LiveTabBinding,
  ResearchItem,
  RuntimeEvent,
  RuntimeRequest,
  RuntimeResponse,
  TabContext,
} from '../shared/types'
import { storageRepository as repository } from './storage'

const RESEARCH_MENU_ID = 'research-trail:add-selection'

class RequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

let mutationTail: Promise<void> = Promise.resolve()
let initializationPromise: Promise<void> | undefined
let lastError: string | undefined

function createId(): string {
  return crypto.randomUUID()
}

function asError(error: unknown, fallbackCode = 'INTERNAL_ERROR'): AppError {
  if (error instanceof RequestError) {
    return { code: error.code, message: error.message }
  }
  if (error instanceof Error) {
    return { code: fallbackCode, message: error.message }
  }
  return { code: fallbackCode, message: 'An unexpected extension error occurred.' }
}

function recordBackgroundError(error: unknown): void {
  lastError = asError(error).message
  void Promise.allSettled([
    browserApi.action.setBadgeBackgroundColor({ color: '#b42318' }),
    browserApi.action.setBadgeText({ text: '!' }),
    browserApi.action.setTitle({ title: `Research Trail: ${lastError}` }),
  ])
}

async function clearBackgroundError(): Promise<void> {
  if (!lastError) return
  lastError = undefined
  await Promise.allSettled([
    browserApi.action.setBadgeText({ text: '' }),
    browserApi.action.setTitle({ title: 'Open Research Trail' }),
  ])
}

function notifyStateChanged(): void {
  const event: RuntimeEvent = { type: 'STATE_CHANGED' }
  browserApi.runtime.sendMessage(event, () => {
    // Reading lastError prevents a harmless "receiving end does not exist"
    // message when no side panel is open.
    void browserApi.runtime.lastError
  })
}

function runSerialized<T>(operation: () => Promise<T>): Promise<T> {
  const run = mutationTail.then(async () => {
    await ensureInitialized()
    const result = await operation()
    await clearBackgroundError()
    return result
  })
  mutationTail = run.then(
    () => undefined,
    (error) => {
      recordBackgroundError(error)
    },
  )
  return run
}

async function setupContextMenu(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    browserApi.contextMenus.removeAll(() => {
      const removeError = browserApi.runtime.lastError
      if (removeError) {
        reject(new Error(removeError.message))
        return
      }

      browserApi.contextMenus.create(
        {
          id: RESEARCH_MENU_ID,
          title: 'Add to Research Cart',
          contexts: ['selection'],
          documentUrlPatterns: ['http://*/*', 'https://*/*'],
        },
        () => {
          const createError = browserApi.runtime.lastError
          if (createError) reject(new Error(createError.message))
          else resolve()
        },
      )
    })
  })
}

function tabUrl(tab: chrome.tabs.Tab): string | undefined {
  return tab.pendingUrl ?? tab.url
}

function bindingForTab(tab: chrome.tabs.Tab & { id: number; url: string }, contextId: string): LiveTabBinding {
  return {
    tabId: tab.id,
    contextId,
    windowId: tab.windowId,
    index: tab.index,
    url: tabUrl(tab) ?? tab.url,
    title: tab.title ?? '',
  }
}

async function persistOpenContext(context: TabContext, tab: chrome.tabs.Tab & { id: number; url: string }): Promise<void> {
  const { closedAt: _closedAt, ...openContext } = context
  const updated: TabContext = {
    ...openContext,
    currentUrl: tabUrl(tab) ?? context.currentUrl,
    currentTitle: tab.title ?? context.currentTitle,
    updatedAt: Date.now(),
  }
  const binding = bindingForTab(tab, context.id)

  await repository.putContext(updated)
  await repository.putBinding(binding)
  await repository.putSnapshot({
    contextId: context.id,
    lastTabId: tab.id,
    url: binding.url,
    title: binding.title,
    updatedAt: updated.updatedAt,
  })
}

async function createContextForTab(
  tab: chrome.tabs.Tab & { id: number; url: string },
  openerTabId: number | null | undefined = tab.openerTabId,
  createdAt = Date.now(),
): Promise<TabContext> {
  const existingBinding = await repository.getBinding(tab.id)
  if (existingBinding) {
    const existingContext = await repository.getContext(existingBinding.contextId)
    if (existingContext) return existingContext
  }

  const candidates = await repository.listCandidates()
  const matchedCandidate = findMatchingCandidate(
    candidates,
    { openerTabId: openerTabId ?? undefined, url: tabUrl(tab), createdAt },
    Date.now(),
  )
  await repository.replaceCandidates(withoutCandidate(candidates, matchedCandidate))

  const openerBinding =
    typeof openerTabId === 'number' ? await repository.getBinding(openerTabId) : undefined
  const url = tabUrl(tab) ?? tab.url
  const now = Date.now()
  const parentId = openerBinding?.contextId ?? matchedCandidate?.sourceContextId
  const context: TabContext = {
    id: createId(),
    currentUrl: url,
    currentTitle: tab.title ?? '',
    openedUrl: url,
    ...(parentId ? { parentId } : {}),
    ...(matchedCandidate?.linkText ? { linkText: matchedCandidate.linkText } : {}),
    ...(matchedCandidate?.surroundingText
      ? { surroundingText: matchedCandidate.surroundingText }
      : {}),
    createdAt: now,
    updatedAt: now,
  }

  await persistOpenContext(context, tab)
  await repository.deleteProvisional(tab.id)
  return context
}

async function reconcileOpenTabs(): Promise<void> {
  const tabs = await browserApi.tabs.query({})
  const tabById = new Map(
    tabs.filter((tab): tab is chrome.tabs.Tab & { id: number } => typeof tab.id === 'number').map((tab) => [tab.id, tab]),
  )
  const contexts = await repository.listContexts()
  const contextById = new Map(contexts.map((context) => [context.id, context]))
  const bindings = await repository.listBindings()

  for (const binding of bindings) {
    const tab = tabById.get(binding.tabId)
    if (tab) continue

    const context = contextById.get(binding.contextId)
    if (context) {
      await repository.putContext({ ...context, closedAt: Date.now(), updatedAt: Date.now() })
    }
    await repository.deleteBinding(binding.tabId)
    await repository.deleteSnapshot(binding.contextId)
  }

  const liveBindings = await repository.listBindings()
  const boundTabIds = new Set(liveBindings.map((binding) => binding.tabId))
  const boundContextIds = new Set(liveBindings.map((binding) => binding.contextId))
  const eligibleUnbound = tabs.filter(
    (tab): tab is chrome.tabs.Tab & { id: number; url: string } =>
      isEligibleTab(tab) && !boundTabIds.has(tab.id),
  )
  const snapshots = (await repository.listSnapshots()).filter(
    (snapshot) => !boundContextIds.has(snapshot.contextId) && contextById.has(snapshot.contextId),
  )
  const reconciliation = reconcileRestoredTabs(
    eligibleUnbound.map((tab) => ({
      tabId: tab.id,
      url: tabUrl(tab) ?? tab.url,
      title: tab.title ?? '',
    })),
    snapshots,
  )
  const eligibleById = new Map(eligibleUnbound.map((tab) => [tab.id, tab]))
  const matchedContextIds = new Set(reconciliation.matches.map((match) => match.contextId))

  for (const match of reconciliation.matches) {
    const tab = eligibleById.get(match.tabId)
    const context = contextById.get(match.contextId)
    if (tab && context) await persistOpenContext(context, tab)
  }
  for (const tabId of reconciliation.unmatchedTabIds) {
    const tab = eligibleById.get(tabId)
    // Existing tabs that cannot be reconciled safely are independent roots.
    if (tab) await createContextForTab(tab, null)
  }

  // Unmatched restart snapshots are no longer live. Keeping them would make
  // later restarts increasingly ambiguous for repeated URLs.
  for (const snapshot of snapshots) {
    if (matchedContextIds.has(snapshot.contextId)) continue
    const context = contextById.get(snapshot.contextId)
    if (context) {
      const now = Date.now()
      await repository.putContext({ ...context, closedAt: now, updatedAt: now })
    }
    await repository.deleteSnapshot(snapshot.contextId)
  }

  // Refresh metadata for bindings that survived a service-worker restart.
  for (const binding of liveBindings) {
    const tab = tabById.get(binding.tabId)
    const context = contextById.get(binding.contextId)
    if (tab && context && isEligibleTab(tab)) await persistOpenContext(context, tab)
  }
}

async function initialize(): Promise<void> {
  await repository.initialize()
  await browserApi.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  await setupContextMenu()
  await reconcileOpenTabs()
}

function ensureInitialized(): Promise<void> {
  if (!initializationPromise) {
    const attempt = initialize()
    initializationPromise = attempt.catch((error) => {
      initializationPromise = undefined
      recordBackgroundError(error)
      throw error
    })
  }
  return initializationPromise
}

async function processCreatedTab(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.incognito || typeof tab.id !== 'number') return
  if (await repository.getBinding(tab.id)) return

  if (!isEligibleTab(tab)) {
    await repository.putProvisional({
      tabId: tab.id,
      ...(typeof tab.openerTabId === 'number' ? { openerTabId: tab.openerTabId } : {}),
      createdAt: Date.now(),
    })
    return
  }

  await createContextForTab(tab)
  notifyStateChanged()
}

async function processUpdatedTab(
  tabId: number,
  changeInfo: chrome.tabs.OnUpdatedInfo,
  tab: chrome.tabs.Tab,
): Promise<void> {
  if (tab.incognito || (!changeInfo.url && changeInfo.title === undefined)) return

  const binding = await repository.getBinding(tabId)
  if (!binding) {
    if (!isEligibleTab(tab)) return
    const provisional = await repository.getProvisional(tabId)
    await createContextForTab(tab, provisional?.openerTabId ?? tab.openerTabId, provisional?.createdAt)
    notifyStateChanged()
    return
  }

  if (!isEligibleTab(tab)) {
    notifyStateChanged()
    return
  }

  const context = await repository.getContext(binding.contextId)
  if (!context) {
    await repository.deleteBinding(tabId)
    await createContextForTab(tab)
    notifyStateChanged()
    return
  }

  await persistOpenContext(context, tab)
  notifyStateChanged()
}

async function processRemovedTab(tabId: number): Promise<void> {
  const binding = await repository.getBinding(tabId)
  await repository.deleteProvisional(tabId)
  if (!binding) return

  const context = await repository.getContext(binding.contextId)
  if (context) {
    const now = Date.now()
    await repository.putContext({ ...context, closedAt: now, updatedAt: now })
  }
  await repository.deleteBinding(tabId)
  await repository.deleteSnapshot(binding.contextId)
  notifyStateChanged()
}

async function processReplacedTab(addedTabId: number, removedTabId: number): Promise<void> {
  const oldBinding = await repository.getBinding(removedTabId)
  const oldProvisional = await repository.getProvisional(removedTabId)
  const tab = await browserApi.tabs.get(addedTabId)

  if (oldBinding) {
    await repository.deleteBinding(removedTabId)
    const context = await repository.getContext(oldBinding.contextId)
    if (context && isEligibleTab(tab)) {
      await persistOpenContext(context, tab)
    } else {
      const replacementBinding: LiveTabBinding = {
        ...oldBinding,
        tabId: addedTabId,
        windowId: tab.windowId,
        index: tab.index,
      }
      await repository.putBinding(replacementBinding)
      await repository.putSnapshot({
        contextId: oldBinding.contextId,
        lastTabId: addedTabId,
        url: oldBinding.url,
        title: oldBinding.title,
        updatedAt: Date.now(),
      })
    }
  } else if (oldProvisional) {
    await repository.putProvisional({ ...oldProvisional, tabId: addedTabId })
    await repository.deleteProvisional(removedTabId)
  } else if (isEligibleTab(tab)) {
    await createContextForTab(tab)
  }
  notifyStateChanged()
}

async function ensureContextForTabId(tabId: number): Promise<LiveTabBinding | undefined> {
  const existing = await repository.getBinding(tabId)
  if (existing) return existing

  let tab: chrome.tabs.Tab
  try {
    tab = await browserApi.tabs.get(tabId)
  } catch {
    return undefined
  }
  if (!isEligibleTab(tab)) return undefined
  const context = await createContextForTab(tab)
  return repository.getBinding(tabId).then(
    (binding) => binding ?? bindingForTab(tab, context.id),
  )
}

async function getViewModel(tabId: number): Promise<AppViewModel> {
  let unsupportedReason: string | undefined
  try {
    const tab = await browserApi.tabs.get(tabId)
    if (!isEligibleTab(tab)) {
      unsupportedReason = 'Research Trail is available on regular HTTP and HTTPS pages.'
    }
  } catch {
    unsupportedReason = 'No active browser tab is available.'
  }

  const binding = unsupportedReason ? undefined : await ensureContextForTabId(tabId)
  const [contexts, bindings, researchItems] = await Promise.all([
    repository.listContexts(),
    repository.listBindings(),
    repository.listResearchItems(),
  ])

  return {
    context: buildContextView(contexts, bindings, binding?.contextId, unsupportedReason),
    researchItems: researchItems.sort(
      (left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id),
    ),
    ...(lastError ? { lastError } : {}),
  }
}

async function updateTabNote(contextId: string, note: string): Promise<void> {
  const context = await repository.getContext(contextId)
  if (!context) throw new RequestError('NOT_FOUND', 'The tab context no longer exists.')
  const trimmed = note.trim()
  const updated: TabContext = {
    ...context,
    ...(trimmed ? { intentNote: trimmed } : {}),
    updatedAt: Date.now(),
  }
  if (!trimmed) delete updated.intentNote
  await repository.putContext(updated)
  notifyStateChanged()
}

async function updateResearchNote(itemId: string, note: string): Promise<void> {
  const item = await repository.getResearchItem(itemId)
  if (!item) throw new RequestError('NOT_FOUND', 'The research item no longer exists.')
  const trimmed = note.trim()
  const updated: ResearchItem = {
    ...item,
    ...(trimmed ? { note: trimmed } : {}),
    updatedAt: Date.now(),
  }
  if (!trimmed) delete updated.note
  await repository.putResearchItem(updated)
  notifyStateChanged()
}

async function focusTab(tabId: number, windowId: number): Promise<void> {
  await browserApi.windows.update(windowId, { focused: true })
  await browserApi.tabs.update(tabId, { active: true })
}

async function activateContext(contextId: string): Promise<void> {
  const context = await repository.getContext(contextId)
  if (!context) throw new RequestError('NOT_FOUND', 'The tab context no longer exists.')

  const binding = (await repository.listBindings()).find(
    (candidate) => candidate.contextId === contextId,
  )
  if (binding) {
    try {
      await focusTab(binding.tabId, binding.windowId)
      return
    } catch {
      await repository.deleteBinding(binding.tabId)
    }
  }

  const url = normalizeUrl(context.currentUrl)
  if (!url) throw new RequestError('UNSUPPORTED_URL', 'This source URL cannot be opened.')
  const tab = await browserApi.tabs.create({ url, active: true })
  if (!isEligibleTab(tab)) {
    throw new RequestError('TAB_OPEN_FAILED', 'Chrome did not return the newly opened tab.')
  }
  await persistOpenContext(context, tab)
  notifyStateChanged()
}

async function openResearchSource(itemId: string): Promise<void> {
  const item = await repository.getResearchItem(itemId)
  if (!item) throw new RequestError('NOT_FOUND', 'The research item no longer exists.')

  const decision = decideOpenSource(item.url, await repository.listBindings())
  if (decision.type === 'unsupported') {
    throw new RequestError('UNSUPPORTED_URL', 'This source URL cannot be opened.')
  }
  if (decision.type === 'focus') {
    try {
      await focusTab(decision.tabId, decision.windowId)
      return
    } catch {
      await repository.deleteBinding(decision.tabId)
    }
  }
  await browserApi.tabs.create({ url: item.url, active: true })
}

async function clearTabHistory(): Promise<void> {
  await repository.deleteAllContexts()
  await repository.detachResearchItemsFromContexts()
  await repository.clearTransientState()

  const tabs = await browserApi.tabs.query({})
  for (const tab of tabs) {
    if (isEligibleTab(tab)) await createContextForTab(tab, null)
  }
  notifyStateChanged()
}

async function recordLinkCandidate(
  request: Extract<RuntimeRequest, { type: 'RECORD_LINK_CANDIDATE' }>,
  sender: chrome.runtime.MessageSender,
): Promise<void> {
  const sourceTab = sender.tab
  if (!sourceTab || !isEligibleTab(sourceTab) || !isEligibleUrl(request.candidate.targetUrl)) {
    throw new RequestError('INVALID_SOURCE', 'Link context can only be captured from a web page.')
  }

  const binding = await ensureContextForTabId(sourceTab.id)
  const candidates = await repository.listCandidates()
  const candidate: LinkCandidate = {
    id: createId(),
    sourceTabId: sourceTab.id,
    ...(binding ? { sourceContextId: binding.contextId } : {}),
    targetUrl: request.candidate.targetUrl,
    linkText: request.candidate.linkText.slice(0, 500),
    surroundingText: request.candidate.surroundingText.slice(0, 1_000),
    capturedAt:
      Math.abs(Date.now() - request.candidate.capturedAt) <= 60_000
        ? request.candidate.capturedAt
        : Date.now(),
  }

  // Usually the content-script message arrives before tabs.onCreated, but the
  // two browser events are not ordered. If the child was already persisted,
  // enrich exactly one recent plausible context instead of leaving a stale
  // candidate that can never be applied.
  if (candidate.sourceContextId) {
    const contexts = await repository.listContexts()
    const recentChildren = contexts.filter(
      (context) =>
        context.parentId === candidate.sourceContextId &&
        !context.linkText &&
        context.createdAt >= candidate.capturedAt &&
        context.createdAt - candidate.capturedAt <= LINK_CANDIDATE_FALLBACK_MS,
    )
    const exactChildren = recentChildren.filter(
      (context) => normalizeUrl(context.openedUrl) === normalizeUrl(candidate.targetUrl),
    )
    const match =
      exactChildren.length === 1
        ? exactChildren[0]
        : exactChildren.length === 0 && recentChildren.length === 1
          ? recentChildren[0]
          : undefined

    if (match) {
      await repository.putContext({
        ...match,
        ...(candidate.linkText ? { linkText: candidate.linkText } : {}),
        ...(candidate.surroundingText
          ? { surroundingText: candidate.surroundingText }
          : {}),
        updatedAt: Date.now(),
      })
      notifyStateChanged()
      return
    }
  }
  await repository.replaceCandidates(withoutCandidate([...candidates, candidate], undefined))
}

async function saveSelection(
  info: chrome.contextMenus.OnClickData,
  tab: chrome.tabs.Tab | undefined,
): Promise<void> {
  const selectedText = info.selectionText?.trim()
  if (!selectedText || !tab || !isEligibleTab(tab)) return

  const url = isEligibleUrl(info.pageUrl) ? info.pageUrl : tabUrl(tab)
  if (!url || !isEligibleUrl(url)) return
  const binding = await ensureContextForTabId(tab.id)
  const now = Date.now()
  const item: ResearchItem = {
    id: createId(),
    selectedText,
    url,
    pageTitle: tab.title ?? url,
    ...(binding ? { tabContextId: binding.contextId } : {}),
    createdAt: now,
    updatedAt: now,
  }
  await repository.putResearchItem(item)
  notifyStateChanged()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new RequestError('INVALID_REQUEST', `${field} must be a string.`)
  }
  return value
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new RequestError('INVALID_REQUEST', `${field} must be a non-negative integer.`)
  }
  return value
}

async function handleRequest(
  rawRequest: unknown,
  sender: chrome.runtime.MessageSender,
): Promise<RuntimeResponse> {
  if (!isRecord(rawRequest) || typeof rawRequest.type !== 'string') {
    throw new RequestError('INVALID_REQUEST', 'The extension request is malformed.')
  }

  switch (rawRequest.type) {
    case 'GET_VIEW_MODEL': {
      const tabId = requireNumber(rawRequest.tabId, 'tabId')
      return { ok: true, data: await runSerialized(() => getViewModel(tabId)) }
    }
    case 'UPDATE_TAB_NOTE': {
      const contextId = requireString(rawRequest.contextId, 'contextId')
      const note = requireString(rawRequest.note, 'note')
      await runSerialized(() => updateTabNote(contextId, note))
      return { ok: true, data: null }
    }
    case 'UPDATE_RESEARCH_NOTE': {
      const itemId = requireString(rawRequest.itemId, 'itemId')
      const note = requireString(rawRequest.note, 'note')
      await runSerialized(() => updateResearchNote(itemId, note))
      return { ok: true, data: null }
    }
    case 'DELETE_RESEARCH_ITEM': {
      const itemId = requireString(rawRequest.itemId, 'itemId')
      await runSerialized(async () => {
        await repository.deleteResearchItem(itemId)
        notifyStateChanged()
      })
      return { ok: true, data: null }
    }
    case 'ACTIVATE_CONTEXT': {
      const contextId = requireString(rawRequest.contextId, 'contextId')
      await runSerialized(() => activateContext(contextId))
      return { ok: true, data: null }
    }
    case 'OPEN_RESEARCH_SOURCE': {
      const itemId = requireString(rawRequest.itemId, 'itemId')
      await runSerialized(() => openResearchSource(itemId))
      return { ok: true, data: null }
    }
    case 'CLEAR_TAB_HISTORY': {
      await runSerialized(clearTabHistory)
      return { ok: true, data: null }
    }
    case 'RECORD_LINK_CANDIDATE': {
      if (!isRecord(rawRequest.candidate)) {
        throw new RequestError('INVALID_REQUEST', 'candidate must be an object.')
      }
      const candidate = {
        targetUrl: requireString(rawRequest.candidate.targetUrl, 'candidate.targetUrl'),
        linkText: requireString(rawRequest.candidate.linkText, 'candidate.linkText'),
        surroundingText: requireString(
          rawRequest.candidate.surroundingText,
          'candidate.surroundingText',
        ),
        capturedAt: requireNumber(rawRequest.candidate.capturedAt, 'candidate.capturedAt'),
      }
      await runSerialized(() =>
        recordLinkCandidate({ type: 'RECORD_LINK_CANDIDATE', candidate }, sender),
      )
      return { ok: true, data: null }
    }
    default:
      throw new RequestError('UNKNOWN_REQUEST', `Unsupported request type: ${rawRequest.type}`)
  }
}

// Listener registration is deliberately synchronous. Each callback schedules
// its work after initialization through the single mutation queue.
browserApi.runtime.onInstalled.addListener(() => {
  void ensureInitialized().catch(() => undefined)
})

browserApi.runtime.onStartup.addListener(() => {
  void ensureInitialized().catch(() => undefined)
})

browserApi.tabs.onCreated.addListener((tab) => {
  void runSerialized(() => processCreatedTab(tab))
})

browserApi.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  void runSerialized(() => processUpdatedTab(tabId, changeInfo, tab))
})

browserApi.tabs.onRemoved.addListener((tabId) => {
  void runSerialized(() => processRemovedTab(tabId))
})

browserApi.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  void runSerialized(() => processReplacedTab(addedTabId, removedTabId))
})

browserApi.tabs.onActivated.addListener(() => {
  notifyStateChanged()
})

browserApi.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== RESEARCH_MENU_ID) return
  void runSerialized(() => saveSelection(info, tab))
})

browserApi.runtime.onMessage.addListener((request: unknown, sender, sendResponse) => {
  if (isRecord(request) && request.type === 'STATE_CHANGED') return false

  void handleRequest(request, sender)
    .then((response) => sendResponse(response))
    .catch((error: unknown) => {
      const appError = asError(error)
      recordBackgroundError(error)
      const response: RuntimeResponse = { ok: false, error: appError }
      sendResponse(response)
    })

  // Chrome 114 requires literal true to keep sendResponse alive for async work.
  return true
})

void ensureInitialized().catch(() => undefined)
