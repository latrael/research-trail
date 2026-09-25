import { browserApi } from '../platform/chrome'
import { formatResearchMarkdown } from '../research-export'
import type {
  AppViewModel,
  ContextNodeView,
  ResearchItem,
  RuntimeEvent,
  RuntimeRequest,
  RuntimeResponse,
} from '../shared/types'

type ViewName = 'context' | 'cart'
type EditTarget =
  | { kind: 'context'; id: string; draft: string }
  | { kind: 'research'; id: string; draft: string }
  | undefined

const appRoot = document.querySelector<HTMLDivElement>('#app')

if (!appRoot) throw new Error('Research Trail could not find its application root.')

const app: HTMLDivElement = appRoot

const state: {
  view: ViewName
  model?: AppViewModel
  activeTabId?: number
  activeWindowId?: number
  loading: boolean
  error?: string
  dismissedBackgroundError?: string
  editing: EditTarget
  deleteCandidateId?: string
  clearPending: boolean
  exportStatus?: string
} = {
  view: 'context',
  loading: true,
  editing: undefined,
  clearPending: false,
}

let exportStatusTimer: number | undefined

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function button(label: string, className = 'button button--quiet'): HTMLButtonElement {
  const node = element('button', className, label)
  node.type = 'button'
  return node
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.'
}

async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    return
  } catch {
    // Chrome extension pages normally support the async Clipboard API. Keep a
    // synchronous fallback for older or policy-restricted installations.
  }

  const textarea = element('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.append(textarea)
  textarea.focus()
  textarea.select()
  const copied = document.execCommand('copy')
  textarea.remove()
  if (!copied) throw new Error('Chrome could not copy the Markdown to your clipboard.')
}

async function sendRequest<T>(request: RuntimeRequest): Promise<T> {
  const response = (await browserApi.runtime.sendMessage(request)) as RuntimeResponse<T> | undefined

  if (!response) throw new Error('The Research Trail background service did not respond.')
  if (!response.ok) throw new Error(response.error.message)
  return response.data
}

async function findActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await browserApi.tabs.query({ active: true, currentWindow: true })
  return tab
}

async function refresh(options: { preserveContent?: boolean } = {}): Promise<void> {
  if (!options.preserveContent || !state.model) {
    state.loading = true
    render()
  }

  try {
    const tab = await findActiveTab()
    state.activeTabId = tab?.id
    state.activeWindowId = tab?.windowId

    if (typeof tab?.id !== 'number') {
      throw new Error('No active browser tab is available in this window.')
    }

    state.model = await sendRequest<AppViewModel>({ type: 'GET_VIEW_MODEL', tabId: tab.id })
    state.error = undefined
  } catch (error) {
    state.error = errorMessage(error)
  } finally {
    state.loading = false
    render()
  }
}

async function runMutation(request: RuntimeRequest): Promise<boolean> {
  state.error = undefined

  try {
    await sendRequest<unknown>(request)
    await refresh({ preserveContent: true })
    return true
  } catch (error) {
    state.error = errorMessage(error)
    render()
    return false
  }
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(timestamp)
}

function appendIconMark(target: HTMLElement): void {
  const mark = element('span', 'brand__mark')
  mark.setAttribute('aria-hidden', 'true')
  mark.append(element('i'), element('i'), element('i'))
  target.append(mark)
}

function renderHeader(container: HTMLElement): void {
  const header = element('header', 'header')
  const brand = element('div', 'brand')
  appendIconMark(brand)
  const wordmark = element('div')
  wordmark.append(element('p', 'brand__name', 'Research Trail'))
  wordmark.append(element('p', 'brand__tagline', 'Keep the why with the source'))
  brand.append(wordmark)
  header.append(brand)

  const navigation = element('nav', 'tabs')
  navigation.setAttribute('aria-label', 'Research Trail views')
  navigation.setAttribute('role', 'tablist')

  const contextTab = button('Tab context', 'tabs__button')
  contextTab.setAttribute('role', 'tab')
  contextTab.setAttribute('aria-selected', String(state.view === 'context'))
  contextTab.setAttribute('aria-controls', 'context-panel')
  if (state.view === 'context') contextTab.classList.add('is-active')
  contextTab.addEventListener('click', () => {
    state.view = 'context'
    state.deleteCandidateId = undefined
    render()
  })

  const cartTab = button('Research cart', 'tabs__button')
  cartTab.setAttribute('role', 'tab')
  cartTab.setAttribute('aria-selected', String(state.view === 'cart'))
  cartTab.setAttribute('aria-controls', 'cart-panel')
  if (state.view === 'cart') cartTab.classList.add('is-active')

  const count = state.model?.researchItems.length ?? 0
  const countBadge = element('span', 'tabs__count', String(count))
  countBadge.setAttribute('aria-label', `${count} saved ${count === 1 ? 'item' : 'items'}`)
  cartTab.append(countBadge)
  cartTab.addEventListener('click', () => {
    state.view = 'cart'
    state.clearPending = false
    render()
  })

  navigation.append(contextTab, cartTab)
  container.append(header, navigation)
}

function renderNotice(container: HTMLElement): void {
  const backgroundError = state.model?.lastError
  const message =
    state.error ??
    (backgroundError !== state.dismissedBackgroundError ? backgroundError : undefined)
  if (!message) return

  const notice = element('div', 'notice notice--error')
  notice.setAttribute('role', 'alert')
  notice.append(element('span', 'notice__icon', '!'), element('p', '', message))

  const dismiss = button('Dismiss', 'button button--text')
  dismiss.setAttribute('aria-label', 'Dismiss error')
  dismiss.addEventListener('click', () => {
    if (state.error) {
      state.error = undefined
    } else {
      state.dismissedBackgroundError = message
    }
    render()
  })
  notice.append(dismiss)
  container.append(notice)
}

function renderLoading(container: HTMLElement): void {
  const loading = element('main', 'loading-state')
  loading.append(element('div', 'loading-state__mark'))
  loading.append(element('p', '', 'Following this tab…'))
  container.append(loading)
}

function renderEmpty(
  container: HTMLElement,
  title: string,
  copy: string,
  className = '',
): void {
  const empty = element('section', `empty-state ${className}`.trim())
  const illustration = element('div', 'empty-state__illustration')
  illustration.setAttribute('aria-hidden', 'true')
  illustration.append(element('span'), element('span'), element('span'))
  empty.append(illustration, element('h2', '', title), element('p', '', copy))
  container.append(empty)
}

function renderNoteEditor(
  target: Exclude<EditTarget, undefined>,
  onSave: (draft: string) => Promise<void>,
): HTMLElement {
  const form = element('form', 'note-editor')
  const label = element('label', 'sr-only', 'Intent note')
  const textarea = element('textarea', 'note-editor__input')
  textarea.rows = 3
  textarea.value = target.draft
  textarea.placeholder = target.kind === 'context' ? 'Why is this tab useful?' : 'Why does this matter?'
  label.htmlFor = `note-${target.kind}-${target.id}`
  textarea.id = label.htmlFor
  textarea.addEventListener('input', () => {
    if (state.editing?.id === target.id && state.editing.kind === target.kind) {
      state.editing.draft = textarea.value
    }
  })
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      state.editing = undefined
      render()
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      form.requestSubmit()
    }
  })

  const actions = element('div', 'note-editor__actions')
  const cancel = button('Cancel')
  cancel.addEventListener('click', () => {
    state.editing = undefined
    render()
  })
  const save = button('Save note', 'button button--primary')
  save.type = 'submit'
  actions.append(cancel, save)
  form.append(label, textarea, actions)
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    save.disabled = true
    cancel.disabled = true
    textarea.disabled = true
    void onSave(textarea.value.trim())
  })
  return form
}

function contextStatus(context: ContextNodeView): HTMLElement {
  const status = element('span', `status ${context.isLive ? 'status--live' : 'status--closed'}`)
  const dot = element('span', 'status__dot')
  dot.setAttribute('aria-hidden', 'true')
  status.append(dot, document.createTextNode(context.isLive ? 'Open' : 'Closed'))
  return status
}

function contextCard(context: ContextNodeView): HTMLElement {
  const card = element('article', 'context-card')
  const top = element('div', 'context-card__top')
  const copy = element('div', 'context-card__copy')
  copy.append(element('h4', 'context-card__title', context.currentTitle || 'Untitled page'))
  copy.append(element('p', 'context-card__source', hostname(context.currentUrl)))
  top.append(copy, contextStatus(context))
  card.append(top)

  if (context.linkText) {
    const linkText = element('p', 'context-card__link')
    linkText.append(element('span', '', 'Opened from '), document.createTextNode(context.linkText))
    card.append(linkText)
  }

  if (context.intentNote) card.append(element('p', 'context-card__note', context.intentNote))

  const action = button(context.isLive ? 'Go to tab' : 'Reopen', 'button button--card')
  action.setAttribute('aria-label', `${context.isLive ? 'Go to' : 'Reopen'} ${context.currentTitle || 'untitled page'}`)
  action.addEventListener('click', () => {
    action.disabled = true
    void runMutation({ type: 'ACTIVATE_CONTEXT', contextId: context.id })
  })
  card.append(action)
  return card
}

function relationshipSection(
  title: string,
  contexts: ContextNodeView[],
  emptyCopy: string,
): HTMLElement {
  const section = element('section', 'relationship-section')
  const heading = element('div', 'section-heading')
  heading.append(element('h3', '', title))
  if (contexts.length > 0) heading.append(element('span', 'section-heading__count', String(contexts.length)))
  section.append(heading)

  if (contexts.length === 0) {
    section.append(element('p', 'relationship-section__empty', emptyCopy))
  } else {
    const list = element('div', 'context-list')
    contexts.forEach((context) => list.append(contextCard(context)))
    section.append(list)
  }

  return section
}

function renderCurrentContext(container: HTMLElement, context: ContextNodeView): void {
  const hero = element('section', 'current-context')
  const eyebrow = element('div', 'current-context__eyebrow')
  eyebrow.append(element('span', '', 'Current tab'), contextStatus(context))
  hero.append(eyebrow)
  hero.append(element('h1', '', context.currentTitle || 'Untitled page'))
  hero.append(element('p', 'current-context__source', hostname(context.currentUrl)))

  if (context.linkText || context.surroundingText) {
    const origin = element('div', 'origin')
    origin.append(element('p', 'origin__label', 'How you got here'))
    if (context.linkText) origin.append(element('p', 'origin__link', context.linkText))
    if (context.surroundingText) origin.append(element('blockquote', '', context.surroundingText))
    hero.append(origin)
  }

  const noteBlock = element('div', 'intent')
  const noteHeading = element('div', 'intent__heading')
  noteHeading.append(element('h2', '', 'Intent'))

  const editing = state.editing?.kind === 'context' && state.editing.id === context.id
  if (!editing) {
    const edit = button(context.intentNote ? 'Edit' : 'Add note', 'button button--text')
    edit.addEventListener('click', () => {
      state.editing = { kind: 'context', id: context.id, draft: context.intentNote ?? '' }
      render()
      document.querySelector<HTMLTextAreaElement>(`#note-context-${CSS.escape(context.id)}`)?.focus()
    })
    noteHeading.append(edit)
  }
  noteBlock.append(noteHeading)

  if (editing && state.editing) {
    noteBlock.append(
      renderNoteEditor(state.editing, async (draft) => {
        const saved = await runMutation({ type: 'UPDATE_TAB_NOTE', contextId: context.id, note: draft })
        if (saved) state.editing = undefined
        render()
      }),
    )
  } else {
    noteBlock.append(
      element('p', context.intentNote ? 'intent__note' : 'intent__placeholder', context.intentNote || 'Add a note about why this tab matters.'),
    )
  }

  hero.append(noteBlock)
  container.append(hero)
}

function renderClearHistory(container: HTMLElement): void {
  const footer = element('footer', 'context-footer')

  if (state.clearPending) {
    const confirmation = element('div', 'danger-confirm')
    confirmation.append(
      element('p', '', 'Clear every saved tab relationship? Your Research Cart will be kept.'),
    )
    const actions = element('div', 'danger-confirm__actions')
    const cancel = button('Cancel')
    cancel.addEventListener('click', () => {
      state.clearPending = false
      render()
    })
    const confirm = button('Clear history', 'button button--danger')
    confirm.addEventListener('click', () => {
      confirm.disabled = true
      cancel.disabled = true
      void runMutation({ type: 'CLEAR_TAB_HISTORY' }).then((cleared) => {
        if (cleared) state.clearPending = false
        render()
      })
    })
    actions.append(cancel, confirm)
    confirmation.append(actions)
    footer.append(confirmation)
  } else {
    const clear = button('Clear tab history', 'button button--text button--danger-text')
    clear.addEventListener('click', () => {
      state.clearPending = true
      render()
    })
    footer.append(clear)
  }

  container.append(footer)
}

function renderContext(container: HTMLElement): void {
  const panel = element('main', 'panel')
  panel.id = 'context-panel'
  panel.setAttribute('role', 'tabpanel')

  const context = state.model?.context
  if (!context?.current) {
    renderEmpty(
      panel,
      'No trail for this page',
      context?.unsupportedReason ??
        'Research Trail works on regular web pages. Switch to an HTTP or HTTPS tab to start a trail.',
      'empty-state--context',
    )
    container.append(panel)
    return
  }

  renderCurrentContext(panel, context.current)

  const relationships = element('div', 'relationships')
  relationships.append(
    relationshipSection('Parent', context.parent ? [context.parent] : [], 'This tab started a new trail.'),
    relationshipSection('Siblings', context.siblings, 'No sibling tabs yet.'),
    relationshipSection('Children', context.children, 'Links opened from this tab will appear here.'),
  )
  panel.append(relationships)
  renderClearHistory(panel)
  container.append(panel)
}

function renderResearchNote(item: ResearchItem): HTMLElement {
  const note = element('div', 'research-note')
  const editing = state.editing?.kind === 'research' && state.editing.id === item.id

  if (editing && state.editing) {
    note.append(
      renderNoteEditor(state.editing, async (draft) => {
        const saved = await runMutation({ type: 'UPDATE_RESEARCH_NOTE', itemId: item.id, note: draft })
        if (saved) state.editing = undefined
        render()
      }),
    )
    return note
  }

  const row = element('div', 'research-note__row')
  row.append(
    element('p', item.note ? 'research-note__text' : 'research-note__placeholder', item.note || 'No note yet.'),
  )
  const edit = button(item.note ? 'Edit note' : 'Add note', 'button button--text')
  edit.addEventListener('click', () => {
    state.editing = { kind: 'research', id: item.id, draft: item.note ?? '' }
    state.deleteCandidateId = undefined
    render()
    document.querySelector<HTMLTextAreaElement>(`#note-research-${CSS.escape(item.id)}`)?.focus()
  })
  row.append(edit)
  note.append(row)
  return note
}

function researchCard(item: ResearchItem): HTMLElement {
  const card = element('article', 'research-card')
  const quote = element('blockquote', 'research-card__quote', item.selectedText)
  card.append(quote)

  const source = element('div', 'research-card__source')
  const sourceCopy = element('div')
  sourceCopy.append(element('p', 'research-card__title', item.pageTitle || 'Untitled page'))
  sourceCopy.append(
    element('p', 'research-card__meta', `${hostname(item.url)} · ${formatTime(item.createdAt)}`),
  )
  source.append(sourceCopy)

  const open = button('Open source', 'button button--quiet button--small')
  open.addEventListener('click', () => {
    open.disabled = true
    void runMutation({ type: 'OPEN_RESEARCH_SOURCE', itemId: item.id })
  })
  source.append(open)
  card.append(source, renderResearchNote(item))

  const footer = element('div', 'research-card__footer')
  if (state.deleteCandidateId === item.id) {
    footer.append(element('span', 'research-card__confirm-copy', 'Delete this item?'))
    const cancel = button('Cancel')
    cancel.addEventListener('click', () => {
      state.deleteCandidateId = undefined
      render()
    })
    const confirm = button('Delete', 'button button--danger')
    confirm.addEventListener('click', () => {
      confirm.disabled = true
      cancel.disabled = true
      void runMutation({ type: 'DELETE_RESEARCH_ITEM', itemId: item.id }).then((deleted) => {
        if (deleted) state.deleteCandidateId = undefined
        render()
      })
    })
    footer.append(cancel, confirm)
  } else {
    const remove = button('Delete', 'button button--text button--danger-text')
    remove.addEventListener('click', () => {
      state.deleteCandidateId = item.id
      state.editing = undefined
      render()
    })
    footer.append(remove)
  }
  card.append(footer)
  return card
}

function renderCart(container: HTMLElement): void {
  const panel = element('main', 'panel panel--cart')
  panel.id = 'cart-panel'
  panel.setAttribute('role', 'tabpanel')

  const intro = element('div', 'cart-intro')
  intro.append(element('h1', '', 'Research Cart'))
  intro.append(
    element('p', '', 'Evidence you saved while browsing, kept with its original source.'),
  )
  panel.append(intro)

  const items = [...(state.model?.researchItems ?? [])].sort((left, right) => right.createdAt - left.createdAt)
  if (items.length === 0) {
    renderEmpty(
      panel,
      'Your cart is empty',
      'Select text on any web page, right-click, and choose “Add to Research Cart.”',
    )
  } else {
    const exportBar = element('section', 'export-bar')
    const exportCopy = element('div', 'export-bar__copy')
    exportCopy.append(element('h2', '', 'Use your evidence'))
    exportCopy.append(
      element(
        'p',
        '',
        `${items.length} human-selected ${items.length === 1 ? 'quote' : 'quotes'}, each paired with its source.`,
      ),
    )

    const exportButton = button('Export as Markdown', 'button button--primary export-bar__button')
    exportButton.addEventListener('click', () => {
      exportButton.disabled = true
      exportButton.textContent = 'Copying…'
      state.error = undefined

      void writeClipboard(formatResearchMarkdown(items))
        .then(() => {
          state.exportStatus = `${items.length} ${items.length === 1 ? 'item' : 'items'} copied with citations.`
          if (exportStatusTimer !== undefined) window.clearTimeout(exportStatusTimer)
          exportStatusTimer = window.setTimeout(() => {
            state.exportStatus = undefined
            render()
          }, 3_000)
          render()
        })
        .catch((error: unknown) => {
          state.error = errorMessage(error)
          render()
        })
    })
    exportBar.append(exportCopy, exportButton)

    if (state.exportStatus) {
      const status = element('p', 'export-status', state.exportStatus)
      status.setAttribute('role', 'status')
      status.setAttribute('aria-live', 'polite')
      exportBar.append(status)
    }

    panel.append(exportBar)
    const list = element('div', 'research-list')
    items.forEach((item) => list.append(researchCard(item)))
    panel.append(list)
  }

  container.append(panel)
}

function render(): void {
  app.replaceChildren()
  const shell = element('div', 'shell')
  renderHeader(shell)
  renderNotice(shell)

  if (state.loading && !state.model) {
    renderLoading(shell)
  } else if (state.view === 'context') {
    renderContext(shell)
  } else {
    renderCart(shell)
  }

  app.append(shell)
}

browserApi.runtime.onMessage.addListener((message: unknown) => {
  const event = message as Partial<RuntimeEvent>
  if (event.type === 'STATE_CHANGED') void refresh({ preserveContent: true })
})

browserApi.tabs.onActivated.addListener((activeInfo) => {
  if (state.activeWindowId === undefined || activeInfo.windowId === state.activeWindowId) {
    state.activeTabId = activeInfo.tabId
    void refresh({ preserveContent: true })
  }
})

browserApi.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (
    tabId === state.activeTabId &&
    (changeInfo.status === 'complete' || changeInfo.url !== undefined || changeInfo.title !== undefined)
  ) {
    void refresh({ preserveContent: true })
  }
})

render()
void refresh()
