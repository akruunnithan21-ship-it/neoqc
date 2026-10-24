-- =============================================================================
-- neohr-hr.tests.sql — tests for the neohr_hr_v2_3 migration (sql/neohr-hr.sql)
-- -----------------------------------------------------------------------------
-- Run AFTER sql/service-v2.sql, sql/service-v2.1.sql, sql/work-queue.sql,
-- sql/neohr-hr.sql and sql/neohr-hr-v2.4.sql (v2.4 is live: these v2.3 tests
-- run on top of it — its own tests are sql/neohr-hr-v2.4.tests.sql), as the
-- database owner (Supabase SQL editor or psql as
-- postgres). Everything happens inside one transaction that ends in ROLLBACK:
-- nothing is left behind, not even the helper schema.
--
-- Users are simulated the way PostgREST does it (SET ROLE + request.jwt.claims),
-- as in the other test files. Real profiles are used only for their rank (the
-- owner = tier 5, two tier 4s, a tier 3 head); everybody whose attendance is
-- exercised is a throw-away login (zq.hr.*@neotokyo.test) made here, so no
-- real punch, roster or request can change an answer. The shift, the settings
-- and the holidays near today are pinned inside the transaction.
--
-- Time: now() is the transaction's start and does not move. Days are India
-- days relative to today (neo_hrt.d(-3) = three days ago); punches on past
-- days are sent with their device time (the phone's offline queue), punches
-- "now" with age_ms (server-anchored). Where an answer depends on the time of
-- day (before / after 09:40 India time) the expectation is computed with the
-- same rule. tests/fixtures/hr-km.json and tests/fixtures/hr-day.json are
-- inlined below byte for byte (tests/sql-parity.test.js checks that) and run
-- through _hr_track_points / _hr_day_calc.
--
-- A failed assertion raises "FAIL: …" and aborts — the first error is the one
-- to read. Success ends with the row
--   result = 'neohr-hr tests: all passed'
-- just before the rollback.
-- =============================================================================

begin;

-- ── 0. Scaffolding (as the owner) ────────────────────────────────────────────
create schema neo_hrt;
grant usage on schema neo_hrt to anon, authenticated;

create table neo_hrt.users (alias text primary key, id uuid not null, email text not null, tier int not null, name text not null);
create table neo_hrt.ctx (k text primary key, v text);
create table neo_hrt.fx (name text primary key, body jsonb not null);
grant select on neo_hrt.users, neo_hrt.fx to anon, authenticated;
grant select, insert, update, delete on neo_hrt.ctx to anon, authenticated;
-- v2.4: no client reads attendance_events directly any more; the assertions made while
-- signed in read it through this view (it runs as the owner)
create view neo_hrt.ae as select * from public.attendance_events;
grant select on neo_hrt.ae to authenticated;

-- The shared fixtures, inlined byte for byte (tests/sql-parity.test.js).
insert into neo_hrt.fx (name, body) values ('hr-km', $fx${"version":1,"about":"HR-SPEC 9.5.4: distance fixtures shared by SQL (_hr_track_points), Kotlin (HrDistance) and JS. Comparisons: total_m within 0.001 m, km exactly, stop lat/lng within 1e-7.","cases":[{"name":"dt0_pair","note":"same at: keep the smaller accuracy, then the smaller id; input not in time order","runs":[[{"id":"a4","at":"2026-10-20T04:02:00Z","lat":10.0159,"lng":76.3437265,"accuracy_m":10},{"id":"a2","at":"2026-10-20T04:01:00Z","lat":10.0159,"lng":76.3428132,"accuracy_m":20},{"id":"a1","at":"2026-10-20T04:00:00Z","lat":10.0159,"lng":76.3419,"accuracy_m":10},{"id":"a3","at":"2026-10-20T04:01:00Z","lat":10.015927,"lng":76.3428498,"accuracy_m":8},{"id":"a6","at":"2026-10-20T04:03:00Z","lat":10.015918,"lng":76.3446945,"accuracy_m":10},{"id":"a5","at":"2026-10-20T04:03:00Z","lat":10.015882,"lng":76.3446397,"accuracy_m":10}]],"expect":{"total_m":300.108568,"km":0.3,"km_gaps":0,"kept":["a1","a3","a4","a5"],"stops":[]}},{"name":"bad_first_fix","note":"first fix far away: the three-reject re-anchor; nothing counted to the jump","runs":[[{"id":"b1","at":"2026-10-20T04:00:00Z","lat":10.0159,"lng":76.387562,"accuracy_m":20},{"id":"b2","at":"2026-10-20T04:00:30Z","lat":10.0159,"lng":76.3419,"accuracy_m":10},{"id":"b3","at":"2026-10-20T04:01:00Z","lat":10.0159,"lng":76.3422653,"accuracy_m":10},{"id":"b4","at":"2026-10-20T04:01:30Z","lat":10.0159,"lng":76.3426306,"accuracy_m":10},{"id":"b5","at":"2026-10-20T04:02:00Z","lat":10.015927,"lng":76.3429959,"accuracy_m":10},{"id":"b6","at":"2026-10-20T04:02:30Z","lat":10.015945,"lng":76.3433703,"accuracy_m":10}]],"expect":{"total_m":161.159793,"km":0.16,"km_gaps":0,"kept":["b1","b2","b3","b4","b5","b6"],"stops":[]}},{"name":"teleport_mid","note":"three consecutive far fixes mid-run: jump, nothing counted across it","runs":[[{"id":"c1","at":"2026-10-20T04:00:00Z","lat":10.0159,"lng":76.3419,"accuracy_m":10},{"id":"c2","at":"2026-10-20T04:00:30Z","lat":10.0159,"lng":76.342174,"accuracy_m":10},{"id":"c3","at":"2026-10-20T04:01:00Z","lat":10.015918,"lng":76.3424571,"accuracy_m":10},{"id":"c4","at":"2026-10-20T04:01:30Z","lat":10.015909,"lng":76.3427402,"accuracy_m":10},{"id":"c5","at":"2026-10-20T04:02:30Z","lat":10.0159,"lng":76.5253699,"accuracy_m":10},{"id":"c6","at":"2026-10-20T04:03:00Z","lat":10.015936,"lng":76.525653,"accuracy_m":10},{"id":"c7","at":"2026-10-20T04:03:30Z","lat":10.015918,"lng":76.5259361,"accuracy_m":10},{"id":"c8","at":"2026-10-20T04:04:00Z","lat":10.015909,"lng":76.5262192,"accuracy_m":10}]],"expect":{"total_m":185.419726,"km":0.19,"km_gaps":0,"kept":["c1","c2","c3","c4","c5","c6","c7","c8"],"stops":[]}},{"name":"stationary_jitter","note":"jitter inside a stop counts 0; the stop first fix counts; anchor stays at it","runs":[[{"id":"d00","at":"2026-10-20T03:58:00Z","lat":10.0159,"lng":76.3446397,"accuracy_m":12},{"id":"d01","at":"2026-10-20T04:00:00Z","lat":10.0159,"lng":76.3419,"accuracy_m":12},{"id":"d02","at":"2026-10-20T04:01:00Z","lat":10.015864,"lng":76.3419548,"accuracy_m":12},{"id":"d03","at":"2026-10-20T04:02:00Z","lat":10.015963,"lng":76.3418543,"accuracy_m":12},{"id":"d04","at":"2026-10-20T04:03:00Z","lat":10.015927,"lng":76.3419731,"accuracy_m":12},{"id":"d05","at":"2026-10-20T04:04:00Z","lat":10.0158281,"lng":76.3418726,"accuracy_m":12},{"id":"d06","at":"2026-10-20T04:05:00Z","lat":10.015954,"lng":76.3419365,"accuracy_m":12},{"id":"d07","at":"2026-10-20T04:06:00Z","lat":10.015882,"lng":76.3418361,"accuracy_m":12},{"id":"d08","at":"2026-10-20T04:07:00Z","lat":10.0159809,"lng":76.3419183,"accuracy_m":12},{"id":"d09","at":"2026-10-20T04:08:00Z","lat":10.015846,"lng":76.3419822,"accuracy_m":12},{"id":"d10","at":"2026-10-20T04:09:00Z","lat":10.015936,"lng":76.3418452,"accuracy_m":12},{"id":"d11","at":"2026-10-20T04:10:00Z","lat":10.015873,"lng":76.3419457,"accuracy_m":12},{"id":"d12","at":"2026-10-20T04:11:00Z","lat":10.015945,"lng":76.3418817,"accuracy_m":12},{"id":"d13","at":"2026-10-20T04:12:00Z","lat":10.0161698,"lng":76.3456443,"accuracy_m":12}]],"expect":{"total_m":711.096639,"km":0.71,"km_gaps":0,"kept":["d00","d01","d02","d03","d04","d05","d06","d07","d08","d09","d10","d11","d12","d13"],"stops":[{"arrived":"2026-10-20T04:00:00Z","left":"2026-10-20T04:11:00Z","lat":10.01590825,"lng":76.341908375}]}},{"name":"slow_walk","note":"steps under 15 m are skipped and the anchor stays; 270 s within 75 m is not a stop","runs":[[{"id":"e01","at":"2026-10-20T04:00:00Z","lat":10.0159,"lng":76.3419,"accuracy_m":5},{"id":"e02","at":"2026-10-20T04:00:30Z","lat":10.0159,"lng":76.3419548,"accuracy_m":5},{"id":"e03","at":"2026-10-20T04:01:00Z","lat":10.0159,"lng":76.3420096,"accuracy_m":5},{"id":"e04","at":"2026-10-20T04:01:30Z","lat":10.0159,"lng":76.3420662,"accuracy_m":5},{"id":"e05","at":"2026-10-20T04:02:00Z","lat":10.0159,"lng":76.342121,"accuracy_m":5},{"id":"e06","at":"2026-10-20T04:02:30Z","lat":10.0159,"lng":76.3421758,"accuracy_m":5},{"id":"e07","at":"2026-10-20T04:03:00Z","lat":10.0159,"lng":76.3422333,"accuracy_m":5},{"id":"e08","at":"2026-10-20T04:03:30Z","lat":10.0159,"lng":76.3422881,"accuracy_m":5},{"id":"e09","at":"2026-10-20T04:04:00Z","lat":10.0159,"lng":76.3423429,"accuracy_m":5},{"id":"e10","at":"2026-10-20T04:04:30Z","lat":10.0159,"lng":76.3424014,"accuracy_m":5}]],"expect":{"total_m":54.903508,"km":0.06,"km_gaps":0,"kept":["e01","e02","e03","e04","e05","e06","e07","e08","e09","e10"],"stops":[]}},{"name":"accuracy_threshold","note":"acc 40 + 40: a step must reach 40 m; a zig-zag of 30 m steps is measured corner to corner","runs":[[{"id":"f1","at":"2026-10-20T04:00:00Z","lat":10.0159,"lng":76.3419,"accuracy_m":40},{"id":"f2","at":"2026-10-20T04:00:30Z","lat":10.0160979,"lng":76.3420826,"accuracy_m":40},{"id":"f3","at":"2026-10-20T04:01:00Z","lat":10.0159,"lng":76.342311,"accuracy_m":40},{"id":"f4","at":"2026-10-20T04:01:30Z","lat":10.0160979,"lng":76.3424936,"accuracy_m":40},{"id":"f5","at":"2026-10-20T04:02:00Z","lat":10.0159,"lng":76.3427219,"accuracy_m":40}]],"expect":{"total_m":89.998391,"km":0.09,"km_gaps":0,"kept":["f1","f2","f3","f4","f5"],"stops":[]}},{"name":"break_two_runs","note":"two runs (a break between): each measured alone, summed","runs":[[{"id":"g1","at":"2026-10-20T04:00:00Z","lat":10.0159,"lng":76.3419,"accuracy_m":10},{"id":"g2","at":"2026-10-20T04:00:30Z","lat":10.0159,"lng":76.3423566,"accuracy_m":10},{"id":"g3","at":"2026-10-20T04:01:00Z","lat":10.0159,"lng":76.3428224,"accuracy_m":10},{"id":"g4","at":"2026-10-20T04:01:30Z","lat":10.0159,"lng":76.3432881,"accuracy_m":10}],[{"id":"g5","at":"2026-10-20T05:00:00Z","lat":10.0159,"lng":76.3615529,"accuracy_m":10},{"id":"g6","at":"2026-10-20T05:00:30Z","lat":10.0159,"lng":76.3620095,"accuracy_m":10},{"id":"g7","at":"2026-10-20T05:01:00Z","lat":10.0159,"lng":76.3624753,"accuracy_m":10},{"id":"g8","at":"2026-10-20T05:01:30Z","lat":10.0159,"lng":76.362941,"accuracy_m":10}]],"expect":{"total_m":303.995051,"km":0.3,"km_gaps":0,"kept":["g1","g2","g3","g4","g5","g6","g7","g8"],"stops":[]}},{"name":"tunnel_gap","note":"dt > 600 s and d > 1000 m: counted, km_gaps + 1; dt > 600 s with d < 1000 m: an ordinary step","runs":[[{"id":"h1","at":"2026-10-20T04:00:00Z","lat":10.0159,"lng":76.3419,"accuracy_m":10},{"id":"h2","at":"2026-10-20T04:00:30Z","lat":10.0159,"lng":76.3428132,"accuracy_m":10},{"id":"h3","at":"2026-10-20T04:12:10Z","lat":10.0159,"lng":76.361078,"accuracy_m":10},{"id":"h4","at":"2026-10-20T04:12:40Z","lat":10.0159,"lng":76.3620004,"accuracy_m":10},{"id":"h5","at":"2026-10-20T04:23:30Z","lat":10.0159,"lng":76.3665757,"accuracy_m":10}]],"expect":{"total_m":2701.999379,"km":2.7,"km_gaps":1,"kept":["h1","h2","h3","h4","h5"],"stops":[]}},{"name":"null_accuracy","note":"accuracy null = 50: kept, and it raises the threshold to (50 + 10) / 2 = 30","runs":[[{"id":"i1","at":"2026-10-20T04:00:00Z","lat":10.0159,"lng":76.3419,"accuracy_m":null},{"id":"i2","at":"2026-10-20T04:00:30Z","lat":10.0159,"lng":76.3421283,"accuracy_m":10},{"id":"i3","at":"2026-10-20T04:01:00Z","lat":10.0159,"lng":76.342311,"accuracy_m":10},{"id":"i4","at":"2026-10-20T04:01:30Z","lat":10.0160979,"lng":76.342311,"accuracy_m":null}]],"expect":{"total_m":45.00467,"km":0.05,"km_gaps":0,"kept":["i1","i2","i3","i4"],"stops":[]}},{"name":"all_bad_accuracy","note":"every fix > 50 m: nothing kept, 0 km","runs":[[{"id":"k1","at":"2026-10-20T04:00:00Z","lat":10.0159,"lng":76.3419,"accuracy_m":60},{"id":"k2","at":"2026-10-20T04:00:30Z","lat":10.0159,"lng":76.3437265,"accuracy_m":51},{"id":"k3","at":"2026-10-20T04:01:00Z","lat":10.0159,"lng":76.345553,"accuracy_m":120},{"id":"k4","at":"2026-10-20T04:01:30Z","lat":10.0159,"lng":76.3473794,"accuracy_m":80}]],"expect":{"total_m":0,"km":0,"km_gaps":0,"kept":[],"stops":[]}},{"name":"drive","note":"a drive at ~12 m/s with a dropped bad-accuracy fix and a single glitch, ending in a 7-minute stop","runs":[[{"id":"m01","at":"2026-10-20T04:00:00Z","lat":10.015936,"lng":76.3419,"accuracy_m":8},{"id":"m02","at":"2026-10-20T04:00:20Z","lat":10.015873,"lng":76.3441009,"accuracy_m":8},{"id":"m03","at":"2026-10-20T04:00:40Z","lat":10.015873,"lng":76.3463292,"accuracy_m":8},{"id":"m04","at":"2026-10-20T04:01:00Z","lat":10.015936,"lng":76.3485849,"accuracy_m":8},{"id":"m05","at":"2026-10-20T04:01:20Z","lat":10.015873,"lng":76.350868,"accuracy_m":8},{"id":"m06","at":"2026-10-20T04:01:40Z","lat":10.015873,"lng":76.3530689,"accuracy_m":8},{"id":"m90","at":"2026-10-20T04:01:55Z","lat":10.0239939,"lng":76.3550507,"accuracy_m":80},{"id":"m07","at":"2026-10-20T04:02:00Z","lat":10.015936,"lng":76.3552972,"accuracy_m":8},{"id":"m08","at":"2026-10-20T04:02:20Z","lat":10.015873,"lng":76.3575529,"accuracy_m":8},{"id":"m09","at":"2026-10-20T04:02:40Z","lat":10.015873,"lng":76.359836,"accuracy_m":8},{"id":"m10","at":"2026-10-20T04:03:00Z","lat":10.015936,"lng":76.3620369,"accuracy_m":8},{"id":"m91","at":"2026-10-20T04:03:15Z","lat":9.9925176,"lng":76.3857355,"accuracy_m":8},{"id":"m11","at":"2026-10-20T04:03:20Z","lat":10.015873,"lng":76.3642652,"accuracy_m":8},{"id":"m12","at":"2026-10-20T04:03:40Z","lat":10.015873,"lng":76.3665209,"accuracy_m":8},{"id":"m13","at":"2026-10-20T04:04:00Z","lat":10.015936,"lng":76.368804,"accuracy_m":8},{"id":"m14","at":"2026-10-20T04:04:20Z","lat":10.015873,"lng":76.371005,"accuracy_m":8},{"id":"m15","at":"2026-10-20T04:04:40Z","lat":10.015873,"lng":76.3732333,"accuracy_m":8},{"id":"m16","at":"2026-10-20T04:05:00Z","lat":10.015936,"lng":76.375489,"accuracy_m":8},{"id":"m17","at":"2026-10-20T04:05:20Z","lat":10.015873,"lng":76.3777721,"accuracy_m":8},{"id":"m18","at":"2026-10-20T04:05:40Z","lat":10.015873,"lng":76.379973,"accuracy_m":8},{"id":"m19","at":"2026-10-20T04:06:00Z","lat":10.0159,"lng":76.3821647,"accuracy_m":10},{"id":"m20","at":"2026-10-20T04:07:00Z","lat":10.015927,"lng":76.3822469,"accuracy_m":10},{"id":"m21","at":"2026-10-20T04:08:00Z","lat":10.015954,"lng":76.3821647,"accuracy_m":10},{"id":"m22","at":"2026-10-20T04:09:00Z","lat":10.0159,"lng":76.3822469,"accuracy_m":10},{"id":"m23","at":"2026-10-20T04:10:00Z","lat":10.015927,"lng":76.3821647,"accuracy_m":10},{"id":"m24","at":"2026-10-20T04:11:00Z","lat":10.015954,"lng":76.3822469,"accuracy_m":10},{"id":"m25","at":"2026-10-20T04:12:00Z","lat":10.0159,"lng":76.3821647,"accuracy_m":10},{"id":"m26","at":"2026-10-20T04:13:00Z","lat":10.015927,"lng":76.3822469,"accuracy_m":10}]],"expect":{"total_m":4410.119016,"km":4.41,"km_gaps":0,"kept":["m01","m02","m03","m04","m05","m06","m07","m08","m09","m10","m11","m12","m13","m14","m15","m16","m17","m18","m19","m20","m21","m22","m23","m24","m25","m26"],"stops":[{"arrived":"2026-10-20T04:06:00Z","left":"2026-10-20T04:13:00Z","lat":10.015923625,"lng":76.3822058}]}},{"name":"two_stops","note":"two stops 300 m apart; a 290 s cluster is not a stop","runs":[[{"id":"n01","at":"2026-10-20T04:00:00Z","lat":10.0159,"lng":76.3419,"accuracy_m":10},{"id":"n02","at":"2026-10-20T04:02:00Z","lat":10.015927,"lng":76.3419457,"accuracy_m":10},{"id":"n03","at":"2026-10-20T04:04:00Z","lat":10.015954,"lng":76.3418635,"accuracy_m":10},{"id":"n04","at":"2026-10-20T04:06:00Z","lat":10.015855,"lng":76.3419274,"accuracy_m":10},{"id":"n05","at":"2026-10-20T04:07:00Z","lat":10.0159,"lng":76.344658,"accuracy_m":10},{"id":"n06","at":"2026-10-20T04:09:00Z","lat":10.015936,"lng":76.3446945,"accuracy_m":10},{"id":"n07","at":"2026-10-20T04:11:00Z","lat":10.015846,"lng":76.3446306,"accuracy_m":10},{"id":"n08","at":"2026-10-20T04:13:00Z","lat":10.015918,"lng":76.3446762,"accuracy_m":10},{"id":"n09","at":"2026-10-20T04:14:00Z","lat":10.0159,"lng":76.3482927,"accuracy_m":10},{"id":"n10","at":"2026-10-20T04:15:30Z","lat":10.015927,"lng":76.3483475,"accuracy_m":10},{"id":"n11","at":"2026-10-20T04:17:00Z","lat":10.015864,"lng":76.3483109,"accuracy_m":10},{"id":"n12","at":"2026-10-20T04:18:50Z","lat":10.015909,"lng":76.3483657,"accuracy_m":10},{"id":"n13","at":"2026-10-20T04:19:20Z","lat":10.0159,"lng":76.3510324,"accuracy_m":10}]],"expect":{"total_m":1000.001586,"km":1,"km_gaps":0,"kept":["n01","n02","n03","n04","n05","n06","n07","n08","n09","n10","n11","n12","n13"],"stops":[{"arrived":"2026-10-20T04:00:00Z","left":"2026-10-20T04:06:00Z","lat":10.015909,"lng":76.34190915},{"arrived":"2026-10-20T04:07:00Z","left":"2026-10-20T04:13:00Z","lat":10.0159,"lng":76.344664825}]}},{"name":"double_glitch","note":"two far fixes in a row are dropped (only a third reject re-anchors)","runs":[[{"id":"q1","at":"2026-10-20T04:00:00Z","lat":10.0159,"lng":76.3419,"accuracy_m":10},{"id":"q2","at":"2026-10-20T04:00:30Z","lat":10.0159,"lng":76.342174,"accuracy_m":10},{"id":"q3","at":"2026-10-20T04:01:00Z","lat":10.0159,"lng":76.3424571,"accuracy_m":10},{"id":"q4","at":"2026-10-20T04:01:30Z","lat":10.015918,"lng":76.3427402,"accuracy_m":10},{"id":"q5","at":"2026-10-20T04:02:00Z","lat":10.0293898,"lng":76.3701374,"accuracy_m":10},{"id":"q6","at":"2026-10-20T04:02:30Z","lat":10.0295697,"lng":76.3703018,"accuracy_m":10},{"id":"q7","at":"2026-10-20T04:03:00Z","lat":10.015927,"lng":76.3432881,"accuracy_m":10},{"id":"q8","at":"2026-10-20T04:03:30Z","lat":10.015909,"lng":76.3435712,"accuracy_m":10},{"id":"q9","at":"2026-10-20T04:04:00Z","lat":10.015936,"lng":76.3438543,"accuracy_m":10}]],"expect":{"total_m":214.279136,"km":0.21,"km_gaps":0,"kept":["q1","q2","q3","q4","q7","q8","q9"],"stops":[]}},{"name":"stop_wander","note":"only the stop first fix counts; the stop radius is 75 m (85 m is outside)","runs":[[{"id":"w1","at":"2026-10-20T04:00:00Z","lat":10.0159,"lng":76.3419,"accuracy_m":10},{"id":"w2","at":"2026-10-20T04:01:00Z","lat":10.0159,"lng":76.3420826,"accuracy_m":10},{"id":"w3","at":"2026-10-20T04:02:00Z","lat":10.0160619,"lng":76.341763,"accuracy_m":10},{"id":"w4","at":"2026-10-20T04:03:00Z","lat":10.0161248,"lng":76.3421283,"accuracy_m":10},{"id":"w5","at":"2026-10-20T04:04:00Z","lat":10.0157201,"lng":76.3419,"accuracy_m":10},{"id":"w6","at":"2026-10-20T04:05:00Z","lat":10.0161698,"lng":76.3419913,"accuracy_m":10},{"id":"w7","at":"2026-10-20T04:06:00Z","lat":10.015945,"lng":76.3417174,"accuracy_m":10},{"id":"w8","at":"2026-10-20T04:06:30Z","lat":10.0159,"lng":76.3426763,"accuracy_m":10}]],"expect":{"total_m":85.005172,"km":0.09,"km_gaps":0,"kept":["w1","w2","w3","w4","w5","w6","w7","w8"],"stops":[{"arrived":"2026-10-20T04:00:00Z","left":"2026-10-20T04:06:00Z","lat":10.015974514,"lng":76.341926086}]}}]}$fx$::jsonb);
insert into neo_hrt.fx (name, body) values ('hr-day', $fx${"version":1,"about":"Day records of public._hr_day_calc (HR-SPEC 9.4.1 / 9.6.5). India time; minutes are whole minutes, rounded down.","cases":[{"name":"present","input":{"day":"2026-10-20","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"shop","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":false,"events":[{"id":"e001","kind":"punch_in","at":"2026-10-20T04:05:00Z"},{"id":"e002","kind":"break_start","at":"2026-10-20T07:30:00Z"},{"id":"e003","kind":"break_end","at":"2026-10-20T08:15:00Z"},{"id":"e004","kind":"punch_out","at":"2026-10-20T13:10:00Z"}],"points_at":[],"km":0,"km_gaps":0},"expect":{"status":"present","flex":false,"first_in":"2026-10-20T04:05:00Z","last_out":"2026-10-20T13:10:00Z","worked_min":500,"break_min":45,"late_min":0,"early_min":0,"missed_out":false,"irregular":false,"worked_on_duty":null,"half_day_leave":false,"open":false,"leave_units":0,"absent_units":0}},{"name":"late","input":{"day":"2026-10-20","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"shop","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":false,"events":[{"id":"e005","kind":"punch_in","at":"2026-10-20T04:22:00Z"},{"id":"e006","kind":"punch_out","at":"2026-10-20T13:01:00Z"}],"points_at":[],"km":0,"km_gaps":0},"expect":{"status":"late","flex":false,"first_in":"2026-10-20T04:22:00Z","last_out":"2026-10-20T13:01:00Z","worked_min":519,"break_min":0,"late_min":12,"early_min":0,"missed_out":false,"irregular":false,"worked_on_duty":null,"half_day_leave":false,"open":false,"leave_units":0,"absent_units":0}},{"name":"late_with_flex_request","input":{"day":"2026-10-20","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"shop","holiday":null,"attendance_required":true,"flex_request":true,"half_day_leave":false,"events":[{"id":"e007","kind":"punch_in","at":"2026-10-20T05:00:00Z"},{"id":"e008","kind":"punch_out","at":"2026-10-20T13:30:00Z"}],"points_at":[],"km":0,"km_gaps":0},"expect":{"status":"present","flex":true,"first_in":"2026-10-20T05:00:00Z","last_out":"2026-10-20T13:30:00Z","worked_min":510,"break_min":0,"late_min":0,"early_min":0,"missed_out":false,"irregular":false,"worked_on_duty":null,"half_day_leave":false,"open":false,"leave_units":0,"absent_units":0}},{"name":"field_duty","input":{"day":"2026-10-20","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"field","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":false,"events":[{"id":"e009","kind":"punch_in","at":"2026-10-20T05:30:00Z"},{"id":"e010","kind":"punch_out","at":"2026-10-20T11:30:00Z"}],"points_at":[],"km":0,"km_gaps":0},"expect":{"status":"present","flex":true,"first_in":"2026-10-20T05:30:00Z","last_out":"2026-10-20T11:30:00Z","worked_min":360,"break_min":0,"late_min":0,"early_min":0,"missed_out":false,"irregular":false,"worked_on_duty":null,"half_day_leave":false,"open":false,"leave_units":0,"absent_units":0}},{"name":"half_day","input":{"day":"2026-10-20","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"shop","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":false,"events":[{"id":"e011","kind":"punch_in","at":"2026-10-20T04:00:00Z"},{"id":"e012","kind":"punch_out","at":"2026-10-20T07:00:00Z"}],"points_at":[],"km":0,"km_gaps":0},"expect":{"status":"half_day","flex":false,"first_in":"2026-10-20T04:00:00Z","last_out":"2026-10-20T07:00:00Z","worked_min":180,"break_min":0,"late_min":0,"early_min":360,"missed_out":false,"irregular":false,"worked_on_duty":null,"half_day_leave":false,"open":false,"leave_units":0,"absent_units":0}},{"name":"absent","input":{"day":"2026-10-20","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"shop","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":false,"events":[],"points_at":[],"km":0,"km_gaps":0},"expect":{"status":"absent","flex":false,"first_in":null,"last_out":null,"worked_min":0,"break_min":0,"late_min":0,"early_min":0,"missed_out":false,"irregular":false,"worked_on_duty":null,"half_day_leave":false,"open":false,"leave_units":0,"absent_units":1}},{"name":"leave","input":{"day":"2026-10-20","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"leave","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":false,"events":[],"points_at":[],"km":0,"km_gaps":0},"expect":{"status":"leave","flex":false,"first_in":null,"last_out":null,"worked_min":0,"break_min":0,"late_min":0,"early_min":0,"missed_out":false,"irregular":false,"worked_on_duty":null,"half_day_leave":false,"open":false,"leave_units":1,"absent_units":0}},{"name":"half_day_leave_not_punched","input":{"day":"2026-10-20","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"shop","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":true,"events":[],"points_at":[],"km":0,"km_gaps":0},"expect":{"status":"leave","flex":true,"first_in":null,"last_out":null,"worked_min":0,"break_min":0,"late_min":0,"early_min":0,"missed_out":false,"irregular":false,"worked_on_duty":null,"half_day_leave":true,"open":false,"leave_units":0.5,"absent_units":0.5}},{"name":"half_day_leave_punched","input":{"day":"2026-10-20","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"shop","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":true,"events":[{"id":"e013","kind":"punch_in","at":"2026-10-20T08:00:00Z"},{"id":"e014","kind":"punch_out","at":"2026-10-20T13:00:00Z"}],"points_at":[],"km":0,"km_gaps":0},"expect":{"status":"half_day","flex":true,"first_in":"2026-10-20T08:00:00Z","last_out":"2026-10-20T13:00:00Z","worked_min":300,"break_min":0,"late_min":0,"early_min":0,"missed_out":false,"irregular":false,"worked_on_duty":null,"half_day_leave":true,"open":false,"leave_units":0.5,"absent_units":0}},{"name":"off","input":{"day":"2026-10-20","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"off","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":false,"events":[],"points_at":[],"km":0,"km_gaps":0},"expect":{"status":"off","flex":false,"first_in":null,"last_out":null,"worked_min":0,"break_min":0,"late_min":0,"early_min":0,"missed_out":false,"irregular":false,"worked_on_duty":null,"half_day_leave":false,"open":false,"leave_units":0,"absent_units":0}},{"name":"holiday","input":{"day":"2026-10-20","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"off","holiday":"Diwali","attendance_required":true,"flex_request":false,"half_day_leave":false,"events":[],"points_at":[],"km":0,"km_gaps":0},"expect":{"status":"off","flex":false,"first_in":null,"last_out":null,"worked_min":0,"break_min":0,"late_min":0,"early_min":0,"missed_out":false,"irregular":false,"worked_on_duty":null,"half_day_leave":false,"open":false,"leave_units":0,"absent_units":0}},{"name":"worked_on_off_day","input":{"day":"2026-10-20","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"off","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":false,"events":[{"id":"e015","kind":"punch_in","at":"2026-10-20T04:30:00Z"},{"id":"e016","kind":"punch_out","at":"2026-10-20T09:30:00Z"}],"points_at":[],"km":0,"km_gaps":0},"expect":{"status":"present","flex":false,"first_in":"2026-10-20T04:30:00Z","last_out":"2026-10-20T09:30:00Z","worked_min":300,"break_min":0,"late_min":0,"early_min":0,"missed_out":false,"irregular":false,"worked_on_duty":"off","half_day_leave":false,"open":false,"leave_units":0,"absent_units":0}},{"name":"open_today","input":{"day":"2026-10-22","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"shop","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":false,"events":[{"id":"e017","kind":"punch_in","at":"2026-10-22T03:50:00Z"}],"points_at":[],"km":0,"km_gaps":0},"expect":{"status":"open","flex":false,"first_in":"2026-10-22T03:50:00Z","last_out":null,"worked_min":160,"break_min":0,"late_min":0,"early_min":0,"missed_out":false,"irregular":false,"worked_on_duty":null,"half_day_leave":false,"open":true,"leave_units":0,"absent_units":0}},{"name":"open_on_break","input":{"day":"2026-10-22","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"shop","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":false,"events":[{"id":"e018","kind":"punch_in","at":"2026-10-22T03:30:00Z"},{"id":"e019","kind":"break_start","at":"2026-10-22T06:00:00Z"}],"points_at":[],"km":0,"km_gaps":0},"expect":{"status":"open","flex":false,"first_in":"2026-10-22T03:30:00Z","last_out":null,"worked_min":150,"break_min":30,"late_min":0,"early_min":0,"missed_out":false,"irregular":false,"worked_on_duty":null,"half_day_leave":false,"open":true,"leave_units":0,"absent_units":0}},{"name":"missed_out","input":{"day":"2026-10-20","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"shop","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":false,"events":[{"id":"e020","kind":"punch_in","at":"2026-10-20T04:00:00Z"},{"id":"e021","kind":"break_start","at":"2026-10-20T07:30:00Z"},{"id":"e022","kind":"break_end","at":"2026-10-20T08:00:00Z"}],"points_at":["2026-10-20T09:30:00Z","2026-10-20T11:40:00Z","2026-10-20T21:30:00Z"],"km":0,"km_gaps":0},"expect":{"status":"present","flex":false,"first_in":"2026-10-20T04:00:00Z","last_out":null,"worked_min":430,"break_min":30,"late_min":0,"early_min":0,"missed_out":true,"irregular":false,"worked_on_duty":null,"half_day_leave":false,"open":false,"leave_units":0,"absent_units":0}},{"name":"missed_out_open_break","input":{"day":"2026-10-20","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"shop","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":false,"events":[{"id":"e023","kind":"punch_in","at":"2026-10-20T04:00:00Z"},{"id":"e024","kind":"break_start","at":"2026-10-20T08:30:00Z"}],"points_at":["2026-10-20T11:30:00Z"],"km":0,"km_gaps":0},"expect":{"status":"present","flex":false,"first_in":"2026-10-20T04:00:00Z","last_out":null,"worked_min":270,"break_min":0,"late_min":0,"early_min":0,"missed_out":true,"irregular":false,"worked_on_duty":null,"half_day_leave":false,"open":false,"leave_units":0,"absent_units":0}},{"name":"past_midnight","input":{"day":"2026-10-20","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"shop","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":false,"events":[{"id":"e025","kind":"punch_in","at":"2026-10-20T14:30:00Z"},{"id":"e026","kind":"punch_out","at":"2026-10-20T20:30:00Z"}],"points_at":[],"km":0,"km_gaps":0},"expect":{"status":"late","flex":false,"first_in":"2026-10-20T14:30:00Z","last_out":"2026-10-20T20:30:00Z","worked_min":360,"break_min":0,"late_min":620,"early_min":0,"missed_out":false,"irregular":false,"worked_on_duty":null,"half_day_leave":false,"open":false,"leave_units":0,"absent_units":0}},{"name":"past_midnight_next_day","input":{"day":"2026-10-21","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"shop","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":false,"events":[{"id":"e025","kind":"punch_in","at":"2026-10-20T14:30:00Z"},{"id":"e026","kind":"punch_out","at":"2026-10-20T20:30:00Z"}],"points_at":[],"km":0,"km_gaps":0},"expect":{"status":"absent","flex":false,"first_in":null,"last_out":null,"worked_min":0,"break_min":0,"late_min":0,"early_min":0,"missed_out":false,"irregular":false,"worked_on_duty":null,"half_day_leave":false,"open":false,"leave_units":0,"absent_units":1}},{"name":"irregular","input":{"day":"2026-10-20","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"shop","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":false,"events":[{"id":"e027","kind":"punch_in","at":"2026-10-20T04:00:00Z"},{"id":"e028","kind":"punch_in","at":"2026-10-20T04:30:00Z"},{"id":"e029","kind":"punch_out","at":"2026-10-20T13:00:00Z"}],"points_at":[],"km":0,"km_gaps":0},"expect":{"status":"present","flex":false,"first_in":"2026-10-20T04:00:00Z","last_out":"2026-10-20T13:00:00Z","worked_min":540,"break_min":0,"late_min":0,"early_min":0,"missed_out":false,"irregular":true,"worked_on_duty":null,"half_day_leave":false,"open":false,"leave_units":0,"absent_units":0}},{"name":"not_in_yet_before_grace","input":{"day":"2026-10-22","now":"2026-10-22T04:05:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"shop","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":false,"events":[],"points_at":[],"km":0,"km_gaps":0},"expect":{"status":"not_in_yet","flex":false,"first_in":null,"last_out":null,"worked_min":0,"break_min":0,"late_min":0,"early_min":0,"missed_out":false,"irregular":false,"worked_on_duty":null,"half_day_leave":false,"open":false,"leave_units":0,"absent_units":0}},{"name":"absent_after_grace","input":{"day":"2026-10-22","now":"2026-10-22T04:15:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"shop","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":false,"events":[],"points_at":[],"km":0,"km_gaps":0},"expect":{"status":"absent","flex":false,"first_in":null,"last_out":null,"worked_min":0,"break_min":0,"late_min":0,"early_min":0,"missed_out":false,"irregular":false,"worked_on_duty":null,"half_day_leave":false,"open":false,"leave_units":0,"absent_units":1}},{"name":"not_in_yet_field_until_shift_end","input":{"day":"2026-10-22","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"field","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":false,"events":[],"points_at":[],"km":0,"km_gaps":0},"expect":{"status":"not_in_yet","flex":true,"first_in":null,"last_out":null,"worked_min":0,"break_min":0,"late_min":0,"early_min":0,"missed_out":false,"irregular":false,"worked_on_duty":null,"half_day_leave":false,"open":false,"leave_units":0,"absent_units":0}},{"name":"not_tracked","input":{"day":"2026-10-20","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"shop","holiday":null,"attendance_required":false,"flex_request":false,"half_day_leave":false,"events":[],"points_at":[],"km":0,"km_gaps":0},"expect":{"status":"not_tracked","flex":false,"first_in":null,"last_out":null,"worked_min":0,"break_min":0,"late_min":0,"early_min":0,"missed_out":false,"irregular":false,"worked_on_duty":null,"half_day_leave":false,"open":false,"leave_units":0,"absent_units":0}},{"name":"not_tracked_punched_late","input":{"day":"2026-10-20","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"shop","holiday":null,"attendance_required":false,"flex_request":false,"half_day_leave":false,"events":[{"id":"e030","kind":"punch_in","at":"2026-10-20T05:30:00Z"},{"id":"e031","kind":"punch_out","at":"2026-10-20T13:00:00Z"}],"points_at":[],"km":0,"km_gaps":0},"expect":{"status":"present","flex":false,"first_in":"2026-10-20T05:30:00Z","last_out":"2026-10-20T13:00:00Z","worked_min":450,"break_min":0,"late_min":0,"early_min":0,"missed_out":false,"irregular":false,"worked_on_duty":null,"half_day_leave":false,"open":false,"leave_units":0,"absent_units":0}},{"name":"two_sessions","input":{"day":"2026-10-20","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"shop","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":false,"events":[{"id":"e032","kind":"punch_in","at":"2026-10-20T04:00:00Z"},{"id":"e033","kind":"punch_out","at":"2026-10-20T06:30:00Z"},{"id":"e034","kind":"punch_in","at":"2026-10-20T07:30:00Z"},{"id":"e035","kind":"punch_out","at":"2026-10-20T13:00:00Z"}],"points_at":[],"km":0,"km_gaps":0},"expect":{"status":"present","flex":false,"first_in":"2026-10-20T04:00:00Z","last_out":"2026-10-20T13:00:00Z","worked_min":480,"break_min":0,"late_min":0,"early_min":0,"missed_out":false,"irregular":false,"worked_on_duty":null,"half_day_leave":false,"open":false,"leave_units":0,"absent_units":0}},{"name":"early_leave_mark","input":{"day":"2026-10-20","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"shop","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":false,"events":[{"id":"e036","kind":"punch_in","at":"2026-10-20T04:00:00Z"},{"id":"e037","kind":"punch_out","at":"2026-10-20T11:30:00Z"}],"points_at":[],"km":0,"km_gaps":0},"expect":{"status":"present","flex":false,"first_in":"2026-10-20T04:00:00Z","last_out":"2026-10-20T11:30:00Z","worked_min":450,"break_min":0,"late_min":0,"early_min":90,"missed_out":false,"irregular":false,"worked_on_duty":null,"half_day_leave":false,"open":false,"leave_units":0,"absent_units":0}},{"name":"capped_session","input":{"day":"2026-10-20","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"shop","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":false,"events":[{"id":"e038","kind":"punch_in","at":"2026-10-20T02:30:00Z"},{"id":"e039","kind":"punch_in","at":"2026-10-21T04:00:00Z"},{"id":"e040","kind":"punch_out","at":"2026-10-21T13:00:00Z"}],"points_at":[],"km":0,"km_gaps":0},"expect":{"status":"half_day","flex":false,"first_in":"2026-10-20T02:30:00Z","last_out":null,"worked_min":0,"break_min":0,"late_min":0,"early_min":0,"missed_out":true,"irregular":false,"worked_on_duty":null,"half_day_leave":false,"open":false,"leave_units":0,"absent_units":0}},{"name":"after_the_cap_next_day","input":{"day":"2026-10-21","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"shop","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":false,"events":[{"id":"e038","kind":"punch_in","at":"2026-10-20T02:30:00Z"},{"id":"e039","kind":"punch_in","at":"2026-10-21T04:00:00Z"},{"id":"e040","kind":"punch_out","at":"2026-10-21T13:00:00Z"}],"points_at":[],"km":0,"km_gaps":0},"expect":{"status":"present","flex":false,"first_in":"2026-10-21T04:00:00Z","last_out":"2026-10-21T13:00:00Z","worked_min":540,"break_min":0,"late_min":0,"early_min":0,"missed_out":false,"irregular":false,"worked_on_duty":null,"half_day_leave":false,"open":false,"leave_units":0,"absent_units":0}},{"name":"punch_out_on_break","input":{"day":"2026-10-20","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"shop","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":false,"events":[{"id":"e041","kind":"punch_in","at":"2026-10-20T04:00:00Z"},{"id":"e042","kind":"break_start","at":"2026-10-20T12:00:00Z"},{"id":"e043","kind":"punch_out","at":"2026-10-20T13:00:00Z"}],"points_at":[],"km":0,"km_gaps":0},"expect":{"status":"present","flex":false,"first_in":"2026-10-20T04:00:00Z","last_out":"2026-10-20T13:00:00Z","worked_min":480,"break_min":60,"late_min":0,"early_min":0,"missed_out":false,"irregular":false,"worked_on_duty":null,"half_day_leave":false,"open":false,"leave_units":0,"absent_units":0}},{"name":"tie_break_received_at","input":{"day":"2026-10-20","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"shop","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":false,"events":[{"id":"z1","kind":"punch_in","at":"2026-10-20T04:00:00Z","rcv":"2026-10-20T04:10:00Z"},{"id":"z9","kind":"break_start","at":"2026-10-20T04:00:00Z","rcv":"2026-10-20T04:09:00Z"},{"id":"e044","kind":"punch_out","at":"2026-10-20T13:00:00Z"}],"points_at":[],"km":0,"km_gaps":0},"expect":{"status":"present","flex":false,"first_in":"2026-10-20T04:00:00Z","last_out":"2026-10-20T13:00:00Z","worked_min":540,"break_min":0,"late_min":0,"early_min":0,"missed_out":false,"irregular":true,"worked_on_duty":null,"half_day_leave":false,"open":false,"leave_units":0,"absent_units":0}},{"name":"tie_break_id","input":{"day":"2026-10-20","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"shop","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":false,"events":[{"id":"y2","kind":"punch_in","at":"2026-10-20T04:00:00Z","rcv":"2026-10-20T04:10:00Z"},{"id":"y1","kind":"break_start","at":"2026-10-20T04:00:00Z","rcv":"2026-10-20T04:10:00Z"},{"id":"e045","kind":"punch_out","at":"2026-10-20T13:00:00Z"}],"points_at":[],"km":0,"km_gaps":0},"expect":{"status":"present","flex":false,"first_in":"2026-10-20T04:00:00Z","last_out":"2026-10-20T13:00:00Z","worked_min":540,"break_min":0,"late_min":0,"early_min":0,"missed_out":false,"irregular":true,"worked_on_duty":null,"half_day_leave":false,"open":false,"leave_units":0,"absent_units":0}},{"name":"early_morning_start","input":{"day":"2026-10-21","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"shop","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":false,"events":[{"id":"e046","kind":"punch_in","at":"2026-10-20T20:00:00Z"},{"id":"e047","kind":"punch_out","at":"2026-10-21T01:00:00Z"}],"points_at":[],"km":0,"km_gaps":0},"expect":{"status":"present","flex":false,"first_in":"2026-10-20T20:00:00Z","last_out":"2026-10-21T01:00:00Z","worked_min":300,"break_min":0,"late_min":0,"early_min":720,"missed_out":false,"irregular":false,"worked_on_duty":null,"half_day_leave":false,"open":false,"leave_units":0,"absent_units":0}},{"name":"early_morning_start_not_the_day_before","input":{"day":"2026-10-20","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"shop","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":false,"events":[{"id":"e046","kind":"punch_in","at":"2026-10-20T20:00:00Z"},{"id":"e047","kind":"punch_out","at":"2026-10-21T01:00:00Z"}],"points_at":[],"km":0,"km_gaps":0},"expect":{"status":"absent","flex":false,"first_in":null,"last_out":null,"worked_min":0,"break_min":0,"late_min":0,"early_min":0,"missed_out":false,"irregular":false,"worked_on_duty":null,"half_day_leave":false,"open":false,"leave_units":0,"absent_units":1}},{"name":"before_tracking_starts","input":{"day":"2026-10-20","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"shop","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":false,"events":[],"points_at":[],"km":0,"km_gaps":0,"tracked_from":"2026-10-21"},"expect":{"status":"not_tracked","flex":false,"first_in":null,"last_out":null,"worked_min":0,"break_min":0,"late_min":0,"early_min":0,"missed_out":false,"irregular":false,"worked_on_duty":null,"half_day_leave":false,"open":false,"leave_units":0,"absent_units":0}},{"name":"before_tracking_starts_punched","input":{"day":"2026-10-20","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"shop","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":false,"events":[{"id":"e048","kind":"punch_in","at":"2026-10-20T04:00:00Z"},{"id":"e049","kind":"punch_out","at":"2026-10-20T13:00:00Z"}],"points_at":[],"km":0,"km_gaps":0,"tracked_from":"2026-10-21"},"expect":{"status":"present","flex":false,"first_in":"2026-10-20T04:00:00Z","last_out":"2026-10-20T13:00:00Z","worked_min":540,"break_min":0,"late_min":0,"early_min":0,"missed_out":false,"irregular":false,"worked_on_duty":null,"half_day_leave":false,"open":false,"leave_units":0,"absent_units":0}},{"name":"leave_before_tracking_starts","note":"an approved leave before attendance_from (or the account) is still leave","input":{"day":"2026-10-20","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"leave","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":false,"events":[],"points_at":[],"km":0,"km_gaps":0,"tracked_from":"2026-10-21"},"expect":{"status":"leave","flex":false,"first_in":null,"last_out":null,"worked_min":0,"break_min":0,"late_min":0,"early_min":0,"missed_out":false,"irregular":false,"worked_on_duty":null,"half_day_leave":false,"open":false,"leave_units":1,"absent_units":0}},{"name":"half_day_leave_before_tracking_starts","note":"a half-day leave before attendance_from: the leave half counts, the other half is not absent","input":{"day":"2026-10-20","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"shop","holiday":null,"attendance_required":true,"flex_request":false,"half_day_leave":true,"events":[],"points_at":[],"km":0,"km_gaps":0,"tracked_from":"2026-10-21"},"expect":{"status":"leave","flex":true,"first_in":null,"last_out":null,"worked_min":0,"break_min":0,"late_min":0,"early_min":0,"missed_out":false,"irregular":false,"worked_on_duty":null,"half_day_leave":true,"open":false,"leave_units":0.5,"absent_units":0}},{"name":"off_before_tracking_starts","note":"a holiday before attendance_from is still off","input":{"day":"2026-10-20","now":"2026-10-22T06:30:00Z","max_session_h":16,"shift":{"start":"09:30","end":"18:30","grace_min":10,"half_day_min":240},"duty":"off","holiday":"Zq Festival","attendance_required":true,"flex_request":false,"half_day_leave":false,"events":[],"points_at":[],"km":0,"km_gaps":0,"tracked_from":"2026-10-21"},"expect":{"status":"off","flex":false,"first_in":null,"last_out":null,"worked_min":0,"break_min":0,"late_min":0,"early_min":0,"missed_out":false,"irregular":false,"worked_on_duty":null,"half_day_leave":false,"open":false,"leave_units":0,"absent_units":0}}]}$fx$::jsonb);

create function neo_hrt.put(p_k text, p_v text) returns void language plpgsql as $$
begin
  insert into neo_hrt.ctx (k, v) values (p_k, p_v) on conflict (k) do update set v = excluded.v;
end $$;
create function neo_hrt.get(p_k text) returns text language plpgsql volatile as $$
declare v text;
begin
  select c.v into v from neo_hrt.ctx c where c.k = p_k;
  if not found or v is null then raise exception 'TEST BUG: nothing stored under "%"', p_k; end if;
  return v;
end $$;
create function neo_hrt.email(p_alias text) returns text language plpgsql volatile as $$
declare v text;
begin
  select u.email into v from neo_hrt.users u where u.alias = p_alias;
  if not found then raise exception 'TEST SETUP: no test user "%"', p_alias; end if;
  return lower(v);
end $$;
create function neo_hrt.uid(p_alias text) returns uuid language plpgsql volatile as $$
declare v uuid;
begin
  select u.id into v from neo_hrt.users u where u.alias = p_alias;
  if not found then raise exception 'TEST SETUP: no test user "%"', p_alias; end if;
  return v;
end $$;
create function neo_hrt.name(p_alias text) returns text language plpgsql volatile as $$
declare v text;
begin
  select u.name into v from neo_hrt.users u where u.alias = p_alias;
  if not found then raise exception 'TEST SETUP: no test user "%"', p_alias; end if;
  return v;
end $$;
create function neo_hrt.login(p_alias text) returns void language plpgsql as $$
declare u neo_hrt.users;
begin
  select * into u from neo_hrt.users where alias = p_alias;
  if not found then raise exception 'TEST SETUP: no test user "%"', p_alias; end if;
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', u.id::text, true);
  perform set_config('request.jwt.claim.email', u.email, true);
  perform set_config('request.jwt.claims',
                     json_build_object('sub', u.id, 'email', u.email, 'role', 'authenticated')::text, true);
end $$;
create function neo_hrt.login_anon() returns void language plpgsql as $$
begin
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.email', '', true);
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
end $$;
create function neo_hrt.no_jwt() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.email', '', true);
  perform set_config('request.jwt.claims', '', true);
end $$;
create function neo_hrt.assert(p_ok boolean, p_msg text) returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FAIL: %', p_msg; end if;
end $$;
create function neo_hrt.expect_error(p_sql text, p_like text) returns void language plpgsql as $$
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
-- India days and instants relative to today.
create function neo_hrt.today() returns date language sql stable as $$
  select (now() at time zone 'Asia/Kolkata')::date
$$;
create function neo_hrt.d(p_days int) returns date language sql stable as $$
  select neo_hrt.today() + p_days
$$;
create function neo_hrt.at(p_days int, p_time text) returns timestamptz language sql stable as $$
  select ((neo_hrt.today() + p_days) + p_time::time) at time zone 'Asia/Kolkata'
$$;
-- A day of the previous month (always closed: travel allowance).
create function neo_hrt.lmd() returns date language sql stable as $$
  select date_trunc('month', neo_hrt.today())::date - 3
$$;
-- hr_punch with a device time (p_at), or server-anchored (p_age_ms).
create function neo_hrt.punch(p_kind text, p_at timestamptz, p_id uuid default null, p_age_ms bigint default null)
returns jsonb language plpgsql as $$
begin
  return public.hr_punch(jsonb_strip_nulls(jsonb_build_object('id', coalesce(p_id, gen_random_uuid()), 'kind', p_kind,
                                                              'at', p_at, 'age_ms', p_age_ms)));
end $$;
-- One route point (device time, or with age_ms).
create function neo_hrt.pt(p_at timestamptz, p_lat float8, p_lng float8, p_acc float8 default 10, p_id uuid default null,
                           p_age_ms bigint default null) returns jsonb language sql volatile as $$
  select jsonb_strip_nulls(jsonb_build_object('id', coalesce(p_id, gen_random_uuid()), 'at', p_at, 'age_ms', p_age_ms,
                                              'lat', p_lat, 'lng', p_lng, 'accuracy_m', p_acc))
$$;
-- A fixture case's first run moved to start at p_start (fresh uuids, same spacing).
create function neo_hrt.fixture_points(p_case text, p_start timestamptz) returns jsonb language sql volatile as $$
  with c as (select x.value as cs from neo_hrt.fx f, jsonb_array_elements(f.body -> 'cases') as x(value)
              where f.name = 'hr-km' and x.value ->> 'name' = p_case),
       pts as (select pt.value as p, pt.ordinality as n from c, jsonb_array_elements(c.cs -> 'runs' -> 0) with ordinality as pt),
       t0 as (select min((p ->> 'at')::timestamptz) as t from pts)
  select jsonb_agg(jsonb_build_object('id', gen_random_uuid(), 'at', p_start + ((pts.p ->> 'at')::timestamptz - t0.t),
                                      'lat', (pts.p ->> 'lat')::float8, 'lng', (pts.p ->> 'lng')::float8,
                                      'accuracy_m', pts.p -> 'accuracy_m') order by pts.n)
    from pts, t0
$$;
create function neo_hrt.fixture_expect(p_case text) returns jsonb language sql stable as $$
  select x.value -> 'expect' from neo_hrt.fx f, jsonb_array_elements(f.body -> 'cases') as x(value)
   where f.name = 'hr-km' and x.value ->> 'name' = p_case
$$;
create function neo_hrt.keys(p jsonb) returns text[] language sql immutable as $$
  select coalesce(array_agg(k order by k), '{}') from jsonb_object_keys(p) as k
$$;
create function neo_hrt.reason(p_answer jsonb, p_id text) returns text language sql immutable as $$
  select e.value ->> 'reason' from jsonb_array_elements(coalesce(p_answer -> 'rejected', '[]'::jsonb)) as e(value)
   where e.value ->> 'id' = p_id limit 1
$$;
create function neo_hrt.person(p_board jsonb, p_email text) returns jsonb language sql immutable as $$
  select e.value from jsonb_array_elements(coalesce(p_board -> 'people', '[]'::jsonb)) as e(value)
   where lower(e.value ->> 'email') = lower(p_email) limit 1
$$;
-- The day record of one person on one day in a register answer.
create function neo_hrt.regday(p_reg jsonb, p_email text, p_day date) returns jsonb language sql immutable as $$
  select d.value from jsonb_array_elements(coalesce(neo_hrt.person(p_reg, p_email) -> 'days', '[]'::jsonb)) as d(value)
   where (d.value ->> 'day')::date = p_day limit 1
$$;
-- Today's expected "no punch yet" status for the pinned 09:30 / 10 min shift.
create function neo_hrt.idle_status() returns text language sql stable as $$
  select case when now() < neo_hrt.at(0, '09:40') then 'not_in_yet' else 'absent' end
$$;
grant execute on all functions in schema neo_hrt to anon, authenticated;

-- Owner-only helpers (created after the grant above, so no client may call them).
create function neo_hrt.raw_event(p_alias text, p_kind text, p_at timestamptz, p_lat float8 default null, p_lng float8 default null)
returns uuid language plpgsql as $$
declare v uuid := gen_random_uuid();
begin
  insert into public.attendance_events (id, profile_id, employee_email, kind, at, device_at, time_source, lat, lng, accuracy_m, source, created_by_email)
  values (v, neo_hrt.uid(p_alias), neo_hrt.email(p_alias), p_kind, p_at, p_at, 'device', p_lat, p_lng, case when p_lat is not null then 8 end,
          'phone', neo_hrt.email(p_alias));
  return v;
end $$;
create function neo_hrt.raw_points(p_alias text, p_points jsonb) returns int language plpgsql as $$
declare n int;
begin
  insert into public.location_points (client_point_id, profile_id, employee_email, at, device_at, time_source, lat, lng, accuracy_m)
  select (x.value ->> 'id')::uuid, neo_hrt.uid(p_alias), neo_hrt.email(p_alias), (x.value ->> 'at')::timestamptz,
         (x.value ->> 'at')::timestamptz, 'device', (x.value ->> 'lat')::float8, (x.value ->> 'lng')::float8,
         (x.value ->> 'accuracy_m')::float8
    from jsonb_array_elements(p_points) as x(value);
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function neo_hrt.raw_event(text, text, timestamptz, float8, float8) from public, anon, authenticated;
revoke all on function neo_hrt.raw_points(text, jsonb) from public, anon, authenticated;


-- ── 1. Test users ────────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from public.profiles where lower(email) like 'zq.hr.%@neotokyo.test')
     or exists (select 1 from auth.users where lower(email) like 'zq.hr.%@neotokyo.test') then
    raise exception 'TEST SETUP: zq.hr.*@neotokyo.test logins already exist; change the test emails in this file';
  end if;
  if exists (select 1 from public.service_jobs where id like 's\_hrt\_%') then
    raise exception 'TEST SETUP: s_hrt_* ticket ids are already in use';
  end if;
end $$;

insert into auth.users (id, email, raw_user_meta_data) values
  ('b2222222-0000-4000-8000-000000000001', 'zq.hr.tech@neotokyo.test', '{"full_name":"Zqhr Tech"}'),
  ('b2222222-0000-4000-8000-000000000002', 'zq.hr.walk@neotokyo.test', '{"full_name":"Zqhr Walker"}'),
  ('b2222222-0000-4000-8000-000000000003', 'zq.hr.lead@neotokyo.test', '{"full_name":"Zqhr Lead"}'),
  ('b2222222-0000-4000-8000-000000000004', 'zq.hr.sales@neotokyo.test', '{"full_name":"Zqhr Sales"}'),
  ('b2222222-0000-4000-8000-000000000005', 'zq.hr.plain@neotokyo.test', '{"full_name":"Zqhr Plain"}'),
  ('b2222222-0000-4000-8000-000000000006', 'zq.hr.flex@neotokyo.test', '{"full_name":"Zqhr Flex"}'),
  ('b2222222-0000-4000-8000-000000000007', 'zq.hr.lock@neotokyo.test', '{"full_name":"Zqhr Lock"}'),
  ('b2222222-0000-4000-8000-000000000008', 'zq.hr.night@neotokyo.test', '{"full_name":"Zqhr Night"}'),
  ('b2222222-0000-4000-8000-000000000009', 'zq.hr.break@neotokyo.test', '{"full_name":"Zqhr Break"}'),
  ('b2222222-0000-4000-8000-000000000010', 'zq.hr.idle@neotokyo.test', '{"full_name":"Zqhr Idle"}'),
  ('b2222222-0000-4000-8000-000000000011', 'zq.hr.guest@neotokyo.test', '{"full_name":"Zqhr Guest"}'),
  ('b2222222-0000-4000-8000-000000000012', 'zq.hr.thin@neotokyo.test', '{"full_name":"Zqhr Thin"}'),
  ('b2222222-0000-4000-8000-000000000013', 'zq.hr.old@neotokyo.test', '{"full_name":"Zqhr Old"}'),
  ('b2222222-0000-4000-8000-000000000014', 'zq.hr.noallow@neotokyo.test', '{"full_name":"Zqhr Noallow"}'),
  ('b2222222-0000-4000-8000-000000000015', 'zq.hr.fix@neotokyo.test', '{"full_name":"Zqhr Fix"}');
update public.profiles p
   set full_name = u.raw_user_meta_data ->> 'full_name', active = true, is_staff = true,
       tier = case when p.email in ('zq.hr.sales@neotokyo.test') then 1 else 2 end,
       designation = 'Zq Tester'
  from auth.users u
 where u.id = p.id and p.email like 'zq.hr.%@neotokyo.test' and p.email <> 'zq.hr.guest@neotokyo.test';
update public.profiles set full_name = 'Zqhr Guest', tier = 1, is_staff = false, active = true
 where email = 'zq.hr.guest@neotokyo.test';

-- (the real tier 3 head may be inactive now: active again inside this transaction only)
update public.profiles set active = true, is_staff = true where lower(email) = 'jophy.joseph@neotokyo.in' and tier = 3;

insert into neo_hrt.users (alias, id, email, tier, name)
select a.alias, p.id, lower(p.email), p.tier, p.full_name
  from (values ('owner', 'ananthakrishnan@neotokyo.in'), ('ceo', 'ajay.joy@neotokyo.in'), ('cto', 'rony.thomas@neotokyo.in'),
               ('head', 'jophy.joseph@neotokyo.in'),
               ('tech', 'zq.hr.tech@neotokyo.test'), ('walk', 'zq.hr.walk@neotokyo.test'), ('lead', 'zq.hr.lead@neotokyo.test'),
               ('sales', 'zq.hr.sales@neotokyo.test'), ('plain', 'zq.hr.plain@neotokyo.test'), ('flex', 'zq.hr.flex@neotokyo.test'),
               ('lock', 'zq.hr.lock@neotokyo.test'), ('night', 'zq.hr.night@neotokyo.test'), ('brk', 'zq.hr.break@neotokyo.test'),
               ('idle', 'zq.hr.idle@neotokyo.test'), ('guest', 'zq.hr.guest@neotokyo.test'), ('thin', 'zq.hr.thin@neotokyo.test'),
               ('old', 'zq.hr.old@neotokyo.test'), ('noallow', 'zq.hr.noallow@neotokyo.test'),
               ('fix', 'zq.hr.fix@neotokyo.test')) as a(alias, email)
  join public.profiles p on lower(p.email) = a.email;

do $$
begin
  if (select count(*) from neo_hrt.users) <> 19 then raise exception 'TEST SETUP: missing profiles (%)', (select count(*) from neo_hrt.users); end if;
  if (select tier from neo_hrt.users where alias = 'owner') <> 5 then raise exception 'TEST SETUP: owner must be tier 5'; end if;
  if exists (select 1 from neo_hrt.users where alias in ('ceo', 'cto') and tier <> 4) then raise exception 'TEST SETUP: ceo / cto must be tier 4'; end if;
  if (select tier from neo_hrt.users where alias = 'head') <> 3 then raise exception 'TEST SETUP: head must be tier 3'; end if;
  if exists (select 1 from neo_hrt.users u join public.profiles p on p.id = u.id
              where u.alias <> 'guest' and (not p.active or not coalesce(p.is_staff, false))) then
    raise exception 'TEST SETUP: every test user but guest must be active staff';
  end if;
end $$;

-- Roles: the lead is a NeoHR lead (tier 2), the tech a service technician.
delete from public.module_access where profile_id in (select id from neo_hrt.users where alias not in ('owner', 'ceo', 'cto', 'head'));
insert into public.module_access (profile_id, module, role, granted_by)
select u.id, m.module, m.role, 'tests'
  from neo_hrt.users u
  join (values ('lead', 'neohr', 'lead'), ('tech', 'service', 'tech'), ('plain', 'neohr', 'desk')) as m(alias, module, role)
    on m.alias = u.alias;

-- Pin the shift, the settings and the near holidays for this transaction (one default
-- shift row: any later default rows HR scheduled are set aside until the rollback).
delete from public.hr_shift_history
 where profile_id is null and effective_from > (select min(h.effective_from) from public.hr_shift_history h where h.profile_id is null);
update public.hr_shift_history set shift_start = '09:30', shift_end = '18:30', grace_min = 10, weekly_off = '{}', half_day_min = 240
 where profile_id is null;
update public.hr_settings
   set shift_start = '09:30', shift_end = '18:30', grace_min = 10, weekly_off = '{}', half_day_min = 240,
       max_session_h = 16, track_interval_s = 120, track_distance_m = 100, retention_days = 90, ta_rate_per_km = null,
       office_lat = null, office_lng = null, office_radius_m = 150, last_purge_at = now(), attendance_from = '2020-01-01'
 where id = 1;
-- the throw-away accounts 'existed' long before the days this file reads
update public.profiles set created_at = '2020-01-01' where email like 'zq.hr.%@neotokyo.test';
delete from public.hr_holidays where day between neo_hrt.d(-130) and neo_hrt.d(130);
delete from public.hr_roster where profile_id in (select id from neo_hrt.users);
delete from public.hr_shift_history where profile_id in (select id from neo_hrt.users);
delete from public.hr_person where profile_id in (select id from neo_hrt.users);
-- v2.4: route, trips and travel allowance are for field staff only (no row = none), so
-- the throw-away logins these tests record routes for are field staff
insert into public.hr_person (profile_id, track_location, ta_eligible, updated_by)
select u.id, true, true, 'tests' from neo_hrt.users u where u.email like 'zq.hr.%@neotokyo.test' and u.alias <> 'guest';


-- ── 2. Schema facts, RLS, grants (as the owner) ─────────────────────────────
do $$
declare
  t text; f record; n int;
  v_api text[] := array['hr_punch', 'hr_my_day', 'hr_my_month', 'location_push', 'hr_route', 'hr_request_create',
    'hr_request_cancel', 'hr_request_decide', 'hr_requests_list', 'hr_roster_set', 'hr_roster_get', 'hr_board', 'hr_register',
    'hr_correct', 'hr_settings_get', 'hr_settings_set', 'hr_person_set', 'hr_ta_report', 'hr_ta_approve', 'hr_ta_unapprove',
    'hr_holiday_set', 'hr_dashboard', 'record_field_activity', 'tech_activity'];
begin
  foreach t in array array['hr_settings', 'hr_person', 'hr_shift_history', 'attendance_events', 'location_points', 'hr_requests',
                           'hr_roster', 'hr_ta_approvals', 'hr_day_km', 'hr_holidays', 'hr_route_views'] loop
    perform neo_hrt.assert((select relrowsecurity from pg_class where oid = format('public.%I', t)::regclass), t || ': RLS is on');
    perform neo_hrt.assert(not has_table_privilege('anon', format('public.%I', t), 'select, insert, update, delete, truncate, references, trigger'),
                           t || ': anon has no privilege');
    perform neo_hrt.assert(not has_table_privilege('authenticated', format('public.%I', t), 'insert, update, delete, truncate, references, trigger'),
                           t || ': authenticated cannot write');
    perform neo_hrt.assert(has_table_privilege('authenticated', format('public.%I', t), 'select') = (t not in ('location_points', 'attendance_events')),
                           t || ': authenticated may select (location_points and, since v2.4, attendance_events: nobody)');
    perform neo_hrt.assert(not exists (select 1 from pg_publication_tables where tablename = t), t || ' is not in realtime');
  end loop;
  perform neo_hrt.assert(not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'location_points'),
                         'location_points has no policy at all');
  perform neo_hrt.assert(not has_column_privilege('authenticated', 'public.attendance_events', 'lat', 'select'),
                         'v2.4: no client reads punch coordinates');
  -- every function of the file: _hr_* internal, the API for authenticated
  for f in select p.oid, p.proname, p.prosecdef, p.proconfig from pg_proc p
            where p.pronamespace = 'public'::regnamespace and (p.proname ~ '^_hr_' or p.proname = any (v_api)) loop
    perform neo_hrt.assert(not has_function_privilege('anon', f.oid, 'execute'), 'anon cannot execute ' || f.proname);
    perform neo_hrt.assert(has_function_privilege('service_role', f.oid, 'execute'), 'service_role may execute ' || f.proname);
    if f.proname = any (v_api) then
      perform neo_hrt.assert(has_function_privilege('authenticated', f.oid, 'execute'), 'authenticated may execute ' || f.proname);
      perform neo_hrt.assert(f.prosecdef and array_to_string(f.proconfig, ',') like '%search_path=public%',
                             f.proname || ' is security definer with search_path = public');
    else
      perform neo_hrt.assert(not has_function_privilege('authenticated', f.oid, 'execute'), 'authenticated cannot execute ' || f.proname);
      perform neo_hrt.assert(array_to_string(f.proconfig, ',') like '%search_path=public%', f.proname || ' pins search_path');
    end if;
  end loop;
  select count(*) into n from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = any (v_api);
  perform neo_hrt.assert(n = cardinality(v_api), format('every API function exists exactly once (%s of %s)', n, cardinality(v_api)));
  perform neo_hrt.assert((select pg_get_function_identity_arguments(oid) from pg_proc where proname = 'record_field_activity'
                            and pronamespace = 'public'::regnamespace) = 'p jsonb'
                         and (select pg_get_function_identity_arguments(oid) from pg_proc where proname = 'tech_activity'
                                and pronamespace = 'public'::regnamespace) = 'p_from date, p_to date',
                         '9.9.1: record_field_activity and tech_activity keep their v2 signatures');
  perform neo_hrt.assert((select count(*) from public.hr_settings) = 1, 'one settings row');
  perform neo_hrt.assert(exists (select 1 from public.hr_shift_history where profile_id is null and effective_from = '2020-01-01'),
                         'the default shift row since 2020 is seeded');
  perform neo_hrt.assert((select string_agg(pg_get_constraintdef(oid), ' ') from pg_constraint
                           where conrelid = 'public.attendance_events'::regclass and contype = 'c') like '%''phone''%''hr''%'
                         and (select string_agg(pg_get_constraintdef(oid), ' ') from pg_constraint
                               where conrelid = 'public.attendance_events'::regclass and contype = 'c') not like '%desktop%',
                         'attendance_events.source is phone or hr (no desktop)');
  -- every internal is volatile-safe: neo_dashboard was not touched (NeoHR 2.1.1 phones)
  perform neo_hrt.assert(pg_get_functiondef('public.neo_dashboard()'::regprocedure) not like '%attendance%'
                         and pg_get_functiondef('public.neo_dashboard()'::regprocedure) not like '%_hr_%',
                         '9.9.2: neo_dashboard is not redefined');
  perform neo_hrt.assert(exists (select 1 from pg_indexes where tablename = 'attendance_events' and indexdef like '%lower(employee_email)%at%')
                         and exists (select 1 from pg_indexes where tablename = 'location_points' and indexdef like '%lower(employee_email)%at%'),
                         'the (lower(employee_email), at) indexes exist');
end $$;

-- neo_dashboard keeps every v2.2 key (as a head: every section).
select neo_hrt.login('head');
do $$
declare r jsonb := public.neo_dashboard();
begin
  perform neo_hrt.assert(r ?& array['now', 'me', 'queue', 'service', 'builds', 'rma', 'team', 'attention']
                         and not (r ? 'hr') and not (r ? 'attendance')
                         and neo_hrt.keys(r -> 'me') = array['designation', 'name', 'tier']
                         and neo_hrt.keys(r -> 'team') = array['alerts', 'busy', 'free', 'load_pct', 'logs_today', 'people', 'visits_today'],
                         'neo_dashboard keeps exactly its v2.2 shape: ' || r::text);
end $$;


-- ── 3. Pure parts: India time, the shared fixtures, the fold ────────────────
reset role;
select neo_hrt.no_jwt();
do $$
declare c jsonb; r jsonb; e jsonb; k text; i int; n int := 0; v_a text; v_b text;
begin
  -- India days: from 00:00 to 05:30 IST the UTC date is still yesterday.
  perform neo_hrt.assert(public._hr_today('2026-10-22T19:00:00Z') = '2026-10-23', 'IST: 00:30 on the 23rd is the 23rd');
  perform neo_hrt.assert(public._hr_today('2026-10-22T18:30:00Z') = '2026-10-23', 'IST: 00:00 on the 23rd is the 23rd');
  perform neo_hrt.assert(public._hr_today('2026-10-22T18:29:59Z') = '2026-10-22', 'IST: 23:59:59 on the 22nd is the 22nd');
  perform neo_hrt.assert(public._hr_today('2026-10-23T00:29:00Z') = '2026-10-23', 'IST: 05:59 on the 23rd is the 23rd');
  perform neo_hrt.assert(public._hr_today() = (now() at time zone 'Asia/Kolkata')::date, 'IST: the default is now');
  perform neo_hrt.assert(public._hr_at('2026-10-23', '00:00') = '2026-10-22T18:30:00Z'
                         and public._hr_at('2026-10-23', '09:30') = '2026-10-23T04:00:00Z', 'IST: shift instants');
  perform neo_hrt.assert(abs(public._hr_hav(10, 76, 11, 76) - 111195.08023353292) < 0.001
                         and public._hr_hav(10.0159, 76.3419, 10.0159, 76.3419) = 0, 'haversine: R = 6371008.8, one degree of latitude');

  -- tests/fixtures/hr-km.json through _hr_track_points (§9.5.4)
  for c in select x.value from neo_hrt.fx f, jsonb_array_elements(f.body -> 'cases') as x(value) where f.name = 'hr-km' loop
    r := public._hr_track_points(c -> 'runs');
    e := c -> 'expect';
    perform neo_hrt.assert(abs((r ->> 'total_m')::float8 - (e ->> 'total_m')::float8) <= 0.001,
                           format('km fixture %s: total_m %s, expected %s', c ->> 'name', r ->> 'total_m', e ->> 'total_m'));
    perform neo_hrt.assert((r ->> 'km')::numeric = (e ->> 'km')::numeric,
                           format('km fixture %s: km %s, expected %s', c ->> 'name', r ->> 'km', e ->> 'km'));
    perform neo_hrt.assert((r ->> 'km_gaps')::int = (e ->> 'km_gaps')::int,
                           format('km fixture %s: km_gaps %s, expected %s', c ->> 'name', r ->> 'km_gaps', e ->> 'km_gaps'));
    perform neo_hrt.assert(r -> 'kept' = e -> 'kept', format('km fixture %s: kept %s, expected %s', c ->> 'name', r -> 'kept', e -> 'kept'));
    perform neo_hrt.assert(jsonb_array_length(r -> 'stops') = jsonb_array_length(e -> 'stops'),
                           format('km fixture %s: %s stops, expected %s', c ->> 'name', jsonb_array_length(r -> 'stops'), jsonb_array_length(e -> 'stops')));
    for i in 0 .. jsonb_array_length(e -> 'stops') - 1 loop
      perform neo_hrt.assert((r -> 'stops' -> i ->> 'arrived')::timestamptz = (e -> 'stops' -> i ->> 'arrived')::timestamptz
                             and (r -> 'stops' -> i ->> 'left')::timestamptz = (e -> 'stops' -> i ->> 'left')::timestamptz
                             and abs((r -> 'stops' -> i ->> 'lat')::float8 - (e -> 'stops' -> i ->> 'lat')::float8) <= 1e-7
                             and abs((r -> 'stops' -> i ->> 'lng')::float8 - (e -> 'stops' -> i ->> 'lng')::float8) <= 1e-7,
                             format('km fixture %s: stop %s is %s, expected %s', c ->> 'name', i, r -> 'stops' -> i, e -> 'stops' -> i));
    end loop;
    n := n + 1;
  end loop;
  perform neo_hrt.assert(n >= 12, 'every km fixture case ran (' || n || ')');
  -- the gap and moving segments of the tunnel case
  r := public._hr_track_points((select x.value -> 'runs' from neo_hrt.fx f, jsonb_array_elements(f.body -> 'cases') as x(value)
                                 where f.name = 'hr-km' and x.value ->> 'name' = 'tunnel_gap'));
  perform neo_hrt.assert((select count(*) from jsonb_array_elements(r -> 'segments') s where s.value ->> 'mode' = 'gap') = 1
                         and (select count(*) from jsonb_array_elements(r -> 'segments') s where s.value ->> 'mode' = 'moving') = 2,
                         'segments: a gap between two moving stretches ' || (r -> 'segments')::text);

  -- tests/fixtures/hr-day.json through _hr_day_calc
  n := 0;
  for c in select x.value from neo_hrt.fx f, jsonb_array_elements(f.body -> 'cases') as x(value) where f.name = 'hr-day' loop
    r := public._hr_day_calc(c -> 'input');
    for k in select jsonb_object_keys(c -> 'expect') loop
      v_a := r ->> k; v_b := c -> 'expect' ->> k;
      if k in ('first_in', 'last_out') and v_a is not null and v_b is not null then
        perform neo_hrt.assert(v_a::timestamptz = v_b::timestamptz, format('day fixture %s: %s %s, expected %s', c ->> 'name', k, v_a, v_b));
      elsif k in ('leave_units', 'absent_units') then
        perform neo_hrt.assert(v_a::numeric = v_b::numeric, format('day fixture %s: %s %s, expected %s', c ->> 'name', k, v_a, v_b));
      else
        perform neo_hrt.assert(v_a is not distinct from v_b, format('day fixture %s: %s %s, expected %s', c ->> 'name', k, v_a, v_b));
      end if;
    end loop;
    n := n + 1;
  end loop;
  perform neo_hrt.assert(n >= 30, 'every day fixture case ran (' || n || ')');

  -- the fold's probe (what the writers' two-sided check reads)
  r := public._hr_fold(jsonb_build_array(
         jsonb_build_object('id', 'a', 'kind', 'punch_in', 'at', '2026-10-20T04:00:00Z'),
         jsonb_build_object('id', 'b', 'kind', 'break_start', 'at', '2026-10-20T06:00:00Z'),
         jsonb_build_object('id', 'c', 'kind', 'punch_out', 'at', '2026-10-20T12:00:00Z')), 16, '2026-10-22T00:00:00Z', 'b');
  perform neo_hrt.assert(r -> 'probe' ->> 'ok' = 'true' and r -> 'probe' ->> 'before' = 'on_duty'
                         and r -> 'probe' ->> 'next_id' = 'c' and r -> 'probe' ->> 'next_ok' = 'true'
                         and r ->> 'state' = 'off_duty' and jsonb_array_length(r -> 'sessions') = 1
                         and r -> 'sessions' -> 0 -> 'breaks' -> 0 ->> 'to' is not null,
                         'fold: a punch_out during a break ends the break ' || r::text);
  r := public._hr_fold(jsonb_build_array(
         jsonb_build_object('id', 'a', 'kind', 'punch_in', 'at', '2026-10-20T04:00:00Z'),
         jsonb_build_object('id', 'b', 'kind', 'punch_out', 'at', '2026-10-20T21:00:00Z')), 16, '2026-10-22T00:00:00Z', 'b');
  perform neo_hrt.assert(r -> 'probe' ->> 'ok' = 'false' and r -> 'probe' ->> 'before' = 'off_duty'
                         and (r -> 'probe' ->> 'auto_cap')::timestamptz = '2026-10-20T20:00:00Z'
                         and r -> 'sessions' -> 0 ->> 'end' = 'auto' and r ->> 'since' is not null,
                         'fold: no punch_out by the cap → closed at punch_in + 16 h; a later punch_out is refused ' || r::text);
  r := public._hr_fold(jsonb_build_array(
         jsonb_build_object('id', 'a', 'kind', 'punch_in', 'at', '2026-10-20T04:00:00Z'),
         jsonb_build_object('id', 'b', 'kind', 'punch_out', 'at', '2026-10-20T20:00:00Z')), 16, '2026-10-22T00:00:00Z');
  perform neo_hrt.assert(r -> 'sessions' -> 0 ->> 'end' = 'out', 'fold: a punch_out exactly at the cap still closes the session');
  r := public._hr_fold(jsonb_build_array(jsonb_build_object('id', 'a', 'kind', 'punch_in', 'at', now() - interval '1 hour')), 16, now());
  perform neo_hrt.assert(r ->> 'state' = 'on_duty' and r -> 'sessions' -> 0 ->> 'end' = 'open', 'fold: an open session');
  r := public._hr_fold(jsonb_build_array(jsonb_build_object('id', 'a', 'kind', 'punch_in', 'at', '2026-10-20T04:00:00Z')), 4, '2026-10-20T08:00:00Z');
  perform neo_hrt.assert(r ->> 'state' = 'off_duty' and (r ->> 'since')::timestamptz = '2026-10-20T08:00:00Z',
                         'fold: off duty from the cap on (max_session_h is the current setting)');
  r := public._hr_runs(jsonb_build_array(jsonb_build_object('start', '2026-10-20T04:00:00Z', 'cap', '2026-10-20T20:00:00Z', 'end', 'out',
         'out', '2026-10-20T12:00:00Z', 'day', '2026-10-20', 'open_break', null,
         'breaks', jsonb_build_array(jsonb_build_object('from', '2026-10-20T06:00:00Z', 'to', '2026-10-20T07:00:00Z')))));
  perform neo_hrt.assert(jsonb_array_length(r) = 2 and (r -> 0 ->> 'to')::timestamptz = '2026-10-20T06:00:00Z'
                         and (r -> 1 ->> 'from')::timestamptz = '2026-10-20T07:00:00Z' and (r -> 1 ->> 'to')::timestamptz = '2026-10-20T12:00:00Z',
                         'runs: on duty and not on a break ' || r::text);
end $$;


-- ── 4. Locks (§9.4.2): hr_punch takes the person's lock, location_push shares it ──
select neo_hrt.login('lock');
do $$
declare k bigint := hashtext('neo_hr_att:' || neo_hrt.email('lock')); v text; n int;
begin
  -- inside a subtransaction, so the lock is released again and nothing is kept
  begin
    perform neo_hrt.punch('punch_in', now(), null, 60000);
    select count(*) into n from pg_locks l
     where l.locktype = 'advisory' and l.objsubid = 1 and l.mode = 'ExclusiveLock'
       and l.classid = ((k >> 32) & 4294967295)::oid and l.objid = (k & 4294967295)::oid;
    raise exception 'probe:%', n;
  exception when others then v := sqlerrm;
  end;
  perform neo_hrt.assert(v = 'probe:1', 'hr_punch holds pg_advisory_xact_lock on neo_hr_att:<email> (' || v || ')');
  begin
    perform public.location_push(jsonb_build_array(neo_hrt.pt(now(), 10.0159, 76.3419)));
    select count(*) into n from pg_locks l
     where l.locktype = 'advisory' and l.objsubid = 1 and l.mode = 'ShareLock'
       and l.classid = ((k >> 32) & 4294967295)::oid and l.objid = (k & 4294967295)::oid;
    raise exception 'probe:%', n;
  exception when others then v := sqlerrm;
  end;
  perform neo_hrt.assert(v = 'probe:1', 'location_push holds the SHARED lock on the same key (' || v || ')');
  perform neo_hrt.assert(not exists (select 1 from neo_hrt.ae where employee_email = neo_hrt.email('lock')),
                         'the probes left nothing behind');
end $$;
-- hr_correct takes the person's lock (once, for every change of the set)
select neo_hrt.login('lead');
do $$
declare k bigint := hashtext('neo_hr_att:' || neo_hrt.email('lock')); v text; n int;
begin
  begin
    perform public.hr_correct(neo_hrt.email('lock'), jsonb_build_object('note', 'Lock probe', 'ops', jsonb_build_array(
      jsonb_build_object('action', 'add', 'kind', 'punch_in', 'at', now() - interval '2 hours'),
      jsonb_build_object('action', 'add', 'kind', 'punch_out', 'at', now() - interval '1 hour'))));
    select count(*) into n from pg_locks l
     where l.locktype = 'advisory' and l.objsubid = 1 and l.mode = 'ExclusiveLock'
       and l.classid = ((k >> 32) & 4294967295)::oid and l.objid = (k & 4294967295)::oid;
    raise exception 'probe:%', n;
  exception when others then v := sqlerrm;
  end;
  perform neo_hrt.assert(v = 'probe:1', 'hr_correct holds pg_advisory_xact_lock on neo_hr_att:<email> (' || v || ')');
  perform neo_hrt.assert(not exists (select 1 from neo_hrt.ae where employee_email = neo_hrt.email('lock')),
                         'the probe left nothing behind');
end $$;


-- ── 5. hr_punch: fields, time, replays, the sequence and the two-sided check ──
select neo_hrt.login_anon();
do $$
begin
  perform neo_hrt.expect_error($q$select public.hr_punch('{}'::jsonb)$q$, '%permission denied%');
  perform neo_hrt.expect_error($q$select public.location_push('[]'::jsonb)$q$, '%permission denied%');
  perform neo_hrt.expect_error($q$select public.hr_dashboard()$q$, '%permission denied%');
end $$;

select neo_hrt.login('guest');
do $$
begin
  perform neo_hrt.expect_error($q$select neo_hrt.punch('punch_in', now())$q$, '%NEO_DENIED: Sign in with an active staff account to do this.%');
  perform neo_hrt.expect_error($q$select public.hr_dashboard()$q$, '%NEO_DENIED: Sign in with an active staff account to do this.%');
  perform neo_hrt.expect_error($q$select public.hr_settings_get()$q$, '%NEO_DENIED: Sign in with an active staff account%');
end $$;

select neo_hrt.login('lock');
do $$
declare r jsonb; r2 jsonb; v_id uuid := gen_random_uuid(); e public.attendance_events;
begin
  perform neo_hrt.expect_error($q$select public.hr_punch(null)$q$, '%NEO_GATE: The request is empty.%');
  perform neo_hrt.expect_error($q$select public.hr_punch('{"kind":"punch_in"}'::jsonb)$q$,
                               '%NEO_GATE: id is required — make one UUID per punch and reuse it on every retry.%');
  perform neo_hrt.expect_error($q$select public.hr_punch('{"id":"nope","kind":"punch_in"}'::jsonb)$q$, '%NEO_GATE: id is not a valid UUID.%');
  perform neo_hrt.expect_error(format('select public.hr_punch(%L::jsonb)', jsonb_build_object('id', gen_random_uuid(), 'kind', 'lunch')),
                               '%NEO_GATE: Say what you''re punching: punch_in, punch_out, break_start or break_end.%');
  -- device time outside 2020-01-01 … now + 10 min
  perform neo_hrt.expect_error(format('select neo_hrt.punch(%L, %L)', 'punch_in', '2019-12-31T10:00:00Z'),
                               '%NEO_GATE: The phone''s clock is wrong — turn on automatic date and time, then punch again.%');
  perform neo_hrt.expect_error(format('select neo_hrt.punch(%L, %L)', 'punch_in', now() + interval '11 minutes'),
                               '%NEO_GATE: The phone''s clock is wrong%');
  -- server-anchored: at = now() − age_ms, device_at = the phone's at, time_source 'server' (a wrong clock is fine)
  r := public.hr_punch(jsonb_build_object('id', v_id, 'kind', 'punch_in', 'at', '2019-01-01T00:00:00Z', 'age_ms', 90000,
                                          'lat', 10.0159, 'lng', 76.3419, 'accuracy_m', 9, 'source', 'desktop', 'note', 'first in'));
  perform neo_hrt.assert(r ->> 'ok' = 'true' and r ->> 'duplicate' = 'false' and r ->> 'state' = 'on_duty'
                         and (r ->> 'since')::timestamptz = now() - interval '90 seconds' and r ->> 'id' = v_id::text
                         and r ? 'now' and r -> 'day' ->> 'status' = 'open' and r -> 'tracking' ->> 'enabled' = 'true',
                         'hr_punch answers {ok, duplicate, now, id, state, since, day, tracking} ' || r::text);
  perform neo_hrt.assert(r ?& array['day', 'duplicate', 'id', 'now', 'ok', 'since', 'state', 'tracking'], 'hr_punch keys (v2.4 adds check) ' || r::text);
  select * into e from neo_hrt.ae where id = v_id;
  perform neo_hrt.assert(e.at = now() - interval '90 seconds' and e.device_at = '2019-01-01T00:00:00Z' and e.time_source = 'server'
                         and e.source = 'phone' and e.employee_email = neo_hrt.email('lock') and e.profile_id = neo_hrt.uid('lock')
                         and e.lat = 10.0159 and e.accuracy_m = 9 and e.note = 'first in',
                         '§9.3.3: anchored time; source is always phone');
  -- a replay: the CURRENT state, duplicate:true
  perform neo_hrt.punch('break_start', now(), null, 30000);
  r2 := public.hr_punch(jsonb_build_object('id', v_id, 'kind', 'punch_in', 'at', now()));
  perform neo_hrt.assert(r2 ->> 'ok' = 'true' and r2 ->> 'duplicate' = 'true' and r2 ->> 'state' = 'on_break',
                         'a replay answers with the current state ' || r2::text);
  perform neo_hrt.assert((select count(*) from neo_hrt.ae where id = v_id) = 1, 'a replay stores nothing');
  perform neo_hrt.put('lock_punch', v_id::text);
  -- wrong steps
  perform neo_hrt.expect_error($q$select neo_hrt.punch('punch_in', now())$q$, '%NEO_GATE: You''re already punched in.%');
  perform neo_hrt.expect_error($q$select neo_hrt.punch('break_start', now())$q$, '%NEO_GATE: You''re already on a break.%');
  perform neo_hrt.punch('punch_out', now(), null, 10000);
  perform neo_hrt.expect_error($q$select neo_hrt.punch('break_start', now())$q$, '%NEO_GATE: Punch in first.%');
  perform neo_hrt.expect_error($q$select neo_hrt.punch('break_end', now())$q$, '%NEO_GATE: You''re not on a break.%');
  perform neo_hrt.expect_error($q$select neo_hrt.punch('punch_out', now())$q$, '%NEO_GATE: You''re not punched in.%');
  r := neo_hrt.punch('punch_in', now(), null, 5000);
  perform neo_hrt.expect_error($q$select neo_hrt.punch('break_end', now())$q$, '%NEO_GATE: You''re not on a break.%');
  perform neo_hrt.punch('punch_out', now(), null, 1000);
end $$;

-- An id someone else used is refused; a replay of a voided id says so.
select neo_hrt.login('night');
do $$
begin
  perform neo_hrt.expect_error(format('select neo_hrt.punch(%L, now(), %L::uuid)', 'punch_in', neo_hrt.get('lock_punch')),
                               '%NEO_GATE: That punch id is already used.%');
end $$;

-- The two-sided check with offline (device-time) punches, and the tie-break.
select neo_hrt.login('tech');
do $$
declare r jsonb;
begin
  -- the week the later sections read: d-6 late, d-5 field (roster later), d-4 a short day
  perform neo_hrt.punch('punch_in', neo_hrt.at(-6, '09:55'));
  perform neo_hrt.punch('punch_out', neo_hrt.at(-6, '18:35'));
  perform neo_hrt.punch('punch_in', neo_hrt.at(-5, '11:00'));
  perform neo_hrt.punch('punch_out', neo_hrt.at(-5, '17:00'));
  perform neo_hrt.punch('punch_in', neo_hrt.at(-4, '09:30'));
  perform neo_hrt.punch('punch_out', neo_hrt.at(-4, '12:00'));
  -- offline inserts between existing punches: allowed only when both sides still fit
  r := neo_hrt.punch('break_start', neo_hrt.at(-4, '11:00'));
  perform neo_hrt.assert(r ->> 'ok' = 'true' and (r -> 'day' ->> 'day')::date = neo_hrt.d(-4),
                         'an offline break_start between punch_in and punch_out fits; day = that session''s day ' || r::text);
  perform neo_hrt.punch('break_end', neo_hrt.at(-4, '11:30'));
  perform neo_hrt.expect_error(format('select neo_hrt.punch(%L, %L)', 'punch_in', neo_hrt.at(-4, '10:00')),
                               '%NEO_GATE: You''re already punched in.%');
  perform neo_hrt.expect_error(format('select neo_hrt.punch(%L, %L)', 'punch_out', neo_hrt.at(-4, '11:45')),
                               '%NEO_GATE: That doesn''t fit the day''s punches.%');
  perform neo_hrt.expect_error(format('select neo_hrt.punch(%L, %L)', 'break_end', neo_hrt.at(-4, '11:15')),
                               '%NEO_GATE: That doesn''t fit the day''s punches.%');
  -- today: on duty since an hour ago (server-anchored)
  r := neo_hrt.punch('punch_in', now(), null, 3600000);
  perform neo_hrt.put('tech_in', r ->> 'id');
  perform neo_hrt.assert(r ->> 'state' = 'on_duty'
                         and (r -> 'day' ->> 'day')::date = ((now() - interval '1 hour') at time zone 'Asia/Kolkata')::date,
                         'the open session belongs to the India day of its punch_in ' || r::text);
end $$;

-- (at, received_at, id): two punches at the same instant, received in the same transaction, sort by id.
select neo_hrt.login('night');
do $$
declare v_hi uuid := 'ffffffff-0000-4000-8000-000000000001';
begin
  perform neo_hrt.punch('punch_in', neo_hrt.at(-6, '09:30'), v_hi);
  perform neo_hrt.expect_error(format('select neo_hrt.punch(%L, %L, %L::uuid)', 'break_start', neo_hrt.at(-6, '09:30'),
                                      '00000000-0000-4000-8000-000000000001'),
                               '%NEO_GATE: Punch in first.%');
  perform neo_hrt.assert((neo_hrt.punch('break_start', neo_hrt.at(-6, '09:30'), 'ffffffff-ffff-4fff-8fff-ffffffffffff') ->> 'ok')::boolean,
                         'the same instant with a larger id sorts after the punch_in and fits');
  perform neo_hrt.punch('break_end', neo_hrt.at(-6, '10:00'));
  perform neo_hrt.punch('punch_out', neo_hrt.at(-6, '18:00'));
  -- a session past midnight belongs to its punch_in day
  perform neo_hrt.punch('punch_in', neo_hrt.at(-5, '20:00'));
  perform neo_hrt.punch('punch_out', neo_hrt.at(-4, '02:00'));
end $$;
do $$
declare r jsonb;
begin
  r := public.hr_my_day(neo_hrt.d(-5));
  perform neo_hrt.assert(r ->> 'status' = 'late' and (r ->> 'worked_min')::int = 360 and (r ->> 'late_min')::int = 620
                         and (r ->> 'last_out')::timestamptz = neo_hrt.at(-4, '02:00')
                         and jsonb_array_length(r -> 'events') = 2,
                         'a session past midnight belongs to its punch_in day ' || r::text);
  r := public.hr_my_day(neo_hrt.d(-4));
  perform neo_hrt.assert(r ->> 'status' = 'absent' and jsonb_array_length(r -> 'events') = 0,
                         'the 02:00 punch_out is not the next day''s ' || r::text);
  r := public.hr_my_day(neo_hrt.d(-6));
  perform neo_hrt.assert(r ->> 'status' = 'present' and (r ->> 'break_min')::int = 30 and (r ->> 'worked_min')::int = 480
                         and r ->> 'irregular' = 'false',
                         'the tie-broken day folds cleanly ' || r::text);
end $$;

-- Forgotten punch-out: the server closes the session at punch_in + 16 h.
select neo_hrt.login('flex');
do $$
declare r jsonb;
begin
  perform neo_hrt.punch('punch_in', neo_hrt.at(-2, '08:00'));
  perform neo_hrt.expect_error(format('select neo_hrt.punch(%L, %L)', 'punch_out', neo_hrt.at(-1, '01:00')),
                               '%NEO_GATE: That shift was closed automatically — ask HR to add your punch-out.%');
  r := neo_hrt.punch('punch_in', neo_hrt.at(-1, '09:30'));
  perform neo_hrt.assert(r ->> 'ok' = 'true', 'after the cap the next punch_in is accepted');
  perform neo_hrt.punch('punch_out', neo_hrt.at(-1, '18:00'));
  r := public.hr_my_day(neo_hrt.d(-2));
  perform neo_hrt.assert(r ->> 'missed_out' = 'true' and r ->> 'last_out' is null
                         and (r -> 'sessions' -> 0 ->> 'cap_at')::timestamptz = neo_hrt.at(-2, '08:00') + interval '16 hours',
                         'missed_out is set on the day of the capped session ' || r::text);
  r := public.hr_my_day(neo_hrt.d(-1));
  perform neo_hrt.assert(r ->> 'status' = 'present' and r ->> 'missed_out' = 'false' and (r ->> 'worked_min')::int = 510,
                         'the next day is a normal day ' || r::text);
end $$;


-- ── 6. A week of day records: roster, leave, correction, register, month ─────
-- tech: d-6 late · d-5 field duty · d-4 short day with a break · d-3 absent
-- (then corrected by HR) · d-2 approved leave · d-1 roster off · today open.
select neo_hrt.login('lead');
do $$
declare r jsonb;
begin
  r := public.hr_roster_set(neo_hrt.email('tech'), neo_hrt.d(-5), 'field', 'Site visits');
  perform neo_hrt.assert(r ->> 'ok' = 'true' and r ->> 'duty' = 'field' and r ->> 'source' = 'roster', 'roster: field duty ' || r::text);
  r := public.hr_roster_set(neo_hrt.email('tech'), neo_hrt.d(-1), 'off', null);
  perform neo_hrt.assert(r ->> 'duty' = 'off', 'roster: an off day');
end $$;

select neo_hrt.login('tech');
do $$
declare r jsonb;
begin
  r := public.hr_request_create(jsonb_build_object('kind', 'leave', 'date_from', neo_hrt.d(-2), 'leave_type', 'sick',
                                                   'reason', 'Fever, doctor''s note to follow'));
  perform neo_hrt.assert(r ->> 'ok' = 'true' and r -> 'request' ->> 'status' = 'pending' and (r -> 'request' ->> 'date_to')::date = neo_hrt.d(-2)
                         and r -> 'request' ->> 'leave_type' = 'sick', 'a one-day leave request (date_to defaults to date_from) ' || r::text);
  perform neo_hrt.put('tech_leave', r -> 'request' ->> 'id');
end $$;

select neo_hrt.login('lead');
do $$
declare r jsonb;
begin
  r := public.hr_request_decide(neo_hrt.get('tech_leave')::uuid, true, 'Get well soon');
  perform neo_hrt.assert(r ->> 'ok' = 'true' and r -> 'request' ->> 'status' = 'approved' and r -> 'request' ->> 'decided_by_name' = neo_hrt.name('lead')
                         and r -> 'request' ->> 'decision_note' = 'Get well soon', 'approve a leave ' || r::text);
  perform neo_hrt.assert(exists (select 1 from public.hr_roster where profile_id = neo_hrt.uid('tech') and day = neo_hrt.d(-2) and duty = 'leave'
                                   and note = 'Leave' and source_request_id = neo_hrt.get('tech_leave')::uuid),
                         'an approved leave writes the roster: duty leave, note "Leave" (never the reason), source_request_id');
  -- d-3: tech forgot both punches; HR adds them (two-sided rules, 'hr' source, a note)
  perform neo_hrt.expect_error(format('select public.hr_correct(%L, %L::jsonb)', neo_hrt.email('tech'),
                                      jsonb_build_object('action', 'add', 'kind', 'punch_in', 'at', neo_hrt.at(-3, '09:40'))),
                               '%NEO_GATE: Say why — HR corrections need a note.%');
  r := public.hr_correct(neo_hrt.email('tech'), jsonb_build_object('action', 'add', 'kind', 'punch_in', 'at', neo_hrt.at(-3, '09:40'),
                                                                     'note', 'Was at the counter, phone off'));
  perform neo_hrt.assert(r ->> 'ok' = 'true' and r -> 'event' ->> 'source' = 'hr' and r -> 'event' ->> 'time_source' = 'hr'
                         and r -> 'event' ->> 'created_by_email' = neo_hrt.email('lead') and (r -> 'day' ->> 'day')::date = neo_hrt.d(-3),
                         'hr_correct adds an hr punch ' || r::text);
  perform neo_hrt.put('tech_fix_in', r -> 'event' ->> 'id');
  perform neo_hrt.expect_error(format('select public.hr_correct(%L, %L::jsonb)', neo_hrt.email('tech'),
                                      jsonb_build_object('action', 'add', 'kind', 'punch_in', 'at', neo_hrt.at(-3, '10:00'), 'note', 'again')),
                               '%NEO_GATE: You''re already punched in.%');
  r := public.hr_correct(neo_hrt.email('tech'), jsonb_build_object('action', 'add', 'kind', 'punch_out', 'at', neo_hrt.at(-3, '18:30'),
                                                                     'note', 'Left with the van'));
  perform neo_hrt.put('tech_fix_out', r -> 'event' ->> 'id');
  perform neo_hrt.assert(r -> 'day' ->> 'status' = 'present' and (r -> 'day' ->> 'worked_min')::int = 530
                         and (r -> 'day' ->> 'clock_marks')::int = 0, 'the corrected day is present ' || (r -> 'day')::text);
  -- voids: the punch_in cannot go while its punch_out stays
  perform neo_hrt.expect_error(format('select public.hr_correct(%L, %L::jsonb)', neo_hrt.email('tech'),
                                      jsonb_build_object('action', 'void', 'id', neo_hrt.get('tech_fix_in'), 'note', 'wrong')),
                               '%NEO_GATE: Voiding that breaks the order of the day''s punches — fix the matching punch too.%');
  perform neo_hrt.expect_error(format('select public.hr_correct(%L, %L::jsonb)', neo_hrt.email('tech'),
                                      jsonb_build_object('action', 'void', 'note', 'wrong')), '%NEO_GATE: Say which punch to void.%');
  perform neo_hrt.expect_error(format('select public.hr_correct(%L, %L::jsonb)', neo_hrt.email('tech'),
                                      jsonb_build_object('action', 'void', 'id', gen_random_uuid(), 'note', 'wrong')),
                               '%NEO_GATE: That punch was not found.%');
  perform neo_hrt.expect_error(format('select public.hr_correct(%L, %L::jsonb)', neo_hrt.email('tech'),
                                      jsonb_build_object('action', 'move', 'note', 'wrong')), '%NEO_GATE: Say add or void.%');
  perform neo_hrt.expect_error(format('select public.hr_correct(%L, %L::jsonb)', neo_hrt.email('tech'),
                                      jsonb_build_object('action', 'add', 'kind', 'nap', 'at', now(), 'note', 'x x')),
                               '%NEO_GATE: Say what you''re punching: punch_in, punch_out, break_start or break_end.%');
  perform neo_hrt.expect_error(format('select public.hr_correct(%L, %L::jsonb)', neo_hrt.email('tech'),
                                      jsonb_build_object('action', 'add', 'kind', 'punch_in', 'note', 'x x')),
                               '%NEO_GATE: Say when it happened.%');
  perform neo_hrt.expect_error(format('select public.hr_correct(%L, %L::jsonb)', neo_hrt.email('tech'),
                                      jsonb_build_object('action', 'add', 'kind', 'punch_in', 'at', '2019-06-01T04:00:00Z', 'note', 'x x')),
                               '%NEO_GATE: That time can''t be right — check the date.%');
  perform neo_hrt.expect_error(format('select public.hr_correct(%L, %L::jsonb)', neo_hrt.email('tech'),
                                      jsonb_build_object('action', 'add', 'kind', 'punch_in', 'at', neo_hrt.at(-30, '09:00'),
                                                         'id', neo_hrt.get('tech_fix_out'), 'note', 'x x')),
                               '%NEO_GATE: That punch id is already used.%');
  perform neo_hrt.expect_error(format('select public.hr_correct(%L, %L::jsonb)', 'nobody@neotokyo.test', '{"action":"add"}'),
                               '%NEO_GATE: There is no staff account with that email.%');
  perform neo_hrt.expect_error(format('select public.hr_correct(%L, null)', neo_hrt.email('tech')), '%NEO_GATE: The request is empty.%');
  -- void the punch_out then the punch_in (the day is absent again), then put them back
  r := public.hr_correct(neo_hrt.email('tech'), jsonb_build_object('action', 'void', 'id', neo_hrt.get('tech_fix_out'), 'note', 'Wrong day'));
  perform neo_hrt.assert(r -> 'event' ->> 'voided_at' is not null and r -> 'event' ->> 'void_reason' = 'Wrong day', 'void ' || r::text);
  perform neo_hrt.expect_error(format('select public.hr_correct(%L, %L::jsonb)', neo_hrt.email('tech'),
                                      jsonb_build_object('action', 'void', 'id', neo_hrt.get('tech_fix_out'), 'note', 'again')),
                               '%NEO_GATE: That punch is already voided.%');
  r := public.hr_correct(neo_hrt.email('tech'), jsonb_build_object('action', 'void', 'id', neo_hrt.get('tech_fix_in'), 'note', 'Wrong day'));
  perform neo_hrt.assert(r -> 'day' ->> 'status' = 'absent', 'both voided: absent again ' || (r -> 'day')::text);
  perform public.hr_correct(neo_hrt.email('tech'), jsonb_build_object('action', 'add', 'kind', 'punch_in', 'at', neo_hrt.at(-3, '09:40'), 'note', 'Back in'));
  perform public.hr_correct(neo_hrt.email('tech'), jsonb_build_object('action', 'add', 'kind', 'punch_out', 'at', neo_hrt.at(-3, '18:30'), 'note', 'Back in'));
end $$;

-- Corrections that need more than one change, made as ONE correction (ops):
-- fix d-2: in 09:30, out 11:00 by mistake, in 11:05, out 18:30 (the accidental out–in pair);
-- fix d-4 → d-3: in 19:00, forgot to punch out, the phone still said on duty next morning:
-- out 09:00 + in 09:01, out 18:00 (the real punch-out was 23:00: a missed punch request).
select neo_hrt.login('fix');
do $$
declare r jsonb;
begin
  perform neo_hrt.put('fix_p1', neo_hrt.punch('punch_in', neo_hrt.at(-2, '09:30')) ->> 'id');
  perform neo_hrt.put('fix_p2', neo_hrt.punch('punch_out', neo_hrt.at(-2, '11:00')) ->> 'id');
  perform neo_hrt.put('fix_p3', neo_hrt.punch('punch_in', neo_hrt.at(-2, '11:05')) ->> 'id');
  perform neo_hrt.put('fix_p4', neo_hrt.punch('punch_out', neo_hrt.at(-2, '18:30')) ->> 'id');
  perform neo_hrt.put('fix_q1', neo_hrt.punch('punch_in', neo_hrt.at(-4, '19:00')) ->> 'id');
  perform neo_hrt.put('fix_q2', neo_hrt.punch('punch_out', neo_hrt.at(-3, '09:00')) ->> 'id');
  perform neo_hrt.put('fix_q3', neo_hrt.punch('punch_in', neo_hrt.at(-3, '09:01')) ->> 'id');
  perform neo_hrt.put('fix_q4', neo_hrt.punch('punch_out', neo_hrt.at(-3, '18:00')) ->> 'id');
  r := public.hr_request_create(jsonb_build_object('kind', 'missed_punch', 'missed_kind', 'punch_out', 'missed_at', neo_hrt.at(-4, '23:00'),
                                                   'reason', 'Left the site at 23:00'));
  perform neo_hrt.put('fix_missed', r -> 'request' ->> 'id');
  r := public.hr_request_create(jsonb_build_object('kind', 'missed_punch', 'missed_kind', 'break_start', 'missed_at', neo_hrt.at(-2, '13:00'),
                                                   'reason', 'Lunch, forgot the break'));
  perform neo_hrt.put('fix_brk', r -> 'request' ->> 'id');
  r := public.hr_request_create(jsonb_build_object('kind', 'missed_punch', 'missed_kind', 'break_end', 'missed_at', neo_hrt.at(-2, '13:30'),
                                                   'reason', 'Lunch, forgot the break'));
  perform neo_hrt.put('fix_brk_end', r -> 'request' ->> 'id');
  r := public.hr_request_create(jsonb_build_object('kind', 'late_start', 'date_from', neo_hrt.d(-1), 'reason', 'Bus breakdown'));
  perform neo_hrt.put('fix_late', r -> 'request' ->> 'id');
end $$;
select neo_hrt.login('lead');
do $$
declare r jsonb; s text := 'select public.hr_correct(%L, %L::jsonb)'; v_n int; v_e text := neo_hrt.email('fix');
begin
  select count(*) into v_n from neo_hrt.ae where employee_email = v_e;
  -- one change at a time cannot remove the pair: either void alone breaks the order
  perform neo_hrt.expect_error(format(s, v_e, jsonb_build_object('action', 'void', 'id', neo_hrt.get('fix_p2'), 'note', 'Tapped out by mistake')),
                               '%NEO_GATE: Voiding that breaks the order of the day''s punches — fix the matching punch too.%');
  perform neo_hrt.expect_error(format(s, v_e, jsonb_build_object('action', 'void', 'id', neo_hrt.get('fix_p3'), 'note', 'Tapped out by mistake')),
                               '%NEO_GATE: Voiding that breaks the order of the day''s punches — fix the matching punch too.%');
  -- the shape of a set
  perform neo_hrt.expect_error(format(s, v_e, jsonb_build_object('ops', 'void', 'note', 'Tapped out by mistake')),
                               '%NEO_GATE: Send from 1 to 10 changes.%');
  perform neo_hrt.expect_error(format(s, v_e, jsonb_build_object('ops', '[]'::jsonb, 'note', 'Tapped out by mistake')),
                               '%NEO_GATE: Send from 1 to 10 changes.%');
  perform neo_hrt.expect_error(format(s, v_e, jsonb_build_object('note', 'Too many', 'ops',
                                 (select jsonb_agg(jsonb_build_object('action', 'void', 'id', gen_random_uuid())) from generate_series(1, 11)))),
                               '%NEO_GATE: Send from 1 to 10 changes.%');
  perform neo_hrt.expect_error(format(s, v_e, jsonb_build_object('ops', jsonb_build_array(5), 'note', 'Tapped out by mistake')),
                               '%NEO_GATE: Say add or void.%');
  perform neo_hrt.expect_error(format(s, v_e, jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('action', 'void', 'id', neo_hrt.get('fix_p2'))),
                                                                 'note', 'no')),
                               '%NEO_GATE: Say why — HR corrections need a note.%');
  perform neo_hrt.expect_error(format(s, v_e, jsonb_build_object('note', 'Twice', 'ops', jsonb_build_array(
                                 jsonb_build_object('action', 'void', 'id', neo_hrt.get('fix_p2')),
                                 jsonb_build_object('action', 'void', 'id', neo_hrt.get('fix_p2'))))),
                               '%NEO_GATE: That punch is already voided.%');
  perform neo_hrt.expect_error(format(s, v_e, jsonb_build_object('note', 'Same id', 'ops', jsonb_build_array(
                                 jsonb_build_object('action', 'add', 'kind', 'punch_in', 'at', neo_hrt.at(-10, '09:00'), 'id', 'f1000000-0000-4000-8000-000000000001'),
                                 jsonb_build_object('action', 'add', 'kind', 'punch_out', 'at', neo_hrt.at(-10, '18:00'), 'id', 'f1000000-0000-4000-8000-000000000001')))),
                               '%NEO_GATE: That punch id is already used.%');
  -- an added punch the fold does not take answers as hr_punch would; a set that makes a later punch irregular is refused
  perform neo_hrt.expect_error(format(s, v_e, jsonb_build_object('note', 'In again', 'ops', jsonb_build_array(
                                 jsonb_build_object('action', 'add', 'kind', 'punch_in', 'at', neo_hrt.at(-2, '10:00'))))),
                               '%NEO_GATE: You''re already punched in.%');
  perform neo_hrt.expect_error(format(s, v_e, jsonb_build_object('note', 'A break instead', 'ops', jsonb_build_array(
                                 jsonb_build_object('action', 'void', 'id', neo_hrt.get('fix_p2')),
                                 jsonb_build_object('action', 'add', 'kind', 'break_start', 'at', neo_hrt.at(-2, '11:02'))))),
                               '%NEO_GATE: That doesn''t fit the day''s punches.%');
  perform neo_hrt.assert((select count(*) from neo_hrt.ae where employee_email = v_e) = v_n
                         and not exists (select 1 from neo_hrt.ae where employee_email = v_e and voided_at is not null),
                         'a refused set changes nothing');
  -- remove the pair: one correction, one day
  r := public.hr_correct(v_e, jsonb_build_object('note', 'Tapped out by mistake', 'ops', jsonb_build_array(
         jsonb_build_object('action', 'void', 'id', neo_hrt.get('fix_p2')), jsonb_build_object('action', 'void', 'id', neo_hrt.get('fix_p3')))));
  perform neo_hrt.assert(r ->> 'ok' = 'true' and jsonb_array_length(r -> 'events') = 2
                         and r -> 'events' -> 0 ->> 'id' = neo_hrt.get('fix_p2') and r -> 'events' -> 1 ->> 'id' = neo_hrt.get('fix_p3')
                         and r -> 'events' -> 0 ->> 'voided_at' is not null and r -> 'events' -> 1 ->> 'void_reason' = 'Tapped out by mistake'
                         and r -> 'event' = r -> 'events' -> 0 and jsonb_array_length(r -> 'days') = 1
                         and (r -> 'day' ->> 'day')::date = neo_hrt.d(-2) and r -> 'day' ->> 'status' = 'present'
                         and (r -> 'day' ->> 'worked_min')::int = 540 and jsonb_array_length(r -> 'day' -> 'sessions') = 1
                         and r -> 'day' ->> 'irregular' = 'false',
                         'ops: the accidental out–in pair goes in one correction ' || r::text);
  -- replace a punch: void + add
  r := public.hr_correct(v_e, jsonb_build_object('note', 'Was in at 09:20', 'ops', jsonb_build_array(
         jsonb_build_object('action', 'void', 'id', neo_hrt.get('fix_p1')),
         jsonb_build_object('action', 'add', 'kind', 'punch_in', 'at', neo_hrt.at(-2, '09:20')))));
  perform neo_hrt.assert(r ->> 'ok' = 'true' and (r -> 'day' ->> 'first_in')::timestamptz = neo_hrt.at(-2, '09:20')
                         and (r -> 'day' ->> 'worked_min')::int = 550 and r -> 'events' -> 1 ->> 'source' = 'hr'
                         and r -> 'events' -> 1 ->> 'time_source' = 'hr' and r -> 'events' -> 1 ->> 'created_by_email' = neo_hrt.email('lead')
                         and r -> 'events' -> 1 ->> 'note' = 'Was in at 09:20',
                         'ops: replace a punch ' || r::text);
  -- the forgotten punch-out: approving the request alone, adding the punch-out alone, voiding the morning punch_out alone — each refused
  perform neo_hrt.expect_error(format('select public.hr_request_decide(%L::uuid, true)', neo_hrt.get('fix_missed')),
                               '%NEO_GATE: That punch no longer fits the day — use Correct….%');
  perform neo_hrt.expect_error(format(s, v_e, jsonb_build_object('action', 'add', 'kind', 'punch_out', 'at', neo_hrt.at(-4, '23:00'), 'note', 'Left the site')),
                               '%NEO_GATE: That doesn''t fit the day''s punches.%');
  perform neo_hrt.expect_error(format(s, v_e, jsonb_build_object('action', 'void', 'id', neo_hrt.get('fix_q2'), 'note', 'Not a real punch-out')),
                               '%NEO_GATE: Voiding that breaks the order of the day''s punches — fix the matching punch too.%');
  -- request_id: only this person's pending missed punch
  perform neo_hrt.expect_error(format(s, v_e, jsonb_build_object('ops', '[]'::jsonb, 'request_id', neo_hrt.get('tech_leave'), 'note', 'Wrong one')),
                               '%NEO_GATE: That request is someone else''s.%');
  perform neo_hrt.expect_error(format(s, v_e, jsonb_build_object('ops', '[]'::jsonb, 'request_id', neo_hrt.get('fix_late'), 'note', 'Wrong one')),
                               '%NEO_GATE: Only a missed punch is approved with a correction.%');
  perform neo_hrt.expect_error(format(s, v_e, jsonb_build_object('ops', '[]'::jsonb, 'request_id', gen_random_uuid(), 'note', 'Wrong one')),
                               '%NEO_GATE: That request no longer exists.%');
  -- approved WITH the changes it needs: void the morning punch_out, and fix the evening punch-out of d-3 too (two days)
  r := public.hr_correct(v_e, jsonb_build_object('note', 'Left the site at 23:00; out at 18:15 on the next day', 'request_id', neo_hrt.get('fix_missed'),
         'ops', jsonb_build_array(jsonb_build_object('action', 'void', 'id', neo_hrt.get('fix_q2')),
                                  jsonb_build_object('action', 'void', 'id', neo_hrt.get('fix_q4')),
                                  jsonb_build_object('action', 'add', 'kind', 'punch_out', 'at', neo_hrt.at(-3, '18:15')))));
  perform neo_hrt.assert(r ->> 'ok' = 'true' and r -> 'request' ->> 'status' = 'approved' and r -> 'request' ->> 'decided_by_name' = neo_hrt.name('lead')
                         and jsonb_array_length(r -> 'events') = 4 and r -> 'events' -> 0 ->> 'id' = neo_hrt.get('fix_q2')
                         and r -> 'events' -> 3 ->> 'kind' = 'punch_out' and (r -> 'events' -> 3 ->> 'at')::timestamptz = neo_hrt.at(-4, '23:00')
                         and r -> 'events' -> 3 ->> 'note' = 'Left the site at 23:00' and r -> 'events' -> 3 ->> 'source' = 'hr'
                         and (r -> 'day' ->> 'day')::date = neo_hrt.d(-4) and (r -> 'day' ->> 'last_out')::timestamptz = neo_hrt.at(-4, '23:00')
                         and (r -> 'day' ->> 'worked_min')::int = 240 and r -> 'day' ->> 'missed_out' = 'false'
                         and jsonb_array_length(r -> 'days') = 2 and (r -> 'days' -> 0 ->> 'day')::date = neo_hrt.d(-4)
                         and (r -> 'days' -> 1 ->> 'day')::date = neo_hrt.d(-3) and (r -> 'days' -> 1 ->> 'first_in')::timestamptz = neo_hrt.at(-3, '09:01')
                         and (r -> 'days' -> 1 ->> 'last_out')::timestamptz = neo_hrt.at(-3, '18:15'),
                         'a missed punch approved with the changes it needs, in one correction ' || r::text);
  perform neo_hrt.assert((select status from public.hr_requests where id = neo_hrt.get('fix_missed')::uuid) = 'approved', 'the request is approved');
  -- …once: a request no longer pending answers 'decided' and changes nothing
  select count(*) into v_n from neo_hrt.ae where employee_email = v_e;
  r := public.hr_correct(v_e, jsonb_build_object('ops', '[]'::jsonb, 'request_id', neo_hrt.get('fix_missed'), 'note', 'Again'));
  perform neo_hrt.assert(r ->> 'ok' = 'false' and r ->> 'reason' = 'decided' and r ->> 'status' = 'approved' and r ->> 'by' = neo_hrt.name('lead')
                         and r ->> 'at' is not null and (select count(*) from neo_hrt.ae where employee_email = v_e) = v_n,
                         'a decided request through hr_correct ' || r::text);
  -- a missed punch on its own (no other change), through hr_correct and through hr_request_decide
  r := public.hr_correct(v_e, jsonb_build_object('ops', '[]'::jsonb, 'request_id', neo_hrt.get('fix_brk'), 'note', 'Lunch break'));
  perform neo_hrt.assert(r ->> 'ok' = 'true' and r -> 'request' ->> 'status' = 'approved' and jsonb_array_length(r -> 'events') = 1,
                         'a missed break start approved through hr_correct ' || r::text);
  r := public.hr_request_decide(neo_hrt.get('fix_brk_end')::uuid, true, null);
  perform neo_hrt.assert(r ->> 'ok' = 'true', 'the missed break end through hr_request_decide ' || r::text);
  r := public.hr_my_day(neo_hrt.d(-2), v_e);
  perform neo_hrt.assert((r ->> 'break_min')::int = 30 and (r ->> 'worked_min')::int = 520 and r ->> 'irregular' = 'false'
                         and (select count(*) from jsonb_array_elements(r -> 'events') e where e.value ->> 'voided_at' is not null) = 3,
                         'd-2 after the corrections (the voided punches still listed) ' || r::text);
end $$;

-- A replay of a voided punch id answers {ok:false, duplicate:true, voided:true}.
select neo_hrt.login('tech');
do $$
declare r jsonb;
begin
  r := public.hr_punch(jsonb_build_object('id', neo_hrt.get('tech_fix_out'), 'kind', 'punch_out', 'at', neo_hrt.at(-3, '18:30')));
  perform neo_hrt.assert(r ->> 'ok' = 'false' and r ->> 'duplicate' = 'true' and r ->> 'voided' = 'true' and r ? 'state' and r ? 'tracking',
                         'a replay of a voided id ' || r::text);
  -- my own day: no clock marks for me, tracking and viewed_by present
  r := public.hr_my_day(neo_hrt.d(-6));
  perform neo_hrt.assert(r ->> 'status' = 'late' and (r ->> 'late_min')::int = 15 and (r ->> 'worked_min')::int = 520
                         and r ? 'tracking' and r ? 'viewed_by' and r -> 'events' -> 0 ->> 'clock_mark' is null
                         and r -> 'events' -> 0 ->> 'time_source' = 'device' and r ->> 'email' = neo_hrt.email('tech'),
                         'hr_my_day (own): late 09:55 vs 09:40, no clock marks for me ' || r::text);
  perform neo_hrt.assert(r ?& array['now', 'day', 'status', 'flex', 'first_in', 'last_out', 'worked_min', 'break_min', 'late_min',
                                    'early_min', 'missed_out', 'irregular', 'worked_on_duty', 'half_day_leave', 'sessions', 'km',
                                    'km_gaps', 'holiday', 'duty', 'shift', 'events', 'visits', 'requests', 'tracking', 'viewed_by'],
                         'hr_my_day keys ' || neo_hrt.keys(r)::text);
  perform neo_hrt.expect_error(format('select public.hr_my_day(%L, %L)', neo_hrt.d(-6), neo_hrt.email('walk')),
                               '%NEO_DENIED: Only a head or a NeoHR lead can see someone else''s day.%');
  r := public.hr_my_day();
  perform neo_hrt.assert((r ->> 'day')::date = (now() at time zone 'Asia/Kolkata')::date, 'hr_my_day defaults to today in India');
end $$;

-- The register (approvers): a week of tech's days.
select neo_hrt.login('lead');
do $$
declare r jsonb; v_today date := neo_hrt.today(); d jsonb;
begin
  r := public.hr_register(neo_hrt.d(-6), neo_hrt.d(0), neo_hrt.email('tech'));
  perform neo_hrt.assert(jsonb_array_length(r -> 'people') = 1 and jsonb_array_length(neo_hrt.person(r, neo_hrt.email('tech')) -> 'days') = 7,
                         'register: one person, seven days ' || r::text);
  d := neo_hrt.regday(r, neo_hrt.email('tech'), neo_hrt.d(-6));
  perform neo_hrt.assert(d ->> 'status' = 'late' and (d ->> 'late_min')::int = 15 and (d ->> 'clock_marks')::int = 2,
                         'd-6: late; both punches carry a clock mark (device time) for an approver ' || d::text);
  d := neo_hrt.regday(r, neo_hrt.email('tech'), neo_hrt.d(-5));
  perform neo_hrt.assert(d ->> 'status' = 'present' and d ->> 'flex' = 'true' and (d ->> 'late_min')::int = 0 and (d ->> 'early_min')::int = 0
                         and d ->> 'duty' = 'field' and d ->> 'duty_source' = 'roster' and d ->> 'roster_note' = 'Site visits',
                         'd-5: field duty → flex, no late or early marks ' || d::text);
  d := neo_hrt.regday(r, neo_hrt.email('tech'), neo_hrt.d(-4));
  perform neo_hrt.assert(d ->> 'status' = 'half_day' and (d ->> 'worked_min')::int = 120 and (d ->> 'break_min')::int = 30
                         and (d ->> 'early_min')::int = 390, 'd-4: 09:30–12:00 with a 30-minute break → half day ' || d::text);
  d := neo_hrt.regday(r, neo_hrt.email('tech'), neo_hrt.d(-3));
  perform neo_hrt.assert(d ->> 'status' = 'present' and (d ->> 'worked_min')::int = 530, 'd-3: present after the correction ' || d::text);
  d := neo_hrt.regday(r, neo_hrt.email('tech'), neo_hrt.d(-2));
  perform neo_hrt.assert(d ->> 'status' = 'leave' and (d ->> 'leave_units')::numeric = 1 and d ->> 'duty' = 'leave', 'd-2: leave ' || d::text);
  d := neo_hrt.regday(r, neo_hrt.email('tech'), neo_hrt.d(-1));
  perform neo_hrt.assert(d ->> 'status' = 'off', 'd-1: roster off ' || d::text);
  d := neo_hrt.regday(r, neo_hrt.email('tech'), neo_hrt.d(0));
  perform neo_hrt.assert(d ->> 'status' = case when ((now() - interval '1 hour') at time zone 'Asia/Kolkata')::date = v_today then 'open' else neo_hrt.idle_status() end,
                         'today: open (or, before 01:00, the open session is yesterday''s) ' || d::text);
  -- someone else's day, as an approver: with clock marks
  d := public.hr_my_day(neo_hrt.d(-6), neo_hrt.email('tech'));
  perform neo_hrt.assert(d -> 'events' -> 0 ->> 'clock_mark' = '⏱ time not verified' and not (d ? 'tracking') and not (d ? 'viewed_by'),
                         'approver view: "⏱ time not verified" on device-time punches; no tracking / viewed_by ' || d::text);
  -- the whole team, and the limits
  r := public.hr_register(neo_hrt.d(-1), neo_hrt.d(0));
  perform neo_hrt.assert(neo_hrt.person(r, neo_hrt.email('walk')) is not null and neo_hrt.person(r, neo_hrt.email('guest')) is null,
                         'register for everyone: active staff only');
  r := public.hr_register(neo_hrt.d(0), neo_hrt.d(5), neo_hrt.email('tech'));
  perform neo_hrt.assert(jsonb_array_length(neo_hrt.person(r, neo_hrt.email('tech')) -> 'days') = 1, 'register: days after today are not returned');
  perform neo_hrt.expect_error(format('select public.hr_register(%L, %L)', neo_hrt.d(0), neo_hrt.d(-1)),
                               '%NEO_GATE: The end date is before the start date.%');
  perform neo_hrt.expect_error(format('select public.hr_register(%L, %L)', neo_hrt.d(-62), neo_hrt.d(0)),
                               '%NEO_GATE: Ask for at most 62 days at a time.%');
  perform neo_hrt.expect_error(format('select public.hr_register(%L, %L, %L)', neo_hrt.d(0), neo_hrt.d(0), 'nobody@neotokyo.test'),
                               '%NEO_GATE: There is no staff account with that email.%');
  perform neo_hrt.expect_error(format('select public.hr_my_day(%L, %L)', neo_hrt.d(0), 'nobody@neotokyo.test'),
                               '%NEO_GATE: There is no staff account with that email.%');
end $$;

select neo_hrt.login('plain');
do $$
begin
  perform neo_hrt.expect_error($q$select public.hr_register(null, null)$q$, '%NEO_DENIED: Only a head or a NeoHR lead can see the team''s attendance.%');
  perform neo_hrt.expect_error($q$select public.hr_board()$q$, '%NEO_DENIED: Only a head or a NeoHR lead can see the team''s attendance.%');
  perform neo_hrt.expect_error(format('select public.hr_correct(%L, %L::jsonb)', neo_hrt.email('tech'), '{"action":"add"}'),
                               '%NEO_DENIED: Only a head or a NeoHR lead can correct attendance.%');
end $$;

-- My month: the totals are the sum of the days.
select neo_hrt.login('tech');
do $$
declare r jsonb; t jsonb;
begin
  r := public.hr_my_month(neo_hrt.d(-6));
  t := r -> 'totals';
  perform neo_hrt.assert((r ->> 'month')::date = date_trunc('month', neo_hrt.d(-6))::date
                         and jsonb_array_length(r -> 'days') = least((date_trunc('month', neo_hrt.d(-6)) + interval '1 month')::date - 1, neo_hrt.today())
                                                               - date_trunc('month', neo_hrt.d(-6))::date + 1,
                         'my month: every day from the 1st to today (or the month''s end) ' || (r -> 'month')::text);
  perform neo_hrt.assert((t ->> 'late')::int = (select count(*) from jsonb_array_elements(r -> 'days') d where d.value ->> 'status' = 'late')
                         and (t ->> 'absent')::numeric = (select coalesce(sum((d.value ->> 'absent_units')::numeric), 0) from jsonb_array_elements(r -> 'days') d)
                         and (t ->> 'leave')::numeric = (select coalesce(sum((d.value ->> 'leave_units')::numeric), 0) from jsonb_array_elements(r -> 'days') d)
                         and (t ->> 'km')::numeric = (select coalesce(sum((d.value ->> 'km')::numeric), 0) from jsonb_array_elements(r -> 'days') d)
                         and t ?& array['present', 'late', 'half_day', 'absent', 'leave', 'off', 'worked_hours', 'km', 'ta']
                         and (t -> 'ta') ? 'rate' and (t -> 'ta') ? 'amount' and (t -> 'ta') ? 'approved',
                         'my month totals ' || t::text);
  perform neo_hrt.assert((t ->> 'late')::int >= 1 and (t ->> 'leave')::numeric >= case when neo_hrt.d(-2) >= date_trunc('month', neo_hrt.d(-6))::date then 1 else 0 end,
                         'my month counts the late day and the leave');
  r := public.hr_my_month(neo_hrt.d(40));
  perform neo_hrt.assert(jsonb_array_length(r -> 'days') = 0, 'a month in the future has no days yet');
  r := public.hr_my_month();
  perform neo_hrt.assert((r ->> 'month')::date = date_trunc('month', (now() at time zone 'Asia/Kolkata')::date)::date, 'my month defaults to this month in India');
end $$;

-- Shift history (§9.4.6): a change from tomorrow leaves the past alone.
select neo_hrt.login('owner');
do $$
declare r jsonb; c record;
begin
  r := public.hr_person_set(neo_hrt.email('tech'), jsonb_build_object('shift_start', '10:30', 'shift_end', '19:30'));
  perform neo_hrt.assert(r ->> 'ok' = 'true' and (r ->> 'effective_from')::date = neo_hrt.d(1)
                         and r -> 'person' ->> 'shift_start' is null and r -> 'person' ->> 'shift_end' is null
                         and exists (select 1 from public.hr_shift_history h where h.profile_id = neo_hrt.uid('tech')
                                        and h.effective_from = neo_hrt.d(1) and h.shift_start = '10:30' and h.shift_end = '19:30'),
                         'a person''s shift change applies from tomorrow by default; today''s display copy stays empty (no own row in force today) ' || r::text);
  perform neo_hrt.expect_error(format('select public.hr_person_set(%L, %L::jsonb)', neo_hrt.email('tech'),
                                      jsonb_build_object('shift_start', '11:00', 'effective_from', neo_hrt.d(-1))),
                               '%NEO_GATE: Changes apply from today onwards.%');
  -- a key given as null stores null: that day falls back to the default
  perform public.hr_person_set(neo_hrt.email('tech'), jsonb_build_object('shift_start', null, 'shift_end', null, 'effective_from', neo_hrt.d(3)));
end $$;
reset role;
select neo_hrt.no_jwt();
do $$
declare c record; d jsonb;
begin
  select * into c from public._hr_ctx(neo_hrt.uid('tech'), neo_hrt.email('tech'), neo_hrt.d(0), neo_hrt.d(0));
  perform neo_hrt.assert(c.shift_start = '09:30', 'today still has the default shift');
  select * into c from public._hr_ctx(neo_hrt.uid('tech'), neo_hrt.email('tech'), neo_hrt.d(1), neo_hrt.d(1));
  perform neo_hrt.assert(c.shift_start = '10:30' and c.shift_end = '19:30' and c.grace_min = 10, 'tomorrow: the person''s row, the rest default');
  select * into c from public._hr_ctx(neo_hrt.uid('tech'), neo_hrt.email('tech'), neo_hrt.d(3), neo_hrt.d(3));
  perform neo_hrt.assert(c.shift_start = '09:30' and c.shift_end = '18:30', 'a null field falls back to the default row');
  d := public._hr_days(neo_hrt.email('tech'), neo_hrt.d(-6), neo_hrt.d(-6), now()) -> 0;
  perform neo_hrt.assert(d ->> 'status' = 'late' and (d ->> 'late_min')::int = 15 and d -> 'shift' ->> 'start' = '09:30',
                         'yesterday''s late marks are unchanged by a change effective tomorrow ' || d::text);
  perform neo_hrt.assert((select shift_start from public.hr_person where profile_id = neo_hrt.uid('tech')) is null
                         and (select shift_end from public.hr_person where profile_id = neo_hrt.uid('tech')) is null,
                         'hr_person''s display copy is the row in force today (none yet), not the d+1 or d+3 row');
end $$;

-- §9.3.1 — the display copies (hr_settings for the default, hr_person for a person) are the
-- history row IN FORCE TODAY (India), not the newest one: a row dated today shows at once, a
-- future-dated row does not (in a subtransaction: nothing is kept).
select neo_hrt.login('owner');
do $$
declare v text; r jsonb; s public.hr_settings; hp public.hr_person;
begin
  begin
    -- a person: a row from today, then a future-dated one
    r := public.hr_person_set(neo_hrt.email('tech'), jsonb_build_object('shift_start', '08:00', 'shift_end', '17:00',
                                                                        'weekly_off', jsonb_build_array(6), 'effective_from', neo_hrt.d(0)));
    perform neo_hrt.assert(r -> 'person' ->> 'shift_start' = '08:00' and r -> 'person' ->> 'shift_end' = '17:00'
                           and r -> 'person' -> 'weekly_off' = '[6]'::jsonb,
                           'a person''s row from today is the display copy at once ' || r::text);
    r := public.hr_person_set(neo_hrt.email('tech'), jsonb_build_object('shift_start', '11:00', 'shift_end', '20:00',
                                                                        'weekly_off', jsonb_build_array(0), 'effective_from', neo_hrt.d(5)));
    select * into hp from public.hr_person where profile_id = neo_hrt.uid('tech');
    perform neo_hrt.assert(r -> 'person' ->> 'shift_start' = '08:00' and r -> 'person' ->> 'shift_end' = '17:00'
                           and r -> 'person' -> 'weekly_off' = '[6]'::jsonb
                           and hp.shift_start = '08:00' and hp.shift_end = '17:00' and hp.weekly_off = '{6}'
                           and exists (select 1 from public.hr_shift_history h where h.profile_id = neo_hrt.uid('tech')
                                          and h.effective_from = neo_hrt.d(5) and h.shift_start = '11:00'),
                           'a future-dated person row leaves today''s display copy alone ' || r::text);
    -- the default: a row from today, then a future-dated one
    r := public.hr_settings_set(jsonb_build_object('grace_min', 12, 'half_day_min', 250, 'effective_from', neo_hrt.d(0)));
    perform neo_hrt.assert((r ->> 'grace_min')::int = 12 and (r ->> 'half_day_min')::int = 250,
                           'a default row from today is the display copy at once ' || r::text);
    r := public.hr_settings_set(jsonb_build_object('grace_min', 25, 'half_day_min', 300, 'weekly_off', jsonb_build_array(0, 6),
                                                   'effective_from', neo_hrt.d(6)));
    select * into s from public.hr_settings where id = 1;
    perform neo_hrt.assert((r ->> 'grace_min')::int = 12 and (r ->> 'half_day_min')::int = 250 and r -> 'weekly_off' = '[]'::jsonb
                           and s.grace_min = 12 and s.half_day_min = 250 and s.weekly_off = '{}'
                           and s.shift_start = '09:30' and s.shift_end = '18:30'
                           and exists (select 1 from jsonb_array_elements(r -> 'history') h
                                        where (h.value ->> 'effective_from')::date = neo_hrt.d(6) and (h.value ->> 'grace_min')::int = 25),
                           'a future-dated default row leaves today''s display copy alone (it is in the history) ' || r::text);
    -- …and the person's copy is still their row in force today
    perform neo_hrt.assert((select shift_start from public.hr_person where profile_id = neo_hrt.uid('tech')) = '08:00',
                           'a default change leaves a person''s display copy alone');
    raise exception 'rollback:ok';
  exception when others then v := sqlerrm;
  end;
  perform neo_hrt.assert(v = 'rollback:ok', 'display copies: ' || v);
end $$;


-- ── 7. location_push (§9.4.7) ────────────────────────────────────────────────
-- brk: on duty 3 h ago, a break 2 h → 1 h ago, on duty since (all server-anchored)
select neo_hrt.login('brk');
do $$
declare r jsonb; v_ids uuid[] := array(select gen_random_uuid() from generate_series(1, 9)); e public.location_points;
begin
  perform neo_hrt.punch('punch_in', now(), null, 10800000);
  perform neo_hrt.punch('break_start', now(), null, 7200000);
  perform neo_hrt.punch('break_end', now(), null, 3600000);
  r := public.location_push(jsonb_build_array(
    neo_hrt.pt(now(), 10.0100, 76.3400, 10, v_ids[1], 9000000),     -- 2.5 h ago: on duty
    neo_hrt.pt(now(), 10.0101, 76.3401, 10, v_ids[2], 7200000),     -- AT the break_start: no tolerance
    neo_hrt.pt(now(), 10.0102, 76.3402, 10, v_ids[3], 5400000),     -- in the break
    neo_hrt.pt(now(), 10.0103, 76.3403, 10, v_ids[4], 3630000),     -- 30 s before the break_end: stored at it
    neo_hrt.pt(now(), 10.0104, 76.3404, 10, v_ids[5], 3690000),     -- 90 s before the break_end: on break
    neo_hrt.pt(now(), 10.0105, 76.3405, 10, v_ids[6], 1800000),     -- on duty again
    neo_hrt.pt(now(), 10.0106, 76.3406, 10, v_ids[7], 14400000),    -- before the punch_in: off duty
    neo_hrt.pt(now(), 10.0107, 76.3407, 10, v_ids[8], 10830000),    -- 30 s before the punch_in: stored at it
    neo_hrt.pt(now(), 10.0105, 76.3405, 10, v_ids[6], 1700000)));   -- the same id twice: once
  perform neo_hrt.assert((r ->> 'accepted')::int = 5 and jsonb_array_length(r -> 'rejected') = 4
                         and neo_hrt.reason(r, v_ids[2]::text) = 'on_break' and neo_hrt.reason(r, v_ids[3]::text) = 'on_break'
                         and neo_hrt.reason(r, v_ids[5]::text) = 'on_break' and neo_hrt.reason(r, v_ids[7]::text) = 'off_duty',
                         'S4: on duty only, one-sided 60 s tolerance before punch_in / break_end ' || r::text);
  perform neo_hrt.assert(neo_hrt.keys(r) = array['accepted', 'rejected'], 'location_push keys');
  perform neo_hrt.put('brk_ids', array_to_string(v_ids, ','));
end $$;
reset role;
select neo_hrt.no_jwt();
do $$
declare v_ids uuid[]; e public.location_points;
begin
  v_ids := string_to_array(neo_hrt.get('brk_ids'), ',')::uuid[];
  select * into e from public.location_points where client_point_id = v_ids[4];
  perform neo_hrt.assert(e.at = now() - interval '1 hour' and e.device_at = now() and e.time_source = 'server',
                         'a point 30 s before the break_end is stored at the break_end (device_at kept)');
  select * into e from public.location_points where client_point_id = v_ids[8];
  perform neo_hrt.assert(e.at = now() - interval '3 hours', 'a point 30 s before the punch_in is stored at the punch_in');
  select * into e from public.location_points where client_point_id = v_ids[1];
  perform neo_hrt.assert(e.at = now() - interval '9000 seconds' and e.employee_email = neo_hrt.email('brk') and e.profile_id = neo_hrt.uid('brk')
                         and e.accuracy_m = 10, 'an accepted point as sent');
  perform neo_hrt.assert((select count(*) from public.location_points where client_point_id = v_ids[6]) = 1
                         and (select at from public.location_points where client_point_id = v_ids[6]) = now() - interval '30 minutes',
                         'a repeated id in one batch is stored once (the first)');
end $$;

select neo_hrt.login('brk');
do $$
declare r jsonb; v_ids uuid[] := string_to_array(neo_hrt.get('brk_ids'), ',')::uuid[];
begin
  -- own duplicates are accepted and not listed
  r := public.location_push(jsonb_build_array(neo_hrt.pt(now(), 10.01, 76.34, 10, v_ids[1], 9000000)));
  perform neo_hrt.assert((r ->> 'accepted')::int = 1 and jsonb_array_length(r -> 'rejected') = 0, 'an own duplicate counts as accepted ' || r::text);
  -- invalid items, the clock window
  r := public.location_push(jsonb_build_array(
    jsonb_build_object('id', 'not-a-uuid', 'at', now(), 'lat', 10, 'lng', 76),
    jsonb_build_object('id', gen_random_uuid(), 'at', '2026-13-01T00:00:00Z', 'lat', 10, 'lng', 76),
    jsonb_build_object('id', gen_random_uuid(), 'at', '2026-02-30T00:00:00Z', 'lat', 10, 'lng', 76),
    jsonb_build_object('id', 'b0000000-0000-4000-8000-000000000001', 'at', now(), 'lat', 91, 'lng', 76),
    jsonb_build_object('id', 'b0000000-0000-4000-8000-000000000002', 'at', now(), 'lat', 10, 'lng', 'east'),
    jsonb_build_object('id', 'b0000000-0000-4000-8000-000000000003', 'at', now(), 'lat', 10, 'lng', 76, 'accuracy_m', -1),
    jsonb_build_object('id', 'b0000000-0000-4000-8000-000000000004', 'at', '2019-12-31T23:00:00Z', 'lat', 10, 'lng', 76),
    jsonb_build_object('id', 'b0000000-0000-4000-8000-000000000005', 'at', now() + interval '1 hour', 'lat', 10, 'lng', 76),
    jsonb_build_object('id', 'b0000000-0000-4000-8000-000000000006', 'at', '2019-12-31T23:00:00Z', 'age_ms', 60000, 'lat', 10.0108, 'lng', 76.3408),
    jsonb_build_object('id', 'b0000000-0000-4000-8000-000000000007', 'at', '2026-10-22T10:00:00+16:00', 'lat', 10, 'lng', 76),
    jsonb_build_object('id', 'b0000000-0000-4000-8000-000000000008', 'at', '2026-10-22T10:00:00+23:59', 'lat', 10, 'lng', 76),
    '{"id": "b0000000-0000-4000-8000-000000000009", "at": "2026-10-22T10:00:00Z", "lat": 10, "lng": 76, "accuracy_m": 1e-400}'::jsonb,
    to_jsonb(5)));
  perform neo_hrt.assert((r ->> 'accepted')::int = 1
                         and neo_hrt.reason(r, 'not-a-uuid') = 'invalid'
                         and neo_hrt.reason(r, 'b0000000-0000-4000-8000-000000000001') = 'invalid'
                         and neo_hrt.reason(r, 'b0000000-0000-4000-8000-000000000002') = 'invalid'
                         and neo_hrt.reason(r, 'b0000000-0000-4000-8000-000000000003') = 'invalid'
                         and neo_hrt.reason(r, 'b0000000-0000-4000-8000-000000000004') = 'clock'
                         and neo_hrt.reason(r, 'b0000000-0000-4000-8000-000000000005') = 'clock'
                         and neo_hrt.reason(r, 'b0000000-0000-4000-8000-000000000007') = 'invalid'
                         and neo_hrt.reason(r, 'b0000000-0000-4000-8000-000000000008') = 'invalid'
                         and neo_hrt.reason(r, 'b0000000-0000-4000-8000-000000000009') = 'invalid'
                         and (select count(*) from jsonb_array_elements(r -> 'rejected') x where x.value ->> 'reason' = 'invalid') = 10,
                         'invalid (uuid, date, Feb 30, lat range, a word, accuracy < 0, an offset past ±15:59 ×2, a number that would '
                         || 'underflow, not an object) and clock — none of them fails the batch; an anchored point ignores a wrong clock '
                         || r::text);
  -- the phone's numbers as kotlinx writes them: a Float accuracy widened to Double has 16–17 decimals
  r := public.location_push(
    ('[{"id": "b0000000-0000-4000-8000-00000000000a", "at": "2026-10-22T10:00:00+05:30", "age_ms": 2400000, "lat": 10.015912345678901, '
     || '"lng": 76.34191234567890, "accuracy_m": 3.9000000953674316, "speed_mps": 1.2345678901234567, "bearing": 91.12345678901234},'
     || '{"id": "b0000000-0000-4000-8000-00000000000b", "at": "2026-10-22T10:00:00+05:30", "age_ms": 2300000, "lat": 10.0161, '
     || '"lng": 76.3421, "accuracy_m": 2.9186787605285645, "speed_mps": 2.9186787605285645E-7}]')::jsonb);
  perform neo_hrt.assert((r ->> 'accepted')::int = 2 and jsonb_array_length(r -> 'rejected') = 0,
                         'accuracy, latitude, speed with 16–17 decimals are accepted ' || r::text);
  perform neo_hrt.put('brk_long', 'b0000000-0000-4000-8000-00000000000a');
  perform neo_hrt.expect_error($q$select public.location_push('{"id":1}'::jsonb)$q$, '%NEO_GATE: Send a list of points.%');
  perform neo_hrt.expect_error($q$select public.location_push(null)$q$, '%NEO_GATE: Send a list of points.%');
  perform neo_hrt.expect_error(format('select public.location_push(%L::jsonb)',
                                      (select jsonb_agg(neo_hrt.pt(now(), 10, 76, 10, null, 1000)) from generate_series(1, 501))),
                               '%NEO_GATE: Send at most 500 points at a time.%');
  r := public.location_push('[]'::jsonb);
  perform neo_hrt.assert(r = '{"accepted": 0, "rejected": []}'::jsonb, 'an empty list: nothing to do');
end $$;
reset role;
select neo_hrt.no_jwt();
do $$
declare e public.location_points;
begin
  select * into e from public.location_points where client_point_id = neo_hrt.get('brk_long')::uuid;
  perform neo_hrt.assert(e.accuracy_m = 3.9000000953674316::float8 and e.lat = 10.015912345678901::float8
                         and e.speed_mps = 1.2345678901234567::float8 and e.bearing = 91.12345678901234::float8,
                         'the long numbers are stored as sent ' || row_to_json(e)::text);
  perform neo_hrt.assert((select speed_mps from public.location_points where client_point_id = 'b0000000-0000-4000-8000-00000000000b')
                         = 2.9186787605285645e-7::float8, 'a small speed with an exponent is stored');
end $$;

-- not_yours: someone else's id
select neo_hrt.login('tech');
do $$
declare r jsonb; v_ids uuid[] := string_to_array(neo_hrt.get('brk_ids'), ',')::uuid[];
begin
  r := public.location_push(jsonb_build_array(neo_hrt.pt(now(), 10.01, 76.34, 10, v_ids[1], 60000)));
  perform neo_hrt.assert((r ->> 'accepted')::int = 0 and neo_hrt.reason(r, v_ids[1]::text) = 'not_yours', 'an id of someone else''s ' || r::text);
end $$;


-- ── 8. The tracking object (§9.4.4) ──────────────────────────────────────────
select neo_hrt.login('tech');
do $$
declare r jsonb; v_in timestamptz := now() - interval '1 hour'; v_d date := ((now() - interval '1 hour') at time zone 'Asia/Kolkata')::date;
        v_end timestamptz;
begin
  r := public.hr_settings_get() -> 'me' -> 'tracking';
  v_end := (v_d + time '18:30') at time zone 'Asia/Kolkata';
  perform neo_hrt.assert(neo_hrt.keys(r) = array['cap_at', 'distance_m', 'enabled', 'interval_s', 'pause_at', 'reason', 'remind_out_at', 'session_start'],
                         'tracking keys ' || r::text);
  perform neo_hrt.assert(r ->> 'enabled' = 'true' and r ->> 'reason' is null and (r ->> 'interval_s')::int = 120 and (r ->> 'distance_m')::int = 100
                         and (r ->> 'session_start')::timestamptz = v_in and (r ->> 'cap_at')::timestamptz = v_in + interval '16 hours'
                         and (r ->> 'pause_at')::timestamptz = least(v_in + interval '16 hours', greatest(v_end, v_in) + interval '4 hours')
                         and (r ->> 'remind_out_at')::timestamptz is not distinct from
                             case when v_in < v_end + interval '30 minutes' then v_end + interval '30 minutes' end,
                         'tracking: on duty ' || r::text);
end $$;
select neo_hrt.login('brk');
do $$
declare r jsonb;
begin
  perform neo_hrt.punch('break_start', now(), null, 600000);
  r := public.hr_dashboard() -> 'me' -> 'tracking';
  perform neo_hrt.assert(r ->> 'enabled' = 'false' and r ->> 'reason' = 'on_break' and r ->> 'session_start' is not null,
                         'tracking: on a break ' || r::text);
end $$;
select neo_hrt.login('sales');
do $$
declare r jsonb;
begin
  r := public.hr_settings_get();
  perform neo_hrt.assert(r -> 'me' -> 'tracking' ->> 'reason' = 'off_duty' and r -> 'me' -> 'tracking' ->> 'session_start' is null
                         and r -> 'me' -> 'tracking' ->> 'cap_at' is null and r -> 'me' -> 'shift' ->> 'start' = '09:30'
                         and r -> 'me' ->> 'attendance_required' = 'true' and r -> 'me' ->> 'ta_eligible' = 'true'
                         and not (r ? 'people') and r ? 'history' and (r ->> 'max_session_h')::int = 16,
                         'hr_settings_get for any staff: me, no people ' || r::text);
end $$;
-- wfh on the session's day, then route recording switched off for the person
select neo_hrt.login('lead');
select public.hr_roster_set(neo_hrt.email('tech'), ((now() - interval '1 hour') at time zone 'Asia/Kolkata')::date, 'wfh', null);
select neo_hrt.login('tech');
do $$
declare r jsonb; v_id uuid := gen_random_uuid();
begin
  r := public.hr_dashboard() -> 'me' -> 'tracking';
  perform neo_hrt.assert(r ->> 'enabled' = 'false' and r ->> 'reason' = 'wfh', 'tracking: work from home ' || r::text);
  r := public.location_push(jsonb_build_array(neo_hrt.pt(now(), 10.01, 76.34, 10, v_id, 60000)));
  perform neo_hrt.assert(neo_hrt.reason(r, v_id::text) = 'wfh', 'location_push: wfh ' || r::text);
end $$;
select neo_hrt.login('lead');
select public.hr_roster_set(neo_hrt.email('tech'), ((now() - interval '1 hour') at time zone 'Asia/Kolkata')::date,
                            case when ((now() - interval '1 hour') at time zone 'Asia/Kolkata')::date = neo_hrt.d(-1) then 'off' end, null);
select neo_hrt.login('owner');
select public.hr_person_set(neo_hrt.email('tech'), '{"track_location": false}'::jsonb);
select neo_hrt.login('tech');
do $$
declare r jsonb; v_id uuid := gen_random_uuid();
begin
  r := public.hr_dashboard() -> 'me' -> 'tracking';
  perform neo_hrt.assert(r ->> 'enabled' = 'false' and r ->> 'reason' = 'disabled', 'tracking: switched off for the person ' || r::text);
  r := public.location_push(jsonb_build_array(neo_hrt.pt(now(), 10.01, 76.34, 10, v_id, 60000)));
  perform neo_hrt.assert(neo_hrt.reason(r, v_id::text) = 'disabled', 'location_push: disabled ' || r::text);
end $$;
select neo_hrt.login('owner');
select public.hr_person_set(neo_hrt.email('tech'), '{"track_location": true}'::jsonb);


-- ── 9. Visits, on site, the board, the dashboard (§9.6.6, §9.9.2) ────────────
reset role;
select neo_hrt.no_jwt();
select set_config('neo.migrating', '1', true);
insert into public.service_jobs (id, public_code, model_version, service_type, stage, stage_since, customer_name, customer_phone,
                                 device_label, category, assignee, assignee_email, assigned_via, assigned_at, site_address, site_area)
values ('s_hrt_j1', 'NT-HRTJ0001', 2, 'on_site', 'scheduled', now(), 'Zqhr Customer One', '9000000901', 'Zq Office Router', 'networking',
        'Zqhr Tech', 'zq.hr.tech@neotokyo.test', 'claim', now(), '1 Zq Road', 'Zqarea One'),
       ('s_hrt_j2', 'NT-HRTJ0002', 2, 'on_site', 'en_route', now(), 'Zqhr Customer Two', '9000000902', null, 'networking',
        'Zqhr Tech', 'zq.hr.tech@neotokyo.test', 'claim', now(), '2 Zq Road', 'Zqarea Two');
select set_config('neo.migrating', '', true);

select neo_hrt.login('tech');
do $$
declare r jsonb; v jsonb;
begin
  -- a visit on d-6 (inside that day's session): left 11:00, arrived 11:20, finished 12:05
  perform public.record_field_activity(jsonb_build_object('client_request_id', gen_random_uuid(), 'kind', 'left_base', 'ref_type', 'service_job',
                                                          'ref_id', 's_hrt_j1', 'at', neo_hrt.at(-6, '11:00'), 'source', 'neohr'));
  perform public.record_field_activity(jsonb_build_object('client_request_id', gen_random_uuid(), 'kind', 'arrived', 'ref_type', 'service_job',
                                                          'ref_id', 's_hrt_j1', 'at', neo_hrt.at(-6, '11:20'), 'source', 'neohr'));
  perform public.record_field_activity(jsonb_build_object('client_request_id', gen_random_uuid(), 'kind', 'departed', 'outcome', 'done',
                                                          'ref_type', 'service_job', 'ref_id', 's_hrt_j1', 'at', neo_hrt.at(-6, '12:05'), 'source', 'neohr'));
  r := public.hr_my_day(neo_hrt.d(-6));
  v := r -> 'visits' -> 0;
  perform neo_hrt.assert(jsonb_array_length(r -> 'visits') = 1 and v ->> 'job_id' = 's_hrt_j1' and v ->> 'code' = 'NT-HRTJ0001'
                         and v ->> 'title' = 'Zq Office Router' and (v ->> 'minutes')::int = 45 and (v ->> 'travel_min')::int = 20
                         and v ->> 'outcome' = 'done' and v ->> 'assumed_arrival' = 'false' and v ->> 'open' = 'false'
                         and (v ->> 'arrived')::timestamptz = neo_hrt.at(-6, '11:20'),
                         'a visit: arrived → departed, minutes on site, travel from left_base ' || r::text);
  perform neo_hrt.assert(neo_hrt.keys(v) @> array['arrived', 'assumed_arrival', 'code', 'departed', 'job_id', 'minutes', 'open', 'outcome',
                                                  'title', 'travel_min'], 'visit keys ' || v::text);
  -- now: arrived at the second job → on site
  perform public.record_field_activity(jsonb_build_object('client_request_id', gen_random_uuid(), 'kind', 'arrived', 'ref_type', 'service_job',
                                                          'ref_id', 's_hrt_j2', 'at', now(), 'source', 'neohr'));
  r := public.hr_my_day(((now() - interval '1 hour') at time zone 'Asia/Kolkata')::date);
  v := (select x.value from jsonb_array_elements(r -> 'visits') x where x.value ->> 'job_id' = 's_hrt_j2');
  perform neo_hrt.assert(v ->> 'open' = 'true' and v ->> 'departed' is null and (v ->> 'minutes')::int = 0
                         and v ->> 'title' = 'Networking', 'an open visit (no departed yet); title falls back to the category ' || coalesce(v::text, r::text));
end $$;

select neo_hrt.login('lead');
do $$
declare r jsonb; p jsonb; c jsonb; v_idle text := neo_hrt.idle_status();
begin
  r := public.hr_board();
  p := neo_hrt.person(r, neo_hrt.email('tech'));
  perform neo_hrt.assert(p ->> 'status' = 'on_site' and p -> 'on_site' ->> 'code' = 'NT-HRTJ0002' and (p ->> 'since')::timestamptz = now()
                         and p ->> 'stale' = 'true' and p ? 'last_point_at',
                         'board: on site (assignee, arrived since the punch_in, no departed); stale: no point in the session for 15 min ' || p::text);
  perform neo_hrt.assert(not (p ? 'lat') and not (p ? 'lng') and not (p::text like '%10.01%'), 'board: no coordinates');
  p := neo_hrt.person(r, neo_hrt.email('brk'));
  perform neo_hrt.assert(p ->> 'status' = 'on_break' and (p ->> 'since')::timestamptz = now() - interval '10 minutes' and p ->> 'stale' = 'false',
                         'board: on a break ' || p::text);
  p := neo_hrt.person(r, neo_hrt.email('idle'));
  perform neo_hrt.assert(p ->> 'status' = v_idle and p ->> 'since' is null, 'board: no punch today → ' || v_idle || ' ' || p::text);
  perform neo_hrt.assert(neo_hrt.person(r, neo_hrt.email('guest')) is null, 'board: active staff only');
  perform neo_hrt.assert(p ?& array['email', 'name', 'designation', 'status', 'since', 'duty', 'shift', 'first_in', 'worked_min', 'on_site',
                                    'last_point_at', 'stale', 'pending_requests'], 'board row keys ' || p::text);
  c := r -> 'counts';
  perform neo_hrt.assert((c ->> 'on_site')::int >= 1 and (c ->> 'on_break')::int >= 1, 'board counts ' || c::text);
end $$;

-- the technician leaves the site: on duty again; a fresh point clears "stale"
select neo_hrt.login('tech');
do $$
declare r jsonb;
begin
  perform public.record_field_activity(jsonb_build_object('client_request_id', gen_random_uuid(), 'kind', 'departed', 'outcome', 'revisit_needed',
                                                          'ref_type', 'service_job', 'ref_id', 's_hrt_j2', 'at', now(), 'source', 'neohr'));
  r := public.location_push(jsonb_build_array(neo_hrt.pt(now(), 10.0150, 76.3410, 10, null, 60000)));
  perform neo_hrt.assert((r ->> 'accepted')::int = 1, 'a point now ' || r::text);
  r := public.hr_dashboard();
  perform neo_hrt.assert(r -> 'me' ->> 'state' = 'on_duty' and (r -> 'me' ->> 'since')::timestamptz = now() - interval '1 hour'
                         and not (r ? 'hr') and r ? 'now'
                         and (r -> 'me') ?& array['break_min', 'flex', 'km', 'late_min', 'missed_out', 'since', 'state', 'tracking', 'worked_min'],
                         'hr_dashboard for staff: me only ' || r::text);
end $$;

-- a job still at on_site whose arrival came before this session is not "on site"
reset role;
select neo_hrt.no_jwt();
select set_config('neo.migrating', '1', true);
insert into public.service_jobs (id, public_code, model_version, service_type, stage, stage_since, customer_name, customer_phone,
                                 device_label, category, assignee, assignee_email, assigned_via, assigned_at, site_address, site_area)
values ('s_hrt_j3', 'NT-HRTJ0003', 2, 'on_site', 'on_site', now(), 'Zqhr Customer Three', '9000000903', 'Zq Old Visit', 'networking',
        'Zqhr Tech', 'zq.hr.tech@neotokyo.test', 'claim', now(), '3 Zq Road', 'Zqarea Three');
select set_config('neo.migrating', '', true);
insert into public.field_activity (client_request_id, employee_email, employee_name, module, ref_type, ref_id, kind, at, source, applied, applied_note)
values (gen_random_uuid(), 'zq.hr.tech@neotokyo.test', 'Zqhr Tech', 'service', 'service_job', 's_hrt_j3', 'arrived', neo_hrt.at(-6, '13:00'),
        'neohr', true, 'Moved to On site.');
select neo_hrt.login('lead');
do $$
declare p jsonb := neo_hrt.person(public.hr_board(), neo_hrt.email('tech'));
begin
  perform neo_hrt.assert(p ->> 'status' = 'on_duty' and p -> 'on_site' = 'null'::jsonb and p ->> 'stale' = 'false',
                         'on site needs an arrival since this session''s punch_in; a fresh point clears stale ' || p::text);
end $$;

-- idle's statuses: leave, off, not tracked, off duty
select neo_hrt.login('lead');
select public.hr_roster_set(neo_hrt.email('idle'), neo_hrt.d(0), 'leave', null);
do $$
begin
  perform neo_hrt.assert(neo_hrt.person(public.hr_board(), neo_hrt.email('idle')) ->> 'status' = 'on_leave', 'board: on leave');
  perform public.hr_roster_set(neo_hrt.email('idle'), neo_hrt.d(0), 'off', null);
  perform neo_hrt.assert(neo_hrt.person(public.hr_board(), neo_hrt.email('idle')) ->> 'status' = 'off', 'board: off');
  perform public.hr_roster_set(neo_hrt.email('idle'), neo_hrt.d(0), null, null);
end $$;
select neo_hrt.login('owner');
select public.hr_person_set(neo_hrt.email('idle'), '{"attendance_required": false}'::jsonb);
select neo_hrt.login('lead');
do $$
declare p jsonb;
begin
  p := neo_hrt.person(public.hr_board(), neo_hrt.email('idle'));
  perform neo_hrt.assert(p ->> 'status' = 'not_tracked' and p ->> 'attendance_required' = 'false', 'board: attendance not required → not_tracked ' || p::text);
end $$;
select neo_hrt.login('owner');
select public.hr_person_set(neo_hrt.email('idle'), '{"attendance_required": true}'::jsonb);
select neo_hrt.login('idle');
select neo_hrt.punch('punch_in', now(), null, 1200000);
select neo_hrt.punch('punch_out', now(), null, 600000);
select neo_hrt.login('lead');
do $$
declare r jsonb; p jsonb; v_today boolean := ((now() - interval '20 minutes') at time zone 'Asia/Kolkata')::date = neo_hrt.today();
begin
  r := public.hr_board();
  p := neo_hrt.person(r, neo_hrt.email('idle'));
  perform neo_hrt.assert(p ->> 'status' = case when v_today then 'off_duty' else neo_hrt.idle_status() end
                         and (not v_today or (p ->> 'since')::timestamptz = now() - interval '10 minutes'),
                         'board: a session today that has closed → off_duty since its punch_out ' || p::text);
  -- the dashboard's hr block = the board's counts
  r := public.hr_dashboard();
  perform neo_hrt.assert(r ? 'hr' and (r -> 'hr') ?& array['absent', 'not_in_yet', 'on_break', 'on_duty', 'on_site', 'pending_requests'],
                         'hr_dashboard for an approver: hr ' || r::text);
  p := public.hr_board() -> 'counts';
  perform neo_hrt.assert((r -> 'hr' ->> 'on_duty')::int = coalesce((p ->> 'on_duty')::int, 0)
                         and (r -> 'hr' ->> 'on_break')::int = coalesce((p ->> 'on_break')::int, 0)
                         and (r -> 'hr' ->> 'on_site')::int = coalesce((p ->> 'on_site')::int, 0)
                         and (r -> 'hr' ->> 'absent')::int = coalesce((p ->> 'absent')::int, 0)
                         and (r -> 'hr' ->> 'not_in_yet')::int = coalesce((p ->> 'not_in_yet')::int, 0),
                         'hr_dashboard counts = hr_board counts ' || r::text || ' / ' || p::text);
end $$;


-- ── 10. Requests to HR (§9.6.1–§9.6.3), roster and holidays (§9.6.4, §9.6.8) ─
select neo_hrt.login('flex');
do $$
declare r jsonb; v uuid := gen_random_uuid(); s text;
begin
  perform neo_hrt.punch('punch_in', neo_hrt.at(-3, '09:30'));      -- and no punch_out: missed_out
  s := 'select public.hr_request_create(%L::jsonb)';
  perform neo_hrt.expect_error(format(s, '{}'),
    '%NEO_GATE: Say what you''re telling HR: late start, early leave, flexible day, field day, missed punch or leave.%');
  perform neo_hrt.expect_error($q$select public.hr_request_create(null)$q$, '%NEO_GATE: The request is empty.%');
  perform neo_hrt.expect_error(format(s, jsonb_build_object('kind', 'late_start', 'date_from', neo_hrt.d(0), 'reason', 'no')),
                               '%NEO_GATE: Say why — at least 3 characters.%');
  perform neo_hrt.expect_error(format(s, jsonb_build_object('kind', 'flexible_day', 'date_from', neo_hrt.d(0), 'reason', 'RMA pickup', 'ref_code', 'XX-1')),
                               '%NEO_GATE: A job code looks like NT-7KQ2ACDE or RM-7KQ2PX4D.%');
  perform neo_hrt.expect_error(format(s, jsonb_build_object('kind', 'missed_punch', 'reason', 'Phone died')),
                               '%NEO_GATE: Say which punch you missed: punch in, punch out, break start or break end.%');
  perform neo_hrt.expect_error(format(s, jsonb_build_object('kind', 'missed_punch', 'missed_kind', 'punch_out', 'reason', 'Phone died')),
                               '%NEO_GATE: Say when the missed punch was.%');
  perform neo_hrt.expect_error(format(s, jsonb_build_object('kind', 'missed_punch', 'missed_kind', 'punch_out', 'reason', 'Phone died',
                                                            'missed_at', now() + interval '1 hour')),
                               '%NEO_GATE: The missed punch can''t be in the future.%');
  perform neo_hrt.expect_error(format(s, jsonb_build_object('kind', 'missed_punch', 'missed_kind', 'punch_out', 'reason', 'Phone died',
                                                            'missed_at', neo_hrt.at(-8, '18:00'))),
                               '%NEO_GATE: Tell HR within 7 days of the day.%');
  perform neo_hrt.expect_error(format(s, jsonb_build_object('kind', 'late_start', 'reason', 'Traffic jam')), '%NEO_GATE: Say which day.%');
  perform neo_hrt.expect_error(format(s, jsonb_build_object('kind', 'late_start', 'reason', 'Traffic jam', 'date_from', neo_hrt.d(0), 'date_to', neo_hrt.d(-1))),
                               '%NEO_GATE: The end date is before the start date.%');
  perform neo_hrt.expect_error(format(s, jsonb_build_object('kind', 'field_day', 'reason', 'A long project', 'date_from', neo_hrt.d(0), 'date_to', neo_hrt.d(31))),
                               '%NEO_GATE: Ask for at most 31 days at a time.%');
  perform neo_hrt.expect_error(format(s, jsonb_build_object('kind', 'leave', 'reason', 'Wedding', 'date_from', neo_hrt.d(1))),
                               '%NEO_GATE: Say what kind of leave: casual, sick or other.%');
  perform neo_hrt.expect_error(format(s, jsonb_build_object('kind', 'leave', 'leave_type', 'casual', 'half_day', true, 'reason', 'Bank work',
                                                            'date_from', neo_hrt.d(10), 'date_to', neo_hrt.d(11))),
                               '%NEO_GATE: A half-day leave is for one day.%');
  perform neo_hrt.expect_error(format(s, jsonb_build_object('kind', 'late_start', 'reason', 'Traffic jam', 'date_from', neo_hrt.d(-8))),
                               '%NEO_GATE: Tell HR within 7 days of the day.%');
  perform neo_hrt.expect_error(format(s, jsonb_build_object('kind', 'leave', 'leave_type', 'casual', 'reason', 'Trip', 'date_from', neo_hrt.d(91))),
                               '%NEO_GATE: That''s too far ahead — ask closer to the date.%');
  perform neo_hrt.expect_error(format(s, jsonb_build_object('kind', 'late_start', 'reason', 'Traffic jam', 'date_from', neo_hrt.d(32))),
                               '%NEO_GATE: That''s too far ahead — ask closer to the date.%');
  -- the requests the approvers will act on
  r := public.hr_request_create(jsonb_build_object('kind', 'missed_punch', 'missed_kind', 'punch_out', 'missed_at', neo_hrt.at(-3, '18:00'),
                                                   'reason', 'Phone died at the site', 'ref_code', 'nt-hrtj0001'));
  perform neo_hrt.assert(r -> 'request' ->> 'status' = 'pending' and (r -> 'request' ->> 'date_from')::date = neo_hrt.d(-3)
                         and (r -> 'request' ->> 'date_to')::date = neo_hrt.d(-3) and r -> 'request' ->> 'ref_code' = 'NT-HRTJ0001'
                         and r -> 'request' ->> 'missed_kind' = 'punch_out', 'a missed punch takes its day from missed_at ' || r::text);
  perform neo_hrt.put('f_missed', r -> 'request' ->> 'id');
  r := public.hr_request_create(jsonb_build_object('kind', 'missed_punch', 'missed_kind', 'punch_in', 'missed_at', neo_hrt.at(-3, '10:00'),
                                                   'reason', 'Second punch in'));
  perform neo_hrt.put('f_missed_bad', r -> 'request' ->> 'id');
  r := public.hr_request_create(jsonb_build_object('id', v, 'kind', 'late_start', 'date_from', neo_hrt.d(0), 'reason', 'Bus breakdown'));
  perform neo_hrt.assert(r ->> 'duplicate' = 'false', 'a request with a client id');
  r := public.hr_request_create(jsonb_build_object('id', v, 'kind', 'late_start', 'date_from', neo_hrt.d(0), 'reason', 'Bus breakdown'));
  perform neo_hrt.assert(r ->> 'duplicate' = 'true' and r -> 'request' ->> 'id' = v::text, 'a retry with the same id answers the first ' || r::text);
  perform neo_hrt.put('f_late', v::text);
  r := public.hr_request_create(jsonb_build_object('kind', 'leave', 'leave_type', 'casual', 'date_from', neo_hrt.d(1), 'date_to', neo_hrt.d(4),
                                                   'reason', 'Family function'));
  perform neo_hrt.put('f_leave', r -> 'request' ->> 'id');
  r := public.hr_request_create(jsonb_build_object('kind', 'leave', 'leave_type', 'other', 'date_from', neo_hrt.d(6), 'date_to', neo_hrt.d(7),
                                                   'reason', 'House shifting'));
  perform neo_hrt.put('f_leave2', r -> 'request' ->> 'id');
  perform neo_hrt.expect_error(format(s, jsonb_build_object('kind', 'leave', 'leave_type', 'casual', 'reason', 'Overlap',
                                                            'date_from', neo_hrt.d(7), 'date_to', neo_hrt.d(8))),
                               '%NEO_GATE: You already asked for leave on one of those days.%');
  r := public.hr_request_create(jsonb_build_object('kind', 'leave', 'leave_type', 'sick', 'half_day', true, 'date_from', neo_hrt.d(9),
                                                   'reason', 'Dentist'));
  perform neo_hrt.assert(r -> 'request' ->> 'half_day' = 'true', 'a half-day leave');
  perform neo_hrt.put('f_half', r -> 'request' ->> 'id');
  r := public.hr_request_create(jsonb_build_object('kind', 'field_day', 'date_from', neo_hrt.d(12), 'reason', 'Install at a school'));
  perform neo_hrt.put('f_field', r -> 'request' ->> 'id');
  r := public.hr_request_create(jsonb_build_object('kind', 'early_leave', 'date_from', neo_hrt.d(1), 'reason', 'Parent meeting'));
  perform neo_hrt.put('f_early', r -> 'request' ->> 'id');
end $$;

select neo_hrt.login('plain');
do $$
begin
  perform neo_hrt.expect_error(format('select public.hr_request_create(%L::jsonb)',
                                      jsonb_build_object('id', neo_hrt.get('f_late'), 'kind', 'late_start', 'date_from', neo_hrt.d(0), 'reason', 'Mine')),
                               '%NEO_GATE: That request id is already used.%');
  -- v2.3 said NEO_DENIED: Only a head or a NeoHR lead can approve requests. — v2.4 says it as NEO_GATE
  perform neo_hrt.expect_error(format('select public.hr_request_decide(%L::uuid, true)', neo_hrt.get('f_late')),
                               '%NEO_GATE: Only a head or a NeoHR lead can approve requests.%');
  perform neo_hrt.expect_error(format('select public.hr_request_cancel(%L::uuid, %L)', neo_hrt.get('f_field'), 'no'),
                               '%NEO_DENIED: You can only cancel your own requests.%');
  perform neo_hrt.expect_error($q$select public.hr_requests_list('pending')$q$,
                               '%NEO_DENIED: Only a head or a NeoHR lead can see everyone''s requests.%');
  perform neo_hrt.expect_error($q$select public.hr_requests_list('everything')$q$, '%NEO_GATE: The scope is mine, pending or all.%');
  perform neo_hrt.expect_error(format('select public.hr_roster_set(%L, %L, %L)', neo_hrt.email('flex'), neo_hrt.d(1), 'shop'),
                               '%NEO_DENIED: Only a head or a NeoHR lead can change the roster.%');
  perform neo_hrt.expect_error(format('select public.hr_holiday_set(%L, %L)', neo_hrt.d(2), 'Zq Festival'),
                               '%NEO_DENIED: Only a head or a NeoHR lead can change the roster.%');
end $$;

-- flex's weekly off is d+3 (from today), d+2 is a holiday, d+1 was rostered 'shop' by hand
select neo_hrt.login('owner');
select public.hr_person_set(neo_hrt.email('flex'), jsonb_build_object('weekly_off', jsonb_build_array(extract(dow from neo_hrt.d(3))::int),
                                                                      'effective_from', neo_hrt.d(0)));
select neo_hrt.login('lead');
do $$
declare r jsonb; n int;
begin
  r := public.hr_holiday_set(neo_hrt.d(2), '  Zq Festival  ');
  perform neo_hrt.assert(r = jsonb_build_object('ok', true, 'day', neo_hrt.d(2), 'name', 'Zq Festival'), 'a holiday ' || r::text);
  perform neo_hrt.expect_error(format('select public.hr_holiday_set(%L, %L)', neo_hrt.d(2), 'X'),
                               '%NEO_GATE: A holiday''s name is 2 to 80 characters.%');
  perform neo_hrt.expect_error($q$select public.hr_holiday_set(null, 'Zq Day')$q$, '%NEO_GATE: Say which day.%');
  perform public.hr_holiday_set(neo_hrt.d(20), 'Zq Gone');
  r := public.hr_holiday_set(neo_hrt.d(20), '');
  perform neo_hrt.assert(r ->> 'name' is null and not exists (select 1 from public.hr_holidays where day = neo_hrt.d(20)), 'an empty name deletes the holiday');
  perform public.hr_roster_set(neo_hrt.email('flex'), neo_hrt.d(1), 'shop', 'Counter cover');
  -- decide
  r := public.hr_request_decide(neo_hrt.get('f_missed')::uuid, true, null);
  perform neo_hrt.assert(r ->> 'ok' = 'true' and r -> 'request' ->> 'status' = 'approved', 'approve a missed punch ' || r::text);
  perform neo_hrt.assert(exists (select 1 from neo_hrt.ae e where e.employee_email = neo_hrt.email('flex') and e.kind = 'punch_out'
                                   and e.at = neo_hrt.at(-3, '18:00') and e.source = 'hr' and e.time_source = 'hr' and e.device_at is null
                                   and e.note = 'Phone died at the site' and e.created_by_email = neo_hrt.email('lead')),
                         'the approved missed punch is an hr punch (note = the reason, by the approver)');
  r := public.hr_my_day(neo_hrt.d(-3), neo_hrt.email('flex'));
  perform neo_hrt.assert(r ->> 'missed_out' = 'false' and (r ->> 'last_out')::timestamptz = neo_hrt.at(-3, '18:00') and (r ->> 'worked_min')::int = 510,
                         'the day is whole again ' || r::text);
  perform neo_hrt.expect_error(format('select public.hr_request_decide(%L::uuid, true)', neo_hrt.get('f_missed_bad')),
                               '%NEO_GATE: That punch no longer fits the day — use Correct….%');
  perform neo_hrt.assert((select status from public.hr_requests where id = neo_hrt.get('f_missed_bad')::uuid) = 'pending',
                         'a missed punch that no longer fits stays pending');
  r := public.hr_request_decide(neo_hrt.get('f_missed_bad')::uuid, false, 'Inside your shift');
  perform neo_hrt.assert(r -> 'request' ->> 'status' = 'rejected' and r -> 'request' ->> 'decision_note' = 'Inside your shift', 'reject');
  r := public.hr_request_decide(neo_hrt.get('f_missed_bad')::uuid, true, null);
  perform neo_hrt.assert(r ->> 'ok' = 'false' and r ->> 'reason' = 'decided' and r ->> 'status' = 'rejected' and r ->> 'by' = neo_hrt.name('lead')
                         and r ->> 'at' is not null, 'a second decision answers {ok:false, reason:decided} ' || r::text);
  perform neo_hrt.expect_error(format('select public.hr_request_decide(%L::uuid, null)', neo_hrt.get('f_late')), '%NEO_GATE: Say approve or reject.%');
  perform neo_hrt.expect_error(format('select public.hr_request_decide(%L::uuid, true)', gen_random_uuid()), '%NEO_GATE: That request no longer exists.%');
  perform neo_hrt.expect_error(format('select public.hr_request_cancel(%L::uuid, %L)', gen_random_uuid(), 'x'), '%NEO_GATE: That request no longer exists.%');
  perform neo_hrt.expect_error(format('select public.hr_request_decide(%L::uuid, true, %L)', neo_hrt.get('f_late'), repeat('x', 301)),
                               '%NEO_GATE: The note is too long — keep it under 300 characters.%');
  -- a full-day leave writes the roster for working days only
  r := public.hr_request_decide(neo_hrt.get('f_leave')::uuid, true, null);
  select count(*) into n from public.hr_roster where source_request_id = neo_hrt.get('f_leave')::uuid;
  perform neo_hrt.assert(n = 2
                         and exists (select 1 from public.hr_roster where profile_id = neo_hrt.uid('flex') and day = neo_hrt.d(1) and duty = 'leave'
                                       and note = 'Leave' and source_request_id = neo_hrt.get('f_leave')::uuid)
                         and exists (select 1 from public.hr_roster where profile_id = neo_hrt.uid('flex') and day = neo_hrt.d(4) and duty = 'leave')
                         and not exists (select 1 from public.hr_roster where profile_id = neo_hrt.uid('flex') and day in (neo_hrt.d(2), neo_hrt.d(3))),
                         'leave d+1…d+4: the holiday and the weekly off are skipped, the hand-made shop row is overwritten (' || n || ' rows)');
  -- a half-day leave writes no roster row
  perform public.hr_request_decide(neo_hrt.get('f_half')::uuid, true, null);
  perform neo_hrt.assert(not exists (select 1 from public.hr_roster where profile_id = neo_hrt.uid('flex') and day = neo_hrt.d(9)),
                         'a half-day leave writes no roster row');
  r := public.hr_request_decide(neo_hrt.get('f_field')::uuid, true, null);
  perform neo_hrt.assert(exists (select 1 from public.hr_roster where profile_id = neo_hrt.uid('flex') and day = neo_hrt.d(12) and duty = 'field'
                                   and note = 'Field day' and source_request_id = neo_hrt.get('f_field')::uuid),
                         'a field day writes duty field, note "Field day"');
  perform public.hr_request_decide(neo_hrt.get('f_late')::uuid, true, null);
  -- cancelling as an approver needs a note; an approved missed punch is fixed with Correct…
  perform neo_hrt.expect_error(format('select public.hr_request_cancel(%L::uuid)', neo_hrt.get('f_leave2')), '%NEO_GATE: Say why you''re cancelling it.%');
  r := public.hr_request_cancel(neo_hrt.get('f_leave2')::uuid, 'Shifting postponed');
  perform neo_hrt.assert(r -> 'request' ->> 'status' = 'cancelled' and r -> 'request' ->> 'cancelled_by_name' = neo_hrt.name('lead')
                         and r -> 'request' ->> 'cancel_note' = 'Shifting postponed', 'an approver cancels with a note ' || r::text);
  perform neo_hrt.expect_error(format('select public.hr_request_cancel(%L::uuid, %L)', neo_hrt.get('f_missed'), 'undo'),
                               '%NEO_GATE: Fix an added punch with Correct… instead.%');
  perform neo_hrt.expect_error(format('select public.hr_request_cancel(%L::uuid, %L)', neo_hrt.get('f_early'), repeat('y', 301)),
                               '%NEO_GATE: The note is too long — keep it under 300 characters.%');
  -- the pending list
  r := public.hr_requests_list('pending');
  perform neo_hrt.assert(exists (select 1 from jsonb_array_elements(r -> 'requests') x where x.value ->> 'id' = neo_hrt.get('f_early')
                                   and x.value ->> 'can_decide' = 'true')
                         and not exists (select 1 from jsonb_array_elements(r -> 'requests') x where x.value ->> 'status' <> 'pending'),
                         'pending: everyone''s pending requests, decidable ' || r::text);
  r := public.hr_requests_list('all');
  perform neo_hrt.assert((select count(*) from jsonb_array_elements(r -> 'requests') x where x.value ->> 'email' = neo_hrt.email('flex')) >= 7,
                         'all: everyone''s requests in the range');
end $$;

-- flex's day records from the approved requests
reset role;
select neo_hrt.no_jwt();
do $$
declare d jsonb;
begin
  d := public._hr_days(neo_hrt.email('flex'), neo_hrt.d(9), neo_hrt.d(9), now()) -> 0;
  perform neo_hrt.assert(d ->> 'half_day_leave' = 'true' and d ->> 'flex' = 'true' and d ->> 'status' = 'leave'
                         and (d ->> 'leave_units')::numeric = 0.5 and (d ->> 'absent_units')::numeric = 0,
                         'an approved half-day leave (future, not punched): leave, flex, 0.5 ' || d::text);
  d := public._hr_days(neo_hrt.email('flex'), neo_hrt.d(0), neo_hrt.d(0), now()) -> 0;
  perform neo_hrt.assert(d ->> 'flex' = 'true', 'an approved late start makes today flexible ' || d::text);
  d := public._hr_days(neo_hrt.email('flex'), neo_hrt.d(3), neo_hrt.d(3), now()) -> 0;
  perform neo_hrt.assert(d ->> 'duty' = 'off' and d ->> 'duty_source' = 'weekly_off', 'a weekly off from the person''s shift row ' || d::text);
  d := public._hr_days(neo_hrt.email('flex'), neo_hrt.d(2), neo_hrt.d(2), now()) -> 0;
  perform neo_hrt.assert(d ->> 'duty' = 'off' and d ->> 'duty_source' = 'holiday' and d ->> 'holiday' = 'Zq Festival', 'a holiday ' || d::text);
end $$;

-- the owner cancels an approved leave before it starts: its roster rows go
select neo_hrt.login('flex');
do $$
declare r jsonb;
begin
  r := public.hr_request_cancel(neo_hrt.get('f_leave')::uuid);
  perform neo_hrt.assert(r ->> 'ok' = 'true' and r -> 'request' ->> 'status' = 'cancelled' and r -> 'request' ->> 'cancelled_by_name' = neo_hrt.name('flex'),
                         'the owner cancels an approved leave that has not started ' || r::text);
  perform neo_hrt.assert(not exists (select 1 from public.hr_roster where source_request_id = neo_hrt.get('f_leave')::uuid)
                         and not exists (select 1 from public.hr_roster where profile_id = neo_hrt.uid('flex') and day in (neo_hrt.d(1), neo_hrt.d(4))),
                         'cancelling an approved leave deletes its roster rows');
  r := public.hr_request_cancel(neo_hrt.get('f_leave')::uuid);
  perform neo_hrt.assert(r ->> 'ok' = 'false' and r ->> 'reason' = 'decided' and r ->> 'status' = 'cancelled' and r ->> 'by' = neo_hrt.name('flex'),
                         'cancelled twice ' || r::text);
  r := public.hr_requests_list();
  perform neo_hrt.assert(r ->> 'scope' = 'mine' and (select count(*) from jsonb_array_elements(r -> 'requests') x) >= 7
                         and not exists (select 1 from jsonb_array_elements(r -> 'requests') x where x.value ->> 'email' <> neo_hrt.email('flex')),
                         'mine: only my requests ' || r::text);
  perform neo_hrt.expect_error(format('select public.hr_requests_list(%L, %L, %L)', 'all', neo_hrt.d(0), neo_hrt.d(1)), '%NEO_DENIED%');
  -- the roster: my own week, with holidays
  r := public.hr_roster_get();
  perform neo_hrt.assert(jsonb_array_length(r -> 'people') = 1 and r -> 'people' -> 0 ->> 'email' = neo_hrt.email('flex')
                         and (r ->> 'to')::date - (r ->> 'from')::date = 6 and extract(isodow from (r ->> 'from')::date) = 1,
                         'hr_roster_get: my own week, Monday to Sunday ' || r::text);
  perform neo_hrt.expect_error(format('select public.hr_roster_get(%L, %L, %L)', neo_hrt.d(0), neo_hrt.d(6), neo_hrt.email('tech')),
                               '%NEO_DENIED: Only a head or a NeoHR lead can see someone else''s roster.%');
  perform neo_hrt.expect_error(format('select public.hr_roster_get(%L, %L)', neo_hrt.d(0), neo_hrt.d(62)), '%NEO_GATE: Ask for at most 62 days at a time.%');
  perform neo_hrt.expect_error(format('select public.hr_roster_get(%L, %L)', neo_hrt.d(1), neo_hrt.d(0)), '%NEO_GATE: The end date is before the start date.%');
end $$;

-- a technician's own approved leave that has started: only a head may cancel it
select neo_hrt.login('tech');
do $$
begin
  perform neo_hrt.expect_error(format('select public.hr_request_cancel(%L::uuid)', neo_hrt.get('tech_leave')),
                               '%NEO_GATE: It has already started — ask a head or a NeoHR lead to cancel it.%');
end $$;

-- a stale row clicked: 'decided' names whoever cancelled a cancelled request (not who approved it before)
select neo_hrt.login('lead');
do $$
declare r jsonb;
begin
  r := public.hr_request_decide(neo_hrt.get('f_leave')::uuid, true, null);
  perform neo_hrt.assert(r ->> 'ok' = 'false' and r ->> 'reason' = 'decided' and r ->> 'status' = 'cancelled' and r ->> 'by' = neo_hrt.name('flex')
                         and (r ->> 'at')::timestamptz = (select cancelled_at from public.hr_requests where id = neo_hrt.get('f_leave')::uuid),
                         'approved, then cancelled by its owner: decide answers the canceller ' || r::text);
end $$;
select neo_hrt.login('flex');
do $$
declare r jsonb;
begin
  r := public.hr_request_cancel(neo_hrt.get('f_missed_bad')::uuid);
  perform neo_hrt.assert(r ->> 'ok' = 'false' and r ->> 'status' = 'rejected' and r ->> 'by' = neo_hrt.name('lead'),
                         'a rejected request: cancel answers who rejected it ' || r::text);
end $$;

-- roster and holidays as an approver
select neo_hrt.login('lead');
do $$
declare r jsonb; p jsonb; d jsonb;
begin
  r := public.hr_roster_get(neo_hrt.d(1), neo_hrt.d(12), neo_hrt.email('flex'));
  p := r -> 'people' -> 0;
  perform neo_hrt.assert(jsonb_array_length(r -> 'people') = 1 and jsonb_array_length(p -> 'days') = 12
                         and exists (select 1 from jsonb_array_elements(r -> 'holidays') h where (h.value ->> 'day')::date = neo_hrt.d(2)),
                         'hr_roster_get: one person, 12 days, the holidays ' || r::text);
  d := (select x.value from jsonb_array_elements(p -> 'days') x where (x.value ->> 'day')::date = neo_hrt.d(12));
  perform neo_hrt.assert(d ->> 'duty' = 'field' and d ->> 'source' = 'roster' and d ->> 'note' = 'Field day' and d ->> 'request_id' = neo_hrt.get('f_field'),
                         'a roster row made by a request carries its id ' || d::text);
  r := public.hr_roster_get(neo_hrt.d(0), neo_hrt.d(0));
  perform neo_hrt.assert(jsonb_array_length(r -> 'people') > 5, 'an approver sees everyone''s roster');
  perform neo_hrt.expect_error(format('select public.hr_roster_get(%L, %L, %L)', neo_hrt.d(0), neo_hrt.d(0), 'nobody@neotokyo.test'),
                               '%NEO_GATE: There is no staff account with that email.%');
end $$;
do $$
begin
  perform neo_hrt.expect_error(format('select public.hr_roster_set(%L, %L, %L)', 'nobody@neotokyo.test', neo_hrt.d(1), 'shop'),
                               '%NEO_GATE: There is no active staff account with that email.%');
  perform neo_hrt.expect_error(format('select public.hr_roster_set(%L, %L, %L)', neo_hrt.email('guest'), neo_hrt.d(1), 'shop'),
                               '%NEO_GATE: There is no active staff account with that email.%');
  perform neo_hrt.expect_error(format('select public.hr_roster_set(%L, null, %L)', neo_hrt.email('flex'), 'shop'), '%NEO_GATE: Say which day.%');
  perform neo_hrt.expect_error(format('select public.hr_roster_set(%L, %L, %L)', neo_hrt.email('flex'), neo_hrt.d(400), 'shop'),
                               '%NEO_GATE: Pick a day within the last 62 days or the next year.%');
  perform neo_hrt.expect_error(format('select public.hr_roster_set(%L, %L, %L)', neo_hrt.email('flex'), neo_hrt.d(1), 'remote'),
                               '%NEO_GATE: A duty is shop, field, off, leave or wfh (work from home).%');
  perform neo_hrt.expect_error(format('select public.hr_roster_set(%L, %L, %L, %L)', neo_hrt.email('flex'), neo_hrt.d(1), 'shop', repeat('n', 201)),
                               '%NEO_GATE: The note is too long — keep it under 200 characters.%');
  -- S19 for a NeoHR lead (tier 2) too
  perform neo_hrt.expect_error(format('select public.hr_roster_set(%L, %L, %L)', neo_hrt.email('lead'), neo_hrt.d(1), 'wfh'),
                               '%NEO_DENIED: Someone else has to approve or change your own attendance, duty or travel allowance.%');
end $$;

-- S19: a lead's own request, and the owner (tier 5) on their own records
select neo_hrt.login('lead');
do $$
declare r jsonb;
begin
  r := public.hr_request_create(jsonb_build_object('kind', 'late_start', 'date_from', neo_hrt.d(1), 'reason', 'Lead running late'));
  perform neo_hrt.expect_error(format('select public.hr_request_decide(%L::uuid, true)', r -> 'request' ->> 'id'),
                               '%NEO_GATE: Someone else has to approve or change your own attendance, duty or travel allowance.%');
end $$;
select neo_hrt.login('owner');
do $$
declare r jsonb;
begin
  r := public.hr_request_create(jsonb_build_object('kind', 'late_start', 'date_from', neo_hrt.d(0), 'reason', 'Doctor visit'));
  perform neo_hrt.put('owner_req', r -> 'request' ->> 'id');
  perform neo_hrt.expect_error(format('select public.hr_request_decide(%L::uuid, true)', r -> 'request' ->> 'id'),
                               '%NEO_GATE: Someone else has to approve or change your own attendance, duty or travel allowance.%');
  perform neo_hrt.expect_error(format('select public.hr_correct(%L, %L::jsonb)', neo_hrt.email('owner'),
                                      jsonb_build_object('action', 'add', 'kind', 'punch_in', 'at', now(), 'note', 'self')),
                               '%NEO_DENIED: Someone else has to approve or change your own attendance, duty or travel allowance.%');
  perform neo_hrt.expect_error(format('select public.hr_roster_set(%L, %L, %L)', neo_hrt.email('owner'), neo_hrt.d(1), 'wfh'),
                               '%NEO_DENIED: Someone else has to approve or change your own attendance, duty or travel allowance.%');
  perform neo_hrt.expect_error(format('select public.hr_ta_approve(%L, %L, null, 0)', neo_hrt.email('owner'), neo_hrt.lmd()),
                               '%NEO_DENIED: Someone else has to approve or change your own attendance, duty or travel allowance.%');
end $$;
select neo_hrt.login('head');
do $$
begin
  perform neo_hrt.expect_error(format('select public.hr_request_decide(%L::uuid, true)', neo_hrt.get('owner_req')),
                               '%NEO_GATE: Requests from a tier 4 or 5 account are decided by tier 4 and above.%');
end $$;
select neo_hrt.login('ceo');
select public.hr_request_decide(neo_hrt.get('owner_req')::uuid, true, null);
select neo_hrt.login('owner');
do $$
begin
  -- the owner's own approved request has started; as an approver they still may not cancel their own
  perform neo_hrt.expect_error(format('select public.hr_request_cancel(%L::uuid, %L)', neo_hrt.get('owner_req'), 'changed my mind'),
                               '%NEO_DENIED: Someone else has to approve or change your own attendance, duty or travel allowance.%');
end $$;


-- ── 11. Routes, who viewed them, thinning, place hints (§9.4.5, §9.8) ────────
select neo_hrt.login('walk');
do $$
declare r jsonb; e jsonb := neo_hrt.fixture_expect('two_stops');
begin
  perform neo_hrt.punch('punch_in', (neo_hrt.lmd() + time '09:00') at time zone 'Asia/Kolkata');
  perform neo_hrt.punch('punch_out', (neo_hrt.lmd() + time '17:00') at time zone 'Asia/Kolkata');
  r := public.location_push(neo_hrt.fixture_points('two_stops', (neo_hrt.lmd() + time '10:00') at time zone 'Asia/Kolkata'));
  perform neo_hrt.assert((r ->> 'accepted')::int = 13 and jsonb_array_length(r -> 'rejected') = 0, 'the fixture route is on duty ' || r::text);
  r := public.hr_route(null, neo_hrt.lmd());
  perform neo_hrt.assert((r ->> 'km')::numeric = (e ->> 'km')::numeric and jsonb_array_length(r -> 'stops') = 2
                         and jsonb_array_length(r -> 'points') = 13 and (r ->> 'km_gaps')::int = 0
                         and jsonb_array_length(r -> 'segments') >= 1 and r -> 'visits' = '[]'::jsonb
                         and r -> 'stops' -> 0 ? 'place_hint' and r -> 'stops' -> 0 ->> 'place_hint' is null
                         and (r -> 'stops' -> 0 ->> 'minutes')::int = 6,
                         'hr_route: the server measures the pushed fixture exactly as _hr_track_points did ' || r::text);
  perform neo_hrt.assert(neo_hrt.keys(r) @> array['day', 'km', 'km_gaps', 'moving_min', 'points', 'segments', 'stops', 'visits'],
                         'hr_route keys ' || neo_hrt.keys(r)::text);
  r := public.hr_my_day(neo_hrt.lmd());
  perform neo_hrt.assert((r ->> 'km')::numeric = (e ->> 'km')::numeric and r -> 'viewed_by' = '[]'::jsonb, 'hr_my_day km = the route km ' || r::text);
  perform neo_hrt.assert((select count(*) from public.hr_route_views where subject_email = neo_hrt.email('walk')) = 0,
                         'viewing your own route records nothing');
  perform neo_hrt.expect_error(format('select public.hr_route(%L, %L)', neo_hrt.email('tech'), neo_hrt.d(-6)),
                               '%NEO_DENIED: Only a head or a NeoHR lead can see someone else''s route.%');
  r := public.hr_route();
  perform neo_hrt.assert((r ->> 'day')::date = (now() at time zone 'Asia/Kolkata')::date, 'hr_route defaults to today in India');
end $$;
reset role;
select neo_hrt.no_jwt();
do $$
declare h public.hr_day_km;
begin
  select * into h from public.hr_day_km where employee_email = neo_hrt.email('walk') and day = neo_hrt.lmd();
  perform neo_hrt.assert(h.km = (neo_hrt.fixture_expect('two_stops') ->> 'km')::numeric and not h.final and h.points = 13
                         and h.profile_id = neo_hrt.uid('walk'), '§9.5.6: a past day''s km is cached (not final) ' || row_to_json(h)::text);
end $$;

-- the office point at the first stop: "Shop"
select neo_hrt.login('ceo');
do $$
declare e jsonb := neo_hrt.fixture_expect('two_stops');
begin
  perform public.hr_settings_set(jsonb_build_object('office_lat', (e -> 'stops' -> 0 ->> 'lat')::float8, 'office_lng', (e -> 'stops' -> 0 ->> 'lng')::float8));
end $$;
select neo_hrt.login('head');
do $$
declare r jsonb;
begin
  r := public.hr_route(neo_hrt.email('walk'), neo_hrt.lmd());
  perform neo_hrt.assert(r -> 'stops' -> 0 ->> 'place_hint' = 'Shop' and r -> 'stops' -> 1 ->> 'place_hint' is null and r ->> 'email' = neo_hrt.email('walk'),
                         'place_hint: "Shop" within office_radius_m of the office point ' || r::text);
  perform public.hr_route(neo_hrt.email('tech'), neo_hrt.d(-6));
  r := public.hr_route(neo_hrt.email('tech'), neo_hrt.d(-6));
  perform neo_hrt.assert(r -> 'visits' -> 0 ->> 'code' = 'NT-HRTJ0001', 'hr_route lists the day''s visits');
  perform neo_hrt.expect_error(format('select public.hr_route(%L)', 'nobody@neotokyo.test'), '%NEO_GATE: There is no staff account with that email.%');
end $$;
reset role;
select neo_hrt.no_jwt();
do $$
begin
  perform neo_hrt.assert(exists (select 1 from public.hr_route_views where viewer_email = neo_hrt.email('head') and subject_email = neo_hrt.email('walk')
                                   and day = neo_hrt.lmd()), 'a head viewing someone''s route is recorded');
end $$;
select neo_hrt.login('walk');
do $$
declare r jsonb;
begin
  r := public.hr_my_day(neo_hrt.lmd());
  perform neo_hrt.assert(jsonb_array_length(r -> 'viewed_by') = 1 and r -> 'viewed_by' -> 0 ->> 'name' = neo_hrt.name('head')
                         and r -> 'viewed_by' -> 0 ->> 'at' is not null, 'the person sees who viewed their route ' || r::text);
end $$;

-- more than 2000 points: evenly thinned to 2000
select neo_hrt.login('thin');
select neo_hrt.punch('punch_in', neo_hrt.at(-5, '08:00'));
select neo_hrt.punch('punch_out', neo_hrt.at(-5, '20:00'));
reset role;
select neo_hrt.no_jwt();
select neo_hrt.raw_points('thin', (select jsonb_agg(jsonb_build_object('id', gen_random_uuid(), 'at', neo_hrt.at(-5, '08:30') + g * interval '15 seconds',
                                                                       'lat', 10.0 + g * 0.000045, 'lng', 76.3, 'accuracy_m', 10) order by g)
                                     from generate_series(0, 2099) as g));
select neo_hrt.login('lead');
do $$
declare r jsonb;
begin
  r := public.hr_route(neo_hrt.email('thin'), neo_hrt.d(-5));
  perform neo_hrt.assert(jsonb_array_length(r -> 'points') = 2000
                         and (r -> 'points' -> 0 ->> 'at')::timestamptz = neo_hrt.at(-5, '08:30')
                         and (r -> 'points' -> 1999 ->> 'at')::timestamptz = neo_hrt.at(-5, '08:30') + 2099 * interval '15 seconds',
                         'hr_route: ≤ 2000 points, evenly thinned, first and last kept (' || jsonb_array_length(r -> 'points') || ')');
end $$;


-- ── 12. Settings and per-person settings (§9.4.6) ───────────────────────────
select neo_hrt.login('tech');
do $$
begin
  perform neo_hrt.expect_error($q$select public.hr_settings_set('{"grace_min": 5}'::jsonb)$q$,
                               '%NEO_DENIED: Only tier 4 and above can change attendance settings.%');
  perform neo_hrt.expect_error(format('select public.hr_person_set(%L, %L::jsonb)', neo_hrt.email('walk'), '{"ta_eligible": false}'),
                               '%NEO_DENIED: Only tier 4 and above can change attendance settings.%');
end $$;
select neo_hrt.login('ceo');
do $$
declare r jsonb; s text := 'select public.hr_settings_set(%L::jsonb)';
begin
  perform neo_hrt.expect_error($q$select public.hr_settings_set(null)$q$, '%NEO_GATE: The request is empty.%');
  perform neo_hrt.expect_error(format(s, '{"colour": "red"}'), '%NEO_GATE: "colour" is not a setting you can change here.%');
  perform neo_hrt.expect_error(format(s, '{"grace_min": 121}'), '%NEO_GATE: Grace must be between 0 and 120.%');
  perform neo_hrt.expect_error(format(s, '{"grace_min": "ten"}'), '%NEO_GATE: Grace must be between 0 and 120.%');
  perform neo_hrt.expect_error(format(s, '{"half_day_min": 59}'), '%NEO_GATE: Half-day threshold must be between 60 and 600.%');
  perform neo_hrt.expect_error(format(s, '{"track_interval_s": 29}'), '%NEO_GATE: Tracking interval must be between 30 and 600.%');
  perform neo_hrt.expect_error(format(s, '{"track_distance_m": 1001}'), '%NEO_GATE: Tracking distance must be between 25 and 1000.%');
  perform neo_hrt.expect_error(format(s, '{"retention_days": 29}'), '%NEO_GATE: Retention must be between 30 and 365.%');
  perform neo_hrt.expect_error(format(s, '{"office_radius_m": 49}'), '%NEO_GATE: Office radius must be between 50 and 2000.%');
  perform neo_hrt.expect_error(format(s, '{"max_session_h": 25}'), '%NEO_GATE: Longest shift must be between 4 and 24.%');
  perform neo_hrt.expect_error(format(s, '{"shift_start": "18:00", "shift_end": "09:00"}'), '%NEO_GATE: The shift must end after it starts.%');
  perform neo_hrt.expect_error(format(s, '{"shift_end": "09:00"}'), '%NEO_GATE: The shift must end after it starts.%');
  perform neo_hrt.expect_error(format(s, '{"weekly_off": [7]}'), '%NEO_GATE: Weekly off days are 0 (Sunday) to 6 (Saturday), each at most once.%');
  perform neo_hrt.expect_error(format(s, '{"weekly_off": [1, 1]}'), '%NEO_GATE: Weekly off days are 0 (Sunday) to 6 (Saturday), each at most once.%');
  perform neo_hrt.expect_error(format(s, '{"weekly_off": "sun"}'), '%NEO_GATE: Weekly off days are 0 (Sunday) to 6 (Saturday), each at most once.%');
  perform neo_hrt.expect_error(format(s, '{"weekly_off": null}'), '%NEO_GATE: Weekly off days are 0 (Sunday) to 6 (Saturday), each at most once.%');
  perform neo_hrt.expect_error(format(s, '{"shift_start": "nine"}'), '%NEO_GATE: Shift start must be a time like 09:30.%');
  perform neo_hrt.expect_error(format(s, jsonb_build_object('grace_min', 5, 'effective_from', neo_hrt.d(-1))), '%NEO_GATE: Changes apply from today onwards.%');
  perform neo_hrt.expect_error(format(s, '{"ta_rate_per_km": 1001}'), '%NEO_GATE: Travel allowance rate must be between 0 and 1000.%');
  perform neo_hrt.expect_error(format(s, '{"ta_rate_per_km": "cheap"}'), '%NEO_GATE: Travel allowance rate must be between 0 and 1000.%');
  perform neo_hrt.expect_error(format(s, '{"office_lat": 10}'), '%NEO_GATE: The office point needs both a latitude and a longitude.%');
  perform neo_hrt.expect_error(format(s, '{"office_lat": 95, "office_lng": 76}'), '%NEO_GATE: That office point is not on the map.%');
  r := public.hr_settings_set(jsonb_build_object('grace_min', 15, 'weekly_off', jsonb_build_array(0, 6), 'track_interval_s', 90));
  perform neo_hrt.assert(r ->> 'ok' = 'true' and (r ->> 'effective_from')::date = neo_hrt.d(1) and (r ->> 'grace_min')::int = 10
                         and (r ->> 'track_interval_s')::int = 90 and r -> 'weekly_off' = '[]'::jsonb and r ? 'people'
                         and exists (select 1 from jsonb_array_elements(r -> 'history') h
                                      where (h.value ->> 'effective_from')::date = neo_hrt.d(1) and (h.value ->> 'grace_min')::int = 15
                                        and h.value -> 'weekly_off' = '[0, 6]'::jsonb),
                         'hr_settings_set: shift keys from tomorrow (in the history; the display copies stay today''s row), others at once ' || r::text);
  perform neo_hrt.assert((select count(*) from public.hr_shift_history where profile_id is null and effective_from = neo_hrt.d(1)) = 1,
                         'one default row for tomorrow');
  r := public.hr_settings_set(jsonb_build_object('shift_start', '09:30', 'effective_from', neo_hrt.d(1)));
  perform neo_hrt.assert((select count(*) from public.hr_shift_history where profile_id is null and effective_from = neo_hrt.d(1)) = 1
                         and (select grace_min from public.hr_shift_history where profile_id is null and effective_from = neo_hrt.d(1)) = 15,
                         'the same date again replaces that row and keeps its other fields');
  -- hierarchy and the own-row rule
  r := public.hr_person_set(neo_hrt.email('head'), '{"ta_eligible": false}'::jsonb);
  perform neo_hrt.assert(r -> 'person' ->> 'ta_eligible' = 'false', 'a tier 4 may change a tier 3 ' || r::text);
  perform neo_hrt.expect_error(format('select public.hr_person_set(%L, %L::jsonb)', neo_hrt.email('cto'), '{"ta_eligible": false}'),
                               '%NEO_DENIED: Only the owner can change a tier 4 or 5 account.%');
  perform neo_hrt.expect_error(format('select public.hr_person_set(%L, %L::jsonb)', neo_hrt.email('ceo'), '{"ta_eligible": false}'),
                               '%NEO_DENIED: Someone else has to approve or change your own attendance, duty or travel allowance.%');
  perform neo_hrt.expect_error(format('select public.hr_person_set(%L, %L::jsonb)', neo_hrt.email('head'), '{"ta_eligible": null}'),
                               '%NEO_GATE: Travel allowance must be yes or no.%');
  perform neo_hrt.expect_error(format('select public.hr_person_set(%L, %L::jsonb)', neo_hrt.email('head'), '{"track_location": "maybe"}'),
                               '%NEO_GATE: Route recording must be yes or no.%');
  perform neo_hrt.expect_error(format('select public.hr_person_set(%L, %L::jsonb)', neo_hrt.email('head'), '{"attendance_required": null}'),
                               '%NEO_GATE: Attendance required must be yes or no.%');
  perform neo_hrt.expect_error(format('select public.hr_person_set(%L, %L::jsonb)', neo_hrt.email('head'), '{"tier": 5}'),
                               '%NEO_GATE: "tier" is not a setting you can change here.%');
  perform neo_hrt.expect_error(format('select public.hr_person_set(%L, null)', neo_hrt.email('head')), '%NEO_GATE: The request is empty.%');
  perform neo_hrt.expect_error(format('select public.hr_person_set(%L, %L::jsonb)', 'nobody@neotokyo.test', '{"ta_eligible": true}'),
                               '%NEO_GATE: There is no staff account with that email.%');
  r := public.hr_settings_get();
  perform neo_hrt.assert((neo_hrt.person(r, neo_hrt.email('head')) ->> 'can_edit')::boolean
                         and not (neo_hrt.person(r, neo_hrt.email('cto')) ->> 'can_edit')::boolean
                         and not (neo_hrt.person(r, neo_hrt.email('ceo')) ->> 'can_edit')::boolean
                         and neo_hrt.person(r, neo_hrt.email('head')) ->> 'ta_eligible' = 'false',
                         'hr_settings_get for tier 4: people with can_edit by the hierarchy and the own-row rule');
end $$;
-- days before attendance_from, or before the person's account, are not_tracked (not absent)
select neo_hrt.login('ceo');
do $$
declare r jsonb;
begin
  perform neo_hrt.expect_error($q$select public.hr_settings_set('{"attendance_from": null}'::jsonb)$q$,
                               '%NEO_GATE: Say from which day attendance counts.%');
  r := public.hr_settings_set(jsonb_build_object('attendance_from', neo_hrt.d(-2)));
  perform neo_hrt.assert((r ->> 'attendance_from')::date = neo_hrt.d(-2), 'attendance_from is a setting ' || (r ->> 'attendance_from'));
end $$;
select neo_hrt.login('lead');
do $$
declare r jsonb;
begin
  r := public.hr_register(neo_hrt.d(-3), neo_hrt.d(-2), neo_hrt.email('idle'));
  perform neo_hrt.assert(neo_hrt.regday(r, neo_hrt.email('idle'), neo_hrt.d(-3)) ->> 'status' = 'not_tracked'
                         and (neo_hrt.regday(r, neo_hrt.email('idle'), neo_hrt.d(-3)) ->> 'absent_units')::numeric = 0
                         and neo_hrt.regday(r, neo_hrt.email('idle'), neo_hrt.d(-2)) ->> 'status' = 'absent',
                         'before attendance_from a day with no punch is not_tracked ' || r::text);
  r := public.hr_register(neo_hrt.d(-3), neo_hrt.d(-3), neo_hrt.email('tech'));
  perform neo_hrt.assert(neo_hrt.regday(r, neo_hrt.email('tech'), neo_hrt.d(-3)) ->> 'status' = 'present', '…a punched day still counts');
end $$;
select neo_hrt.login('ceo');
select public.hr_settings_set('{"attendance_from": "2020-01-01"}'::jsonb);
reset role;
select neo_hrt.no_jwt();
update public.profiles set created_at = now() where email = 'zq.hr.idle@neotokyo.test';
do $$
begin
  perform neo_hrt.assert(public._hr_days(neo_hrt.email('idle'), neo_hrt.d(-3), neo_hrt.d(-3), now()) -> 0 ->> 'status' = 'not_tracked',
                         'a new account: the days before it are not_tracked');
end $$;
update public.profiles set created_at = '2020-01-01' where email = 'zq.hr.idle@neotokyo.test';

select neo_hrt.login('owner');
do $$
declare r jsonb;
begin
  r := public.hr_person_set(neo_hrt.email('owner'), '{"ta_eligible": false}'::jsonb);
  perform neo_hrt.assert(r ->> 'ok' = 'true', 'S19 exception: a tier 5 may change their own row ' || r::text);
  r := public.hr_person_set(neo_hrt.email('cto'), '{"track_location": false}'::jsonb);
  perform neo_hrt.assert(r -> 'person' ->> 'track_location' = 'false', 'the owner may change a tier 4');
  perform neo_hrt.assert((neo_hrt.person(public.hr_settings_get(), neo_hrt.email('owner')) ->> 'can_edit')::boolean, 'can_edit: the owner''s own row');
end $$;
reset role;
select neo_hrt.no_jwt();
do $$
declare c record;
begin
  select * into c from public._hr_ctx(neo_hrt.uid('walk'), neo_hrt.email('walk'), neo_hrt.d(0), neo_hrt.d(0));
  perform neo_hrt.assert(c.grace_min = 10 and c.weekly_off = '{}', 'today keeps today''s default row');
  select * into c from public._hr_ctx(neo_hrt.uid('walk'), neo_hrt.email('walk'), neo_hrt.d(1), neo_hrt.d(1));
  perform neo_hrt.assert(c.grace_min = 15 and c.weekly_off = '{0,6}', 'tomorrow takes the new default row');
  perform neo_hrt.assert((select grace_min from public.hr_settings) = 10 and (select weekly_off from public.hr_settings) = '{}'
                         and (select track_interval_s from public.hr_settings) = 90
                         and (select updated_by from public.hr_settings) = neo_hrt.email('ceo'),
                         'settings display copies (today''s default row, not tomorrow''s) and updated_by');
end $$;

-- A shift ends after it starts on EVERY day, also for someone whose own row takes one end from the
-- default row of that day: checked from both sides (in a subtransaction: nothing is kept).
-- Real people's own shift rows are set aside until the rollback, so only the test users' rows decide.
delete from public.hr_shift_history where profile_id is not null and profile_id not in (select id from neo_hrt.users);
select neo_hrt.login('ceo');
do $$
declare v text; r jsonb; s text := 'select public.hr_settings_set(%L::jsonb)'; ps text := 'select public.hr_person_set(%L, %L::jsonb)';
begin
  begin
    -- walk's own end (17:00) from d+2: a default row from d+5 that starts at 17:30 is refused, naming walk
    r := public.hr_person_set(neo_hrt.email('walk'), jsonb_build_object('shift_end', '17:00', 'effective_from', neo_hrt.d(2)));
    perform neo_hrt.assert(r ->> 'ok' = 'true', 'walk''s own end time ' || r::text);
    perform neo_hrt.expect_error(format(s, jsonb_build_object('shift_start', '17:30', 'shift_end', '20:00', 'effective_from', neo_hrt.d(5))),
      '%NEO_GATE: The shift must end after it starts — with Zqhr Walker''s own start or end time it would not. Change theirs first.%');
    perform neo_hrt.expect_error(format(s, jsonb_build_object('shift_start', '17:30', 'shift_end', '20:00', 'effective_from', neo_hrt.d(2))),
      '%NEO_GATE: The shift must end after it starts — with Zqhr Walker''s own start or end time it would not. Change theirs first.%');
    -- a default row that ends before walk's row starts is fine (the d+1 row takes over before d+2)
    r := public.hr_settings_set(jsonb_build_object('shift_start', '17:30', 'shift_end', '20:00', 'effective_from', neo_hrt.d(0)));
    perform neo_hrt.assert(r ->> 'ok' = 'true', 'a default row the person''s own row never meets ' || r::text);
    -- the other side: the default row from d+5 first, then walk's end time that comes before its start
    perform public.hr_person_set(neo_hrt.email('walk'), jsonb_build_object('shift_end', null, 'effective_from', neo_hrt.d(2)));
    r := public.hr_settings_set(jsonb_build_object('shift_start', '17:30', 'shift_end', '20:00', 'effective_from', neo_hrt.d(5)));
    perform neo_hrt.assert(r ->> 'ok' = 'true', 'a later default row ' || r::text);
    perform neo_hrt.expect_error(format(ps, neo_hrt.email('walk'), jsonb_build_object('shift_end', '17:00', 'effective_from', neo_hrt.d(2))),
      format('%%NEO_GATE: The shift must end after it starts — from %s (the default shift changes then) it would not.%%',
             to_char(neo_hrt.d(5), 'DD Mon YYYY')));
    perform neo_hrt.expect_error(format(ps, neo_hrt.email('walk'), jsonb_build_object('shift_end', '09:00', 'effective_from', neo_hrt.d(2))),
      '%NEO_GATE: The shift must end after it starts.');
    r := public.hr_person_set(neo_hrt.email('walk'), jsonb_build_object('shift_end', '21:00', 'effective_from', neo_hrt.d(2)));
    perform neo_hrt.assert(r ->> 'ok' = 'true', 'an end after every start is fine ' || r::text);
    raise exception 'rollback:ok';
  exception when others then v := sqlerrm;
  end;
  perform neo_hrt.assert(v = 'rollback:ok', 'shift checks: ' || v);
end $$;

-- attendance_from after today: leave and off days before it still count; the board agrees with the day record.
select neo_hrt.login('ceo');
select public.hr_settings_set(jsonb_build_object('attendance_from', neo_hrt.d(1)));
select neo_hrt.login('lead');
do $$
declare r jsonb; c jsonb;
begin
  r := public.hr_register(neo_hrt.d(-3), neo_hrt.d(-1), neo_hrt.email('tech'));
  perform neo_hrt.assert(neo_hrt.regday(r, neo_hrt.email('tech'), neo_hrt.d(-3)) ->> 'status' = 'present'
                         and neo_hrt.regday(r, neo_hrt.email('tech'), neo_hrt.d(-2)) ->> 'status' = 'leave'
                         and (neo_hrt.regday(r, neo_hrt.email('tech'), neo_hrt.d(-2)) ->> 'leave_units')::numeric = 1
                         and neo_hrt.regday(r, neo_hrt.email('tech'), neo_hrt.d(-1)) ->> 'status' = 'off',
                         'before attendance_from: a punched day, an approved leave and an off day still count ' || r::text);
  r := public.hr_register(neo_hrt.d(0), neo_hrt.d(0), neo_hrt.email('plain'));
  perform neo_hrt.assert(neo_hrt.regday(r, neo_hrt.email('plain'), neo_hrt.d(0)) ->> 'status' = 'not_tracked', 'register: not_tracked ' || r::text);
  r := public.hr_board();
  perform neo_hrt.assert(neo_hrt.person(r, neo_hrt.email('plain')) ->> 'status' = 'not_tracked',
                         'board: not_tracked before attendance_from, as the day record ' || (neo_hrt.person(r, neo_hrt.email('plain')))::text);
  c := r -> 'counts';
  r := public.hr_dashboard();
  perform neo_hrt.assert((r -> 'hr' ->> 'absent')::int = coalesce((c ->> 'absent')::int, 0)
                         and (r -> 'hr' ->> 'not_in_yet')::int = coalesce((c ->> 'not_in_yet')::int, 0),
                         'hr_dashboard counts = hr_board counts ' || r::text || ' / ' || c::text);
end $$;
select neo_hrt.login('tech');
do $$
begin
  perform neo_hrt.assert((public.hr_my_month(neo_hrt.d(-2)) -> 'totals' ->> 'leave')::numeric >= 1, 'my month counts a leave before attendance_from');
end $$;
select neo_hrt.login('ceo');
select public.hr_settings_set('{"attendance_from": "2020-01-01"}'::jsonb);


-- ── 13. Travel allowance (§9.7) ──────────────────────────────────────────────
select neo_hrt.login('plain');
do $$
begin
  perform neo_hrt.expect_error($q$select public.hr_ta_report(null)$q$, '%NEO_DENIED: Only a head or a NeoHR lead can see travel allowance.%');
  perform neo_hrt.expect_error(format('select public.hr_ta_approve(%L, %L, null, 1)', neo_hrt.email('walk'), neo_hrt.lmd()),
                               '%NEO_DENIED: Only a head or a NeoHR lead can approve travel allowance.%');
end $$;
-- v2.4: the allowance is trip km — walk's day out was one on-site trip, 09:00–17:00
select neo_hrt.login('walk');
do $$
declare r jsonb; v uuid := gen_random_uuid();
begin
  r := public.hr_trip_start(jsonb_build_object('id', v, 'kind', 'on_site', 'note', 'Zq site visits',
                                               'at', (neo_hrt.lmd() + time '09:00') at time zone 'Asia/Kolkata'));
  perform neo_hrt.assert(r ->> 'ok' = 'true', 'a trip over walk''s day ' || r::text);
  r := public.hr_trip_end(jsonb_build_object('id', v, 'at', (neo_hrt.lmd() + time '17:00') at time zone 'Asia/Kolkata'));
  perform neo_hrt.assert(r ->> 'ok' = 'true' and (r -> 'trip' ->> 'km')::numeric = (neo_hrt.fixture_expect('two_stops') ->> 'km')::numeric,
                         'its km is the day''s km ' || r::text);
end $$;
select neo_hrt.login('noallow');
select neo_hrt.punch('punch_in', (neo_hrt.lmd() + time '09:00') at time zone 'Asia/Kolkata');
select neo_hrt.punch('punch_out', (neo_hrt.lmd() + time '17:00') at time zone 'Asia/Kolkata');
select public.location_push(neo_hrt.fixture_points('slow_walk', (neo_hrt.lmd() + time '10:00') at time zone 'Asia/Kolkata'));
select neo_hrt.login('owner');
select public.hr_person_set(neo_hrt.email('noallow'), '{"ta_eligible": false}'::jsonb);
select neo_hrt.login('lead');
do $$
declare r jsonb; p jsonb; v_km numeric := (neo_hrt.fixture_expect('two_stops') ->> 'km')::numeric;
begin
  r := public.hr_ta_report(neo_hrt.lmd());
  p := neo_hrt.person(r, neo_hrt.email('walk'));
  perform neo_hrt.assert((r ->> 'month')::date = date_trunc('month', neo_hrt.lmd())::date and r ->> 'closed' = 'true' and r ->> 'rate' is null
                         and (p ->> 'km')::numeric = v_km and p -> 'days' @> jsonb_build_array(jsonb_build_object('day', neo_hrt.lmd(), 'km', v_km))
                         and p ->> 'rate' is null and p ->> 'amount' is null and p -> 'approved' = 'null'::jsonb and p ->> 'can_approve' = 'false',
                         'hr_ta_report: km per day and the month; no rate yet ' || p::text);
  perform neo_hrt.expect_error(format('select public.hr_ta_approve(%L, %L, null, %s)', neo_hrt.email('walk'), neo_hrt.d(0), v_km),
                               '%NEO_GATE: Approve a month after it ends.%');
  perform neo_hrt.expect_error(format('select public.hr_ta_approve(%L, %L, null, %s)', neo_hrt.email('walk'), neo_hrt.lmd(), v_km),
                               '%NEO_GATE: Set the travel allowance rate first.%');
  perform neo_hrt.expect_error(format('select public.hr_ta_approve(%L, %L, null, %s)', neo_hrt.email('lead'), neo_hrt.lmd(), v_km),
                               '%NEO_DENIED: Someone else has to approve or change your own attendance, duty or travel allowance.%');
  perform neo_hrt.expect_error(format('select public.hr_ta_approve(%L, null, null, %s)', neo_hrt.email('walk'), v_km), '%NEO_GATE: Say which month.%');
  perform neo_hrt.expect_error(format('select public.hr_ta_approve(%L, %L, null, %s)', 'nobody@neotokyo.test', neo_hrt.lmd(), v_km),
                               '%NEO_GATE: There is no staff account with that email.%');
end $$;
select neo_hrt.login('ceo');
select public.hr_settings_set('{"ta_rate_per_km": 8.5}'::jsonb);
select neo_hrt.login('lead');
do $$
declare r jsonb; p jsonb; v_km numeric := (neo_hrt.fixture_expect('two_stops') ->> 'km')::numeric;
begin
  perform neo_hrt.expect_error(format('select public.hr_ta_approve(%L, %L, null, 0.06)', neo_hrt.email('noallow'), neo_hrt.lmd()),
                               '%NEO_GATE: Zqhr Noallow isn''t eligible for travel allowance.%');
  r := public.hr_ta_approve(neo_hrt.email('walk'), neo_hrt.lmd(), null, 0.5);
  perform neo_hrt.assert(r = jsonb_build_object('ok', false, 'reason', 'changed', 'km', v_km), 'a different km: {ok:false, reason:changed, km} ' || r::text);
  perform neo_hrt.assert(not exists (select 1 from public.hr_ta_approvals where profile_id = neo_hrt.uid('walk')), '…and nothing is written');
  perform neo_hrt.expect_error(format('select public.hr_ta_approve(%L, %L, %L, %s)', neo_hrt.email('walk'), neo_hrt.lmd(), repeat('z', 301), v_km),
                               '%NEO_GATE: The note is too long — keep it under 300 characters.%');
  r := public.hr_ta_approve(neo_hrt.email('walk'), neo_hrt.lmd() - 5, 'Site visits', v_km);
  perform neo_hrt.assert(r ->> 'ok' = 'true' and (r ->> 'km')::numeric = v_km and (r ->> 'rate')::numeric = 8.5
                         and (r ->> 'amount')::numeric = round(v_km * 8.5, 2), 'approved: a snapshot of km, rate, amount ' || r::text);
  perform neo_hrt.assert(exists (select 1 from public.hr_ta_approvals where profile_id = neo_hrt.uid('walk') and month = date_trunc('month', neo_hrt.lmd())::date
                                   and approved_by_name = neo_hrt.name('lead') and note = 'Site visits'),
                         'the month is normalised to its 1st');
  r := public.hr_ta_approve(neo_hrt.email('walk'), neo_hrt.lmd(), null, v_km);
  perform neo_hrt.assert(r ->> 'ok' = 'false' and r ->> 'reason' = 'approved' and r ->> 'by' = neo_hrt.name('lead') and r ->> 'at' is not null,
                         'approved twice: {ok:false, reason:approved, by, at} ' || r::text);
  p := neo_hrt.person(public.hr_ta_report(neo_hrt.lmd()), neo_hrt.email('walk'));
  perform neo_hrt.assert(p -> 'approved' ->> 'by' = neo_hrt.name('lead') and (p ->> 'km')::numeric = v_km and (p ->> 'live_km')::numeric = v_km
                         and p ->> 'changed' = 'false' and p ->> 'can_approve' = 'false', 'the report shows the approval ' || p::text);
end $$;
-- a point added later: the cached day goes stale, the approved month shows "changed"
select neo_hrt.login('walk');
do $$
declare r jsonb;
begin
  r := public.location_push(jsonb_build_array(neo_hrt.pt((neo_hrt.lmd() + time '16:00') at time zone 'Asia/Kolkata', 10.0359, 76.3419, 10)));
  perform neo_hrt.assert((r ->> 'accepted')::int = 1, 'a late point ' || r::text);
  perform neo_hrt.assert(not exists (select 1 from public.hr_day_km where employee_email = neo_hrt.email('walk') and day = neo_hrt.lmd()),
                         '§9.5.6: a stored point of a past day drops that day''s cached km');
  r := public.hr_my_month(neo_hrt.lmd());
  perform neo_hrt.assert((r -> 'totals' ->> 'km')::numeric > (neo_hrt.fixture_expect('two_stops') ->> 'km')::numeric
                         and r -> 'totals' -> 'ta' -> 'approved' ->> 'by' = neo_hrt.name('lead'), 'my month: the live km and the approval ' || r::text);
end $$;
select neo_hrt.login('lead');
do $$
declare p jsonb; v_km numeric := (neo_hrt.fixture_expect('two_stops') ->> 'km')::numeric;
begin
  p := neo_hrt.person(public.hr_ta_report(neo_hrt.lmd()), neo_hrt.email('walk'));
  perform neo_hrt.assert((p ->> 'km')::numeric = v_km and (p ->> 'live_km')::numeric > v_km and p ->> 'changed' = 'true',
                         'an approved month keeps its snapshot and shows live_km / changed ' || p::text);
  perform neo_hrt.expect_error(format('select public.hr_ta_unapprove(%L, %L, %L)', neo_hrt.email('walk'), neo_hrt.lmd(), 'recount'),
                               '%NEO_DENIED: Only tier 4 and above can take a travel allowance approval back.%');
end $$;
select neo_hrt.login('ceo');
do $$
declare r jsonb; p jsonb;
begin
  perform neo_hrt.expect_error(format('select public.hr_ta_unapprove(%L, %L)', neo_hrt.email('walk'), neo_hrt.lmd()),
                               '%NEO_GATE: Say why you''re taking the approval back.%');
  perform neo_hrt.expect_error(format('select public.hr_ta_unapprove(%L, null, %L)', neo_hrt.email('walk'), 'recount'), '%NEO_GATE: Say which month.%');
  perform neo_hrt.expect_error(format('select public.hr_ta_unapprove(%L, %L, %L)', neo_hrt.email('ceo'), neo_hrt.lmd(), 'recount'),
                               '%NEO_DENIED: Someone else has to approve or change your own attendance, duty or travel allowance.%');
  perform neo_hrt.expect_error(format('select public.hr_ta_unapprove(%L, %L, %L)', 'nobody@neotokyo.test', neo_hrt.lmd(), 'recount'),
                               '%NEO_GATE: There is no staff account with that email.%');
  r := public.hr_ta_unapprove(neo_hrt.email('walk'), neo_hrt.lmd(), 'A point came in late — recount');
  perform neo_hrt.assert(r = '{"ok": true, "removed": true}'::jsonb, 'unapprove ' || r::text);
  p := neo_hrt.person(public.hr_ta_report(neo_hrt.lmd()), neo_hrt.email('walk'));
  perform neo_hrt.assert(p -> 'approved' = 'null'::jsonb and p ->> 'can_approve' = 'true' and (p ->> 'km')::numeric = (p ->> 'live_km')::numeric,
                         'after unapprove: the live figure, approvable again ' || p::text);
  r := public.hr_ta_approve(neo_hrt.email('walk'), neo_hrt.lmd(), 'Recounted', (p ->> 'km')::numeric);
  perform neo_hrt.assert(r ->> 'ok' = 'true', 'approved again with the new km ' || r::text);
end $$;

-- §9.5.6: a cached day km is used while its inputs are unchanged and recomputed once they change — also
-- when the change never invalidated it (a reader that raced a writer can leave a row computed before the
-- writer's commit behind; the fingerprint, taken before the inputs are read, gives it away).
reset role;
select neo_hrt.no_jwt();
do $$
declare d jsonb; h public.hr_day_km; v_e text := neo_hrt.email('noallow'); v_km numeric; v_live numeric;
begin
  d := public._hr_days(v_e, neo_hrt.lmd(), neo_hrt.lmd(), now()) -> 0;
  v_km := (d ->> 'km')::numeric;
  select * into h from public.hr_day_km where employee_email = v_e and day = neo_hrt.lmd();
  perform neo_hrt.assert(h.fp is not null and not h.final and h.km = v_km and v_km > 0,
                         'a cached day carries the fingerprint of its inputs ' || row_to_json(h)::text);
  update public.hr_day_km set km = 99.99 where employee_email = v_e and day = neo_hrt.lmd();
  perform neo_hrt.assert((public._hr_days(v_e, neo_hrt.lmd(), neo_hrt.lmd(), now()) -> 0 ->> 'km')::numeric = 99.99,
                         'inputs unchanged: the cached row is what the day reads');
  -- a point stored behind the cache's back
  perform neo_hrt.raw_points('noallow', jsonb_build_array(jsonb_build_object('id', gen_random_uuid(),
            'at', (neo_hrt.lmd() + time '16:30') at time zone 'Asia/Kolkata', 'lat', 10.0459, 'lng', 76.3419, 'accuracy_m', 10)));
  v_live := public._hr_km(v_e, neo_hrt.lmd());
  d := public._hr_days(v_e, neo_hrt.lmd(), neo_hrt.lmd(), now()) -> 0;
  perform neo_hrt.assert((d ->> 'km')::numeric = v_live and v_live > v_km
                         and (select km from public.hr_day_km where employee_email = v_e and day = neo_hrt.lmd()) = v_live,
                         'a new point: recomputed and cached again (' || v_live || ', ' || (d ->> 'km') || ')');
  -- a punch voided behind its back
  update public.hr_day_km set km = 99.99 where employee_email = v_e and day = neo_hrt.lmd();
  update public.attendance_events set voided_at = now() where employee_email = v_e and kind = 'punch_in';
  d := public._hr_days(v_e, neo_hrt.lmd(), neo_hrt.lmd(), now()) -> 0;
  perform neo_hrt.assert((d ->> 'km')::numeric = 0 and not exists (select 1 from public.hr_day_km where employee_email = v_e and day = neo_hrt.lmd()),
                         'a voided punch_in: no session, 0 km, the stale row gone');
  update public.attendance_events set voided_at = null where employee_email = v_e and kind = 'punch_in';
  perform neo_hrt.assert((public._hr_days(v_e, neo_hrt.lmd(), neo_hrt.lmd(), now()) -> 0 ->> 'km')::numeric = v_live, 'back again');
  -- the longest shift is an input too
  update public.hr_day_km set km = 99.99 where employee_email = v_e and day = neo_hrt.lmd();
  update public.hr_settings set max_session_h = 15;
  perform neo_hrt.assert((public._hr_days(v_e, neo_hrt.lmd(), neo_hrt.lmd(), now()) -> 0 ->> 'km')::numeric = v_live,
                         'a different longest shift: recomputed');
  update public.hr_settings set max_session_h = 16;
end $$;


-- ── 14. Retention: final km rows, deleted points, cleared coordinates (§9.8) ─
reset role;
select neo_hrt.no_jwt();
do $$
declare v_before numeric; v_after numeric; r jsonb; h public.hr_day_km; e jsonb := neo_hrt.fixture_expect('drive');
begin
  perform neo_hrt.raw_event('old', 'punch_in', neo_hrt.at(-100, '09:00'), 10.0159, 76.3419);
  perform neo_hrt.raw_event('old', 'punch_out', neo_hrt.at(-100, '17:00'), 10.0159, 76.3419);
  perform neo_hrt.raw_points('old', neo_hrt.fixture_points('drive', neo_hrt.at(-100, '10:00')));
  v_before := (public._hr_days(neo_hrt.email('old'), neo_hrt.d(-100), neo_hrt.d(-100), now()) -> 0 ->> 'km')::numeric;
  perform neo_hrt.assert(v_before = (e ->> 'km')::numeric, 'the old day measures as the drive fixture (' || v_before || ')');
  -- a pre-v2.3 punch row field_activity still holds (its copy is in attendance_events), and a check-in of the same day
  insert into public.field_activity (client_request_id, employee_email, employee_name, module, ref_type, kind, at, lat, lng, accuracy_m, source,
                                     applied, applied_note)
  values ('c0000000-0000-4000-8000-0000000000f1', 'zq.hr.old@neotokyo.test', 'Zqhr Old', 'neohr', 'attendance', 'punch_in',
          neo_hrt.at(-100, '09:00'), 10.0159, 76.3419, 8, 'neohr', false, 'Recorded.'),
         ('c0000000-0000-4000-8000-0000000000f2', 'zq.hr.old@neotokyo.test', 'Zqhr Old', 'service', 'service_job', 'arrived',
          neo_hrt.at(-100, '10:30'), 10.0159, 76.3419, 8, 'neohr', false, 'No change: ticket not found.');
  update public.hr_settings set last_purge_at = null;
  r := public._hr_purge();
  perform neo_hrt.assert((r ->> 'deleted')::int >= 28 and (r ->> 'cutoff')::date = neo_hrt.d(-90) and r ->> 'done' = 'true', '_hr_purge ' || r::text);
  select * into h from public.hr_day_km where employee_email = neo_hrt.email('old') and day = neo_hrt.d(-100);
  perform neo_hrt.assert(h.final and h.km = v_before, 'a final hr_day_km row before the points went ' || row_to_json(h)::text);
  perform neo_hrt.assert(not exists (select 1 from public.location_points where employee_email = neo_hrt.email('old')), 'the old points are deleted');
  perform neo_hrt.assert(not exists (select 1 from public.location_points where at < neo_hrt.at(-90, '00:00')), 'nothing older than the cutoff is left');
  perform neo_hrt.assert((select count(*) from public.attendance_events where employee_email = neo_hrt.email('old')) = 2
                         and not exists (select 1 from public.attendance_events where employee_email = neo_hrt.email('old')
                                          and (lat is not null or lng is not null or accuracy_m is not null)),
                         'punches stay; their coordinates before the cutoff are cleared');
  perform neo_hrt.assert((select lat is null and lng is null and accuracy_m is null from public.field_activity
                           where client_request_id = 'c0000000-0000-4000-8000-0000000000f1')
                         and (select lat = 10.0159 from public.field_activity where client_request_id = 'c0000000-0000-4000-8000-0000000000f2'),
                         '…and so are those of the legacy punch rows in field_activity (a check-in keeps its point)');
  delete from public.field_activity where client_request_id in ('c0000000-0000-4000-8000-0000000000f1', 'c0000000-0000-4000-8000-0000000000f2');
  perform neo_hrt.assert((select last_purge_at from public.hr_settings) = now(), 'last_purge_at is set when nothing older is left');
  v_after := (public._hr_days(neo_hrt.email('old'), neo_hrt.d(-100), neo_hrt.d(-100), now()) -> 0 ->> 'km')::numeric;
  perform neo_hrt.assert(v_after = v_before, 'the day''s km does not change after the purge (' || v_after || ')');
  perform public._hr_invalidate(neo_hrt.email('old'), neo_hrt.at(-100, '12:00'));
  perform neo_hrt.assert(exists (select 1 from public.hr_day_km where employee_email = neo_hrt.email('old') and day = neo_hrt.d(-100) and final),
                         'a final row is never dropped');
  -- the fallback: location_push purges when the last purge is older than 6 hours
  perform neo_hrt.raw_event('old', 'punch_in', neo_hrt.at(-101, '09:00'));
  perform neo_hrt.raw_event('old', 'punch_out', neo_hrt.at(-101, '17:00'));
  perform neo_hrt.raw_points('old', neo_hrt.fixture_points('slow_walk', neo_hrt.at(-101, '10:00')));
  update public.hr_settings set last_purge_at = now() - interval '7 hours';
end $$;
select neo_hrt.login('old');
select public.location_push(jsonb_build_array(neo_hrt.pt(now(), 10.0, 76.3, 10)));
reset role;
select neo_hrt.no_jwt();
do $$
begin
  perform neo_hrt.assert(not exists (select 1 from public.location_points where employee_email = neo_hrt.email('old'))
                         and exists (select 1 from public.hr_day_km where employee_email = neo_hrt.email('old') and day = neo_hrt.d(-101) and final
                                       and km = (neo_hrt.fixture_expect('slow_walk') ->> 'km')::numeric)
                         and (select last_purge_at from public.hr_settings) = now(),
                         'the purge fallback in location_push ran');
end $$;

-- The fallback is bounded (it runs inside a phone's request): the oldest p_max_rows expired points, at most
-- 20 of their days made final per call (oldest first) and only their points deleted — what a call did stays
-- done, so a backlog shrinks call after call; a day without a punch_in is never tracked.
do $$
declare r jsonb; k int; v_e text := neo_hrt.email('old'); v_km numeric;
begin
  for k in 106 .. 130 loop
    perform neo_hrt.raw_event('old', 'punch_in', neo_hrt.at(-k, '09:00'));
    perform neo_hrt.raw_event('old', 'punch_out', neo_hrt.at(-k, '17:00'));
    perform neo_hrt.raw_points('old', jsonb_build_array(
      jsonb_build_object('id', gen_random_uuid(), 'at', neo_hrt.at(-k, '10:00'), 'lat', 10.0, 'lng', 76.30, 'accuracy_m', 10),
      jsonb_build_object('id', gen_random_uuid(), 'at', neo_hrt.at(-k, '11:00'), 'lat', 10.0, 'lng', 76.31, 'accuracy_m', 10),
      jsonb_build_object('id', gen_random_uuid(), 'at', neo_hrt.at(-k, '12:00'), 'lat', 10.0, 'lng', 76.32, 'accuracy_m', 10)));
  end loop;
  v_km := public._hr_km(v_e, neo_hrt.d(-120));
  perform neo_hrt.assert(v_km > 2, 'each old day measures ' || v_km || ' km');
  update public.hr_settings set last_purge_at = null;
  r := public._hr_purge(5000);
  perform neo_hrt.assert((r ->> 'finals')::int = 20 and (r ->> 'deleted')::int = 60 and r ->> 'done' = 'false'
                         and (select count(*) from public.hr_day_km where employee_email = v_e and final and day between neo_hrt.d(-130) and neo_hrt.d(-111)) = 20
                         and not exists (select 1 from public.hr_day_km where employee_email = v_e and (day = neo_hrt.d(-131) or day between neo_hrt.d(-110) and neo_hrt.d(-106)))
                         and (select count(*) from public.location_points where employee_email = v_e) = 15
                         and not exists (select 1 from public.location_points where employee_email = v_e and at < neo_hrt.at(-110, '00:00'))
                         and (select last_purge_at from public.hr_settings) is null,
                         'a bounded call: the 20 oldest days final, only their points gone, the rest left for the next call ' || r::text);
  r := public._hr_purge(5000);
  perform neo_hrt.assert((r ->> 'finals')::int = 5 and (r ->> 'deleted')::int = 15 and r ->> 'done' = 'true'
                         and not exists (select 1 from public.location_points where employee_email = v_e)
                         and (select count(*) from public.hr_day_km where employee_email = v_e and final and day between neo_hrt.d(-130) and neo_hrt.d(-106)
                                and km = v_km and points = 3) = 25
                         and (select last_purge_at from public.hr_settings) = now(),
                         'the next call finishes the backlog; every day kept its km ' || r::text);
end $$;

-- A new longest shift re-folds every past auto-closed session (its runs end at the new cap): hr_settings_set
-- drops every cached day km (final rows stay), so register, route and live km agree.
do $$
begin
  perform neo_hrt.raw_event('lock', 'punch_in', neo_hrt.at(-8, '06:00'));      -- and never a punch_out
  perform neo_hrt.raw_points('lock', (select jsonb_agg(jsonb_build_object('id', gen_random_uuid(), 'at', neo_hrt.at(-8, '06:00') + g * interval '10 minutes',
                                                                          'lat', 10.0, 'lng', 76.3 + g * 0.002, 'accuracy_m', 10) order by g)
                                        from generate_series(0, 95) as g));
end $$;
select neo_hrt.login('lead');
do $$
declare d jsonb;
begin
  d := neo_hrt.regday(public.hr_register(neo_hrt.d(-8), neo_hrt.d(-8), neo_hrt.email('lock')), neo_hrt.email('lock'), neo_hrt.d(-8));
  perform neo_hrt.assert(d ->> 'missed_out' = 'true' and (d ->> 'worked_min')::int = 950 and (d ->> 'km')::numeric > 20
                         and exists (select 1 from public.hr_day_km where employee_email = neo_hrt.email('lock') and day = neo_hrt.d(-8) and not final),
                         'a 16-hour auto-closed day, cached ' || d::text);
  perform neo_hrt.put('lock_km16', d ->> 'km');
end $$;
select neo_hrt.login('ceo');
do $$
declare r jsonb;
begin
  r := public.hr_settings_set('{"max_session_h": 8}'::jsonb);
  perform neo_hrt.assert(r ->> 'ok' = 'true' and not exists (select 1 from public.hr_day_km where not final)
                         and exists (select 1 from public.hr_day_km where final),
                         'a new longest shift drops every cached day km; the final rows stay');
end $$;
select neo_hrt.login('lead');
do $$
begin
  perform neo_hrt.put('lock_day8', (neo_hrt.regday(public.hr_register(neo_hrt.d(-8), neo_hrt.d(-8), neo_hrt.email('lock')), neo_hrt.email('lock'),
                                                   neo_hrt.d(-8)))::text);
  perform neo_hrt.put('lock_route8', public.hr_route(neo_hrt.email('lock'), neo_hrt.d(-8))::text);
end $$;
reset role;
select neo_hrt.no_jwt();
do $$
declare d jsonb := neo_hrt.get('lock_day8')::jsonb; r jsonb := neo_hrt.get('lock_route8')::jsonb;
        v_live numeric := public._hr_km(neo_hrt.email('lock'), neo_hrt.d(-8));
begin
  perform neo_hrt.assert((d ->> 'worked_min')::int = 480 and (d ->> 'km')::numeric = v_live and v_live < neo_hrt.get('lock_km16')::numeric
                         and (r ->> 'km')::numeric = v_live
                         and (select sum((s.value ->> 'km')::numeric) from jsonb_array_elements(r -> 'segments') as s(value)) = v_live,
                         'the 8-hour cap: worked time, register km, route km and its segments agree with the live km (' || v_live || ') '
                         || d::text || ' / ' || (r -> 'segments')::text);
end $$;
select neo_hrt.login('ceo');
select public.hr_settings_set('{"max_session_h": 16}'::jsonb);
select neo_hrt.login('lead');
do $$
begin
  perform neo_hrt.assert((neo_hrt.regday(public.hr_register(neo_hrt.d(-8), neo_hrt.d(-8), neo_hrt.email('lock')), neo_hrt.email('lock'), neo_hrt.d(-8))
                          ->> 'km')::numeric = neo_hrt.get('lock_km16')::numeric, 'back to 16 hours: the first km again');
  perform public.hr_register(neo_hrt.lmd(), neo_hrt.lmd(), neo_hrt.email('walk'));      -- cached again (§16 reads walk's km rows)
  perform neo_hrt.assert(exists (select 1 from public.hr_day_km where employee_email = neo_hrt.email('walk') and day = neo_hrt.lmd()),
                         'reading a day caches it again');
end $$;


-- ── 15. Old clients: record_field_activity punches, tech_activity (§9.9.1) ───
select neo_hrt.login('night');
do $$
declare r jsonb; v uuid := gen_random_uuid(); t jsonb;
begin
  r := public.record_field_activity(jsonb_build_object('client_request_id', v, 'kind', 'punch_in', 'ref_type', 'attendance', 'module', 'neohr',
                                                       'at', neo_hrt.at(-3, '09:00'), 'lat', 10.0159, 'lng', 76.3419, 'source', 'neohr'));
  perform neo_hrt.assert(r = jsonb_build_object('id', v, 'applied', true, 'applied_note', 'Recorded.', 'duplicate', false, 'stage', null),
                         'a legacy punch answers in the old shape ' || r::text);
  perform neo_hrt.assert(not exists (select 1 from public.field_activity where client_request_id = v)
                         and exists (select 1 from neo_hrt.ae where id = v and employee_email = neo_hrt.email('night')
                                       and source = 'phone' and time_source = 'device' and lat = 10.0159),
                         'a legacy punch goes to attendance_events only');
  r := public.record_field_activity(jsonb_build_object('client_request_id', v, 'kind', 'punch_in', 'at', neo_hrt.at(-3, '09:00')));
  perform neo_hrt.assert(r ->> 'duplicate' = 'true' and r ->> 'applied' = 'true', 'a legacy replay ' || r::text);
  r := public.record_field_activity(jsonb_build_object('client_request_id', gen_random_uuid(), 'kind', 'punch_in', 'at', neo_hrt.at(-3, '09:05')));
  perform neo_hrt.assert(r ->> 'applied' = 'false' and r ->> 'applied_note' = 'You''re already punched in.' and r ->> 'duplicate' = 'false',
                         'a legacy punch the sequence refuses: applied false with the sentence ' || r::text);
  r := public.record_field_activity(jsonb_build_object('client_request_id', gen_random_uuid(), 'kind', 'punch_out', 'at', '2019-01-01T00:00:00Z'));
  perform neo_hrt.assert(r ->> 'applied' = 'false' and r ->> 'applied_note' like 'The phone''s clock is wrong%', 'a legacy punch with a wrong clock ' || r::text);
  -- employee_email is ignored: always the caller
  r := public.record_field_activity(jsonb_build_object('client_request_id', gen_random_uuid(), 'kind', 'punch_out', 'at', neo_hrt.at(-3, '17:00'),
                                                       'employee_email', neo_hrt.email('tech')));
  perform neo_hrt.assert(r ->> 'applied' = 'true' and exists (select 1 from neo_hrt.ae where employee_email = neo_hrt.email('night')
                                                                and at = neo_hrt.at(-3, '17:00')), 'a legacy punch is always the caller''s');
  r := public.hr_my_day(neo_hrt.d(-3));
  perform neo_hrt.assert(r ->> 'status' = 'present' and (r ->> 'worked_min')::int = 480 and jsonb_array_length(r -> 'events') = 2,
                         'a punch sent through record_field_activity appears in hr_my_day ' || r::text);
  t := (select x.value from jsonb_array_elements(public.tech_activity(neo_hrt.d(-3), neo_hrt.d(-3))) x
         where x.value ->> 'employee_email' = neo_hrt.email('night'));
  perform neo_hrt.assert((t ->> 'punch_ins')::int = 1 and (t ->> 'punch_outs')::int = 1
                         and (t ->> 'first_at')::timestamptz = neo_hrt.at(-3, '09:00') and (t ->> 'last_at')::timestamptz = neo_hrt.at(-3, '17:00'),
                         'tech_activity counts attendance_events punches ' || coalesce(t::text, 'none'));
  t := (select x.value from jsonb_array_elements(public.tech_activity(neo_hrt.d(-6), neo_hrt.d(-6))) x
         where x.value ->> 'employee_email' = neo_hrt.email('night'));
  perform neo_hrt.assert((t ->> 'punch_ins')::int = 1 and (t ->> 'punch_outs')::int = 1,
                         'a punch sent through hr_punch appears in tech_activity ' || coalesce(t::text, 'none'));
  perform neo_hrt.assert(not exists (select 1 from jsonb_array_elements(public.tech_activity(neo_hrt.d(-6), neo_hrt.d(0))) x
                                      where x.value ->> 'employee_email' <> neo_hrt.email('night')),
                         'tech_activity: someone without a lead role sees only their own rows');
end $$;
-- a punch migrated from field_activity (both rows, same id) counts once; its replay is answered from field_activity
reset role;
select neo_hrt.no_jwt();
insert into public.field_activity (client_request_id, employee_email, employee_name, module, ref_type, kind, at, source, applied, applied_note)
values ('c0000000-0000-4000-8000-000000000001', 'zq.hr.night@neotokyo.test', 'Zqhr Night', 'neohr', 'attendance', 'punch_in',
        neo_hrt.at(-2, '09:00'), 'neohr', false, 'Recorded.');
insert into public.attendance_events (id, profile_id, employee_email, kind, at, device_at, time_source, source, note, created_by_email)
values ('c0000000-0000-4000-8000-000000000001', 'b2222222-0000-4000-8000-000000000008', 'zq.hr.night@neotokyo.test', 'punch_in',
        neo_hrt.at(-2, '09:00'), neo_hrt.at(-2, '09:00'), 'device', 'phone', 'migrated from field_activity', 'zq.hr.night@neotokyo.test');
select neo_hrt.login('night');
do $$
declare t jsonb; r jsonb;
begin
  t := (select x.value from jsonb_array_elements(public.tech_activity(neo_hrt.d(-2), neo_hrt.d(-2))) x
         where x.value ->> 'employee_email' = neo_hrt.email('night'));
  perform neo_hrt.assert((t ->> 'punch_ins')::int = 1, 'a migrated punch is counted once ' || coalesce(t::text, 'none'));
  r := public.record_field_activity(jsonb_build_object('client_request_id', 'c0000000-0000-4000-8000-000000000001', 'kind', 'punch_in',
                                                       'at', neo_hrt.at(-2, '09:00')));
  perform neo_hrt.assert(r ->> 'duplicate' = 'true' and r ->> 'applied_note' = 'Recorded.', 'a pre-v2.3 punch replayed: the old answer ' || r::text);
end $$;
select neo_hrt.login('lead');
do $$
begin
  perform neo_hrt.assert(exists (select 1 from jsonb_array_elements(public.tech_activity(neo_hrt.d(-6), neo_hrt.d(0))) x
                                  where x.value ->> 'employee_email' = neo_hrt.email('tech') and (x.value ->> 'punch_ins')::int >= 1),
                         'tech_activity: a NeoHR lead sees everyone''s punches');
end $$;
reset role;
select neo_hrt.no_jwt();
do $$
begin
  perform neo_hrt.assert(not exists (select 1 from public.field_activity fa where fa.kind in ('punch_in', 'punch_out')
                                      and not exists (select 1 from public.attendance_events ae where ae.id = fa.client_request_id)),
                         '§9.9.1 a: every legacy punch in field_activity is in attendance_events (same id)');
end $$;


-- ── 16. Row level security, role by role ────────────────────────────────────
select neo_hrt.login_anon();
do $$
declare t text;
begin
  foreach t in array array['hr_settings', 'hr_person', 'hr_shift_history', 'attendance_events', 'location_points', 'hr_requests', 'hr_roster',
                           'hr_ta_approvals', 'hr_day_km', 'hr_holidays', 'hr_route_views'] loop
    perform neo_hrt.expect_error(format('select count(*) from public.%I', t), '%permission denied%');
  end loop;
end $$;

reset role;
select neo_hrt.no_jwt();
-- What each role can read of someone else's records: [settings, holidays, tech's punches, tech's shift rows,
-- flex's requests, tech's roster, tech's person row, walk's allowance, walk's km rows, views of walk's route]
create function neo_hrt.try_count(p_sql text) returns int language plpgsql as $$
declare n int;
begin
  execute p_sql into n;
  return n;
exception when insufficient_privilege then
  return -1;
end $$;
grant execute on function neo_hrt.try_count(text) to authenticated;
create function neo_hrt.seen() returns int[] language sql volatile as $$
  select array[
    (select count(*) from public.hr_settings)::int,
    (select count(*) from public.hr_holidays where day = neo_hrt.d(2))::int,
    neo_hrt.try_count('select count(*) from public.attendance_events where employee_email = ''zq.hr.tech@neotokyo.test'''),
    (select count(*) from public.hr_shift_history where profile_id = 'b2222222-0000-4000-8000-000000000001')::int,
    (select count(*) from public.hr_requests where employee_email = 'zq.hr.flex@neotokyo.test')::int,
    (select count(*) from public.hr_roster where profile_id = 'b2222222-0000-4000-8000-000000000001')::int,
    (select count(*) from public.hr_person where profile_id = 'b2222222-0000-4000-8000-000000000001')::int,
    (select count(*) from public.hr_ta_approvals where profile_id = 'b2222222-0000-4000-8000-000000000002')::int,
    (select count(*) from public.hr_day_km where employee_email = 'zq.hr.walk@neotokyo.test')::int,
    (select count(*) from public.hr_route_views where subject_email = 'zq.hr.walk@neotokyo.test')::int]
$$;
grant execute on function neo_hrt.seen() to authenticated;
do $$
begin
  perform neo_hrt.assert(not exists (select 1 from unnest(neo_hrt.seen()) as x where x = 0), 'every probed table has rows (owner) ' || neo_hrt.seen()::text);
  perform neo_hrt.assert(exists (select 1 from public.hr_shift_history where profile_id is null), 'default shift rows exist');
end $$;

select neo_hrt.login('sales');
do $$
declare s int[] := neo_hrt.seen();
begin
  perform neo_hrt.assert(s = array[1, 1, -1, 0, 0, 0, 0, 0, 0, 0], 'tier-1 sales: settings and holidays only (punches: no direct read at all) ' || s::text);
  perform neo_hrt.assert(exists (select 1 from public.hr_shift_history where profile_id is null), 'staff read the default shift rows');
  perform neo_hrt.expect_error($q$select count(*) from public.location_points$q$, '%permission denied%');
end $$;
select neo_hrt.login('plain');
do $$
declare s int[] := neo_hrt.seen();
begin
  perform neo_hrt.assert(s = array[1, 1, -1, 0, 0, 0, 0, 0, 0, 0], 'a plain technician (NeoHR desk role): nobody else''s records ' || s::text);
end $$;
select neo_hrt.login('tech');
do $$
declare s int[] := neo_hrt.seen();
begin
  perform neo_hrt.assert(s[3] = -1 and s[4] > 0 and s[6] > 0 and s[7] = 1 and s[5] = 0 and s[8] = 0 and s[9] = 0 and s[10] = 0,
                         'the person: their own shift rows, roster and switches (punches only through the RPCs); nobody else''s ' || s::text);
  perform neo_hrt.assert((select count(*) from public.hr_route_views where subject_email = neo_hrt.email('tech')) >= 1,
                         'the person sees the views of their own route');
  perform neo_hrt.expect_error($q$select count(*) from public.location_points$q$, '%permission denied%');
  perform neo_hrt.expect_error(format('insert into public.attendance_events (id, employee_email, kind, at) values (%L, %L, %L, now())',
                                      gen_random_uuid(), neo_hrt.email('tech'), 'punch_in'), '%permission denied%');
end $$;
select neo_hrt.login('walk');
do $$
declare s int[] := neo_hrt.seen();
begin
  perform neo_hrt.assert(s[8] = 1 and s[9] > 0 and s[10] >= 1 and s[3] = -1, 'walk: own allowance, km rows and route views ' || s::text);
end $$;
select neo_hrt.login('lead');
do $$
declare s int[] := neo_hrt.seen();
begin
  perform neo_hrt.assert(s[3] = -1 and s[4] > 0 and s[5] > 0 and s[6] > 0 and s[7] = 1 and s[8] = 1 and s[9] > 0 and s[10] = 0,
                         'a NeoHR lead (tier 2): everyone''s attendance records (punches through the RPCs), but route views only at tier 4 ' || s::text);
  perform neo_hrt.expect_error($q$select count(*) from public.location_points$q$, '%permission denied%');
  perform neo_hrt.expect_error($q$delete from public.hr_requests$q$, '%permission denied%');
end $$;
select neo_hrt.login('head');
do $$
declare s int[] := neo_hrt.seen();
begin
  perform neo_hrt.assert(s[3] = -1 and s[5] > 0 and s[8] = 1 and s[10] = 0, 'tier 3: everyone''s records; route views only at tier 4 ' || s::text);
end $$;
select neo_hrt.login('ceo');
do $$
declare s int[] := neo_hrt.seen();
begin
  perform neo_hrt.assert(s[3] = -1 and s[5] > 0 and s[8] = 1 and s[10] >= 1, 'tier 4: everything, including who viewed whose route ' || s::text);
  perform neo_hrt.expect_error($q$update public.hr_settings set grace_min = 0$q$, '%permission denied%');
  perform neo_hrt.expect_error($q$select count(*) from public.location_points$q$, '%permission denied%');
end $$;
select neo_hrt.login('owner');
do $$
declare s int[] := neo_hrt.seen();
begin
  perform neo_hrt.assert(s[3] = -1 and s[10] >= 1, 'tier 5: everything (punches through the RPCs) ' || s::text);
end $$;


-- ── Done ────────────────────────────────────────────────────────────────────
reset role;
select neo_hrt.no_jwt();
select 'neohr-hr tests: all passed' as result;

rollback;
