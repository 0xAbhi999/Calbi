# In-page help requests

The shared navbar, assessment header, and post-assessment feedback header expose a question-mark button. It opens an accessible native dialog with required email, phone, and message fields. Signed-in email is prefilled but remains editable. The dialog traps focus, supports closing, and retains unsent input when reopened on the same page.

## Where requests go

Requests are posted to **our own API**, `POST /api/help`, and stored in Supabase `public.help_requests`. They used to be sent from the browser straight to an external form service (`formspree.io`); that endpoint has a monthly submission limit, so once it was used up every candidate saw "Your request could not be sent" and nothing reached the database the rest of the app reads. **Nothing in the app calls that service any more** (`grep -ri formspree .next` returns no hits after a build).

Fields sent: `id` (a client-generated UUID, reused on retry), `student_id` when signed in, `email`, `phone`, `message`, `page` (pathname only — the query string is stripped, it can carry a session id) and `source`. No assessment answers, scores or tokens are sent.

The endpoint behaves exactly like feedback (`lib/helpStore.ts`):

- valid request + healthy database → `200 {stored:"supabase"}`;
- valid request + unreachable database → `200 {stored:"queue"}` — kept in the local store as `synced: false` and replayed by `flushQueuedHelpRequests()` (run on every `/api/help` POST and by `POST /api/feedback/flush`);
- invalid email / phone / message → `400` with the reason;
- more than 10 requests per IP per 10 minutes → `429`.

The candidate always sees either the success state or a validation error — never an outage of our own making.

Reading: `GET /api/help` is admin-cookie protected (`isAdminRequest`) and merges Supabase with the local queue; `/admin` shows the list under **Help requests** (fetched only when the panel is opened). A queued request is labelled "queued — waiting for Supabase" with the failure reason in its tooltip.

## Assessment safety

Help renders inside the current fullscreen element (or the document body), using `dialog.showModal()` rather than a new tab, external navigation, browser alert, or fullscreen exit. Moving focus to its form controls stays inside the same document, so it does not trigger the existing window-blur / document-hidden warning conditions. There is deliberately **no blanket proctoring suppression**: switching tabs, leaving fullscreen, and connecting displays still follow the existing rules. The assessment timer continues. The dialog closes when a real violation, submission, termination, or assessment review must take priority.

## Checks

- `npm test` includes phone/message boundary tests and `lib/__tests__/helpStore.test.ts` (validation, the Supabase write, the queue + flush, demo mode).
- `npx tsc --noEmit` validates component wiring and portal types.
- `POST /api/help` against a running server: `200 {stored:"supabase"}` and a row in `help_requests`; with `MISSING_TABLE=1 node scripts/mock-postgrest.mjs` it returns `200 {stored:"queue"}` and `POST /api/feedback/flush` delivers it once the database is back.
- `GET /api/help` without the admin cookie → `401`.
- Manual browser check: open help from the navbar, use Tab / Shift+Tab, close it, reopen, and confirm draft retention.
- In an active fullscreen assessment: open, type, send, and close help; confirm the warning count is unchanged and the timer continues.
- While help is open, a real tab switch / fullscreen exit should retain normal proctoring behavior; assessment timeout should dismiss help and show review.
- Check 360px mobile layout and reduced-motion preferences.
