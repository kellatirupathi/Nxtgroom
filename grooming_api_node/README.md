# FacultyTrack API

Production Node.js 24 and Express API for instructor attendance, Gemini vision
evaluation, and Amazon SES check-in/checkout notifications.

## Local development

Prerequisites: Node.js 24, npm 11, MongoDB, a Gemini API key, and (to test
email delivery) an Amazon SES identity.

```powershell
cd grooming_api_node
Copy-Item .env.example .env
npm ci
npm run dev
```

Fill in the local `.env` before starting. The template contains placeholders,
not production credentials. The API listens on `http://localhost:8000` by
default.

Useful checks:

```powershell
npm run db:preflight
npm run check
npm audit --omit=dev
```

`db:preflight` is read-only. Production startup verifies that the audit is
clean and all required indexes already exist. See the deployment guide for the
explicitly confirmed, one-off index command; it never changes application
documents.

Health endpoints:

- `GET /health/live` confirms that the process is running.
- `GET /health/ready` confirms MongoDB connectivity, worker-loop progress, and
  that no durable queue is approaching its 24-hour privacy deadline.
- `GET /health` is retained as the readiness-compatible health endpoint.

## Production

The included multi-stage Dockerfile installs production dependencies only,
runs as the unprivileged `node` user, uses `dumb-init` for signal handling, and
starts Node directly. Its Docker health check tests process liveness;
Northflank separately checks database readiness. The image does not bake
`.env`, tests, temporary uploads, or documentation into its layers.

Deploy the API as a continuously running container with at least one replica.
The in-process evaluation and email workers stop when the service scales to
zero. Photos waiting for analysis and notification jobs are stored in MongoDB;
no persistent filesystem volume is required.

See [DEPLOYMENT.md](./DEPLOYMENT.md) for the exact Northflank, Vercel, MongoDB,
Gemini, and Amazon SES settings and the complete production environment
contract.
