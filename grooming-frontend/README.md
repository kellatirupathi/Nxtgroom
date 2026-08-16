# FacultyTrack frontend

React/Vite frontend for the instructor attendance and grooming audit application.

## Local setup

1. Copy `.env.example` to `.env`.
2. Run `npm ci`.
3. Run `npm run dev`.

For local development, set `VITE_API_BASE=http://localhost:8000`. Production
builds intentionally fail when this value is missing or does not use HTTPS.

## Vercel project settings

- Root directory: `grooming-frontend`
- Framework preset: Vite
- Node.js version: 24.x
- Install command: `npm ci`
- Build command: `npm run build`
- Output directory: `dist`
- Environment variable: `VITE_API_BASE=https://<your-northflank-origin>`

Include the final Vercel origin exactly in the backend `CORS_ORIGINS` setting.
The checked-in `vercel.json` applies browser security headers and the application
blocks search indexing because it is an authenticated operational system.

## Verification

```powershell
npm run lint
npm test
$env:VITE_API_BASE='https://api.example.com'; npm run build
npm audit --omit=dev
```
