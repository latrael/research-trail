export const SCHEMA_VERSION = 1 as const

export type TabContext = {
  id: string
  currentUrl: string
  currentTitle: string
  openedUrl: string
  parentId?: string
  linkText?: string
  surroundingText?: string
  intentNote?: string
  createdAt: number
  updatedAt: number
  closedAt?: number
}

export type ResearchItem = {
  id: string
  selectedText: string
  url: string
  pageTitle: string
  tabContextId?: string
  note?: string
  createdAt: number
  updatedAt: number
}

export type CapturedLink = {
  targetUrl: string
  linkText: string
  surroundingText: string
  capturedAt: number
}

export type LinkCandidate = CapturedLink & {
  id: string
  sourceTabId: number
  sourceContextId?: string
}

export type LiveTabBinding = {
  tabId: number
  contextId: string
  windowId: number
  index: number
  url: string
  title: string
}

export type ProvisionalTab = {
  tabId: number
  openerTabId?: number
  createdAt: number
}

export type LiveSnapshot = {
  contextId: string
  lastTabId: number
  url: string
  title: string
  updatedAt: number
}

export type ContextNodeView = TabContext & {
  isLive: boolean
  browserTabId?: number
}

export type ContextView = {
  current?: ContextNodeView
  parent?: ContextNodeView
  siblings: ContextNodeView[]
  children: ContextNodeView[]
  unsupportedReason?: string
}

export type AppViewModel = {
  context: ContextView
  researchItems: ResearchItem[]
  lastError?: string
}

export type RuntimeRequest =
  | { type: 'GET_VIEW_MODEL'; tabId: number }
  | { type: 'UPDATE_TAB_NOTE'; contextId: string; note: string }
  | { type: 'UPDATE_RESEARCH_NOTE'; itemId: string; note: string }
  | { type: 'DELETE_RESEARCH_ITEM'; itemId: string }
  | { type: 'ACTIVATE_CONTEXT'; contextId: string }
  | { type: 'OPEN_RESEARCH_SOURCE'; itemId: string }
  | { type: 'CLEAR_TAB_HISTORY' }
  | { type: 'RECORD_LINK_CANDIDATE'; candidate: CapturedLink }

export type RuntimeEvent = { type: 'STATE_CHANGED' }

export type AppError = {
  code: string
  message: string
}

export type RuntimeResponse<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: AppError }

