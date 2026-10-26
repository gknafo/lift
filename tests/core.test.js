const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../core.js");

const neck = { id: "n", name: "4-Way Neck", parts: ["Front", "Left", "Right", "Back"], sets: 2 };
const bench = { id: "b", name: "Bench Press", sets: 3 };

function sess(id, date, entries, extra = {}) {
  return { id, routineId: "r", routineName: "Push", date, updatedAt: 1, entries, ...extra };
}

test("seed: gav gets neck in Upper, bethany does not; seeds identical across calls", () => {
  const g = C.seedDoc("gav"), b = C.seedDoc("bethany");
  assert.deepEqual(g.routines.map((r) => r.name), ["Push", "Pull", "Legs", "Upper"]);
  assert.equal(g.routines[3].exercises[0].name, "4-Way Neck");
  assert.equal(g.routines[3].exercises[0].sets, 2);
  assert.equal(b.routines[3].exercises.length, 0);
  const m = C.mergeDocs(C.seedDoc("gav"), C.seedDoc("gav"));
  assert.equal(m.routines.length, 4, "two phones seeding must not duplicate routines");
});

test("merge: newer updatedAt wins; tombstone beats stale copy", () => {
  const a = { schema: 1, routines: [{ id: "x", name: "Old", updatedAt: 1, exercises: [] }], sessions: [] };
  const b = { schema: 1, routines: [{ id: "x", name: "New", updatedAt: 2, exercises: [] }], sessions: [] };
  assert.equal(C.mergeDocs(a, b).routines[0].name, "New");
  assert.equal(C.mergeDocs(b, a).routines[0].name, "New");
  const del = { schema: 1, routines: [{ id: "x", name: "New", updatedAt: 3, deleted: true, exercises: [] }], sessions: [] };
  assert.equal(C.liveRoutines(C.mergeDocs(b, del)).length, 0);
  assert.equal(C.liveRoutines(C.mergeDocs(del, b)).length, 0);
});

test("merge: random docs — commutative (by content), idempotent, keeps every id", () => {
  let seed = 42;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let iter = 0; iter < 500; iter++) {
    const mk = () => ({ schema: 1, routines: [], sessions: Array.from({ length: rnd(6) }, () =>
      ({ id: "s" + rnd(8), updatedAt: rnd(5) * 10 + rnd(3), deleted: rnd(4) === 0, date: "2026-10-0" + (1 + rnd(9)), entries: [] })) });
    // ensure ties on updatedAt carry identical content, as real edits always bump updatedAt
    const a = mk(), b = mk();
    const canonical = new Map();
    for (const s of [...a.sessions, ...b.sessions]) {
      const k = s.id + "@" + s.updatedAt;
      if (canonical.has(k)) Object.assign(s, canonical.get(k)); else canonical.set(k, { ...s });
    }
    const ab = C.mergeDocs(a, b), ba = C.mergeDocs(b, a);
    assert.ok(C.sameDoc(ab, ba), "commutative");
    assert.ok(C.sameDoc(C.mergeDocs(ab, ab), ab), "idempotent");
    const ids = new Set([...a.sessions, ...b.sessions].map((s) => s.id));
    assert.equal(ab.sessions.length, ids.size, "no id lost or duplicated");
    for (const s of ab.sessions) {
      const all = [...a.sessions, ...b.sessions].filter((x) => x.id === s.id);
      const manual = all.filter((x) => x.deleted || x.edited);
      const pool = manual.length ? manual : all; // a hand delete/edit beats any automatic version
      assert.equal(s.updatedAt, Math.max(...pool.map((x) => x.updatedAt)), "newest version kept");
      if (manual.length) assert.ok(s.deleted || s.edited);
    }
  }
});

test("merge: null / empty inputs", () => {
  assert.deepEqual(C.mergeDocs(null, null), C.emptyDoc());
  const g = C.seedDoc("gav");
  assert.ok(C.sameDoc(C.mergeDocs(g, null), g));
});

test("lastFor: most recent by date, by name across routines, skips deleted/excluded/empty", () => {
  const doc = { schema: 1, routines: [], sessions: [
    sess("old", "2026-10-01T10:00:00Z", [{ name: "Bench Press", sets: [{ w: 135, reps: [8] }] }]),
    sess("new", "2026-10-10T10:00:00Z", [{ name: "bench  press", sets: [{ w: 140, reps: [6] }] }]),
    sess("del", "2026-10-15T10:00:00Z", [{ name: "Bench Press", sets: [{ w: 999, reps: [1] }] }], { deleted: true }),
    sess("emp", "2026-10-16T10:00:00Z", [{ name: "Bench Press", sets: [] }]),
  ] };
  assert.equal(C.lastFor(doc, "Bench Press").entry.sets[0].w, 140);
  assert.equal(C.lastFor(doc, "Bench Press", "new").entry.sets[0].w, 135);
  assert.equal(C.lastFor(doc, "Squat"), null);
});

test("compareSet: weight first, then total reps; blanks give null", () => {
  assert.equal(C.compareSet({ w: 135, reps: [9] }, { w: 135, reps: [8] }), "up");
  assert.equal(C.compareSet({ w: 135, reps: [8] }, { w: 135, reps: [8] }), "same");
  assert.equal(C.compareSet({ w: 135, reps: [7] }, { w: 135, reps: [8] }), "down");
  assert.equal(C.compareSet({ w: 140, reps: [5] }, { w: 135, reps: [8] }), "up");
  assert.equal(C.compareSet({ w: 130, reps: [12] }, { w: 135, reps: [8] }), "down");
  assert.equal(C.compareSet({ w: 135, reps: [null] }, { w: 135, reps: [8] }), null);
  assert.equal(C.compareSet({ w: 135, reps: [8] }, undefined), null);
  assert.equal(C.compareSet({ w: null, reps: [10] }, { w: null, reps: [9] }), "up", "bodyweight");
  assert.equal(C.compareSet({ w: 10, reps: [10, 10, 9, 10] }, { w: 10, reps: [10, 10, 10, 10] }), "down", "neck sums parts");
});

test("newDraft: no history → default set counts, blank weights; neck has 4 rep slots", () => {
  const d = C.newDraft(C.emptyDoc(), { id: "u", name: "Upper", exercises: [neck, bench] }, "2026-10-22T12:00:00Z");
  assert.equal(d.entries[0].sets.length, 2);
  assert.equal(d.entries[0].sets[0].w, null); assert.deepEqual(d.entries[0].sets[0].reps, [null, null, null, null]);
  assert.equal(d.entries[1].sets.length, 3);
  assert.deepEqual(d.entries[1].sets[0].reps, [null]);
});

test("newDraft: history → copies last set count and weights (descending), reps blank", () => {
  const doc = { schema: 1, routines: [], sessions: [
    sess("a", "2026-10-20T10:00:00Z", [{ name: "Bench Press", sets: [{ w: 185, reps: [5] }, { w: 155, reps: [8] }] }]),
  ] };
  const d = C.newDraft(doc, { id: "p", name: "Push", exercises: [bench] }, "2026-10-22T12:00:00Z");
  assert.deepEqual(d.entries[0].sets.map((x) => [x.w, x.reps]), [[185, [null]], [155, [null]]]);
});

test("finalizeDraft: drops unfilled sets and empty exercises; blanks → 0 within a filled neck set", () => {
  const draft = { id: "d", routineId: "u", routineName: "Upper", date: "x", entries: [
    { exId: "n", name: "4-Way Neck", parts: neck.parts, sets: [{ w: 10, reps: [12, 12, null, 11] }, { w: 10, reps: [null, null, null, null] }] },
    { exId: "b", name: "Bench Press", parts: null, sets: [{ w: 135, reps: [null] }] },
  ] };
  const s = C.finalizeDraft(draft, 5);
  assert.equal(s.entries.length, 1);
  assert.deepEqual(s.entries[0].sets, [{ w: 10, reps: [12, 12, 0, 11] }]);
  assert.equal(s.updatedAt, 5);
});

test("summarize: collapses repeats, neck shows per-part reps, BW for no weight", () => {
  assert.equal(C.summarize([{ w: 135, reps: [8] }, { w: 135, reps: [8] }, { w: 115, reps: [10] }], null), "2×(135×8), 115×10");
  assert.equal(C.summarize([{ w: 10, reps: [12, 12, 10, 11] }], neck.parts), "10×12/12/10/11");
  assert.equal(C.summarize([{ w: null, reps: [10] }], null), "BW×10");
  assert.equal(C.summarize([{ w: 22.5, reps: [8] }], null), "22.5×8");
});

test("parseNum: blanks, commas, junk", () => {
  assert.equal(C.parseNum(""), null);
  assert.equal(C.parseNum("  "), null);
  assert.equal(C.parseNum("22,5"), 22.5);
  assert.equal(C.parseNum("135"), 135);
  assert.equal(C.parseNum("abc"), null);
  assert.equal(C.parseNum(null), null);
  assert.equal(C.parseNum("-20"), -20);
});

test("base64 round-trip: unicode, emoji, large doc", () => {
  for (const s of ["", "plain", "Gav’s “neck” — ×✓", "💪🏋️", JSON.stringify(C.seedDoc("gav")).repeat(2000)]) {
    assert.equal(C.b64decode(C.b64encode(s)), s);
  }
  // GitHub returns base64 wrapped with newlines
  const wrapped = C.b64encode("hello world, this is wrapped").replace(/(.{10})/g, "$1\n");
  assert.equal(C.b64decode(wrapped), "hello world, this is wrapped");
});

test("validDoc", () => {
  assert.ok(C.validDoc(C.emptyDoc()));
  assert.ok(!C.validDoc(null));
  assert.ok(!C.validDoc({ routines: [] }));
  assert.ok(!C.validDoc("x"));
});

test("lastFor beforeIso: editing an old workout compares to the one before it", () => {
  const doc = { schema: 1, routines: [], sessions: [
    { id: "a", date: "2026-10-01T10:00:00Z", updatedAt: 1, entries: [{ name: "Row", sets: [{ w: 100, reps: [8] }] }] },
    { id: "b", date: "2026-10-05T10:00:00Z", updatedAt: 1, entries: [{ name: "Row", sets: [{ w: 110, reps: [8] }] }] },
    { id: "c", date: "2026-10-09T10:00:00Z", updatedAt: 1, entries: [{ name: "Row", sets: [{ w: 120, reps: [8] }] }] },
  ] };
  assert.equal(C.lastFor(doc, "Row", "b", "2026-10-05T10:00:00Z").entry.sets[0].w, 100);
  assert.equal(C.lastFor(doc, "Row", "a", "2026-10-01T10:00:00Z"), null);
});

test("newDraft carries wmode; default same", () => {
  const d = C.newDraft(C.emptyDoc(), { id: "l", name: "Legs", exercises: [
    { id: "a", name: "Adductor Machine", sets: 2, wmode: "diff" }, { id: "c", name: "Calf Press", sets: 2 }] }, "2026-10-26T12:00:00Z");
  assert.equal(d.entries[0].wmode, "diff");
  assert.equal(d.entries[1].wmode, "same");
  assert.equal(C.finalizeDraft({ ...d, entries: [{ ...d.entries[0], sets: [{ w: 90, reps: [10] }] }] }, 1).entries[0].wmode, undefined, "sessions don't store wmode");
});


/* ---------- live workouts across phones (incl. the reviewer's F1–F8 scenarios) ---------- */
const R = { id: "legs", name: "Legs", exercises: [{ id: "e1", name: "Squat", sets: 3 }, { id: "e2", name: "Curl", sets: 3 },
  { id: "e3", name: "4-Way Neck", sets: 2, parts: ["F", "L", "R", "B"] }] };
const cl = (x) => JSON.parse(JSON.stringify(x));
function docWith(t) { const d = C.seedDoc("gav"); const dr = C.newDraft(d, R, new Date(t).toISOString()); d.drafts = { [dr.id]: dr }; return [d, dr.id]; }
const S = (doc, id, ei, si) => doc.drafts[id].entries[ei].sets[si];
const log = (x, w, r, t) => { C.editW(x, w, t); C.editRep(x, 0, r, t); };
const sessOf = (doc, id) => doc.sessions.find((x) => x.id === id);
const finish = (doc, id, t) => { C.endDraft(doc.drafts[id], "finished", t); C.reconcile(doc); };

test("F1: set logged on phone B before Finish on phone A lands in the saved session", () => {
  const [A, id] = docWith(1000), B = cl(A);
  log(S(A, id, 0, 0), 225, 8, 2000);
  log(S(B, id, 0, 2), 200, 5, 5000);
  finish(A, id, 6000);
  for (const m of [C.mergeDocs(B, A), C.mergeDocs(A, B)]) {
    const s = sessOf(m, id);
    assert.deepEqual(s.entries[0].sets, [{ w: 225, reps: [8] }, { w: 200, reps: [5] }]);
  }
});

test("F2: two phones start workouts with different ids → both kept, nothing replaced", () => {
  const [A, idA] = docWith(1000); log(S(A, idA, 0, 0), 225, 8, 2000);
  const [B, idB] = docWith(2500);
  const m = C.mergeDocs(A, B);
  assert.equal(C.liveDrafts(m).length, 2);
  assert.equal(S(m, idA, 0, 0).w, 225);
  assert.equal(C.currentDraft(m).id, idA, "the one with logged sets is shown");
});

test("F3: delete set on A, fill same set later on B → set comes back with B's numbers", () => {
  const [A, id] = docWith(1000), B = cl(A);
  C.delSet(S(A, id, 0, 2), 2000);
  log(S(B, id, 0, 2), 135, 10, 3000);
  const e = C.mergeDocs(A, B).drafts[id].entries[0];
  assert.equal(C.visibleSets(e).length, 3);
  assert.equal(C.visibleSets(e)[2].w, 135);
  // and a delete after the fill wins
  C.delSet(S(B, id, 0, 2), 4000);
  assert.equal(C.visibleSets(C.mergeDocs(A, B).drafts[id].entries[0]).length, 2);
});

test("F4: both phones add a set → both added sets kept", () => {
  const [A, id] = docWith(1000), B = cl(A);
  C.addSet(A.drafts[id].entries[0], 100, 2000); log(A.drafts[id].entries[0].sets[3], 100, 10, 2000);
  C.addSet(B.drafts[id].entries[0], 90, 2001); log(B.drafts[id].entries[0].sets[3], 90, 12, 2001);
  const e = C.mergeDocs(A, B).drafts[id].entries[0];
  assert.equal(C.visibleSets(e).length, 5);
  assert.deepEqual(C.visibleSets(e).slice(3).map((x) => x.w).sort(), [100, 90].sort());
});

test("F5: weight on one phone, reps on the other, same set → both kept", () => {
  const [A, id] = docWith(1000), B = cl(A);
  C.editW(S(A, id, 0, 0), 185, 2000);
  C.editRep(S(B, id, 0, 0), 0, 8, 2001);
  for (const m of [C.mergeDocs(A, B), C.mergeDocs(B, A)]) assert.deepEqual([S(m, id, 0, 0).w, S(m, id, 0, 0).reps[0]], [185, 8]);
});

test("F5b: 4-way neck — different directions entered on different phones all kept", () => {
  const [A, id] = docWith(1000), B = cl(A);
  C.editW(S(A, id, 2, 0), 25, 2000); C.editRep(S(A, id, 2, 0), 0, 16, 2000); C.editRep(S(A, id, 2, 0), 2, 12, 2002);
  C.editRep(S(B, id, 2, 0), 1, 12, 2001); C.editRep(S(B, id, 2, 0), 3, 15, 2003);
  assert.deepEqual(S(C.mergeDocs(A, B), id, 2, 0).reps, [16, 12, 12, 15]);
});

test("F6: both phones finish the same workout → one session with everything", () => {
  const [A, id] = docWith(1000), B = cl(A);
  log(S(A, id, 0, 0), 225, 8, 2000); finish(A, id, 3000);
  log(S(B, id, 1, 0), 30, 12, 2000); finish(B, id, 3001);
  const m = C.mergeDocs(A, B);
  assert.equal(m.sessions.filter((x) => x.id === id).length, 1);
  assert.deepEqual(sessOf(m, id).entries.map((e) => e.name), ["Squat", "Curl"]);
  assert.ok(C.canon(m) === C.canon(C.mergeDocs(B, A)), "commutative");
});

test("F7: finished workout can't come back; offline edit folds into its session; new workout untouched", () => {
  const [A, X] = docWith(1000), B = cl(A);
  log(S(A, X, 0, 0), 1, 1, 1500); finish(A, X, 2000);
  const z = C.newDraft(A, R, new Date(3000).toISOString()); A.drafts[z.id] = z; log(A.drafts[z.id].entries[0].sets[0], 300, 5, 3500);
  log(S(B, X, 1, 0), 30, 12, 4000);          // B offline, still on X
  const m = C.mergeDocs(A, B);
  assert.equal(m.drafts[X].state, "finished");
  assert.equal(C.currentDraft(m).id, z.id);
  assert.equal(S(m, z.id, 0, 0).w, 300);
  assert.deepEqual(sessOf(m, X).entries.map((e) => e.name), ["Squat", "Curl"]);
});

test("F8: clock skew — a finished tombstone never kills a different workout", () => {
  const [A, X] = docWith(1000); log(S(A, X, 0, 0), 5, 5, 1100); finish(A, X, 10000);
  const [B, Y] = docWith(9000); log(S(B, Y, 0, 0), 1, 1, 9500);
  assert.equal(C.currentDraft(C.mergeDocs(B, A)).id, Y);
});

test("History edit / delete of a session is never overwritten by its workout", () => {
  const [A, id] = docWith(1000), B = cl(A);
  log(S(A, id, 0, 0), 225, 8, 2000); finish(A, id, 3000);
  const ed = cl(A); const s = sessOf(ed, id); s.entries[0].sets[0].reps = [9]; s.edited = true; s.updatedAt = 9000;
  log(S(B, id, 1, 0), 30, 12, 9500);          // late set from other phone after the edit
  assert.deepEqual(sessOf(C.mergeDocs(ed, B), id).entries[0].sets[0].reps, [9]);
  const del = cl(A); sessOf(del, id).deleted = true; sessOf(del, id).updatedAt = 9000;
  assert.equal(sessOf(C.mergeDocs(B, del), id).deleted, true);
  assert.equal(sessOf(C.mergeDocs(del, B), id).deleted, true);
});

test("discard on one phone + finish on the other → finished (data kept)", () => {
  const [A, id] = docWith(1000), B = cl(A);
  log(S(A, id, 0, 0), 225, 8, 2000); finish(A, id, 3000);
  C.endDraft(B.drafts[id], "discarded", 4000);
  assert.equal(C.mergeDocs(B, A).drafts[id].state, "finished");
  assert.ok(sessOf(C.mergeDocs(B, A), id));
});

test("prune: old finished workouts shrink to a stub; stale full copy can't resurrect content", () => {
  const [A, id] = docWith(1000), B = cl(A);
  log(S(A, id, 0, 0), 225, 8, 2000); finish(A, id, 3000);
  const old = cl(A); C.pruneDrafts(old, 3000 + 15 * 864e5);
  assert.equal(old.drafts[id].pruned, true);
  const m = C.mergeDocs(old, B);
  assert.equal(m.drafts[id].pruned, true);
  assert.equal(sessOf(m, id).entries[0].sets[0].w, 225, "session kept");
  const live = C.seedDoc("gav"); const d = C.newDraft(live, R, new Date(1000).toISOString()); live.drafts = { [d.id]: d };
  C.pruneDrafts(live, 1e13); assert.equal(live.drafts[d.id].pruned, undefined, "open workouts never pruned");
});

test("legacy localStorage draft migrates; skipped if its session already exists", () => {
  const d = C.seedDoc("bethany");
  const old = { id: "old1", routineId: "r", routineName: "Rest Pause Upper", date: "2026-10-22T20:35:56.348Z",
    entries: [{ exId: "x", name: "Chest Press Machine", parts: null, sets: [{ w: 30, reps: [10] }, { w: null, reps: [null] }] }] };
  assert.ok(C.migrateLegacyDraft(d, old, 5));
  assert.equal(C.currentDraft(d).id, "old1");
  assert.equal(C.visibleSets(d.drafts.old1.entries[0])[0].w, 30);
  const d2 = C.seedDoc("bethany"); d2.sessions.push({ id: "old1", entries: [], date: "x", updatedAt: 1 });
  assert.equal(C.migrateLegacyDraft(d2, old, 5), false);
});

test("PROPERTY: two phones, random edits/adds/deletes/finishes with random sync points — commutative, idempotent, no edit lost", () => {
  let seed = 11; const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let iter = 0; iter < 600; iter++) {
    const [base, id] = docWith(1000);
    const ph = [cl(base), cl(base)];
    let clock = 2000;
    const lastField = new Map(); // "ei:setId:field" -> {v, t}
    let finished = false;
    for (let step = 0; step < 16; step++) {
      const p = ph[rnd(2)], d = p.drafts[id], ei = rnd(3), e = d.entries[ei];
      const op = rnd(10), t = clock++;
      if (op < 6) {
        const vis = C.visibleSets(e); if (!vis.length) continue;
        const x = vis[rnd(vis.length)];
        if (rnd(2)) { const v = rnd(300); C.editW(x, v, t); lastField.set(`${ei}:${x.id}:w`, { v, t }); }
        else { const i = rnd(x.reps.length), v = rnd(20); C.editRep(x, i, v, t); lastField.set(`${ei}:${x.id}:r${i}`, { v, t }); }
      } else if (op < 8) { C.addSet(e, null, t); }
      else if (op < 9) { const vis = C.visibleSets(e); if (vis.length) C.delSet(vis[rnd(vis.length)], t); }
      else if (!finished && step > 10) { C.endDraft(d, "finished", t); C.reconcile(p); finished = true; }
      if (rnd(4) === 0) { const m = C.mergeDocs(ph[0], ph[1]); ph[0] = cl(m); ph[1] = cl(m); }
    }
    const m1 = C.mergeDocs(ph[0], ph[1]), m2 = C.mergeDocs(ph[1], ph[0]);
    assert.equal(C.canon(m1), C.canon(m2), "commutative @" + iter);
    assert.equal(C.canon(C.mergeDocs(m1, m1)), C.canon(m1), "idempotent");
    assert.equal(C.canon(C.mergeDocs(C.mergeDocs(m1, ph[0]), ph[1])), C.canon(m1), "absorbs inputs");
    for (const [key, { v, t }] of lastField) {
      const [ei, sid, f] = key.split(":");
      const x = m1.drafts[id].entries[+ei].sets.find((y) => y.id === sid);
      assert.ok(x, "set vanished " + key);
      const got = f === "w" ? [x.w, x.wt] : [x.reps[+f.slice(1)], x.rt[+f.slice(1)]];
      assert.ok(got[1] >= t, "edit lost " + key);
      if (got[1] === t) assert.equal(got[0], v);
    }
    if (finished) {
      const s = sessOf(m1, id); const fromDraft = C.canon(m1.drafts[id].entries.map((e) => C.visibleSets(e).filter(C.setFilled).map((x) => [x.w, x.reps.map((r) => r ?? 0)])).filter((a) => a.length));
      assert.ok(s, "finished workout has a session");
      assert.equal(C.canon(s.entries.map((e) => e.sets.map((x) => [x.w, x.reps]))), fromDraft, "session == merged workout");
    }
  }
});
