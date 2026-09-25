import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinkCandidate, ResearchItem, TabContext } from '../shared/types'

type FakeArea = {
  data: Record<string, unknown>
  failNextSet: boolean
  reset(): void
  get(keys: string | string[] | null): Promise<Record<string, unknown>>
  set(values: Record<string, unknown>): Promise<void>
  remove(keys: string | string[]): Promise<void>
  setAccessLevel(): Promise<void>
}

const stores = vi.hoisted(() => {
  const makeArea = (): FakeArea => ({
    data: {},
    failNextSet: false,
    reset() {
      this.data = {}
      this.failNextSet = false
    },
    async get(keys) {
      if (keys === null) return { ...this.data }
      const requested = Array.isArray(keys) ? keys : [keys]
      return Object.fromEntries(
        requested.filter((key) => key in this.data).map((key) => [key, this.data[key]]),
      )
    },
    async set(values) {
      if (this.failNextSet) {
        this.failNextSet = false
        throw new Error('quota exceeded')
      }
      Object.assign(this.data, values)
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete this.data[key]
    },
    async setAccessLevel() {},
  })

  return { local: makeArea(), session: makeArea() }
})

vi.mock('../platform/chrome', () => ({
  browserApi: {
    storage: {
      local: stores.local,
      session: stores.session,
    },
  },
}))

import { StorageRepository } from './storage'

function context(overrides: Partial<TabContext> = {}): TabContext {
  return {
    id: 'context-1',
    currentUrl: 'https://example.com/current',
    currentTitle: 'Current',
    openedUrl: 'https://example.com/opened',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function researchItem(overrides: Partial<ResearchItem> = {}): ResearchItem {
  return {
    id: 'research-1',
    selectedText: 'Useful evidence',
    url: 'https://example.com/source',
    pageTitle: 'Source',
    tabContextId: 'context-1',
    createdAt: 2,
    updatedAt: 2,
    ...overrides,
  }
}

describe('StorageRepository', () => {
  beforeEach(() => {
    stores.local.reset()
    stores.session.reset()
  })

  it('round-trips durable records and clears contexts without deleting evidence', async () => {
    const repository = new StorageRepository()
    await repository.initialize()
    await repository.putContext(context())
    await repository.putResearchItem(researchItem())

    expect(await repository.listContexts()).toEqual([context()])
    expect(await repository.listResearchItems()).toEqual([researchItem()])

    await repository.deleteAllContexts()
    await repository.detachResearchItemsFromContexts()

    expect(await repository.listContexts()).toEqual([])
    const [preservedItem] = await repository.listResearchItems()
    expect(preservedItem).toEqual(
      expect.objectContaining({ id: 'research-1', selectedText: 'Useful evidence' }),
    )
    expect(preservedItem).not.toHaveProperty('tabContextId')
  })

  it('replaces transient link candidates without touching durable storage', async () => {
    const repository = new StorageRepository()
    const first: LinkCandidate = {
      id: 'candidate-1',
      sourceTabId: 1,
      targetUrl: 'https://example.com/one',
      linkText: 'One',
      surroundingText: 'Open one',
      capturedAt: 1,
    }
    const second: LinkCandidate = { ...first, id: 'candidate-2', targetUrl: 'https://example.com/two' }

    await repository.replaceCandidates([first])
    expect(await repository.listCandidates()).toEqual([first])
    await repository.replaceCandidates([second])
    expect(await repository.listCandidates()).toEqual([second])
    expect(await repository.listContexts()).toEqual([])
  })

  it('does not corrupt the previous record when a write fails', async () => {
    const repository = new StorageRepository()
    await repository.putContext(context())
    stores.local.failNextSet = true

    await expect(
      repository.putContext(context({ currentTitle: 'Should not be stored' })),
    ).rejects.toThrow('quota exceeded')
    expect(await repository.getContext('context-1')).toEqual(context())
  })
})
