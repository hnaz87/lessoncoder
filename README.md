# CodeLesson AI

Turn coding lessons into professional teaching videos in minutes.

A self-hosted web app: teachers sign up, describe a lesson (Python, Scratch, Roblox/Luau or Minecraft Education + MakeCode), and get an AI-written lesson with synchronized narration, animated code or blocks, real program output, captions, a challenge and a quiz — then render it to MP4.

## What you need

- **Docker** with Docker Compose (recommended), or Node.js 20+ for development
- A free **Google Gemini API key** from https://aistudio.google.com/apikey — one key powers both lesson writing and the AI narrator voice

On Gemini's free tier, Google may use your prompts and outputs to improve its products, and per-minute limits are low, so a long lesson can take a few minutes to generate. For real student or school data, enable billing on the Google project (still inexpensive) or switch providers — see *Using a different AI provider*.

## Run it (Docker — recommended)

```bash
cp .env.example .env
# edit .env: set GEMINI_API_KEY and SESSION_SECRET (any long random string)
docker compose up -d --build
```

Open http://localhost:3000, create an account, and open a sample lesson or click **New lesson**.

Check everything is wired up:

```bash
node scripts/smoke.js http://localhost:3000
```

## Using GitHub

### 1. Put the code on GitHub

Create a new repository on github.com (private is fine), then upload this folder: either drag the files into **Add file → Upload files**, or from a terminal:

```bash
cd codelesson-ai
git init && git add . && git commit -m "CodeLesson AI"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

`.env` is in `.gitignore`, so your API keys are never uploaded.

Every push now runs **Actions → Test and deploy**: it checks the code, tests the sandbox limits, builds both containers, starts the full app and runs the smoke test (sign-up, lessons, Python execution, network isolation). A green check means the whole stack works.

### 2. Try it in Codespaces (no install needed)

1. In your repo: **Settings → Secrets and variables → Codespaces → New repository secret**, add `GEMINI_API_KEY`.
2. Click **Code → Codespaces → Create codespace on main**.
3. Wait for the build (a few minutes the first time). The app opens automatically; if not, open the **Ports** tab and click the globe icon next to port 3000.

Codespaces stops when idle and is meant for you, not your teachers. Use a server for real use.

### 3. Auto-deploy to a server on every push

1. Rent a small Ubuntu VPS (2 GB RAM) and SSH into it.
2. Copy `scripts/server-setup.sh` to it and run:
   ```bash
   bash server-setup.sh git@github.com:<you>/<repo>.git
   ```
   It installs Docker, asks for your API keys, starts the app, and prints the values for the next step. (For a private repo it also shows a deploy key to add under **Settings → Deploy keys**.)
3. In GitHub: **Settings → Secrets and variables → Actions**, add `VPS_HOST`, `VPS_USER` and `VPS_SSH_KEY` exactly as printed. Optional: `VPS_PORT`, `VPS_APP_DIR`.
4. Add HTTPS (below). From now on, every push to `main` that passes the tests is deployed automatically. Until those secrets exist, the deploy step is skipped.

## Run it for development (no Docker)

```bash
npm install
cp .env.example .env        # set GEMINI_API_KEY
npm run dev                 # SANDBOX_MODE=local-unsafe: Python runs locally with resource limits only
```

`local-unsafe` is for your own machine only — it has no network or filesystem isolation. Always deploy with Docker Compose.

## Deploying to a server

1. Copy the project to any Linux VPS with Docker (e.g. a small DigitalOcean, Hetzner, Lightsail or EC2 instance; 2 GB RAM is plenty).
2. Fill in `.env`, set `COOKIE_SECURE=1`, and run `docker compose up -d --build`.
3. Put HTTPS in front of port 3000. The simplest option is Caddy:
   ```
   lessons.yourschool.org {
       reverse_proxy localhost:3000
   }
   ```
4. To run a private instance, create your accounts and then set `DISABLE_SIGNUP=1`.

Data (database, voice cache) lives in the `appdata` Docker volume. Back it up with
`docker run --rm -v codelesson-ai_appdata:/d -v $PWD:/b alpine tar czf /b/backup.tgz -C /d .`

## How it fits together

```
browser (public/index.html)
  ├─ lesson editor, sync timeline engine, canvas renderer, MediaRecorder export
  └─ talks only to the app server ──► app (server/, Node + Express + SQLite)
                                        ├─ accounts & sessions (bcrypt, httpOnly cookies)
                                        ├─ lessons database
                                        ├─ /api/ai/json  ──► Gemini API (or Anthropic) — your key never reaches browsers
                                        ├─ /api/tts      ──► Gemini TTS (or OpenAI) — cached audio per sentence
                                        ├─ /api/convert  ──► ffmpeg (WebM → MP4)
                                        └─ /api/run ──unix socket──► sandbox container (sandbox/server.py)
```

**Lesson generation.** Two stages: a plan (objectives, scene list, final program, quiz, challenge), then each scene is written in parallel. Every AI reply is validated against the lesson schema; small problems are repaired automatically and reported in the editor, and invalid replies are sent back to the AI once with the list of errors.

**Synchronization.** Each scene is a list of *beats* — one or two sentences of narration plus the events that happen while it is spoken (`TYPE_CODE`, `HIGHLIGHT_CODE`, `SHOW_OUTPUT`, `SHOW_BLOCK`, `HIGHLIGHT_BLOCK`, `MOVE_AGENT`, `PLACE_BLOCK`, `SHOW_TEXT`, `SHOW_CHALLENGE`, `SHOW_QUIZ`, …). A timeline compiler turns beats into timed events; with the AI narrator, each beat's length is the real length of its audio, so voice, code and highlights stay locked together. The renderer draws any frame purely from the timeline, so preview, scrubbing and export are identical.

**Python security.** Lesson code never runs in the web server. The sandbox container has no network (`network_mode: none`), a read-only filesystem with a 64 MB tmpfs, a 512 MB / 1 CPU / 128-process cap, all Linux capabilities dropped except the ones needed to switch users, `no-new-privileges`, and no access to `.env`. Each run gets a fresh temp directory, an empty environment, an unprivileged user, 2 s CPU, 5 s wall clock, 256 MB memory, 16 processes, 1 MB file writes and 64 KB of output; the whole process group is killed on any limit.

**Adding a platform or blocks.** Platforms are defined in `PLATFORMS` in `public/index.html`; block sets in `BLOCK_SETS` (one entry per block: category, shape and a label like `move (STEPS) steps`). The AI prompt for each platform is in `platformGuide()`.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | — | Required. Lessons and narrator voice |
| `GEMINI_MODEL` | `gemini-3.8-flash` | Model that writes lessons |
| `GEMINI_TTS_MODEL` | `gemini-3.8-flash-lite-tts` | Narrator voice model (`gemini-3.8-flash-tts` sounds richer) |
| `GEMINI_THINKING` | `low` | `minimal`, `low`, `medium` or `high` |
| `AI_CONCURRENCY` | `2` | Scenes written in parallel; use `1` if the free tier keeps rate-limiting |
| `SESSION_SECRET` | — | Required in production |
| `AI_DAILY_LIMIT` | `300` | AI requests per user per day |
| `DISABLE_SIGNUP` | `0` | `1` closes registration |
| `COOKIE_SECURE` | `0` | `1` when served over HTTPS |
| `SANDBOX_MODE` | `socket` | `socket`, `local-unsafe` or `off` |

## Using a different AI provider

Gemini is the default. To use Claude for lesson writing instead, set `AI_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`. To use OpenAI voices, set `TTS_PROVIDER=openai` and `OPENAI_API_KEY`. You can mix them (for example Claude for lessons, Gemini for the voice).

## Costs

On Gemini's free tier, lesson generation and the narrator voice cost nothing, within Google's rate limits. An 8-minute lesson is roughly 10–12 text requests plus one voice request per narration sentence (about 60–80); voice audio is cached, so re-rendering costs nothing extra. If you outgrow the free limits, enabling billing on the Google project raises them; check the Gemini pricing page for current rates.

## Known limits

- Rendering happens in the teacher's browser in real time (an 8-minute lesson takes 8 minutes); keep the tab visible while it renders. Chrome and Edge are recommended.
- Scratch, Roblox and Minecraft scenes are simulations drawn by the app; they don't drive the real Scratch, Roblox Studio or Minecraft apps. Only Python code is actually executed.
- The AI writes Luau and MakeCode JavaScript but cannot run them; the "Output" shown is the AI's expected result.
