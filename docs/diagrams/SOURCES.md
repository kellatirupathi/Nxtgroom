# Diagram sources

The animated diagrams in the main README are SVG images generated from these Mermaid sources.
To change a diagram: edit its source here, re-render it to `<name>.svg` (Mermaid with `htmlLabels: false`), and keep the flowing-line animation style at the end of the SVG.

## big-picture.svg

```mermaid
flowchart LR
    I(["👩‍🏫 Instructor"]) -->|stands in front of| K["📱 Campus kiosk<br/>(tablet app)"]
    K -->|photo + location| S["⚙️ FacultyTrack<br/>server"]
    S -->|who is this?| F["🧑 Face match<br/>AWS Rekognition"]
    S -->|is the grooming OK?| G["🤖 Gemini AI"]
    S -->|stores photo| R[("🗂️ Photo storage<br/>Cloudflare R2")]
    S -->|stores records| M[("🗄️ MongoDB")]
    S -->|sends reports| E["✉️ Email<br/>Amazon SES"]
    E --> I
    E --> P(["👥 Reporting partners<br/>& management"])
    A(["🧑‍💼 Admins / BOAs"]) -->|manage & review| W["💻 Admin portal<br/>(web)"]
    W --> S
```

## architecture.svg

```mermaid
flowchart TB
    subgraph Clients["🖥️ Clients"]
        direction LR
        APK["📱 Android kiosk app<br/>(Capacitor shell → live site)"]
        WEB["💻 Admin portal<br/>React 19 + Vite"]
        PUB["🔗 Public report pages<br/>(link only, no login)"]
    end

    subgraph Vercel["▲ Vercel"]
        FE["Static web app<br/>nxtgroom-xi.vercel.app"]
    end

    subgraph Lightsail["☁️ AWS Lightsail — one Docker host"]
        NGINX["Nginx<br/>HTTPS · TLS · proxy"]
        subgraph API["Node.js 24 + Express — API"]
            direction LR
            AUTH["Auth & roles"]
            ATT["Attendance<br/>check-in / out"]
            ADM["Admin & settings"]
            REP["Public reports"]
        end
        subgraph Workers["Background workers (same process)"]
            direction LR
            EW["🤖 Evaluation<br/>worker"]
            NW["📨 Notification<br/>worker"]
            MW["✉️ Mail<br/>worker"]
            DS["🗓️ Daily report<br/>scheduler"]
            RS["⏰ Reminder<br/>scheduler"]
            CW["🧹 Storage<br/>cleanup"]
        end
    end

    subgraph Cloud["🌐 Managed services"]
        direction LR
        MDB[("MongoDB Atlas")]
        R2[("Cloudflare R2<br/>photos")]
        REK["AWS Rekognition<br/>faces"]
        GEM["Google Gemini<br/>2.5 Flash-Lite"]
        SES["Amazon SES<br/>email"]
        BQ["Google BigQuery<br/>instructor roster"]
        GEO["OpenStreetMap<br/>address lookup"]
    end

    CRON["⏱️ cron-jobs.org"] -->|"cron secret"| NGINX
    APK --> FE
    WEB --> FE
    PUB --> FE
    FE -->|"HTTPS /api/v2"| NGINX
    NGINX --> API
    AUTH & ATT & ADM & REP <--> MDB
    EW & NW & MW & DS & RS <--> MDB
    ATT --> R2
    ATT --> REK
    ATT --> GEO
    EW --> GEM
    EW --> R2
    MW --> SES
    NW --> SES
    ADM --> BQ
```

## check-in-sequence.svg

```mermaid
sequenceDiagram
    autonumber
    actor I as Instructor
    participant K as Kiosk tablet
    participant API as API server
    participant R2 as R2 photos
    participant REK as Rekognition
    participant DB as MongoDB
    participant EW as Evaluation worker
    participant AI as Gemini
    participant MAIL as Email workers

    I->>K: Stands in front of the camera
    K->>K: Pose check — full body, upright, arms visible (on device)
    K->>API: Photo + location + body regions
    API->>API: Validate and normalise the image
    API->>R2: Upload the photo
    API->>REK: Whose face is this? (campus collection)
    REK-->>API: Instructor match
    API->>DB: Save attendance (check-in or check-out) in a transaction
    API->>DB: Queue an evaluation job
    API-->>K: ✅ "Checked in, Ravi" (within seconds)
    EW->>DB: Claim the job (lease)
    EW->>R2: Download the photo
    EW->>AI: Grade appearance (structured JSON)
    AI-->>EW: Checkpoint results
    EW->>DB: Save the evaluation + verdict
    EW->>DB: Queue report, alert and escalation emails
    MAIL->>I: 📧 Appearance report
```

## kiosk-capture.svg

```mermaid
flowchart LR
    A["Camera frame"] --> B{"Person in frame?"}
    B -- no --> A
    B -- yes --> C{"Full body,<br/>standing straight,<br/>arms relaxed?"}
    C -- no --> D["Show a hint:<br/>'Step back' · 'Lower your hands'"] --> A
    C -- yes --> E{"Held for<br/>1 second?"}
    E -- no --> A
    E -- yes --> F["📸 Capture"] --> G["3-second pause<br/>for the next person"]
```

## check-in-or-out.svg

```mermaid
flowchart TD
    S["Face matched to an instructor"] --> T{"Any attendance<br/>today?"}
    T -- no --> CI["✅ Check-in"]
    T -- "yes, not checked out" --> W{"Too soon after<br/>check-in?"}
    W -- yes --> DUP["Ignored as a duplicate"]
    W -- no --> CO["✅ Check-out"]
    T -- "yes, already checked out" --> DONE["Already done today"]
    S2["No face match"] --> U["Saved as unidentified<br/>for an admin to assign"]
```

## ai-grading.svg

```mermaid
flowchart TD
    P["📷 Photo + gender"] --> G{"Gender?"}

    G -- Female --> F1["Step 1 — Attire type<br/>Saree · Kurti + dupatta · Formal · Abaya"]
    F1 --> F2["Step 2 — Full report<br/>for that attire type"]

    G -- Male --> M1["Crop close-ups on the server<br/>face · waist · trousers · shoes"]
    M1 --> M2["One request: full report<br/>+ close-up answers"]

    F2 --> POST
    M2 --> POST

    subgraph POST["Rule checks on the server"]
        direction TB
        R1["ID card not visible ≠ fail"] --> R2["Blazer worn → shirt & belt rows pass"]
        R2 --> R3["Close-ups correct belt, shoes, beard, trousers"]
    end

    POST --> V{"Any checkpoint<br/>FAIL?"}
    V -- yes --> NC["❌ Non-compliant"]
    V -- no --> C["✅ Compliant"]
    POST --> UA["⚠️ Not assessed<br/>(photo too unclear)"]
```

## emails.svg

```mermaid
flowchart LR
    EV["Evaluation saved"] --> A{"Settings →<br/>Notifications"}
    A -->|"check-in / check-out<br/>report switch"| R1["📧 Instructor report"]
    A -->|"non-compliant"| R2["📧 Alert to reporting partners"]
    EV --> ESC{"3 non-compliant<br/>check-ins in a row<br/>this week?<br/>(holidays skipped)"}
    ESC -- yes --> R3["🚨 Escalation email"]

    T1["⏰ Daily report times"] --> D1["📊 Overall daily report"]
    T1 -->|"campus switch on"| D2["🏫 One report per campus"]
    T2["⏰ Reminder times"] --> M1["Missed check-in email<br/>(Mon–Sat, not holidays)"]
    T2 --> M2["Missed check-out email"]
    W["Weekly switch"] --> WK["📅 Weekly summary"]
```

## daily-timeline.svg

```mermaid
timeline
    title A typical day (India time)
    Morning : Instructors check in at the kiosk
            : AI grades each photo within a minute
            : Instructor gets the appearance report
    10.30 AM : Missed check-in emails (if switched on)
    1.00 PM : Daily report — morning check-ins
            : Campus reports (if switched on)
    Evening : Instructors check out
            : Check-out photos graded and reported
    6.30 PM : Daily report — afternoon
    7.00 PM : Missed check-out emails (if switched on)
```

## data-model.svg

```mermaid
erDiagram
    COLLEGES ||--o{ INSTRUCTORS : "has"
    COLLEGES ||--o{ BOAS : "operated by"
    COLLEGES ||--o{ ATTENDANCE : "recorded at"
    INSTRUCTORS ||--o{ ATTENDANCE : "checks in"
    ATTENDANCE ||--o{ EVALUATIONS : "check-in + check-out"
    USERS ||--o| BOAS : "login for"
    ATTENDANCE ||--o{ MAIL_JOBS : "triggers"
    ATTENDANCE ||--o{ NOTIFICATION_JOBS : "triggers"
    ATTENDANCE ||--o{ EVALUATION_JOBS : "queues"

    COLLEGES {
        string _id
        string name
        string location
        date deleted_at
    }
    INSTRUCTORS {
        string _id
        string name
        string email
        string employee_id
        string instructor_user_id
        string gender
        string college_id
        string instructor_category
        array face_ids
        string report_token
        date deleted_at
    }
    ATTENDANCE {
        string _id
        string instructor_id
        string college_id
        string attendance_day
        date check_in_time
        date check_out_time
        string check_in_photo_key
        string check_out_photo_key
        string status
        string checkout_compliance_status
        string remarks
    }
    EVALUATIONS {
        string attendance_id
        string kind
        string overall_status
        array attire_check
        array grooming_check
        string prompt_version
    }
    USERS {
        string email
        string role
        string password_hash
        number session_version
    }
    BOAS {
        string employee_id
        string college_id
    }
```

## roles.svg

```mermaid
flowchart LR
    SA["👑 Super admin"] --> ALL["Everything, including<br/>admin accounts & the audit log"]
    AD["🧑‍💼 Admin"] --> MOST["All campuses: instructors,<br/>institutes, BOAs, settings, reports"]
    BOA["🏫 BOA"] --> ONE["One campus: run the kiosk,<br/>see that campus's records"]
    PUB["🔗 Anyone with a link"] --> RPT["One report page only"]
```

## deploy.svg

```mermaid
flowchart LR
    DEV["💻 git push<br/>to main"] --> V["▲ Vercel builds<br/>the web app"]
    DEV --> L["☁️ Lightsail:<br/>deploy/lightsail/deploy.sh"]
    L --> D["🐳 Docker image<br/>rebuilt & restarted"]
    D --> H{"/health/ready"}
    H -- ok --> LIVE["✅ Live"]
    V --> LIVE
```
