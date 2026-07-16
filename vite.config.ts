import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// Served from a GitHub Pages project subpath: https://sibron.github.io/ThoughtFoundry/
// The hash router and all assets resolve correctly under this base.
const base = '/ThoughtFoundry/'

export default defineConfig({
  base,
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'ThoughtFoundry',
        short_name: 'ThoughtFoundry',
        description: 'Persoonlijk systeem voor het vangen, verbinden en uitwerken van ideeën',
        theme_color: '#C94A24',
        background_color: '#F9F8F6',
        display: 'standalone',
        start_url: base,
        scope: base,
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ],
        // Accept text/links shared from other apps → lands in capture.
        share_target: {
          action: base,
          method: 'GET',
          params: { title: 'title', text: 'text', url: 'url' }
        },
        // Long-press / right-click app-icon shortcuts.
        shortcuts: [
          { name: 'Nieuwe notitie', short_name: 'Nieuw', url: base + '#/capture' },
          { name: 'Zoeken', short_name: 'Zoek', url: base + '#/inbox?view=search' }
        ]
      },
      workbox: {
        navigateFallback: base + 'index.html',
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/.*\.supabase\.co\//,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'supabase-api',
              networkTimeoutSeconds: 10
            }
          },
          // Brand fonts load from Google Fonts at runtime (see style.css) —
          // cache them so offline launches keep the typography.
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\//,
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'google-fonts-css' }
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-webfonts',
              expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] }
            }
          }
        ]
      }
    })
  ]
})
