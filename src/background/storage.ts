import { browserApi } from '../platform/chrome'
import {
  SCHEMA_VERSION,
  type LinkCandidate,
  type LiveSnapshot,
  type LiveTabBinding,
  type ProvisionalTab,
  type ResearchItem,
  type TabContext,
} from '../shared/types'

const PREFIX = 'research-trail:'
const SCHEMA_KEY = `${PREFIX}schema-version`
const CONTEXT_PREFIX = `${PREFIX}context:`
const RESEARCH_PREFIX = `${PREFIX}research:`
const SNAPSHOT_PREFIX = `${PREFIX}snapshot:`
const BINDING_PREFIX = `${PREFIX}binding:`
const PROVISIONAL_PREFIX = `${PREFIX}provisional:`
const CANDIDATE_PREFIX = `${PREFIX}candidate:`

type StorageRecord = Record<string, unknown>

function contextKey(id: string): string {
  return `${CONTEXT_PREFIX}${id}`
}

function researchKey(id: string): string {
  return `${RESEARCH_PREFIX}${id}`
}

function snapshotKey(contextId: string): string {
  return `${SNAPSHOT_PREFIX}${contextId}`
}

function bindingKey(tabId: number): string {
  return `${BINDING_PREFIX}${tabId}`
}

function provisionalKey(tabId: number): string {
  return `${PROVISIONAL_PREFIX}${tabId}`
}

function candidateKey(id: string): string {
  return `${CANDIDATE_PREFIX}${id}`
}

async function all(area: chrome.storage.StorageArea): Promise<StorageRecord> {
  return area.get(null) as Promise<StorageRecord>
}

async function valuesWithPrefix<T>(
  area: chrome.storage.StorageArea,
  prefix: string,
): Promise<T[]> {
  const records = await all(area)
  return Object.entries(records)
    .filter(([key]) => key.startsWith(prefix))
    .map(([, value]) => value as T)
}

async function removeWithPrefixes(
  area: chrome.storage.StorageArea,
  prefixes: string[],
): Promise<void> {
  const records = await all(area)
  const keys = Object.keys(records).filter((key) =>
    prefixes.some((prefix) => key.startsWith(prefix)),
  )
  if (keys.length > 0) await area.remove(keys)
}

/**
 * Small persistence boundary for the background worker. Durable entities use
 * one key per record so unrelated edits do not rewrite a monolithic object.
 */
export class StorageRepository {
  async initialize(): Promise<void> {
    await browserApi.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
    await browserApi.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })

    const stored = await browserApi.storage.local.get(SCHEMA_KEY)
    if (stored[SCHEMA_KEY] !== SCHEMA_VERSION) {
      await browserApi.storage.local.set({ [SCHEMA_KEY]: SCHEMA_VERSION })
    }
  }

  async listContexts(): Promise<TabContext[]> {
    return valuesWithPrefix<TabContext>(browserApi.storage.local, CONTEXT_PREFIX)
  }

  async getContext(id: string): Promise<TabContext | undefined> {
    const key = contextKey(id)
    const record = await browserApi.storage.local.get(key)
    return record[key] as TabContext | undefined
  }

  async putContext(context: TabContext): Promise<void> {
    await browserApi.storage.local.set({ [contextKey(context.id)]: context })
  }

  async deleteAllContexts(): Promise<void> {
    await removeWithPrefixes(browserApi.storage.local, [CONTEXT_PREFIX, SNAPSHOT_PREFIX])
  }

  async listResearchItems(): Promise<ResearchItem[]> {
    return valuesWithPrefix<ResearchItem>(browserApi.storage.local, RESEARCH_PREFIX)
  }

  async getResearchItem(id: string): Promise<ResearchItem | undefined> {
    const key = researchKey(id)
    const record = await browserApi.storage.local.get(key)
    return record[key] as ResearchItem | undefined
  }

  async putResearchItem(item: ResearchItem): Promise<void> {
    await browserApi.storage.local.set({ [researchKey(item.id)]: item })
  }

  async deleteResearchItem(id: string): Promise<void> {
    await browserApi.storage.local.remove(researchKey(id))
  }

  async detachResearchItemsFromContexts(): Promise<void> {
    const items = await this.listResearchItems()
    const updates: StorageRecord = {}

    for (const item of items) {
      if (!item.tabContextId) continue
      const { tabContextId: _removed, ...detached } = item
      updates[researchKey(item.id)] = { ...detached, updatedAt: Date.now() }
    }

    if (Object.keys(updates).length > 0) {
      await browserApi.storage.local.set(updates)
    }
  }

  async listSnapshots(): Promise<LiveSnapshot[]> {
    return valuesWithPrefix<LiveSnapshot>(browserApi.storage.local, SNAPSHOT_PREFIX)
  }

  async putSnapshot(snapshot: LiveSnapshot): Promise<void> {
    await browserApi.storage.local.set({ [snapshotKey(snapshot.contextId)]: snapshot })
  }

  async deleteSnapshot(contextId: string): Promise<void> {
    await browserApi.storage.local.remove(snapshotKey(contextId))
  }

  async listBindings(): Promise<LiveTabBinding[]> {
    return valuesWithPrefix<LiveTabBinding>(browserApi.storage.session, BINDING_PREFIX)
  }

  async getBinding(tabId: number): Promise<LiveTabBinding | undefined> {
    const key = bindingKey(tabId)
    const record = await browserApi.storage.session.get(key)
    return record[key] as LiveTabBinding | undefined
  }

  async putBinding(binding: LiveTabBinding): Promise<void> {
    await browserApi.storage.session.set({ [bindingKey(binding.tabId)]: binding })
  }

  async deleteBinding(tabId: number): Promise<void> {
    await browserApi.storage.session.remove(bindingKey(tabId))
  }

  async clearBindings(): Promise<void> {
    await removeWithPrefixes(browserApi.storage.session, [BINDING_PREFIX])
  }

  async listProvisionals(): Promise<ProvisionalTab[]> {
    return valuesWithPrefix<ProvisionalTab>(browserApi.storage.session, PROVISIONAL_PREFIX)
  }

  async getProvisional(tabId: number): Promise<ProvisionalTab | undefined> {
    const key = provisionalKey(tabId)
    const record = await browserApi.storage.session.get(key)
    return record[key] as ProvisionalTab | undefined
  }

  async putProvisional(provisional: ProvisionalTab): Promise<void> {
    await browserApi.storage.session.set({
      [provisionalKey(provisional.tabId)]: provisional,
    })
  }

  async deleteProvisional(tabId: number): Promise<void> {
    await browserApi.storage.session.remove(provisionalKey(tabId))
  }

  async clearProvisionals(): Promise<void> {
    await removeWithPrefixes(browserApi.storage.session, [PROVISIONAL_PREFIX])
  }

  async listCandidates(): Promise<LinkCandidate[]> {
    return valuesWithPrefix<LinkCandidate>(browserApi.storage.session, CANDIDATE_PREFIX)
  }

  async putCandidate(candidate: LinkCandidate): Promise<void> {
    await browserApi.storage.session.set({ [candidateKey(candidate.id)]: candidate })
  }

  async deleteCandidate(id: string): Promise<void> {
    await browserApi.storage.session.remove(candidateKey(id))
  }

  async replaceCandidates(candidates: LinkCandidate[]): Promise<void> {
    await removeWithPrefixes(browserApi.storage.session, [CANDIDATE_PREFIX])
    if (candidates.length === 0) return

    const updates: StorageRecord = {}
    for (const candidate of candidates) {
      updates[candidateKey(candidate.id)] = candidate
    }
    await browserApi.storage.session.set(updates)
  }

  async clearTransientState(): Promise<void> {
    await removeWithPrefixes(browserApi.storage.session, [
      BINDING_PREFIX,
      PROVISIONAL_PREFIX,
      CANDIDATE_PREFIX,
    ])
  }
}

export const storageRepository = new StorageRepository()
