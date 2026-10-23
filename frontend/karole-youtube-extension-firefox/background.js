// Relays messages between the Karole pages and the YouTube window they control, and moves the
// queue on when a song ends there. Any Karole page can steer the window, not only the player
// page, so a change made on the admin Playlist page reaches it even while the player page is
// asleep in a background tab. Service workers can be stopped at any time, so the window's tab
// id and the rest of the state live in session storage.

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

async function getState() {
    const { youtubeTabId = null, siteTabIds = [], desired = null, lastStatus = null, settings = {} } =
        await browser.storage.session.get(["youtubeTabId", "siteTabIds", "desired", "lastStatus", "settings"]);
    return { youtubeTabId, siteTabIds, desired, lastStatus, settings };
}

async function getYouTubeTab() {
    const { youtubeTabId } = await getState();
    if (youtubeTabId !== null) {
        try {
            return await browser.tabs.get(youtubeTabId);
        } catch {
            // The window was closed; fall through and look for another.
        }
    }
    // Reloading or updating the extension forgets which window it opened, and the scripts in
    // that window stop listening. Take the window over again rather than opening a second one
    // (it gets a fresh page, and so fresh scripts, the next time a song is sent).
    const [adopted] = await browser.tabs.query({ url: "https://www.youtube.com/watch*", windowType: "popup" });
    if (!adopted) return null;
    await browser.storage.session.set({ youtubeTabId: adopted.id, needsFreshPage: true });
    return adopted;
}

// `paused` adds karole=paused, which makes the window hold the song at the start, silent, until
// Play is pressed on the site (see youtube-main.js). YouTube ignores the extra parameter.
function watchUrl(videoId, start, paused = false) {
    const url = new URL("https://www.youtube.com/watch");
    url.searchParams.set("v", videoId);
    if (start > 0) url.searchParams.set("t", `${Math.floor(start)}s`);
    if (paused) url.searchParams.set("karole", "paused");
    return url.href;
}

async function tellSites(message) {
    const { siteTabIds } = await getState();
    for (const tabId of siteTabIds) {
        browser.tabs.sendMessage(tabId, message).catch(() => {});
    }
}

async function tellYouTube(message) {
    const tab = await getYouTubeTab();
    if (!tab) return false;
    const { needsFreshPage, desired, lastStatus } = await browser.storage.session.get(["needsFreshPage", "desired", "lastStatus"]);
    try {
        if (needsFreshPage) throw new Error("taken over");
        await browser.tabs.sendMessage(tab.id, message);
    } catch {
        // Nothing is listening in that window (it was taken over, or its page is from before
        // the extension was reloaded): load the song again, from where it was.
        if (desired) {
            const playing = message.type === "play" ? true : message.type === "pause" ? false : desired.playing;
            const start = lastStatus?.videoId === desired.videoId ? lastStatus.time : 0;
            await loadVideo(desired.videoId, playing, start, { pId: desired.pId });
        }
    }
    return true;
}

function videoInUrl(url) {
    try {
        return new URL(url).searchParams.get("v");
    } catch {
        return null;
    }
}

// The window follows one Karole site: the one whose player page loaded its song (`desired.origin`,
// with that page's tab, `desired.driverTabId`). Two copies of the site (say the laptop's own at
// localhost and the hosted one) have different queues, so following whichever page spoke last made
// the window flip between them. Another site's pages can only take over once the driving page is
// closed (or has left the site), or when someone presses Open/Reopen YouTube window there.
async function driverStillOpen(desired) {
    if (desired?.driverTabId == null) return false;
    try {
        const tab = await browser.tabs.get(desired.driverTabId);
        return new URL(tab.url).origin === desired.origin;
    } catch {
        return false;
    }
}

async function isOtherSite(origin) {
    const { desired } = await browser.storage.session.get("desired");
    return Boolean(desired?.origin && origin && origin !== desired.origin && (await driverStillOpen(desired)));
}

const OTHER_SITE = { ok: false, ignored: true, error: "The YouTube window is following another copy of the Karole site" };

// Opens the YouTube window, or reuses it, and points it at a song (pId is its place in the
// queue). The same song asked for again, say by the player page once it wakes up after the
// Playlist page already sent it, only gets its play/pause state applied instead of starting over;
// `force` reloads it anyway. With `onlyIfOpen` no window is opened: opening it is the player
// page's job. `origin` is the site the song comes from and `driverTabId` the player page that
// sent it (see driverStillOpen); both stay as they were when left out. Returns whether the window
// was pointed at the song.
async function loadVideo(
    videoId,
    playing,
    start,
    { pId = null, onlyIfOpen = false, force = false, origin = null, driverTabId = null } = {}
) {
    const openTab = await getYouTubeTab();
    if (!openTab && onlyIfOpen) return false;
    const { desired: previous, siteOrigin } = await browser.storage.session.get(["desired", "siteOrigin"]);
    const songOrigin = origin || previous?.origin || siteOrigin || null;
    const sameSite = songOrigin === previous?.origin;
    const driver = driverTabId ?? (sameSite ? previous?.driverTabId ?? null : null);
    if (openTab && !force && pId !== null) {
        const { desired, needsFreshPage } = await browser.storage.session.get(["desired", "needsFreshPage"]);
        // The same place in the queue on another site is another song (each site counts its own).
        if (!needsFreshPage && sameSite && desired?.pId === pId && videoInUrl(openTab.url) === videoId) {
            if (desired.driverTabId !== driver) await browser.storage.session.set({ desired: { ...desired, driverTabId: driver } });
            if (desired.playing !== playing) {
                // A real Play or Pause, so the song no longer plays by itself (see autoPlay).
                await browser.storage.session.set({ desired: { ...desired, driverTabId: driver, playing, autoPlayCancelled: true } });
                await tellYouTube({ type: playing ? "play" : "pause", cancelAutoPlay: true });
            }
            return true;
        }
    }
    await browser.storage.session.set({
        desired: { videoId, pId, playing, start: start || 0, origin: songOrigin, driverTabId: driver },
        needsFreshPage: false,
        endedPId: null,
    });
    const url = watchUrl(videoId, start, !playing);
    const tab = await getYouTubeTab();
    if (tab) {
        await browser.tabs.update(tab.id, { url });
        return true;
    }
    const window = await browser.windows.create({ url, type: "popup", width: 1280, height: 760 });
    await browser.storage.session.set({ youtubeTabId: window.tabs[0].id });
    return true;
}

// The Karole backend of the site the window follows (see driverStillOpen), reached through that
// site's /backend pass-through with its admin login. Before any song, the site that last talked
// to the extension.
async function fromBackend(path, options = {}) {
    const { desired, siteOrigin } = await browser.storage.session.get(["desired", "siteOrigin"]);
    const origin = desired?.origin || siteOrigin;
    if (!origin) throw new Error("No Karole page has talked to the extension yet");
    const response = await fetch(`${origin}/backend${path}`, { ...options, credentials: "include", cache: "no-store" });
    if (!response.ok) throw new Error(`${path} answered ${response.status}`);
    return response.json();
}

// How many seconds a song held at the start waits before playing by itself ("Auto-play after a
// delay" on the site), or 0 to wait for Play: also while that or "Start each song paused" is off.
async function autoPlayDelay() {
    try {
        const settings = await fromBackend("/playlist/queue-settings");
        return settings.pause_before_songs && settings.auto_play && settings.auto_play_seconds > 0 ? settings.auto_play_seconds : 0;
    } catch {
        return 0;
    }
}

// The YouTube window's countdown for the held song `pId` ran out. Plays it the way the site's Play
// button does, but only if nothing changed meanwhile: it's still the song, still paused, nobody
// pressed Play or Pause for it, and the delay is still set.
async function autoPlay(pId) {
    const { desired } = await getState();
    const skip = (why) => console.log(`Karole auto-play: skipped song ${pId}, ${why}`);
    if (desired?.pId !== pId) return skip(`the window has moved on to song ${desired?.pId}`);
    if (desired.playing) return skip("it is already playing");
    if (desired.autoPlayCancelled) return skip("Play or Pause was pressed during the countdown");
    try {
        if (!(await autoPlayDelay())) return skip("auto-play or the pause switch is off now");
        const current = await fromBackend("/playlist/current-play");
        if (current.song?.p_id !== pId) return skip(`the backend is on song ${current.song?.p_id}`);
        if (current.playing) return skip("the backend says it is already playing");
        // Play, not a toggle, so a Play pressed elsewhere at the same moment can't turn it off again.
        const playing = await fromBackend("/playlist/play", { method: "POST" });
        console.log(`Karole auto-play: pressed Play for song ${pId}, the backend answered playing=${playing}`);
        if (playing !== true) return;
        await browser.storage.session.set({ desired: { ...desired, playing: true } });
        await tellYouTube({ type: "play" });
    } catch (error) {
        // The backend couldn't be reached; the song waits for Play as usual.
        skip(`the backend couldn't be reached (${error.message})`);
    }
}

// The song `pId` finished in the YouTube window: move the queue on and play what comes next.
// Returns false when the backend couldn't be reached, so a player page can do it instead.
async function advanceAfter(pId) {
    try {
        const current = await fromBackend("/playlist/current-play");
        // Someone already moved on (say skip was pressed in the song's last second).
        if (current.song?.p_id !== pId) return true;
        // With "Start each song paused" on, the backend answers with the next song paused. Naming
        // the song makes this skip do nothing if someone (say on a phone) skipped it meanwhile.
        const next = await fromBackend(`/playlist/skip?from_p_id=${pId}`, { method: "POST" });
        const finished = await fromBackend("/playlist/queue-finished");
        const videoId = next.song?.url_id;
        if (!finished && next.song && VIDEO_ID.test(videoId || "")) {
            await loadVideo(videoId, Boolean(next.playing), 0, { pId: next.song.p_id });
        }
        return true;
    } catch {
        return false;
    }
}

// This browser's own ID, made up once and kept, so the site can tell which device is the "main
// screen" (the one that plays the video; see the player page). Kept by the extension rather than
// a page, so it's the same whichever address the site is opened at.
async function getDeviceId() {
    const { deviceId } = await browser.storage.local.get("deviceId");
    if (deviceId) return deviceId;
    const newId = crypto.randomUUID();
    await browser.storage.local.set({ deviceId: newId });
    return newId;
}

// Keeps the window in step with the backend by itself, so Play, Pause, Skip, Back or a jump pressed
// anywhere (on a phone, say, where there's no extension) reaches it within a second or two, even
// with no Karole page awake on this computer. Runs on the window's status reports, which come at
// least every second while it's open, at most once a second. Messages are handled one at a time,
// so a press made on this computer is applied either before this (and is already in the backend's
// answer) or after it, never undone by it. Moving on from a song that ended is advanceAfter's job:
// while the backend is still on that song, nothing is done, so it's never played again.
let lastSyncAt = 0;
async function syncFromBackend() {
    if (Date.now() - lastSyncAt < 1000) return;
    lastSyncAt = Date.now();
    const { desired, endedPId } = await browser.storage.session.get(["desired", "endedPId"]);
    if (!desired) return;
    let current;
    let finished;
    try {
        // Only the main screen plays. If another device has taken over, this window closes, even
        // with no Karole page open here, so the song never plays in two places.
        const screen = await fromBackend("/playlist/screen");
        if (screen.device_id && screen.device_id !== (await getDeviceId())) {
            const tab = await getYouTubeTab();
            if (tab) {
                console.log("Karole: another device is the main screen now, closing this YouTube window");
                await browser.windows.remove(tab.windowId).catch(() => {});
            }
            return;
        }
        current = await fromBackend("/playlist/current-play");
        finished = await fromBackend("/playlist/queue-finished");
    } catch {
        return; // The backend couldn't be reached; try again on the next report.
    }
    const song = finished ? null : current.song;
    if (!song || !VIDEO_ID.test(song.url_id || "")) {
        if (desired.playing) {
            console.log("Karole sync: the queue has nothing to play, pausing the window");
            await browser.storage.session.set({ desired: { ...desired, playing: false, autoPlayCancelled: true } });
            await tellYouTube({ type: "pause", cancelAutoPlay: true });
        }
        return;
    }
    const playing = Boolean(current.playing);
    if (song.p_id === endedPId && desired.pId === endedPId) return;
    if (song.p_id === desired.pId && playing === desired.playing) return;
    console.log(song.p_id === desired.pId
        ? `Karole sync: song ${song.p_id} was ${playing ? "played" : "paused"} elsewhere`
        : `Karole sync: the queue moved to song ${song.p_id} elsewhere, loading it`);
    // The same song only gets play or pause applied (a real change, so it also cancels an
    // auto-play countdown); another song is loaded, held at the start if it should wait.
    await loadVideo(song.url_id, playing, 0, { pId: song.p_id });
}

async function fromSite(message, tab, senderUrl) {
    const state = await getState();
    if (!state.siteTabIds.includes(tab.id)) {
        await browser.storage.session.set({ siteTabIds: [...state.siteTabIds, tab.id] });
    }
    // The site this page belongs to. It's only where the backend is reached before the window
    // has a song; after that the window follows the site its song came from (see loadVideo).
    const origin = senderUrl ? new URL(senderUrl).origin : null;
    if (origin && !state.desired?.origin) await browser.storage.session.set({ siteOrigin: origin });
    // Commands for the window from another copy of the site are ignored while the page driving
    // it is open. Open/Reopen YouTube window ("load" with force) is the deliberate way to move it.
    const steersWindow = ["load", "play", "pause", "seek", "captions", "settings", "fullscreen", "close"];
    if (steersWindow.includes(message.type) && !(message.type === "load" && message.force) && (await isOtherSite(origin))) {
        return OTHER_SITE;
    }

    switch (message.type) {
        case "load":
            if (!VIDEO_ID.test(message.videoId || "")) return { ok: false, error: "Not a YouTube video id" };
            return {
                ok: await loadVideo(message.videoId, Boolean(message.playing), Number(message.start) || 0, {
                    pId: Number.isInteger(message.pId) ? message.pId : null,
                    onlyIfOpen: Boolean(message.onlyIfOpen),
                    force: Boolean(message.force),
                    origin,
                    // The player page loads songs itself; the Playlist page only steers an open window.
                    driverTabId: message.onlyIfOpen ? null : tab.id,
                }),
            };
        case "play":
        case "pause": {
            const playing = message.type === "play";
            // Only a real change cancels the song's auto-play countdown: the player page also
            // repeats the current state, say "pause" right after a held song is sent.
            const cancelAutoPlay = Boolean(state.desired) && state.desired.playing !== playing;
            if (state.desired) {
                await browser.storage.session.set({
                    desired: { ...state.desired, playing, autoPlayCancelled: state.desired.autoPlayCancelled || cancelAutoPlay },
                });
            }
            return { ok: await tellYouTube({ type: message.type, cancelAutoPlay }) };
        }
        case "seek":
            return { ok: await tellYouTube({ type: "seek", time: Number(message.time) || 0 }) };
        case "captions":
            // Only for the song playing now: each video has its own caption tracks.
            return {
                ok: await tellYouTube({
                    type: "captions",
                    captionId: typeof message.captionId === "string" ? message.captionId : null,
                }),
            };
        case "settings": {
            // Volume (0-100), muted, speed and whether YouTube's own controls show. They are
            // kept so every new song gets them too.
            const settings = { ...state.settings };
            if (typeof message.volume === "number") settings.volume = Math.min(100, Math.max(0, message.volume));
            if (typeof message.muted === "boolean") settings.muted = message.muted;
            if (typeof message.rate === "number") settings.rate = Math.min(2, Math.max(0.25, message.rate));
            if (typeof message.showControls === "boolean") settings.showControls = message.showControls;
            await browser.storage.session.set({ settings });
            return { ok: await tellYouTube({ type: "settings", settings }), settings };
        }
        case "fullscreen": {
            const youtubeTab = await getYouTubeTab();
            if (!youtubeTab) return { ok: false };
            const window = await browser.windows.get(youtubeTab.windowId);
            await browser.windows.update(youtubeTab.windowId, {
                state: window.state === "fullscreen" ? "normal" : "fullscreen",
            });
            return { ok: true };
        }
        case "close": {
            const youtubeTab = await getYouTubeTab();
            if (youtubeTab) await browser.windows.remove(youtubeTab.windowId);
            return { ok: true };
        }
        case "device-id":
            return { ok: true, deviceId: await getDeviceId() };
        case "status": {
            // The player page asks every 2 seconds. The window is also asked to report at once:
            // its own report timer is slowed right down by the browser while the window is
            // hidden (minimized or covered) and quiet, but messages still get through. Nothing
            // listening there (a page loading, or left over from before an update) is fine.
            const youtubeTab = await getYouTubeTab();
            if (youtubeTab) browser.tabs.sendMessage(youtubeTab.id, { type: "report" }).catch(() => {});
            return { ok: true, open: Boolean(youtubeTab), status: state.lastStatus };
        }
        default:
            return { ok: false, error: `Unknown command ${message.type}` };
    }
}

async function fromYouTube(message, tab) {
    const { youtubeTabId, desired, settings } = await getState();
    const controlled = tab.id === youtubeTabId;
    if (message.type === "hello") {
        // Only the window opened for Karole is taken over; other YouTube tabs are left alone. A
        // song held at the start also gets its auto-play delay, for the window's countdown.
        const autoPlaySeconds = controlled && desired && !desired.playing ? await autoPlayDelay() : 0;
        return { controlled, desired: controlled ? desired : null, settings: controlled ? settings : null, autoPlaySeconds };
    }
    if (controlled && message.type === "position") {
        // Only for the queue's song; the backend also ignores it if the queue has moved on.
        if (desired?.pId === message.pId && Number.isFinite(message.time)) {
            await fromBackend("/playlist/position", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    p_id: message.pId,
                    position: Math.max(0, message.time),
                    // The real length, for a song added without one (not for live streams, which have none).
                    ...(Number.isFinite(message.duration) && message.duration > 0 ? { duration: message.duration } : {}),
                }),
            }).catch(() => {});
        }
        return { ok: true };
    }
    if (controlled && message.type === "auto-play") {
        await autoPlay(message.pId);
        return { ok: true };
    }
    if (controlled && message.type === "status") {
        // The page can't see its own window, so whether it's full screen is added here.
        const window = await browser.windows.get(tab.windowId).catch(() => null);
        const status = { ...message.status, fullscreen: window?.state === "fullscreen" };
        await browser.storage.session.set({ lastStatus: status });
        await tellSites({ type: "status", status });
        // The queue's song finished (not an ad before it): move on from here, so it happens even
        // while the player page is asleep. Each song is only moved on from once.
        let advanced = false;
        if (status.state === "ended" && !status.ad && desired?.pId != null && status.videoId === desired.videoId) {
            const { endedPId } = await browser.storage.session.get("endedPId");
            if (endedPId !== desired.pId) {
                advanced = true;
                await browser.storage.session.set({ endedPId: desired.pId });
                const handled = await advanceAfter(desired.pId);
                await tellSites({ type: "song-ended", pId: desired.pId, handled });
            }
        }
        if (!advanced) await syncFromBackend();
    }
    return { ok: true };
}

// Messages are handled one at a time: each reads the stored state and writes it back, so two
// at once (say volume and speed changed together) would overwrite each other's change.
let queue = Promise.resolve();
function oneAtATime(task) {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
}

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!sender.tab) return false;
    const handler = message.from === "youtube" ? fromYouTube : fromSite;
    oneAtATime(() => handler(message, sender.tab, sender.url))
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true; // the answer is sent asynchronously
});

browser.tabs.onRemoved.addListener(async (tabId) => {
    const { youtubeTabId, siteTabIds } = await getState();
    if (tabId === youtubeTabId) {
        await browser.storage.session.set({ youtubeTabId: null, lastStatus: null });
        await tellSites({ type: "status", status: { state: "closed" } });
    } else if (siteTabIds.includes(tabId)) {
        await browser.storage.session.set({ siteTabIds: siteTabIds.filter((id) => id !== tabId) });
        // The page driving the window closed: another copy of the site's player page may take over.
        const { desired } = await browser.storage.session.get("desired");
        if (desired?.driverTabId === tabId) await browser.storage.session.set({ desired: { ...desired, driverTabId: null } });
    }
});
