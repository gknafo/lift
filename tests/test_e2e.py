"""Two simulated iPhones against an in-memory fake of the GitHub contents API."""
import base64
import functools
import http.server
import json
import pathlib
import threading

import pytest
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parent.parent
SHOTS = pathlib.Path(__file__).resolve().parent / "shots"
REPO = "gknafo/lift-data"
TOKEN = "github_pat_TEST"


class FakeGitHub:
    def __init__(self):
        self.files = {}  # name -> (text, sha)
        self.n = 0
        self.puts = 0
        self.conflicts = 0
        self.offline = set()  # page ids that are "offline"
        self.race = None  # (page_id, file, fn): before that page's next PUT, another phone writes fn(doc)

    def handler(self, page_id):
        def handle(route, request):
            if page_id in self.offline:
                return route.abort("internetdisconnected")
            cors = {"access-control-allow-origin": "*", "access-control-allow-headers": "*",
                    "access-control-allow-methods": "GET,PUT,OPTIONS", "content-type": "application/json"}
            if request.method == "OPTIONS":
                return route.fulfill(status=204, headers=cors)
            if request.headers.get("authorization") != "Bearer " + TOKEN:
                return route.fulfill(status=401, headers=cors, body='{"message":"Bad credentials"}')
            path = request.url.split("/repos/" + REPO, 1)[1].split("?")[0]
            if path == "":
                return route.fulfill(status=200, headers=cors, body=json.dumps({"private": True, "permissions": {"push": True}}))
            name = path.removeprefix("/contents/")
            if request.method == "GET":
                if name not in self.files:
                    return route.fulfill(status=404, headers=cors, body='{"message":"Not Found"}')
                text, sha = self.files[name]
                b = base64.encodebytes(text.encode()).decode()  # wrapped with newlines like GitHub
                return route.fulfill(status=200, headers=cors, body=json.dumps(
                    {"encoding": "base64", "content": b, "sha": sha, "size": len(text.encode())}))
            if request.method == "PUT":
                body = json.loads(request.post_data)
                if self.race and self.race[0] == page_id and self.race[1] == name:
                    _, _, fn = self.race; self.race = None
                    d = self.doc(name); fn(d); self.n += 1
                    self.files[name] = (json.dumps(d), "sha%d" % self.n)
                cur = self.files.get(name)
                if (cur and body.get("sha") != cur[1]) or (not cur and body.get("sha")):
                    self.conflicts += 1
                    return route.fulfill(status=409, headers=cors, body='{"message":"sha mismatch"}')
                self.n += 1
                self.puts += 1
                sha = "sha%d" % self.n
                self.files[name] = (base64.b64decode(body["content"]).decode(), sha)
                return route.fulfill(status=200, headers=cors, body=json.dumps({"content": {"sha": sha}}))
            return route.abort()
        return handle

    def doc(self, name):
        return json.loads(self.files[name][0])


@pytest.fixture(scope="module")
def server():
    h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
    h.log_message = lambda *a: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d/index.html" % srv.server_address[1]
    srv.shutdown()


def phone(pw_browser, gh, pid, url, errors):
    iphone = {"viewport": {"width": 390, "height": 844}, "device_scale_factor": 2, "is_mobile": True, "has_touch": True}
    ctx = pw_browser.new_context(**iphone)
    ctx.route("https://api.github.com/**", gh.handler(pid))
    p = ctx.new_page()
    p.on("pageerror", lambda e: errors.append(f"{pid}: {e}"))
    p.on("dialog", lambda d: d.accept())
    p.goto(url)
    return p


def setup_sync(p):
    p.get_by_role("button", name="Settings").click()
    p.fill("#token", TOKEN)
    p.get_by_role("button", name="Save & test").click()
    expect(p.locator("#cfgmsg")).to_contain_text("Both profiles synced", timeout=8000)
    p.get_by_role("button", name="‹ Back").click()


def set_row(p, ex_index, set_index, weight=None, reps=()):
    row = p.locator(f'.set[data-ei="{ex_index}"][data-si="{set_index}"]')
    if weight is not None:
        row.locator(".w").fill(str(weight))
        row.locator(".w").dispatch_event("change")
    for i, r in enumerate(reps):
        row.locator(f'.r[data-pi="{i}"]').fill(str(r))
    return row


def shot(p, name):
    SHOTS.mkdir(exist_ok=True)
    p.screenshot(path=str(SHOTS / name), full_page=True)


def wait_synced(p):
    expect(p.locator("#sync")).to_have_text("Synced", timeout=8000)


def test_full_flow(server):
    gh = FakeGitHub()
    errors = []
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        A = phone(b, gh, "A", server, errors)

        # Before setup: local-only warning, seeded routines, neck in Gav's Upper only
        expect(A.locator(".warn")).to_be_visible()
        expect(A.locator(".rcard .nm")).to_have_text(["Push", "Pull", "Legs", "Upper"])
        shot(A, "01-home-unsynced.png")
        setup_sync(A)
        assert set(gh.files) == {"gav.json", "bethany.json"}
        assert gh.doc("gav.json")["routines"][3]["exercises"][0]["name"] == "4-Way Neck"
        assert gh.doc("bethany.json")["routines"][3]["exercises"] == []
        expect(A.locator(".warn")).to_have_count(0)

        # Edit Push: add two exercises
        A.locator(".rcard", has_text="Push").click()
        A.get_by_role("button", name="Edit").click()
        A.get_by_role("button", name="+ Add exercise").click()
        A.locator('[data-f="exname"]').last.fill("Bench Press")
        A.get_by_role("button", name="+ Add exercise").click()
        A.locator('[data-f="exname"]').last.fill("Incline DB Press")
        A.locator('[data-f="sets"]').last.fill("2")
        shot(A, "02-edit-routine.png")
        A.get_by_role("button", name="Save routine").click()
        expect(A.locator(".card .exname button")).to_have_text(["Bench Press", "Incline DB Press"])
        shot(A, "03-routine.png")

        # Workout 1: descending weights; third bench set left empty → dropped
        A.get_by_role("button", name="Start workout").click()
        expect(A.locator('.set[data-ei="0"]')).to_have_count(3)
        set_row(A, 0, 0, 185, [5])
        set_row(A, 0, 1, 155, [8])
        # carry-down: 185 filled sets 2-3, then 155 on set 2 re-filled only set 3
        expect(A.locator('.set[data-ei="0"][data-si="2"] .w')).to_have_value("155")
        set_row(A, 1, 0, 50, [10])
        set_row(A, 1, 1, None, [9])
        expect(A.locator('.set[data-ei="1"][data-si="1"] .w')).to_have_value("50")

        # Draft survives a reload mid-workout
        A.reload()
        expect(A.locator(".banner", has_text="Gav: Push")).to_be_visible()
        A.get_by_role("button", name="Resume").click()
        expect(A.locator('.set[data-ei="0"][data-si="0"] .w')).to_have_value("185")
        A.get_by_role("button", name="Finish Gav").click()
        expect(A.locator(".hist .d").first).to_contain_text("Push")
        wait_synced(A)
        sess = gh.doc("gav.json")["sessions"]
        assert len(sess) == 1
        bench = sess[0]["entries"][0]
        assert bench["sets"] == [{"w": 185, "reps": [5]}, {"w": 155, "reps": [8]}]
        assert sess[0]["entries"][1]["sets"] == [{"w": 50, "reps": [10]}, {"w": 50, "reps": [9]}]

        # 4-way neck in Upper: one weight, four rep fields, 2 sets by default
        A.get_by_role("button", name="Routines").click()
        A.locator(".rcard", has_text="Upper").click()
        A.get_by_role("button", name="Start workout").click()
        expect(A.locator('.set[data-ei="0"]')).to_have_count(2)
        expect(A.locator('.set[data-ei="0"][data-si="0"] .r')).to_have_count(4)
        set_row(A, 0, 0, 10, [12, 12, 10, 11])
        set_row(A, 0, 1, None, [12, 11, 10, 10])
        shot(A, "04-neck-workout.png")
        A.get_by_role("button", name="Finish Gav").click()
        wait_synced(A)
        neck = [s for s in gh.doc("gav.json")["sessions"] if s["routineName"] == "Upper"][0]["entries"][0]
        assert neck["sets"] == [{"w": 10, "reps": [12, 12, 10, 11]}, {"w": 10, "reps": [12, 11, 10, 10]}]
        expect(A.locator(".hist .l", has_text="4-Way Neck")).to_contain_text("10×12/12/10/11, 10×12/11/10/10")

        # Phone B: configure, sees Gav's history, adds Bethany's own routine
        B = phone(b, gh, "B", server, errors)
        setup_sync(B)
        B.get_by_role("button", name="History").click()
        expect(B.locator(".hist .d")).to_have_count(2)
        B.get_by_role("button", name="Bethany").click()
        expect(B.locator(".empty")).to_contain_text("No workouts logged for Bethany")
        B.get_by_role("button", name="Routines").click()
        B.locator(".rcard", has_text="Legs").click()
        B.get_by_role("button", name="Edit").click()
        B.get_by_role("button", name="+ Add exercise").click()
        B.locator('[data-f="exname"]').last.fill("Hip Thrust")
        B.get_by_role("button", name="Save routine").click()
        wait_synced(B)
        assert gh.doc("bethany.json")["routines"][2]["exercises"][0]["name"] == "Hip Thrust"
        assert len(gh.doc("gav.json")["sessions"]) == 2, "Bethany's edit must not touch Gav's file"

        # Beat-the-reps: second Push prefills weights, shows last reps, marks ▲ / ▼
        A.get_by_role("button", name="Routines").click()
        A.locator(".rcard", has_text="Push").click()
        A.get_by_role("button", name="Start workout").click()
        expect(A.locator('.set[data-ei="0"]')).to_have_count(2)
        expect(A.locator('.set[data-ei="0"][data-si="0"] .w')).to_have_value("185")
        expect(A.locator('.set[data-ei="0"][data-si="1"] .w')).to_have_value("155")
        expect(A.locator('.set[data-ei="0"][data-si="0"] .r')).to_have_attribute("placeholder", "5")
        expect(A.locator(".card", has_text="Bench Press").locator(".last")).to_contain_text("185×5, 155×8")
        set_row(A, 0, 0, None, [6])
        set_row(A, 0, 1, None, [7])
        expect(A.locator('.set[data-ei="0"][data-si="0"] .mk')).to_have_text("▲")
        expect(A.locator('.set[data-ei="0"][data-si="1"] .mk')).to_have_text("▼")
        shot(A, "05-beat-reps.png")

        # Concurrent edits to Gav's file: B (viewing Gav) renames Pull while A finishes Push
        B.get_by_role("button", name="‹ Back").click()
        B.get_by_role("button", name="Gav").click()
        B.locator(".rcard", has_text="Pull").click()
        B.get_by_role("button", name="Edit").click()
        B.locator('[data-f="name"]').fill("Pull A")
        A.get_by_role("button", name="Finish Gav").click()
        B.get_by_role("button", name="Save routine").click()
        wait_synced(A); wait_synced(B)
        A.wait_for_timeout(1500)
        A.evaluate("sync('gav')"); wait_synced(A)
        g = gh.doc("gav.json")
        assert len([s for s in g["sessions"] if not s.get("deleted")]) == 3
        assert any(r["name"] == "Pull A" for r in g["routines"])

        # Forced race: while B saves, "another phone" logs a workout first → 409 → B re-merges
        sneaked = {"id": "sneak", "routineId": "x", "routineName": "Sneaky", "date": "2026-10-21T10:00:00.000Z",
                   "updatedAt": 99, "entries": [{"exId": None, "name": "Curl", "parts": None, "sets": [{"w": 30, "reps": [12]}]}]}
        gh.race = ("B", "gav.json", lambda d: d["sessions"].append(sneaked))
        B.get_by_role("button", name="Edit").click()
        B.locator('[data-f="name"]').fill("Pull B")
        B.get_by_role("button", name="Save routine").click()
        wait_synced(B)
        assert gh.conflicts >= 1, "race never triggered"
        g = gh.doc("gav.json")
        assert any(x["id"] == "sneak" for x in g["sessions"]), "other phone's workout lost"
        assert any(r["name"] == "Pull B" for r in g["routines"]), "B's edit lost"
        assert len([x for x in g["sessions"] if not x.get("deleted")]) == 4
        A.evaluate("sync('gav')"); wait_synced(A)
        A.get_by_role("button", name="History").click()
        expect(A.locator(".hist", has_text="Sneaky")).to_have_count(1)

        # Offline at the gym: log a workout, it stays local, then syncs when back online
        gh.offline.add("A")
        A.get_by_role("button", name="Routines").click()
        A.locator(".rcard", has_text="Legs").click()
        A.get_by_role("button", name="Edit").click()
        A.get_by_role("button", name="+ Add exercise").click()
        A.locator('[data-f="exname"]').last.fill("Squat")
        A.get_by_role("button", name="Save routine").click()
        A.get_by_role("button", name="Start workout").click()
        set_row(A, 0, 0, 225, [5])
        A.get_by_role("button", name="Finish Gav").click()
        expect(A.locator("#sync")).to_contain_text("Offline", timeout=8000)
        assert not any(s["routineName"] == "Legs" for s in gh.doc("gav.json")["sessions"])
        gh.offline.discard("A")
        A.evaluate("window.dispatchEvent(new Event('online'))")
        wait_synced(A)
        assert any(s["routineName"] == "Legs" for s in gh.doc("gav.json")["sessions"])

        # Edit a past workout, then delete one; both propagate
        A.get_by_role("button", name="History").click()
        A.locator(".hist", has_text="Legs").click()
        set_row(A, 0, 0, None, [6])
        A.get_by_role("button", name="Save changes").click()
        wait_synced(A)
        legs = [s for s in gh.doc("gav.json")["sessions"] if s["routineName"] == "Legs"][0]
        assert legs["entries"][0]["sets"][0]["reps"] == [6]
        A.locator(".hist", has_text="Legs").click()
        A.get_by_role("button", name="Delete workout").click()
        wait_synced(A)
        assert [s for s in gh.doc("gav.json")["sessions"] if s["routineName"] == "Legs"][0]["deleted"] is True
        expect(A.locator(".hist", has_text="Legs")).to_have_count(0)

        # Exercise history view from a routine
        A.get_by_role("button", name="Routines").click()
        A.locator(".rcard", has_text="Push").click()
        A.get_by_role("button", name="Bench Press").click()
        expect(A.locator(".hist .l")).to_have_count(2)
        expect(A.locator(".card").first).to_contain_text("185×6")
        shot(A, "06-exercise-history.png")
        A.get_by_role("button", name="‹ Back").click()
        expect(A.get_by_role("button", name="Start workout")).to_be_visible()

        # Bad token message
        A.get_by_role("button", name="Settings").click()
        A.fill("#token", "wrong")
        A.get_by_role("button", name="Save & test").click()
        expect(A.locator("#cfgmsg")).to_contain_text("Token rejected")
        shot(A, "07-settings.png")

        # No horizontal overflow on a small phone
        A.set_viewport_size({"width": 320, "height": 640})
        A.fill("#token", TOKEN); A.get_by_role("button", name="Save & test").click()
        A.get_by_role("button", name="‹ Back").click()
        A.locator(".rcard", has_text="Upper").click()
        A.get_by_role("button", name="Start workout").click()
        assert A.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), "horizontal scroll at 320px"
        shot(A, "08-neck-320px.png")

        b.close()
    assert not errors, errors
    print("PUTs:", gh.puts, "conflicts resolved:", gh.conflicts)
