# NeoHR data contract

**Contract version:** 2. It comes from the database migration `service_v2_rma` (`sql/service-v2.sql`). Version 2 replaces the `v_tech_activity` view with the `tech_activity` RPC and changes phone normalisation, check-out handling, claim retries and re-timed claims; see §10 for the list.
**Audience:** the Android (Kotlin) developer turning *Daily Logger* (today a local-only Room/SQLite app) into **NeoHR**. NeoHR talks to the same Supabase project as the Neo Tokyo desktop app and website.

This file is the only promise the server makes to NeoHR. Everything listed here exists in the database once `service_v2_rma` is applied. Anything not listed (tables, columns, other RPCs) may change without notice, so NeoHR must not read or write it.

---

## 1. What NeoHR does with this

| NeoHR feature | Server surface |
|---|---|
| Sign in as a staff member | Supabase Auth (email + PIN), then `my_modules()` |
| "Open jobs near me" (the queue) | view `v_service_queue` |
| Take a job, optionally with a visit time | RPC `service_claim` |
| Hand a job back | RPC `service_release` |
| "My day" (claimed jobs with address and phone) | view `v_tech_day` |
| Left shop / Checked in / Checked out | RPC `record_field_activity` (kinds `left_base`, `arrived`, `departed`) |
| Attendance punch in / out | RPC `record_field_activity` (kinds `punch_in`, `punch_out`) |
| Daily work-log entries (the Daily Logger feature) | RPC `record_field_activity` (kind `note`, `ref_type` `work_log`) |
| Notes on a job | RPC `service_add_note` |
| Photos on a job | Storage bucket `service-media` + table `service_media` |
| HR / manager activity report | RPC `tech_activity`, table `field_activity` |
| Technician picker | RPC `service_tech_list` |
| A part pulled from a customer's machine on site | RPC `rma_create` with `source: "field"` (§6.8) |

Daily Logger's local Room database stays the source of truth for the person's own log while offline. The server receives an idempotent copy (see §6).

---

## 2. Connection and authentication

- **Project URL:** `https://ggsxkhenzdhaachubrsc.supabase.co`
- **Key:** the project's *publishable* (anon) key, the same one the website uses. Ask the owner for it. It is public by design and safe to ship in the APK; every table is protected by row-level security.
- **Never** put the `service_role` / `sb_secret_…` key in the app or in any NeoHR backend that acts for a user. It bypasses every rule in this document.

### Sign-in
Staff accounts are the same accounts as the desktop app and the website. The password is the person's PIN: 6 digits for tiers 1–3, 8 digits for tiers 4–5.

```
POST {URL}/auth/v1/token?grant_type=password
apikey: <publishable key>
Content-Type: application/json

{"email": "athul.sudheer@neotokyo.in", "password": "<PIN>"}
```

The response carries `access_token` (a JWT that lasts about one hour) and `refresh_token`. Refresh with `grant_type=refresh_token` before the access token expires. With `supabase-kt` (`io.github.jan-tennert.supabase`), the Auth plugin does this for you:

```kotlin
val supabase = createSupabaseClient(URL, PUBLISHABLE_KEY) {
    install(Auth)
    install(Postgrest)
    install(Storage)
}
supabase.auth.signInWith(Email) { email = e; password = pin }
```

### Every data call
```
apikey: <publishable key>
Authorization: Bearer <access_token>
Content-Type: application/json
```

The server identifies the person **only** from the JWT. NeoHR never sends a user id or role to prove who someone is. A field such as `employee_email` in a payload is a request; it is ignored unless the caller is allowed to act for someone else (§5.4).

### Who counts as staff
The person's row in `profiles` must have `active = true` and `is_staff = true`. Otherwise every RPC answers `NEO_DENIED: Sign in with an active staff account to do this.` NeoHR should then sign out and show that sentence.

---

## 3. Access model: tiers and module roles

Each person has a **tier** (1–5) and, per module, an optional **role**: `desk` < `tech` < `lead`.

- Tier 3 and above is automatically `lead` in every module.
- Everyone else gets roles from the `module_access` table. Tier 4+ set these in the desktop app under Settings → Module access.
- Modules: `service`, `rma`, `qc`, `neohr`. The server checks the `neohr` role in one place: a `neohr` lead sees everyone's activity (`tech_activity`, `field_activity`). Other `neohr` uses are reserved for NeoHR's own features.

### `my_modules()` — call once after sign-in, then cache
```
POST {URL}/rest/v1/rpc/my_modules
{}
```
```json
{"service": "tech", "rma": "tech", "qc": null, "neohr": null, "tier": 2}
```

| Capability | Needs |
|---|---|
| Read the queue, tickets, own day | `service` role `desk` or higher |
| Claim a job | `service` role `tech` or higher |
| Release your own job | being its assignee (`tech`); a `lead` can release anyone's |
| Release while `en_route` / `on_site` | `lead` only |
| Add a job note | `service` role `desk` or higher |
| Post your own field activity / attendance / work log | any active staff member |
| Post field activity **for someone else** | `service` role `lead` |
| Log a part pulled on site (`rma_create`, `source: "field"`) | `service` or `rma` role `desk` or higher (techs qualify) |
| Read everyone's activity (HR, managers) | `service` role `lead`, `neohr` role `lead`, or tier 3+ |

A role change takes effect on the person's **next request**; no new sign-in is needed. The desktop app tells people to restart, so NeoHR can simply re-call `my_modules()` when it returns to the foreground.

---

## 4. Conventions

### Ids
- Ticket ids are text, for example `s_mgx1k2abcde`. Never parse them.
- The customer-facing ticket code is `NT-` plus 8 characters (for example `NT-7KQ2ACDE`). Parts use `RM-` plus 8 characters.
- Field-activity ids are UUIDs.

### Time
- Send every timestamp as ISO-8601 **with an offset**: `2026-10-23T09:30:00Z` or `2026-10-23T15:00:00+05:30`. A string without an offset is read as UTC, which is wrong for India by 5h30.
- Timestamps come back as ISO-8601 with an offset (`2026-10-23T09:30:00.123+00:00`). Show them in the device's local time.
- "Day" in reports means the shop's day, `Asia/Kolkata`.

### Phone numbers
Send phone numbers as typed. The server normalises them to digits **with the country code** (`norm_phone`). The rule, in order:

1. Keep the digits only.
2. If they start with `00` (the international dialling prefix), drop that one leading `00`.
3. 10 digits → `91` + the digits. 11 digits starting with `0` → `91` + the last 10.
4. Anything else stays as it is (already international, or too short to use).

| Typed | Stored / matched as |
|---|---|
| `98470 12345` (10 digits) | `919847012345` |
| `098470 12345` (11 digits, leading 0) | `919847012345` |
| `+91 98470 12345` or `0091 98470 12345` | `919847012345` |
| `+971 50 123 4567` or `00971 50 123 4567` (Gulf / NRI) | `971501234567` (kept as it is) |
| `+974 5012 3456` (Qatar: code + 8 digits) | `97450123456` |

A usable number (`phone_ok`) has **12 to 15 digits** after this, or **11 digits starting with `965`, `968`, `973` or `974`** (Kuwait, Oman, Bahrain, Qatar, whose numbers are a 3-digit code plus 8 digits). Nothing else is accepted: an Indian mobile typed with one digit too many (`98470123456`) is refused, not guessed at. The desktop app and the website apply the identical rule (`NeoQcCatalog.normPhone` / `phoneOk`), so check it the same way on the phone before sending:

```kotlin
fun normPhone(raw: String?): String {
    var d = (raw ?: "").filter { it in '0'..'9' }
    if (d.startsWith("00")) d = d.substring(2)
    return when {
        d.length == 10 -> "91$d"
        d.length == 11 && d[0] == '0' -> "91" + d.takeLast(10)
        else -> d
    }
}
fun phoneOk(norm: String): Boolean =
    norm.length in 12..15 || (norm.length == 11 && norm.take(3) in setOf("965", "968", "973", "974"))
```

A ticket's `customer_phone` stays exactly as it was typed; every lookup normalises both sides. For WhatsApp, open `https://wa.me/<normalised digits>`. The tracking page checks the **last 4 digits** of the number, which works the same for Indian and foreign numbers.

### Errors
A failed RPC returns HTTP 4xx with PostgREST's error body:

```json
{"code": "P0001", "message": "NEO_GATE: Say why you're handing it back.", "details": null, "hint": null}
```

| `message` starts with | Meaning | What NeoHR does |
|---|---|---|
| `NEO_GATE:` | The request breaks a rule (missing reason, wrong step, bad value) | Show the sentence after the colon. **Permanent:** retrying the same payload fails again. |
| `NEO_DENIED:` | Not allowed for this person | Show the sentence. Permanent. Re-check `my_modules()`. |
| `NEO_STALE:` | Someone else changed the job first | Show the sentence, refresh the job. Permanent for this payload. |
| `NEO_RMA_HOLD:` | The job is waiting on a part under warranty claim, for example "This ticket is waiting on RMA RM-7KQ2PX4D. Move the part on in the RMA module, or release it from the ticket (update the app on this PC if you don't see those options)." | Show the sentence. Permanent until the RMA desk acts. |
| `permission denied …` (code `42501`) | Called something NeoHR may not touch | A bug. Report it. |
| HTTP 401 / `JWT expired` | Token expired | Refresh the token, then retry. |
| Network error, HTTP 5xx, timeout | Transient | Retry with backoff, **reusing the same `client_request_id`**. |

To display an error, strip everything up to and including the first `": "` after the `NEO_…` prefix. Never show the raw prefix.

### Idempotency
Every write NeoHR may queue offline carries a `client_request_id`: a random UUID v4 generated **once per user action** and stored with the queued item. Every retry sends the same UUID. The server records the action once; a repeat returns the first result with `"duplicate": true`. Treat `duplicate: true` as success.

---

## 5. Reads

The two views are read through PostgREST as `GET {URL}/rest/v1/<view>?select=…`. They are `security_invoker`: the caller's own row-level security applies, so a person only ever gets rows they are allowed to see. Neither view (nor any table here) is readable without signing in. The activity report is an RPC (§5.3).

### 5.1 `v_service_queue` — open, unclaimed jobs
No customer phone, no customer surname, no street address. Location is rounded to 2 decimals (about 1 km).

| Column | Type | Notes |
|---|---|---|
| `id` | text | ticket id, used for `service_claim` |
| `public_code` | text | `NT-…` |
| `service_type` | text | `in_store` \| `on_site` \| `remote` |
| `category` | text | `repair`, `warranty_claim`, `upgrade`, `installation`, `data_recovery`, `os_software`, `networking`, `maintenance`, `diagnosis_only` |
| `priority` | text | `low` \| `normal` \| `high` \| `urgent` |
| `fault_keys` | text[] | catalogue keys, for example `["no_display","network_setup"]` |
| `device_label` | text | primary item, for example "ASUS TUF A15" |
| `site_area`, `site_pincode` | text | on-site only |
| `lat`, `lng` | double | rounded to 2 decimals, may be null |
| `window_start`, `window_end` | timestamptz | when the customer is available |
| `window_note` | text | for example "weekdays after 5 pm" |
| `est_minutes` | int | typical time on site |
| `queued_at` | timestamptz | when it entered the queue |
| `suggested_tech_email` | text | requested technician, if any |
| `suggest_reason` | text | |
| `created_at` | timestamptz | |
| `stage` | text | usually `logged` (or `revisit_needed`, `en_route` after a release) |
| `customer_first_name` | text | first word of the name only |

```
GET {URL}/rest/v1/v_service_queue?select=*&service_type=eq.on_site&order=queued_at.asc
```

**Queue urgency.** Compute it on the device, using the same rule as the desktop:
- Budget in hours: `urgent` 1, `high` 4, `low` 24; `normal` is 8 for on-site and 4 otherwise.
- Hours waiting = now − `queued_at` (or `created_at` if `queued_at` is null).
- Waiting ≥ budget → late (red, with the word "late"). Waiting ≥ 0.75 × budget → due soon. Otherwise fine.
- Show "Requested for you" when `suggested_tech_email` equals the signed-in email.

### 5.2 `v_tech_day` — my claimed, open jobs
Only jobs whose assignee is the signed-in person. This is the only place NeoHR gets a customer's address and phone. Anything cached offline must come from here (see §6).

Columns: `id, public_code, service_type, category, priority, stage, stage_since, fault_keys, reported_fault, device_label, customer_name, customer_phone, site_address, site_area, site_pincode, site_landmark, site_maps_url, site_lat, site_lng, site_contact, window_start, window_end, window_note, visit_start, visit_end, visit_count, est_minutes, remote_tool, remote_session_ref, promised_at, needed_by, assigned_at, assigned_via, updated_at`.

```
GET {URL}/rest/v1/v_tech_day?select=*&order=visit_start.asc.nullslast
```

`remote_session_ref` is a session id, never a password. The one password the server keeps is a device's password or PIN that the customer gave at the counter (§6.10). It is in no table or view NeoHR can read, only behind its own RPC, and it is deleted when the job closes.

### 5.3 `tech_activity(p_from, p_to)` — per person per day (HR and managers)
An RPC (it replaced the version-1 view `v_tech_activity`). A `service` lead, a `neohr` lead, or anyone tier 3+ gets everyone's rows; anyone else gets only their own.

```
POST {URL}/rest/v1/rpc/tech_activity
{"p_from": "2026-10-01", "p_to": "2026-10-31"}
```

- Both dates are shop days (`Asia/Kolkata`), inclusive. Either may be `null`: the default range is the last 30 days up to today.
- At most 366 days per call; an end before the start is `NEO_GATE`.
- The answer is a JSON array, newest day first, then by email (`[]` when there is nothing):

```json
[{"employee_email": "athul.sudheer@neotokyo.in", "employee_name": "Athul Sudheer", "day": "2026-10-23",
  "claims": 2, "releases": 0, "released_by_lead": 0, "manager_assigns": 1,
  "visits_left": 1, "visits_arrived": 1, "visits_done": 1, "revisits": 0, "parts_needed": 0, "customer_absent": 0,
  "punch_ins": 1, "punch_outs": 1,
  "first_at": "2026-10-23T03:31:00+00:00", "last_at": "2026-10-23T12:02:00+00:00"}]
```

| Key | Meaning |
|---|---|
| `employee_email`, `employee_name`, `day` | who and when (`employee_email` is lower-case) |
| `claims` | jobs taken from the queue (including "take it myself" at intake) |
| `releases` | jobs the person handed back themselves |
| `released_by_lead` | jobs a lead took off them |
| `manager_assigns` | jobs a lead assigned to them |
| `visits_left`, `visits_arrived`, `visits_done` | field check-ins (`left_base`, `arrived`, `departed` + `done`) |
| `revisits`, `parts_needed`, `customer_absent` | the other `departed` outcomes |
| `punch_ins`, `punch_outs` | attendance |
| `first_at`, `last_at` | first and last recorded event that day |

```kotlin
val rows = supabase.postgrest.rpc("tech_activity",
    buildJsonObject { put("p_from", "2026-10-01"); put("p_to", JsonNull) }).decodeAs<JsonArray>()
```

### 5.4 `field_activity` — the raw log (read only)
The same visibility as `tech_activity`: your own rows, or everyone's for a `service` lead, a `neohr` lead or tier 3+. Columns: `id, client_request_id, employee_email, employee_name, module, ref_type, ref_id, kind, outcome, at, received_at, lat, lng, accuracy_m, note, media_path, source, applied, applied_note`. `at` is device time; `received_at` is server time. NeoHR cannot insert here directly; it writes only through `record_field_activity`.

---

## 6. Writes (RPCs)

Every RPC is a `POST {URL}/rest/v1/rpc/<name>` with a JSON object of **named arguments**. A function that takes one `jsonb` argument named `p` is called with `{"p": { … }}`.

```kotlin
// supabase-kt
val result = supabase.postgrest.rpc(
    "record_field_activity",
    buildJsonObject { put("p", payload) }   // payload: JsonObject
).decodeAs<JsonObject>()
```

### 6.1 `record_field_activity(p jsonb)` — idempotent, safe to queue offline

Request:
```json
{
  "p": {
    "client_request_id": "6f1c2a8e-3d55-4c2b-9b7e-1a2b3c4d5e6f",
    "kind": "arrived",
    "outcome": null,
    "ref_type": "service_job",
    "ref_id": "s_mgx1k2abcde",
    "module": "service",
    "at": "2026-10-23T09:31:12+05:30",
    "lat": 10.01593, "lng": 76.34192, "accuracy_m": 12.5,
    "note": null,
    "media_path": null,
    "source": "neohr"
  }
}
```

| Field | Required | Values |
|---|---|---|
| `client_request_id` | **yes** | UUID v4, one per action, reused on retry |
| `kind` | **yes** | `punch_in`, `punch_out`, `left_base`, `arrived`, `departed`, `note`, `photo` |
| `outcome` | for `departed` | `done`, `revisit_needed`, `parts_needed`, `customer_absent` |
| `ref_type` | no (default `service_job`) | `service_job`, `rma_case`, `attendance`, `work_log`, `none` |
| `ref_id` | for job events | the ticket `id` from `v_tech_day` |
| `module` | no (default `service`) | `service`, `rma`, `neohr` |
| `at` | strongly recommended | **device time when it happened** (default: server time on arrival) |
| `lat`, `lng`, `accuracy_m` | no | an out-of-range or partial fix is dropped and the record is kept |
| `note` | no | up to 2000 characters |
| `media_path` | no | storage path of a photo already uploaded (§6.5) |
| `source` | no (default `desktop`) | NeoHR must send `neohr` |
| `employee_email` | no | ignored unless the caller is a `service` lead (posting for the assignee) |

Response:
```json
{"id": "0b7d…", "applied": true, "applied_note": "Moved to On site.", "stage": "on_site", "duplicate": false}
```

A replay of the same `client_request_id`:
```json
{"id": "0b7d…", "applied": true, "applied_note": "Moved to On site.", "stage": "on_site", "duplicate": true}
```

**What moves a job.** Every activity is stored, whoever sends it. A job moves only when `ref_type` is `service_job`, the job is **on-site**, and the sender is its assignee (or a lead):

| kind (+ outcome) | from stage | to stage | customer sees |
|---|---|---|---|
| `left_base` | logged, scheduled, revisit_needed | `en_route` | "Our technician is on the way." |
| `arrived` | logged, scheduled, en_route, revisit_needed | `on_site` (visit_count + 1) | "Our technician has arrived." |
| `departed` + `done` | scheduled, en_route, on_site | `work_done` | "Work done on site. Tell us if anything is still wrong." |
| `departed` + `revisit_needed` | scheduled, en_route, on_site | `revisit_needed` | internal only |
| `departed` + `parts_needed` | scheduled, en_route, on_site | `parts_to_order` | internal only |
| `departed` + `customer_absent` | scheduled, en_route, on_site | `revisit_needed` (the visit time is cleared) | "We missed you at the visit — we'll call you to book another time." |

**Customer absent.** The booked time is spent, so the server clears `visit_start` / `visit_end` and the job waits at `revisit_needed` for the next visit: the desk books a new time in the desktop app, and `left_base` / `arrived` work from `revisit_needed` as usual. The job stays with the same technician. The tracking page then says "We'll call you to book the follow-up visit" instead of reading the old slot as a late visit.

**A forgotten check-in.** A check-out (`departed`) from `scheduled` or `en_route` means the technician did reach the site but the check-in never got sent (no signal, forgot to tap). The server counts the visit (`visit_count + 1`) and adds an internal line "Check-in was not recorded — assumed." A second check-out after the job has already moved past `on_site` is stored with `applied: false`.

Any other combination is still **recorded**, with `applied: false` and an `applied_note` explaining why. Show that sentence:
- "No change: ticket is at Work done — awaiting sign-off."
- "No change: this ticket is with Adhil M."
- "No change: take the ticket from the queue first."
- "No change: check-ins only move on-site tickets."
- "Recorded." (for punch, note and photo kinds)

The technician's `note` is **never** shown to the customer. When a move is customer-visible, the customer reads the fixed wording above and the note goes into the job as an internal note.

**Attendance:**
```json
{"p": {"client_request_id": "…", "kind": "punch_in", "ref_type": "attendance", "module": "neohr",
       "at": "2026-10-23T09:02:00+05:30", "lat": 10.0159, "lng": 76.3419, "source": "neohr"}}
```

**A Daily Logger work-log entry:**
```json
{"p": {"client_request_id": "<the Room row's UUID>", "kind": "note", "ref_type": "work_log",
       "ref_id": "<the Room row's UUID>", "module": "neohr", "at": "<entry time>",
       "note": "Re-cabled the front office switch", "source": "neohr"}}
```
Use the Room row's own UUID as `client_request_id` so a re-sync can never post the same entry twice. An entry edited after it was posted is a new action with a new UUID; the server keeps both and does not overwrite.

### 6.2 `service_claim(p_job_id, p_visit_start, p_visit_end, p_reason)` — online only
```json
{"p_job_id": "s_mgx1k2abcde",
 "p_visit_start": "2026-10-24T14:00:00+05:30",
 "p_visit_end": "2026-10-24T16:00:00+05:30",
 "p_reason": null}
```
- The visit times are optional; send `null` to claim without one. For an on-site job at `logged` or `revisit_needed`, a visit time moves it to `scheduled`, and the customer sees "Visit booked for Fri 24 Oct, 2:00 pm." For a remote job at `logged`, it moves to `session_booked`.
- A job can already be `scheduled` (or `session_booked`) with a `visit_start` before anyone claims it: the desk agreed a time with the customer. Show that time in the claim screen and send `null` (or the same time) to keep it. A **different** time is stored, the job stays where it is, and the customer sees "Visit moved to Fri 24 Oct, 5:00 pm." (remote: "Remote session moved to …"). Times in these lines are India time.
- The reason is optional and never required, even when the job was requested for someone else. The requested technician sees the claim in the job's history.

Responses:
```json
{"ok": true, "job": { "...": "the full ticket row" }}
{"ok": true, "already": true, "job": { "...": "the full ticket row" }}
{"ok": false, "reason": "taken", "by": "Athul Sudheer", "by_email": "athul.sudheer@neotokyo.in", "at": "2026-10-23T08:59:41+00:00"}
{"ok": false, "reason": "closed"}
{"ok": false, "reason": "not_found"}
```
- `"already": true` means the job is already yours: an earlier tap got through but its answer was lost, or a lead assigned it to you. Treat it as success. A retry after a timeout is therefore safe.
- "Taken" is a normal answer, not an error: two people tapped at once and the other was first. Remove the card and say "Taken by Athul Sudheer". **Never queue a claim offline**: by the time it syncs, someone else has the job.

### 6.3 `service_release(p_job_id, p_reason)` — online only
```json
{"p_job_id": "s_mgx1k2abcde", "p_reason": "Clashes with another visit"}
```
- The reason is required.
- Only the assignee (or a lead) can release, and not while the job is `en_route` or `on_site` (lead only).
- A `scheduled` / `session_booked` job goes back to `logged`, its visit time is cleared, and the customer sees "We're rebooking your visit time." (a remote `session_booked` job: "We're rebooking your remote session."). A job at any other stage keeps its stage; only the assignee is cleared.

Response: `{"ok": true, "job": {…}}`

### 6.4 `service_add_note(p_job_id, p_body, p_visible)` — online only (not idempotent)
```json
{"p_job_id": "s_mgx1k2abcde", "p_body": "Router replaced, old one returned to customer", "p_visible": false}
```
`p_visible: true` publishes the note on the customer's tracking page. Default to `false`, and use `true` only when the technician deliberately ticks "the customer can read this". The response is the new timeline row (`id, job_id, at, kind, body, customer_visible, …`).

To take a note while offline, queue it as a `record_field_activity` with `kind: "note"`, `ref_type: "service_job"` and the job's `ref_id`. That path is idempotent, and the note stays internal.

### 6.5 Photos on a job
1. Upload the image (JPEG, PNG or WebP; HEIC accepted; at most 15 MB; NeoHR should resize to at most 2048 px, JPEG quality 0.85) to the private bucket **`service-media`**, at the path **`<jobId>/<uuid>.jpg`**. The bucket follows the module roles: uploading and reading need a `service` role (desk, tech or lead); only the uploader or a `service` lead can delete a file. (An `rma` role can also read, but not change, the photos recorded on a job's item once that item is sent under warranty claim; this does not affect NeoHR.) Use a fresh UUID per photo and keep it with the queued item, so a retry overwrites nothing and duplicates nothing.
   ```kotlin
   supabase.storage.from("service-media").upload("$jobId/$photoUuid.jpg", bytes) { upsert = false }
   ```
   If the upload fails with "already exists", the earlier attempt succeeded; continue to step 2.
2. Record it (needs `service` desk+, which includes techs). This is a direct insert:
   ```
   POST {URL}/rest/v1/service_media
   Prefer: return=representation
   {"job_id": "s_mgx1k2abcde", "path": "s_mgx1k2abcde/<uuid>.jpg", "phase": "during",
    "role": "during", "remark": "Dust in the PSU fan", "uploaded_by": "<my email>", "uploaded_name": "<my name>"}
   ```
   `role` is one of `condition, damage, during, after, other`. Do not use `invoice`, `serial_label` or `vendor_doc` from NeoHR. `phase` is `intake` (condition or damage), `during` or `after`. Before inserting after a retry, check `GET /rest/v1/service_media?path=eq.<path>&select=id`; if a row exists, do not insert again.
3. Optionally, post `record_field_activity` with `kind: "photo"` and `media_path` set to the same path, so the photo appears in the person's activity log.

Photos are never public. The customer sees one only when desk staff tick "show customer".

### 6.6 `service_tech_list()` — read helper
`{}` →
```json
[{"email": "...", "name": "Athul Sudheer", "designation": "Technician", "role": "tech",
  "open_count": 3, "visits_today": 1, "in_queue_requested": 1}]
```

### 6.7 Other RPCs NeoHR may call
- `service_my_requests()` returns `{"jobs": [...], "rma_units": [...]}`: the jobs and parts the signed-in person raised in the last 60 days.
- `service_create(p)` (raising a request; same payload as the website). Contact the desktop team before using it from NeoHR.

### 6.8 A part pulled on site — `rma_create(p)` with `source: "field"` (online only)
When a technician takes a faulty part out of a customer's machine to send it under warranty, it is logged as a **field pull**. It starts at the RMA stage `with_tech` ("With our technician"; the customer reads "Your part is with our technician") and moves to `received` when the technician hands it in at the counter (the RMA desk does that step in the desktop app). The caller needs a `service` or `rma` role of `desk` or higher; technicians qualify.

```json
{"p": {
  "client_request_id": "0c9e…",
  "source": "field",
  "service_job_id": "s_mgx1k2abcde",
  "holds_ticket": false,
  "notes": "Pulled during the visit",
  "units": [{"kind": "psu", "brand": "Corsair", "model": "RM750", "serial": "RM750-2231-0042",
             "fault": "Shuts off under load", "purchase_source": "elsewhere",
             "data_handling": null}]
}}
```
- `service_job_id` is optional; with it, the part is linked to that job and is tracked with the job customer's phone. Without it, give `owner_name` and `owner_phone` on each unit.
- `holds_ticket: true` makes the job wait for the part (it then moves to `rma_raised` automatically). That is allowed only while the job is in `logged`, `received`, `diagnosing`, `on_site`, `revisit_needed` or one of the RMA stages; otherwise the answer is `NEO_GATE: The ticket is at … Send this part without holding the ticket, or move the ticket back to diagnosing first.`
- The sender is recorded as our technician (the signed-in person); `in_hand` is ignored for field pulls.
- `data_handling` matters for drives (`ssd`, `hdd`): `wiped_by_us`, `customer_consents` or `unreadable_informed`. A drive cannot ship to the vendor until it is set.
- `purchase_source` is `neo_tokyo`, `elsewhere` or `unknown`; `build_ticket_id` (optional) is a build id `t_…` or its 6-character receipt code.
- Idempotent on `client_request_id`; a replay returns the same answer with `"duplicate": true`. Still treat it as **online only**: the counter needs to see the part when it arrives.

Response (units in the order sent):
```json
{"intake_id": "ri_…", "duplicate": false,
 "units": [{"id": "rc_…", "public_code": "RM-7KQ2PX4D", "stage": "with_tech", "kind": "psu",
            "fee_status": "quoted", "handling_fee": 300, "holds_ticket": false, "data_handling": null,
            "serial_matches": []}]}
```
`serial_matches` lists earlier RMAs with the same serial (or that received it as a replacement).

### 6.9 RMA desk RPCs (desktop only, listed so NeoHR never calls them by mistake)
These are for the counter; NeoHR does not call them. Their signatures, for reference:
- `rma_receive(p_case_ids text[], p_note text)` — `logged` or `with_tech` → `received`.
- `rma_dispatch(p_case_ids text[], p_vendor_id bigint, p_mode text, p_courier text, p_awb text, p_cost numeric, p_note text, p_carried_by text)` — `p_mode` is `courier` (needs `p_awb`), `hand_delivery`, `vendor_pickup` or `bus_parcel` (each needs `p_carried_by` or `p_note`).
- `rma_release_hold(p_case_ids text[], p_job_to text, p_outcome text, p_note text, p_return_method text, p_return_address text)` — the job stops waiting for its parts, which go on under their own `RM-` codes. Where the job goes (`p_job_to`) depends on its type:

  | Job | `p_job_to` | Customer sees |
  |---|---|---|
  | in-store (and every job made before this version) | `ready` (with `p_outcome`, normally `returned_rma_pending`) | "Collected; your … is still … — track it as RM-…." |
  | in-store (and every job made before this version) | `in_service` | "Your … is still … — track it as RM-…. It continues on its own." |
  | **on-site** | `work_done` (the part follows later) or `revisit_needed` (we come back to fit it); no outcome | "Your … is still … — track it as RM-…. It continues on its own." |
  | already `closed` | ignored; the job stays closed | only the part's own timeline changes |

  Any other target is refused with `NEO_GATE: Pick where the ticket goes now: …`, and a move while another held part is still on its way with `NEO_RMA_HOLD: This ticket is also waiting on RMA …`. Leaving `p_job_to` out keeps the job where it is; that is refused with `NEO_GATE: Say where the ticket goes now …` while the job waits at `rma_raised`, `at_vendor` or `back_from_vendor` on no other part. A released part is collected later (`p_return_method` `collect`, the default), or couriered back when `p_return_method = 'courier'` with `p_return_address`; `with_device` is refused, because a released part no longer goes back inside the device.
- `rma_vendor_result(…)`, `rma_move(…)`, `rma_set_fee(…)`, `rma_advance_replace(…)`, `rma_claim(…)`, `rma_add_note(…)`.

### 6.10 Device password — `service_get_password(p_job_id)` / `service_set_password(p_job_id, p_secret)` (online only, never cached)
From `sql/service-v2.1.sql`. A customer leaving a device may give its password or PIN, so the technician can sign in. The value lives in `service_secrets`, which has row-level security with no policies and no grants: nobody reads it with a `select`, only through these two functions. `service_jobs.has_device_password` (boolean) says whether one is on file; that flag is safe to show.

- `service_get_password(p_job_id)` → `{"secret": "…", "set_by_name": "Anagha K C", "set_at": "…"}`, or `{"secret": null, …}` when none is on file. Needs a `service` role (desk, tech or lead). **Every call that returns a password writes an internal timeline line "Device password viewed by <name>"**, so call it only when the person taps Show, never to pre-fill or cache. Show it hidden by default, hide it again after 30 seconds, and never write it to Room, a log, a crash report or a notification.
- `service_set_password(p_job_id, p_secret)` saves or changes it (stored exactly as typed, at most 500 characters); an empty or blank `p_secret` removes it. Returns `{"ok": true, "has_device_password": true, "job": {…}}`. Refused with `NEO_GATE` on a closed job.
- Closing a job deletes its password in the same update, however it is closed, and leaves "Device password deleted — ticket closed" on the internal timeline.
- Errors: `NEO_DENIED` without a `service` role, `NEO_GATE` for a missing or closed job or a password over 500 characters.

---

## 7. Offline rules (Room)

| Action | Queue offline? | Why |
|---|---|---|
| `record_field_activity` (all kinds) | **Yes** | idempotent on `client_request_id`; stores device time `at` |
| Photo upload + `service_media` insert | Yes, with the per-photo UUID path and the existence check in §6.5 | |
| `service_claim` | **No** | first come, first served; a stale claim misleads the customer |
| `service_release` | **No** | the job must return to the queue while someone can still take it |
| `service_add_note` | **No** (use a `note` field activity instead) | not idempotent |
| `rma_create` (field pull) | **No** | idempotent, but the counter must see the part when it is handed in |
| `tech_activity` | cache for display only | a report; re-ask when back online |
| Reading the queue | cache for display only, mark it "as of hh:mm" | the queue changes by the minute |
| Reading `v_tech_day` | cache allowed | the only customer data NeoHR may keep on the device; delete a job's cache once it leaves `v_tech_day` (closed or released) |
| `service_get_password` / `service_set_password` | **No**, and never cache the answer | every read is recorded; the password is deleted at close, so a cached copy would outlive it (§6.10) |

Suggested Room table for the outbox:

```kotlin
@Entity(tableName = "outbox")
data class OutboxItem(
    @PrimaryKey val clientRequestId: String,   // UUID v4, never regenerated
    val rpc: String,                           // "record_field_activity"
    val payloadJson: String,                   // the full {"p": {...}} body
    val createdAt: Long,
    val attempts: Int = 0,
    val lastError: String? = null,
    val state: String = "pending"              // pending | done | failed_permanent
)
```

Replay in `createdAt` order, one at a time. Mark `done` on HTTP 200, whether or not the response says `duplicate`. Mark `failed_permanent` on a `NEO_…` error (show it to the user once) and keep it for HR to see. Retry with exponential backoff on network errors, 5xx and timeouts. A device whose clock is wrong still sends its own `at`; the server also stores `received_at`, so HR can spot skew.

A job reassigned while the technician was offline is not an error. Their queued check-in is recorded with `applied: false` and "No change: this ticket is with …". Show it.

---

## 8. Privacy

- The queue (`v_service_queue`) never exposes phone, surname or address, and its location is rounded to about 1 km. Full contact details arrive only after a claim, via `v_tech_day`.
- Location is recorded only on the explicit events a technician posts (check-in, check-out, punch). There is no continuous tracking, and NeoHR must not add any.
- Technicians' home addresses belong in NeoHR's own storage, never in these tables.
- What the database allows is wider than what NeoHR should show. Row-level security lets any `service` desk+ member read every ticket, because the desktop board needs that. NeoHR should still read only the views above, so a phone app never holds more customer data than the person's own day needs.
- Who can read the activity log: the person, any `service` lead, any `neohr` lead, and tier 3+ (owner, founders, department heads). HR staff below tier 3 need a `neohr` lead role (Settings → Module access).
- A customer's tracking page never shows a distributor's name: it names the part's brand (or the vendor's public name).

---

## 9. Stage vocabulary NeoHR will meet

On-site jobs: `logged` → `scheduled` → `en_route` → `on_site` → `work_done`, with `revisit_needed`, `parts_to_order`, `parts_on_order`, `quoted`, `approved` and `closed` along the way. While a part is away under warranty claim, the server alone sets `rma_raised`, `at_vendor` or `back_from_vendor`; when the desk releases the part from an on-site job (§6.9), the job jumps from there to `work_done` or `revisit_needed`. Remote jobs use `logged` → `session_booked` → `in_session` → `resolved` → `closed`.

| stage | staff label |
|---|---|
| logged | Logged — not in hand yet |
| scheduled | Visit scheduled |
| en_route | Technician en route |
| on_site | On site |
| work_done | Work done — awaiting sign-off |
| revisit_needed | Revisit needed |
| session_booked | Remote session booked |
| in_session | In remote session |
| resolved | Resolved remotely — confirming |
| parts_to_order | Parts to order |
| rma_raised / at_vendor / back_from_vendor | RMA raised — not shipped yet / At vendor / Back from vendor |
| closed | Closed |

RMA parts (`rma_cases.stage`, returned by `rma_create`): a field pull starts at `with_tech`, then the counter takes it to `received`, and it goes on through `testing`, `awaiting_docs`, `ready_to_ship`, `with_vendor`, `back_from_vendor`, `customer_decision`, `ready_to_return`, `returning` and `closed`. A part a customer is still to bring in is `logged`.

| RMA stage | staff label | customer label |
|---|---|---|
| with_tech | With our technician | Your part is with our technician |
| logged | Expected — not in hand | We're expecting your part |
| received | Received | Your part is with us |
| with_vendor | With vendor | With the manufacturer under warranty |
| returning | Returning by courier | On its way back to you |
| closed | Closed | (from how it ended) |

---

## 10. Changes to this contract

Additive changes (a new column, a new optional field, a new RPC) can ship at any time, so NeoHR must ignore unknown JSON keys. Removing or renaming anything here means a new contract version and a note in this file first.

### Version 2.1 (additive, `sql/service-v2.1.sql`)
- The shop never backs up customer data. `service_jobs.data_consent` now records what the customer did: `customer_backed_up` ("Customer backed up their data"), `no_important_data` ("No important data on it") or `customer_accepts_risk` ("Customer accepts the risk — no backup"). The older `backup_ok` / `no_backup` stay valid on old jobs; show them as "Back up first (old option)" / "No backup needed (old option)" and never offer them. `has_customer_data` is true unless the answer is `no_important_data`.
- New: `service_jobs.has_device_password` and the device-password RPCs `service_get_password` / `service_set_password` (§6.10). Every read is recorded on the job's internal timeline; the password is deleted when the job closes.
- Unchanged: `v_service_queue`, `v_tech_day`, `get_service_public` (the customer's page never mentions a password).

### Version 2 (this file)
- The view `v_tech_activity` is gone. Use the RPC `tech_activity(p_from, p_to)` (§5.3); same keys, plus a date range. A `neohr` lead now sees everyone's activity, in `tech_activity` and in `field_activity`.
- Phone numbers keep their country code (`919847012345`, `971501234567`) instead of being cut to 10 digits; a leading `00` is dropped, and 11-digit Kuwait / Oman / Bahrain / Qatar numbers are valid (§4).
- `service_claim` at a different time than the one already booked tells the customer the visit moved (§6.2).
- `rma_release_hold` on an on-site job goes to `work_done` or `revisit_needed` (§6.9, §9).
- `record_field_activity`: a check-out from `scheduled` / `en_route` finishes the visit and counts it (§6.1).
- `record_field_activity`: `departed` + `customer_absent` moves the job to `revisit_needed` (not `scheduled`), clears the spent visit time and tells the customer we will call to rebook (§6.1).
- Who has a job changes only through `service_claim` / `service_release` (and a lead's `service_assign`); a direct write of `assignee` / `assignee_email` is refused for anyone but a lead. Timeline rows written directly (not through an RPC) may only be kinds `stage`, `note`, `edit`, `media`, with no `meta`, in the signed-in person's own name — claim, release and assign rows (which `tech_activity` counts) come only from the RPCs.
- Files in the `service-media` bucket need a `service` role, not just a staff account (§6.5).
- `service_claim`: a claim of a job that is already yours answers `{"ok": true, "already": true, …}`; the reason is never required (§6.2).
- New: field pulls through `rma_create` with `source: "field"`, starting at the RMA stage `with_tech` (§6.8).
- `rma_dispatch` takes `p_mode` and `p_carried_by` (§6.9; desktop only).
