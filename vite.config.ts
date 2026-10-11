import { defineConfig } from 'vite'

// Shared memory for worker threads needs a cross-origin-isolated page.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export default defineConfig({
  server: { headers: isolation },
  preview: { headers: isolation },
  worker: { format: 'es' },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
