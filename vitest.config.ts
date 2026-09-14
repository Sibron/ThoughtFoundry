import { defineConfig } from 'vitest/config'

// Unit tests over the pure logic — no Supabase, no network. jsdom is here
// because a few modules touch localStorage at import time (lib/supabase.ts
// reads stored credentials), not because these tests exercise the DOM.
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
  },
})
