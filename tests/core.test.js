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
      const max = Math.max(...[...a.sessions, ...b.sessions].filter((x) => x.id === s.id).map((x) => x.updatedAt));
      assert.equal(s.updatedAt, max, "newest version kept");
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
  assert.deepEqual(d.entries[0].sets[0], { w: null, reps: [null, null, null, null] });
  assert.equal(d.entries[1].sets.length, 3);
  assert.deepEqual(d.entries[1].sets[0], { w: null, reps: [null] });
});

test("newDraft: history → copies last set count and weights (descending), reps blank", () => {
  const doc = { schema: 1, routines: [], sessions: [
    sess("a", "2026-10-20T10:00:00Z", [{ name: "Bench Press", sets: [{ w: 185, reps: [5] }, { w: 155, reps: [8] }] }]),
  ] };
  const d = C.newDraft(doc, { id: "p", name: "Push", exercises: [bench] }, "2026-10-22T12:00:00Z");
  assert.deepEqual(d.entries[0].sets, [{ w: 185, reps: [null] }, { w: 155, reps: [null] }]);
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
