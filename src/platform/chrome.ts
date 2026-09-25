// Chrome-specific access stays behind this module so core and UI code remain portable.
export const browserApi = chrome

export function isEligibleUrl(url: string | undefined): url is string {
  if (!url) return false

  try {
    const protocol = new URL(url).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

export function isEligibleTab(tab: chrome.tabs.Tab): tab is chrome.tabs.Tab & { id: number; url: string } {
  return !tab.incognito && typeof tab.id === 'number' && isEligibleUrl(tab.pendingUrl ?? tab.url)
}
