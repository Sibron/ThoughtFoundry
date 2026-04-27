# ThoughtFoundry

A personal "thinking system" PWA for capturing atomic ideas. Built for Sibron Segers — a single-user tool that collects ideas across themes (autism/neurodiversity, relationships, coaching, management, etc.) so they can later be processed into informative books.

## Tech Stack

- **Build tool:** Vite (latest stable, vanilla TypeScript template)
- **Frontend:** Vanilla HTML + CSS + TypeScript (no framework)
- **Database:** Supabase (Postgres, EU region Frankfurt)
- **Auth:** Supabase Auth (email + password)
- **PWA:** vite-plugin-pwa (service worker, installable on Android)
- **Hosting:** Static build deployed to Vimexx via GitHub Actions (FTP)

## Setup

1. **Clone repo**
   ```bash
   git clone https://github.com/Sibron/ThoughtFoundry.git
   cd ThoughtFoundry
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Create a Supabase project**
   - Go to [supabase.com](https://supabase.com) → New project
   - Choose region: **Frankfurt (eu-central-1)**

4. **Run the DB schema**
   - Open your Supabase project → SQL Editor
   - Paste the contents of `supabase/schema.sql` and run it

5. **Create your user**
   - In Supabase dashboard → Authentication → Users → **Add user**
   - Enter your email and a strong password

6. **Configure environment variables**
   ```bash
   cp .env.example .env
   ```
   Fill in `.env`:
   ```
   VITE_SUPABASE_URL=https://your-project.supabase.co
   VITE_SUPABASE_ANON_KEY=your-anon-key
   ```
   Both values are found in Supabase → Project Settings → API.

7. **Start development server**
   ```bash
   npm run dev
   ```

## Deployment (Vimexx via GitHub Actions)

Add the following secrets to your GitHub repository (Settings → Secrets → Actions):

| Secret | Value |
|---|---|
| `VITE_SUPABASE_URL` | Your Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Your Supabase anon key |
| `FTP_SERVER` | Your Vimexx FTP server hostname |
| `FTP_USERNAME` | Your Vimexx FTP username |
| `FTP_PASSWORD` | Your Vimexx FTP password |
| `FTP_SERVER_DIR` | Target directory on server (e.g. `/public_html/`) |

Every push to `main` will build and deploy automatically.

**Note:** HTTPS must be enabled on your domain for PWA features (service worker, install prompt) to work. Enable SSL in your Vimexx control panel.

## Roadmap

| Phase | Status | Description |
|---|---|---|
| Phase 1 — Capture MVP | ✅ Current | Login, capture screen, inbox with CRUD |
| Phase 2 — AI Processing | Not implemented | AI categorization, embeddings, theme linking |
| Phase 3 — Graph / Zettelkasten | Not implemented | Note linking, visual network |
| Phase 4 — Book Generation | Not implemented | Export ideas into book chapters |
