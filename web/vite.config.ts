import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the API runs on :3000 (server/: `npm run dev`); proxying keeps the session cookie and the SSE
// stream same-origin, as they are in production, where the server serves this build.
export default defineConfig({
  plugins: [react()],
  // Two pages: the landing page at /, and the app at /demo/.
  build: { rollupOptions: { input: { main: 'index.html', demo: 'demo/index.html' } } },
  server: { proxy: { '/api': { target: 'http://127.0.0.1:3000', changeOrigin: false } } },
});
