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

  function mergeDocs(a, b) {
    a = a || emptyDoc();
    b = b || emptyDoc();
    return {
      schema: SCHEMA,
      routines: mergeList(a.routines, b.routines),
      sessions: mergeList(a.sessions, b.sessions),
    };
  }

  function sameDoc(a, b) {
    const canon = (d) => JSON.stringify({
      r: [...d.routines].sort((x, y) => (x.id < y.id ? -1 : 1)),
      s: [...d.sessions].sort((x, y) => (x.id < y.id ? -1 : 1)),
    });
    return canon(a) === canon(b);
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
    return {
      id: uid(),
      routineId: routine.id,
      routineName: routine.name,
      date: nowIso,
      isNew: true,
      entries: routine.exercises.map((ex) => {
        const last = lastFor(doc, ex.name, null);
        const n = nReps(ex);
        let sets;
        if (last) {
          sets = last.entry.sets.map((s) => ({ w: s.w ?? null, reps: new Array(n).fill(null) }));
        } else {
          sets = Array.from({ length: ex.sets || 3 }, () => ({ w: null, reps: new Array(n).fill(null) }));
        }
        return { exId: ex.id, name: ex.name, parts: partsOf(ex), wmode: ex.wmode === "diff" ? "diff" : "same", sets };
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
    finalizeDraft, fmtW, fmtSet, summarize, parseNum, b64encode, b64decode, validDoc,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LiftCore = api;
})(typeof self !== "undefined" ? self : this);
