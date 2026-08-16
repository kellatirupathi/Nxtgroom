import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from "@tailwindcss/vite"

function validateProductionApiBase(value) {
  if (!value) throw new Error('VITE_API_BASE is required for a production build.');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('VITE_API_BASE must be a valid absolute URL.');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('VITE_API_BASE must use HTTPS for a production build.');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('VITE_API_BASE cannot contain credentials, a query, or a fragment.');
  }
  if (parsed.pathname !== '/') {
    throw new Error('VITE_API_BASE must be an origin without a path.');
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  if (mode === 'production') validateProductionApiBase(env.VITE_API_BASE);

  return {
    plugins: [react(), tailwindcss()],
  };
})
