import sys, pathlib; sys.path.insert(0, str(pathlib.Path(__file__).parent))
import json
from playwright.sync_api import sync_playwright, expect
from test_e2e import FakeGitHub, server, phone, setup_sync, set_row  # noqa: F401
from test_joint import seed, settle


def test_discard_on_A_trashes_B_typed_sets(server):
    """A sees 'Nothing entered' and discards; B had just logged Gav sets on the same workout."""
    gh = FakeGitHub(); seed(gh); errors = []
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        A = phone(b, gh, "A", server, errors); B = phone(b, gh, "B", server, errors)
        setup_sync(A); setup_sync(B)
        A.locator(".rcard", has_text="Legs").click(); A.get_by_role("button", name="Start workout").click()
        settle(A, B); B.reload(); B.get_by_role("button", name="Resume").click()
        gh.offline.add("B")                      # B's 1st set hasn't reached the file yet (or 700ms debounce)
        set_row(B, 0, 0, 200, [15])
        A.get_by_role("button", name="Finish Gav").click()   # dialog: "Nothing entered for Gav. Discard?" -> accepted
        settle(A)
        gh.offline.clear()
        B.locator('.set[data-ei="0"][data-si="1"] .r').focus()   # B is mid-entry on set 2
        B.evaluate("sync('gav')"); B.wait_for_timeout(1200)
        B.locator('.set[data-ei="0"][data-si="1"] .r').fill("14")  # still accepted, into a discarded workout
        B.wait_for_timeout(1500); B.evaluate("sync('gav')"); B.wait_for_timeout(800)
        d = gh.doc("gav.json")
        legs = [s for s in d["sessions"] if s["routineName"] == "Legs"]
        live = [x for x in gh.doc("gav.live.json")["drafts"].values() if x["state"] == "live"]
        states = [(x["state"], sum(1 for e in x["entries"] for s in e["sets"] if any(r for r in s["reps"] if r))) for x in gh.doc("gav.live.json")["drafts"].values()]
        print("drafts(state, filled sets):", states, "legs sessions:", len(legs), "B view:", B.locator("h1").inner_text())
        b.close()
        assert legs or live, "B's 2 logged sets are neither saved nor open"


def test_view_flips_between_two_open_workouts_and_minus_set_hits_other(server):
    gh = FakeGitHub(); seed(gh); errors = []
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        A = phone(b, gh, "A", server, errors); B = phone(b, gh, "B", server, errors)
        setup_sync(A); setup_sync(B)
        gh.offline.update({"A", "B"})
        A.locator(".rcard", has_text="Legs").click(); A.get_by_role("button", name="Start workout").click()
        set_row(A, 0, 0, 200, [15]); set_row(A, 0, 1, 200, [14]); A.locator(".r").first.blur()
        B.locator(".rcard", has_text="Legs").click(); B.get_by_role("button", name="Start workout").click()
        B.wait_for_timeout(50); set_row(B, 0, 0, 150, [10]); set_row(B, 0, 1, 150, [9]); B.locator(".r").first.blur()
        gh.offline.clear(); settle(B, A)
        mine = A.evaluate("getDraft('gav').id")
        print("A rows show draft:", A.locator('.set').first.get_attribute('data-d'), "active:", A.evaluate("document.activeElement.tagName"), "drafts:", A.evaluate("JSON.stringify(Object.values(doc('gav').drafts).map(d=>[d.id,d.state,C.draftActivity(d)]))"))
        print("A screen calf set1 weight now:", A.locator('.set[data-ei="0"][data-si="0"] .w').input_value())
        # A taps "- Set" on Calf Press while looking at its own workout
        A.locator(".card", has_text="Calf Press").get_by_role("button", name="− Set").click(); settle(A, B)
        d = gh.doc("gav.live.json")["drafts"]
        dels = {k: [s["id"] for e in v["entries"] for s in e["sets"] if s.get("dt")] for k, v in d.items()}
        print("current draft on A:", mine, "deleted sets per draft:", dels)
        b.close()


def test_bottom_discard_hits_other_phones_workout(server):
    gh = FakeGitHub(); seed(gh); errors = []
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        A = phone(b, gh, "A", server, errors); B = phone(b, gh, "B", server, errors)
        setup_sync(A); setup_sync(B)
        gh.offline.update({"A", "B"})
        A.locator(".rcard", has_text="Legs").click(); A.get_by_role("button", name="Start workout").click()
        set_row(A, 0, 0, 200, [15]); set_row(A, 0, 1, 200, [14]); A.locator(".r").first.blur()
        B.locator(".rcard", has_text="Legs").click(); B.get_by_role("button", name="Start workout").click()
        B.wait_for_timeout(50); set_row(B, 0, 0, 150, [10]); set_row(B, 0, 1, 150, [9]); B.locator(".r").first.blur()
        gh.offline.clear(); settle(B, A)
        mine = A.evaluate("getDraft('gav').id")
        print("A rows show draft:", A.locator('.set').first.get_attribute('data-d'), "active:", A.evaluate("document.activeElement.tagName"), "drafts:", A.evaluate("JSON.stringify(Object.values(doc('gav').drafts).map(d=>[d.id,d.state,C.draftActivity(d)]))"))
        print("A screen calf set1 weight now:", A.locator('.set[data-ei="0"][data-si="0"] .w').input_value())
        # A taps "- Set" on Calf Press while looking at its own workout
        A.get_by_role("button", name="Discard", exact=True).last.click(); settle(A, B)
        d = gh.doc("gav.live.json")["drafts"]
        print("after A taps bottom Discard:", {k: (v["state"], [s["w"] for e in v["entries"][:1] for s in e["sets"]]) for k, v in d.items()})
        b.close()
