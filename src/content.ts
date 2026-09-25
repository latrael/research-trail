import { clipExcerpt, isEligibleUrl, normalizeText } from './core'
import { browserApi } from './platform/chrome'
import type { CapturedLink, RuntimeRequest } from './shared/types'

const READABLE_BLOCK_SELECTOR =
  'p, li, blockquote, article, section, dd, dt, figcaption, td, th, main'

function anchorFromEvent(event: MouseEvent): HTMLAnchorElement | undefined {
  for (const target of event.composedPath()) {
    if (target instanceof HTMLAnchorElement) return target
    if (target instanceof Element) {
      const anchor = target.closest('a[href]')
      if (anchor instanceof HTMLAnchorElement) return anchor
    }
  }
  return undefined
}

export function extractSurroundingText(anchor: HTMLAnchorElement): string {
  const readableBlock = anchor.closest(READABLE_BLOCK_SELECTOR)
  const fallback = anchor.parentElement
  const source = readableBlock?.textContent ?? fallback?.textContent ?? anchor.textContent
  return clipExcerpt(source, anchor.textContent ?? undefined)
}

export function captureLink(anchor: HTMLAnchorElement, capturedAt = Date.now()): CapturedLink | undefined {
  const targetUrl = anchor.href
  if (!isEligibleUrl(targetUrl)) return undefined

  return {
    targetUrl,
    linkText: normalizeText(anchor.textContent) || normalizeText(anchor.getAttribute('aria-label')),
    surroundingText: extractSurroundingText(anchor),
    capturedAt,
  }
}

function recordFromEvent(event: MouseEvent): void {
  const anchor = anchorFromEvent(event)
  if (!anchor) return
  const candidate = captureLink(anchor)
  if (!candidate) return

  const request: RuntimeRequest = { type: 'RECORD_LINK_CANDIDATE', candidate }
  // A suspended or reloading worker may reject the message. Link capture is
  // best-effort and must never affect the host page's interaction.
  void browserApi.runtime.sendMessage(request).catch(() => undefined)
}

document.addEventListener('contextmenu', recordFromEvent, true)
document.addEventListener(
  'click',
  (event) => {
    const anchor = anchorFromEvent(event)
    if (!anchor) return
    if (event.metaKey || event.ctrlKey || event.shiftKey || anchor.target.toLowerCase() === '_blank') {
      recordFromEvent(event)
    }
  },
  true,
)
document.addEventListener(
  'auxclick',
  (event) => {
    if (event.button === 1) recordFromEvent(event)
  },
  true,
)
