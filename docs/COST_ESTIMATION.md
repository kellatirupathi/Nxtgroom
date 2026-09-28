# FacultyTrack — Monthly Cost Estimation

**Setup:** AWS Lightsail $12 plan (backend) + MongoDB Atlas Flex (database) + Vercel Pro (frontend)
**Load:** 1,000 instructors across ~50 campuses, 1 check-in + 1 check-out per day
**Prices checked:** 28 September 2026 · **Exchange rate used:** ₹96 = $1

> Numbers marked *(est.)* could not be confirmed on an official pricing page, or
> depend on usage that should be measured in production (the API exposes live
> token and job counters at `/health/metrics`).

---

## 1. Summary

| Service | What it does | Monthly cost (USD) | Monthly cost (INR) |
|---|---|---|---|
| AWS Lightsail ($12 plan + snapshots) | Runs the backend API and workers | $13 | ₹1,250 |
| MongoDB Atlas Flex | Database | $8 – $15 | ₹770 – ₹1,440 |
| Vercel Pro | Hosts the frontend website | $20 | ₹1,920 |
| **Google Gemini 2.5 Flash-Lite** | AI grooming check on every photo | **$59 – $172** | ₹5,660 – ₹16,500 |
| **AWS Rekognition** | Face identification on every photo | **$52 – $65** | ₹5,000 – ₹6,240 |
| AWS SES | Report emails | $12 – $32 | ₹1,150 – ₹3,070 |
| Cloudflare R2 | Photo storage (kept 2 months) | $1 – $2 | ₹100 – ₹190 |
| cron-job.org, BigQuery, SSL | Scheduled jobs, instructor sync, HTTPS | $0 | ₹0 |
| **Total** | | **$165 – $319** | **₹15,800 – ₹30,600** |
| **Most likely** | | **≈ $210** | **≈ ₹20,000** |

**Where the money goes:** Gemini and Rekognition are about **70–75%** of the
bill. The server itself is about **6%**.

---

## 2. Usage assumptions

| Item | Value | How it is derived |
|---|---|---|
| Instructors | 1,000 | Given |
| Working days per month | 26 | Monday–Saturday |
| Photo events per instructor per day | 2 | 1 check-in photo + 1 check-out photo |
| **Photo events per month** | **52,000** | 1,000 × 2 × 26 |
| Male / female split | 50 / 50 | Assumed; adjust with real roster |
| Peak window | 70% of instructors within 30 minutes | Morning check-in and evening check-out rushes |
| Peak arrivals | ~700 people in 30 min ≈ 23/min, bursts up to ~2.5/sec | 700 ÷ 30; 50 tablets × 1 person per 20 s |
| Photo size after browser resize | 0.5 – 1.2 MB (2048 px JPEG) | `grooming-frontend/src/lib/imageCapture.ts` |
| Photo retention in R2 | 2 months | `grooming_api_node/src/routes/reportRoutes.js` (`PHOTO_RETENTION_MONTHS`) |

---

## 3. Why the $12 Lightsail plan

### 3.1 The plan

| Price | RAM | vCPU | CPU baseline | SSD | Data transfer (Mumbai) |
|---|---|---|---|---|---|
| $12/month | 2 GB | 2 | 20% per vCPU | 60 GB | 1.5 TB (Mumbai gets half the listed 3 TB) |

Source: https://aws.amazon.com/lightsail/pricing/ and
https://docs.aws.amazon.com/lightsail/latest/userguide/baseline-cpu-performance.html

### 3.2 RAM — the deciding factor

The heaviest work the server does is resizing photos in memory (the `sharp`
library). The app allows at most **10 photos to be processed at the same time**
(`CHECKIN_CONCURRENCY_LIMIT=10`) specifically to protect memory.

**Measured** using the app's own `normalizeInstructorImage` function:

| Test | Memory (RSS) |
|---|---|
| Node.js + all app libraries loaded | 133 MB |
| 1 photo (2048 px) being processed | 242 MB peak |
| **10 photos processed at once** | **548 MB peak** |

**Server memory at the busiest minute:**

| Component | Peak RAM |
|---|---|
| Ubuntu (operating system) | ~250 MB |
| Docker engine | ~80 MB |
| Nginx (HTTPS) | ~20 MB |
| Node app incl. 10 photos at once (measured) | ~550 MB |
| Extra app overhead: 2 group photos, workers, DB connections | ~100 – 150 MB |
| **Total** | **~1.0 – 1.05 GB** |

| Plan | RAM | Peak need ~1.05 GB | Verdict |
|---|---|---|---|
| $7 | 1 GB | Over the limit → app is killed and restarted mid check-in | ❌ |
| **$12** | **2 GB** | **~0.95 GB spare (≈ 48% headroom)** | ✅ |
| $24 | 4 GB | ~3 GB spare | Not needed yet (needed at ~2,000 instructors) |

### 3.3 CPU — comfortably within burst limits

Lightsail plans are *burstable*: below the baseline the server saves credits,
above it the server spends them.

**CPU cost of one tablet visit** (measured on an Apple M4, scaled ×3–4 for a
Lightsail vCPU):

| Work | M4 (measured) | Lightsail (est.) |
|---|---|---|
| Resize one 2048 px photo | 47 ms | 150 – 200 ms |
| Upload handling, HTTPS, JSON, DB calls | — | 50 – 80 ms |
| **Total per visit** | | **0.2 – 0.3 CPU-seconds** |

The Gemini and email workers mostly wait on the network (~20–50 ms of CPU per
job), so they barely use the CPU.

**Rush-hour maths:**

```
Peak rate          = 2.5 visits/sec
CPU needed         = 2.5 × 0.25 s          = 0.63 vCPU
Instance capacity  = 2 vCPU
CPU utilisation    = 0.63 ÷ 2              ≈ 31%   (baseline is 20%)

Credits spent per rush  = (0.63 − 0.40 baseline) vCPU × 0.5 h ≈ 0.12 vCPU-hours
Two rushes per day      ≈ 0.25 vCPU-hours

Credits earned in quiet hours (≈3% use, 20 h/day):
                        = (0.40 − 0.06) vCPU × 20 h          ≈ 6.8 vCPU-hours
```

The server earns roughly **25× more credit than it spends**, so the CPU never
throttles at this load.

### 3.4 SSD — mostly empty

No photos (they go to R2) and no data (it is in Atlas) are stored on the server.

| Item | Size |
|---|---|
| Ubuntu | 3 – 4 GB |
| Docker engine | ~0.5 GB |
| App image (Node 24 Alpine + 87 MB of libraries) | ~0.3 GB |
| 2–3 old versions kept for rollback | 0.5 – 1 GB |
| Swap file (emergency memory) | 2 GB |
| Logs (rotated, capped) | ≤ 1 GB |
| **Total** | **~8 – 12 GB of 60 GB** |

### 3.5 Data transfer — well inside the allowance

| Flow | Maths | Per month |
|---|---|---|
| Photos uploaded by tablets (in) | 52,000 × 0.8 MB | ~42 GB |
| Photos saved to R2 (out) | 52,000 × 0.8 MB | ~42 GB |
| Photos read back from R2 for Gemini (in) | 52,000 × 0.8 MB | ~42 GB |
| Photos sent to Gemini (out, base64 ≈ +37%) | 78,000 calls × 1.1 MB | ~86 GB |
| Photos sent to Rekognition (out) | 52,000 × 0.8 MB | ~42 GB |
| API responses to browsers | | ~5 GB |
| **Total** | | **~260 GB of 1,500 GB (≈ 17%)** |

### 3.6 Capacity of the $12 plan

```
Max tablet visits/sec = 10 photo slots ÷ 2.5 s per visit = 4 visits/sec (240/min)
Needed at peak        = 2.5 visits/sec (burst), 23/min (average)
```

| Instructors | Tablets | Photos in progress at peak (limit 10) | $12 plan |
|---|---|---|---|
| **1,000** | 50 | ~6 | ✅ Comfortable |
| 1,500 | 75 | ~9 | ✅ Near the limit |
| 2,000 | 100 | ~12 | ⚠️ Move to $24 (4 GB) and raise limits |

### 3.7 Lightsail cost

| Item | Maths | Cost |
|---|---|---|
| Instance | Fixed | $12.00 |
| Static IP | Free while attached | $0.00 |
| Snapshots (backups) | ~10–20 GB × $0.05/GB-month | ~$0.50 – $1.00 |
| Data transfer overage | 260 GB used of 1.5 TB included | $0.00 |
| **Total** | | **≈ $13/month** |

---

## 4. Why a paid MongoDB plan (Atlas Flex)

### 4.1 Storage growth

The database stores attendance and AI reports **forever** (only the job queues
expire automatically).

| Data per instructor per day | Size |
|---|---|
| 2 AI evaluation reports (check-in + check-out, ~5 KB each) | ~10 KB |
| 1 attendance record | ~2 KB |
| Indexes + short-lived job/email queue records | ~2 – 3 KB |
| **Total** | **~12 – 15 KB** |

```
Per day   = 1,000 instructors × 12–15 KB   = 12 – 15 MB
Per month = 12–15 MB × 26 working days     = 312 – 390 MB
```

| Plan | Storage limit | Time until full |
|---|---|---|
| **M0 (free)** | 512 MB | 512 ÷ 12–15 MB/day = **34 – 43 working days ≈ 5 – 7 weeks** |
| **Flex** | 5 GB | 5,120 ÷ 312–390 MB/month = **13 – 16 months** |

When M0 is full, Atlas stops accepting writes, and **every check-in on every
campus fails** until the database is upgraded.

### 4.2 Operations per second at peak

| Source | Maths | Ops/sec |
|---|---|---|
| Tablet visits | 2.5 visits/sec × 15–25 DB operations each | 38 – 63 |
| Evaluation worker (busy) | ~20 jobs/min × 10–15 ops + polling | ~5 – 8 |
| Notification + mail + cleanup workers | Polling every 2 s + sending | ~5 – 8 |
| Admin/BOA dashboards, health checks | | ~5 – 10 |
| **Total at peak** | | **~55 – 90 ops/sec** |

M0 caps at **100 ops/sec**, so peak load runs at 55–90% of the cap and would
reach it as campuses grow. Atlas slows requests down when the cap is hit, so
tablets would take 5–10 s instead of 2–3 s.

### 4.3 Backups

| | M0 (free) | Flex |
|---|---|---|
| Automatic backup | ❌ None | ✅ Daily snapshot included |
| Recovery after an accidental delete | Impossible | Restore from the latest snapshot |

Attendance history is a record the organisation may need for HR or audits, so
running it with no backup is not acceptable.

### 4.4 Plan comparison

| | M0 (free) | **Flex (recommended)** | M10 (dedicated) |
|---|---|---|---|
| Price | $0 | **$8 base, up to a $30 cap** | ~$57+ (US list price; Mumbai slightly higher *(est.)*) |
| Storage | 512 MB | **5 GB** | 10 GB+ |
| Throughput | 100 ops/sec | **Up to 500 ops/sec** | Dedicated resources |
| Backup | None | **Daily** | Continuous (extra cost) |
| Lasts at 1,000 instructors | 5 – 7 weeks | **13 – 16 months** | Years |
| Code change needed to move | — | **None** | None |

Flex bills by the throughput actually used. Our ~55–90 ops/sec peak sits in the
lowest tiers, so the expected cost is **$8 – $15/month**.

Source: https://www.mongodb.com/pricing and
https://www.mongodb.com/docs/atlas/reference/flex-limitations/

---

## 5. Gemini (AI grooming check)

### 5.1 Pricing — Gemini 2.5 Flash-Lite, paid tier

| Item | Price |
|---|---|
| Input (text / image) | $0.10 per 1M tokens |
| Cached input | $0.01 per 1M tokens |
| Output (includes "thinking" tokens) | $0.40 per 1M tokens |
| Cache storage | $1.00 per 1M tokens per hour |

Source: https://ai.google.dev/gemini-api/docs/pricing

### 5.2 Calls per month

Both check-in **and** check-out photos are evaluated. Women need two calls
(first classify the attire type, then evaluate against the right rules); men
need one (`grooming_api_node/src/services/visionEngine.js`).

| | Maths | Calls/month |
|---|---|---|
| Evaluation calls | 52,000 events × 1 | 52,000 |
| Attire-classification calls (women only) | 26,000 events × 1 | 26,000 |
| **Total** | | **78,000** |

### 5.3 Tokens per call

| Part | Evaluation call | Classification call | Source |
|---|---|---|---|
| Prompt (rules), cached | ~5,500 tokens | ~3,200 tokens | `src/prompts.js`: 18.8k–23.9k characters ÷ 4 |
| Photo (2048 px, high resolution) | 1,300 – 2,300 tokens *(est.)* | 1,300 – 2,300 tokens *(est.)* | `mediaResolution: HIGH` |
| Output incl. thinking | 1,500 – 5,500 tokens *(est.)* | 300 – 1,100 tokens *(est.)* | Thinking budget 4,096 / 1,024 |

### 5.4 Cost maths

**One evaluation call:**
```
Prompt (cached)   5,500 × $0.01/1M        = $0.000055
Photo             1,300–2,300 × $0.10/1M   = $0.00013 – $0.00023
Output            1,500–5,500 × $0.40/1M   = $0.00060 – $0.00220
Total per call                             = $0.00079 – $0.00249
× 52,000 calls                             = $41 – $129
```

**One classification call:**
```
Prompt (cached)   3,200 × $0.01/1M         = $0.000032
Photo             1,300–2,300 × $0.10/1M   = $0.00013 – $0.00023
Output            300–1,100 × $0.40/1M     = $0.00012 – $0.00044
Total per call                             = $0.00028 – $0.00070
× 26,000 calls                             = $7 – $18
```

**Cache storage** (5 cached prompts ≈ 25,000 tokens, kept for 1 hour after use):
```
Per hour      = 0.025M tokens × $1.00      = $0.025
Active hours  = 360 – 720 per month
Total         = $9 – $18
```

| Gemini item | Monthly |
|---|---|
| Evaluation calls | $41 – $129 |
| Classification calls | $7 – $18 |
| Retries (~5%) | $2 – $7 |
| Cache storage | $9 – $18 |
| **Total Gemini** | **$59 – $172** |

About **75% of the Gemini cost is output ("thinking") tokens**, which is where
savings are possible (see Section 9).

---

## 6. AWS Rekognition (face identification)

### 6.1 Pricing

| Item | Price |
|---|---|
| Image API calls (`SearchFacesByImage`, `DetectFaces`, `IndexFaces`), first 1M/month | $0.001 per image |
| Face metadata storage | $0.00001 per face per month |

Source: https://aws.amazon.com/rekognition/pricing/ (US list price; the Mumbai
price may be up to ~25% higher *(est.)*).

### 6.2 Cost maths

Each photo event makes **one** face search
(`grooming_api_node/src/services/faceRecognition.js`).

```
Face searches   = 52,000 events × 1 × $0.001          = $52.00
Face storage    = 1,000 instructors × up to 6 faces
                  = 6,000 faces × $0.00001            = $0.06
Mumbai uplift (up to +25%, est.)                      = up to $13
Total                                                 = $52 – $65 / month
```

One-time cost to enrol reference photos:
`1,000 × 2 calls (DetectFaces + IndexFaces) × $0.001 = $2`.

Group photos cost 1 `DetectFaces` call + 1 search per face; they are occasional
and add little.

---

## 7. Other services

### 7.1 AWS SES (email) — $0.10 per 1,000 emails

Every photo result goes to the instructor **and to every reporting partner**
(both check-in and check-out copies are on by default,
`grooming_api_node/src/services/reportRecipients.js`), plus a failure alert when
a check fails.

```
Emails/month ≈ 52,000 × (1 instructor + P partners) + ~10,000 alerts/reminders
```

| Reporting partners (P) | Emails/month | Cost |
|---|---|---|
| 1 | ~114,000 | ~$12 |
| 3 | ~218,000 | ~$22 |
| 5 | ~322,000 | ~$32 |

### 7.2 Cloudflare R2 (photos) — $0.015/GB-month, first 10 GB free, no egress fees

```
Photos stored (2-month retention) = 52,000 × 2         = 104,000 photos
Storage                           = 104,000 × 0.5–1.2 MB = 52 – 125 GB
Billable                          = 42 – 115 GB × $0.015 = $0.63 – $1.73
Uploads (52k) and reads           = inside the free operation allowance
Total                                                   ≈ $1 – $2
```

### 7.3 Vercel Pro — $20/month

The free Hobby plan is for **personal, non-commercial use only** under Vercel's
terms, so an organisation-wide app needs Pro (1 seat, $20/month).

### 7.4 Free items

| Service | Why it costs nothing |
|---|---|
| cron-job.org | Free service for scheduled jobs |
| BigQuery | Instructor sync reads a small table occasionally |
| SSL certificate | Let's Encrypt (free) via Nginx |

---

## 8. Total monthly cost (1,000 instructors)

| Service | Low | High |
|---|---|---|
| Lightsail $12 + snapshots | $13 | $13 |
| MongoDB Atlas Flex | $8 | $15 |
| Vercel Pro | $20 | $20 |
| Gemini 2.5 Flash-Lite | $59 | $172 |
| AWS Rekognition | $52 | $65 |
| AWS SES | $12 | $32 |
| Cloudflare R2 | $1 | $2 |
| **Total (USD)** | **$165** | **$319** |
| **Total (INR, ₹96/$)** | **₹15,800** | **₹30,600** |

**Most likely: ≈ $210/month (≈ ₹20,000)**

Cost per instructor: **$0.17 – $0.32/month (≈ ₹16 – ₹31)**.
Cost per check-in or check-out: **$0.003 – $0.006 (≈ ₹0.30 – ₹0.60)**.

### Growth reference (2,000 instructors)

This needs the $24 Lightsail plan (4 GB), and Flex may reach its upper tier.
The estimate is roughly **$300 – $600/month (₹28,500 – ₹57,500)**.

---

## 9. Ways to reduce cost

| Idea | Saving | Effort |
|---|---|---|
| Lower Gemini's thinking budget and image resolution | Gemini bill −40–60% (≈ $25 – $90/month) | Configuration change; grading quality must be re-tested first |
| Send reporting partners a daily digest instead of every result | SES volume −60–80% | Small code change |
| Archive MongoDB records older than 1 year | Stay on Flex instead of moving to M10 (saves ~$40+/month later) | Small code change + retention policy decision |

---

## 10. Items to verify after go-live

1. **Real Gemini token usage per call:** read `/health/metrics` after one week
   and replace the estimated ranges in Section 5.
2. **Rekognition price in Mumbai (ap-south-1):** check the AWS Billing console
   after the first month.
3. **Number of reporting partners:** this drives the SES line.
4. **Actual MongoDB data size:** check Atlas → Metrics monthly against the 5 GB
   Flex limit.
5. **Lightsail memory and CPU graphs:** move to the $24 plan if peak RAM stays
   above ~75% or burst credits run low.
