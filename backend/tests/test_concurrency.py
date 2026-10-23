# Several people pressing the controls at the same moment, say from their phones: fires bursts of
# simultaneous requests at the playlist routes and checks the queue ends up in one sensible state.
#
# Runs entirely in this process against a fresh, empty playlist with its log in a temporary file,
# so the server's live queue, playlist_log.jsonl and MongoDB are never touched: MongoDB clients are
# replaced before anything imports them (any call that slips through fails loudly), the queue
# settings, names, blocked songs and the YouTube lookup are stubbed, and the admin login is skipped.
#
# Run from the backend folder:  .venv/bin/python tests/test_concurrency.py
import asyncio
import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class NoMongo:
    # Stands in for every MongoDB client, collection and call; awaiting it raises.
    def __init__(self, *args, **kwargs):
        pass

    def __getitem__(self, key):
        return self

    def __getattr__(self, key):
        return self

    def __call__(self, *args, **kwargs):
        return self


import pymongo  # noqa: E402

pymongo.MongoClient = NoMongo
pymongo.AsyncMongoClient = NoMongo

import httpx  # noqa: E402

import main  # noqa: E402
from auth import require_admin  # noqa: E402
from models import NameEntry  # noqa: E402
from name import name as name_module  # noqa: E402
from playlist import playlist as routes  # noqa: E402
from playlist.playlist_store import Playlist  # noqa: E402

LOG_DIR = tempfile.mkdtemp(prefix="karole-test-")
SETTINGS = {"open": True, "pause_before_songs": False, "auto_play": False, "auto_play_seconds": 10}


async def fake_settings():
    await asyncio.sleep(0.01)  # a real MongoDB read yields too, letting other requests in
    return dict(SETTINGS)


class NoBlockedSongs:
    async def find_one(self, *args, **kwargs):
        await asyncio.sleep(0.01)
        return None


async def fake_read_name(body, *args, **kwargs):
    await asyncio.sleep(0.01)
    return {"entry": NameEntry(name_id=500, name=body.name, name_alt=[], blacklist=False)}


def fake_video_info(url):
    time.sleep(0.2)  # the YouTube lookup is slow, which is when two adds overlap
    return {"title": "Test video", "duration": 200, "uploader": "Test channel"}


routes.read_queue_settings = fake_settings
routes.blocked_col = NoBlockedSongs()
REAL_EXTRACT_VIDEO_INFO = routes.extract_video_info
routes.extract_video_info = fake_video_info
routes.extract_channel_icon_url = lambda url: None
name_module.read_name = fake_read_name
main.app.dependency_overrides[require_admin] = lambda: {"admin": True}


def fresh_queue(song_count: int = 6, current: int | None = 0, playing: bool = True) -> Playlist:
    store = Playlist(os.path.join(LOG_DIR, f"log-{time.time_ns()}.jsonl"))
    for number in range(song_count):
        store.add_song(
            {
                "name_id": number,
                "time": 1000 + number,
                "name": f"Singer {number}",
                "song_name": f"Song {number}",
                "service": "youtube",
                "url": f"https://www.youtube.com/watch?v=video{number:06d}",
                "url_id": f"video{number:06d}",
                "url_creator": "Test channel",
                "youtube_title": f"Video {number}",
                "url_channel_icon": None,
                "duration": 200,
                "is_too_long": False,
                "file_loc": None,
                "is_downloaded": False,
            },
            1,
        )
    if current is not None:
        store.jump(current)
        store.playing = playing
    routes.playlist_store = store
    return store


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)
    print(f"  ok  {message}")


def each_song_once(store: Playlist, expected: int) -> None:
    ids = [song.p_id for song in store.songs]
    check(len(ids) == expected and len(set(ids)) == expected, f"all {expected} songs are there, each once")
    check([song.order_num for song in store.songs] == list(range(len(ids))), "places are numbered 0, 1, 2... with no gaps")


async def burst(client: httpx.AsyncClient, requests: list[tuple[str, str, dict]]) -> list[httpx.Response]:
    return await asyncio.gather(*(client.request(method, url, **options) for method, url, options in requests))


async def main_test() -> None:
    transport = httpx.ASGITransport(app=main.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        print("10 people press Play at once (song paused)")
        store = fresh_queue(playing=False)
        answers = await burst(client, [("POST", "/playlist/play", {})] * 10)
        check(all(answer.status_code == 200 for answer in answers), "every press answered 200")
        check(store.playing is True, "still playing afterwards, not toggled back off")

        print("10 people press Pause at once")
        await burst(client, [("POST", "/playlist/pause", {})] * 10)
        check(store.playing is False, "paused afterwards")

        print("Play and Pause pressed together, 10 times each")
        store = fresh_queue(playing=False)
        requests = [("POST", "/playlist/play", {}), ("POST", "/playlist/pause", {})] * 10
        answers = await burst(client, requests)
        check(all(answer.status_code == 200 for answer in answers), "every press answered 200")
        check(store.current_song is not None and store.current_song.p_id == 0, "still on the same song")

        print("10 people press Skip on song 0 at once")
        store = fresh_queue()
        answers = await burst(client, [("POST", "/playlist/skip?from_p_id=0", {})] * 10)
        check(all(answer.status_code == 200 for answer in answers), "every press answered 200")
        check(store.current_song.p_id == 1, "moved on one song (to song 1), not ten")
        each_song_once(store, 6)

        print("For comparison, 3 Skips without from_p_id still each skip (older callers)")
        store = fresh_queue()
        await burst(client, [("POST", "/playlist/skip", {})] * 3)
        check(store.current_song.p_id == 3, "three plain skips move three songs")

        print("Back and Skip pressed together on song 2, 5 times each")
        store = fresh_queue(current=2)
        requests = [("POST", "/playlist/back?from_p_id=2", {}), ("POST", "/playlist/skip?from_p_id=2", {})] * 5
        await burst(client, requests)
        check(store.current_song.p_id in (1, 3), f"moved exactly one song either way (now song {store.current_song.p_id})")
        each_song_once(store, 6)

        print("Skip pressed on a song after someone already skipped it is ignored")
        store = fresh_queue(current=3)
        answer = await client.post("/playlist/skip?from_p_id=2")
        check(answer.status_code == 200 and answer.json()["song"]["p_id"] == 3, "nothing changed; the current song comes back")

        print("Jump to song 4 by p_id while someone deletes song 1 (which moves song 4 up a place)")
        store = fresh_queue()
        answers = await burst(client, [
            ("DELETE", "/playlist/delete?playlist_id=1", {}),
            ("POST", "/playlist/jump", {"json": {"p_id": 4}}),
        ])
        check([answer.status_code for answer in answers] == [200, 200], "both answered 200")
        check(store.current_song.p_id == 4, "landed on song 4, the song that was tapped")
        each_song_once(store, 5)

        print("Jump to a song that someone deletes at the same moment")
        store = fresh_queue()
        answers = await burst(client, [
            ("DELETE", "/playlist/delete?playlist_id=5", {}),
            ("POST", "/playlist/jump", {"json": {"p_id": 5}}),
        ])
        check(answers[1].status_code in (200, 404), f"the jump answered {answers[1].status_code}, no crash")
        check(store.current_song is not None and store.current_song.p_id != 5 or answers[1].status_code == 200,
              "never left on the deleted song")
        each_song_once(store, 5)

        print("Jump by place to the last song while someone deletes a song (older callers)")
        store = fresh_queue()
        answers = await burst(client, [
            ("DELETE", "/playlist/delete?playlist_id=0", {}),
            ("POST", "/playlist/jump", {"json": {"order_num": 5}}),
        ])
        check(answers[1].status_code in (200, 404), f"the jump answered {answers[1].status_code}, not a server error")

        print("Swap songs 2 and 3 by p_id while someone moves song 3 to the top")
        store = fresh_queue()
        answers = await burst(client, [
            ("POST", "/playlist/move", {"json": {"p_id": 3, "order_num": 0}}),
            ("POST", "/playlist/swap", {"json": {"p_id": 2, "swap_p_id": 3}}),
        ])
        check([answer.status_code for answer in answers] == [200, 200], "both answered 200")
        check({song["p_id"] for song in answers[1].json()} == {2, 3}, "the swap answered with songs 2 and 3")
        each_song_once(store, 6)

        print("Two people add the same video at the same moment")
        store = fresh_queue()
        body = {"url": "https://www.youtube.com/watch?v=dupVideo123", "name": "Alex", "song_name": "Same song"}
        answers = await burst(client, [("POST", "/playlist/add", {"json": body})] * 2)
        codes = sorted(answer.status_code for answer in answers)
        check(codes == [200, 400], f"one added, one turned away (answers {codes})")
        check(sum(song.url_id == "dupVideo123" for song in store.songs) == 1, "the video is in the queue once")
        each_song_once(store, 7)

        print("A mixed storm: 40 presses of every kind at once")
        store = fresh_queue(song_count=8)
        requests = []
        for round_number in range(5):
            requests += [
                ("POST", "/playlist/play", {}),
                ("POST", "/playlist/pause", {}),
                ("POST", "/playlist/skip?from_p_id=0", {}),
                ("POST", "/playlist/back?from_p_id=0", {}),
                ("POST", "/playlist/jump", {"json": {"p_id": 6}}),
                ("POST", "/playlist/swap", {"json": {"p_id": 1, "swap_p_id": 2}}),
                ("POST", "/playlist/move", {"json": {"p_id": 7, "order_num": round_number}}),
                ("DELETE", f"/playlist/delete?playlist_id={4 if round_number == 0 else 99}", {}),
            ]
        answers = await burst(client, requests)
        check(all(answer.status_code < 500 for answer in answers), "no server errors")
        each_song_once(store, 7)
        check(store.current_song is None or store.current_song in store.songs, "the current song is in the queue")

    await position_test()
    await login_cookie_test()
    await main_screen_test()
    await add_fallback_test()
    await real_length_test()
    print("\nAll checks passed. Temporary logs were written to", LOG_DIR)


async def add_fallback_test() -> None:
    # Adding a song tries, in turn: yt-dlp, yt-dlp with the cookies file, YouTube's Data API, and
    # finally nothing (added with the typed song name as its title). Each step is made to fail here.
    import io
    import json as json_module
    import urllib.error
    from yt_dlp.utils import DownloadError

    real = (routes.extract_video_info, routes.urlopen, routes.YoutubeDL)
    environment = {key: os.environ.get(key) for key in ("YOUTUBE_API_KEY", "YTDLP_COOKIE_FILE")}
    api_calls = []

    def refused(url):
        raise DownloadError("ERROR: [youtube] x: Sign in to confirm you're not a bot")

    def age_restricted(url):
        raise DownloadError("ERROR: [youtube] x: Sign in to confirm your age")

    def api_answers(payload):
        def fake_urlopen(request, timeout=None):
            api_calls.append(request.full_url)
            if isinstance(payload, Exception):
                raise payload
            return io.BytesIO(json_module.dumps(payload).encode())
        return fake_urlopen

    def api_item(rating=None):
        details = {"duration": "PT3M25S"}
        if rating:
            details["contentRating"] = {"ytRating": rating}
        return {"items": [{"snippet": {"title": "From the API", "channelTitle": "API channel", "channelId": "UCabc"},
                           "contentDetails": details}]}

    def body(video_id, song_name="Typed song name"):
        return {"url": f"https://www.youtube.com/watch?v={video_id}", "name": "Alex", "song_name": song_name}

    def added(store, video_id):
        return [song for song in store.songs if song.url_id == video_id]

    try:
        print("Reading the API's lengths")
        check(routes.parse_iso_duration("PT3M25S") == 205 and routes.parse_iso_duration("PT1H2M5S") == 3725
              and routes.parse_iso_duration("PT45S") == 45 and routes.parse_iso_duration("P1DT1S") == 86401,
              "PT3M25S, PT1H2M5S, PT45S and P1DT1S are read right")
        check(routes.parse_iso_duration("P0D") is None and routes.parse_iso_duration(None) is None
              and routes.parse_iso_duration("nonsense") is None, "a live stream (P0D) or nonsense has no length")

        print("Step 2: yt-dlp again with the cookies file")
        cookie_file = os.path.join(LOG_DIR, "cookies.txt")
        open(cookie_file, "w").close()
        os.environ["YTDLP_COOKIE_FILE"] = cookie_file
        attempts = []

        class FakeYoutubeDL:
            def __init__(self, options):
                self.options = options
            def __enter__(self):
                return self
            def __exit__(self, *args):
                return False
            def extract_info(self, url, download=False):
                attempts.append("cookies" if self.options.get("cookiefile") else "plain")
                if not self.options.get("cookiefile"):
                    raise DownloadError("ERROR: Sign in to confirm you're not a bot")
                return {"title": "With cookies", "duration": 100, "uploader": "Cookie channel"}

        routes.YoutubeDL = FakeYoutubeDL
        info = REAL_EXTRACT_VIDEO_INFO("https://www.youtube.com/watch?v=cookieVid01")
        check(attempts == ["plain", "cookies"] and info["title"] == "With cookies", "a refused lookup is retried with the cookies")
        routes.YoutubeDL = real[2]
        os.environ.pop("YTDLP_COOKIE_FILE")

        transport = httpx.ASGITransport(app=main.app, raise_app_exceptions=False)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            print("Step 1: yt-dlp answers")
            store = fresh_queue()
            routes.extract_video_info = lambda url: {"title": "From yt-dlp", "duration": 200, "uploader": "Channel"}
            os.environ["YOUTUBE_API_KEY"] = "test-key"
            routes.urlopen = api_answers(api_item())
            api_calls.clear()
            answer = await client.post("/playlist/add", json=body("stepOneVid1"))
            check(answer.status_code == 200 and added(store, "stepOneVid1")[0].youtube_title == "From yt-dlp" and not api_calls,
                  "added from yt-dlp, and the API isn't used")

            print("Step 3: YouTube's Data API")
            routes.extract_video_info = refused
            answer = await client.post("/playlist/add", json=body("stepThreeV1"))
            song = added(store, "stepThreeV1")
            check(answer.status_code == 200 and len(song) == 1, "yt-dlp refused: added from the API")
            check(song[0].youtube_title == "From the API" and song[0].url_creator == "API channel" and song[0].duration == 205,
                  "with the API's title, channel and length (3:25)")
            check(len(api_calls) >= 1 and "id=stepThreeV1" in api_calls[0] and "part=snippet%2CcontentDetails" in api_calls[0],
                  "one videos.list request for that ID")

            routes.urlopen = api_answers({"items": []})
            answer = await client.post("/playlist/add", json=body("missingVid1"))
            check(answer.status_code >= 500 and not added(store, "missingVid1"),
                  "a video the API says doesn't exist isn't added (the usual 'couldn't look up' message)")

            routes.urlopen = api_answers(api_item(rating="ytAgeRestricted"))
            answer = await client.post("/playlist/add", json=body("ageApiVid01"))
            check(answer.status_code == 400 and answer.json()["detail"] == "Video is age-restricted" and not added(store, "ageApiVid01"),
                  "an age-restricted video (said by the API) gets the age-restricted message")

            routes.extract_video_info = age_restricted
            api_calls.clear()
            answer = await client.post("/playlist/add", json=body("ageYtdlp001"))
            check(answer.status_code == 400 and not api_calls, "age-restricted from yt-dlp isn't retried with the API")

            print("Step 4: nothing could look it up")
            routes.extract_video_info = refused
            routes.urlopen = api_answers(urllib.error.HTTPError("https://example", 403, "quotaExceeded", {}, None))
            answer = await client.post("/playlist/add", json=body("nullStepV01", "Gurenge"))
            song = added(store, "nullStepV01")
            check(answer.status_code == 200 and len(song) == 1, "the API can't answer (quota used up): added anyway")
            check(song[0].youtube_title == "Gurenge" and song[0].url_creator is None and song[0].duration is None
                  and song[0].url_channel_icon is None and song[0].is_too_long is False,
                  "with the typed song name as its title, and no channel, icon or length")

            os.environ.pop("YOUTUBE_API_KEY")
            api_calls.clear()
            answer = await client.post("/playlist/add", json=body("noKeyVid001"))
            check(answer.status_code == 200 and not api_calls and added(store, "noKeyVid001"),
                  "with no API key, the API step is skipped and it's added the same way")

            answer = await client.post("/playlist/add", json=body("nullStepV01"))
            check(answer.status_code == 400, "the duplicate check still applies")
            check((await client.get("/playlist/progress")).status_code == 200 and (await client.get("/playlist/")).status_code == 200,
                  "the queue and progress still load with those songs in it")
            each_song_once(store, 10)
    finally:
        routes.extract_video_info, routes.urlopen, routes.YoutubeDL = real
        for key, value in environment.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


async def real_length_test() -> None:
    # A song added without a length gets its real one from the YouTube window once it plays.
    from playlist.playlist_store import read_snapshot, songs_from_snapshot, read_log

    print("Filling in the real length when a song with no length plays")
    store = fresh_queue(song_count=3)
    store.songs[0].duration = None
    store.songs[1].duration = None
    transport = httpx.ASGITransport(app=main.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        answer = await client.post("/playlist/position", json={"p_id": 0, "position": 5, "duration": 205})
        check(answer.json() is True and store.songs[0].duration == 205, "the window's length is saved for the playing song")
        await client.post("/playlist/position", json={"p_id": 0, "position": 9, "duration": 999})
        check(store.songs[0].duration == 205, "a known length is never overwritten")
        await client.post("/playlist/position", json={"p_id": 1, "position": 3, "duration": 150})
        check(store.songs[1].duration is None, "a report about a song that isn't playing is ignored")
        await client.post("/playlist/position", json={"p_id": 0, "position": 12})
        check(store.songs[0].duration == 205, "a report without a length (older extension) changes nothing")
        check(store.songs[0].is_too_long is False, "a normal length isn't flagged")
        line = read_log(store.log_path)[-1][0]
        restored = songs_from_snapshot(read_snapshot(store.log_path, line))
        check(restored[0].duration == 205, "the session log keeps it, so Restore does too")

        await client.post("/playlist/skip?from_p_id=0")
        answer = await client.post("/playlist/position", json={"p_id": 1, "position": 1, "duration": 900})
        check(store.songs[1].duration == 900 and store.songs[1].is_too_long is True,
              "a real length over the limit is flagged as too long")
        check(store.current_song.p_id == 1 and store.playing is True, "and it keeps playing")
        answer = await client.post("/playlist/position", json={"p_id": 1, "position": 1, "duration": 0})
        check(answer.status_code == 422, "a zero length is refused")


class FakeSettingsCollection:
    # Stands in for MongoDB's queue_settings collection: one document, kept in memory.
    def __init__(self):
        self.document = {}

    async def find_one(self, query):
        return dict(self.document) if self.document else None

    async def update_one(self, query, update, upsert=False):
        self.document.update(update["$set"])


async def main_screen_test() -> None:
    real_collection = routes.queue_settings_col
    routes.queue_settings_col = FakeSettingsCollection()
    try:
        print("The main screen")
        fresh_queue()
        transport = httpx.ASGITransport(app=main.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            answer = await client.get("/playlist/screen")
            check(answer.status_code == 200 and answer.json()["device_id"] is None, "no main screen at first")
            laptop = {"device_id": "laptop-0001-aaaa", "label": "Chrome on Mac"}
            phone = {"device_id": "phone-0002-bbbb", "label": "Safari on iPhone"}
            answer = await client.post("/playlist/screen?only_if_unset=true", json=laptop)
            check(answer.json()["device_id"] == laptop["device_id"], "the first device with the extension claims it by itself")
            answer = await client.post("/playlist/screen?only_if_unset=true", json=phone)
            check(answer.json()["device_id"] == laptop["device_id"], "a claim by itself can't take it from another device")
            answers = await burst(client, [("POST", "/playlist/screen?only_if_unset=true", {"json": phone})] * 5)
            check(all(each.json()["device_id"] == laptop["device_id"] for each in answers), "nor can several at once")
            answer = await client.post("/playlist/screen", json=phone)
            check(answer.json()["device_id"] == phone["device_id"] and answer.json()["label"] == "Safari on iPhone",
                  "pressing the button moves it to that device")
            answer = await client.post("/playlist/screen", json={"device_id": "bad id!", "label": ""})
            check(answer.status_code == 422, "a malformed device ID is refused")
            progress = (await client.get("/playlist/progress")).json()
            check("device_id" not in progress and "label" not in progress, "the public progress route doesn't show it")
            main.app.dependency_overrides.pop(require_admin)
            try:
                check((await client.get("/playlist/screen")).status_code == 401, "reading it needs the admin login")
                check((await client.post("/playlist/screen", json=laptop)).status_code == 401, "so does claiming it")
            finally:
                main.app.dependency_overrides[require_admin] = lambda: {"admin": True}
    finally:
        routes.queue_settings_col = real_collection


async def login_cookie_test() -> None:
    # The admin login cookie only travels encrypted. Uses a made-up username, password and signing
    # secret for this test only; the real ones from .env are never read or shown here.
    import auth

    real = (auth.ADMIN_USERNAME, auth.ADMIN_PASSWORD, auth.JWT_SECRET)
    auth.ADMIN_USERNAME, auth.ADMIN_PASSWORD, auth.JWT_SECRET = "test-admin", "test-password", "test-secret"
    try:
        print("The admin login cookie")
        transport = httpx.ASGITransport(app=main.app)
        async with httpx.AsyncClient(transport=transport, base_url="https://test") as client:
            answer = await client.post("/auth/login", data={"username": "test-admin", "password": "test-password"})
            cookie = answer.headers.get("set-cookie", "")
            attributes = {part.strip().split("=")[0].lower() for part in cookie.split(";")}
            check(answer.status_code == 200 and cookie.startswith(f"{auth.ADMIN_COOKIE_NAME}="), "signing in sets the cookie")
            check({"secure", "httponly", "path"} <= attributes and "samesite=lax" in cookie.lower(),
                  "it's Secure, HttpOnly and SameSite=Lax")
            check("max-age=18000" in cookie.lower(), "it lasts 5 hours, as before")
            answer = await client.post("/auth/logout")
            cookie = answer.headers.get("set-cookie", "").lower()
            check(cookie.startswith(f"{auth.ADMIN_COOKIE_NAME}=") and "max-age=0" in cookie and "secure" in cookie,
                  "signing out clears it")
            answer = await client.post("/auth/login", data={"username": "test-admin", "password": "wrong"})
            check(answer.status_code == 401 and "set-cookie" not in answer.headers, "a wrong password sets nothing")
    finally:
        auth.ADMIN_USERNAME, auth.ADMIN_PASSWORD, auth.JWT_SECRET = real


async def position_test() -> None:
    # The song clock behind the admin page's live "Time left", on a pretend server clock.
    import types
    from playlist import playlist_store as store_module

    clock = [10_000.0]
    real_time = store_module.time
    store_module.time = types.SimpleNamespace(time=lambda: clock[0])
    try:
        def elapsed(store: Playlist) -> float:
            state = store.playback_state()
            return state["position"] + (state["server_time"] - state["position_at"] if state["playing"] else 0)

        print("The current song's position")
        store = fresh_queue(playing=False)
        store.reset_position()
        clock[0] += 30
        check(elapsed(store) == 0, "a paused song stays at 0:00")
        store.set_playing(True)
        clock[0] += 40
        check(elapsed(store) == 40, "40 s after Play it's at 0:40")
        store.set_playing(False)
        clock[0] += 100
        check(elapsed(store) == 40, "Pause stops it at 0:40")
        store.set_playing(True)
        clock[0] += 5
        check(elapsed(store) == 45, "Play carries on from 0:40")
        check(store.set_position(0, 120) and elapsed(store) == 120, "the YouTube window's report sets it to 2:00")
        check(not store.set_position(3, 10) and elapsed(store) == 120, "a report about another song is ignored")
        check(store.set_position(0, 999) and elapsed(store) == 200, "a report past the end is held at the song's length")
        store.skip()
        check(elapsed(store) == 0, "Skip starts the next song at 0:00")
        clock[0] += 7
        store.back()
        check(elapsed(store) == 0, "Back starts that song at 0:00 too")

        print("Through the routes")
        store = fresh_queue()
        transport = httpx.ASGITransport(app=main.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            state = (await client.get("/playlist/current-play")).json()
            check({"position", "position_at", "server_time"} <= state.keys(), "current-play includes the position")
            answer = await client.post("/playlist/position", json={"p_id": 0, "position": 33})
            check(answer.json() is True and store.position == 33, "the window's report for the current song is taken")
            answer = await client.post("/playlist/position", json={"p_id": 4, "position": 90})
            check(answer.json() is False and store.position == 33, "a report for another song is ignored")
            await client.post("/playlist/skip?from_p_id=0")
            check(store.position == 0, "skipping resets it")

            print("The public progress route")
            main.app.dependency_overrides.pop(require_admin)
            try:
                answer = await client.get("/playlist/progress")
                check(answer.status_code == 200, "answers without the admin login")
                body = answer.json()
                expected = {"p_id", "finished", "playing", "position", "position_at", "server_time",
                            "pause_before_songs", "auto_play", "auto_play_seconds"}
                check(set(body) == expected, "has exactly the song, its position and the delay settings")
                check(body["p_id"] == 1 and body["playing"] is True and body["finished"] is False,
                      "names the song playing now")
                check(body["auto_play_seconds"] == SETTINGS["auto_play_seconds"], "includes the delay settings")
                answer = await client.get("/playlist/current-play")
                check(answer.status_code == 401, "current-play still needs the login")
            finally:
                main.app.dependency_overrides[require_admin] = lambda: {"admin": True}
    finally:
        store_module.time = real_time


if __name__ == "__main__":
    asyncio.run(main_test())
