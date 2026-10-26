"""The data-loss scenarios found in review, driven through the real UI on simulated phones."""
import json
from playwright.sync_api import sync_playwright, expect
from test_e2e import FakeGitHub, server, phone, setup_sync, set_row  # noqa: F401
from test_joint import seed, settle, check_first_workouts, card, both_row, fill


def legs_sessions(gh, who):
    return [s for s in gh.doc(who + ".json")["sessions"] if s["routineName"] == "Legs" and not s.get("deleted")]


def test_stale_phone_start_together_keeps_both(server):
    """#2: Gav logs offline; Bethany's phone can't see it and taps Start together → nothing of Gav's is lost."""
    gh = FakeGitHub(); seed(gh); errors = []
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        A = phone(b, gh, "A", server, errors); B = phone(b, gh, "B", server, errors)
        setup_sync(A); setup_sync(B)
        gh.offline.add("A")
        A.locator(".rcard", has_text="Legs").click(); A.get_by_role("button", name="Start workout").click()
        set_row(A, 0, 0, 200, [15]); set_row(A, 1, 0, 80, [12]); A.locator(".r").first.blur()
        B.get_by_role("button", name="Bethany").click()
        B.locator(".rcard", has_text="Legs").click(); B.get_by_role("button", name="Start together with Gav").click()
        settle(B)
        gh.offline.clear(); settle(A, B, A)
        live = [d for d in gh.doc("gav.live.json")["drafts"].values() if d["state"] == "live"]
        assert len(live) == 2, len(live)
        # both phones show Gav's logged workout, and flag the empty one
        for p in (A, B):
            p.evaluate("sync('gav')"); p.wait_for_timeout(800)
            p.locator(".seg button", has_text="Gav").click()
            expect(p.locator('.set[data-ei="0"][data-si="0"] .w')).to_have_value("200")
            expect(p.locator(".banner", has_text="Gav also has Legs open (0 sets)")).to_be_visible()
        A.get_by_role("button", name="Discard").nth(0).click()   # banner's Discard for the empty copy
        A.get_by_role("button", name="Finish Gav").click(); settle(A)
        assert legs_sessions(gh, "gav")[0]["entries"][0]["sets"] == [{"w": 200, "reps": [15]}]
        check_first_workouts(gh); b.close()
    assert not errors, errors


def test_finish_on_other_phone_keeps_late_set(server):
    """#3: Bethany taps Finish both while Gav's last set hasn't synced from his phone → it lands in his session."""
    gh = FakeGitHub(); seed(gh); errors = []
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        A = phone(b, gh, "A", server, errors); B = phone(b, gh, "B", server, errors)
        setup_sync(A); setup_sync(B)
        A.locator(".rcard", has_text="Legs").click(); A.get_by_role("button", name="Start together with Bethany").click()
        fill(both_row(A, "Calf Press", "Gav", 0), 200, [15]); fill(both_row(A, "Calf Press", "Bethany", 0), 90, [20])
        settle(A, B)
        B.reload(); B.get_by_role("button", name="Resume").click()
        gh.offline.add("A")
        fill(both_row(A, "Calf Press", "Gav", 1), None, [13])          # last set, stuck on Gav's phone
        B.get_by_role("button", name="Finish both").click(); settle(B)
        assert legs_sessions(gh, "gav")[0]["entries"][0]["sets"] == [{"w": 200, "reps": [15]}]
        gh.offline.clear(); settle(A, B)
        assert legs_sessions(gh, "gav")[0]["entries"][0]["sets"] == [{"w": 200, "reps": [15]}, {"w": 200, "reps": [13]}]
        assert len(legs_sessions(gh, "gav")) == 1 and len(legs_sessions(gh, "bethany")) == 1
        A.get_by_role("button", name="History").click() if A.locator(".tabs").count() else None
        check_first_workouts(gh); b.close()
    assert not errors, errors


def test_typing_survives_remote_replacement(server):
    """#1: while Gav types, a sync brings in a second workout for him → keystrokes still go to the one on screen."""
    gh = FakeGitHub(); seed(gh); errors = []
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        A = phone(b, gh, "A", server, errors); setup_sync(A)
        A.locator(".rcard", has_text="Legs").click(); A.get_by_role("button", name="Start workout").click()
        set_row(A, 0, 0, 200, [15]); settle(A)
        on_screen = A.evaluate("getDraft('gav').id")
        # another phone starts Rest Pause Upper for Gav and logs a set (written straight into the file)
        d = gh.doc("gav.live.json"); rid = "other-wk"
        d["drafts"][rid] = {"id": rid, "routineId": "rpu-gav", "routineName": "Rest Pause Upper", "date": "2026-10-26T18:00:00.000Z",
            "startedAt": 9e12, "state": "live", "entries": [{"k": "e0", "ord": 0, "exId": "rpu-0", "name": "Chest Press Machine",
            "parts": None, "wmode": "same", "sets": [{"id": "s0", "c": 0, "w": 185, "wt": 9e12, "reps": [8], "rt": [9e12]}]}]}
        gh.n += 1; gh.files["gav.live.json"] = (json.dumps(d), "sha%d" % gh.n)
        inp = A.locator('.set[data-ei="1"][data-si="0"] .w'); inp.click()
        A.evaluate("sync('gav')"); A.wait_for_timeout(800)               # arrives mid-typing
        inp.press_sequentially("80"); A.locator('.set[data-ei="1"][data-si="0"] .r').fill("12"); A.locator('.set[data-ei="1"][data-si="0"] .r').blur()
        settle(A)
        d = gh.doc("gav.live.json")["drafts"]
        assert d[on_screen]["entries"][1]["sets"][0]["w"] == 80 and d[on_screen]["entries"][1]["sets"][0]["reps"] == [12]
        assert d[rid]["entries"][0]["sets"][0]["w"] == 185 and len(d[rid]["entries"]) == 1, "other workout untouched"
        check_first_workouts(gh); b.close()
    assert not errors, errors


def test_old_version_draft_migrates_without_clobbering(server):
    """#4: a phone still holding an old-version open workout in localStorage upgrades while another workout is live."""
    gh = FakeGitHub(); seed(gh); errors = []
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        A = phone(b, gh, "A", server, errors); setup_sync(A)
        A.locator(".rcard", has_text="Legs").click(); A.get_by_role("button", name="Start workout").click()
        set_row(A, 0, 0, 150, [10]); settle(A)
        B = phone(b, gh, "B", server, errors)
        B.evaluate("""localStorage.setItem('lift.cfg', JSON.stringify({repo:'gknafo/lift-data', token:'github_pat_TEST'}));
          localStorage.setItem('lift.draft.gav', JSON.stringify({id:'OLD', routineId:'rpu-gav', routineName:'Rest Pause Upper',
          date:'2026-10-22T20:00:00.000Z', entries:[{exId:'rpu-0', name:'Chest Press Machine', parts:null, sets:[{w:170,reps:[7]}]}]}))""")
        B.reload(); settle(B, A)
        d = gh.doc("gav.live.json")["drafts"]
        live = {k: v for k, v in d.items() if v["state"] == "live"}
        assert "OLD" in live and len(live) == 2
        mine = [v for k, v in live.items() if k != "OLD"][0]
        assert mine["entries"][0]["sets"][0]["w"] == 150, "live workout intact"
        expect(A.locator('.set[data-ei="0"][data-si="0"] .w')).to_have_value("150")
        check_first_workouts(gh); b.close()
    assert not errors, errors


def test_old_version_save_cannot_strip_open_workouts(server):
    """An old-version phone rewrites gav.json without open workouts; finished ones must not come back as live."""
    gh = FakeGitHub(); seed(gh); errors = []
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        A = phone(b, gh, "A", server, errors); B = phone(b, gh, "B", server, errors)
        setup_sync(A); setup_sync(B)
        A.locator(".rcard", has_text="Legs").click(); A.get_by_role("button", name="Start workout").click()
        set_row(A, 0, 0, 200, [15]); settle(A, B)                       # B now holds a live copy
        gh.offline.add("B")
        set_row(A, 0, 1, None, [13]); A.get_by_role("button", name="Finish Gav").click(); settle(A)
        # old-version phone saves gav.json in its old shape (no drafts key at all)
        main = gh.doc("gav.json"); main.pop("drafts", None); main["routines"][0]["name"] = "Rest Pause Upper"
        gh.n += 1; gh.files["gav.json"] = (json.dumps(main), "sha%d" % gh.n)
        gh.offline.clear(); B.reload(); settle(B, A)
        assert not [d for d in gh.doc("gav.live.json")["drafts"].values() if d["state"] == "live"], "finished workout came back"
        expect(B.locator(".banner:not(.warn)")).to_have_count(0)
        s = [x for x in gh.doc("gav.json")["sessions"] if x["routineName"] == "Legs"]
        assert len(s) == 1 and s[0]["entries"][0]["sets"] == [{"w": 200, "reps": [15]}, {"w": 200, "reps": [13]}]
        check_first_workouts(gh); b.close()
    assert not errors, errors


def test_discard_warns_about_sets_from_other_phone(server):
    gh = FakeGitHub(); seed(gh); errors = []; seen = []
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        A = phone(b, gh, "A", server, errors); B = phone(b, gh, "B", server, errors)
        setup_sync(A); setup_sync(B)
        A.locator(".rcard", has_text="Legs").click(); A.get_by_role("button", name="Start workout").click(); settle(A, B)
        B.reload(); B.get_by_role("button", name="Resume").click()
        set_row(B, 0, 0, 200, [15]); set_row(B, 1, 0, 80, [12]); B.locator(".r").first.blur(); settle(B)
        def on_dialog(d): seen.append(d.message)
        A.on("dialog", on_dialog)
        A.get_by_role("button", name="Discard").click(); A.wait_for_timeout(4000)
        assert any("2 logged sets" in m for m in seen), seen
        # the harness auto-accepts dialogs, so the discard went through: it must have been informed, and the sets stay on file
        ds = list(gh.doc("gav.live.json")["drafts"].values())
        assert len(ds) == 1 and ds[0]["state"] == "discarded"
        assert sum(1 for e in ds[0]["entries"] for x in e["sets"] if any(r for r in x["reps"] if r)) == 2
        b.close()
    assert not errors, errors
