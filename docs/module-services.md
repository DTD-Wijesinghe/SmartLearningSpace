# Module services setup

The module catalog, exams and provider integrations are staged. Apply the modules and providers SQL migrations in order to the dedicated Supabase project as part of an approved release. On the existing Render service, change the build command to `npm ci --omit=dev && node --check backend/server.js` before deploying. The committed platform blueprint already uses `npm ci`.

## File storage and video

Keep the R2 bucket private. Configure `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY` with a bucket-scoped credential. Keep `SUPABASE_SERVICE_ROLE_KEY` on the server so only the API can confirm that the reserved object reached R2. Keep all signing credentials out of the browser and Git.

R2 CORS for the exact Render origin needs `PUT` with `Content-Type` and `If-None-Match`. The application signs the expected byte count, content type and write-once condition. The browser uploads to R2 directly, and the API checks object metadata before making the material visible. The uploader validates the duration of browser-decodable videos. The MVP uses native MP4 or WebM playback and a single signed PUT. A four-hour recording also needs to fit within the 2 GiB file limit. Unsupported codecs, transcoding, adaptive bitrate, server-side duration analysis, malware scanning and resumable multipart upload need a subsequent media pipeline.

Materials are limited to 8 GiB and 500 reservations across this application, with a 4 GiB cap per teacher. Reservations include incomplete uploads. Review abandoned reservations and provider costs before inviting real classes. Cloudflare applies its free allowance and usage charges at the account level. A viewer holding a signed link can use it until it expires.

## Private classroom

Set `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` for a LiveKit project. The app issues room-scoped tokens only to the module teacher and enrolled students. Student tokens can subscribe and have publishing disabled. Start and end rooms from the module page. This release supports a live camera and microphone broadcast. Recording and scheduled events require further work. Verify token issuance, permissions, camera, sound and room closure on a real provider before rollout. [LiveKit quotas](https://docs.livekit.io/deploy/admin/quotas-and-limits/)

## AI assistant

Configure `AI_API_URL` with the full HTTPS chat-completions endpoint, along with `AI_API_KEY` and `AI_MODEL`. Use an account with an approved spending limit or a free quota. Each app user can make 12 requests per UTC day and the app can make 100 across users. These caps do not replace provider billing controls.

Teachers can ask for draft assessment feedback from a scored answer sheet. The teacher retains control of marks and release. Students can request study steps based on unfinished lessons and their released results. The help chat answers questions about the platform guide. When AI is unavailable, the student help panel uses the built-in guide. Exam answers and course titles supplied to the model should contain only material authorized for processing by the chosen provider.

## Verification

Run `npm test` for the local workflow and adapter checks. Run `backend/supabase/test-workspace.sql`, `test-modules.sql`, and `test-providers.sql` after applying the migrations to a test database. Those tests roll back their fixtures. Real R2 upload and range playback, LiveKit media, and AI responses require connected credentials and separate live verification.
