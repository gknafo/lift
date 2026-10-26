"""Joint workout on one phone: both people's sets entered without leaving either workout."""
import json
from playwright.sync_api import sync_playwright, expect
from test_e2e import FakeGitHub, server, phone, setup_sync, set_row, shot, wait_synced  # noqa: F401

LEGS = [("Calf Press", 2, None), ("Leg Curl", 2, None), ("Adductor Machine", 2, "diff"),
        ("Walking Lunges", 2, None), ("Stiff-Legged Deadlift", 2, None), ("Leg Press", 2, "diff")]


def seed(gh):
    """Start from the real first-workout data shape: a saved RPU session for each person."""
    for who in ("gav", "bethany"):
        d = {"schema": 1, "routines": [
            {"id": "rpu-" + who, "name": "Rest Pause Upper", "order": 4, "updatedAt": 1, "exercises": [
                {"id": "rpu-0", "name": "Chest Press Machine", "sets": 3}]},
            {"id": "seed-legs", "name": "Legs", "order": 2, "updatedAt": 2, "exercises": [
                dict({"id": f"lg-{i}", "name": n, "sets": s}, **({"wmode": m} if m else {})) for i, (n, s, m) in enumerate(LEGS)]},
        ], "sessions": [{"id": "first-" + who, "routineId": "rpu-" + who, "routineName": "Rest Pause Upper",
                         "date": "2026-10-22T20:43:52.102Z", "updatedAt": 5, "entries": [
                             {"exId": "rpu-0", "name": "Chest Press Machine", "parts": None,
                              "sets": [{"w": 180 if who == "gav" else 30, "reps": [9]}]}]}]}
        gh.files[who + ".json"] = (json.dumps(d), "seed-" + who)


def test_joint_and_separate(server):
    gh = FakeGitHub(); seed(gh); errors = []
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        A = phone(b, gh, "A", server, errors)
        setup_sync(A)
        A.locator(".rcard", has_text="Legs").click()
        A.get_by_role("button", name="Start together with Bethany").click()
        expect(A.locator(".seg button.on")).to_have_text("Gav")
        expect(A.locator('.set[data-ei="0"]')).to_have_count(2)

        # Gav: calf press same weight carries down; adductor diff does not
        set_row(A, 0, 0, 200, [15])
        expect(A.locator('.set[data-ei="0"][data-si="1"] .w')).to_have_value("200")
        set_row(A, 2, 0, 110, [12])
        expect(A.locator('.set[data-ei="2"][data-si="1"] .w')).to_have_value("")
        set_row(A, 2, 1, 90, [14])

        # Switch to Bethany mid-workout: her own draft, Gav's numbers untouched
        A.locator(".seg button", has_text="Bethany").click()
        expect(A.locator(".seg button.on")).to_have_text("Bethany")
        expect(A.locator('.set[data-ei="0"][data-si="0"] .w')).to_have_value("")
        set_row(A, 0, 0, 90, [20])
        set_row(A, 5, 0, 180, [10]); set_row(A, 5, 1, 140, [12])
        expect(A.locator('.set[data-ei="5"][data-si="1"] .w')).to_have_value("140")
        shot(A, "10-joint-bethany.png")

        # Back to Gav: still there. Then reload the app: both still there.
        A.locator(".seg button", has_text="Gav").click()
        expect(A.locator('.set[data-ei="2"][data-si="1"] .w')).to_have_value("90")
        A.reload()
        expect(A.locator(".banner")).to_contain_text("Gav: Legs · Bethany: Legs")
        A.get_by_role("button", name="Resume").click()
        expect(A.locator('.set[data-ei="0"][data-si="1"] .w')).to_have_value("200")
        A.locator(".seg button", has_text="Bethany").click()
        expect(A.locator('.set[data-ei="5"][data-si="0"] .w')).to_have_value("180")

        # Nothing saved to GitHub until Finish
        assert len(gh.doc("gav.json")["sessions"]) == 1 and len(gh.doc("bethany.json")["sessions"]) == 1
        expect(A.get_by_role("button", name="Finish both")).to_be_visible()
        A.get_by_role("button", name="Finish both").click()
        wait_synced(A); A.wait_for_timeout(1200); A.evaluate("sync('gav'); sync('bethany')"); A.wait_for_timeout(1500)
        g, be = gh.doc("gav.json"), gh.doc("bethany.json")
        assert [s["id"] for s in g["sessions"]][0] == "first-gav", "first workout kept"
        assert [s["id"] for s in be["sessions"]][0] == "first-bethany", "first workout kept"
        gl = [s for s in g["sessions"] if s["routineName"] == "Legs"]; bl = [s for s in be["sessions"] if s["routineName"] == "Legs"]
        assert len(gl) == 1 and len(bl) == 1
        assert gl[0]["entries"][0]["sets"] == [{"w": 200, "reps": [15]}], "Gav calf: only filled set saved"
        assert gl[0]["entries"][1]["sets"] == [{"w": 110, "reps": [12]}, {"w": 90, "reps": [14]}]
        assert bl[0]["entries"][1]["sets"] == [{"w": 180, "reps": [10]}, {"w": 140, "reps": [12]}]
        assert gl[0]["entries"][0]["name"] == "Calf Press" and bl[0]["entries"][0]["sets"] == [{"w": 90, "reps": [20]}]

        # Separate workout: Gav alone; Bethany tab offers to join instead of closing Gav's
        A.get_by_role("button", name="Routines").click()
        A.get_by_role("button", name="Gav", exact=True).click()
        A.locator(".rcard", has_text="Rest Pause Upper").click()
        A.get_by_role("button", name="Start workout").click()
        set_row(A, 0, 0, 185, [8])
        A.locator(".seg button", has_text="Bethany").click()
        expect(A.locator(".rcard").first).to_contain_text("same as Gav")
        A.get_by_role("button", name="Back to Gav").click()
        expect(A.locator('.set[data-ei="0"][data-si="0"] .r')).to_have_value("8")
        expect(A.get_by_role("button", name="Finish & save")).to_be_visible()
        # Bethany joins late, enters nothing; Finish saves Gav and keeps Bethany's draft open
        A.locator(".seg button", has_text="Bethany").click()
        A.locator(".rcard", has_text="Rest Pause Upper").click()
        A.locator(".seg button", has_text="Gav").click()
        A.get_by_role("button", name="Finish both").click()
        expect(A.locator(".seg button.on")).to_have_text("Bethany")
        A.get_by_role("button", name="Discard").click()
        expect(A.locator(".rcard").first).to_be_visible()
        A.wait_for_timeout(1200); A.evaluate("sync('gav')"); A.wait_for_timeout(1500)
        assert len([s for s in gh.doc("gav.json")["sessions"] if s["routineName"] == "Rest Pause Upper"]) == 2
        assert len([s for s in gh.doc("bethany.json")["sessions"] if s["routineName"] == "Rest Pause Upper"]) == 1
        assert A.evaluate("Object.keys(localStorage).filter(k=>k.startsWith('lift.draft.'))") == []
        b.close()
    assert not errors, errors
