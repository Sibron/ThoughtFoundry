import { defineConfig } from 'vitest/config'

// Unit tests over the pure logic — no Supabase, no network, no DOM.
// `node` rather than a browser environment on purpose: nothing here renders.
// The setup file supplies the one browser API the modules under test touch at
// import time (localStorage) — see tests/setup.ts for why that beats jsdom.
export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
  },
})
