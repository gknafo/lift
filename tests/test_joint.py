"""Joint + separate within one workout: one phone, and two phones logging live."""
import json
from playwright.sync_api import sync_playwright, expect
from test_e2e import FakeGitHub, server, phone, setup_sync, set_row, shot, wait_synced  # noqa: F401

LEGS = [("Calf Press", 2, None), ("Leg Curl", 2, None), ("Adductor Machine", 2, "diff"),
        ("Walking Lunges", 2, None), ("Stiff-Legged Deadlift", 2, None), ("Leg Press", 2, "diff")]
FIRST = {"gav": 180, "bethany": 30}


def seed(gh):
    for who in ("gav", "bethany"):
        d = {"schema": 1, "routines": [
            {"id": "rpu-" + who, "name": "Rest Pause Upper", "order": 4, "updatedAt": 1, "exercises": [
                {"id": "rpu-0", "name": "Chest Press Machine", "sets": 3}]},
            {"id": "seed-legs", "name": "Legs", "order": 2, "updatedAt": 2, "exercises": [
                dict({"id": f"lg-{i}", "name": n, "sets": s}, **({"wmode": m} if m else {})) for i, (n, s, m) in enumerate(LEGS)]},
        ], "sessions": [{"id": "first-" + who, "routineId": "rpu-" + who, "routineName": "Rest Pause Upper",
                         "date": "2026-10-22T20:43:52.102Z", "updatedAt": 5, "entries": [
                             {"exId": "rpu-0", "name": "Chest Press Machine", "parts": None,
                              "sets": [{"w": FIRST[who], "reps": [9]}]}]}]}
        gh.files[who + ".json"] = (json.dumps(d), "seed-" + who)


def card(p, name):
    return p.locator(".card", has=p.locator(".exname", has_text=name))


def both_row(p, name, who_name, si):
    """In Both view: the set row for one person inside one exercise card."""
    c = card(p, name)
    who = {"Gav": "gav", "Bethany": "bethany"}[who_name]
    return c.locator(f'.set[data-who="{who}"][data-si="{si}"]')


def fill(row, w=None, reps=()):
    if w is not None:
        row.locator(".w").fill(str(w)); row.locator(".w").dispatch_event("change")
    for i, r in enumerate(reps):
        row.locator(f'.r[data-pi="{i}"]').fill(str(r))
    row.locator(".r").first.blur()


def settle(*phones):
    for p in phones:
        p.wait_for_timeout(900)
        p.evaluate("Promise.all([sync('gav'), sync('bethany')])")
        p.wait_for_timeout(600)


def check_first_workouts(gh):
    for who in ("gav", "bethany"):
        s = [x for x in gh.doc(who + ".json")["sessions"] if x["id"] == "first-" + who]
        assert len(s) == 1 and not s[0].get("deleted") and s[0]["entries"][0]["sets"][0]["w"] == FIRST[who], who


def test_one_phone_together_then_apart(server):
    gh = FakeGitHub(); seed(gh); errors = []
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        A = phone(b, gh, "A", server, errors)
        setup_sync(A)
        A.locator(".rcard", has_text="Legs").click()
        A.get_by_role("button", name="Start together with Bethany").click()
        expect(A.locator(".seg button.on")).to_have_text("Both")

        # Together: calf press, both people in one card
        expect(card(A, "Calf Press").locator(".who")).to_have_text(["Gav", "Bethany"])
        fill(both_row(A, "Calf Press", "Gav", 0), 200, [15])
        expect(both_row(A, "Calf Press", "Gav", 1).locator(".w")).to_have_value("200")
        expect(both_row(A, "Calf Press", "Bethany", 1).locator(".w")).to_have_value("")
        fill(both_row(A, "Calf Press", "Bethany", 0), 90, [20])
        fill(both_row(A, "Calf Press", "Gav", 1), None, [14])
        shot(A, "11-both-view.png")

        # Apart: leg curl on Gav's tab, then Bethany's tab; Both view still shows everything
        A.locator(".seg button", has_text="Gav").click()
        set_row(A, 1, 0, 80, [12])
        A.locator(".seg button", has_text="Bethany").click()
        set_row(A, 1, 0, 40, [15])
        A.locator(".seg button", has_text="Both").click()
        expect(both_row(A, "Leg Curl", "Gav", 0).locator(".r")).to_have_value("12")
        expect(both_row(A, "Leg Curl", "Bethany", 0).locator(".r")).to_have_value("15")
        expect(both_row(A, "Calf Press", "Gav", 1).locator(".r")).to_have_value("14")

        # Reload mid-workout: everything is still there
        A.reload()
        A.get_by_role("button", name="Resume").click()
        expect(A.locator(".seg button.on")).to_have_text("Both")
        expect(both_row(A, "Calf Press", "Bethany", 0).locator(".w")).to_have_value("90")

        A.get_by_role("button", name="Finish both").click()
        expect(A.locator(".toast")).to_contain_text("Gav 3 sets")
        settle(A)
        g = gh.doc("gav.json"); be = gh.doc("bethany.json")
        gl = [s for s in g["sessions"] if s["routineName"] == "Legs"]; bl = [s for s in be["sessions"] if s["routineName"] == "Legs"]
        assert len(gl) == 1 and len(bl) == 1
        assert gl[0]["entries"][0]["sets"] == [{"w": 200, "reps": [15]}, {"w": 200, "reps": [14]}]
        assert gl[0]["entries"][1]["sets"] == [{"w": 80, "reps": [12]}]
        assert bl[0]["entries"][0]["sets"] == [{"w": 90, "reps": [20]}]
        assert bl[0]["entries"][1]["sets"] == [{"w": 40, "reps": [15]}]
        assert all(d["state"] == "finished" for d in gh.doc("gav.live.json")["drafts"].values()) and all(d["state"] == "finished" for d in gh.doc("bethany.live.json")["drafts"].values())
        assert "drafts" not in g and "drafts" not in be, "main files stay old-version-shaped"
        check_first_workouts(gh)
        b.close()
    assert not errors, errors


def test_two_phones_live(server):
    gh = FakeGitHub(); seed(gh); errors = []
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        A = phone(b, gh, "A", server, errors)   # Gav's phone
        B = phone(b, gh, "B", server, errors)   # Bethany's phone
        setup_sync(A); setup_sync(B)
        A.locator(".rcard", has_text="Legs").click()
        A.get_by_role("button", name="Start together with Bethany").click()
        fill(both_row(A, "Calf Press", "Gav", 0), 200, [15])
        fill(both_row(A, "Calf Press", "Bethany", 0), 90, [20])   # Gav logs Bethany's set on his phone
        settle(A)

        # Bethany's phone picks up the live workout
        settle(B)
        B.reload()
        expect(B.locator(".banner")).to_contain_text("Gav: Legs · Bethany: Legs")
        B.get_by_role("button", name="Resume").click()
        expect(both_row(B, "Calf Press", "Bethany", 0).locator(".w")).to_have_value("90")

        # They split: each logs own leg curl at the same time on own phone.
        # Both phones offline while editing, so the edits really are concurrent.
        gh.offline.update({"A", "B"})
        A.locator(".seg button", has_text="Gav").click()
        B.locator(".seg button", has_text="Bethany").click()
        set_row(A, 1, 0, 80, [12]); A.locator(".r").first.blur()
        set_row(B, 1, 0, 40, [15]); B.locator(".r").first.blur()
        # and Bethany fixes her calf rep on her phone while Gav adds his second calf set on his
        B.locator(".seg button", has_text="Both").click()
        fill(both_row(B, "Calf Press", "Bethany", 0), None, [21])
        fill(A.locator('.set[data-who="gav"][data-ei="0"][data-si="1"]'), None, [14])
        # same-person collision: Gav, on his phone, logs Bethany's 2nd calf set while she logs leg curl on hers
        A.locator(".seg button", has_text="Both").click()
        fill(both_row(A, "Calf Press", "Bethany", 1), 90, [18])
        A.locator(".seg button", has_text="Gav").click()
        A.wait_for_timeout(1500)
        # nothing new reached GitHub while offline
        assert [d for d in gh.doc("bethany.live.json")["drafts"].values() if d["state"] == "live"][0]["entries"][1]["sets"][0]["reps"] == [None]
        gh.offline.clear()
        settle(A, B, A, B)

        # Each phone sees the other's edits
        A.locator(".seg button", has_text="Both").click()
        expect(both_row(A, "Leg Curl", "Bethany", 0).locator(".r")).to_have_value("15")
        expect(both_row(A, "Calf Press", "Bethany", 0).locator(".r")).to_have_value("21")
        expect(both_row(B, "Calf Press", "Gav", 1).locator(".r")).to_have_value("14", timeout=12000)
        expect(both_row(B, "Leg Curl", "Gav", 0).locator(".r")).to_have_value("12")

        # Gav finishes only himself; Bethany keeps going on her phone
        A.locator(".seg button", has_text="Gav").click()
        A.get_by_role("button", name="Finish Gav").click()
        settle(A, B)
        B.locator(".seg button", has_text="Bethany").click()
        set_row(B, 5, 0, 180, [10]); B.locator(".r").first.blur()
        B.get_by_role("button", name="Finish Bethany").click()
        settle(B, A)
        g = gh.doc("gav.json"); be = gh.doc("bethany.json")
        gl = [s for s in g["sessions"] if s["routineName"] == "Legs"]; bl = [s for s in be["sessions"] if s["routineName"] == "Legs"]
        assert len(gl) == 1 and len(bl) == 1, (len(gl), len(bl))
        assert gl[0]["entries"][0]["sets"] == [{"w": 200, "reps": [15]}, {"w": 200, "reps": [14]}]
        assert gl[0]["entries"][1]["sets"] == [{"w": 80, "reps": [12]}]
        names = [e["name"] for e in bl[0]["entries"]]
        assert names == ["Calf Press", "Leg Curl", "Leg Press"], names
        assert bl[0]["entries"][0]["sets"] == [{"w": 90, "reps": [21]}, {"w": 90, "reps": [18]}]
        assert bl[0]["entries"][1]["sets"] == [{"w": 40, "reps": [15]}]
        assert bl[0]["entries"][2]["sets"] == [{"w": 180, "reps": [10]}]
        check_first_workouts(gh)
        # both phones end on a clean state with no workout open
        for p in (A, B):
            p.goto(server); expect(p.locator(".banner:not(.warn)")).to_have_count(0)
        b.close()
    assert not errors, errors
