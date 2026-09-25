import { defineManifest } from '@crxjs/vite-plugin'
import pkg from './package.json' with { type: 'json' }

export default defineManifest({
  manifest_version: 3,
  name: 'Research Trail',
  description: 'Preserve why tabs were opened and collect sourced evidence while you research.',
  version: pkg.version,
  minimum_chrome_version: '114',
  permissions: ['tabs', 'storage', 'contextMenus', 'sidePanel'],
  action: {
    default_title: 'Open Research Trail',
  },
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  side_panel: {
    default_path: 'src/sidepanel/index.html',
  },
  content_scripts: [
    {
      matches: ['http://*/*', 'https://*/*'],
      js: ['src/content.ts'],
      run_at: 'document_idle',
    },
  ],
})
