# NeoHR data contract

**Contract version:** 3.1. It comes from the database migrations `service_v2_rma` (`sql/service-v2.sql`), `service_v2_1_secrets` (`sql/service-v2.1.sql`) and `work_queue_v2_2` (`sql/work-queue.sql`). Version 3.1 (NeoHR 2.1, additive) adds the simplified dashboard, the technician's job detail, moves, photos and RMA parts from the phone, and the NeoHR update manifest (§10). Version 3 adds the work queue for builds and service (§8), synced work logs (§9) and sign-in over plain REST (§8.1); version 2 replaced the `v_tech_activity` view with the `tech_activity` RPC and changed phone normalisation, check-out handling, claim retries and re-timed claims. See §13 for the lists.
**Audience:** the Android (Kotlin) developer turning *Daily Logger* (today a local-only Room/SQLite app) into **NeoHR**. NeoHR talks to the same Supabase project as the Neo Tokyo desktop app and website.

This file is the only promise the server makes to NeoHR. Everything listed here exists in the database once `service_v2_rma` is applied. Anything not listed (tables, columns, other RPCs) may change without notice, so NeoHR must not read or write it.

---

## 1. What NeoHR does with this

| NeoHR feature | Server surface |
|---|---|
| Sign in as a staff member | Supabase Auth (email + PIN) over REST (§8.1), then `my_work_profile()` (§8.2) |
| The work queue: offers to me, open builds and service jobs, my work | RPCs `work_queue`, `work_tick` (§8.3, §8.4) |
| Claim, accept or decline an offer, hand back | RPCs `work_claim`, `work_respond`, `work_release` (§8.5–§8.7) |
| Leads: offer work to someone, see the team, dismiss alerts | RPCs `work_offer`, `work_team`, `work_alert_resolve` (§8.8, §8.9) |
| "Open jobs near me" (the queue) | view `v_service_queue` |
| Take a job, optionally with a visit time | RPC `service_claim` |
| Hand a job back | RPC `service_release` |
| "My day" (claimed jobs with address and phone) | view `v_tech_day` |
| Left shop / Checked in / Checked out | RPC `record_field_activity` (kinds `left_base`, `arrived`, `departed`) |
| Attendance punch in / out | RPC `record_field_activity` (kinds `punch_in`, `punch_out`) |
| Daily work-log entries (the Daily Logger feature) | RPCs `work_log_push`, `work_log_pull`; tier 3+ `work_log_team` (§9). (Version 2's `record_field_activity` with `ref_type` `work_log` still records, but is no longer how logs sync.) |
| Notes on a job | RPC `service_add_note` |
| Photos on a job | Storage bucket `service-media` + table `service_media` |
| HR / manager activity report | RPC `tech_activity`, table `field_activity` |
| Technician picker | RPC `service_tech_list` |
| A part pulled from a customer's machine on site | RPC `rma_create` with `source: "field"` (§6.8) |
| The Dashboard tab (simplified, by what the person may read) | RPC `neo_dashboard` (§10.1) |
| A service job's detail: items, timeline, move, note, photos, device password | `v_tech_day`, `service_items`, `service_events`, `service_move`, `service_add_note`, bucket `service-media` + `service_media`, `service_get_password` (§10.2–§10.4) |
| A build's detail; my RMA parts | `tickets` (named columns only), `rma_cases` (§10.2) |
| "Update available — NeoHR x.y.z" | GitHub Releases + `neohr.json` (§10.5) |

Daily Logger's local Room database stays the source of truth for the person's own log while offline. The server receives an idempotent copy (see §6).

---

## 2. Connection and authentication

- **Project URL:** `https://ggsxkhenzdhaachubrsc.supabase.co`
- **Key:** the project's *publishable* (anon) key, the same one the website uses. Ask the owner for it. It is public by design and safe to ship in the APK; every table is protected by row-level security.
- **Never** put the `service_role` / `sb_secret_…` key in the app or in any NeoHR backend that acts for a user. It bypasses every rule in this document.

### Sign-in
NeoHR 2.1 (contract version 3) signs in over plain REST with OkHttp — the exact requests and answers, refresh and sign-out are in §8.1. The SDK example below is kept for reference.

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
- Everyone else gets roles from the `module_access` table. Tier 4+ set the `service`, `rma`, `qc` and (contract 3.1) `neohr` roles in the desktop app under Settings → General → People (in the Operations section; it saves through the desktop-only RPC `staff_update`, whose `roles` take `service`, `rma`, `qc` and `neohr`). A designation preset sets `service`, `rma` and `qc` only and never touches `neohr`. `module_access_set({"p_email": "…", "p_module": "neohr", "p_role": "lead"})` still works too.
- Modules: `service`, `rma`, `qc`, `neohr`. The server checks the `neohr` role for one thing: a `neohr` **lead** (HR; tier 3+ are leads automatically) sees everyone's activity and logs — `tech_activity`, `field_activity`, `work_log_team`, `work_logs`, and the team (`work_team`, without the items and alerts of kinds they do not lead); `my_work_profile.team_view` is `true` for them. Other `neohr` uses are reserved for NeoHR's own features.

### `my_modules()` — call once after sign-in, then cache
```
POST {URL}/rest/v1/rpc/my_modules
{}
```
```json
{"service": "tech", "rma": "tech", "qc": "tech", "neohr": null, "tier": 2,
 "build_pool": true, "service_pool": true, "build_level": "junior"}
```
Version 3 added `build_pool`, `service_pool` (booleans) and `build_level` (`"junior"`, `"senior"` or `null`): the person's work pools (§8). They are `false` / `null` for anyone who is not active staff. NeoHR mostly needs `my_work_profile()` (§8.2), which carries all of this.

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
| Read everyone's work logs and the team | `neohr` role `lead`, or tier 3+ |

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
- **Version 3:** the caller must be in the service pool (`NEO_GATE: You aren't in the service pool.`). A job with a live offer to someone else answers `{"ok": false, "reason": "offered", "by": "Adhil M", "by_email": "adhil.m@neotokyo.in", "to_name": "Adhil M", "expires_at": "…"}` and changes nothing; a job offered to the caller is accepted (§8.6, with `job`). New NeoHR builds use `work_claim` (§8.5), which answers the same plus `item`.

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
**Contract 3.1:** NeoHR 2.1 uploads exactly as Neo OS does — path `<jobId>/<base36 time>-<8 random>.jpg`, the full `service_media` row and the clean-up on failure are in §10.4, which replaces the path below (the bucket accepts both). NeoHR 2.1 adds photos **online only**, with a new path for every attempt. The advice below about keeping the path with a queued item and checking for an existing row before a retry applies only to a future offline queue (§10.4, last paragraph).

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
  "open_count": 3, "visits_today": 1, "in_queue_requested": 1,
  "service_pool": true, "build_pool": true, "build_level": "junior", "points": 2, "jobs": 1, "capacity_points": 5, "max_jobs": 3}]
```
Version 3: only active staff with a service role of `tech` or `lead` **and** the service pool are listed (tier 3+ are no longer listed just for being leads). `points` / `jobs` are what they hold now (open items plus live offers), against `capacity_points` / `max_jobs`.

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
| Photo upload + `service_media` insert | **No** in NeoHR 2.1 (nor in Neo OS): online only, a new path for every attempt (§10.4) | a failure goes back to the person, who adds the photo again; a later version may queue it (§10.4, last paragraph) |
| `service_claim` | **No** | first come, first served; a stale claim misleads the customer |
| `service_release` | **No** | the job must return to the queue while someone can still take it |
| `service_add_note` | **No** (use a `note` field activity instead) | not idempotent |
| `rma_create` (field pull) | **No** | idempotent, but the counter must see the part when it is handed in |
| `tech_activity` | cache for display only | a report; re-ask when back online |
| Reading the queue | cache for display only, mark it "as of hh:mm" | the queue changes by the minute |
| Reading `v_tech_day` | cache allowed | the only customer data NeoHR may keep on the device; delete a job's cache once it leaves `v_tech_day` (closed or released) |
| `service_get_password` / `service_set_password` | **No**, and never cache the answer | every read is recorded; the password is deleted at close, so a cached copy would outlive it (§6.10) |

The work-queue actions (§8) follow the same rule: only `record_field_activity` is queued; `work_claim`, `work_respond`, `work_release` and `work_offer` are online only (§8.11). Work logs sync by their own rules (§9).

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

## 8. Work queue (contract version 3, `sql/work-queue.sql`)

One queue holds every PC build that is waiting for a builder and every service ticket that is waiting for a technician. People in the pool claim what suits them. An item that nobody claims within **4 hours** is offered by the server to the best free person; an offer — from the app or from a lead — must be accepted within **30 minutes**. Declining (with a reason) or not answering ends the offer, skips that person for this item and alerts the leads; once the 4 hours are up, the next best person gets the offer. Builds of tier 4–5 are for senior builders only.

The phone talks to the server with plain HTTPS (OkHttp): Supabase Auth for the session, PostgREST for everything else. Every example below is a real answer of the RPC, shortened only where it says `…`.

### 8.1 Sign-in, refresh, sign-out (Supabase Auth over REST)

```
POST {URL}/auth/v1/token?grant_type=password
apikey: <anon key>
Content-Type: application/json

{"email": "athul.sudheer@neotokyo.in", "password": "<PIN>"}
```
`200`:
```json
{"access_token": "eyJhbGciOi…", "token_type": "bearer", "expires_in": 3600, "expires_at": 1761126000,
 "refresh_token": "v1.MjAyNi…", "user": {"id": "b115a7bf-7d5f-4c9e-9f2a-165aea55159a", "email": "athul.sudheer@neotokyo.in", "…": "…"}}
```
- Keep `access_token`, `refresh_token`, `expires_at` (Unix seconds), `user.id` and `user.email` in the `neo_auth` DataStore (never in Room). Ignore every other key.
- A wrong email or PIN answers `400`. Depending on the Auth version the body is `{"error": "invalid_grant", "error_description": "Invalid login credentials"}` or `{"code": 400, "error_code": "invalid_credentials", "msg": "Invalid login credentials"}`: read `error_code` / `error`, then `msg` / `error_description`, and show **"Wrong email or PIN."** for any `400` from this call.

Refresh (when fewer than 60 s are left, or once after a `401`):
```
POST {URL}/auth/v1/token?grant_type=refresh_token
apikey: <anon key>
Content-Type: application/json

{"refresh_token": "v1.MjAyNi…"}
```
The answer has the same shape as sign-in, with a **new** `refresh_token` (each refresh token works once). A `400` / `401` here means the session is over — but only if the token you sent is still the stored one (another caller may have refreshed a moment ago; re-read `neo_auth` first). A network failure is "offline", never "signed out".

Sign-out of this phone only:
```
POST {URL}/auth/v1/logout?scope=local
apikey: <anon key>
Authorization: Bearer <access_token>
```
`204` with no body. A `401` means the session had already ended: treat it as signed out.

Every RPC is then:
```
POST {URL}/rest/v1/rpc/<name>
apikey: <anon key>
Authorization: Bearer <access_token>
Content-Type: application/json

{ named arguments, or {} }
```
The answer body is the function's JSON value itself. Errors are PostgREST's body (§4): `{"code": "P0001", "message": "NEO_GATE: Say why you can't take it.", "details": null, "hint": null}` with HTTP `400`; strip the `NEO_…: ` prefix for display.

### 8.2 `my_work_profile()` — right after sign-in, cached for offline start
`{}` →
```json
{"id": "b115a7bf-7d5f-4c9e-9f2a-165aea55159a", "email": "athul.sudheer@neotokyo.in", "full_name": "Athul Sudheer",
 "designation": "Service Engineer", "department": "service", "tier": 2,
 "modules": {"service": "tech", "rma": "tech", "qc": "tech", "neohr": null, "tier": 2,
             "build_pool": true, "service_pool": true, "build_level": "junior"},
 "build_pool": true, "service_pool": true, "build_level": "junior", "capacity_points": 5, "max_jobs": 3,
 "team_view": false, "lead_builds": false, "lead_service": false, "desk_builds": true, "desk_service": true,
 "home": "work"}
```
| Key | Use |
|---|---|
| `home` | `"work"` exactly when `work_queue()` will answer (Builds or Service desk and up); otherwise `"logs"`. A pool flag never selects `work` on its own. |
| `team_view` | tier 3+ or a `neohr` lead (contract 3.1): show the Team tab and everyone's logs (`work_log_team`). |
| `lead_builds` / `lead_service` | may offer items of that kind (`work_offer`) and sees that kind's alerts. |
| `desk_builds` / `desk_service` | reads items of that kind in the queue. |
| `build_pool`, `service_pool`, `build_level` | the person's own work settings (`build_level`: `"junior"`, `"senior"` or `null`). |
| `capacity_points`, `max_jobs` | how much they may hold (defaults applied). |

`NEO_DENIED: Sign in with an active staff account to do this.` means the login exists but is not (or no longer) active staff: show "This account isn't set up as staff yet. Ask the owner.", keep the app in logs-only mode and do not sync.

`my_modules()` (§3) also carries `build_pool`, `service_pool` and `build_level` now.

### 8.3 `work_queue()` — the feed
`{}` →
```json
{"now": "2026-10-22T08:58:18.347+00:00", "claim_hours": 4, "offer_minutes": 30,
 "me": {"email": "athul.sudheer@neotokyo.in", "name": "Athul Sudheer", "designation": "Service Engineer", "tier": 2,
        "build_pool": true, "service_pool": true, "build_level": "junior", "capacity_points": 5, "max_jobs": 3,
        "points": 2, "jobs": 1, "lead_builds": false, "lead_service": false, "desk_builds": true, "desk_service": true},
 "items": [
  {"kind": "service", "id": "s_mvjb6hjraugjf", "code": "NT-6V6KTW7J", "title": "Networking", "sub": "On-site · Networking",
   "customer": "Ravi", "area": "Kakkanad", "service_type": "on_site", "stage": "logged", "priority": "normal",
   "build_tier": null, "needs_senior": false, "deadline": null,
   "queued_at": "2026-10-22T08:58:18.318+00:00", "claim_due": "2026-10-22T12:58:18.318+00:00", "cost": 2,
   "assignee_email": null, "assignee_name": null, "assigned_via": null, "assigned_at": null,
   "offer": {"to_email": "athul.sudheer@neotokyo.in", "to_name": "Athul Sudheer", "kind": "manager", "by_name": "Jophy Joseph",
             "reason": "Closest to Kakkanad", "offered_at": "2026-10-22T08:58:18.337+00:00", "expires_at": "2026-10-22T09:28:18.337+00:00"},
   "declined_count": 0, "mine": false, "offered_to_me": true, "can_claim": true, "why_not": null},
  {"kind": "build", "id": "t_wqlegacy_queued", "code": "QUEUED", "title": "Legacy Waiting Build", "sub": "Ryzen 5 7600 · RTX 4060",
   "customer": "Legacy Waiting Build", "area": null, "service_type": null, "stage": "awaiting", "priority": "normal",
   "build_tier": 1, "needs_senior": false, "deadline": null,
   "queued_at": "2026-10-22T03:58:18.309+00:00", "claim_due": "2026-10-22T07:58:18.309+00:00", "cost": 1,
   "assignee_email": null, "assignee_name": null, "assigned_via": null, "assigned_at": null,
   "offer": null, "declined_count": 0, "mine": false, "offered_to_me": false, "can_claim": true, "why_not": null}],
 "alerts": []}
```
`NEO_DENIED: The work queue is for the build and service teams.` when the caller is neither Builds nor Service desk+ (then `home` was `"logs"`).

**Which items:** every open item of the kinds the caller may read (builds need Builds desk+, service needs Service desk+), every item with a live offer to the caller, every open item assigned to the caller, and — for a lead of that kind — every item with a live offer to anyone. **Order** (keep it): offered to me (soonest expiry first), then open (`claim_due` ascending), then mine (`deadline` ascending), then the rest.

| ITEM key | Meaning |
|---|---|
| `kind` | `"build"` or `"service"` — pass it back as `p_kind` |
| `id` | `t_…` (build) or `s_…` (service ticket) — pass it back as `p_id` |
| `code` | what people say: the build's last 6 characters, or the `NT-` code |
| `title`, `sub` | build: customer name, `cpu · gpu`; service: device (or category), `type · category` |
| `customer` | a **first name only** for a pure technician until the job is theirs; desk and leads see the whole name. Never a phone or an address (`area` only) — after a claim, read the job from `v_tech_day` (§8.10). |
| `stage` | build `status` (`awaiting`, `building`, `waiting_qc`, `qc_testing`) or service `stage` (§12) |
| `priority` | builds: `urgent` when the deadline is less than 48 h away, else `normal`; service: the ticket's priority |
| `build_tier`, `needs_senior` | builds: 1–5; `true` for tier 4–5 |
| `deadline` | builds: the deadline; service: the visit start, else the needed-by date |
| `queued_at`, `claim_due` | when it entered the queue; `queued_at + 4 h` (only while it is open) |
| `cost` | load points: a build's tier; an on-site visit 2; other service 1 |
| `assignee_email`, `assignee_name`, `assigned_via`, `assigned_at` | who has it (`assigned_via`: `claim`, `manager`, `auto`, `legacy`, `self`) |
| `offer` | `null`, or the live offer (`kind`: `manager` = a lead, `auto` = the app). An expired offer reads `null`. |
| `declined_count` | how many people declined or ignored it this cycle |
| `mine`, `offered_to_me` | it is mine / it is offered to me now |
| `can_claim` | show **Claim** (an item offered to me is claimable: claiming = accepting) |
| `why_not` | otherwise, the sentence to show instead (below), or `null` |

`why_not` sentences (exact): "You don't have the Builds technician role." · "You don't have the Service technician role." · "You aren't in the build pool." · "You aren't in the service pool." · "This is a high-value build — only senior builders can take it." · "Offered to Athul Sudheer until 14:58." (India time).

`alerts` (leads only, of the kinds they lead, newest first, at most 50):
```json
[{"id": 1, "kind": "declined", "item_kind": "service", "item_id": "s_mvjb6hjraugjf", "item_code": "NT-6V6KTW7J",
  "title": "Networking", "body": "Adhil M declined NT-6V6KTW7J: Two visits already today", "person_name": "Adhil M",
  "created_at": "2026-10-22T08:58:18.404+00:00"}]
```
`kind`: `declined` (also "Offer to X ended — …" when the person was no longer eligible), `expired` ("No answer from X on CODE in 30 minutes."), `no_candidate` ("Nobody free can take CODE — offer it to someone or wait for room.").

**Clock skew.** Count down from the server's clock, not the phone's: `offsetMs = Date.parse(now) − (device time when the answer arrived)`; every countdown uses `device now + offsetMs`. Never print "30 minutes": say "accept by HH:MM (Xm left)" from `offer.expires_at`.

### 8.4 `work_tick()` — run the clock
`{}` → `{"ok": true, "expired": 0, "offered": 0, "stuck": 0}` (or `{"ok": true, "skipped": true}` when another tick is running). Call it, fire-and-forget, before each `work_queue()` refresh; it ends overdue offers and offers overdue items. Any active staff member may call it; ignore its errors.

### 8.5 `work_claim(p_kind, p_id, p_visit_start, p_visit_end)` — online only
```json
{"p_kind": "build", "p_id": "t_wqlegacy_queued", "p_visit_start": null, "p_visit_end": null}
```
Visit times are for service tickets only (as `service_claim`, §6.2); they are ignored for builds. Answers:
```json
{"ok": true, "item": {"kind": "build", "id": "t_wqlegacy_queued", "mine": true, "assigned_via": "claim", "assignee_name": "Adhil", "…": "…"}}
{"ok": true, "already": true, "item": {…}}
{"ok": false, "reason": "taken", "by": "Adhil", "by_email": "adhil.m@neotokyo.in", "at": "2026-10-22T08:58:18.383+00:00"}
{"ok": false, "reason": "offered", "by": "Athul Sudheer", "to_name": "Athul Sudheer", "expires_at": "2026-10-22T09:28:18.337+00:00"}
{"ok": false, "reason": "not_queued"}
{"ok": false, "reason": "closed"}
{"ok": false, "reason": "not_found"}
```
- Service: the answer is `service_claim`'s (§6.2, including `"job"` on success) plus `"item"` (on every answer about a ticket that exists). Its `offered` also carries `"by_email"`.
- `taken` / `offered` are normal answers: refresh and say "Taken by X" / "Offered to X until HH:MM".
- `not_queued`: a build not sent to the floor (a quote) — refresh.
- If an offer to the caller is live, claiming accepts it (the answer is §8.6's).
- Errors: `NEO_GATE:` + one of the `why_not` sentences when the caller may not take it (e.g. "NEO_GATE: You aren't in the service pool.").

### 8.6 `work_respond(p_kind, p_id, p_accept, p_reason, p_visit_start, p_visit_end)` — online only
Accept (on-site / remote: an optional visit time, as §6.2):
```json
{"p_kind": "service", "p_id": "s_mvjb6hjraugjf", "p_accept": true, "p_reason": null,
 "p_visit_start": "2026-10-23T14:30:00+05:30", "p_visit_end": "2026-10-23T16:30:00+05:30"}
```
```json
{"ok": true, "item": {"kind": "service", "id": "s_mvjb6hjraugjf", "mine": true, "stage": "scheduled", "assigned_via": "manager", "customer": "Ravi Kumar", "…": "…"},
 "job": { "...": "the full ticket row (service only)" }}
```
Decline (a reason is required, at most 300 characters):
```json
{"p_kind": "service", "p_id": "s_mvjb6hjraugjf", "p_accept": false, "p_reason": "Two visits already today"}
```
```json
{"ok": true, "declined": true, "next": null, "item": {…}}
```
`next` is the app's next offer when the item was already past its 4 hours (`{"offered": true, "to_email": …, "to_name": …, "expires_at": …}` or `{"offered": false, "stuck": true, "alerted": true|false}`), else `null`.

Other answers:
```json
{"ok": false, "reason": "expired"}
{"ok": false, "reason": "not_offered"}
{"ok": false, "reason": "not_eligible", "why": "This is a high-value build — only senior builders can take it.", "next": null}
{"ok": false, "reason": "not_found"}
```
`expired`: the offer to you ended (you are on this item's declined list) — remove the card. `not_offered`: nothing is offered to you here. `not_eligible`: you can no longer take it (the build became tier 4–5, or your pool or role changed); the offer has ended — show `why`. Errors: `NEO_GATE: Say why you can't take it.`, `NEO_GATE: The visit ends before it starts.`

### 8.7 `work_release(p_kind, p_id, p_reason)` — online only
```json
{"p_kind": "build", "p_id": "t_wqlegacy_queued", "p_reason": "Parts not here yet"}
```
```json
{"ok": true, "item": {"kind": "build", "id": "t_wqlegacy_queued", "mine": false, "claim_due": "2026-10-22T12:58:18.391+00:00", "declined_count": 1, "…": "…"}}
```
Service: every rule of `service_release` (§6.3) applies and its `"job"` is in the answer too. The person handing it back is not offered it again in this cycle. Errors: `NEO_GATE: Say why you're handing it back.`, `NEO_GATE: The reason is too long — keep it under 300 characters.`, `NEO_STALE: Nobody has this build now — refresh.`, `NEO_DENIED: Only the technician who has this build, or a lead, can hand it back.`, `NEO_GATE: This build is finished.`, and §6.3's for service (for example `NEO_GATE: You're on the way or on site. Check out first, or ask a lead to reassign it.`).

### 8.8 `work_offer(p_kind, p_id, p_email, p_reason, p_expected)` — leads, online only
`p_expected` is the assignee email the lead's screen showed (`null` = it showed the item unassigned). An empty `p_email` withdraws the live offer. After a withdrawal the server waits at least 10 minutes before it offers the item again by itself, so "withdraw, then offer to someone else" is never beaten by the clock. Withdrawing the app's own offer (`kind` `auto`) also skips that person for the item; a lead can still offer it to them by name.
```json
{"p_kind": "service", "p_id": "s_mvjb6hjraugjf", "p_email": "athul.sudheer@neotokyo.in", "p_reason": "Closest to Kakkanad", "p_expected": null}
```
```json
{"ok": true, "item": {"offer": {"to_email": "athul.sudheer@neotokyo.in", "kind": "manager", "expires_at": "…", "…": "…"}, "…": "…"}}
{"ok": true, "unchanged": true, "item": {…}}
{"ok": true, "withdrawn": true, "item": {…}}
{"ok": true, "withdrawn": false, "item": {…}}
{"ok": false, "reason": "changed", "by": "Athul Sudheer", "by_email": "athul.sudheer@neotokyo.in", "at": "2026-10-22T08:58:18.374+00:00"}
{"ok": false, "reason": "offered", "to_name": "Adhil M", "expires_at": "2026-10-22T09:28:18.398+00:00"}
```
`changed`: someone took or changed it since the screen loaded — refresh. `offered`: someone else holds a live offer — withdraw it first. An item that someone holds can be offered to someone else (a reassignment): the holder keeps it until the target accepts. Errors: `NEO_DENIED: Only a lead can offer work to a technician.`, `NEO_GATE: Say why you're offering it to them.`, `NEO_GATE: This one is finished.`, `NEO_GATE: No active staff account with that email.`, `NEO_GATE: Adhil M can't take this — they aren't in the build pool.` (and the other `why_not` reasons, said of them).

### 8.9 `work_team()` — leads, `neohr` leads and tier 3+
`{}` →
```json
{"now": "2026-10-22T08:58:18.413+00:00",
 "people": [{"email": "adhil.m@neotokyo.in", "name": "Adhil M", "designation": "Senior System Integrator / Service Engineer", "tier": 2,
             "build_pool": true, "service_pool": true, "build_level": "senior", "capacity_points": 8, "max_jobs": 5,
             "points": 2, "jobs": 1, "qc_role": "tech", "service_role": "tech",
             "items": [{"kind": "build", "id": "t_wqlegacy_adhil1", "code": "ADHIL1", "title": "Legacy Adhil Build", "stage": "building",
                        "deadline": null, "assigned_at": "2026-10-21T08:58:18.054+00:00", "cost": 2}],
             "offers": [{"kind": "service", "id": "s_…", "code": "NT-…", "title": "…", "expires_at": "…", "offer_kind": "auto"}],
             "last_seen_at": "2026-10-22T08:40:02+00:00", "logs_today": 3}],
 "alerts": [ "…as in work_queue…" ]}
```
People: everyone active who is in a pool or holds work or a live offer, by name. `items`, `offers` and `alerts` list only the kinds the caller leads. `last_seen_at` (the latest field activity or work log) and `logs_today` (India day) are `null` unless the caller is tier 3+ or a `neohr` lead. A `neohr` lead who leads no kind of work (HR) gets the people with empty `items` / `offers` and no `alerts` (contract 3.1). `NEO_DENIED: Only leads can see the team.` for anyone else. To dismiss an alert: `work_alert_resolve({"p_id": 1})` → `{"ok": true}` (or `{"ok": true, "already": true}`).

### 8.10 My work on site — `v_tech_day` and `record_field_activity`
For each of the caller's own **service** items, read the contact and site details from the view (§5.2), in memory only — never in Room:
```
GET {URL}/rest/v1/v_tech_day?id=eq.s_mvjb6hjraugjf&select=*
```
```json
[{"id": "s_mvjb6hjraugjf", "public_code": "NT-6V6KTW7J", "service_type": "on_site", "stage": "scheduled", "category": "networking",
  "customer_name": "Ravi Kumar", "customer_phone": "9000000501", "site_address": "12 MG Road", "site_area": "Kakkanad",
  "site_landmark": null, "site_maps_url": null, "site_lat": null, "site_lng": null, "site_contact": null,
  "visit_start": "2026-10-23T08:58:18.374+00:00", "visit_end": "2026-10-23T10:58:18.374+00:00", "visit_count": 0,
  "reported_fault": "No internet", "assigned_via": "manager", "assigned_at": "2026-10-22T08:58:18.374+00:00", "…": "…"}]
```
**Left shop / Arrived / Finished** are `record_field_activity` (§6.1) with `kind` `left_base`, `arrived`, `departed` (+ `outcome` `done`, `revisit_needed`, `parts_needed` or `customer_absent`):
```json
{"p": {"client_request_id": "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d", "kind": "left_base", "ref_type": "service_job",
       "ref_id": "s_mvjb6hjraugjf", "module": "service", "at": "2026-10-24T08:30:00.000Z",
       "lat": 10.0159, "lng": 76.3419, "accuracy_m": 12.5, "source": "neohr"}}
```
```json
{"id": "63a2386a-8d89-495b-b9ce-86a7e86b0403", "applied": true, "applied_note": "Moved to Technician en route.", "stage": "en_route", "duplicate": false}
```
Generate `client_request_id` once per tap, keep it (with the payload, **including `at` = the time of the tap**) in `pending_field_actions` until the server answers, and retry with the same id. This is the only queue-related write that may be queued offline.

### 8.11 Offline rules for the queue
| Action | Queue offline? |
|---|---|
| `work_claim`, `work_respond`, `work_release`, `work_offer`, `work_alert_resolve` | **No** — online only; show the server's answer |
| `record_field_activity` | Yes (idempotent on `client_request_id`, carries `at`) |
| `work_tick` | No — skip it when offline |
| `work_queue`, `work_team`, `my_work_profile` | Cache the last answer for display only, marked "as of HH:MM" |

`service_claim` from older apps now also needs the service pool and refuses an item offered to someone else (§6.2); the phone uses `work_claim`.

---

## 9. Work logs (contract version 3)

Daily Logger entries sync to `public.work_logs`. Room stays the source of truth on the phone; the server keeps a copy per person, so the logs survive a new phone and tier 3+ can read everyone's. Photos are **not** synced in this release (they stay on the phone).

### 9.1 Shapes and timestamps
- Timestamps are ISO-8601 **UTC with milliseconds**, made from the phone's epoch millis: `2026-10-21T04:01:12.000Z`. The server answers in `+00:00` form.
- `id` is the log's `remoteId`: a UUID v4 the phone creates once per log and never changes.
- An **upsert row**: `{"id", "title", "description", "category", "location_name", "latitude", "longitude", "created_at", "updated_at", "deleted": false}`.
- A **delete row**: `{"id", "updated_at", "deleted": true}` — nothing else is read.

| Field | Rule |
|---|---|
| `title` | trimmed, 1–300 characters |
| `description` | up to 5000 characters, or `null` |
| `category` | 1–60 characters; blank or missing reads `"Work"` |
| `location_name` | up to 200 characters, or `null` |
| `latitude`, `longitude` | both or neither; a value out of range drops both (the row is kept) |
| `created_at`, `updated_at` | required, between 2020-01-01 and the server's now + 10 minutes, else the row is rejected with `clock` |

### 9.2 `work_log_push(p_rows)` — any active staff member
At most 200 rows per call (send in batches of 100).
```json
{"p_rows": [
  {"id": "0b7d6a52-1f3e-4c1a-9d2e-5a6b7c8d9e0f", "title": "Re-cabled the office switch", "description": "Two ports dead",
   "category": "Networking", "location_name": "Kakkanad", "latitude": 10.0159, "longitude": 76.3419,
   "created_at": "2026-10-21T04:01:12.000Z", "updated_at": "2026-10-21T04:01:12.000Z", "deleted": false},
  {"id": "1c8e7b63-2a4f-4d2b-8e3f-6b7c8d9e0f1a", "updated_at": "2026-10-21T05:00:00.000Z", "deleted": true},
  {"id": "not-a-uuid", "title": "x", "created_at": "2026-10-21T04:01:12.000Z", "updated_at": "2026-10-21T04:01:12.000Z"}]}
```
```json
{"ok": true, "accepted": ["0b7d6a52-1f3e-4c1a-9d2e-5a6b7c8d9e0f", "1c8e7b63-2a4f-4d2b-8e3f-6b7c8d9e0f1a"], "stale": [],
 "rejected": [{"id": "not-a-uuid", "reason": "invalid"}]}
```
The ids come back exactly as sent. Per row:
| Case | Answer |
|---|---|
| new id | inserted for the caller → `accepted` |
| own row, incoming `updated_at` newer | updated (a non-deleted row also clears an earlier delete) → `accepted` |
| own row, incoming `updated_at` equal or older | nothing changes → `stale` |
| delete of an own row, newer | tombstoned (`deleted_at` = that time) → `accepted`; older → `stale` |
| delete of an id the server never saw | nothing to do → `accepted` |
| an id that belongs to someone else (or to a login that was deleted) | `rejected`, `"not_yours"` |
| a bad row (not an object, no/invalid uuid, title, lengths, types) | `rejected`, `"invalid"` |
| `created_at` / `updated_at` outside the window | `rejected`, `"clock"` |

Only these raise (the whole call): `NEO_GATE: Send the logs as a list.`, `NEO_GATE: Send at most 200 logs at a time.`, and `NEO_DENIED` for someone who is not active staff.

**Phone side:** `accepted` and `stale` → `dirty = 0` / remove the `pending_deletes` row. `rejected` → the same, plus `Log.w` with the reason; never retry a rejected row. Push only rows whose `ownerEmail` is the signed-in email.

### 9.3 `work_log_pull(p_since, p_after)` — my own rows
First sign-in: `{"p_since": null, "p_after": null}`. Then send back the cursor of the previous answer while `more` is true.
```json
{"rows": [{"id": "0b7d6a52-1f3e-4c1a-9d2e-5a6b7c8d9e0f", "title": "Re-cabled the office switch", "description": "Two ports dead",
           "category": "Networking", "location_name": "Kakkanad", "latitude": 10.0159, "longitude": 76.3419,
           "created_at": "2026-10-21T04:01:12+00:00", "updated_at": "2026-10-21T04:01:12+00:00",
           "deleted": false, "deleted_at": null, "received_at": "2026-10-22T08:58:30.533+00:00"}],
 "next_since": "2026-10-22T08:58:30.533+00:00", "next_after": "0b7d6a52-1f3e-4c1a-9d2e-5a6b7c8d9e0f", "more": false}
```
- Rows are the caller's own (tombstones included), in the push shape plus `deleted`, ordered by `(received_at, id)`, at most 1000 per call.
- **Keep `next_since` and `next_after` as the exact strings returned** and send them back unchanged (`next_since` can carry microseconds; reformatting it can repeat or skip rows).
- Import: insert rows whose `id` is not a local `remoteId`; skip tombstones, and delete (through the repository, so search stays in step) any local row whose `remoteId` has a tombstone.

### 9.4 `work_log_team(p_from, p_to, p_email)` — tier 3+ or a `neohr` lead
Shop days (India), inclusive, at most 62 days per call; `p_email` optional (one person).
```json
{"p_from": "2026-10-21", "p_to": "2026-10-21", "p_email": null}
```
```json
{"from": "2026-10-21", "to": "2026-10-21", "more": false,
 "rows": [{"id": "0b7d6a52-1f3e-4c1a-9d2e-5a6b7c8d9e0f", "employee_email": "athul.sudheer@neotokyo.in", "employee_name": "Athul Sudheer",
           "day": "2026-10-21", "title": "Re-cabled the office switch", "description": "Two ports dead", "category": "Networking",
           "location_name": "Kakkanad", "latitude": 10.0159, "longitude": 76.3419,
           "created_at": "2026-10-21T04:01:12+00:00", "updated_at": "2026-10-21T04:01:12+00:00"}]}
```
Deleted logs are left out; newest first; at most 2000 rows (`more: true` when there are more — ask for fewer days or one person). A log whose login was deleted is labelled with its stored email. A day is India time: `2026-10-21T18:30:00Z` is already the 22nd. Errors: `NEO_DENIED: Only tier 3 and above, or a NeoHR lead, can see the team's logs.` (contract 3.1; version 3 said "Only tier 3 and above can see the team's logs."), `NEO_GATE: The end date is before the start date.`, `NEO_GATE: Ask for at most 62 days at a time.`

### 9.5 Who reads what
`work_logs` is readable directly (`GET /rest/v1/work_logs`) only for your own rows, or everyone's for tier 3+ and `neohr` leads; nobody writes it except through `work_log_push`. It is not in realtime.

---

## 10. The technician's one app (contract version 3.1, NeoHR 2.1)

NeoHR 2.1 is a module of Neo OS: one Neo OS account, and everything a technician needs when they cannot reach a Neo OS PC. Everything here uses the session, headers and error rules of §8.1 / §4. The dashboard answers are real answers of the RPC (PGlite, `pgtest/dashshapes.mjs`), shortened only where it says `…`.

### 10.1 `neo_dashboard()` — the Dashboard tab
Any active staff member; `{}` →
```json
{"now": "2026-10-22T11:12:40.096+00:00",
 "me": {"name": "Athul Sudheer", "designation": "Service Engineer", "tier": 2},
 "mine": {"items": 0, "offers": 1, "due_today": 0, "overdue": 0},
 "queue": {"open": 3, "overdue": 2, "oldest_minutes": 360},
 "service": {"open": 3, "on_us": 2, "on_customer": 0, "on_supplier": 1, "ready_to_collect": 0, "visits_today": 0, "late": 1},
 "builds": {"open": 6, "awaiting": 4, "building": 1, "waiting_qc": 0, "qc_testing": 1, "due_48h": 1, "overdue": 0, "not_sent": 2},
 "rma": {"open": 0, "at_vendor": 0, "ready_to_return": 0},
 "attention": [
  {"kind": "service", "id": "s_mvjfza0d5ktkj", "code": "NT-9C7L7RX4", "title": "Networking",
   "why": "Offered to you — accept by 17:12.", "at": "2026-10-22T11:42:40.074+00:00"},
  {"kind": "service", "id": "s_mvjfza0va2dxz", "code": "NT-UCE3N44E", "title": "ASUS TUF A15",
   "why": "Nobody has claimed it in 4 hours.", "at": "2026-10-22T09:12:40.071+00:00"},
  {"kind": "build", "id": "t_wqlegacy_queued", "code": "QUEUED", "title": "Legacy Waiting Build",
   "why": "Nobody has claimed it in 4 hours.", "at": "2026-10-22T10:12:40.071+00:00"}]}
```
A head (tier 3+) also gets
```json
 "team": {"people": 5, "busy": 3, "free": 2, "load_pct": 14, "logs_today": 0, "visits_today": 0, "alerts": 0}
```
and a person with no work role and no pool (for example sales) gets only `{"now", "me", "attention": []}`.

**A section is there only when the caller may read what it counts; otherwise it is left out — never sent as zeros.** Hide a section's tiles when its key is missing; ignore unknown keys.

| Section | Present for | Keys (all whole numbers) |
|---|---|---|
| `mine` | someone in a work pool, or holding an item or a live offer | `items` my open items (builds and service, of the kinds I read); `offers` live offers to me; `due_today` my items whose deadline (build) or visit start, else needed-by date (service — the queue ITEM's `deadline`) falls inside today's India day; `overdue` my builds past their deadline plus my service tickets that are late. An item due earlier today and now overdue counts in both. |
| `queue` | Builds or Service desk and up (`my_work_profile.home == "work"`) | `open` what `work_queue()` shows as open, of the kinds I read; `overdue` open past its 4 hours (the server is offering it); `oldest_minutes` the longest wait, `0` when the queue is empty |
| `service` | Service desk and up (techs included) | `open` every open ticket; `on_us` / `on_customer` / `on_supplier` whose turn it is (they add up to `open`); `ready_to_collect` stage `ready`; `visits_today` on-site / remote visits booked for today (any stage); `late` |
| `builds` | Builds desk and up | `open` not completed; `awaiting` / `building` / `waiting_qc` / `qc_testing` by status (`awaiting` = any other status); `due_48h` deadline within the next 48 hours; `overdue` deadline passed; `not_sent` quotes not sent to the floor |
| `rma` | RMA desk and up | `open` parts not closed; `at_vendor` stage `with_vendor`; `ready_to_return` |
| `team` | tier 3+ | the people `work_team` lists: `people`; `busy` holding an item or a live offer; `free` holding nothing; `load_pct` points held against the capacity of everyone in a pool (can pass 100); `logs_today` work logs made today; `visits_today` NeoHR "Arrived" check-ins today; `alerts` unresolved "Needs a lead" alerts |

**late and whose turn** are exactly the Neo OS service board's (`shared/service-status.js` `serviceRisk` / `ticketWithUnits`, ported to SQL and kept in step by `tests/sql-parity.test.js`): a broken promise date, a booked visit 30 minutes past its start with nobody there, or a stage idle past its budget; a ticket waiting on parts under warranty claim takes the most urgent part's turn and the worst part's lateness. NeoHR shows the numbers; it never recomputes them. Days are India days (`Asia/Kolkata`).

`attention`: at most 6 lines, one per item (its most urgent reason), most urgent first, then oldest `at` first. `kind` is `build` or `service` — tap opens that item's detail (§10.2). `title` is the build's customer name or the service job's device (else its category), never a service customer's name or phone.

| Order | When | `why` (exact) | `at` |
|---|---|---|---|
| 0 | a live offer to me | "Offered to you — accept by HH:MM." (India time) | the offer's end |
| 1 | my build past its deadline / my late service job | "Past its deadline." / "Late — Diagnosing." (the stage's staff label, §12) | the deadline / when it entered the stage |
| 2 | an unresolved alert of a kind I lead | the alert's `body` (§8.3) | when it was raised |
| 3 | an open item past its 4 hours with no live offer that I could claim (eligible, not declined by me), or any such item of a kind I lead | "Nobody has claimed it in 4 hours." | its claim due time |
| 4 | anyone's late work of a kind I lead | "Past its deadline. Adhil has it." / "Late — Parts on order. Ananthakrishnan A R has it." / "… Nobody has it." | as 1 |
| 5 | my item due later today | "Due today at HH:MM." | its deadline |

Refresh it on open, on pull-to-refresh and every 30 s while the tab is visible (after a fire-and-forget `work_tick()`). Offline: show the last answer with "as of HH:MM" (its `now`). Errors: only `NEO_DENIED: Sign in with an active staff account to do this.`

### 10.2 Reading a job (the detail screens)
**Service job.** The header (code, type, stage, priority) comes from the `work_queue` ITEM; whose turn the stage is, from the stage's `ball` in `shared/service-status.js` (`quoted`, `work_done`, `resolved`, `ready` → the customer; `parts_on_order`, `at_vendor` → a supplier; anything else → us). Then, with any `service` role:
- **Contact and site** — own jobs only, from `v_tech_day` (§5.2, §8.10), in memory only.
- **Items:**
  ```
  GET {URL}/rest/v1/service_items?job_id=eq.<jobId>&select=id,sort,is_primary,kind,label,serial,condition_remarks,accessories,powers_on&order=sort.asc
  ```
  `[{"id": "si_…", "sort": 0, "is_primary": true, "kind": "laptop", "label": "ASUS TUF A15", "serial": "…", "condition_remarks": null, "accessories": [], "powers_on": null}]` — `kind` labels are `S.ITEM_KINDS`.
- **Timeline** (newest 30):
  ```
  GET {URL}/rest/v1/service_events?job_id=eq.<jobId>&select=id,at,kind,actor_name,from_stage,to_stage,body,customer_visible&order=at.desc,id.desc&limit=30
  ```
  Mark rows with `customer_visible: true` ("the customer sees this"). `kind` is one of `stage`, `note`, `edit`, `media`, `claim`, `release`, `assign`, `rma`, `field`, `suggest`, `priority`, `offer`; a `stage` row's `body` may be null (show "from → to" with the staff labels).
- **Device password:** a button; on tap call `service_get_password` (§6.10). `{"secret": null}` means none is on file (and nothing was logged). Show it 30 s, never store it.

**Build.** Read named columns only — `specs` also holds the Windows key and prices, which a phone has no use for:
```
GET {URL}/rest/v1/tickets?id=eq.<t_…>&select=id,customer_name,status,deadline,technician,technician_email,queued_at,offered_to_name,offer_expires_at,completed_at,build_checks,qc_checks,cpu:specs->>cpu,gpu:specs->>gpu,ram:specs->>ram,storage:specs->>storage,psu:specs->>psu,case:specs->>case,mobo:specs->>mobo,cooler_type:specs->>coolerType,cooler_model:specs->>coolerModel,os:specs->>os,sales_exec:specs->__build->>salesExec,build_tier:specs->__build->>tier
```
Assembly progress = ticked of `build_checks` `cpuRamSsd, moboCase, cooler, cables, posted` (5); QC progress = ticked of `qc_checks` `physCabinet, physMobo, physRam, physScrews, softWindows, softDrivers, softBios, portUsb, portVideo, portAudio, portWifi` (11). Both read-only on the phone: "Assembly checks and QC run on the Neo OS Testing Client on the PC being built."

**My RMA parts** (the parts I am handling, read-only; a `service` or `rma` role reads them):
```
GET {URL}/rest/v1/rma_cases?handler_email=eq.<my_work_profile.email>&stage=neq.closed&select=id,public_code,kind,brand,model,stage,stage_since,expected_back_at,rma_vendors(name,public_name)&order=stage_since.asc
```
Use the `email` exactly as `my_work_profile()` returned it. Stage labels are in §12; actions stay in Neo OS.

### 10.3 Writes from the job screen (online only)
**Move a stage** — `service_move(p_job_id, p_from, p_to, p_note, p_visible, p_extra)`, any `service` role (NeoHR offers it on the person's own jobs):
```json
{"p_job_id": "s_mgx1k2abcde", "p_from": "diagnosing", "p_to": "in_service", "p_note": "Fan replaced", "p_visible": false, "p_extra": {}}
```
- `p_from` is the stage the screen showed; if the job moved since, the answer is `NEO_STALE: Someone moved this ticket to … already. Reopen it to see where it is.` (refresh).
- Offer the job type's track minus the current stage and minus `rma_raised`, `at_vendor`, `back_from_vendor` (the RMA module moves those; a try answers `NEO_RMA_HOLD: …`). Tracks (`shared/service-status.js` `STAGES_BY_TYPE`): in-store `logged, received, diagnosing, quoted, approved, parts_to_order, parts_on_order, (rma…), in_service, verifying, ready, closed`; on-site `logged, scheduled, en_route, on_site, work_done, revisit_needed, quoted, approved, parts_to_order, parts_on_order, (rma…), closed`; remote `logged, session_booked, in_session, resolved, quoted, closed`.
- `p_extra` by target: `parts_on_order` (and `at_vendor`) need `"waiting_party"` (who we wait on, ≤ 120; optional `"next_chase_at"`) — else `NEO_GATE: Say who we are waiting on — that is the whole point of the chase list.`; `ready` and `closed` need `"outcome"` (a key of `S.OUTCOMES`, offered in the order of `S.outcomesFor(job)`; closing a `ready` job reuses its outcome) — else `NEO_GATE: Say what happened — the customer sees this, and "Closed" on its own tells them nothing.`; any move may carry `"promised_at"`, `"visit_start"`, `"visit_end"` (ISO with offset; `NEO_GATE: The visit ends before it starts.`). Type conversion (`convert_to`) is for Neo OS.
- The move itself is always on the customer's timeline; `p_note` rides on it with its own `p_visible` (default it to `false`).
- Answer: the whole ticket row (`stage`, `stage_since`, `outcome`, … — it also carries the customer's phone and address: keep it in memory only). Other errors: `NEO_DENIED: You don't have access to move service tickets.`, `NEO_GATE: That ticket no longer exists.`, `NEO_GATE: The ticket is already at ….`, `NEO_GATE: … is not a step for … ticket.`, `NEO_RMA_HOLD: This ticket is waiting on RMA ….`, `NEO_GATE: The note is too long — keep it under 4000 characters.`

**Add a note** — `service_add_note` (§6.4): internal by default, `p_visible: true` only when the technician ticks "the customer can read this".

**Device password** — `service_get_password` (§6.10). **On-site actions, hand back, accept / decline** — §8.5–§8.10.

### 10.4 Photos — exactly as Neo OS uploads them
1. Camera or gallery → JPEG, longest side ≤ 1600 px (Neo OS uses 2048; both fine), ≤ 15 MB, white behind any transparency.
2. **Path**, made fresh for every upload attempt (NeoHR 2.1 keeps nothing on the phone and never retries a path):
   `<jobId>/<t36>-<r8>.jpg` — `t36` = the time in milliseconds in base 36, lower case (`Long.toString(System.currentTimeMillis(), 36)`), `r8` = 8 random characters from `0-9a-z` (a secure random source). Example `s_mgx1k2abcde/mh1v7k2c-4f9q2x7a.jpg`.
3. **Upload** (`service` role; the bucket refuses anyone else):
   ```
   POST {URL}/storage/v1/object/service-media/<path>
   apikey: <anon key>
   Authorization: Bearer <access_token>
   Content-Type: image/jpeg
   x-upsert: false
   cache-control: max-age=3600

   <the JPEG bytes>
   ```
   `200` (a small JSON naming the key). An "already exists" answer (`"error": "Duplicate"`, HTTP 400 or 409) can only come from a second try of the same path, so it means the first try landed. Neither client meets it in practice, because every attempt makes a new path; NeoHR 2.1 treats it as landed and goes on to 4.
4. **Record it** — the same row Neo OS writes:
   ```
   POST {URL}/rest/v1/service_media
   Prefer: return=representation
   Content-Type: application/json

   {"job_id": "s_mgx1k2abcde", "rma_case_id": null, "service_item_id": null, "path": "s_mgx1k2abcde/mh1v7k2c-4f9q2x7a.jpg",
    "phase": "during", "role": "during", "remark": "Dust in the PSU fan", "remark_by": "Athul Sudheer",
    "remark_at": "2026-10-22T11:20:05.000Z", "uploaded_by": "athul.sudheer@neotokyo.in", "uploaded_name": "Athul Sudheer"}
   ```
   → `201` `[{…the row, with its id}]`. `role` from the phone: `condition`, `damage`, `during`, `after` or `other` (never `invoice`, `serial_label`, `vendor_doc`). `phase` follows the role: `condition` / `damage` → `intake`; `during` → `during`; `after` → `after`; `other` → `during`. `remark` is optional; when it is set, `remark_by` is the person's name (else their email) and `remark_at` now, otherwise all three are `null`. `service_item_id` may name one of the job's items (§10.2).
5. **If the row is refused** (any HTTP error answer), remove the file — the uploader may delete their own:
   ```
   DELETE {URL}/storage/v1/object/service-media
   Content-Type: application/json

   {"prefixes": ["s_mgx1k2abcde/mh1v7k2c-4f9q2x7a.jpg"]}
   ```
   When the insert **timed out**, do **not** delete: the row may have been written. NeoHR 2.1, like Neo OS, then reports the failure and stops. It does not retry that path and does not check for the row. The person adds the photo again (a gallery photo is picked again, a camera shot is taken again), which makes a new path. If the timed-out insert did land, the job shows the same photo twice, and a `service` lead can delete the extra one in Neo OS.
6. To show a photo: `POST {URL}/storage/v1/object/sign/service-media/<path>` with `{"expiresIn": 900}` → `{"signedURL": "/object/sign/service-media/<path>?token=…"}`; open `{URL}/storage/v1` + `signedURL`. Never cache the signed link beyond its 15 minutes.

NeoHR 2.1 adds photos **online only** (§7): nothing is queued in Room, and every failure goes back to the person. The customer sees a photo only when the desk ticks "show customer".

*For a later version that queues photos offline (not built in NeoHR 2.1):* make the path once per photo and keep it, with the JPEG and the pending row, in a Room outbox. Retry with the same path; an "already exists" upload answer then means the file landed. Before inserting on a retry, `GET {URL}/rest/v1/service_media?path=eq.<path>&select=id`; if a row is there, the photo is done. With that, a timed-out attempt can be repeated without a duplicate row.

### 10.5 The NeoHR app's own updates (`neohr.json`)
NeoHR updates itself from GitHub Releases of the public repository `akruunnithan21-ship-it/neoqc`, the same repository Neo OS updates from:
- A NeoHR release is tagged `neohr-vMAJOR.MINOR.PATCH`, published as a **pre-release and never "Latest"** (Neo OS desktops update from the Latest release, which must stay theirs), and carries exactly two assets: `NeoHR-<version>.apk` and `neohr.json`.
- `neohr.json`:
  ```json
  {"versionCode": 20100, "versionName": "2.1.0", "apk": "NeoHR-2.1.0.apk", "size": 23874560,
   "sha256": "<64 lower-case hex digits of the APK>", "minSdk": 29,
   "notes": "Plain text, at most 2000 characters.", "mandatory": false}
  ```
  | Key | Rule |
  |---|---|
  | `versionCode` | `major × 10000 + minor × 100 + patch` (2.1.0 → 20100) — the number compared with the installed app's |
  | `versionName` | `"major.minor.patch"`, the tag without `neohr-v` |
  | `apk` | the APK asset's file name in the same release |
  | `size`, `sha256` | the APK's exact byte count and SHA-256; refuse to install a download that does not match both |
  | `minSdk` | the lowest Android API level it runs on; do not offer it to an older phone |
  | `notes` | shown under "Update available — NeoHR 2.1.1" |
  | `mandatory` | `false` in this release (reserved) |
  Unknown keys are ignored.
- **Check:** `GET https://api.github.com/repos/akruunnithan21-ship-it/neoqc/releases?per_page=30` with `Accept: application/vnd.github+json`, no credentials. A `403` or `429` is GitHub's rate limit (60 an hour per network): stay quiet and try later. Keep releases that are not drafts and whose `tag_name` matches `^neohr-v\d+\.\d+\.\d+$`; take the newest by version number (2.10.0 is newer than 2.9.0); download its `neohr.json` asset (`browser_download_url`); offer the update when its `versionCode` is higher than the installed one. Download the APK from the asset named by `apk`, in the same release.
- Neo OS's NeoHR screen reads the same list to show the latest version and its download link. Publishing a release is done only by the owner's release step (`tools/publish-neohr.mjs --publish` in the phone project).

---

## 11. Privacy

- The queue (`v_service_queue`) never exposes phone, surname or address, and its location is rounded to about 1 km. Full contact details arrive only after a claim, via `v_tech_day`.
- Location is recorded only on the explicit events a technician posts (check-in, check-out, punch). There is no continuous tracking, and NeoHR must not add any.
- Technicians' home addresses belong in NeoHR's own storage, never in these tables.
- What the database allows is wider than what NeoHR should show. Row-level security lets any `service` desk+ member read every ticket, because the desktop board needs that. NeoHR should still read only the views above, so a phone app never holds more customer data than the person's own day needs.
- Who can read the activity log and everyone's work logs: the person, any `neohr` lead, and tier 3+ (owner, founders, department heads); a `service` lead also reads the activity log. HR staff below tier 3 need a `neohr` lead role, which tier 4+ grant in Settings → General → People (the NeoHR role column) — see §3.
- The dashboard (§10.1) counts; it never lists customers. Its attention lines name a service job by its device, never its customer.
- A customer's tracking page never shows a distributor's name: it names the part's brand (or the vendor's public name).

---

## 12. Stage vocabulary NeoHR will meet

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

In-store jobs (contract 3.1: the phone now shows and moves them, §10.3): `logged` → `received` → `diagnosing` → `quoted` → `approved` → `parts_to_order` / `parts_on_order` → `in_service` → `verifying` → `ready` → `closed`, with the RMA stages as above.

| stage | staff label |
|---|---|
| received | Received at counter |
| diagnosing | Diagnosing |
| quoted | Quote sent — awaiting approval |
| approved | Approved — queued for bench |
| parts_on_order | Parts on order |
| in_service | On the bench |
| verifying | Verifying / soak |
| ready | Ready for collection |

The full list, with the customer's wording and whose turn each stage is, is `STAGES` in `shared/service-status.js`; the phone keeps a copy of those labels.

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

## 13. Changes to this contract

Additive changes (a new column, a new optional field, a new RPC) can ship at any time, so NeoHR must ignore unknown JSON keys. Removing or renaming anything here means a new contract version and a note in this file first.

### Version 3.1 (additive, `sql/work-queue.sql`, Neo OS 1.11.0 / NeoHR 2.1)
- New: `neo_dashboard()` — the phone's simplified dashboard; each section only for the people who may read it (§10.1). Its "late" and whose-turn counts are the desktop's own rule.
- New in the contract (the server already allowed it): the technician's job detail reads (`service_items`, `service_events`, `rma_cases` for "My RMA parts", a build's named columns), `service_move` from the phone, and the photo upload exactly as Neo OS does it, online only (§10.2–§10.4).
- New: the NeoHR update manifest `neohr.json` on GitHub pre-releases tagged `neohr-v…` (§10.5).
- Changed: a `neohr` lead (HR; tier 3+ always are) now reads everyone's work logs (`work_log_team`, `work_logs`) and the team (`work_team`: people, load, last seen, logs today; items, offers and alerts still only of the kinds they lead), and gets `team_view: true`. `work_log_team`'s refusal reads "Only tier 3 and above, or a NeoHR lead, can see the team's logs."
- Changed: People (`staff_update` / `staff_list`) sets and shows the `neohr` role; presets still never touch it.
- Unchanged: every version 3 shape.

### Version 3 (`sql/work-queue.sql`, Neo OS 1.11.0)
- New: the work queue (§8): `my_work_profile`, `work_queue`, `work_tick`, `work_claim`, `work_respond`, `work_release`, `work_offer`, `work_team`, `work_alert_resolve`, `work_events_for`. Builds and service tickets wait in one queue: 4 hours to claim, then the server offers the item; an offer lasts 30 minutes.
- New: work logs sync (§9): `work_log_push`, `work_log_pull`, `work_log_team`; table `work_logs` (read-only for clients).
- New: sign-in, refresh and sign-out over plain REST (§8.1) — no Supabase SDK needed.
- Changed: `service_claim` needs the service pool, refuses (without writing) a job offered to someone else (`reason: "offered"`), and accepts a job offered to the caller (§6.2).
- Changed: `service_tech_list` lists service-pool members only and adds pools, level, load and capacity (§6.6); `my_modules` adds pools and level (§3).
- Changed: `service_create` ignores "take it myself" (`assign_self`) for someone outside the service pool.
- Unchanged: `v_service_queue`, `v_tech_day`, `record_field_activity`, `service_release`, `service_assign`, `tech_activity`. New `service_events` rows of kind `offer` (internal) record offers; accepting an offer writes an `assign` row, which `tech_activity` counts like a lead's assignment.

### Version 2.1 (additive, `sql/service-v2.1.sql`)
- The shop never backs up customer data. `service_jobs.data_consent` now records what the customer did: `customer_backed_up` ("Customer backed up their data"), `no_important_data` ("No important data on it") or `customer_accepts_risk` ("Customer accepts the risk — no backup"). The older `backup_ok` / `no_backup` stay valid on old jobs; show them as "Back up first (old option)" / "No backup needed (old option)" and never offer them. `has_customer_data` is true unless the answer is `no_important_data`.
- New: `service_jobs.has_device_password` and the device-password RPCs `service_get_password` / `service_set_password` (§6.10). Every read is recorded on the job's internal timeline; the password is deleted when the job closes.
- Unchanged: `v_service_queue`, `v_tech_day`, `get_service_public` (the customer's page never mentions a password).

### Version 2
- The view `v_tech_activity` is gone. Use the RPC `tech_activity(p_from, p_to)` (§5.3); same keys, plus a date range. A `neohr` lead now sees everyone's activity, in `tech_activity` and in `field_activity`.
- Phone numbers keep their country code (`919847012345`, `971501234567`) instead of being cut to 10 digits; a leading `00` is dropped, and 11-digit Kuwait / Oman / Bahrain / Qatar numbers are valid (§4).
- `service_claim` at a different time than the one already booked tells the customer the visit moved (§6.2).
- `rma_release_hold` on an on-site job goes to `work_done` or `revisit_needed` (§6.9, §12).
- `record_field_activity`: a check-out from `scheduled` / `en_route` finishes the visit and counts it (§6.1).
- `record_field_activity`: `departed` + `customer_absent` moves the job to `revisit_needed` (not `scheduled`), clears the spent visit time and tells the customer we will call to rebook (§6.1).
- Who has a job changes only through `service_claim` / `service_release` (and a lead's `service_assign`); a direct write of `assignee` / `assignee_email` is refused for anyone but a lead. Timeline rows written directly (not through an RPC) may only be kinds `stage`, `note`, `edit`, `media`, with no `meta`, in the signed-in person's own name — claim, release and assign rows (which `tech_activity` counts) come only from the RPCs.
- Files in the `service-media` bucket need a `service` role, not just a staff account (§6.5).
- `service_claim`: a claim of a job that is already yours answers `{"ok": true, "already": true, …}`; the reason is never required (§6.2).
- New: field pulls through `rma_create` with `source: "field"`, starting at the RMA stage `with_tech` (§6.8).
- `rma_dispatch` takes `p_mode` and `p_carried_by` (§6.9; desktop only).
