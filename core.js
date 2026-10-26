/* Lift core: pure data logic (no DOM, no network). Loaded by index.html and by node tests. */
(function (root) {
  "use strict";

  const SCHEMA = 1;
  const PROFILES = [
    { key: "gav", name: "Gav" },
    { key: "bethany", name: "Bethany" },
  ];

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function normName(s) {
    return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
  }

  function emptyDoc() {
    return { schema: SCHEMA, routines: [], sessions: [] };
  }

  /* Seeds use fixed ids and updatedAt 0, so two phones seeding the same
     profile produce identical records and merge into one copy. */
  function seedDoc(profileKey) {
    const doc = emptyDoc();
    ["Push", "Pull", "Legs", "Upper"].forEach((name, i) => {
      doc.routines.push({
        id: "seed-" + name.toLowerCase(), name, order: i, updatedAt: 0, exercises: [],
      });
    });
    if (profileKey === "gav") {
      doc.routines[3].exercises.push({
        id: "seed-neck", name: "4-Way Neck", parts: ["Front", "Left", "Right", "Back"], sets: 2,
      });
    }
    return doc;
  }

  /* Record-level last-write-wins merge by id. Deletions are tombstones
     (deleted:true) so they win over stale copies on other phones. */
  function mergeList(a, b) {
    const map = new Map();
    for (const y of [...(a || []), ...(b || [])]) {
      const x = map.get(y.id);
      if (!x || (y.updatedAt || 0) > (x.updatedAt || 0)) map.set(y.id, y);
    }
    return [...map.values()];
  }

  /* ---------- in-progress workouts, shared live between phones ----------
     Merge only ever adds. Rules, all deterministic and order-independent:
     - doc.drafts is a map by workout id; two phones starting workouts can't overwrite each other.
     - every weight and every rep has its own edit time (wt, rt[i]); the newer edit of that one field wins.
     - sets have ids; adding on two phones keeps both; a deleted set comes back if anything in it is
       edited after the delete (dt).
     - state only moves forward: live < discarded < finished.
     - a finished workout's saved session is rebuilt from the merged workout, so sets that reach the
       file after Finish (from the other phone) still land in it — unless the session was edited or
       deleted by hand in History. */
  const RANK = { live: 0, discarded: 1, finished: 2 };

  function canon(x) {
    if (Array.isArray(x)) return "[" + x.map(canon).join(",") + "]";
    if (x && typeof x === "object") return "{" + Object.keys(x).filter((k) => x[k] !== undefined).sort()
      .map((k) => JSON.stringify(k) + ":" + canon(x[k])).join(",") + "}";
    return JSON.stringify(x === undefined ? null : x);
  }
  const pickNewer = (va, ta, vb, tb) => (tb > ta ? [vb, tb] : ta > tb ? [va, ta] : canon(vb) > canon(va) ? [vb, tb] : [va, ta]);

  function setTimes(x) { return Math.max(x.wt || 0, ...(x.rt || []).map((t) => t || 0)); }
  function setLive(x) { return !x.dt || setTimes(x) > x.dt; }
  function mergeSet(a, b) {
    const [w, wt] = pickNewer(a.w ?? null, a.wt || 0, b.w ?? null, b.wt || 0);
    const n = Math.max(a.reps.length, b.reps.length), reps = [], rt = [];
    for (let i = 0; i < n; i++) {
      const [v, t] = pickNewer(a.reps[i] ?? null, (a.rt || [])[i] || 0, b.reps[i] ?? null, (b.rt || [])[i] || 0);
      reps.push(v); rt.push(t);
    }
    const out = { id: a.id, c: Math.min(a.c ?? 0, b.c ?? 0), w, wt, reps, rt };
    const dt = Math.max(a.dt || 0, b.dt || 0); if (dt) out.dt = dt;
    return out;
  }
  const byOrder = (key) => (x, y) => (x[key] ?? 0) - (y[key] ?? 0) || (x.id || x.k) .localeCompare(y.id || y.k);
  function mergeEntry(a, b) {
    const m = new Map(a.sets.map((x) => [x.id, x]));
    for (const y of b.sets) m.set(y.id, m.has(y.id) ? mergeSet(m.get(y.id), y) : y);
    const base = canon({ ...a, sets: 0 }) >= canon({ ...b, sets: 0 }) ? a : b;
    return { ...base, sets: [...m.values()].sort(byOrder("c")) };
  }
  function mergeDraft(a, b) {
    if (!a) return b; if (!b) return a;
    const sa = RANK[a.state] ?? 0, sb = RANK[b.state] ?? 0;
    const state = sa >= sb ? a.state : b.state;
    const meta = canon({ ...a, entries: 0, state: 0, endedAt: 0, startedAt: 0, pruned: 0 }) >= canon({ ...b, entries: 0, state: 0, endedAt: 0, startedAt: 0, pruned: 0 }) ? a : b;
    const out = { ...meta, state, startedAt: Math.min(a.startedAt || 0, b.startedAt || 0) };
    const ended = Math.max(a.endedAt || 0, b.endedAt || 0); if (ended) out.endedAt = ended; else delete out.endedAt;
    if (a.pruned || b.pruned) { out.pruned = true; out.entries = []; return out; }
    delete out.pruned;
    const m = new Map(a.entries.map((e) => [e.k, e]));
    for (const e of b.entries) m.set(e.k, m.has(e.k) ? mergeEntry(m.get(e.k), e) : e);
    out.entries = [...m.values()].sort(byOrder("ord"));
    return out;
  }
  function mergeDrafts(a, b) {
    const out = {};
    for (const id of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) out[id] = mergeDraft((a || {})[id], (b || {})[id]);
    return out;
  }
  function lastEdit(d) {
    let t = 0;
    for (const e of d.entries || []) for (const x of e.sets) t = Math.max(t, setTimes(x), x.dt || 0);
    return t;
  }
  /* A discard only sticks if nothing was typed into the workout after it (e.g. on the other phone);
     otherwise the workout is open again. Finished is final. */
  function effState(d) {
    return d.state === "discarded" && !d.pruned && lastEdit(d) > (d.endedAt || 0) ? "live" : d.state;
  }
  function draftActivity(d) {
    let t = d.startedAt || 0;
    for (const e of d.entries || []) for (const x of e.sets) t = Math.max(t, setTimes(x), x.dt || 0);
    return Math.max(t, d.endedAt || 0);
  }
  function liveDrafts(doc) {
    const has = (d) => (d.entries || []).some((e) => e.sets.some((x) => setTimes(x) > 0)) ? 1 : 0;
    return Object.values((doc && doc.drafts) || {}).filter((d) => effState(d) === "live")
      .sort((x, y) => has(y) - has(x) || draftActivity(y) - draftActivity(x) || (x.id < y.id ? -1 : 1));
  }
  function currentDraft(doc) { return liveDrafts(doc)[0] || null; }
  function visibleSets(e) { return e.sets.filter(setLive); }

  /* edits (each stamps its own field) */
  function editW(x, v, now) { x.w = v; x.wt = now; }
  function editRep(x, i, v, now) { x.reps[i] = v; x.rt = x.rt || []; x.rt[i] = now; }
  function addSet(e, w, now) {
    const n = e.parts && e.parts.length ? e.parts.length : 1;
    e.sets.push({ id: "s" + uid(), c: now, w, wt: w === null ? 0 : now, reps: new Array(n).fill(null), rt: new Array(n).fill(0) });
  }
  function delSet(x, now) { x.dt = Math.max(now, setTimes(x) + 1); }
  function endDraft(d, state, now) {
    if ((RANK[state] ?? 0) >= (RANK[d.state] ?? 0)) d.state = state;
    d.endedAt = Math.max(d.endedAt || 0, now, lastEdit(d) + 1);
  }

  function draftToSession(d) {
    return finalizeDraft({ id: d.id, routineId: d.routineId, routineName: d.routineName, date: d.date,
      entries: d.entries.map((e) => ({ exId: e.exId, name: e.name, parts: e.parts || null, sets: visibleSets(e) })) }, draftActivity(d));
  }
  /* Rebuild sessions from finished workouts; deterministic given the merged doc. */
  function reconcile(doc) {
    for (const d of Object.values(doc.drafts || {})) {
      if (d.state !== "finished" || d.pruned) continue;
      const i = doc.sessions.findIndex((s) => s.id === d.id);
      const cur = i >= 0 ? doc.sessions[i] : null;
      // only sessions this rebuild made itself are rebuilt; a hand edit or delete (on any app version) is final
      if (cur && (!cur.derived || cur.deleted)) continue;
      const built = { ...draftToSession(d), derived: true };
      if (!built.entries.length && !cur) continue;
      if (i >= 0) doc.sessions[i] = built; else doc.sessions.push(built);
    }
    return doc;
  }
  /* Finished/discarded workouts older than this keep only a stub (their session is already saved). */
  function pruneDrafts(doc, now, ageMs = 60 * 864e5) {
    for (const d of Object.values(doc.drafts || {})) {
      if (effState(d) !== "live" && !d.pruned && (d.endedAt || 0) < now - ageMs) { d.pruned = true; d.entries = []; }
    }
  }
  /* A workout saved in this browser by the previous app version (localStorage lift.draft.<person>). */
  function migrateLegacyDraft(doc, old, now) {
    if (!old || !old.id || (doc.drafts && doc.drafts[old.id]) || doc.sessions.some((s) => s.id === old.id)) return false;
    const started = Date.parse(old.date) || now;
    doc.drafts = doc.drafts || {};
    doc.drafts[old.id] = { id: old.id, routineId: old.routineId, routineName: old.routineName, date: old.date,
      startedAt: started, state: "live",
      entries: (old.entries || []).map((e, ei) => ({ k: "m" + ei, ord: ei, exId: e.exId ?? null, name: e.name, parts: e.parts || null,
        wmode: e.wmode === "diff" ? "diff" : "same",
        sets: (e.sets || []).map((x, si) => ({ id: "s" + si, c: si, w: x.w ?? null, wt: x.w == null ? 0 : started,
          reps: (x.reps || []).slice(), rt: (x.reps || []).map((r) => (r == null ? 0 : started)) })) })) };
    return true;
  }

  function mergeSessions(a, b) {
    const manual = (s) => (!s.derived || s.deleted ? 1 : 0);
    const map = new Map();
    for (const y of [...(a || []), ...(b || [])]) {
      const x = map.get(y.id);
      if (!x) { map.set(y.id, y); continue; }
      const kx = [manual(x), x.updatedAt || 0], ky = [manual(y), y.updatedAt || 0];
      if (ky[0] > kx[0] || (ky[0] === kx[0] && (ky[1] > kx[1] || (ky[1] === kx[1] && canon(y) > canon(x))))) map.set(y.id, y);
    }
    return [...map.values()];
  }

  function mergeDocs(a, b) {
    a = a || emptyDoc();
    b = b || emptyDoc();
    const out = {
      schema: SCHEMA,
      routines: mergeList(a.routines, b.routines),
      sessions: mergeSessions(a.sessions, b.sessions),
    };
    const drafts = mergeDrafts(a.drafts, b.drafts);
    if (Object.keys(drafts).length) out.drafts = drafts;
    return reconcile(out);
  }

  function sameDoc(a, b) {
    const norm = (d) => canon({
      r: [...d.routines].sort((x, y) => (x.id < y.id ? -1 : 1)),
      s: [...d.sessions].sort((x, y) => (x.id < y.id ? -1 : 1)),
      d: d.drafts || {},
    });
    return norm(a) === norm(b);
  }

  function liveRoutines(doc) {
    return doc.routines.filter((r) => !r.deleted)
      .sort((x, y) => (x.order ?? 0) - (y.order ?? 0) || (x.name < y.name ? -1 : 1));
  }

  function liveSessions(doc) {
    return doc.sessions.filter((s) => !s.deleted)
      .sort((x, y) => (y.date < x.date ? -1 : y.date > x.date ? 1 : 0));
  }

  function partsOf(ex) {
    return ex && Array.isArray(ex.parts) && ex.parts.length ? ex.parts : null;
  }

  function nReps(ex) {
    const p = partsOf(ex);
    return p ? p.length : 1;
  }

  /* Most recent logged entry for an exercise, matched by name so the same
     lift in two routines (e.g. bench in Push and Upper) shares history. */
  function lastFor(doc, exName, excludeSessionId, beforeIso) {
    const key = normName(exName);
    for (const s of liveSessions(doc)) {
      if (s.id === excludeSessionId) continue;
      if (beforeIso && s.date >= beforeIso) continue;
      const e = s.entries.find((x) => normName(x.name) === key && x.sets.length);
      if (e) return { date: s.date, entry: e };
    }
    return null;
  }

  function totalReps(set) {
    return (set.reps || []).reduce((a, r) => a + (Number.isFinite(r) ? r : 0), 0);
  }

  function setFilled(set) {
    return (set.reps || []).some((r) => Number.isFinite(r) && r > 0);
  }

  /* Compare a set against the same-numbered set last time.
     Heavier wins; at equal weight, more total reps wins. */
  function compareSet(cur, last) {
    if (!cur || !last || !setFilled(cur) || !setFilled(last)) return null;
    const cw = cur.w ?? 0, lw = last.w ?? 0;
    if (cw > lw) return "up";
    if (cw < lw) return "down";
    const cr = totalReps(cur), lr = totalReps(last);
    return cr > lr ? "up" : cr < lr ? "down" : "same";
  }

  /* New workout: weights carried from last time, reps left blank to beat. */
  function newDraft(doc, routine, nowIso) {
    const started = Date.parse(nowIso) || Date.now();
    return {
      id: uid(), routineId: routine.id, routineName: routine.name, date: nowIso, startedAt: started, state: "live",
      entries: routine.exercises.map((ex, ei) => {
        const last = lastFor(doc, ex.name, null);
        const n = nReps(ex);
        const ws = last ? last.entry.sets.map((x) => x.w ?? null) : new Array(ex.sets || 3).fill(null);
        return { k: "e" + ei, ord: ei, exId: ex.id, name: ex.name, parts: partsOf(ex), wmode: ex.wmode === "diff" ? "diff" : "same",
          sets: ws.map((w, si) => ({ id: "s" + si, c: si, w, wt: 0, reps: new Array(n).fill(null), rt: new Array(n).fill(0) })) };
      }),
    };
  }

  /* Drop unfilled sets and empty exercises; returns a session record. */
  function finalizeDraft(draft, nowMs) {
    const entries = draft.entries
      .map((e) => ({
        exId: e.exId, name: e.name, parts: e.parts || null,
        sets: e.sets.filter(setFilled).map((s) => ({
          w: Number.isFinite(s.w) ? s.w : null,
          reps: s.reps.map((r) => (Number.isFinite(r) ? r : 0)),
        })),
      }))
      .filter((e) => e.sets.length);
    return {
      id: draft.id, routineId: draft.routineId, routineName: draft.routineName,
      date: draft.date, updatedAt: nowMs, entries,
    };
  }

  function fmtW(w) {
    if (w === null || w === undefined || !Number.isFinite(w)) return "BW";
    return String(Math.round(w * 100) / 100);
  }

  function fmtSet(set, parts) {
    const reps = parts ? set.reps.join("/") : String(set.reps[0] ?? 0);
    return fmtW(set.w) + "×" + reps;
  }

  /* "135×8, 135×7" ; identical consecutive sets collapse to "3×(135×8)". */
  function summarize(sets, parts) {
    const out = [];
    for (const s of sets) {
      const t = fmtSet(s, parts);
      const prev = out[out.length - 1];
      if (prev && prev.t === t) prev.n++;
      else out.push({ t, n: 1 });
    }
    return out.map((x) => (x.n > 1 ? x.n + "×(" + x.t + ")" : x.t)).join(", ");
  }

  function parseNum(v) {
    if (v === null || v === undefined) return null;
    const s = String(v).trim().replace(",", ".");
    if (s === "") return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  /* UTF-8 safe base64 for the GitHub contents API. */
  function b64encode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function b64decode(b64) {
    const bin = atob(String(b64).replace(/\s/g, ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function validDoc(d) {
    return !!d && typeof d === "object" && Array.isArray(d.routines) && Array.isArray(d.sessions);
  }

  const api = {
    SCHEMA, PROFILES, uid, normName, emptyDoc, seedDoc, mergeDocs, sameDoc, liveRoutines,
    liveSessions, partsOf, nReps, lastFor, totalReps, setFilled, compareSet, newDraft,
    finalizeDraft, mergeDraft, mergeDrafts, liveDrafts, currentDraft, visibleSets, editW, editRep, addSet, delSet,
    endDraft, effState, lastEdit, reconcile, pruneDrafts, migrateLegacyDraft, draftActivity, canon, fmtW, fmtSet, summarize, parseNum, b64encode, b64decode, validDoc,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LiftCore = api;
})(typeof self !== "undefined" ? self : this);
