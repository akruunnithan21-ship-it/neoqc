-- =============================================================================
-- neohr-hr-v2.4.tests.sql — tests for the neohr_hr_v2_4 migration (sql/neohr-hr-v2.4.sql)
-- -----------------------------------------------------------------------------
-- Run AFTER sql/neohr-hr-v2.4.sql (on top of service-v2, v2.1, work-queue,
-- neohr-hr v2.3), as the database owner. Everything happens inside one
-- transaction that ends in ROLLBACK: nothing is left behind, not even the
-- helper schema.
--
-- Users are simulated the way PostgREST does it (SET ROLE + request.jwt.claims),
-- as in the other test files. Everybody here is a throw-away login
-- (zq.v24.*@neotokyo.test) made here with its own hr_person row and its own
-- tier (a tier 3, a tier 4 and a tier 5 among them), so no real person's
-- punch, request or photo can change an answer. The shift, the settings and
-- the holidays near today are pinned inside the transaction; the office point
-- is set during the run.
--
-- Time: now() is the transaction's start and does not move. Punches whose
-- answer depends on lateness are sent with their device time on past days
-- (neo_v24t.at(-3, '09:41')); punches "now" are server-anchored with an
-- age_ms under 10 minutes (so they are not "sent late"). Their session day is
-- worked out with the same rule, so the file passes at any time of day.
-- tests/fixtures/hr-day-v24.json is inlined below byte for byte
-- (tests/sql-parity.test.js checks that) and runs through _hr_day_calc.
--
-- Two halves: sections 0–8 and sections 0–1 + 9–17 each pass on their own as
-- well (a live rehearsal can send them separately); the whole file runs them in
-- this order.
--
-- A failed assertion raises "FAIL: …" and aborts — the first error is the one
-- to read. Success ends with the row
--   result = 'neohr-hr v2.4 tests: all passed'
-- just before the rollback.
-- =============================================================================

begin;

-- ── 0. Scaffolding (as the owner) ────────────────────────────────────────────
create schema neo_v24t;
grant usage on schema neo_v24t to anon, authenticated;

create table neo_v24t.users (alias text primary key, id uuid not null, email text not null, tier int not null, name text not null);
create table neo_v24t.ctx (k text primary key, v text);
create table neo_v24t.fx (name text primary key, body jsonb not null);
grant select on neo_v24t.users, neo_v24t.fx to anon, authenticated;
grant select, insert, update, delete on neo_v24t.ctx to anon, authenticated;

-- The shared fixture, inlined byte for byte (tests/sql-parity.test.js).
insert into neo_v24t.fx (name, body) values ('hr-day-v24', $fx${"version":1,"about":"v2.4 day records of public._hr_day_calc (NEOHR-2.3-SPEC 1.4): excused_in, pending_ids, pending_reason. India time; minutes are whole minutes, rounded down. The status word counts worked + pending minutes (a day waiting for HR is not a half day for that alone).","cases":[{"name":"excused_late","note":"an excused first punch_in: late_raw_min keeps the 50 minutes, late_min is 0, never \"late\"","input":{"day":"2026-10-20","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"shop","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":false,"events":[{"id":"e101","kind":"punch_in","at":"2026-10-20T05:00:00Z"},{"id":"e102","kind":"punch_out","at":"2026-10-20T13:30:00Z"}],"points_at":[],"km":0,"km_gaps":0,"excused_in":["e101"],"pending_ids":[],"pending_reason":false},"expect":{"late_excused":true,"pending_min":0,"away_pending":false,"pending_reason":false,"missed_out":false,"irregular":false,"open":false,"status":"present","flex":false,"first_in":"2026-10-20T05:00:00Z","last_out":"2026-10-20T13:30:00Z","worked_min":510,"break_min":0,"late_min":0,"late_raw_min":50,"early_min":0}},{"name":"late_not_excused","note":"the same day without the excuse: late","input":{"day":"2026-10-20","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"shop","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":false,"events":[{"id":"e103","kind":"punch_in","at":"2026-10-20T05:00:00Z"},{"id":"e104","kind":"punch_out","at":"2026-10-20T13:30:00Z"}],"points_at":[],"km":0,"km_gaps":0,"excused_in":[],"pending_ids":[],"pending_reason":false},"expect":{"late_excused":false,"pending_min":0,"away_pending":false,"pending_reason":false,"missed_out":false,"irregular":false,"open":false,"status":"late","flex":false,"worked_min":510,"late_min":50,"late_raw_min":50}},{"name":"excused_on_time","note":"excused but on time: nothing to excuse, still marked excused","input":{"day":"2026-10-20","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"shop","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":false,"events":[{"id":"e105","kind":"punch_in","at":"2026-10-20T04:05:00Z"},{"id":"e106","kind":"punch_out","at":"2026-10-20T13:05:00Z"}],"points_at":[],"km":0,"km_gaps":0,"excused_in":["e105"],"pending_ids":[],"pending_reason":false},"expect":{"late_excused":true,"pending_min":0,"away_pending":false,"pending_reason":false,"missed_out":false,"irregular":false,"open":false,"status":"present","worked_min":540,"late_min":0,"late_raw_min":0}},{"name":"excused_second_session_only","note":"only the FIRST session's punch_in can excuse the day","input":{"day":"2026-10-20","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"shop","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":false,"events":[{"id":"e107","kind":"punch_in","at":"2026-10-20T05:00:00Z"},{"id":"e108","kind":"punch_out","at":"2026-10-20T07:00:00Z"},{"id":"e109","kind":"punch_in","at":"2026-10-20T08:00:00Z"},{"id":"e110","kind":"punch_out","at":"2026-10-20T13:30:00Z"}],"points_at":[],"km":0,"km_gaps":0,"excused_in":["e109"],"pending_ids":[],"pending_reason":false},"expect":{"late_excused":false,"pending_min":0,"away_pending":false,"pending_reason":false,"missed_out":false,"irregular":false,"open":false,"status":"late","worked_min":450,"late_min":50,"late_raw_min":50}},{"name":"excused_skipped_punch_in","note":"a skipped (irregular) second punch_in is not the first session's","input":{"day":"2026-10-20","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"shop","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":false,"events":[{"id":"e111","kind":"punch_in","at":"2026-10-20T04:30:00Z"},{"id":"e112","kind":"punch_in","at":"2026-10-20T05:00:00Z"},{"id":"e113","kind":"punch_out","at":"2026-10-20T13:00:00Z"}],"points_at":[],"km":0,"km_gaps":0,"excused_in":["e112"],"pending_ids":[],"pending_reason":false},"expect":{"late_excused":false,"pending_min":0,"away_pending":false,"pending_reason":false,"missed_out":false,"irregular":true,"open":false,"status":"late","worked_min":510,"late_min":20,"late_raw_min":20}},{"name":"pending_away_punch_in","note":"a pending away punch_in: the session counts nowhere until HR approves; the status word counts it (present, not half_day)","input":{"day":"2026-10-20","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"shop","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":false,"events":[{"id":"e114","kind":"punch_in","at":"2026-10-20T04:00:00Z"},{"id":"e115","kind":"punch_out","at":"2026-10-20T13:00:00Z"}],"points_at":[],"km":0,"km_gaps":0,"excused_in":[],"pending_ids":["e114"],"pending_reason":false},"expect":{"late_excused":false,"pending_min":540,"away_pending":true,"pending_reason":false,"missed_out":false,"irregular":false,"open":false,"status":"present","first_in":"2026-10-20T04:00:00Z","last_out":"2026-10-20T13:00:00Z","worked_min":0,"break_min":0,"late_min":0,"late_raw_min":0,"early_min":0}},{"name":"pending_away_punch_out","note":"a pending away punch_out takes its whole session out too; status from worked + pending minutes","input":{"day":"2026-10-20","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"shop","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":false,"events":[{"id":"e116","kind":"punch_in","at":"2026-10-20T04:00:00Z"},{"id":"e117","kind":"punch_out","at":"2026-10-20T13:00:00Z"}],"points_at":[],"km":0,"km_gaps":0,"excused_in":[],"pending_ids":["e117"],"pending_reason":false},"expect":{"late_excused":false,"pending_min":540,"away_pending":true,"pending_reason":false,"missed_out":false,"irregular":false,"open":false,"status":"present","worked_min":0}},{"name":"pending_second_session","note":"only the pending session is left out; 150 counted + 330 pending is a full day","input":{"day":"2026-10-20","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"shop","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":false,"events":[{"id":"e118","kind":"punch_in","at":"2026-10-20T04:00:00Z"},{"id":"e119","kind":"punch_out","at":"2026-10-20T06:30:00Z"},{"id":"e120","kind":"punch_in","at":"2026-10-20T07:30:00Z"},{"id":"e121","kind":"punch_out","at":"2026-10-20T13:00:00Z"}],"points_at":[],"km":0,"km_gaps":0,"excused_in":[],"pending_ids":["e120"],"pending_reason":false},"expect":{"late_excused":false,"pending_min":330,"away_pending":true,"pending_reason":false,"missed_out":false,"irregular":false,"open":false,"status":"present","worked_min":150,"late_min":0,"early_min":0}},{"name":"pending_with_break","note":"a pending session's break minutes are left out too; status from worked + pending minutes","input":{"day":"2026-10-20","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"shop","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":false,"events":[{"id":"e122","kind":"punch_in","at":"2026-10-20T04:00:00Z"},{"id":"e123","kind":"break_start","at":"2026-10-20T07:00:00Z"},{"id":"e124","kind":"break_end","at":"2026-10-20T07:30:00Z"},{"id":"e125","kind":"punch_out","at":"2026-10-20T13:00:00Z"}],"points_at":[],"km":0,"km_gaps":0,"excused_in":[],"pending_ids":["e122"],"pending_reason":false},"expect":{"late_excused":false,"pending_min":510,"away_pending":true,"pending_reason":false,"missed_out":false,"irregular":false,"open":false,"status":"present","worked_min":0,"break_min":0}},{"name":"pending_open_today","note":"an open pending session: open, its minutes so far pending","input":{"day":"2026-10-22","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"shop","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":false,"events":[{"id":"e126","kind":"punch_in","at":"2026-10-22T03:50:00Z"}],"points_at":[],"km":0,"km_gaps":0,"excused_in":[],"pending_ids":["e126"],"pending_reason":false},"expect":{"late_excused":false,"pending_min":160,"away_pending":true,"pending_reason":false,"missed_out":false,"irregular":false,"open":true,"status":"open","first_in":"2026-10-22T03:50:00Z","last_out":null,"worked_min":0}},{"name":"pending_reason_absent","note":"pending_reason is copied through; no punch: absent","input":{"day":"2026-10-20","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"shop","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":false,"events":[],"points_at":[],"km":0,"km_gaps":0,"excused_in":[],"pending_ids":[],"pending_reason":true},"expect":{"late_excused":false,"pending_min":0,"away_pending":false,"pending_reason":true,"missed_out":false,"irregular":false,"open":false,"status":"absent","worked_min":0,"absent_units":1,"late_raw_min":0}},{"name":"excused_flex_request","note":"a flexible day has no late minutes to excuse","input":{"day":"2026-10-20","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"shop","holiday":null,"attendance_required":true,"flex_request":true,"half_day_leave":false,"events":[{"id":"e127","kind":"punch_in","at":"2026-10-20T05:00:00Z"},{"id":"e128","kind":"punch_out","at":"2026-10-20T13:30:00Z"}],"points_at":[],"km":0,"km_gaps":0,"excused_in":["e127"],"pending_ids":[],"pending_reason":false},"expect":{"late_excused":true,"pending_min":0,"away_pending":false,"pending_reason":false,"missed_out":false,"irregular":false,"open":false,"status":"present","flex":true,"worked_min":510,"late_min":0,"late_raw_min":0}},{"name":"v23_input_no_v24_keys","note":"a v2.3 input (no v2.4 keys): the new keys read false / 0","input":{"day":"2026-10-20","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"shop","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":false,"events":[{"id":"e129","kind":"punch_in","at":"2026-10-20T04:22:00Z"},{"id":"e130","kind":"punch_out","at":"2026-10-20T13:01:00Z"}],"points_at":[],"km":0,"km_gaps":0},"expect":{"late_excused":false,"pending_min":0,"away_pending":false,"pending_reason":false,"missed_out":false,"irregular":false,"open":false,"status":"late","worked_min":519,"late_min":12,"late_raw_min":12}},{"name":"folded_sessions_pending_out","note":"already-folded sessions: pending_ids match out_id as well as in_id; status from worked + pending minutes","input":{"day":"2026-10-20","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"shop","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":false,"sessions":[{"in_id":"s1","start":"2026-10-20T04:00:00Z","cap":"2026-10-20T20:00:00Z","end":"out","out":"2026-10-20T13:00:00Z","out_id":"s2","breaks":[],"open_break":null,"last_at":"2026-10-20T13:00:00Z","irregular":false,"day":"2026-10-20"}],"orphans":[],"km":0,"km_gaps":0,"excused_in":[],"pending_ids":["s2"],"pending_reason":false},"expect":{"late_excused":false,"pending_min":540,"away_pending":true,"pending_reason":false,"missed_out":false,"irregular":false,"open":false,"status":"present","worked_min":0}},{"name":"excused_and_pending","note":"excused and pending at once: no late mark, nothing counted yet, present","input":{"day":"2026-10-20","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"shop","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":false,"events":[{"id":"e131","kind":"punch_in","at":"2026-10-20T05:00:00Z"},{"id":"e132","kind":"punch_out","at":"2026-10-20T13:30:00Z"}],"points_at":[],"km":0,"km_gaps":0,"excused_in":["e131"],"pending_ids":["e131"],"pending_reason":false},"expect":{"late_excused":true,"pending_min":510,"away_pending":true,"pending_reason":false,"missed_out":false,"irregular":false,"open":false,"status":"present","worked_min":0,"late_min":0,"late_raw_min":50}},{"name":"excused_short_day","note":"excused but short: half day, not late","input":{"day":"2026-10-20","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"shop","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":false,"events":[{"id":"e133","kind":"punch_in","at":"2026-10-20T05:00:00Z"},{"id":"e134","kind":"punch_out","at":"2026-10-20T07:00:00Z"}],"points_at":[],"km":0,"km_gaps":0,"excused_in":["e133"],"pending_ids":[],"pending_reason":false},"expect":{"late_excused":true,"pending_min":0,"away_pending":false,"pending_reason":false,"missed_out":false,"irregular":false,"open":false,"status":"half_day","worked_min":120,"late_min":0,"late_raw_min":50,"early_min":360}},{"name":"excused_field_duty","note":"duty field: no late minutes at all","input":{"day":"2026-10-20","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"field","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":false,"events":[{"id":"e135","kind":"punch_in","at":"2026-10-20T05:00:00Z"},{"id":"e136","kind":"punch_out","at":"2026-10-20T13:30:00Z"}],"points_at":[],"km":0,"km_gaps":0,"excused_in":["e135"],"pending_ids":[],"pending_reason":false},"expect":{"late_excused":true,"pending_min":0,"away_pending":false,"pending_reason":false,"missed_out":false,"irregular":false,"open":false,"status":"present","flex":true,"worked_min":510,"late_min":0,"late_raw_min":0}},{"name":"pending_late","note":"a pending away punch_in at 10:30: late keeps its word (late, 50 min) while the session waits for HR","input":{"day":"2026-10-20","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"shop","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":false,"events":[{"id":"e140","kind":"punch_in","at":"2026-10-20T05:00:00Z"},{"id":"e141","kind":"punch_out","at":"2026-10-20T13:00:00Z"}],"points_at":[],"km":0,"km_gaps":0,"excused_in":[],"pending_ids":["e140"],"pending_reason":false},"expect":{"status":"late","worked_min":0,"pending_min":480,"away_pending":true,"late_min":50,"late_raw_min":50,"late_excused":false}},{"name":"pending_short_day","note":"120 counted + 119 pending is 239 minutes: under the half-day line, half_day","input":{"day":"2026-10-20","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"shop","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":false,"events":[{"id":"e142","kind":"punch_in","at":"2026-10-20T04:00:00Z"},{"id":"e143","kind":"punch_out","at":"2026-10-20T06:00:00Z"},{"id":"e144","kind":"punch_in","at":"2026-10-20T06:30:00Z"},{"id":"e145","kind":"punch_out","at":"2026-10-20T08:29:00Z"}],"points_at":[],"km":0,"km_gaps":0,"excused_in":[],"pending_ids":["e144"],"pending_reason":false},"expect":{"status":"half_day","worked_min":120,"pending_min":119,"away_pending":true,"late_min":0}},{"name":"pending_full_half","note":"120 counted + 120 pending is exactly the half-day line: present","input":{"day":"2026-10-20","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"shop","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":false,"events":[{"id":"e148","kind":"punch_in","at":"2026-10-20T04:00:00Z"},{"id":"e149","kind":"punch_out","at":"2026-10-20T06:00:00Z"},{"id":"e150","kind":"punch_in","at":"2026-10-20T06:30:00Z"},{"id":"e151","kind":"punch_out","at":"2026-10-20T08:30:00Z"}],"points_at":[],"km":0,"km_gaps":0,"excused_in":[],"pending_ids":["e150"],"pending_reason":false},"expect":{"status":"present","worked_min":120,"pending_min":120,"away_pending":true,"late_min":0}},{"name":"pending_half_day_leave","note":"a half-day leave with a pending session: half_day whatever the minutes","input":{"day":"2026-10-20","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"shop","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":true,"events":[{"id":"e146","kind":"punch_in","at":"2026-10-20T04:00:00Z"},{"id":"e147","kind":"punch_out","at":"2026-10-20T09:00:00Z"}],"points_at":[],"km":0,"km_gaps":0,"excused_in":[],"pending_ids":["e146"],"pending_reason":false},"expect":{"status":"half_day","worked_min":0,"pending_min":300,"away_pending":true,"leave_units":0.5,"late_min":0}}]}$fx$::jsonb);

create function neo_v24t.put(p_k text, p_v text) returns void language plpgsql as $$
begin
  insert into neo_v24t.ctx (k, v) values (p_k, p_v) on conflict (k) do update set v = excluded.v;
end $$;
create function neo_v24t.get(p_k text) returns text language plpgsql volatile as $$
declare v text;
begin
  select c.v into v from neo_v24t.ctx c where c.k = p_k;
  if not found or v is null then raise exception 'TEST BUG: nothing stored under "%"', p_k; end if;
  return v;
end $$;
create function neo_v24t.email(p_alias text) returns text language plpgsql volatile as $$
declare v text;
begin
  select u.email into v from neo_v24t.users u where u.alias = p_alias;
  if not found then raise exception 'TEST SETUP: no test user "%"', p_alias; end if;
  return lower(v);
end $$;
create function neo_v24t.uid(p_alias text) returns uuid language plpgsql volatile as $$
declare v uuid;
begin
  select u.id into v from neo_v24t.users u where u.alias = p_alias;
  if not found then raise exception 'TEST SETUP: no test user "%"', p_alias; end if;
  return v;
end $$;
-- Sign in as a test user; p_session = the JWT's session_id (auth.sessions)
create function neo_v24t.login(p_alias text, p_session uuid default null) returns void language plpgsql as $$
declare u neo_v24t.users;
begin
  select * into u from neo_v24t.users where alias = p_alias;
  if not found then raise exception 'TEST SETUP: no test user "%"', p_alias; end if;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', u.id::text, true);
  perform set_config('request.jwt.claim.email', u.email, true);
  perform set_config('request.jwt.claims',
                     jsonb_strip_nulls(jsonb_build_object('sub', u.id, 'email', u.email, 'role', 'authenticated',
                                                          'session_id', p_session))::text, true);
end $$;
create function neo_v24t.login_anon() returns void language plpgsql as $$
begin
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.email', '', true);
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
end $$;
create function neo_v24t.no_jwt() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.email', '', true);
  perform set_config('request.jwt.claims', '', true);
end $$;
create function neo_v24t.assert(p_ok boolean, p_msg text) returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FAIL: %', p_msg; end if;
end $$;
create function neo_v24t.expect_error(p_sql text, p_like text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm not like p_like then
      raise exception 'FAIL: expected an error like "%" but got "%" from: %', p_like, sqlerrm, p_sql;
    end if;
    return;
  end;
  raise exception 'FAIL: expected an error like "%" but it succeeded: %', p_like, p_sql;
end $$;
create function neo_v24t.today() returns date language sql stable as $$
  select (now() at time zone 'Asia/Kolkata')::date
$$;
create function neo_v24t.d(p_days int) returns date language sql stable as $$
  select neo_v24t.today() + p_days
$$;
create function neo_v24t.at(p_days int, p_time text) returns timestamptz language sql stable as $$
  select ((neo_v24t.today() + p_days) + p_time::time) at time zone 'Asia/Kolkata'
$$;
-- The India day of an instant this many seconds ago (a fresh punch's session day).
create function neo_v24t.dago(p_seconds int) returns date language sql stable as $$
  select ((now() - p_seconds * interval '1 second') at time zone 'Asia/Kolkata')::date
$$;
-- A day of the previous month (always closed: travel allowance).
create function neo_v24t.lmd() returns date language sql stable as $$
  select date_trunc('month', neo_v24t.today())::date - 3
$$;
-- The office point of these tests and a fix p_m metres east of it.
create function neo_v24t.fix(p_m float8, p_acc float8 default 10) returns jsonb language sql immutable as $$
  select jsonb_strip_nulls(jsonb_build_object('lat', 10.0159, 'lng', 76.3419 + p_m / 109633.0, 'accuracy_m', p_acc))
$$;
-- A NeoHR 2.3 punch's own keys: versionCode, the fix's age, the fix.
create function neo_v24t.app(p_m float8 default 0, p_acc float8 default 10, p_fix_age int default 3000) returns jsonb language sql immutable as $$
  select jsonb_build_object('v', 20300, 'fix_age_ms', p_fix_age) || neo_v24t.fix(p_m, p_acc)
$$;
-- hr_punch: p_extra merged in; server-anchored when p_age_ms, else device time p_at (default now).
create function neo_v24t.punch(p_kind text, p_extra jsonb default '{}'::jsonb, p_age_ms bigint default null,
                               p_at timestamptz default null, p_id uuid default null) returns jsonb language plpgsql as $$
begin
  return public.hr_punch(jsonb_strip_nulls(jsonb_build_object('id', coalesce(p_id, gen_random_uuid()), 'kind', p_kind,
                                                              'at', coalesce(p_at, now()), 'age_ms', p_age_ms)) || coalesce(p_extra, '{}'::jsonb));
end $$;
-- A JPEG-looking blob of n bytes (random, so its md5 is new) and its base64.
create function neo_v24t.jpeg(p_n int, p_magic bytea default '\xffd8ffe0'::bytea) returns bytea language sql volatile as $$
  select substring(p_magic || (select string_agg(extensions.gen_random_bytes(1000), ''::bytea) from generate_series(1, p_n / 1000 + 1))
                   from 1 for p_n)
$$;
create function neo_v24t.b64(p bytea) returns text language sql immutable as $$
  select replace(encode(p, 'base64'), E'\n', '')
$$;
create function neo_v24t.photo(p_event uuid, p_jpeg bytea, p_extra jsonb default '{}'::jsonb) returns jsonb language plpgsql as $$
begin
  return public.hr_selfie_put(jsonb_build_object('event_id', p_event, 'taken_at', now(), 'jpeg_b64', neo_v24t.b64(p_jpeg),
                                                 'thumb_b64', neo_v24t.b64(neo_v24t.jpeg(1200)), 'w', 480, 'h', 360) || p_extra);
end $$;
create function neo_v24t.keys(p jsonb) returns text[] language sql immutable as $$
  select coalesce(array_agg(k order by k), '{}') from jsonb_object_keys(p) as k
$$;
create function neo_v24t.person(p_board jsonb, p_email text) returns jsonb language sql immutable as $$
  select e.value from jsonb_array_elements(coalesce(p_board -> 'people', '[]'::jsonb)) as e(value)
   where lower(e.value ->> 'email') = lower(p_email) limit 1
$$;
create function neo_v24t.req(p_list jsonb, p_id text) returns jsonb language sql immutable as $$
  select e.value from jsonb_array_elements(coalesce(p_list -> 'requests', '[]'::jsonb)) as e(value) where e.value ->> 'id' = p_id limit 1
$$;
grant execute on all functions in schema neo_v24t to anon, authenticated;

-- Owner-only helpers (created after the grant above, so no client may call them).
create function neo_v24t.raw_event(p_alias text, p_kind text, p_at timestamptz, p_source text default 'phone',
                                   p_received timestamptz default null) returns uuid language plpgsql as $$
declare v uuid := gen_random_uuid();
begin
  insert into public.attendance_events (id, profile_id, employee_email, kind, at, device_at, time_source, source, created_by_email, received_at)
  values (v, neo_v24t.uid(p_alias), neo_v24t.email(p_alias), p_kind, p_at, p_at, 'device', p_source, neo_v24t.email(p_alias),
          coalesce(p_received, now()));
  return v;
end $$;
create function neo_v24t.raw_points(p_alias text, p_points jsonb) returns int language plpgsql as $$
declare n int;
begin
  insert into public.location_points (client_point_id, profile_id, employee_email, at, device_at, time_source, lat, lng, accuracy_m)
  select gen_random_uuid(), neo_v24t.uid(p_alias), neo_v24t.email(p_alias), (x.value ->> 'at')::timestamptz,
         (x.value ->> 'at')::timestamptz, 'device', (x.value ->> 'lat')::float8, (x.value ->> 'lng')::float8,
         (x.value ->> 'accuracy_m')::float8
    from jsonb_array_elements(p_points) as x(value);
  get diagnostics n = row_count;
  return n;
end $$;
create function neo_v24t.ev(p_id uuid) returns public.attendance_events language sql stable as $$
  select * from public.attendance_events where id = p_id
$$;
create function neo_v24t.rq(p_event uuid) returns public.hr_requests language sql stable as $$
  select * from public.hr_requests where event_id = p_event
$$;
revoke all on function neo_v24t.raw_event(text, text, timestamptz, text, timestamptz) from public, anon, authenticated;
revoke all on function neo_v24t.raw_points(text, jsonb) from public, anon, authenticated;
revoke all on function neo_v24t.ev(uuid) from public, anon, authenticated;
revoke all on function neo_v24t.rq(uuid) from public, anon, authenticated;


-- ── 1. Test users, settings, tickets ─────────────────────────────────────────
do $$
begin
  if exists (select 1 from public.profiles where lower(email) like 'zq.v24.%@neotokyo.test')
     or exists (select 1 from auth.users where lower(email) like 'zq.v24.%@neotokyo.test') then
    raise exception 'TEST SETUP: zq.v24.*@neotokyo.test logins already exist; change the test emails in this file';
  end if;
  if exists (select 1 from public.service_jobs where id like 's\_v24\_%') or exists (select 1 from public.rma_cases where id like 'r\_v24\_%') then
    raise exception 'TEST SETUP: s_v24_* / r_v24_* ids are already in use';
  end if;
end $$;

insert into auth.users (id, email, raw_user_meta_data)
select x.id::uuid, x.email, jsonb_build_object('full_name', x.name)
  from (values
    ('c3333333-0000-4000-8000-000000000001', 'zq.v24.fe@neotokyo.test', 'Zqv Field'),
    ('c3333333-0000-4000-8000-000000000002', 'zq.v24.fe2@neotokyo.test', 'Zqv Tripper'),
    ('c3333333-0000-4000-8000-000000000003', 'zq.v24.desk@neotokyo.test', 'Zqv Desk'),
    ('c3333333-0000-4000-8000-000000000004', 'zq.v24.desk2@neotokyo.test', 'Zqv Desktwo'),
    ('c3333333-0000-4000-8000-000000000005', 'zq.v24.sales@neotokyo.test', 'Zqv Sales'),
    ('c3333333-0000-4000-8000-000000000006', 'zq.v24.hr@neotokyo.test', 'Zqv Hr'),
    ('c3333333-0000-4000-8000-000000000007', 'zq.v24.head3@neotokyo.test', 'Zqv Head'),
    ('c3333333-0000-4000-8000-000000000008', 'zq.v24.ceo4@neotokyo.test', 'Zqv Ceo'),
    ('c3333333-0000-4000-8000-000000000009', 'zq.v24.own5@neotokyo.test', 'Zqv Owner'),
    ('c3333333-0000-4000-8000-000000000010', 'zq.v24.supply@neotokyo.test', 'Zqv Supply'),
    ('c3333333-0000-4000-8000-000000000011', 'zq.v24.basic@neotokyo.test', 'Zqv Basic'),
    ('c3333333-0000-4000-8000-000000000012', 'zq.v24.cap@neotokyo.test', 'Zqv Cap'),
    ('c3333333-0000-4000-8000-000000000013', 'zq.v24.pic@neotokyo.test', 'Zqv Pic'),
    ('c3333333-0000-4000-8000-000000000014', 'zq.v24.wfh@neotokyo.test', 'Zqv Home'),
    ('c3333333-0000-4000-8000-000000000015', 'zq.v24.oldapp@neotokyo.test', 'Zqv Oldapp'),
    ('c3333333-0000-4000-8000-000000000016', 'zq.v24.r2@neotokyo.test', 'Zqv Lenient'),
    ('c3333333-0000-4000-8000-000000000017', 'zq.v24.ta@neotokyo.test', 'Zqv Allowance')) as x(id, email, name);
update public.profiles p
   set full_name = u.raw_user_meta_data ->> 'full_name', active = true, is_staff = true, created_at = '2020-01-01',
       tier = x.tier, department = x.dept, designation = x.des
  from auth.users u,
       (values ('zq.v24.fe@neotokyo.test', 2, 'service', 'Service Engineer'),
               ('zq.v24.fe2@neotokyo.test', 2, 'service', 'Service Engineer'),
               ('zq.v24.desk@neotokyo.test', 2, 'support', 'Help Desk Coordinator'),
               ('zq.v24.desk2@neotokyo.test', 2, 'support', 'Customer Success Executive'),
               ('zq.v24.sales@neotokyo.test', 1, 'sales', 'Sales Executive'),
               ('zq.v24.hr@neotokyo.test', 2, 'hr', 'HR Executive'),
               ('zq.v24.head3@neotokyo.test', 3, 'service', 'Service Department Head'),
               ('zq.v24.ceo4@neotokyo.test', 4, 'exec', 'Zq Founder'),
               ('zq.v24.own5@neotokyo.test', 5, 'service', 'Zq Owner'),
               ('zq.v24.supply@neotokyo.test', 1, 'procurement', 'Procurement Associate'),
               ('zq.v24.basic@neotokyo.test', 1, 'marketing', 'Creative Associate'),
               ('zq.v24.cap@neotokyo.test', 1, 'tech', 'Zq Tester'),
               ('zq.v24.pic@neotokyo.test', 2, 'tech', 'Zq Tester'),
               ('zq.v24.wfh@neotokyo.test', 2, 'tech', 'Zq Tester'),
               ('zq.v24.oldapp@neotokyo.test', 2, 'tech', 'Zq Tester'),
               ('zq.v24.r2@neotokyo.test', 2, 'service', 'Zq Tester'),
               ('zq.v24.ta@neotokyo.test', 2, 'service', 'Service Engineer')) as x(email, tier, dept, des)
 where u.id = p.id and p.email = x.email;

insert into neo_v24t.users (alias, id, email, tier, name)
select replace(split_part(p.email, '@', 1), 'zq.v24.', ''), p.id, lower(p.email), p.tier, p.full_name
  from public.profiles p where p.email like 'zq.v24.%@neotokyo.test';

do $$
begin
  if (select count(*) from neo_v24t.users) <> 17 then raise exception 'TEST SETUP: missing profiles (%)', (select count(*) from neo_v24t.users); end if;
  if exists (select 1 from neo_v24t.users u join public.profiles p on p.id = u.id where not p.active or not p.is_staff) then
    raise exception 'TEST SETUP: every test user must be active staff';
  end if;
end $$;

-- Roles: hr is a NeoHR lead (tier 2); fe / fe2 / r2 / ta are service technicians; desk has a desk role.
delete from public.module_access where profile_id in (select id from neo_v24t.users);
insert into public.module_access (profile_id, module, role, granted_by)
select u.id, m.module, m.role, 'tests'
  from neo_v24t.users u
  join (values ('hr', 'neohr', 'lead'), ('fe', 'service', 'tech'), ('fe2', 'service', 'tech'), ('r2', 'service', 'tech'),
               ('ta', 'service', 'tech'), ('desk', 'service', 'desk'), ('desk', 'rma', 'desk')) as m(alias, module, role)
    on m.alias = u.alias;
-- Field staff (D1): fe, fe2, own5, r2, ta. Everyone else has a row too: ta_eligible true, not field staff.
delete from public.hr_person where profile_id in (select id from neo_v24t.users);
insert into public.hr_person (profile_id, track_location, ta_eligible, updated_by)
select u.id, u.alias in ('fe', 'fe2', 'own5', 'r2', 'ta'), true, 'tests' from neo_v24t.users u;

-- Pin the shift, the settings and the near holidays (as v2.3's tests); no office point yet.
delete from public.hr_shift_history
 where profile_id is null and effective_from > (select min(h.effective_from) from public.hr_shift_history h where h.profile_id is null);
update public.hr_shift_history set shift_start = '09:30', shift_end = '18:30', grace_min = 10, weekly_off = '{}', half_day_min = 240
 where profile_id is null;
update public.hr_settings
   set shift_start = '09:30', shift_end = '18:30', grace_min = 10, weekly_off = '{}', half_day_min = 240,
       max_session_h = 16, track_interval_s = 120, track_distance_m = 100, retention_days = 90, ta_rate_per_km = null,
       office_lat = null, office_lng = null, office_radius_m = 150, last_purge_at = now(), attendance_from = '2020-01-01'
 where id = 1;
delete from public.hr_holidays where day between neo_v24t.d(-130) and neo_v24t.d(130);
delete from public.hr_roster where profile_id in (select id from neo_v24t.users);
delete from public.hr_shift_history where profile_id in (select id from neo_v24t.users);

-- fe2's on-site job and fe's RMA part, and a job / part that are someone else's.
select set_config('neo.migrating', '1', true);
insert into public.service_jobs (id, public_code, model_version, service_type, stage, stage_since, customer_name, customer_phone,
                                 device_label, category, assignee, assignee_email, assigned_via, assigned_at, site_address, site_area)
values ('s_v24_j1', 'NT-ZQV24J01', 2, 'on_site', 'scheduled', now(), 'Zqv Customer One', '9000000911', 'Zq Router', 'networking',
        'Zqv Field', 'zq.v24.fe@neotokyo.test', 'claim', now(), '1 Zq Road', 'Zqarea'),
       ('s_v24_j2', 'NT-ZQV24J02', 2, 'on_site', 'scheduled', now(), 'Zqv Customer Two', '9000000912', 'Zq Printer', 'repair',
        'Zqv Tripper', 'zq.v24.fe2@neotokyo.test', 'claim', now(), '2 Zq Road', 'Zqarea');
select set_config('neo.migrating', '', true);
insert into public.rma_intakes (id, source, sender_kind) values ('r_v24_i1', 'walk_in', 'customer');
insert into public.rma_cases (id, public_code, intake_id, kind, brand, model, serial, fault, stage, handler_email, handler_name)
values ('r_v24_c1', 'RM-ZQV24R01', 'r_v24_i1', 'ssd', 'Zq', 'Disk 1', 'ZQV24SER1', 'Clicks', 'with_tech', 'zq.v24.desk@neotokyo.test', 'Zqv Desk');


-- ── 2. Schema facts, R1 signatures, R4 grants, the field-staff seed (owner) ──
do $$
declare
  f record; t text; n int;
  v_new text[] := array['_hr_is_field', '_hr_dash_view', '_hr_place', '_hr_can_decide', '_hr_decide_gate', '_hr_sees', '_hr_selfie_brief',
    '_hr_unverified', '_hr_day_totals', '_hr_is_late_punch', '_hr_msg', '_hr_punch_extras', '_hr_punch_core', '_hr_punch_check',
    '_hr_punch_request', '_hr_session_at', '_hr_trip_eff', '_hr_trip_measure', '_hr_trip_json', '_hr_trip_sync', '_hr_trip_begin',
    '_hr_day_trips', '_hr_month_trip_km', '_hr_dash_hr', '_hr_req_acts', '_hr_trip_km_days',
    'hr_selfie_put', 'hr_selfie_get', 'hr_punch_checks', 'hr_punch_request_decide', 'hr_trip_start', 'hr_trip_end'];
  v_api text[] := array['hr_selfie_put', 'hr_selfie_get', 'hr_punch_checks', 'hr_punch_request_decide', 'hr_trip_start', 'hr_trip_end',
    'my_work_profile'];
begin
  -- R1: every redefined function keeps its v2.3 / v2.2 identity and result, and is the only one of its name
  for f in select * from (values
      ('_hr_lockdown', '', 'void'),
      ('_hr_tracking', 'p_email text, p_profile uuid, p_now timestamp with time zone, p_state jsonb', 'jsonb'),
      ('location_push', 'p_points jsonb', 'jsonb'),
      ('hr_settings_get', '', 'jsonb'),
      ('hr_person_set', 'p_email text, p jsonb', 'jsonb'),
      ('hr_punch', 'p jsonb', 'jsonb'),
      ('_hr_punch_apply', 'p_email text, p_id uuid, p_kind text, p_at timestamp with time zone, p_age_ms numeric, p_lat double precision, p_lng double precision, p_acc double precision, p_note text', 'jsonb'),
      ('hr_my_day', 'p_day date, p_email text', 'jsonb'),
      ('hr_my_month', 'p_month date', 'jsonb'),
      ('hr_register', 'p_from date, p_to date, p_email text', 'jsonb'),
      ('hr_route', 'p_email text, p_day date', 'jsonb'),
      ('hr_dashboard', '', 'jsonb'),
      ('hr_board', '', 'jsonb'),
      ('_hr_live', 'p_prof profiles, p_now timestamp with time zone', 'jsonb'),
      ('_hr_day_calc', 'p jsonb', 'jsonb'),
      ('_hr_days', 'p_email text, p_from date, p_to date, p_now timestamp with time zone, p_marks boolean', 'jsonb'),
      ('hr_request_decide', 'p_id uuid, p_approve boolean, p_note text', 'jsonb'),
      ('hr_request_cancel', 'p_id uuid, p_note text', 'jsonb'),
      ('hr_requests_list', 'p_scope text, p_from date, p_to date', 'jsonb'),
      ('_hr_req_json', 'r hr_requests', 'jsonb'),
      ('hr_ta_report', 'p_month date', 'jsonb'),
      ('hr_ta_approve', 'p_email text, p_month date, p_note text, p_expected_km numeric', 'jsonb'),
      ('_hr_purge', 'p_max_rows integer', 'jsonb'),
      ('hr_correct', 'p_email text, p jsonb', 'jsonb'),
      ('my_work_profile', '', 'jsonb'),
      ('_hr_ctx', 'p_profile uuid, p_email text, p_from date, p_to date',
       'TABLE(day date, duty text, duty_source text, duty_note text, request_id uuid, holiday text, shift_start time without time zone, shift_end time without time zone, grace_min integer, weekly_off integer[], half_day_min integer, flex_request boolean, half_day_leave boolean)'),
      ('hr_request_create', 'p jsonb', 'jsonb'),
      ('record_field_activity', 'p jsonb', 'jsonb')) as x(name, args, res) loop
    select count(*) into n from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = f.name;
    perform neo_v24t.assert(n = 1, format('R1: %s exists exactly once (%s)', f.name, n));
    perform neo_v24t.assert((select pg_get_function_identity_arguments(p.oid) from pg_proc p
                              where p.pronamespace = 'public'::regnamespace and p.proname = f.name) = f.args,
                            format('R1: %s keeps its arguments (%s)', f.name,
                                   (select pg_get_function_identity_arguments(p.oid) from pg_proc p
                                     where p.pronamespace = 'public'::regnamespace and p.proname = f.name)));
    perform neo_v24t.assert((select pg_get_function_result(p.oid) from pg_proc p
                              where p.pronamespace = 'public'::regnamespace and p.proname = f.name) = f.res,
                            format('R1: %s keeps its result type', f.name));
  end loop;
  perform neo_v24t.assert(pg_get_functiondef('public._hr_purge(integer)'::regprocedure) like '%p_max_rows integer DEFAULT NULL%',
                          'R1: _hr_purge(p_max_rows int default null): the cron and location_push still call it');
  -- R4: every new function — no anon; the API for authenticated; internals for service_role only
  foreach t in array v_new loop
    select count(*) into n from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = t;
    perform neo_v24t.assert(n = 1, 'R4: ' || t || ' exists once');
    select p.oid, p.prosecdef, p.proconfig into f from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = t;
    perform neo_v24t.assert(not has_function_privilege('anon', f.oid, 'execute'), 'R4: anon cannot execute ' || t);
    perform neo_v24t.assert(has_function_privilege('service_role', f.oid, 'execute'), 'R4: service_role may execute ' || t);
    perform neo_v24t.assert(array_to_string(f.proconfig, ',') like '%search_path=public%', t || ' pins search_path');
    if t = any (v_api) then
      perform neo_v24t.assert(has_function_privilege('authenticated', f.oid, 'execute') and f.prosecdef,
                              'R4: authenticated may execute ' || t || ' (security definer)');
    else
      perform neo_v24t.assert(not has_function_privilege('authenticated', f.oid, 'execute'), 'R4: authenticated cannot execute ' || t);
    end if;
  end loop;
  perform neo_v24t.assert(has_function_privilege('authenticated', 'public.my_work_profile()', 'execute')
                          and not has_function_privilege('anon', 'public.my_work_profile()', 'execute'),
                          'my_work_profile: authenticated, never anon');
  -- the overview RPCs (sql/neohr-hr-v2.4-overview.sql), when applied: in the same API list
  for f in select p.oid, p.proname from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.proname in ('neo_overview', 'neo_overview_list') loop
    perform neo_v24t.assert(not has_function_privilege('anon', f.oid, 'execute') and has_function_privilege('authenticated', f.oid, 'execute'),
                            f.proname || ': authenticated, never anon');
  end loop;
  -- new tables: RLS on, no client privilege at all, not in realtime
  foreach t in array array['hr_punch_selfies', 'hr_selfie_views', 'hr_trips'] loop
    perform neo_v24t.assert((select relrowsecurity from pg_class where oid = format('public.%I', t)::regclass), t || ': RLS is on');
    perform neo_v24t.assert(not has_table_privilege('anon', format('public.%I', t), 'select, insert, update, delete, truncate, references, trigger')
                            and not has_table_privilege('authenticated', format('public.%I', t), 'select, insert, update, delete, truncate, references, trigger'),
                            'R4: ' || t || ': no client privilege');
    perform neo_v24t.assert(not exists (select 1 from pg_publication_tables where tablename = t), 'R6: ' || t || ' is not in realtime');
  end loop;
  perform neo_v24t.assert(not has_sequence_privilege('anon', pg_get_serial_sequence('public.hr_selfie_views', 'id'), 'usage, select, update')
                          and not has_sequence_privilege('authenticated', pg_get_serial_sequence('public.hr_selfie_views', 'id'), 'usage, select, update'),
                          'R4: the hr_selfie_views sequence is the definer code''s only');
  perform neo_v24t.assert(not has_table_privilege('authenticated', 'public.attendance_events', 'select')
                          and not has_column_privilege('authenticated', 'public.attendance_events', 'lat', 'select')
                          and not has_column_privilege('authenticated', 'public.attendance_events', 'lng', 'select'),
                          'R4: no client reads attendance_events (its coordinates stay inside)');
  -- the new constraints and the one-request-per-punch index
  perform neo_v24t.assert((select pg_get_constraintdef(oid) from pg_constraint where conname = 'hr_requests_kind_check'
                            and conrelid = 'public.hr_requests'::regclass) like '%punch_reason%away_punch%',
                          'hr_requests.kind allows punch_reason and away_punch');
  perform neo_v24t.assert(exists (select 1 from pg_indexes where indexname = 'hrq_event_idx' and indexdef like '%UNIQUE%(event_id)%'),
                          'one request per punch (unique event_id)');
  perform neo_v24t.assert((select string_agg(conname, ',' order by conname) from pg_constraint
                            where conrelid = 'public.attendance_events'::regclass and conname in
                              ('attendance_events_place_check', 'attendance_events_verify_check', 'attendance_events_reason_kind_check',
                               'attendance_events_selfie_skip_check'))
                          = 'attendance_events_place_check,attendance_events_reason_kind_check,attendance_events_selfie_skip_check,attendance_events_verify_check',
                          'the new attendance_events CHECKs');
  -- D1: the seed (first run) and the defaults
  perform neo_v24t.assert((select column_default from information_schema.columns where table_schema = 'public' and table_name = 'hr_person'
                            and column_name = 'track_location') = 'false'
                          and (select column_default from information_schema.columns where table_schema = 'public' and table_name = 'hr_person'
                                and column_name = 'ta_eligible') = 'false',
                          'D1: a new person is not field staff and gets no travel allowance');
  perform neo_v24t.assert(not exists (select 1 from public.hr_person hp
                                        join public.profiles p on p.id = hp.profile_id
                                        left join public.staff_work sw on sw.profile_id = p.id
                                       where hp.updated_by = 'neohr_hr_v2_4'
                                         and (hp.track_location is distinct from (p.active and coalesce(p.is_staff, false) and coalesce(sw.service_pool, false))
                                              or hp.ta_eligible is distinct from hp.track_location)),
                          'D1: every seeded row is field staff exactly when the person was active staff in the service pool');
  perform neo_v24t.assert(not public._hr_is_field(gen_random_uuid()) and public._hr_is_field(neo_v24t.uid('fe'))
                          and not public._hr_is_field(neo_v24t.uid('desk')), '_hr_is_field: the row, else not field staff');
  -- R6: the photo store cap lives in hr_selfie_put (a 200 MB store cannot be filled in a test)
  perform neo_v24t.assert(pg_get_functiondef('public.hr_selfie_put(jsonb)'::regprocedure) like '%pg_total_relation_size(''public.hr_punch_selfies'') > 200 * 1024 * 1024%'
                          and pg_get_functiondef('public.hr_selfie_put(jsonb)'::regprocedure) like '%NEO_GATE: The photo store is full — tell the owner.%',
                          'R6: "NEO_GATE: The photo store is full — tell the owner." once the photos pass 200 MB');
  perform neo_v24t.assert(pg_get_functiondef('public.neo_dashboard()'::regprocedure) not like '%_hr_%', 'neo_dashboard is untouched');
end $$;


-- ── 3. Pure parts: the v2.4 day fixture, places, lenient keys, views, deciders ─
reset role;
select neo_v24t.no_jwt();
do $$
declare c jsonb; r jsonb; k text; v_a text; v_b text; n int := 0; x jsonb;
begin
  -- tests/fixtures/hr-day-v24.json through _hr_day_calc
  for c in select y.value from neo_v24t.fx f, jsonb_array_elements(f.body -> 'cases') as y(value) where f.name = 'hr-day-v24' loop
    r := public._hr_day_calc(c -> 'input');
    for k in select jsonb_object_keys(c -> 'expect') loop
      v_a := r ->> k; v_b := c -> 'expect' ->> k;
      if k in ('first_in', 'last_out') and v_a is not null and v_b is not null then
        perform neo_v24t.assert(v_a::timestamptz = v_b::timestamptz, format('day fixture %s: %s %s, expected %s', c ->> 'name', k, v_a, v_b));
      elsif k in ('leave_units', 'absent_units') then
        perform neo_v24t.assert(v_a::numeric = v_b::numeric, format('day fixture %s: %s %s, expected %s', c ->> 'name', k, v_a, v_b));
      else
        perform neo_v24t.assert(v_a is not distinct from v_b, format('day fixture %s: %s %s, expected %s', c ->> 'name', k, v_a, v_b));
      end if;
    end loop;
    n := n + 1;
  end loop;
  perform neo_v24t.assert(n >= 15, 'every v2.4 day fixture case ran (' || n || ')');

  -- §1.3.3 the place, office point not set yet
  perform neo_v24t.assert(public._hr_place(10.0159, 76.3419, 10) = '{"place": "unset", "office_m": null, "verify": "ok"}'::jsonb,
                          'no office point: unset');
  update public.hr_settings set office_lat = 10.0159, office_lng = 76.3419, office_radius_m = 150 where id = 1;
  perform neo_v24t.assert(public._hr_place(10.0159, 76.3419, 10) ->> 'place' = 'office' and public._hr_place(10.0159, 76.3419, 10) ->> 'verify' = 'ok'
                          and (public._hr_place(10.0159, 76.3419, 10) ->> 'office_m')::int = 0, 'at the office, 10 m: office ok');
  x := public._hr_place(10.0159, 76.3419 + 1000 / 109633.0, 10);
  perform neo_v24t.assert(x ->> 'place' = 'away' and x ->> 'verify' = 'ok' and (x ->> 'office_m')::int between 990 and 1010, '1 km away: away ' || x::text);
  perform neo_v24t.assert(public._hr_place(null, null, null) = '{"place": "unknown", "office_m": null, "verify": "no_fix"}'::jsonb, 'no fix: unknown');
  x := public._hr_place(10.0159, 76.3419, null);
  perform neo_v24t.assert(x ->> 'place' = 'unknown' and x ->> 'verify' = 'no_fix', 'no accuracy: unknown, no_fix ' || x::text);
  x := public._hr_place(10.0159, 76.3419 + 50 / 109633.0, 150);
  perform neo_v24t.assert(x ->> 'place' = 'office' and x ->> 'verify' = 'weak_fix', '±150 m with the centre inside: office, weak ' || x::text);
  x := public._hr_place(10.0159, 76.3419 + 500 / 109633.0, 150);
  perform neo_v24t.assert(x ->> 'place' = 'unknown' and x ->> 'verify' = 'weak_fix', '±150 m with the centre outside: unknown, weak ' || x::text);
  x := public._hr_place(10.0159, 76.3419 + 100 / 109633.0, 80);
  perform neo_v24t.assert(x ->> 'place' = 'office' and x ->> 'verify' = 'weak_fix', '±80 m: by distance, weak ' || x::text);
  x := public._hr_place(10.0159, 76.3419 + 1000 / 109633.0, 80);
  perform neo_v24t.assert(x ->> 'place' = 'away' and x ->> 'verify' = 'weak_fix', '±80 m far away: away, weak ' || x::text);
  x := public._hr_place(10.0159, 76.3419 + 140 / 109633.0, 50);
  perform neo_v24t.assert(x ->> 'place' = 'office' and x ->> 'verify' = 'ok', '±50 m at 140 m: office, ok ' || x::text);
  update public.hr_settings set office_lat = null, office_lng = null where id = 1;

  -- R2: the v2.4 keys are read leniently — a bad value is dropped and named, nothing raises
  x := public._hr_punch_extras('{"v": "abc", "fix_age_ms": "x", "mock": "maybe", "restored": 7, "selfie_skip": "nope", "flags": [1, 2]}'::jsonb);
  perform neo_v24t.assert(not (x ? 'v') and not (x ? 'fix_age_ms') and not (x ? 'mock') and not (x ? 'restored') and not (x ? 'selfie_skip')
                          and not (x ? 'flags')
                          and (x -> 'dropped') @> '["v", "fix_age_ms", "mock", "restored", "selfie_skip", "flags"]'::jsonb,
                          'R2: junk values are dropped and listed ' || x::text);
  x := public._hr_punch_extras(jsonb_build_object('v', 20300, 'fix_age_ms', '4500', 'mock', 'false', 'restored', true,
         'reason', jsonb_build_object('kind', 'LATE', 'text', '  ' || repeat('x', 600), 'ref', 'nt-abcd1234'),
         'selfie_skip', 'camera_error', 'flags', jsonb_build_object('dev_options', true), 'trip', jsonb_build_object('id', 'not-a-uuid')));
  perform neo_v24t.assert((x ->> 'v')::int = 20300 and (x ->> 'fix_age_ms')::int = 4500 and x ->> 'mock' = 'false' and x ->> 'restored' = 'true'
                          and x -> 'reason' ->> 'kind' = 'late' and char_length(x -> 'reason' ->> 'text') = 500
                          and x -> 'reason' ->> 'ref' = 'NT-ABCD1234' and x ->> 'selfie_skip' = 'camera_error'
                          and x -> 'flags' ->> 'dev_options' = 'true' and x -> 'trip' -> 'id' = 'null'::jsonb
                          and (x -> 'dropped') @> '["reason.text", "trip"]'::jsonb,
                          'R2: good values kept (cut to 500, upper-cased), a bad trip id named ' || x::text);
  x := public._hr_punch_extras('{"reason": "late"}'::jsonb);
  perform neo_v24t.assert(not (x ? 'reason') and (x -> 'dropped') @> '["reason"]'::jsonb, 'R2: a reason that is not an object ' || x::text);
  x := public._hr_punch_extras('{"reason": {"kind": 5, "text": "Bus broke down", "ref": "BAD"}}'::jsonb);
  perform neo_v24t.assert(x -> 'reason' ->> 'kind' = 'other' and x -> 'reason' ->> 'ref' is null
                          and (x -> 'dropped') @> '["reason.kind", "reason.ref"]'::jsonb, 'R2: an unknown kind with text is "other" ' || x::text);
  x := public._hr_punch_extras('{"reason": {"kind": "late", "text": "ok"}}'::jsonb);
  perform neo_v24t.assert(x -> 'reason' ->> 'kind' = 'late' and x -> 'reason' ->> 'text' is null, 'R2: a text under 3 characters is no text ' || x::text);
  perform neo_v24t.assert(public._hr_punch_extras('{}'::jsonb) = '{"dropped": []}'::jsonb and public._hr_punch_extras(null) = '{"dropped": []}'::jsonb,
                          'R2: a v2.3 payload has no v2.4 keys');
  perform neo_v24t.assert(public._hr_msg('NEO_GATE: Trips are for field staff.') = 'Trips are for field staff.' and public._hr_msg('boom') is null,
                          '_hr_msg strips the prefix');

  -- §6 the dashboard view of each person (their own tier and roles)
  perform neo_v24t.assert(public._hr_dash_view(neo_v24t.uid('head3')) = 'head' and public._hr_dash_view(neo_v24t.uid('ceo4')) = 'head'
                          and public._hr_dash_view(neo_v24t.uid('own5')) = 'head' and public._hr_dash_view(neo_v24t.uid('hr')) = 'hr'
                          and public._hr_dash_view(neo_v24t.uid('fe')) = 'field' and public._hr_dash_view(neo_v24t.uid('desk')) = 'desk'
                          and public._hr_dash_view(neo_v24t.uid('desk2')) = 'desk' and public._hr_dash_view(neo_v24t.uid('supply')) = 'supply'
                          and public._hr_dash_view(neo_v24t.uid('sales')) = 'sales' and public._hr_dash_view(neo_v24t.uid('basic')) = 'basic'
                          and public._hr_dash_view(gen_random_uuid()) = 'basic',
                          '_hr_dash_view: head · hr · field · desk · supply · sales · basic');
  -- F30: the departments come before a desk role — procurement / logistics staff with a desk role still get supply;
  -- a desk role alone (any other department) is desk
  insert into public.module_access (profile_id, module, role, granted_by)
  values (neo_v24t.uid('supply'), 'rma', 'desk', 'tests'), (neo_v24t.uid('supply'), 'qc', 'desk', 'tests'),
         (neo_v24t.uid('basic'), 'service', 'desk', 'tests');
  perform neo_v24t.assert(public._hr_dash_view(neo_v24t.uid('supply')) = 'supply' and public._hr_dash_view(neo_v24t.uid('basic')) = 'desk',
                          'F30: procurement with RMA / Builds desk roles → supply; marketing with a service desk role → desk');
  update public.profiles set department = 'Logistics' where id = neo_v24t.uid('supply');
  perform neo_v24t.assert(public._hr_dash_view(neo_v24t.uid('supply')) = 'supply', 'F30: logistics (any case) with a desk role → supply');
  update public.profiles set department = 'support' where id = neo_v24t.uid('supply');
  perform neo_v24t.assert(public._hr_dash_view(neo_v24t.uid('supply')) = 'desk', 'F30: department support stays desk');
  update public.profiles set department = 'procurement' where id = neo_v24t.uid('supply');
  delete from public.module_access where profile_id in (neo_v24t.uid('supply'), neo_v24t.uid('basic')) and granted_by = 'tests' and role = 'desk';
  perform neo_v24t.assert(public._hr_dash_view(neo_v24t.uid('supply')) = 'supply' and public._hr_dash_view(neo_v24t.uid('basic')) = 'basic',
                          'F30: back as they were');
  -- D10 the decider rule
  perform neo_v24t.assert(public._hr_can_decide(neo_v24t.uid('hr'), neo_v24t.email('fe'))
                          and public._hr_can_decide(neo_v24t.uid('head3'), neo_v24t.email('fe'))
                          and not public._hr_can_decide(neo_v24t.uid('head3'), neo_v24t.email('own5'))
                          and not public._hr_can_decide(neo_v24t.uid('hr'), neo_v24t.email('ceo4'))
                          and public._hr_can_decide(neo_v24t.uid('ceo4'), neo_v24t.email('own5'))
                          and public._hr_can_decide(neo_v24t.uid('own5'), neo_v24t.email('ceo4'))
                          and not public._hr_can_decide(neo_v24t.uid('own5'), neo_v24t.email('own5'))
                          and not public._hr_can_decide(neo_v24t.uid('sales'), neo_v24t.email('fe'))
                          and not public._hr_can_decide(neo_v24t.uid('fe'), neo_v24t.email('desk')),
                          'D10: not your own; a tier 4 / 5 account only by tier 4+; only a NeoHR lead');
end $$;


-- ── 4. "Me" for the clients (my_work_profile, hr_settings_get, hr_dashboard) ─
select neo_v24t.login('fe');
do $$
declare r jsonb;
begin
  r := public.my_work_profile();
  perform neo_v24t.assert(r ->> 'field_staff' = 'true' and r ->> 'dash_view' = 'field' and r ->> 'hr_approver' = 'false'
                          and r ?& array['id', 'email', 'modules', 'home', 'team_view', 'desk_service'],
                          'my_work_profile: field_staff, dash_view, hr_approver added to the v2.2 keys ' || r::text);
  r := public.hr_settings_get();
  perform neo_v24t.assert(r -> 'me' ->> 'field_staff' = 'true' and r -> 'me' ->> 'ta_eligible' = 'true' and r -> 'me' ->> 'dash_view' = 'field'
                          and jsonb_array_length(r -> 'me' -> 'days') = 7 and (r -> 'me' -> 'days' -> 0 ->> 'day')::date = neo_v24t.today()
                          and (r -> 'me' -> 'days' -> 0) ?& array['day', 'duty', 'shift_start', 'shift_end', 'grace_min', 'holiday']
                          and r -> 'me' -> 'days' -> 0 ->> 'shift_start' = '09:30' and not (r ? 'selfie_store_bytes') and not (r ? 'people'),
                          'hr_settings_get().me: field_staff, ta_eligible, dash_view, 7 days ' || (r -> 'me')::text);
  r := public.hr_dashboard();
  perform neo_v24t.assert(r -> 'me' ->> 'field_staff' = 'true' and not (r ? 'hr'), 'hr_dashboard().me.field_staff ' || r::text);
end $$;
select neo_v24t.login('desk');
do $$
declare r jsonb;
begin
  r := public.hr_settings_get();
  perform neo_v24t.assert(r -> 'me' ->> 'field_staff' = 'false' and r -> 'me' ->> 'ta_eligible' = 'false' and r -> 'me' ->> 'dash_view' = 'desk'
                          and r -> 'me' -> 'tracking' ->> 'reason' = 'disabled',
                          'not field staff: no allowance (ta_eligible AND field), tracking disabled ' || (r -> 'me')::text);
  r := public.my_work_profile();
  perform neo_v24t.assert(r ->> 'field_staff' = 'false' and r ->> 'dash_view' = 'desk' and r ->> 'hr_approver' = 'false', 'desk ' || r::text);
end $$;
select neo_v24t.login('hr');
do $$
declare r jsonb;
begin
  r := public.my_work_profile();
  perform neo_v24t.assert(r ->> 'hr_approver' = 'true' and r ->> 'dash_view' = 'hr' and r ->> 'team_view' = 'true', 'a NeoHR lead ' || r::text);
  r := public.hr_dashboard();
  perform neo_v24t.assert(r ? 'hr' and (r -> 'hr') ?& array['on_duty', 'on_break', 'on_site', 'absent', 'not_in_yet', 'pending_requests',
                                                         'late_today', 'away_pending', 'reasons_pending', 'past_eod', 'unverified_today',
                                                         'unseen_photos', 'on_trip'],
                          'hr_dashboard().hr: v2.3 keys plus the v2.4 counts ' || (r -> 'hr')::text);
end $$;
select neo_v24t.login('ceo4');
do $$
declare r jsonb;
begin
  r := public.hr_settings_get();
  perform neo_v24t.assert((r ->> 'selfie_store_bytes')::bigint >= 0
                          and neo_v24t.person(r, neo_v24t.email('fe')) ->> 'field_staff' = 'true'
                          and neo_v24t.person(r, neo_v24t.email('desk')) ->> 'track_location' = 'false',
                          'tier 4: the photo store size and the field-staff switch per person');
  -- hr_person_set: the field switch takes the allowance with it, unless the same change says otherwise
  r := public.hr_person_set(neo_v24t.email('desk2'), '{"track_location": true}'::jsonb);
  perform neo_v24t.assert(r -> 'person' ->> 'track_location' = 'true' and r -> 'person' ->> 'ta_eligible' = 'true', 'field on: allowance on ' || r::text);
  r := public.hr_person_set(neo_v24t.email('desk2'), '{"track_location": false}'::jsonb);
  perform neo_v24t.assert(r -> 'person' ->> 'track_location' = 'false' and r -> 'person' ->> 'ta_eligible' = 'false', 'field off: allowance off ' || r::text);
  r := public.hr_person_set(neo_v24t.email('desk2'), '{"track_location": true, "ta_eligible": false}'::jsonb);
  perform neo_v24t.assert(r -> 'person' ->> 'track_location' = 'true' and r -> 'person' ->> 'ta_eligible' = 'false', 'both in one change ' || r::text);
  r := public.hr_person_set(neo_v24t.email('desk2'), '{"track_location": false, "ta_eligible": true}'::jsonb);
  perform neo_v24t.assert(r -> 'person' ->> 'track_location' = 'false' and r -> 'person' ->> 'ta_eligible' = 'true', 'back to not field staff ' || r::text);
end $$;


-- ── 5. Trips (D7, D8) ──────────────────────────────────────────────────────
select neo_v24t.login('desk');
do $$
begin
  perform neo_v24t.expect_error(format('select public.hr_trip_start(%L::jsonb)', jsonb_build_object('id', gen_random_uuid(), 'kind', 'on_site', 'note', 'Site')),
                                '%NEO_GATE: Trips are for field staff.%');
end $$;
select neo_v24t.login('fe2');
do $$
declare r jsonb; s text := 'select public.hr_trip_start(%L::jsonb)';
begin
  perform neo_v24t.expect_error(format(s, jsonb_build_object('id', gen_random_uuid(), 'kind', 'on_site', 'note', 'Site', 'age_ms', 1000)),
                                '%NEO_GATE: Punch in (or end your break) to start a trip.%');
  r := neo_v24t.punch('punch_in', neo_v24t.app(0), 540000);
  perform neo_v24t.put('fe2_in', r ->> 'id');
  perform neo_v24t.expect_error($q$select public.hr_trip_start(null)$q$, '%NEO_GATE: The request is empty.%');
  perform neo_v24t.expect_error(format(s, jsonb_build_object('kind', 'on_site', 'note', 'Site')),
                                '%NEO_GATE: id is required — make one UUID per trip and reuse it on every retry.%');
  perform neo_v24t.expect_error(format(s, jsonb_build_object('id', gen_random_uuid(), 'kind', 'picnic', 'note', 'Site', 'age_ms', 500000)),
                                '%NEO_GATE: Say On-site or RMA.%');
  perform neo_v24t.expect_error(format(s, jsonb_build_object('id', gen_random_uuid(), 'kind', 'on_site', 'note', 'ab', 'age_ms', 500000)),
                                '%NEO_GATE: Say where you''re going — at least 3 characters.%');
  perform neo_v24t.expect_error(format(s, jsonb_build_object('id', gen_random_uuid(), 'kind', 'on_site', 'ref_code', 'NT-1', 'age_ms', 500000)),
                                '%NEO_GATE: A job code looks like NT-7KQ2ACDE or RM-7KQ2PX4D.%');
  perform neo_v24t.expect_error(format(s, jsonb_build_object('id', gen_random_uuid(), 'kind', 'on_site', 'note', repeat('n', 250), 'age_ms', 500000)),
                                '%NEO_GATE: The note is too long — keep it under 200 characters.%');
  perform neo_v24t.expect_error(format(s, jsonb_build_object('id', gen_random_uuid(), 'kind', 'on_site', 'note', 'Site', 'at', '2019-05-01T10:00:00Z')),
                                '%NEO_GATE: The phone''s clock is wrong — turn on automatic date and time, then punch again.%');
  -- T1: my own job
  r := public.hr_trip_start(jsonb_build_object('id', 'e5555555-0000-4000-8000-000000000001', 'kind', 'on_site', 'ref_code', 'nt-zqv24j02',
                                                'at', now(), 'age_ms', 480000, 'lat', 10.0159, 'lng', 76.3419, 'accuracy_m', 8));
  perform neo_v24t.assert(r ->> 'ok' = 'true' and r ->> 'duplicate' = 'false' and r -> 'trip' ->> 'ref_code' = 'NT-ZQV24J02'
                          and r -> 'trip' ->> 'ref_title' = 'Zq Printer' and r -> 'trip' ->> 'open' = 'true' and r -> 'trip' -> 'flags' = '[]'::jsonb
                          and r -> 'trip' -> 'ended_at' = 'null'::jsonb and (r -> 'trip' ->> 'started_at')::timestamptz = now() - interval '480 seconds',
                          'a trip for my own job ' || r::text);
  r := public.hr_trip_start(jsonb_build_object('id', 'e5555555-0000-4000-8000-000000000001', 'kind', 'on_site', 'ref_code', 'NT-ZQV24J02', 'age_ms', 1));
  perform neo_v24t.assert(r ->> 'ok' = 'true' and r ->> 'duplicate' = 'true', 'the same id again: duplicate ' || r::text);
  -- while a trip is open the recorder never pauses
  r := public.hr_dashboard() -> 'me' -> 'tracking';
  perform neo_v24t.assert(r ->> 'enabled' = 'true' and (r ->> 'pause_at')::timestamptz = (r ->> 'cap_at')::timestamptz, 'pause_at = cap_at on a trip ' || r::text);
  -- a break: no trip starts in it
  perform neo_v24t.punch('break_start', '{}'::jsonb, 420000);
  perform neo_v24t.expect_error(format(s, jsonb_build_object('id', gen_random_uuid(), 'kind', 'rma', 'note', 'Vendor', 'age_ms', 400000)),
                                '%NEO_GATE: Punch in (or end your break) to start a trip.%');
  perform neo_v24t.punch('break_end', '{}'::jsonb, 360000);
  -- T2 ends T1 (one trip at a time)
  r := public.hr_trip_start(jsonb_build_object('id', 'e5555555-0000-4000-8000-000000000002', 'kind', 'rma', 'note', 'Vendor pickup', 'age_ms', 300000));
  perform neo_v24t.assert(r ->> 'ok' = 'true' and r -> 'trip' -> 'flags' ? 'no_ticket', 'an RMA trip with no ticket: flagged ' || r::text);
end $$;
select neo_v24t.login('hr');
do $$
declare p jsonb;
begin
  p := neo_v24t.person(public.hr_board(), neo_v24t.email('fe2'));
  perform neo_v24t.assert(p ->> 'status' = 'on_duty' and p -> 'trip' ->> 'id' = 'e5555555-0000-4000-8000-000000000002'
                          and p -> 'trip' ->> 'kind' = 'rma' and p ->> 'field_staff' = 'true'
                          and (public.hr_dashboard() -> 'hr' ->> 'on_trip')::int >= 1,
                          'board: the open trip on the row (status words unchanged), on_trip counted ' || p::text);
end $$;
select neo_v24t.login('fe');
do $$
begin
  perform neo_v24t.expect_error(format('select public.hr_trip_start(%L::jsonb)',
                                       jsonb_build_object('id', 'e5555555-0000-4000-8000-000000000001', 'kind', 'on_site', 'note', 'Mine now')),
                                '%NEO_GATE: That trip id is already used.%');
end $$;
-- the route the trips measure: points in T1 before and after the break, in the break (not counted), in T2
reset role;
select neo_v24t.no_jwt();
do $$
declare v_t1 public.hr_trips;
begin
  select * into v_t1 from public.hr_trips where id = 'e5555555-0000-4000-8000-000000000001';
  perform neo_v24t.assert(v_t1.ended_at = now() - interval '300 seconds' and v_t1.end_reason = 'next_trip' and v_t1.ref_id = 's_v24_j2',
                          'T1 ended where T2 started (next_trip) ' || row_to_json(v_t1)::text);
  perform neo_v24t.raw_points('fe2', jsonb_build_array(
    jsonb_build_object('at', now() - interval '470 seconds', 'lat', 10.0200, 'lng', 76.3419, 'accuracy_m', 8),
    jsonb_build_object('at', now() - interval '440 seconds', 'lat', 10.0220, 'lng', 76.3419, 'accuracy_m', 8),
    jsonb_build_object('at', now() - interval '400 seconds', 'lat', 10.0900, 'lng', 76.3419, 'accuracy_m', 8),
    jsonb_build_object('at', now() - interval '350 seconds', 'lat', 10.0230, 'lng', 76.3419, 'accuracy_m', 8),
    jsonb_build_object('at', now() - interval '320 seconds', 'lat', 10.0250, 'lng', 76.3419, 'accuracy_m', 8),
    jsonb_build_object('at', now() - interval '280 seconds', 'lat', 10.0300, 'lng', 76.3419, 'accuracy_m', 8),
    jsonb_build_object('at', now() - interval '200 seconds', 'lat', 10.0340, 'lng', 76.3419, 'accuracy_m', 8)));
  perform neo_v24t.put('t1_km', (public._hr_track_points(jsonb_build_array(
      jsonb_build_array(jsonb_build_object('id', 'a', 'at', now() - interval '470 seconds', 'lat', 10.0200, 'lng', 76.3419, 'accuracy_m', 8),
                        jsonb_build_object('id', 'b', 'at', now() - interval '440 seconds', 'lat', 10.0220, 'lng', 76.3419, 'accuracy_m', 8)),
      jsonb_build_array(jsonb_build_object('id', 'c', 'at', now() - interval '350 seconds', 'lat', 10.0230, 'lng', 76.3419, 'accuracy_m', 8),
                        jsonb_build_object('id', 'd', 'at', now() - interval '320 seconds', 'lat', 10.0250, 'lng', 76.3419, 'accuracy_m', 8))))
    ->> 'km'));
  perform neo_v24t.put('t2_km', (public._hr_track_points(jsonb_build_array(jsonb_build_array(
      jsonb_build_object('id', 'e', 'at', now() - interval '280 seconds', 'lat', 10.0300, 'lng', 76.3419, 'accuracy_m', 8),
      jsonb_build_object('id', 'f', 'at', now() - interval '200 seconds', 'lat', 10.0340, 'lng', 76.3419, 'accuracy_m', 8)))) ->> 'km'));
end $$;
select neo_v24t.login('fe2');
do $$
declare r jsonb;
begin
  r := public.hr_trip_end(jsonb_build_object('id', gen_random_uuid(), 'age_ms', 1000));
  perform neo_v24t.assert(r = '{"ok": false, "unknown": true}'::jsonb, 'an unknown trip id: unknown, no exception');
  perform neo_v24t.expect_error($q$select public.hr_trip_end('{}'::jsonb)$q$, '%NEO_GATE: id is required — make one UUID per trip and reuse it on every retry.%');
  r := public.hr_trip_end(jsonb_build_object('id', 'e5555555-0000-4000-8000-000000000002', 'age_ms', 120000, 'lat', 10.034, 'lng', 76.3419, 'accuracy_m', 9));
  perform neo_v24t.assert(r ->> 'ok' = 'true' and r -> 'trip' ->> 'end_reason' = 'tapped'
                          and (r -> 'trip' ->> 'ended_at')::timestamptz = now() - interval '120 seconds'
                          and (r -> 'trip' ->> 'km')::numeric = neo_v24t.get('t2_km')::numeric and r -> 'trip' ->> 'open' = 'false',
                          'End trip: the km of its window ' || r::text);
  r := public.hr_trip_end(jsonb_build_object('id', 'e5555555-0000-4000-8000-000000000002', 'age_ms', 60000));
  perform neo_v24t.assert(r ->> 'duplicate' = 'true' and (r -> 'trip' ->> 'ended_at')::timestamptz = now() - interval '120 seconds', 'ended once ' || r::text);
  -- T3 is ended by the punch_out; a tap that comes in later (offline) and is earlier replaces it
  r := public.hr_trip_start(jsonb_build_object('id', 'e5555555-0000-4000-8000-000000000003', 'kind', 'on_site', 'note', 'Back to the shop', 'age_ms', 100000));
  perform neo_v24t.assert(r ->> 'ok' = 'true', 'T3 ' || r::text);
  r := neo_v24t.punch('punch_out', neo_v24t.app(0), 60000);
  perform neo_v24t.put('fe2_out', r ->> 'id');
  r := public.hr_trip_end(jsonb_build_object('id', 'e5555555-0000-4000-8000-000000000003', 'at', now()));
  perform neo_v24t.assert(r ->> 'duplicate' = 'true' and r -> 'trip' ->> 'end_reason' = 'punch_out'
                          and (r -> 'trip' ->> 'ended_at')::timestamptz = now() - interval '60 seconds',
                          'a tap after the punch_out: the trip already ended with the session ' || r::text);
  r := public.hr_trip_end(jsonb_build_object('id', 'e5555555-0000-4000-8000-000000000003', 'age_ms', 80000));
  perform neo_v24t.assert(r ->> 'duplicate' = 'false' and r -> 'trip' ->> 'end_reason' = 'tapped'
                          and (r -> 'trip' ->> 'ended_at')::timestamptz = now() - interval '80 seconds',
                          'an earlier tap replaces the punch-out end ' || r::text);
  -- the day: trips with their km (T1 over its two runs, the break left out)
  r := public.hr_my_day(neo_v24t.dago(540));
  perform neo_v24t.assert(jsonb_array_length(r -> 'trips') = 3
                          and (select (t.value ->> 'km')::numeric from jsonb_array_elements(r -> 'trips') t
                                where t.value ->> 'id' = 'e5555555-0000-4000-8000-000000000001') = neo_v24t.get('t1_km')::numeric
                          and (r -> 'trips' -> 0) ?& array['id', 'kind', 'ref_code', 'ref_title', 'note', 'started_at', 'ended_at', 'end_reason',
                                                         'km', 'moving_min', 'stops', 'open', 'flags']
                          and r -> 'events' -> 0 ?& array['place', 'office_m', 'verify', 'flags', 'reason_kind', 'reason_text', 'reason_ref',
                                                       'selfie', 'selfie_skip', 'request_id']
                          and not (r -> 'events' -> 0 ? 'lat') and not (r::text like '%"lat"%'),
                          'hr_my_day: trips[] (km over the runs ∩ the trip), the punch checks, still no coordinates ' || (r -> 'trips')::text);
  r := public.hr_route(null, neo_v24t.dago(540));
  perform neo_v24t.assert(jsonb_array_length(r -> 'trips') = 3, 'hr_route: trips[] for the map');
end $$;
-- a trip started with the punch_in (p.trip); refused trips never refuse the punch
select neo_v24t.login('fe');
do $$
declare r jsonb;
begin
  r := neo_v24t.punch('punch_in', neo_v24t.app(0) || '{"trip": {"id": "e5555555-0000-4000-8000-000000000004", "kind": "on_site", "note": "Customer site"}}'::jsonb, 120000);
  perform neo_v24t.assert(r ->> 'ok' = 'true' and r -> 'check' -> 'trip' ->> 'ok' = 'true'
                          and r -> 'check' -> 'trip' ->> 'id' = 'e5555555-0000-4000-8000-000000000004', 'p.trip starts with the punch ' || r::text);
  r := neo_v24t.punch('punch_out', neo_v24t.app(0), 60000);
  perform neo_v24t.assert(r ->> 'ok' = 'true', 'out');
end $$;
select neo_v24t.login('supply');
do $$
declare r jsonb;
begin
  r := neo_v24t.punch('punch_in', neo_v24t.app(0) || '{"trip": {"id": "e5555555-0000-4000-8000-000000000005", "kind": "on_site", "note": "Site"}}'::jsonb, 50000);
  perform neo_v24t.assert(r ->> 'ok' = 'true' and r -> 'check' -> 'trip' ->> 'ok' = 'false'
                          and r -> 'check' -> 'trip' ->> 'message' = 'Trips are for field staff.', 'a refused trip: the punch still counts ' || r::text);
  r := neo_v24t.punch('punch_out', neo_v24t.app(0) || '{"trip": "x"}'::jsonb, 40000);
  perform neo_v24t.assert(r ->> 'ok' = 'true' and (r -> 'check' -> 'dropped') @> '["trip"]'::jsonb, 'a junk trip on a punch_out: dropped ' || r::text);
end $$;
reset role;
select neo_v24t.no_jwt();
do $$
declare t public.hr_trips;
begin
  select * into t from public.hr_trips where id = 'e5555555-0000-4000-8000-000000000004';
  perform neo_v24t.assert(t.start_source = 'punch_in' and t.ended_at is not null and t.end_reason = 'punch_out'
                          and t.ended_at = (select at from public.attendance_events where employee_email = neo_v24t.email('fe') and kind = 'punch_out'
                                             order by at desc limit 1),
                          'the punch_out ended the trip of its session ' || row_to_json(t)::text);
  perform neo_v24t.assert(not exists (select 1 from public.hr_trips where id = 'e5555555-0000-4000-8000-000000000005'), 'no trip for the desk');
end $$;
select neo_v24t.login('hr');
do $$
declare p jsonb;
begin
  p := neo_v24t.person(public.hr_board(), neo_v24t.email('fe2'));
  perform neo_v24t.assert(p ->> 'field_staff' = 'true' and p -> 'trip' = 'null'::jsonb, 'board: no open trip after the punch_out ' || p::text);
end $$;


-- ── 6. Travel allowance on trip km (D8) ────────────────────────────────────
select neo_v24t.login('ta');
do $$
declare r jsonb;
begin
  perform neo_v24t.punch('punch_in', '{}'::jsonb, null, (neo_v24t.lmd() + time '09:00') at time zone 'Asia/Kolkata');
  perform neo_v24t.punch('punch_out', '{}'::jsonb, null, (neo_v24t.lmd() + time '17:00') at time zone 'Asia/Kolkata');
  r := public.hr_trip_start(jsonb_build_object('id', 'e5555555-0000-4000-8000-000000000006', 'kind', 'on_site', 'note', 'Install at a school',
                                                'at', (neo_v24t.lmd() + time '10:00') at time zone 'Asia/Kolkata'));
  perform neo_v24t.assert(r ->> 'ok' = 'true' and r -> 'trip' -> 'flags' ? 'sent_late', 'a trip sent from the offline queue: sent_late ' || r::text);
  r := public.hr_trip_end(jsonb_build_object('id', 'e5555555-0000-4000-8000-000000000006', 'at', (neo_v24t.lmd() + time '12:00') at time zone 'Asia/Kolkata'));
  perform neo_v24t.assert(r ->> 'ok' = 'true', 'ended ' || r::text);
end $$;
reset role;
select neo_v24t.no_jwt();
do $$
declare v_drive jsonb; v_walk jsonb;
begin
  -- the drive inside the trip, a walk after it (day km only)
  select jsonb_agg(jsonb_build_object('at', ((neo_v24t.lmd() + time '10:30') at time zone 'Asia/Kolkata') + ((p.value ->> 'at')::timestamptz - '2026-10-20T04:00:00Z'::timestamptz),
                                      'lat', (p.value ->> 'lat')::float8, 'lng', (p.value ->> 'lng')::float8, 'accuracy_m', (p.value ->> 'accuracy_m')::float8))
    into v_drive
    from jsonb_array_elements('[{"at":"2026-10-20T04:00:00Z","lat":10.015936,"lng":76.3419,"accuracy_m":8},{"at":"2026-10-20T04:00:20Z","lat":10.015873,"lng":76.3441009,"accuracy_m":8},{"at":"2026-10-20T04:00:40Z","lat":10.015873,"lng":76.3463292,"accuracy_m":8},{"at":"2026-10-20T04:01:00Z","lat":10.015936,"lng":76.3485849,"accuracy_m":8},{"at":"2026-10-20T04:01:20Z","lat":10.015873,"lng":76.350868,"accuracy_m":8}]'::jsonb) as p(value);
  select jsonb_agg(jsonb_build_object('at', ((neo_v24t.lmd() + time '14:00') at time zone 'Asia/Kolkata') + g * interval '30 seconds',
                                      'lat', 10.0159, 'lng', 76.3419 + g * 0.0003, 'accuracy_m', 8) order by g)
    into v_walk from generate_series(0, 5) as g;
  perform neo_v24t.raw_points('ta', v_drive || v_walk);
  perform neo_v24t.put('ta_trip_km', (public._hr_track_points(jsonb_build_array(
    (select jsonb_agg(x.value || jsonb_build_object('id', x.ordinality::text)) from jsonb_array_elements(v_drive) with ordinality x)))) ->> 'km');
end $$;
select neo_v24t.login('ceo4');
select public.hr_settings_set('{"ta_rate_per_km": 10}'::jsonb);
do $$
declare r jsonb; p jsonb; v_km numeric := neo_v24t.get('ta_trip_km')::numeric;
begin
  r := public.hr_ta_report(neo_v24t.lmd());
  p := neo_v24t.person(r, neo_v24t.email('ta'));
  perform neo_v24t.assert(v_km > 0.5 and (p ->> 'km')::numeric = v_km and (p ->> 'live_km')::numeric = v_km and (p ->> 'day_km')::numeric > v_km
                          and (p ->> 'amount')::numeric = round(v_km * 10, 2) and p ->> 'eligible' = 'true' and p ->> 'can_approve' = 'true'
                          and (p -> 'days' -> 0 ->> 'km')::numeric = v_km and (p -> 'days' -> 0 ->> 'day_km')::numeric = (p ->> 'day_km')::numeric,
                          'D8: travel allowance on trip km; day_km beside it ' || p::text);
  perform neo_v24t.assert(neo_v24t.person(r, neo_v24t.email('desk')) is null and neo_v24t.person(r, neo_v24t.email('sales')) is null,
                          'the report lists field staff only');
  r := public.hr_ta_approve(neo_v24t.email('ta'), neo_v24t.lmd(), 'School installs', (p ->> 'km')::numeric);
  perform neo_v24t.assert(r ->> 'ok' = 'true' and (r ->> 'km')::numeric = v_km and (r ->> 'amount')::numeric = round(v_km * 10, 2),
                          'a 1.12 desktop sends the row''s km and the approval goes through ' || r::text);
  perform neo_v24t.expect_error(format('select public.hr_ta_approve(%L, %L, null, 1)', neo_v24t.email('desk'), neo_v24t.lmd()),
                                '%NEO_GATE: Zqv Desk isn''t eligible for travel allowance.%');
  -- the register's days carry trip_km too (0 on a day without trips)
  r := public.hr_register(neo_v24t.lmd() - 1, neo_v24t.lmd(), neo_v24t.email('ta'));
  p := neo_v24t.person(r, neo_v24t.email('ta'));
  perform neo_v24t.assert(jsonb_array_length(p -> 'days') = 2 and (p -> 'days' -> 1 ->> 'day')::date = neo_v24t.lmd()
                          and (p -> 'days' -> 1 ->> 'trip_km')::numeric = v_km and (p -> 'days' -> 0 ->> 'trip_km')::numeric = 0
                          and (p -> 'days' -> 1 ->> 'km')::numeric > v_km,
                          'hr_register: days gain trip_km beside the day km ' || (p -> 'days')::text);
  r := public.hr_register(neo_v24t.lmd(), neo_v24t.lmd(), neo_v24t.email('desk'));
  perform neo_v24t.assert((neo_v24t.person(r, neo_v24t.email('desk')) -> 'days' -> 0 ->> 'trip_km')::numeric = 0, 'no trips: trip_km 0');
end $$;
select neo_v24t.login('ta');
do $$
declare r jsonb; v_km numeric := neo_v24t.get('ta_trip_km')::numeric;
begin
  r := public.hr_my_month(neo_v24t.lmd());
  perform neo_v24t.assert((r -> 'totals' ->> 'trip_km')::numeric = v_km and (r -> 'totals' ->> 'km')::numeric > v_km
                          and (r -> 'totals' -> 'ta' ->> 'amount')::numeric = round(v_km * 10, 2) and r -> 'totals' -> 'ta' ->> 'eligible' = 'true'
                          and (r -> 'totals') ? 'away_pending'
                          and (select (d.value ->> 'trip_km')::numeric from jsonb_array_elements(r -> 'days') d
                                where (d.value ->> 'day')::date = neo_v24t.lmd()) = v_km,
                          'hr_my_month: trip_km per day and in the totals; the allowance is trip km × rate ' || (r -> 'totals')::text);
end $$;


-- ── 7. The per-day cap (R6) ───────────────────────────────────────────────────
reset role;
select neo_v24t.no_jwt();
do $$
declare i int;
begin
  for i in 0 .. 29 loop
    perform neo_v24t.raw_event('cap', case when i % 2 = 0 then 'punch_in' else 'punch_out' end, neo_v24t.at(-1, '00:10') + i * interval '9 minutes');
  end loop;
end $$;
select neo_v24t.login('cap');
do $$
begin
  perform neo_v24t.expect_error(format('select neo_v24t.punch(%L, %L::jsonb, null, %L)', 'punch_in', '{}', neo_v24t.at(-1, '12:00')),
                                '%NEO_GATE: Too many punches today — ask HR to correct the day.%');
end $$;

-- ── 8. Anon and the guest (R4) ─────────────────────────────────────────────
select neo_v24t.login_anon();
do $$
begin
  perform neo_v24t.expect_error($q$select public.hr_selfie_put('{}'::jsonb)$q$, '%permission denied%');
  perform neo_v24t.expect_error($q$select public.hr_trip_start('{}'::jsonb)$q$, '%permission denied%');
  perform neo_v24t.expect_error($q$select public.hr_punch_checks(null)$q$, '%permission denied%');
  perform neo_v24t.expect_error($q$select public._hr_dash_view(null)$q$, '%permission denied%');
  perform neo_v24t.expect_error($q$select count(*) from public.hr_trips$q$, '%permission denied%');
end $$;
select neo_v24t.login('fe');
do $$
begin
  perform neo_v24t.expect_error($q$select public._hr_is_field(null)$q$, '%permission denied%');
  perform neo_v24t.expect_error($q$select count(*) from public.hr_punch_selfies$q$, '%permission denied%');
  perform neo_v24t.expect_error($q$select count(*) from public.attendance_events$q$, '%permission denied%');
end $$;


-- ═══ The second half (sections 9–17) runs after sections 0–1 on its own too ══

-- ── 9. Before the office point is set: place 'unset', nothing is asked ───────
select neo_v24t.login('desk2');
do $$
declare r jsonb;
begin
  r := neo_v24t.punch('punch_in', neo_v24t.app(5000), 590000);
  perform neo_v24t.assert(r ->> 'ok' = 'true' and r -> 'check' ->> 'place' = 'unset' and r -> 'check' ->> 'verify' = 'ok'
                          and r -> 'check' -> 'request' = 'null'::jsonb and r -> 'check' ->> 'needs_selfie' = 'true'
                          and r -> 'check' -> 'dropped' = '[]'::jsonb and r -> 'check' -> 'flags' = '[]'::jsonb,
                          'no office point: unset, no away request even 5 km out ' || r::text);
  r := neo_v24t.punch('punch_out', neo_v24t.app(5000), 585000);
  perform neo_v24t.assert(r -> 'check' -> 'request' = 'null'::jsonb, 'punch_out: no request either');
end $$;
select neo_v24t.login('ceo4');
select public.hr_settings_set('{"office_lat": 10.0159, "office_lng": 76.3419, "office_radius_m": 150}'::jsonb);


-- ── 10. Verified punches: the fix, the app, R2 (non-field staff, fresh punches) ─
select neo_v24t.login('desk');
do $$
declare r jsonb; e public.attendance_events; v uuid;
begin
  -- 2.3 at the shop: ok, no request
  r := neo_v24t.punch('punch_in', neo_v24t.app(0), 540000);
  perform neo_v24t.assert(r ->> 'ok' = 'true' and r -> 'check' ->> 'place' = 'office' and r -> 'check' ->> 'verify' = 'ok'
                          and (r -> 'check' ->> 'office_m')::int = 0 and r -> 'check' -> 'request' = 'null'::jsonb
                          and r -> 'check' ->> 'needs_selfie' = 'true' and r -> 'check' -> 'trip' = 'null'::jsonb
                          and r ?& array['ok', 'duplicate', 'now', 'id', 'state', 'since', 'day', 'tracking', 'check'],
                          'D2: a precise fresh fix at the shop counts at once ' || r::text);
  perform neo_v24t.put('desk_in1', r ->> 'id');
  -- 2.3 punch_out 1 km away: an away_punch, pending; the session counts nowhere yet
  r := neo_v24t.punch('punch_out', neo_v24t.app(1000), 480000);
  perform neo_v24t.assert(r -> 'check' ->> 'place' = 'away' and r -> 'check' -> 'request' ->> 'kind' = 'away_punch'
                          and r -> 'check' -> 'request' ->> 'status' = 'pending' and r -> 'day' ->> 'away_pending' = 'true'
                          and (r -> 'day' ->> 'worked_min')::int = 0 and (r -> 'day' ->> 'pending_min')::int >= 1,
                          'D6: away from the shop → waiting for HR; it counts only once approved ' || r::text);
  perform neo_v24t.put('desk_out2', r ->> 'id');
  perform neo_v24t.put('desk_away2', r -> 'check' -> 'request' ->> 'id');
  -- a fix older than 120 s at the tap is dropped: no fix, unknown, away_punch
  r := neo_v24t.punch('punch_in', neo_v24t.app(0, 10, 200000), 420000);
  perform neo_v24t.assert(r -> 'check' ->> 'verify' = 'no_fix' and r -> 'check' ->> 'place' = 'unknown'
                          and r -> 'check' -> 'request' ->> 'kind' = 'away_punch', 'a stale fix is no fix ' || r::text);
  perform neo_v24t.put('desk_in3', r ->> 'id');
  perform neo_v24t.put('desk_away3', r -> 'check' -> 'request' ->> 'id');
  -- a typed reason rides on the away_punch
  r := neo_v24t.punch('punch_out', neo_v24t.app(1000) || '{"reason": {"kind": "other", "text": "At the bank for the shop"}}'::jsonb, 360000);
  perform neo_v24t.assert(r -> 'check' -> 'request' ->> 'kind' = 'away_punch', 'away with a reason ' || r::text);
  perform neo_v24t.put('desk_out4', r ->> 'id');
  perform neo_v24t.put('desk_away4', r -> 'check' -> 'request' ->> 'id');
  -- a replay answers the STORED check
  r := public.hr_punch(jsonb_build_object('id', neo_v24t.get('desk_out2'), 'kind', 'punch_out', 'at', now()));
  perform neo_v24t.assert(r ->> 'duplicate' = 'true' and r -> 'check' ->> 'place' = 'away'
                          and r -> 'check' -> 'request' ->> 'id' = neo_v24t.get('desk_away2'),
                          'a replay answers the check stored with the punch ' || r::text);
end $$;
reset role;
select neo_v24t.no_jwt();
do $$
declare e public.attendance_events; q public.hr_requests;
begin
  e := neo_v24t.ev(neo_v24t.get('desk_in1')::uuid);
  perform neo_v24t.assert(e.verify = 'ok' and e.place = 'office' and e.office_m = 0 and e.app_code = 20300 and e.fix_age_ms = 3000
                          and e.fix_at = e.at - interval '3 seconds' and e.mock = false and e.flags = '{}' and e.request_id is null,
                          'the stored punch: verify, place, the fix time, the app version');
  q := neo_v24t.rq(neo_v24t.get('desk_out2')::uuid);
  perform neo_v24t.assert(q.kind = 'away_punch' and q.status = 'pending' and q.reason = 'Away from the shop — no reason given'
                          and q.date_from = neo_v24t.dago(480) and q.date_to = q.date_from and q.place = 'away'
                          and q.office_m between 990 and 1010
                          and q.due_at = greatest(public._hr_at(q.date_from, '18:30'), (now() - interval '480 seconds') + interval '2 hours')
                          and (select request_id from public.attendance_events where id = q.event_id) = q.id,
                          'the away_punch: a server reason, the session day, due by the shift end or 2 h after');
  q := neo_v24t.rq(neo_v24t.get('desk_in3')::uuid);
  perform neo_v24t.assert(q.reason = 'Location not verified — no reason given', 'no fix: the server''s sentence ' || q.reason);
  q := neo_v24t.rq(neo_v24t.get('desk_out4')::uuid);
  perform neo_v24t.assert(q.reason = 'At the bank for the shop' and q.reason_kind = 'other', 'the typed reason ' || q.reason);
end $$;

-- the phone's clock 10 minutes fast, a fake location, a restored row, no fix age
select neo_v24t.login('desk2');
do $$
declare r jsonb; e public.attendance_events;
begin
  r := public.hr_punch(jsonb_build_object('id', gen_random_uuid(), 'kind', 'punch_in', 'at', now() + interval '10 minutes', 'age_ms', 540000)
                       || neo_v24t.app(0, 10, 4000));
  perform neo_v24t.assert(r -> 'check' ->> 'verify' = 'ok' and r -> 'check' ->> 'place' = 'office' and r -> 'check' -> 'request' = 'null'::jsonb,
                          'a phone clock 10 min fast: the fix age is relative, the fix counts ' || r::text);
  perform neo_v24t.put('desk2_clock', r ->> 'id');
  r := neo_v24t.punch('punch_out', neo_v24t.app(0) || '{"mock": true}'::jsonb, 480000);
  perform neo_v24t.assert(r -> 'check' ->> 'verify' = 'mock' and r -> 'check' ->> 'place' = 'unknown'
                          and r -> 'check' -> 'request' ->> 'kind' = 'away_punch', 'D5: a fake location → mock, waiting for HR ' || r::text);
  perform neo_v24t.put('desk2_mock', r ->> 'id');
  r := neo_v24t.punch('punch_in', neo_v24t.app(0) || '{"restored": true}'::jsonb, 420000, now() - interval '7 minutes');
  perform neo_v24t.assert(r -> 'check' ->> 'verify' = 'restored' and r -> 'check' -> 'request' ->> 'kind' = 'away_punch',
                          'a punch restored from a backup → waiting for HR ' || r::text);
  perform neo_v24t.put('desk2_restored', r ->> 'id');
  r := neo_v24t.punch('punch_out', jsonb_build_object('v', 20300) || neo_v24t.fix(0), 360000);
  perform neo_v24t.assert(r -> 'check' ->> 'verify' = 'no_fix' and r -> 'check' -> 'request' ->> 'kind' = 'away_punch',
                          'NeoHR 2.3 with no fix age: no fix ' || r::text);
end $$;
reset role;
select neo_v24t.no_jwt();
do $$
declare e public.attendance_events;
begin
  e := neo_v24t.ev(neo_v24t.get('desk2_clock')::uuid);
  perform neo_v24t.assert(e.time_source = 'server' and e.at = now() - interval '540 seconds' and e.fix_at = e.at - interval '4 seconds'
                          and e.device_at = now() + interval '10 minutes', 'fix_at = at − fix_age_ms, on the server''s clock');
  e := neo_v24t.ev(neo_v24t.get('desk2_restored')::uuid);
  perform neo_v24t.assert(e.time_source = 'device' and e.at = now() - interval '7 minutes', 'a restored row is never server-anchored');
  perform neo_v24t.assert((neo_v24t.rq(neo_v24t.get('desk2_mock')::uuid)).reason = 'The phone reported a fake location'
                          and (neo_v24t.rq(neo_v24t.get('desk2_restored')::uuid)).reason = 'Sent from a restored backup',
                          'server sentences for a fake location and a restored row');
end $$;

-- NeoHR 2.2 (no v), and the legacy record_field_activity punch: old_app, the same rules
select neo_v24t.login('oldapp');
do $$
declare r jsonb; v uuid := gen_random_uuid();
begin
  r := neo_v24t.punch('punch_in', neo_v24t.fix(20), 540000);
  perform neo_v24t.assert(r -> 'check' ->> 'verify' = 'old_app' and r -> 'check' ->> 'place' = 'office' and r -> 'check' -> 'request' = 'null'::jsonb
                          and r -> 'check' ->> 'needs_selfie' = 'true', 'NeoHR 2.2 at the shop: old_app, counts ' || r::text);
  r := neo_v24t.punch('punch_out', '{}'::jsonb, 480000);
  perform neo_v24t.assert(r -> 'check' ->> 'verify' = 'old_app' and r -> 'check' ->> 'place' = 'unknown'
                          and r -> 'check' -> 'request' ->> 'kind' = 'away_punch', 'NeoHR 2.2 with no fix: waiting for HR ' || r::text);
  perform neo_v24t.put('old_out', r ->> 'id');
  r := public.record_field_activity(jsonb_build_object('client_request_id', v, 'kind', 'punch_in', 'ref_type', 'attendance', 'module', 'neohr',
                                                       'at', now() - interval '7 minutes', 'lat', 10.0159, 'lng', 76.3419 + 3000 / 109633.0,
                                                       'accuracy_m', 8, 'source', 'neohr'));
  perform neo_v24t.assert(r = jsonb_build_object('id', v, 'applied', true, 'applied_note', 'Recorded.', 'duplicate', false, 'stage', null),
                          'the legacy punch keeps its old answer ' || r::text);
  perform neo_v24t.put('old_legacy', v::text);
end $$;
reset role;
select neo_v24t.no_jwt();
do $$
begin
  perform neo_v24t.assert((neo_v24t.rq(neo_v24t.get('old_out')::uuid)).reason = 'No reason sent (NeoHR 2.2)', 'the 2.2 sentence');
  perform neo_v24t.assert((neo_v24t.ev(neo_v24t.get('old_legacy')::uuid)).verify = 'old_app'
                          and (neo_v24t.rq(neo_v24t.get('old_legacy')::uuid)).kind = 'away_punch',
                          'record_field_activity punches go through the same checks (_hr_punch_apply → _hr_punch_core)');
end $$;

-- R2: every malformed v2.4 key — the punch is still recorded (a field engineer, past days)
select neo_v24t.login('r2');
do $$
declare r jsonb; j jsonb; i int := 0;
begin
  foreach j in array array[
      '{"v": "abc"}', '{"v": 20300, "fix_age_ms": "x"}', '{"mock": "maybe"}', '{"reason": "late"}', '{"reason": {"kind": 5}}',
      '{"reason": {"kind": "late", "text": 7}}', '{"selfie_skip": "nope"}', '{"flags": [1, 2]}', '{"trip": "x"}',
      '{"reason": {"kind": "on_site", "ref": "BAD-REF"}, "restored": "yes"}']::jsonb[] loop
    r := neo_v24t.punch(case when i % 2 = 0 then 'punch_in' else 'punch_out' end, j, null, neo_v24t.at(-10, '08:00') + i * interval '20 minutes');
    perform neo_v24t.assert(r ->> 'ok' = 'true' and r ->> 'duplicate' = 'false' and jsonb_array_length(r -> 'check' -> 'dropped') >= 1,
                            format('R2: %s still records the punch: %s', j, r));
    i := i + 1;
  end loop;
  r := neo_v24t.punch('punch_in', jsonb_build_object('reason', jsonb_build_object('kind', 'late', 'text', repeat('y', 700))), null, neo_v24t.at(-10, '13:00'));
  perform neo_v24t.assert(r ->> 'ok' = 'true' and (r -> 'check' -> 'dropped') @> '["reason.text"]'::jsonb, 'R2: an over-long reason is cut ' || r::text);
end $$;
reset role;
select neo_v24t.no_jwt();
do $$
begin
  perform neo_v24t.assert((select count(*) from public.attendance_events where employee_email = neo_v24t.email('r2') and voided_at is null) = 11,
                          'R2: all 11 punches are stored');
  perform neo_v24t.assert((select char_length(reason_text) from public.attendance_events where employee_email = neo_v24t.email('r2')
                            and at = neo_v24t.at(-10, '13:00')) = 500, 'the reason is kept, cut to 500');
end $$;


-- ── 11. Field engineers' punch-in reasons (D3): late at punch time, the matrix ─
select neo_v24t.login('fe');
do $$
declare r jsonb;
begin
  -- 09:40:30 is not late (floor of 30 s is 0 minutes): a Late reason is only kept on the punch
  r := neo_v24t.punch('punch_in', neo_v24t.app(0) || '{"reason": {"kind": "late"}}'::jsonb, null, neo_v24t.at(-2, '09:40:30'));
  perform neo_v24t.assert(r -> 'check' -> 'request' = 'null'::jsonb and r -> 'check' -> 'flags' ? 'sent_late'
                          and (r -> 'day' ->> 'late_min')::int = 0, '09:40:30: not late, no request ' || r::text);
  perform neo_v24t.punch('punch_out', neo_v24t.app(0), null, neo_v24t.at(-2, '18:30'));
  -- 09:41 with the Late chip and no text: a punch_reason, past the end of that day
  r := neo_v24t.punch('punch_in', neo_v24t.app(0) || '{"reason": {"kind": "late"}}'::jsonb, null, neo_v24t.at(-3, '09:41'));
  perform neo_v24t.assert(r -> 'check' -> 'request' ->> 'kind' = 'punch_reason' and (r -> 'day' ->> 'late_min')::int = 1
                          and r -> 'day' ->> 'pending_reason' = 'true', '09:41 Late: a punch reason for HR ' || r::text);
  perform neo_v24t.put('fe_late_in', r ->> 'id');
  perform neo_v24t.put('fe_late_req', r -> 'check' -> 'request' ->> 'id');
  perform neo_v24t.punch('punch_out', neo_v24t.app(0), null, neo_v24t.at(-3, '18:30'));
  -- two sessions: a Late reason on the second punch_in asks nothing
  perform neo_v24t.punch('punch_in', neo_v24t.app(0), null, neo_v24t.at(-4, '09:00'));
  perform neo_v24t.punch('punch_out', neo_v24t.app(0), null, neo_v24t.at(-4, '10:00'));
  r := neo_v24t.punch('punch_in', neo_v24t.app(0) || '{"reason": {"kind": "late", "text": "Back from lunch"}}'::jsonb, null, neo_v24t.at(-4, '11:00'));
  perform neo_v24t.assert(r -> 'check' -> 'request' = 'null'::jsonb, 'only the first session''s punch_in can be late ' || r::text);
  perform neo_v24t.punch('punch_out', neo_v24t.app(0), null, neo_v24t.at(-4, '18:00'));
  -- On-site away from the shop, my own ticket: no request, the late mark excused
  r := neo_v24t.punch('punch_in', neo_v24t.app(5000) || '{"reason": {"kind": "on_site", "ref": "NT-ZQV24J01"}}'::jsonb, null, neo_v24t.at(-5, '10:30'));
  perform neo_v24t.assert(r -> 'check' -> 'request' = 'null'::jsonb and r -> 'check' ->> 'place' = 'away'
                          and not (r -> 'check' -> 'flags' ? 'no_ticket') and not (r -> 'check' -> 'flags' ? 'ticket_not_mine')
                          and (r -> 'day' ->> 'late_min')::int = 0 and (r -> 'day' ->> 'late_raw_min')::int = 50 and r -> 'day' ->> 'late_excused' = 'true',
                          'D3: On-site away from the shop excuses the late mark at once ' || r::text);
  perform neo_v24t.punch('punch_out', neo_v24t.app(5000), null, neo_v24t.at(-5, '18:30'));
  -- On-site picked at the shop, late, no ticket: a punch_reason (no_ticket)
  r := neo_v24t.punch('punch_in', neo_v24t.app(0) || '{"reason": {"kind": "on_site"}}'::jsonb, null, neo_v24t.at(-6, '10:30'));
  perform neo_v24t.assert(r -> 'check' -> 'request' ->> 'kind' = 'punch_reason' and r -> 'check' -> 'flags' ? 'no_ticket'
                          and (r -> 'day' ->> 'late_min')::int = 50, 'On-site at the shop: an ordinary pending reason ' || r::text);
  perform neo_v24t.put('fe_onsite_req', r -> 'check' -> 'request' ->> 'id');
  perform neo_v24t.punch('punch_out', neo_v24t.app(0), null, neo_v24t.at(-6, '18:30'));
  -- RMA away with a part that is someone else's: excused, flagged
  r := neo_v24t.punch('punch_in', neo_v24t.app(4000) || '{"reason": {"kind": "rma", "ref": "rm-zqv24r01"}}'::jsonb, null, neo_v24t.at(-7, '10:30'));
  perform neo_v24t.assert(r -> 'check' -> 'request' = 'null'::jsonb and r -> 'check' -> 'flags' ? 'ticket_not_mine', 'RMA, not my part ' || r::text);
  perform neo_v24t.punch('punch_out', neo_v24t.app(4000), null, neo_v24t.at(-7, '18:30'));
  -- a typed reason, on time but away: a punch_reason
  r := neo_v24t.punch('punch_in', neo_v24t.app(3000) || '{"reason": {"kind": "other", "text": "Bike puncture"}}'::jsonb, null, neo_v24t.at(-8, '09:35'));
  perform neo_v24t.assert(r -> 'check' -> 'request' ->> 'kind' = 'punch_reason' and (r -> 'day' ->> 'late_min')::int = 0,
                          'a typed reason away from the shop goes to HR ' || r::text);
  perform neo_v24t.put('fe_other_req', r -> 'check' -> 'request' ->> 'id');
  perform neo_v24t.punch('punch_out', neo_v24t.app(3000), null, neo_v24t.at(-8, '18:30'));
  -- late with no reason: nothing (a normal late mark)
  r := neo_v24t.punch('punch_in', neo_v24t.app(3000), null, neo_v24t.at(-9, '10:30'));
  perform neo_v24t.assert(r -> 'check' -> 'request' = 'null'::jsonb and (r -> 'day' ->> 'late_min')::int = 50, 'no reason: the late mark ' || r::text);
  perform neo_v24t.punch('punch_out', neo_v24t.app(3000), null, neo_v24t.at(-9, '18:30'));
  -- on time with a weak fix outside the radius and a Late reason: place unknown → a punch_reason
  r := neo_v24t.punch('punch_in', neo_v24t.app(500, 150) || '{"reason": {"kind": "late"}}'::jsonb, null, neo_v24t.at(-11, '09:35'));
  perform neo_v24t.assert(r -> 'check' ->> 'place' = 'unknown' and r -> 'check' ->> 'verify' = 'weak_fix'
                          and r -> 'check' -> 'request' ->> 'kind' = 'punch_reason', 'unknown place: the reason goes to HR ' || r::text);
  perform neo_v24t.put('fe_weak_in', r ->> 'id');
  perform neo_v24t.put('fe_weak_req', r -> 'check' -> 'request' ->> 'id');
  perform neo_v24t.punch('punch_out', neo_v24t.app(0), null, neo_v24t.at(-11, '18:00'));
end $$;
reset role;
select neo_v24t.no_jwt();
do $$
declare q public.hr_requests;
begin
  q := neo_v24t.rq(neo_v24t.get('fe_late_in')::uuid);
  perform neo_v24t.assert(q.kind = 'punch_reason' and q.reason = 'Late — no reason typed' and q.reason_kind = 'late' and q.date_from = neo_v24t.d(-3)
                          and q.due_at = neo_v24t.at(-3, '18:30') and q.status = 'pending',
                          'the Late chip with no text: a 3+ character server reason, due by that day''s shift end');
  perform neo_v24t.assert((select reason from public.hr_requests where id = neo_v24t.get('fe_onsite_req')::uuid) = 'On-site visit',
                          'On-site with no text');
  perform neo_v24t.assert(public._hr_is_late_punch(neo_v24t.email('fe'), neo_v24t.uid('fe'), neo_v24t.get('fe_late_in')::uuid, neo_v24t.at(-3, '09:41'))
                          and not public._hr_is_late_punch(neo_v24t.email('fe'), neo_v24t.uid('fe'), gen_random_uuid(), neo_v24t.at(-3, '09:41')),
                          '_hr_is_late_punch: the first session''s punch_in only');
end $$;

-- D2 / D6 non-field staff: wfh, field duty, sent late, no camera
select neo_v24t.login('hr');
select public.hr_roster_set(neo_v24t.email('wfh'), neo_v24t.dago(540), 'wfh', null);
select neo_v24t.login('wfh');
do $$
declare r jsonb;
begin
  r := neo_v24t.punch('punch_in', neo_v24t.app(8000), 540000);
  perform neo_v24t.assert(r -> 'check' ->> 'place' = 'away' and r -> 'check' -> 'request' = 'null'::jsonb,
                          'a rostered work-from-home day is not asked ' || r::text);
end $$;
select neo_v24t.login('cap');
do $$
declare r jsonb;
begin
  r := neo_v24t.punch('punch_in', neo_v24t.app(0), null, now() - interval '30 minutes');
  perform neo_v24t.assert(r -> 'check' ->> 'place' = 'office' and r -> 'check' -> 'flags' ? 'sent_late'
                          and r -> 'check' -> 'request' ->> 'kind' = 'away_punch', 'sent 30 minutes late: waiting for HR, even at the shop ' || r::text);
  perform neo_v24t.put('cap_late', r ->> 'id');
end $$;
select neo_v24t.login('pic');
do $$
declare r jsonb;
begin
  r := neo_v24t.punch('punch_in', neo_v24t.app(0) || '{"selfie_skip": "camera_error"}'::jsonb, 540000);
  perform neo_v24t.assert(r -> 'check' -> 'flags' ? 'selfie_skip' and r -> 'check' ->> 'needs_selfie' = 'false'
                          and r -> 'check' -> 'request' ->> 'kind' = 'away_punch', 'no camera: waiting for HR ' || r::text);
  perform neo_v24t.put('pic_skip', r ->> 'id');
end $$;
reset role;
select neo_v24t.no_jwt();
do $$
begin
  perform neo_v24t.assert((neo_v24t.rq(neo_v24t.get('cap_late')::uuid)).reason = 'Sent 30 min after the punch time'
                          and (neo_v24t.rq(neo_v24t.get('pic_skip')::uuid)).reason = 'Camera not available',
                          'server sentences: sent late, no camera');
end $$;

-- §1.3.4 the auth session: a session made minutes ago, a client that is not the app
insert into auth.sessions (id, user_id, created_at, user_agent)
values ('d4444444-0000-4000-8000-000000000001', 'c3333333-0000-4000-8000-000000000014', now() - interval '1 hour', 'okhttp/4.12.0'),
       ('d4444444-0000-4000-8000-000000000002', 'c3333333-0000-4000-8000-000000000014', now() - interval '3 days', 'curl/8.4.0');
select neo_v24t.login('wfh', 'd4444444-0000-4000-8000-000000000001');
do $$
declare r jsonb;
begin
  r := neo_v24t.punch('punch_out', neo_v24t.app(8000), 480000);
  perform neo_v24t.assert(r -> 'check' -> 'flags' ? 'new_login' and not (r -> 'check' -> 'flags' ? 'odd_client'),
                          'a login less than 12 h old: new_login ' || r::text);
end $$;
select neo_v24t.login('wfh', 'd4444444-0000-4000-8000-000000000002');
do $$
declare r jsonb;
begin
  r := neo_v24t.punch('punch_in', neo_v24t.app(8000), 420000);
  perform neo_v24t.assert(r -> 'check' -> 'flags' ? 'odd_client' and r -> 'check' -> 'flags' ? 'new_login',
                          'not the app''s client, and a different session from the last punch ' || r::text);
end $$;
reset role;
select neo_v24t.no_jwt();
do $$
begin
  perform neo_v24t.assert((select count(*) from public.attendance_events where employee_email = neo_v24t.email('wfh')
                            and auth_session = 'd4444444-0000-4000-8000-000000000002') = 1, 'the auth session is stored on the punch');
end $$;


-- ── 12. Deciding, cancelling, listing (D4, D6, D10) ──────────────────────────
select neo_v24t.login('hr');
do $$
declare r jsonb; x jsonb;
begin
  -- the old scopes keep to the v2.3 kinds (NeoHR 2.2, Neo OS 1.12); the v4 ones have everything
  r := public.hr_requests_list('pending');
  perform neo_v24t.assert(not exists (select 1 from jsonb_array_elements(r -> 'requests') x where x.value ->> 'kind' in ('punch_reason', 'away_punch')),
                          'pending: no punch reasons for old clients');
  r := public.hr_requests_list('all');
  perform neo_v24t.assert(not exists (select 1 from jsonb_array_elements(r -> 'requests') x where x.value ->> 'kind' in ('punch_reason', 'away_punch')),
                          'all: no punch reasons for old clients');
  r := public.hr_requests_list('pending_v4');
  x := neo_v24t.req(r, neo_v24t.get('fe_late_req'));
  perform neo_v24t.assert(x is not null and x ->> 'past_eod' = 'true' and x ->> 'can_decide' = 'true' and x ->> 'punch_kind' = 'punch_in'
                          and (x ->> 'punch_at')::timestamptz = neo_v24t.at(-3, '09:41') and x ->> 'place' = 'office' and x ->> 'verify' = 'ok'
                          and x ->> 'reason_kind' = 'late' and x ->> 'event_id' = neo_v24t.get('fe_late_in') and x ? 'selfie' and x ? 'flags'
                          and r -> 'requests' -> 0 ->> 'past_eod' = 'true',
                          'pending_v4: the punch, its place and verify, past the end of day first ' || coalesce(x::text, r::text));
  x := neo_v24t.req(r, neo_v24t.get('desk_away2'));
  perform neo_v24t.assert(x ->> 'kind' = 'away_punch' and x ->> 'can_cancel' = 'false' and x ->> 'can_decide' = 'true', 'an away punch ' || x::text);
  -- the old decide refuses the new kinds with NEO_GATE (never NEO_DENIED)
  perform neo_v24t.expect_error(format('select public.hr_request_decide(%L::uuid, true)', neo_v24t.get('desk_away2')),
                                '%NEO_GATE: Update NeoHR / Neo OS to decide punch reasons.%');
  -- an away punch is never cancelled — HR decides it
  perform neo_v24t.expect_error(format('select public.hr_request_cancel(%L::uuid, %L)', neo_v24t.get('desk_away2'), 'not needed'),
                                '%NEO_GATE: HR decides an away punch — ask them.%');
  -- the decide RPC: checks first
  perform neo_v24t.expect_error(format('select public.hr_punch_request_decide(%L::uuid, null)', neo_v24t.get('desk_away2')),
                                '%NEO_GATE: Say approve or reject.%');
  perform neo_v24t.expect_error(format('select public.hr_punch_request_decide(%L::uuid, false)', neo_v24t.get('desk_away2')),
                                '%NEO_GATE: Say why — the person sees your note.%');
  perform neo_v24t.expect_error(format('select public.hr_punch_request_decide(%L::uuid, false, %L, %L)', neo_v24t.get('desk_away2'), 'Wrong',
                                       '2019-01-01T00:00:00Z'), '%NEO_GATE: That time can''t be right — check the date.%');
  perform neo_v24t.expect_error(format('select public.hr_punch_request_decide(%L::uuid, true, %L)', neo_v24t.get('desk_away2'), repeat('n', 301)),
                                '%NEO_GATE: The note is too long — keep it under 300 characters.%');
  perform neo_v24t.expect_error(format('select public.hr_punch_request_decide(%L::uuid, true)', gen_random_uuid()),
                                '%NEO_GATE: That request no longer exists.%');
  -- away punch approved: the session counts
  r := public.hr_punch_request_decide(neo_v24t.get('desk_away2')::uuid, true, 'Was at the bank for us');
  perform neo_v24t.assert(r ->> 'ok' = 'true' and r -> 'request' ->> 'status' = 'approved' and r -> 'correct' = 'null'::jsonb
                          and (r -> 'day' ->> 'day')::date = neo_v24t.dago(540),
                          'approve an away punch ' || r::text);
  -- away punch_in rejected with the right time: voided, an hr punch at that time
  r := public.hr_punch_request_decide(neo_v24t.get('desk_away3')::uuid, false, 'You were not at the shop yet', now() - interval '6 minutes 30 seconds');
  perform neo_v24t.assert(r ->> 'ok' = 'true' and r -> 'request' ->> 'status' = 'rejected' and r -> 'correct' ->> 'ok' = 'true'
                          and r -> 'correct' -> 'event' ->> 'kind' = 'punch_in',
                          'reject an away punch with the right time ' || r::text);
  perform neo_v24t.put('desk_fix_in', r -> 'correct' -> 'event' ->> 'id');
  -- away punch_out rejected with a time that does not fit: correct.ok false (open Correct…)
  r := public.hr_punch_request_decide(neo_v24t.get('desk_away4')::uuid, false, 'Not from the bank', now() - interval '9 minutes 30 seconds');
  perform neo_v24t.assert(r ->> 'ok' = 'true' and r -> 'correct' ->> 'ok' = 'false' and r -> 'correct' ->> 'message' is not null,
                          'a correct time that does not fit is reported, not raised ' || r::text);
  r := public.hr_punch_request_decide(neo_v24t.get('desk_away4')::uuid, true, null);
  perform neo_v24t.assert(r ->> 'ok' = 'false' and r ->> 'reason' = 'decided' and r ->> 'status' = 'rejected', 'decided once ' || r::text);
  -- punch reasons: approve → excused; reject → the late mark stays
  r := public.hr_punch_request_decide(neo_v24t.get('fe_late_req')::uuid, true, 'Traffic');
  perform neo_v24t.assert(r -> 'request' ->> 'status' = 'approved' and (r -> 'day' ->> 'late_min')::int = 0 and r -> 'day' ->> 'late_excused' = 'true'
                          and (r -> 'day' ->> 'late_raw_min')::int = 1 and r -> 'day' ->> 'status' = 'present',
                          'an approved punch reason excuses the late mark ' || r::text);
  r := public.hr_punch_request_decide(neo_v24t.get('fe_onsite_req')::uuid, false, 'You were at the shop');
  perform neo_v24t.assert(r -> 'request' ->> 'status' = 'rejected' and (r -> 'day' ->> 'late_min')::int = 50 and r -> 'day' ->> 'status' = 'late',
                          'a rejected punch reason leaves the late mark ' || r::text);
  -- another kind through the new RPC: decided as hr_request_decide would
  perform neo_v24t.expect_error(format('select public.hr_punch_request_decide(%L::uuid, true)', gen_random_uuid()), '%NEO_GATE: That request no longer exists.%');
end $$;
reset role;
select neo_v24t.no_jwt();
do $$
declare e public.attendance_events;
begin
  e := neo_v24t.ev(neo_v24t.get('desk_in3')::uuid);
  perform neo_v24t.assert(e.voided_at is not null and e.void_reason = 'HR rejected the away punch: You were not at the shop yet'
                          and e.voided_by = neo_v24t.email('hr'), 'the rejected away punch is voided with the note');
  e := neo_v24t.ev(neo_v24t.get('desk_fix_in')::uuid);
  perform neo_v24t.assert(e.source = 'hr' and e.time_source = 'hr' and e.verify = 'hr' and e.at = now() - interval '6 minutes 30 seconds'
                          and e.created_by_email = neo_v24t.email('hr'), 'HR''s punch at the right time');
  perform neo_v24t.assert((neo_v24t.ev(neo_v24t.get('desk_out4')::uuid)).void_reason = 'HR rejected the away punch: Not from the bank',
                          'the rejected away punch_out is voided');
end $$;
-- the person's side: a punch reason may be cancelled while pending, an away punch never
select neo_v24t.login('fe');
do $$
declare r jsonb;
begin
  -- F31 / §9: 'mine' keeps to the v2.3 kinds (NeoHR 2.2.0 shows raw words otherwise); 'mine_v4' has them all
  r := public.hr_requests_list('mine');
  perform neo_v24t.assert(r ->> 'scope' = 'mine' and neo_v24t.req(r, neo_v24t.get('fe_other_req')) is null
                          and not exists (select 1 from jsonb_array_elements(r -> 'requests') x where x.value ->> 'kind' in ('punch_reason', 'away_punch')),
                          'mine: no punch reasons for NeoHR 2.2.0 ' || r::text);
  r := public.hr_requests_list('mine_v4');
  perform neo_v24t.assert(r ->> 'scope' = 'mine_v4' and neo_v24t.req(r, neo_v24t.get('fe_other_req')) ->> 'can_cancel' = 'true'
                          and neo_v24t.req(r, neo_v24t.get('fe_other_req')) ->> 'kind' = 'punch_reason'
                          and neo_v24t.req(r, neo_v24t.get('fe_other_req')) ->> 'kind_label' = 'Punch-in reason'
                          and neo_v24t.req(r, neo_v24t.get('fe_other_req')) ->> 'can_decide' = 'false',
                          'mine_v4: my punch reasons, cancellable, in words, never mine to decide');
  perform neo_v24t.expect_error($q$select public.hr_requests_list('mine_v5')$q$, '%NEO_GATE: The scope is mine, pending or all.%');
  r := public.hr_request_cancel(neo_v24t.get('fe_other_req')::uuid);
  perform neo_v24t.assert(r ->> 'ok' = 'true' and r -> 'request' ->> 'status' = 'cancelled', 'the owner cancels a pending punch reason ' || r::text);
  -- only a punch makes these kinds: hr_request_create refuses them with its v2.3 sentence
  perform neo_v24t.expect_error(format('select public.hr_request_create(%L::jsonb)',
                                       jsonb_build_object('kind', 'punch_reason', 'date_from', neo_v24t.d(0), 'reason', 'Late bus')),
    '%NEO_GATE: Say what you''re telling HR: late start, early leave, flexible day, field day, missed punch or leave.%');
  perform neo_v24t.expect_error(format('select public.hr_request_create(%L::jsonb)',
                                       jsonb_build_object('kind', 'away_punch', 'date_from', neo_v24t.d(0), 'reason', 'At home')),
    '%NEO_GATE: Say what you''re telling HR: late start, early leave, flexible day, field day, missed punch or leave.%');
  perform neo_v24t.expect_error(format('select public.hr_punch_request_decide(%L::uuid, true)', neo_v24t.get('fe_weak_req')),
                                '%NEO_GATE: Only a head or a NeoHR lead can approve requests.%');
end $$;
select neo_v24t.login('desk2');
do $$
declare r jsonb;
begin
  r := public.hr_requests_list('mine_v4');
  perform neo_v24t.assert(exists (select 1 from jsonb_array_elements(r -> 'requests') x where x.value ->> 'kind' = 'away_punch')
                          and not exists (select 1 from jsonb_array_elements(r -> 'requests') x
                                           where x.value ->> 'kind' = 'away_punch' and x.value ->> 'can_cancel' = 'true')
                          and not exists (select 1 from jsonb_array_elements(r -> 'requests') x
                                           where x.value ->> 'kind' = 'away_punch' and x.value ->> 'kind_label' is distinct from 'Away from shop'),
                          'mine_v4: my away punches, never cancellable, in words');
  perform neo_v24t.assert(not exists (select 1 from jsonb_array_elements(public.hr_requests_list('mine') -> 'requests') x
                                       where x.value ->> 'kind' = 'away_punch'), 'mine: no away punches for NeoHR 2.2.0');
  perform neo_v24t.expect_error(format('select public.hr_request_cancel(%L::uuid)',
                                       (select x.value ->> 'id' from jsonb_array_elements(r -> 'requests') x where x.value ->> 'kind' = 'away_punch' limit 1)),
                                '%NEO_GATE: HR decides an away punch — ask them.%');
end $$;

-- D10: the tier 5's reason goes to tier 4+ only; nobody decides their own
select neo_v24t.login('own5');
do $$
declare r jsonb;
begin
  r := neo_v24t.punch('punch_in', neo_v24t.app(0) || '{"reason": {"kind": "late", "text": "Bank visit"}}'::jsonb, null, neo_v24t.at(-3, '09:45'));
  perform neo_v24t.assert(r -> 'check' -> 'request' ->> 'kind' = 'punch_reason', 'the owner''s late reason ' || r::text);
  perform neo_v24t.put('own_req', r -> 'check' -> 'request' ->> 'id');
  perform neo_v24t.put('own_in', r ->> 'id');
  perform neo_v24t.expect_error(format('select public.hr_punch_request_decide(%L::uuid, true)', r -> 'check' -> 'request' ->> 'id'),
                                '%NEO_GATE: Someone else has to approve or change your own attendance, duty or travel allowance.%');
  perform neo_v24t.punch('punch_out', neo_v24t.app(0), null, neo_v24t.at(-3, '18:30'));
end $$;
select neo_v24t.login('head3');
do $$
declare r jsonb;
begin
  perform neo_v24t.expect_error(format('select public.hr_punch_request_decide(%L::uuid, true)', neo_v24t.get('own_req')),
                                '%NEO_GATE: Requests from a tier 4 or 5 account are decided by tier 4 and above.%');
  r := public.hr_requests_list('pending_v4');
  perform neo_v24t.assert(neo_v24t.req(r, neo_v24t.get('own_req')) ->> 'can_decide' = 'false', 'a tier 3 cannot decide the tier 5''s');
end $$;
select neo_v24t.login('ceo4');
do $$
declare r jsonb;
begin
  r := public.hr_requests_list('pending_v4');
  perform neo_v24t.assert(neo_v24t.req(r, neo_v24t.get('own_req')) ->> 'can_decide' = 'true', 'a tier 4 can');
  r := public.hr_punch_request_decide(neo_v24t.get('own_req')::uuid, true, null);
  perform neo_v24t.assert(r -> 'request' ->> 'status' = 'approved', 'the tier 4 decides the tier 5''s reason ' || r::text);
end $$;
select neo_v24t.login('sales');
do $$
begin
  perform neo_v24t.expect_error(format('select public.hr_punch_request_decide(%L::uuid, true)', neo_v24t.get('fe_weak_req')),
                                '%NEO_GATE: Only a head or a NeoHR lead can approve requests.%');
end $$;

-- hr_correct: a voided punch takes its pending reason with it; a replacement keeps the reason
select neo_v24t.login('hr');
do $$
declare r jsonb;
begin
  r := public.hr_correct(neo_v24t.email('fe'), jsonb_build_object('note', 'The phone showed the wrong place', 'ops', jsonb_build_array(
         jsonb_build_object('action', 'void', 'id', neo_v24t.get('fe_weak_in')),
         jsonb_build_object('action', 'add', 'kind', 'punch_in', 'at', neo_v24t.at(-11, '09:36')))));
  perform neo_v24t.assert(r ->> 'ok' = 'true', 'void + add ' || r::text);
  perform neo_v24t.put('fe_weak_new', r -> 'events' -> 1 ->> 'id');
  -- the approved punch reason of d-3 moves to the replacement punch_in
  r := public.hr_correct(neo_v24t.email('fe'), jsonb_build_object('note', 'In at 09:42 by the gate log', 'ops', jsonb_build_array(
         jsonb_build_object('action', 'void', 'id', neo_v24t.get('fe_late_in')),
         jsonb_build_object('action', 'add', 'kind', 'punch_in', 'at', neo_v24t.at(-3, '09:42')))));
  perform neo_v24t.assert(r -> 'day' ->> 'late_excused' = 'true' and (r -> 'day' ->> 'late_min')::int = 0 and (r -> 'day' ->> 'late_raw_min')::int = 2,
                          'the excuse follows the corrected punch_in ' || (r -> 'day')::text);
  perform neo_v24t.put('fe_late_new', r -> 'events' -> 1 ->> 'id');
end $$;
reset role;
select neo_v24t.no_jwt();
do $$
declare q public.hr_requests; e public.attendance_events;
begin
  select * into q from public.hr_requests where id = neo_v24t.get('fe_weak_req')::uuid;
  perform neo_v24t.assert(q.status = 'cancelled' and q.cancel_note = 'The punch was corrected by HR' and q.cancelled_by_email = neo_v24t.email('hr'),
                          'hr_correct: the pending reason of a voided punch is cancelled');
  e := neo_v24t.ev(neo_v24t.get('fe_weak_new')::uuid);
  perform neo_v24t.assert(e.reason_kind = 'late' and e.place = 'unknown' and e.verify = 'hr', 'the replacement punch_in keeps the reason and place');
  perform neo_v24t.assert((select event_id from public.hr_requests where id = neo_v24t.get('fe_late_req')::uuid) = neo_v24t.get('fe_late_new')::uuid,
                          'the approved punch reason now points at the replacement');
end $$;

-- the dashboard counts and the board
-- (F28, D10) a tier 4 account's pending leave: the tier 2 HR person cannot decide it, so it is not in their count
select neo_v24t.login('ceo4');
do $$
declare r jsonb;
begin
  r := public.hr_request_create(jsonb_build_object('kind', 'leave', 'date_from', neo_v24t.d(5), 'leave_type', 'casual', 'reason', 'Zq family function'));
  perform neo_v24t.assert(r ->> 'ok' = 'true' and r -> 'request' ->> 'status' = 'pending', 'a tier 4 leave request ' || r::text);
  perform neo_v24t.put('ceo_leave', r -> 'request' ->> 'id');
end $$;
reset role;
select neo_v24t.no_jwt();
do $$
begin
  -- what the HR person (tier 2) may decide: the v2.3 kinds, not their own, none of a tier 4 / 5 account
  perform neo_v24t.put('hr_pending_n', (select count(*) from public.hr_requests q
    where q.status = 'pending' and q.kind in ('late_start', 'early_leave', 'flexible_day', 'field_day', 'missed_punch', 'leave')
      and q.employee_email <> neo_v24t.email('hr')
      and coalesce((select p.tier from public.profiles p where lower(p.email) = q.employee_email order by p.active desc limit 1), 0) <= 3)::text);
  perform neo_v24t.put('hr_pending_all', (select count(*) from public.hr_requests q
    where q.status = 'pending' and q.kind in ('late_start', 'early_leave', 'flexible_day', 'field_day', 'missed_punch', 'leave')
      and q.employee_email <> neo_v24t.email('hr'))::text);
end $$;
select neo_v24t.login('hr');
do $$
declare r jsonb; p jsonb; n int;
begin
  r := public.hr_dashboard() -> 'hr';
  -- (r2's over-long Late reason, sent with no fix after an earlier session that day, is still waiting)
  perform neo_v24t.assert((r ->> 'away_pending')::int >= 3 and (r ->> 'reasons_pending')::int >= 1 and (r ->> 'past_eod')::int >= 1
                          and (r ->> 'unverified_today')::int >= 5,
                          'hr counts: away punches waiting, reasons waiting, unverified today ' || r::text);
  n := neo_v24t.get('hr_pending_n')::int;
  perform neo_v24t.assert((r ->> 'pending_requests')::int = n and n < neo_v24t.get('hr_pending_all')::int,
                          format('pending_requests counts only the v2.3 kinds (1.12 desktops, 2.2.0 phones) the caller may decide (D10): %s, expected %s of %s',
                                 r ->> 'pending_requests', n, neo_v24t.get('hr_pending_all')));
  perform neo_v24t.assert(neo_v24t.req(public.hr_requests_list('pending'), neo_v24t.get('ceo_leave')) ->> 'can_decide' = 'false',
                          'the tier 4 leave is listed for the HR person, not theirs to decide');
  r := public.hr_board();
  p := neo_v24t.person(r, neo_v24t.email('desk2'));
  perform neo_v24t.assert(p ->> 'status' in ('on_break', 'on_site', 'on_duty', 'off', 'on_leave', 'off_duty', 'not_tracked', 'not_in_yet', 'absent')
                          and (p ->> 'pending_requests')::int = 0 and (p ->> 'punch_requests')::int >= 3 and p ->> 'field_staff' = 'false'
                          and p ? 'trip' and p ? 'punch_check',
                          'board row: v2.3 status words, pending_requests of the v2.3 kinds, punch_requests, field_staff, trip, punch_check ' || p::text);
  p := neo_v24t.person(r, neo_v24t.email('desk'));
  perform neo_v24t.assert(p -> 'punch_check' ->> 'place' = 'office' and p -> 'punch_check' ->> 'verify' = 'ok',
                          'punch_check: today''s first punch_in ' || p::text);
end $$;


-- ── 13. Field gating (D1): route recording ────────────────────────────────────
select neo_v24t.login('desk');
do $$
declare r jsonb; v uuid := gen_random_uuid();
begin
  r := public.location_push(jsonb_build_array(jsonb_build_object('id', v, 'at', now(), 'age_ms', 30000, 'lat', 10.0159, 'lng', 76.3419, 'accuracy_m', 9)));
  perform neo_v24t.assert(r -> 'rejected' -> 0 ->> 'reason' = 'disabled', 'D1: not field staff — every point is disabled ' || r::text);
  r := public.hr_dashboard() -> 'me' -> 'tracking';
  perform neo_v24t.assert(r ->> 'enabled' = 'false' and r ->> 'reason' = 'disabled'
                          and neo_v24t.keys(r) = array['cap_at', 'distance_m', 'enabled', 'interval_s', 'pause_at', 'reason', 'remind_out_at', 'session_start'],
                          'tracking: disabled, the v2.3 keys ' || r::text);
end $$;


-- ── 14. Punch photos (D9) ───────────────────────────────────────────────────
select neo_v24t.login('pic');
do $$
declare r jsonb; v_out uuid; j bytea;
begin
  r := neo_v24t.punch('punch_out', neo_v24t.app(0), 300000);
  v_out := (r ->> 'id')::uuid;
  perform neo_v24t.put('pic_out', v_out::text);
  r := neo_v24t.photo(gen_random_uuid(), neo_v24t.jpeg(5000));
  perform neo_v24t.assert(r = '{"ok": false, "wait": true}'::jsonb, 'the punch is not here yet: wait ' || r::text);
  j := neo_v24t.jpeg(5000);
  perform neo_v24t.put('pic_md5', md5(j));
  r := neo_v24t.photo(v_out, j);
  perform neo_v24t.assert(r = '{"ok": true, "duplicate": false, "late": false}'::jsonb, 'a photo for my punch_out ' || r::text);
  r := neo_v24t.photo(v_out, neo_v24t.jpeg(5000));
  perform neo_v24t.assert(r ->> 'ok' = 'true' and r ->> 'duplicate' = 'true', 'the same punch again: duplicate, never replaced ' || r::text);
  r := public.hr_punch(jsonb_build_object('id', v_out, 'kind', 'punch_out', 'at', now()));
  perform neo_v24t.assert(r -> 'check' ->> 'needs_selfie' = 'false', 'a replay: the photo is in');
  -- the byte-identical photo on another punch
  r := neo_v24t.punch('punch_in', neo_v24t.app(0), 240000);
  perform neo_v24t.put('pic_in2', r ->> 'id');
  perform neo_v24t.expect_error(format('select neo_v24t.photo(%L::uuid, %L::bytea)', r ->> 'id', j), '%NEO_GATE: That photo was already used.%');
  -- shapes and sizes
  perform neo_v24t.expect_error($q$select public.hr_selfie_put(null)$q$, '%NEO_GATE: The request is empty.%');
  perform neo_v24t.expect_error($q$select public.hr_selfie_put('{"jpeg_b64": "x"}'::jsonb)$q$, '%NEO_GATE: Say which punch the photo is for.%');
  perform neo_v24t.expect_error(format('select public.hr_selfie_put(%L::jsonb)', jsonb_build_object('event_id', r ->> 'id', 'jpeg_b64', repeat('!', 3000))),
                                '%NEO_GATE: The photo could not be read — take it again.%');
  perform neo_v24t.expect_error(format('select neo_v24t.photo(%L::uuid, neo_v24t.jpeg(1500))', r ->> 'id'),
                                '%NEO_GATE: The photo must be between 2 KB and 60 KB.%');
  perform neo_v24t.expect_error(format('select neo_v24t.photo(%L::uuid, neo_v24t.jpeg(61000))', r ->> 'id'),
                                '%NEO_GATE: The photo must be between 2 KB and 60 KB.%');
  perform neo_v24t.expect_error(format('select neo_v24t.photo(%L::uuid, neo_v24t.jpeg(5000, %L::bytea))', r ->> 'id', '\x89504e47'),
                                '%NEO_GATE: That is not a JPEG photo.%');
  perform neo_v24t.expect_error(format('select neo_v24t.photo(%L::uuid, neo_v24t.jpeg(5000), jsonb_build_object(%L, neo_v24t.b64(neo_v24t.jpeg(9000))))',
                                       r ->> 'id', 'thumb_b64'), '%NEO_GATE: The small photo must be a JPEG under 8 KB.%');
  -- someone else's punch
  perform neo_v24t.expect_error(format('select neo_v24t.photo(%L::uuid, neo_v24t.jpeg(5000))', neo_v24t.get('desk_in1')),
                                '%NEO_GATE: That punch is someone else''s.%');
end $$;
-- a break, an HR punch, a voided punch, a punch past retention, a late photo, a photo taken long before
reset role;
select neo_v24t.no_jwt();
do $$
begin
  perform neo_v24t.put('pic_brk', neo_v24t.raw_event('pic', 'break_start', now() - interval '3 hours')::text);
  perform neo_v24t.put('pic_hr', neo_v24t.raw_event('pic', 'punch_in', neo_v24t.at(-20, '09:00'), 'hr')::text);
  perform neo_v24t.put('pic_void', neo_v24t.raw_event('pic', 'punch_in', neo_v24t.at(-21, '09:00'))::text);
  update public.attendance_events set voided_at = now(), voided_by = 'tests' where id = neo_v24t.get('pic_void')::uuid;
  perform neo_v24t.put('pic_old', neo_v24t.raw_event('pic', 'punch_in', neo_v24t.at(-100, '09:00'))::text);
  perform neo_v24t.put('pic_late', neo_v24t.raw_event('pic', 'punch_in', neo_v24t.at(-22, '09:00'), 'phone', now() - interval '20 minutes')::text);
  perform neo_v24t.put('pic_taken', neo_v24t.raw_event('pic', 'punch_in', now() - interval '5 hours')::text);
end $$;
select neo_v24t.login('pic');
do $$
declare r jsonb; i int; v uuid; v_n int := 0;
begin
  perform neo_v24t.expect_error(format('select neo_v24t.photo(%L::uuid, neo_v24t.jpeg(5000))', neo_v24t.get('pic_brk')),
                                '%NEO_GATE: A photo goes with a punch in or a punch out.%');
  perform neo_v24t.expect_error(format('select neo_v24t.photo(%L::uuid, neo_v24t.jpeg(5000))', neo_v24t.get('pic_hr')),
                                '%NEO_GATE: A photo goes with a punch in or a punch out.%');
  perform neo_v24t.expect_error(format('select neo_v24t.photo(%L::uuid, neo_v24t.jpeg(5000))', neo_v24t.get('pic_void')),
                                '%NEO_GATE: That punch was removed.%');
  perform neo_v24t.expect_error(format('select neo_v24t.photo(%L::uuid, neo_v24t.jpeg(5000))', neo_v24t.get('pic_old')),
                                '%NEO_GATE: That punch is too old for a photo.%');
  r := neo_v24t.photo(neo_v24t.get('pic_late')::uuid, neo_v24t.jpeg(4000));
  perform neo_v24t.assert(r ->> 'late' = 'true', 'a photo more than 10 minutes after its punch arrived: late ' || r::text);
  r := neo_v24t.photo(neo_v24t.get('pic_taken')::uuid, neo_v24t.jpeg(4000), jsonb_build_object('taken_at', now() - interval '1 day'));
  perform neo_v24t.assert(r ->> 'ok' = 'true', 'a photo whose time is far from the punch is kept, and flagged');
  -- R6: 8 photos a person a day (3 so far today)
  for i in 1 .. 6 loop
    reset role;
    v := neo_v24t.raw_event('pic', case when i % 2 = 1 then 'punch_in' else 'punch_out' end, neo_v24t.at(-30 - i, '09:00'));
    perform neo_v24t.login('pic');
    begin
      r := neo_v24t.photo(v, neo_v24t.jpeg(2500));
      v_n := v_n + 1;
    exception when others then
      perform neo_v24t.assert(sqlerrm like 'NEO_GATE: Too many photos today.%' and v_n = 5, format('the cap after 8 (%s more): %s', v_n, sqlerrm));
    end;
  end loop;
  perform neo_v24t.assert(v_n = 5, 'R6: 8 photos a day, then "NEO_GATE: Too many photos today." (' || v_n || ')');
end $$;
reset role;
select neo_v24t.no_jwt();
do $$
declare s public.hr_punch_selfies;
begin
  select * into s from public.hr_punch_selfies where event_id = neo_v24t.get('pic_out')::uuid;
  perform neo_v24t.assert(s.bytes = 5000 and s.width = 480 and s.height = 360 and s.md5 = neo_v24t.get('pic_md5') and not s.late
                          and octet_length(s.thumb) = 1200 and s.employee_email = neo_v24t.email('pic')
                          and s.event_at = (neo_v24t.ev(neo_v24t.get('pic_out')::uuid)).at, 'the stored photo: bytes, size, md5, the punch time');
  perform neo_v24t.assert('selfie_time' = any ((neo_v24t.ev(neo_v24t.get('pic_taken')::uuid)).flags), 'selfie_time flags the punch');
end $$;
-- seeing the photos: approvers only, a tier 4 / 5 account's only by tier 4+, every view logged
select neo_v24t.login('own5');
do $$
begin
  perform neo_v24t.assert(neo_v24t.photo(neo_v24t.get('own_in')::uuid, neo_v24t.jpeg(3000)) ->> 'ok' = 'true', 'the owner''s punch photo');
end $$;
select neo_v24t.login('sales');
do $$
begin
  perform neo_v24t.expect_error(format('select public.hr_selfie_get(%L::uuid)', neo_v24t.get('pic_out')),
                                '%NEO_GATE: Only a head or a NeoHR lead can see punch photos.%');
  perform neo_v24t.expect_error($q$select public.hr_punch_checks(null)$q$, '%NEO_GATE: Only a head or a NeoHR lead can see the punch checks.%');
end $$;
select neo_v24t.login('head3');
do $$
declare r jsonb;
begin
  perform neo_v24t.expect_error(format('select public.hr_selfie_get(%L::uuid)', neo_v24t.get('own_in')),
                                '%NEO_GATE: Only tier 4 and above can see the photos of a tier 4 or 5 account.%');
  perform neo_v24t.expect_error(format('select public.hr_selfie_get(%L::uuid)', gen_random_uuid()), '%NEO_GATE: That photo is not there any more.%');
  r := neo_v24t.req(public.hr_requests_list('all_v4'), neo_v24t.get('own_req'));
  perform neo_v24t.assert(r -> 'selfie' ->> 'thumb_b64' is null and r -> 'selfie' ? 'late' and r -> 'selfie' ->> 'has_thumb' = 'false',
                          'a tier 3 sees no thumb of the tier 5''s photo ' || r::text);
end $$;
select neo_v24t.login('ceo4');
do $$
declare r jsonb;
begin
  -- (F33) own_req is decided: its row carries no thumb — has_thumb says one is there (hr_selfie_get opens it)
  r := neo_v24t.req(public.hr_requests_list('all_v4'), neo_v24t.get('own_req'));
  perform neo_v24t.assert(r ->> 'status' = 'approved' and not (r -> 'selfie' ? 'thumb_b64') and r -> 'selfie' ->> 'has_thumb' = 'true',
                          'a tier 4 may see it: a decided request says has_thumb, without the thumb ' || r::text);
  perform neo_v24t.assert(public.hr_selfie_get(neo_v24t.get('own_in')::uuid) ->> 'ok' = 'true', 'tier 4: the full photo');
end $$;
select neo_v24t.login('hr');
do $$
declare r jsonb; x jsonb; n int;
begin
  r := public.hr_selfie_get(neo_v24t.get('pic_out')::uuid);
  perform neo_v24t.assert(r ->> 'ok' = 'true' and md5(decode(r ->> 'jpeg_b64', 'base64')) = neo_v24t.get('pic_md5')
                          and (r ->> 'w')::int = 480 and r ->> 'late' = 'false' and r ->> 'event_id' = neo_v24t.get('pic_out'),
                          'the full photo, byte for byte ' || left(r::text, 200));
  -- today's punches: flagged first, the photo, the previous photo, seen_by_me
  r := public.hr_punch_checks(null);
  perform neo_v24t.assert((r ->> 'day')::date = neo_v24t.today() and (r -> 'counts' ->> 'punches')::int = jsonb_array_length(r -> 'punches')
                          and (r -> 'counts' ->> 'unverified')::int = (select count(*) from jsonb_array_elements(r -> 'punches') p
                                                                       where (p.value ->> 'unverified')::boolean)
                          and not exists (select 1 from jsonb_array_elements(r -> 'punches') with ordinality p(value, o)
                                           where not (p.value ->> 'unverified')::boolean
                                             and exists (select 1 from jsonb_array_elements(r -> 'punches') with ordinality q(value, o2)
                                                          where o2 > p.o and (q.value ->> 'unverified')::boolean)),
                          'hr_punch_checks: counts, and every unverified punch before the rest');
  select p.value into x from jsonb_array_elements(r -> 'punches') p where p.value ->> 'id' = neo_v24t.get('pic_out');
  perform neo_v24t.assert(x is null or (x -> 'selfie' ->> 'thumb_b64' is not null and x -> 'selfie' ->> 'seen_by_me' = 'true'
                                        and x -> 'selfie' ->> 'seen_by_any' = 'true'),
                          'a photo HR opened: seen_by_me ' || coalesce(x::text, 'not today'));
  select p.value into x from jsonb_array_elements(r -> 'punches') p where p.value ->> 'id' = neo_v24t.get('desk_in1');
  perform neo_v24t.assert(x is null or (x ->> 'place' = 'office' and x ->> 'verify' = 'ok' and x ->> 'unverified' = 'false' and x -> 'selfie' = 'null'::jsonb),
                          'verified at the shop, its photo not due for 10 minutes yet: not flagged ' || coalesce(x::text, 'not today'));
  -- the previous photo to compare with (pic: the late one before the newer ones)
  r := public.hr_punch_checks(neo_v24t.d(-22));
  perform neo_v24t.assert(jsonb_array_length(r -> 'punches') >= 1, 'another day ' || r::text);
end $$;


reset role;
select neo_v24t.no_jwt();
do $$
declare n int;
begin
  select count(*) into n from public.hr_selfie_views where event_id = neo_v24t.get('pic_out')::uuid and viewer_email = neo_v24t.email('hr');
  perform neo_v24t.assert(n = 1, 'every full view is logged; thumbs are not (' || n || ')');
end $$;

-- ── 15. Away-pending totals in the month and the register ────────────────────
select neo_v24t.login('desk2');
do $$
declare r jsonb;
begin
  r := public.hr_my_month(neo_v24t.dago(540));
  perform neo_v24t.assert((r -> 'totals' ->> 'away_pending')::int >= 1, 'an away-pending day is counted as such ' || (r -> 'totals')::text);
end $$;
select neo_v24t.login('hr');
do $$
declare r jsonb; p jsonb;
begin
  r := public.hr_register(neo_v24t.dago(540), neo_v24t.dago(540), neo_v24t.email('desk2'));
  p := neo_v24t.person(r, neo_v24t.email('desk2'));
  perform neo_v24t.assert((p -> 'totals' ->> 'away_pending')::int = 1 and (p -> 'days' -> 0 ->> 'away_pending')::boolean
                          and (p -> 'totals' ->> 'present')::int = 0 and (p -> 'totals' ->> 'late')::int = 0,
                          'register: per-person totals with away_pending ' || p::text);
end $$;



-- ── 16. Retention: photos, their views, trips (§9.8 v2.4) ───────────────────
reset role;
select neo_v24t.no_jwt();
do $$
declare r jsonb; v uuid := neo_v24t.raw_event('pic', 'punch_in', neo_v24t.at(-120, '09:00'));
begin
  insert into public.hr_punch_selfies (event_id, profile_id, employee_email, event_at, taken_at, jpeg, bytes, md5)
  values (v, neo_v24t.uid('pic'), neo_v24t.email('pic'), neo_v24t.at(-120, '09:00'), now(), neo_v24t.jpeg(3000), 3000, md5(random()::text));
  insert into public.hr_selfie_views (viewer_email, event_id, at) values (neo_v24t.email('hr'), v, neo_v24t.at(-120, '10:00'));
  insert into public.hr_trips (id, profile_id, employee_email, kind, note, started_at, start_lat, start_lng, start_acc)
  values ('e5555555-0000-4000-8000-000000000009', neo_v24t.uid('ta'), neo_v24t.email('ta'), 'on_site', 'Long ago', neo_v24t.at(-120, '10:00'),
          10.0, 76.3, 8);
  update public.hr_settings set last_purge_at = null where id = 1;
  r := public._hr_purge();
  perform neo_v24t.assert((r ->> 'selfies_deleted')::int >= 1 and (r ->> 'trip_finals')::int >= 1 and r ?& array['cutoff', 'deleted', 'finals', 'done'],
                          '_hr_purge: old photos go, old trips are final ' || r::text);
  perform neo_v24t.assert(not exists (select 1 from public.hr_punch_selfies where event_id = v)
                          and not exists (select 1 from public.hr_selfie_views where event_id = v)
                          and exists (select 1 from public.hr_trips where id = 'e5555555-0000-4000-8000-000000000009' and final
                                        and start_lat is null and start_lng is null and km = 0)
                          and exists (select 1 from public.hr_punch_selfies where event_id = neo_v24t.get('pic_out')::uuid),
                          'retention: a 120-day-old photo, its views and the trip''s coordinates go; today''s photo stays');
end $$;


-- ── 17. The review round: device flags, failed requests, what lists carry, the bounded purge ──
-- F1: what the phone reports about itself (p.flags) — fake-GPS route points, an emulator — becomes a server flag
select neo_v24t.login('ta');
do $$
declare r jsonb;
begin
  r := neo_v24t.punch('punch_in', neo_v24t.app(0) || '{"flags": {"mock_route_points": 3, "emulator": true, "dev_options": true}}'::jsonb, 120000);
  perform neo_v24t.assert(r ->> 'ok' = 'true' and r -> 'check' -> 'flags' ? 'mock_route' and r -> 'check' -> 'flags' ? 'emulator'
                          and not (r -> 'check' -> 'flags' ? 'dev_options') and r -> 'check' -> 'request' = 'null'::jsonb,
                          'F1: fake-GPS route points and an emulator are server flags (developer options alone is not) ' || r::text);
  perform neo_v24t.put('ta_mock', r ->> 'id');
  r := neo_v24t.punch('punch_out', neo_v24t.app(0) || '{"flags": {"mock_route_points": 0, "emulator": false}}'::jsonb, 100000);
  perform neo_v24t.assert(r ->> 'ok' = 'true' and not (r -> 'check' -> 'flags' ? 'mock_route') and not (r -> 'check' -> 'flags' ? 'emulator'),
                          'F1: no fake points, no emulator: no flag ' || r::text);
  r := neo_v24t.punch('punch_in', neo_v24t.app(0) || '{"flags": {"mock_route_points": "lots", "emulator": "yes"}}'::jsonb, 80000);
  perform neo_v24t.assert(r ->> 'ok' = 'true' and r -> 'check' -> 'flags' = '[]'::jsonb, 'F1 (R2): junk device flags: no flag, the punch counts ' || r::text);
  r := neo_v24t.punch('punch_out', neo_v24t.app(0) || '{"flags": {"mock_route_points": 1}}'::jsonb, 60000);
  perform neo_v24t.assert(r -> 'check' -> 'flags' ? 'mock_route', 'F1: one fake point is enough ' || r::text);
end $$;

-- F29: a request that cannot be made never fails open — the punch is kept, check.request says so, the punch is flagged
reset role;
select neo_v24t.no_jwt();
create function neo_v24t.boom() returns trigger language plpgsql as $$
begin
  if new.employee_email = 'zq.v24.basic@neotokyo.test' then raise exception 'zq test: the request store is broken'; end if;
  return new;
end $$;
create trigger zq_v24_boom before insert on public.hr_requests for each row execute function neo_v24t.boom();
select neo_v24t.login('basic');
do $$
declare r jsonb; r2 jsonb;
begin
  r := neo_v24t.punch('punch_in', neo_v24t.app(2000), 110000);
  perform neo_v24t.assert(r ->> 'ok' = 'true' and r ->> 'duplicate' = 'false' and r -> 'check' ->> 'place' = 'away'
                          and r -> 'check' -> 'request' ->> 'ok' = 'false' and char_length(r -> 'check' -> 'request' ->> 'message') > 10
                          and r -> 'check' -> 'flags' ? 'request_failed',
                          'F29: the away request could not be made: the punch is kept, check.request {ok:false, message}, request_failed ' || r::text);
  perform neo_v24t.put('basic_fail', r ->> 'id');
  r2 := public.hr_punch(jsonb_build_object('id', r ->> 'id', 'kind', 'punch_in', 'at', now()));
  perform neo_v24t.assert(r2 ->> 'duplicate' = 'true' and r2 -> 'check' -> 'request' ->> 'ok' = 'false' and r2 -> 'check' -> 'flags' ? 'request_failed',
                          'F29: a replay answers the same ' || r2::text);
end $$;
reset role;
select neo_v24t.no_jwt();
drop trigger zq_v24_boom on public.hr_requests;
do $$
declare e public.attendance_events;
begin
  e := neo_v24t.ev(neo_v24t.get('basic_fail')::uuid);
  perform neo_v24t.assert(e.request_id is null and 'request_failed' = any (e.flags) and e.voided_at is null
                          and not exists (select 1 from public.hr_requests where event_id = e.id) and public._hr_unverified(e, now()),
                          'F29: stored with request_failed and no request: it is in HR''s To check');
  -- an HR punch (never a photo) is today's first punch_in of head3
  perform neo_v24t.put('head3_hr', neo_v24t.raw_event('head3', 'punch_in',
                                                      greatest(public._hr_at(neo_v24t.today(), '00:00'), now() - interval '30 seconds'), 'hr')::text);
end $$;

-- sales (not field staff): an away punch_in with no camera, an away punch_out with a photo, a punch_in at the shop with a photo
select neo_v24t.login('sales');
do $$
declare r jsonb;
begin
  r := neo_v24t.punch('punch_in', neo_v24t.app(0) || '{"selfie_skip": "camera_error"}'::jsonb, 300000);
  perform neo_v24t.assert(r -> 'check' -> 'request' ->> 'kind' = 'away_punch' and r -> 'check' -> 'request' ->> 'ok' = 'true'
                          and r -> 'check' -> 'request' ->> 'status' = 'pending', 'a request that was made: check.request.ok ' || r::text);
  perform neo_v24t.put('sales_in', r ->> 'id');
  perform neo_v24t.put('sales_in_req', r -> 'check' -> 'request' ->> 'id');
  r := neo_v24t.punch('punch_out', neo_v24t.app(1500), 240000);
  perform neo_v24t.assert(r -> 'check' -> 'request' ->> 'kind' = 'away_punch', 'away punch_out ' || r::text);
  perform neo_v24t.put('sales_out', r ->> 'id');
  perform neo_v24t.put('sales_out_req', r -> 'check' -> 'request' ->> 'id');
  perform neo_v24t.assert(neo_v24t.photo((r ->> 'id')::uuid, neo_v24t.jpeg(4000)) ->> 'ok' = 'true', 'its photo');
  r := neo_v24t.punch('punch_in', neo_v24t.app(0), 180000);
  perform neo_v24t.assert(r -> 'check' -> 'request' = 'null'::jsonb, 'at the shop ' || r::text);
  perform neo_v24t.put('sales_in2', r ->> 'id');
  perform neo_v24t.assert(neo_v24t.photo((r ->> 'id')::uuid, neo_v24t.jpeg(4000)) ->> 'ok' = 'true', 'its photo');
  -- F31: 'mine' (NeoHR 2.2.0) has none of the punch kinds, 'mine_v4' has both, in words
  r := public.hr_requests_list('mine');
  perform neo_v24t.assert(neo_v24t.req(r, neo_v24t.get('sales_in_req')) is null and neo_v24t.req(r, neo_v24t.get('sales_out_req')) is null,
                          'F31: mine keeps to the v2.3 kinds ' || r::text);
  r := public.hr_requests_list('mine_v4');
  perform neo_v24t.assert(neo_v24t.req(r, neo_v24t.get('sales_in_req')) ->> 'kind_label' = 'Away from shop'
                          and neo_v24t.req(r, neo_v24t.get('sales_out_req')) ->> 'can_cancel' = 'false',
                          'F31: mine_v4 has them, with kind_label ' || r::text);
  -- F18: my own day says whether I am field staff
  r := public.hr_my_day(neo_v24t.dago(240));
  perform neo_v24t.assert(r ->> 'field_staff' = 'false' and r ->> 'away_pending' = 'true', 'F18: hr_my_day.field_staff (own day) ' || left(r::text, 300));
end $$;

select neo_v24t.login('hr');
do $$
declare r jsonb; p jsonb; x jsonb;
begin
  -- F4: the board's punch_check says how the punch came (no photo expected from an HR punch or a skipped camera)
  if neo_v24t.dago(300) = neo_v24t.today() then
    p := neo_v24t.person(public.hr_board(), neo_v24t.email('sales'));
    perform neo_v24t.assert(p -> 'punch_check' ->> 'id' = neo_v24t.get('sales_in') and p -> 'punch_check' ->> 'selfie_skip' = 'camera_error'
                            and p -> 'punch_check' ->> 'source' = 'phone' and p -> 'punch_check' ->> 'selfie' = 'false',
                            'F4: punch_check.selfie_skip and source ' || (p -> 'punch_check')::text);
  end if;
  p := neo_v24t.person(public.hr_board(), neo_v24t.email('head3'));
  perform neo_v24t.assert(p -> 'punch_check' ->> 'id' = neo_v24t.get('head3_hr') and p -> 'punch_check' ->> 'source' = 'hr'
                          and p -> 'punch_check' ? 'selfie_skip', 'F4: an HR punch says source hr ' || (p -> 'punch_check')::text);
  -- F33: a pending request carries its thumb …
  x := neo_v24t.req(public.hr_requests_list('pending_v4'), neo_v24t.get('sales_out_req'));
  perform neo_v24t.assert(x -> 'selfie' ->> 'thumb_b64' is not null and x -> 'selfie' ->> 'has_thumb' = 'true' and x ->> 'kind_label' = 'Away from shop',
                          'F33: a pending request: the thumb ' || left(x::text, 300));
  -- F5 / F15 / F18: the day panel's requests carry can_decide / can_cancel; the day says field_staff
  r := public.hr_my_day(neo_v24t.dago(240), neo_v24t.email('sales'));
  x := (select q.value from jsonb_array_elements(r -> 'requests') q where q.value ->> 'id' = neo_v24t.get('sales_out_req'));
  perform neo_v24t.assert(r ->> 'field_staff' = 'false' and x ->> 'can_decide' = 'true' and x ->> 'can_cancel' = 'false',
                          'F5: hr_my_day.requests: can_decide / can_cancel as the lists ' || coalesce(x::text, r::text));
  perform neo_v24t.assert(public.hr_my_day(neo_v24t.dago(120), neo_v24t.email('ta')) ->> 'field_staff' = 'true', 'F18: field staff');
  r := public.hr_my_day(neo_v24t.d(5), neo_v24t.email('ceo4'));
  x := (select q.value from jsonb_array_elements(r -> 'requests') q where q.value ->> 'id' = neo_v24t.get('ceo_leave'));
  perform neo_v24t.assert(x ->> 'can_decide' = 'false' and x ->> 'can_cancel' = 'true',
                          'F5 (D10): a tier 4 account''s request is not the tier 2 HR person''s to decide ' || coalesce(x::text, r::text));
  -- … a decided one does not (has_thumb; hr_selfie_get opens it)
  r := public.hr_punch_request_decide(neo_v24t.get('sales_out_req')::uuid, true, 'At the customer''s for us');
  perform neo_v24t.assert(r ->> 'ok' = 'true' and not (r -> 'request' -> 'selfie' ? 'thumb_b64') and r -> 'request' -> 'selfie' ->> 'has_thumb' = 'true',
                          'F33: the decided request answers without the thumb ' || left(r::text, 300));
  x := neo_v24t.req(public.hr_requests_list('all_v4'), neo_v24t.get('sales_out_req'));
  perform neo_v24t.assert(x ->> 'status' = 'approved' and not (x -> 'selfie' ? 'thumb_b64') and x -> 'selfie' ->> 'has_thumb' = 'true',
                          'F33: all_v4: no thumb on a decided row ' || left(x::text, 300));
  -- F33 / gaps: hr_punch_checks rows — event_id, device_flags, the previous photo without a second thumb
  r := public.hr_punch_checks(neo_v24t.dago(180));
  x := (select q.value from jsonb_array_elements(r -> 'punches') q where q.value ->> 'id' = neo_v24t.get('sales_in2'));
  perform neo_v24t.assert(x ->> 'event_id' = neo_v24t.get('sales_in2') and x -> 'selfie' ->> 'thumb_b64' is not null
                          and x -> 'prev_selfie' ->> 'event_id' = neo_v24t.get('sales_out') and x -> 'prev_selfie' ? 'event_at'
                          and not (x -> 'prev_selfie' ? 'thumb_b64') and x ? 'device_flags',
                          'hr_punch_checks: event_id, the thumb, prev_selfie {event_id, event_at} only ' || coalesce(left(x::text, 400), 'missing'));
  r := public.hr_punch_checks(neo_v24t.dago(120));
  x := (select q.value from jsonb_array_elements(r -> 'punches') q where q.value ->> 'id' = neo_v24t.get('ta_mock'));
  perform neo_v24t.assert(x ->> 'unverified' = 'true' and x -> 'flags' ? 'mock_route' and (x -> 'device_flags' ->> 'mock_route_points')::int = 3
                          and x -> 'device_flags' ->> 'emulator' = 'true',
                          'F1: HR sees the fake-GPS route in To check, with the device flags ' || coalesce(x::text, 'missing'));
  -- on_leave in the hr block (the hr dashboard's "On leave" tile), the same as the board's count
  perform public.hr_roster_set(neo_v24t.email('supply'), neo_v24t.today(), 'leave', null);
  perform neo_v24t.assert((public.hr_dashboard() -> 'hr' ->> 'on_leave')::int >= 1
                          and (public.hr_dashboard() -> 'hr' ->> 'on_leave')::int = coalesce((public.hr_board() -> 'counts' ->> 'on_leave')::int, 0)
                          and neo_v24t.person(public.hr_board(), neo_v24t.email('supply')) ->> 'status' = 'on_leave',
                          'hr.on_leave: people on leave today ' || (public.hr_dashboard() -> 'hr')::text);
end $$;
select neo_v24t.login('own5');
do $$
declare x jsonb;
begin
  x := (select q.value from jsonb_array_elements(public.hr_my_day(neo_v24t.d(5), neo_v24t.email('ceo4')) -> 'requests') q
         where q.value ->> 'id' = neo_v24t.get('ceo_leave'));
  perform neo_v24t.assert(x ->> 'can_decide' = 'true', 'F5 (D10): the tier 5 may decide the tier 4''s request ' || coalesce(x::text, 'missing'));
end $$;
select neo_v24t.login('ceo4');
do $$
declare x jsonb;
begin
  x := (select q.value from jsonb_array_elements(public.hr_my_day(neo_v24t.d(5)) -> 'requests') q where q.value ->> 'id' = neo_v24t.get('ceo_leave'));
  perform neo_v24t.assert(x ->> 'can_decide' = 'false' and x ->> 'can_cancel' = 'true', 'F5: my own request: cancel, never decide ' || coalesce(x::text, 'missing'));
end $$;

-- unseen_photos leaves out the photos of removed punches
reset role;
select neo_v24t.no_jwt();
do $$
declare v uuid := neo_v24t.raw_event('cap', 'punch_out', greatest(public._hr_at(neo_v24t.today(), '00:00'), now() - interval '20 seconds'));
begin
  insert into public.hr_punch_selfies (event_id, profile_id, employee_email, event_at, taken_at, jpeg, bytes, md5)
  values (v, neo_v24t.uid('cap'), neo_v24t.email('cap'), (neo_v24t.ev(v)).at, now(), neo_v24t.jpeg(3000), 3000, md5(random()::text));
  perform neo_v24t.put('cap_photo', v::text);
end $$;
select neo_v24t.login('hr');
do $$ begin perform neo_v24t.put('unseen_1', public.hr_dashboard() -> 'hr' ->> 'unseen_photos'); end $$;
reset role;
select neo_v24t.no_jwt();
update public.attendance_events set voided_at = now(), voided_by = 'tests', void_reason = 'Zq test' where id = neo_v24t.get('cap_photo')::uuid;
select neo_v24t.login('hr');
do $$
begin
  perform neo_v24t.assert((public.hr_dashboard() -> 'hr' ->> 'unseen_photos')::int = neo_v24t.get('unseen_1')::int - 1,
                          'unseen_photos: a removed punch''s photo no longer waits for a look');
end $$;

-- F32: the bounded purge finalises trips oldest first, whoever they belong to, and never deletes a point inside a trip
-- that is not final yet. T1 (ta, d−200) is the oldest; 49 fillers of fe2 (no route) follow; T2 (fe2, d−130) is the 51st.
reset role;
select neo_v24t.no_jwt();
do $$
declare
  r jsonb; v_km1 numeric; v_km2 numeric; t public.hr_trips;
  v_t1 uuid := 'e5555555-0000-4000-8000-000000000011';
  v_t2 uuid := 'e5555555-0000-4000-8000-000000000012';
begin
  perform neo_v24t.raw_event('ta', 'punch_in', neo_v24t.at(-200, '09:00'));
  perform neo_v24t.raw_event('ta', 'punch_out', neo_v24t.at(-200, '17:00'));
  perform neo_v24t.raw_points('ta', jsonb_build_array(
    jsonb_build_object('at', neo_v24t.at(-200, '10:05'), 'lat', 10.0, 'lng', 76.30, 'accuracy_m', 10),
    jsonb_build_object('at', neo_v24t.at(-200, '10:25'), 'lat', 10.0, 'lng', 76.31, 'accuracy_m', 10),
    jsonb_build_object('at', neo_v24t.at(-200, '10:45'), 'lat', 10.0, 'lng', 76.32, 'accuracy_m', 10)));
  perform neo_v24t.raw_event('fe2', 'punch_in', neo_v24t.at(-130, '09:00'));
  perform neo_v24t.raw_event('fe2', 'punch_out', neo_v24t.at(-130, '17:00'));
  perform neo_v24t.raw_points('fe2', jsonb_build_array(
    jsonb_build_object('at', neo_v24t.at(-130, '10:05'), 'lat', 10.0, 'lng', 76.30, 'accuracy_m', 10),
    jsonb_build_object('at', neo_v24t.at(-130, '10:25'), 'lat', 10.0, 'lng', 76.31, 'accuracy_m', 10),
    jsonb_build_object('at', neo_v24t.at(-130, '10:45'), 'lat', 10.0, 'lng', 76.32, 'accuracy_m', 10),
    jsonb_build_object('at', neo_v24t.at(-130, '15:00'), 'lat', 10.0, 'lng', 76.40, 'accuracy_m', 10)));
  insert into public.hr_trips (id, profile_id, employee_email, kind, note, started_at, ended_at, end_source, end_reason)
  values (v_t1, neo_v24t.uid('ta'), neo_v24t.email('ta'), 'on_site', 'Zq old site one', neo_v24t.at(-200, '10:00'), neo_v24t.at(-200, '11:30'), 'phone', 'tapped'),
         (v_t2, neo_v24t.uid('fe2'), neo_v24t.email('fe2'), 'on_site', 'Zq old site two', neo_v24t.at(-130, '10:00'), neo_v24t.at(-130, '11:30'), 'phone', 'tapped');
  insert into public.hr_trips (id, profile_id, employee_email, kind, note, started_at)
  select gen_random_uuid(), neo_v24t.uid('fe2'), neo_v24t.email('fe2'), 'on_site', 'Zq filler trip', neo_v24t.at(-180, '10:00') + g * interval '1 minute'
    from generate_series(1, 49) as g;
  v_km1 := (public._hr_trip_measure(v_t1, now()) ->> 'km')::numeric;
  v_km2 := (public._hr_trip_measure(v_t2, now()) ->> 'km')::numeric;
  perform neo_v24t.assert(v_km1 > 1 and v_km2 > 1, format('the two old trips measure %s and %s km', v_km1, v_km2));
  update public.hr_settings set last_purge_at = null where id = 1;
  -- a bounded call (location_push's): 50 trips at most
  r := public._hr_purge(5000);
  select * into t from public.hr_trips where id = v_t1;
  perform neo_v24t.assert((r ->> 'trip_finals')::int = 50 and t.final and t.km = v_km1 and t.start_lat is null,
                          'F32: the oldest trip (someone later in the alphabet) is final first, with its km ' || r::text || ' ' || row_to_json(t)::text);
  select * into t from public.hr_trips where id = v_t2;
  perform neo_v24t.assert(not t.final
                          and exists (select 1 from public.hr_day_km h where h.employee_email = neo_v24t.email('fe2') and h.day = neo_v24t.d(-130) and h.final)
                          and (select count(*) from public.location_points where employee_email = neo_v24t.email('fe2')
                                and at >= neo_v24t.at(-130, '10:00') and at <= neo_v24t.at(-130, '11:30')) = 3
                          and not exists (select 1 from public.location_points where employee_email = neo_v24t.email('fe2') and at = neo_v24t.at(-130, '15:00'))
                          and not exists (select 1 from public.location_points where employee_email = neo_v24t.email('ta') and at < neo_v24t.at(-199, '00:00')),
                          'F32: the 51st trip waits — its day is final, its points stay; the points outside it and the final trip''s go');
  r := public._hr_purge(5000);
  select * into t from public.hr_trips where id = v_t2;
  perform neo_v24t.assert((r ->> 'trip_finals')::int = 1 and t.final and t.km = v_km2
                          and not exists (select 1 from public.location_points where employee_email = neo_v24t.email('fe2') and at < neo_v24t.at(-129, '00:00')),
                          'F32: the next call makes it final with its km, then its points go ' || r::text || ' ' || row_to_json(t)::text);
end $$;


-- ── Done ────────────────────────────────────────────────────────────────────
reset role;
select neo_v24t.no_jwt();
select 'neohr-hr v2.4 tests: all passed' as result;

rollback;
