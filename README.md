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

The local integration test covers teacher registration and approval, publishing, enrollment, protected lesson reads, progress and logout. Production preparation still requires a durable database, production identity and session management, authorization policies, private storage and the external media and AI services.
