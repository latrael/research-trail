import { describe, expect, it } from 'vitest'
import {
  buildContextView,
  clipExcerpt,
  decideOpenSource,
  findMatchingCandidate,
  normalizeText,
  normalizeUrl,
  reconcileRestoredTabs,
  withoutCandidate,
} from './core'
import type { LinkCandidate, LiveSnapshot, LiveTabBinding, TabContext } from './shared/types'

const contexts: TabContext[] = [
  {
    id: 'root',
    currentUrl: 'https://example.com/',
    currentTitle: 'Root',
    openedUrl: 'https://example.com/',
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: 'current',
    currentUrl: 'https://example.com/a',
    currentTitle: 'A',
    openedUrl: 'https://example.com/a',
    parentId: 'root',
    createdAt: 2,
    updatedAt: 2,
  },
  {
    id: 'sibling',
    currentUrl: 'https://example.com/b',
    currentTitle: 'B',
    openedUrl: 'https://example.com/b',
    parentId: 'root',
    createdAt: 3,
    updatedAt: 3,
    closedAt: 4,
  },
  {
    id: 'child',
    currentUrl: 'https://example.com/c',
    currentTitle: 'C',
    openedUrl: 'https://example.com/c',
    parentId: 'current',
    createdAt: 4,
    updatedAt: 4,
  },
]

const bindings: LiveTabBinding[] = [
  {
    tabId: 10,
    contextId: 'root',
    windowId: 1,
    index: 0,
    url: 'https://example.com/',
    title: 'Root',
  },
  {
    tabId: 11,
    contextId: 'current',
    windowId: 1,
    index: 1,
    url: 'https://example.com/a',
    title: 'A',
  },
]

function candidate(overrides: Partial<LinkCandidate> = {}): LinkCandidate {
  return {
    id: 'candidate-1',
    sourceTabId: 10,
    sourceContextId: 'root',
    targetUrl: 'https://example.com/a',
    linkText: 'A',
    surroundingText: 'Open A',
    capturedAt: 10_000,
    ...overrides,
  }
}

describe('URL and text normalization', () => {
  it('accepts only HTTP(S) URLs and lets URL canonicalize them', () => {
    expect(normalizeUrl('HTTPS://EXAMPLE.COM:443')).toBe('https://example.com/')
    expect(normalizeUrl('chrome://extensions')).toBeUndefined()
    expect(normalizeUrl('not a url')).toBeUndefined()
  })

  it('normalizes whitespace and clips around the link text', () => {
    expect(normalizeText('  first\n  second\tthird ')).toBe('first second third')
    const excerpt = clipExcerpt(`${'before '.repeat(40)}important link${' after'.repeat(40)}`, 'important link', 80)
    expect(excerpt.length).toBeLessThanOrEqual(80)
    expect(excerpt).toContain('important link')
    expect(excerpt.startsWith('…')).toBe(true)
    expect(excerpt.endsWith('…')).toBe(true)
  })
})

describe('context graph view', () => {
  it('derives parent, siblings, children, and liveness', () => {
    const view = buildContextView(contexts, bindings, 'current')

    expect(view.current).toMatchObject({ id: 'current', isLive: true, browserTabId: 11 })
    expect(view.parent).toMatchObject({ id: 'root', isLive: true, browserTabId: 10 })
    expect(view.siblings).toEqual([expect.objectContaining({ id: 'sibling', isLive: false })])
    expect(view.children).toEqual([expect.objectContaining({ id: 'child', isLive: false })])
  })

  it('returns an empty view for an unknown current context', () => {
    expect(buildContextView(contexts, bindings, 'missing', 'Unavailable')).toEqual({
      siblings: [],
      children: [],
      unsupportedReason: 'Unavailable',
    })
  })
})

describe('link candidate matching', () => {
  it('matches one fresh exact opener and destination', () => {
    const match = findMatchingCandidate(
      [candidate()],
      { openerTabId: 10, url: 'https://EXAMPLE.com:443/a', createdAt: 11_000 },
      11_000,
    )
    expect(match?.id).toBe('candidate-1')
  })

  it('does not match expired candidates', () => {
    expect(
      findMatchingCandidate(
        [candidate()],
        { openerTabId: 10, url: 'https://example.com/a' },
        40_001,
      ),
    ).toBeUndefined()
  })

  it('does not guess when exact candidates are ambiguous', () => {
    expect(
      findMatchingCandidate(
        [candidate(), candidate({ id: 'candidate-2', capturedAt: 10_100 })],
        { openerTabId: 10, url: 'https://example.com/a' },
        11_000,
      ),
    ).toBeUndefined()
  })

  it('uses only a unique very-recent same-opener fallback', () => {
    expect(
      findMatchingCandidate(
        [candidate()],
        { openerTabId: 10, url: 'https://redirected.example/', createdAt: 11_000 },
        11_000,
      )?.id,
    ).toBe('candidate-1')

    expect(
      findMatchingCandidate(
        [candidate(), candidate({ id: 'candidate-2', targetUrl: 'https://example.com/b' })],
        { openerTabId: 10, url: 'https://redirected.example/', createdAt: 11_000 },
        11_000,
      ),
    ).toBeUndefined()
  })

  it('removes a consumed candidate and prunes expired candidates', () => {
    const consumed = candidate()
    const recent = candidate({ id: 'recent', capturedAt: 39_000 })
    const expired = candidate({ id: 'expired', capturedAt: 9_999 })
    expect(withoutCandidate([consumed, recent, expired], consumed, 40_000)).toEqual([recent])
  })
})

describe('source opening and restart reconciliation', () => {
  it('focuses an exact live URL or opens a new eligible URL', () => {
    expect(decideOpenSource('https://example.com/a', bindings)).toEqual({
      type: 'focus',
      tabId: 11,
      windowId: 1,
    })
    expect(decideOpenSource('https://example.com/new', bindings)).toEqual({
      type: 'open',
      url: 'https://example.com/new',
    })
    expect(decideOpenSource('file:///tmp/private', bindings)).toEqual({ type: 'unsupported' })
  })

  it('reconciles only URL/title pairs unique on both sides', () => {
    const snapshots: LiveSnapshot[] = [
      {
        contextId: 'unique',
        lastTabId: 1,
        url: 'https://example.com/unique',
        title: 'Unique',
        updatedAt: 1,
      },
      {
        contextId: 'duplicate-a',
        lastTabId: 2,
        url: 'https://example.com/duplicate',
        title: 'Duplicate',
        updatedAt: 2,
      },
      {
        contextId: 'duplicate-b',
        lastTabId: 3,
        url: 'https://example.com/duplicate',
        title: 'Duplicate',
        updatedAt: 3,
      },
    ]

    expect(
      reconcileRestoredTabs(
        [
          { tabId: 100, url: 'https://example.com/unique', title: 'Unique' },
          { tabId: 101, url: 'https://example.com/duplicate', title: 'Duplicate' },
        ],
        snapshots,
      ),
    ).toEqual({
      matches: [{ tabId: 100, contextId: 'unique' }],
      unmatchedTabIds: [101],
    })
  })

  it('leaves duplicate restored tabs unmatched', () => {
    const snapshots: LiveSnapshot[] = [
      {
        contextId: 'same',
        lastTabId: 1,
        url: 'https://example.com/same',
        title: 'Same',
        updatedAt: 1,
      },
    ]
    expect(
      reconcileRestoredTabs(
        [
          { tabId: 20, url: 'https://example.com/same', title: 'Same' },
          { tabId: 21, url: 'https://example.com/same', title: 'Same' },
        ],
        snapshots,
      ),
    ).toEqual({ matches: [], unmatchedTabIds: [20, 21] })
  })
})
