# FacultyTrack — NxtWave Grooming Audit

FacultyTrack records instructor attendance, evaluates check-in photos against
the included grooming references, and emails concise check-in and checkout
reports through Amazon SES.

## Applications

- `grooming-frontend/`: React 19 and Vite web application, deployed to Vercel.
- `grooming_api_node/`: Node.js 24 and Express API, deployed to Northflank.

The retired Python API has been removed; Python is not required to run or
deploy this application.

## Local commands

Backend terminal:

```powershell
cd grooming_api_node
Copy-Item .env.example .env
npm ci
npm run dev
```

Frontend terminal:

```powershell
cd grooming-frontend
Copy-Item .env.example .env
npm ci
npm run dev
```

Configure both `.env` files before starting. Never commit them.

## Access roles

- `superadmin`: manages colleges, BOA accounts, and all instructors and data.
- `boa`: manages and records attendance only for instructors in the BOA's
  assigned college.

Instructor roles (`Trainee`, `Senior Instructor`, and `Lead Instructor`) are
profile classifications, not application login roles.

## Deployment

Follow [the production deployment guide](./grooming_api_node/DEPLOYMENT.md).
It contains the exact Vercel and Northflank configuration, environment
variables, health checks, and pre-launch security checklist.
