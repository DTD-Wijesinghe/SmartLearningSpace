# SmartLearningSpace

SmartLearningSpace currently runs the core course workflow on a local Node 24 server. The server handles login, role checks and data persistence. The browser uses the same origin for the app and API.

## Run locally

To initialize the development administrator, enter a local password of 12–128 characters in PowerShell and start the server:

```powershell
$env:SMARTLEARNING_ADMIN_PASSWORD = Read-Host 'Local administrator password' -MaskInput
node backend/server.js
```

Open http://127.0.0.1:8787. Sign in as `admin@smartlearning.local` using the password you just set. This variable initializes the administrator on first use. Register separate teacher and student accounts in the browser, then approve the teacher in the administrator dashboard.

```powershell
node --test backend/server.test.js
```

The server stores changes in the ignored `work/local-data.json`. Restarting requires users to sign in again. The JSON store supports one local server process. The seed file is read only when initializing a fresh local store. Set `SMARTLEARNING_API_PORT` if port 8787 is occupied.

The local integration test covers teacher registration and approval, publishing, enrollment, protected lesson reads, progress and logout.

### Supabase and hosting

Apply `backend/supabase/migrations/202611200001_core.sql` to the dedicated database. It adds a private schema, enables RLS on its tables and exposes a single role-checked RPC. Verify the migration with `backend/supabase/test-workspace.sql`. The test uses transaction-scoped identities and rolls back all fixture records.

Set `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` on the API. Register and confirm the first administrator's account through Supabase Auth, verify its Auth UUID, then change that exact profile's role to `admin` from the Supabase SQL editor. Keep email confirmation enabled and configure the public website URL in Supabase Auth before inviting users. Existing local demo data stays in the local store.

The Render Blueprint declares a free Node web service. On a Vercel project eligible for Hobby, use the Other framework preset and `npm run build`. Set `RENDER_API_ORIGIN` to the Render HTTPS origin at build time. The generated Build Output API configuration proxies `/api/*` and maps supported page routes to the frontend. R2 and other media providers require separate configuration.
