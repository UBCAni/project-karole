// A stand-in for the real backend, so the frontend can be clicked through without
// MongoDB or YouTube. Everything lives in memory and resets when it stops.
// Run with: npm run sample-backend   (admin password: karole)
import http from "node:http";

const PORT = 8000;
const ADMIN = { username: "admin", password: "karole" };
const COOKIE = "karole_sample_admin";
const MAX_SECONDS = 10 * 60;

const now = () => Date.now() / 1000;

let nextNameId = 1;
let names = [
    { name: "Aiko", name_alt: ["Aiko S", "aiko"], blacklist: false },
    { name: "Ben", name_alt: [], blacklist: false },
    { name: "Chen Wei", name_alt: ["Chen"], blacklist: false },
    { name: "Dana", name_alt: [], blacklist: false },
    { name: "Danna", name_alt: [], blacklist: false },
    { name: "Eli", name_alt: [], blacklist: false },
    { name: "Ellie", name_alt: [], blacklist: false },
    { name: "Troll", name_alt: [], blacklist: true },
].map((entry) => ({ name_id: nextNameId++, ...entry }));

const findName = (name) => names.find((entry) => entry.name === name);
const findOwner = (name) => findName(name) ?? names.find((entry) => entry.name_alt.includes(name));

function nameIdFor(name) {
    const owner = findOwner(name);
    if (owner) return owner.name_id;
    const entry = { name_id: nextNameId++, name, name_alt: [], blacklist: false };
    names.push(entry);
    return entry.name_id;
}

let nextSongId = 1;
let songs = [];

function addSong({ url, name, song_name }, title, creator, seconds) {
    const nameId = nameIdFor(name);
    const song = {
        p_id: nextSongId++,
        order_num: songs.length,
        priority_num: songs.filter((entry) => entry.name_id === nameId).length + 1,
        name_id: nameId,
        time: now(),
        name,
        song_name,
        service: "youtube",
        url,
        url_id: new URL(url).searchParams.get("v"),
        url_creator: creator,
        youtube_title: title,
        url_channel_icon: "",
        duration: seconds,
        is_too_long: seconds > MAX_SECONDS,
        file_loc: null,
        is_downloaded: false,
    };
    songs.push(song);
    return song;
}

// Real YouTube videos, so the YouTube window player can be tried out. Ed Sheeran is a Sing King
// karaoke video, which refuses to play anywhere but youtube.com itself.
[
    ["Aiko", "Gurenge", "LiSA - Gurenge (Music Clip)", "LiSA Official", 236, "x1FV6IrjZCY"],
    ["Ben", "Idol", "YOASOBI - Idol (Official Music Video)", "Ayase / YOASOBI", 226, "ZRtdQ81jPUQ"],
    ["Chen Wei", "Perfect", "Ed Sheeran - Perfect (Karaoke Version)", "Sing King", 296, "sPMA1tqWuf4"],
    ["Dana", "Blue Bird", "Bluebird - Ikimonogakari (Romaji Karaoke)", "Uta-cha Karaoke", 222, "naKStyMjOwM"],
    ["Eli", "Silhouette", "Silhouette - KANA-BOON (Romaji Karaoke)", "Uta-cha Karaoke", 240, "XUlSt_HXdgU"],
].forEach(([name, songName, title, creator, seconds, id]) =>
    addSong({ url: `https://www.youtube.com/watch?v=${id}`, name, song_name: songName }, title, creator, seconds));

let nextOperationId = 1;
let operations = [
    { name: "Dana", name_alt: "Danna", score: 90.9 },
    { name: "Eli", name_alt: "Ellie", score: 72.7 },
].map((entry) => ({ po_id: nextOperationId++, ...entry }));

// Songs deleted for being too long, which can't be added again.
let blocked = [];

let settings = { open: true, pause_before_songs: false, auto_play: false, auto_play_seconds: 10 };
let screen = { device_id: null, label: "", since: null };

// Playback, as in backend/playlist/playlist_store.py: the first song is on, paused.
let current = songs[0] ?? null;
let finished = false;
let playing = false;
let position = 0;
let positionAt = now();

function setPlaying(value) {
    // Pausing banks the time played so far; playing restarts the clock from where it was.
    if (playing) position += now() - positionAt;
    positionAt = now();
    playing = value;
}

function resetPosition() {
    position = 0;
    positionAt = now();
}

const findIndex = (pId) => songs.findIndex((song) => song.p_id === pId);
const currentIndex = () => (current ? songs.indexOf(current) : -1);

function renumber() {
    songs.forEach((song, index) => { song.order_num = index; });
}

function selectSong(index) {
    // Past the end it stops on the last song (finished); before the start, on nothing.
    finished = false;
    if (index >= 0 && index < songs.length) {
        current = songs[index];
        setPlaying(true);
    } else if (songs.length && index >= songs.length) {
        current = songs[songs.length - 1];
        setPlaying(false);
        finished = true;
    } else {
        current = null;
        setPlaying(false);
    }
    resetPosition();
}

function playPause() {
    const index = currentIndex();
    if (finished && index >= 0) {
        selectSong(index + 1 < songs.length ? index + 1 : index);
        return playing;
    }
    if (!current) {
        if (!songs.length) return false;
        current = songs[0];
        resetPosition();
    }
    setPlaying(!playing);
    return playing;
}

// With "Start each song paused" on, a song that just became the current one waits for Play.
function holdNewSong(beforePId) {
    if (settings.pause_before_songs && current && current.p_id !== beforePId && playing) {
        setPlaying(false);
        resetPosition();
    }
}

// Runs a change of song, then holds the new one if it should wait.
function changeSong(change) {
    const before = current?.p_id ?? null;
    change();
    holdNewSong(before);
}

function playback() {
    return { playing, song: current, position, position_at: positionAt, server_time: now() };
}

function deleteSong(pId) {
    const index = findIndex(pId);
    if (index < 0) return null;
    const [song] = songs.splice(index, 1);
    if (song === current) changeSong(() => selectSong(index));
    renumber();
    return song;
}

function send(res, req, status, body, headers = {}) {
    res.writeHead(status, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": req.headers.origin || "*",
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        ...headers,
    });
    res.end(body === undefined ? "" : JSON.stringify(body));
}

function readBody(req) {
    return new Promise((resolve) => {
        let raw = "";
        req.on("data", (chunk) => { raw += chunk; });
        req.on("end", () => {
            if (!raw) return resolve({});
            if ((req.headers["content-type"] || "").includes("x-www-form-urlencoded")) {
                return resolve(Object.fromEntries(new URLSearchParams(raw)));
            }
            try { resolve(JSON.parse(raw)); } catch { resolve({}); }
        });
    });
}

function videoId(url) {
    try {
        const link = new URL(url);
        return link.searchParams.get("v") || link.pathname.split("/").pop();
    } catch {
        return null;
    }
}

const routes = {
    // Public
    "GET /ping": () => [200, { message: "pong" }],
    "GET /playlist/": () => [200, songs],
    "GET /playlist/now-playing": () => [200, current],
    "GET /playlist/queue-finished": () => [200, finished],
    "GET /playlist/queue-settings": () => [200, settings],
    "GET /playlist/progress": () => [200, {
        p_id: current?.p_id ?? null,
        finished,
        playing,
        position,
        position_at: positionAt,
        server_time: now(),
        pause_before_songs: settings.pause_before_songs,
        auto_play: settings.auto_play,
        auto_play_seconds: settings.auto_play_seconds,
    }],
    "GET /playlist/search": ({ query }) => {
        const text = (query.get("q") || "").trim();
        if (!text) return [422, { detail: "Type something to search for." }];
        // Made-up results; adding one gives a "Sample song" with a random length.
        return [200, [1, 2, 3].map((n) => {
            const id = `sample${n}${text.replace(/[^A-Za-z0-9]/g, "").padEnd(4, "x")}`.slice(0, 11);
            return {
                url_id: id,
                url: `https://www.youtube.com/watch?v=${id}`,
                title: `${text} (sample result ${n})`,
                channel: "Sample channel",
                duration: 180 + n * 20,
                thumbnail: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
            };
        })];
    },
    "POST /playlist/add": ({ body }) => {
        if (!settings.open) return [403, { detail: "Queue is closed" }];
        if (!body.url || !body.name || !body.song_name) return [422, { detail: "Please fill in every field." }];
        const id = videoId(body.url);
        if (!id) return [422, { detail: "Invalid YouTube Video URL" }];
        if (songs.some((song) => song.url_id === id)) return [400, { detail: "Song exists in playlist" }];
        if (blocked.some((song) => song.url_id === id)) return [403, { detail: "Song was removed for being too long" }];
        if (findOwner(body.name)?.blacklist) return [403, { detail: "This name is blacklisted" }];
        const url = `https://www.youtube.com/watch?v=${id}`;
        return [200, addSong({ ...body, url }, `Sample song (${id})`, null, 180 + Math.floor(Math.random() * 120))];
    },

    // Admin login
    "POST /auth/login": ({ body }) => {
        if (body.username !== ADMIN.username || body.password !== ADMIN.password) {
            return [401, { detail: "Invalid username or password" }];
        }
        return [200, { message: "Logged in" }, { "Set-Cookie": `${COOKIE}=1; HttpOnly; Path=/; SameSite=Lax` }];
    },
    "POST /auth/logout": () => [200, { message: "Logged out" }, { "Set-Cookie": `${COOKIE}=; Max-Age=0; Path=/` }],

    // Admin: the main screen
    "GET /playlist/screen": () => [200, screen],
    "POST /playlist/screen": ({ body, query }) => {
        if (!/^[A-Za-z0-9-]{8,64}$/.test(body.device_id || "")) return [422, { detail: "Invalid device_id" }];
        if (!(query.get("only_if_unset") === "true" && screen.device_id)) {
            screen = { device_id: body.device_id, label: (body.label || "").trim().slice(0, 60), since: now() };
        }
        return [200, screen];
    },

    // Admin: playback
    "GET /playlist/current-play": () => [200, playback()],
    "GET /playlist/playback-stream": () => [404, { detail: "The sample backend has no video." }],
    "POST /playlist/position": ({ body }) => {
        if (!current || current.p_id !== body.p_id) return [200, false];
        if (body.duration && !current.duration) {
            current.duration = body.duration;
            if (body.duration > MAX_SECONDS) current.is_too_long = true;
        }
        const limit = current.duration ?? Infinity;
        position = Math.max(0, Math.min(Number(body.position) || 0, limit));
        positionAt = now();
        return [200, true];
    },
    "POST /playlist/play_pause": () => [200, playPause()],
    "POST /playlist/play": () => [200, playing ? playing : playPause()],
    "POST /playlist/pause": () => [200, playing ? playPause() : playing],
    "POST /playlist/skip": ({ query }) => {
        const from = query.get("from_p_id");
        if (from === null || Number(from) === current?.p_id) {
            changeSong(() => selectSong(current ? currentIndex() + 1 : 0));
        }
        return [200, playback()];
    },
    "POST /playlist/back": ({ query }) => {
        const from = query.get("from_p_id");
        if ((from === null || Number(from) === current?.p_id) && current) {
            changeSong(() => selectSong(finished ? currentIndex() : currentIndex() - 1));
        }
        return [200, playback()];
    },
    "POST /playlist/jump": ({ body }) => {
        const index = body.p_id != null ? findIndex(body.p_id) : body.order_num;
        if (!songs[index]) return [404, { detail: "Playlist entry not found" }];
        changeSong(() => selectSong(index));
        return [200, playback()];
    },

    // Admin: queue
    "POST /playlist/queue-settings": ({ body }) => {
        for (const key of ["open", "pause_before_songs", "auto_play"]) {
            if (typeof body[key] === "boolean") settings[key] = body[key];
        }
        if (Number.isInteger(body.auto_play_seconds)) {
            if (body.auto_play_seconds < 1 || body.auto_play_seconds > 300) {
                return [422, { detail: "auto_play_seconds must be 1 to 300" }];
            }
            settings.auto_play_seconds = body.auto_play_seconds;
        }
        return [200, settings];
    },
    "POST /playlist/move": ({ body }) => {
        const from = findIndex(body.p_id);
        if (from < 0) return [404, { detail: "Playlist entry not found" }];
        if (body.order_num < 0) return [400, { detail: "order_num must be non-negative" }];
        const [song] = songs.splice(from, 1);
        songs.splice(body.order_num, 0, song);
        renumber();
        return [200, song];
    },
    "POST /playlist/swap": ({ body }) => {
        const byId = body.p_id != null && body.swap_p_id != null;
        const first = byId ? findIndex(body.p_id) : body.original;
        const second = byId ? findIndex(body.swap_p_id) : body.swap;
        if (first === second) return [400, { detail: "The songs must be different" }];
        if (!songs[first] || !songs[second]) return [404, { detail: "One or both playlist entries were not found" }];
        [songs[first], songs[second]] = [songs[second], songs[first]];
        renumber();
        return [200, [songs[first], songs[second]]];
    },
    "DELETE /playlist/delete": ({ query }) => {
        const song = deleteSong(Number(query.get("playlist_id")));
        return song ? [200, song] : [404, { detail: "Playlist entry not found" }];
    },
    "DELETE /playlist/delete_too_long": ({ query }) => {
        const song = deleteSong(Number(query.get("playlist_id")));
        if (!song) return [404, { detail: "Playlist entry not found" }];
        blocked = blocked.filter((entry) => entry.url_id !== song.url_id);
        blocked.unshift({
            service: song.service,
            url_id: song.url_id,
            url: song.url,
            youtube_title: song.youtube_title,
            duration: song.duration,
            name: song.name,
            time: now(),
        });
        return [200, song];
    },
    "POST /playlist/keep": ({ query }) => {
        const song = songs[findIndex(Number(query.get("playlist_id")))];
        if (!song) return [404, { detail: "Playlist entry not found" }];
        song.is_too_long = false;
        return [200, song];
    },
    "GET /playlist/blocked": () => [200, blocked],
    "DELETE /playlist/blocked": ({ query }) => {
        const before = blocked.length;
        blocked = blocked.filter((entry) => entry.url_id !== query.get("url_id"));
        if (blocked.length === before) return [404, { detail: "Blocked song not found" }];
        return [200, { message: "Song unblocked" }];
    },
    // Sessions come from the real backend's log file, which the sample doesn't keep.
    "GET /playlist/sessions": () => [200, []],
    "POST /playlist/restore": () => [404, { detail: "That session wasn't found in the log." }],
    "DELETE /playlist/flush": () => {
        songs = [];
        current = null;
        finished = false;
        setPlaying(false);
        resetPosition();
        return [200, { message: "Playlist flushed" }];
    },

    // Admin: names
    "GET /names/": () => [200, names],
    "PUT /names/add": ({ body }) => {
        if (findName(body.name)) return [200, { found: true }];
        names.push({ name_id: nextNameId++, name: body.name, name_alt: [], blacklist: false });
        return [200, { found: false }];
    },
    "POST /names/to_alt": ({ body }) => {
        const target = findName(body.name);
        const moved = findName(body.name_alt);
        if (!target || !moved) return [404, { detail: "Name not found" }];
        target.name_alt.push(moved.name, ...moved.name_alt);
        names = names.filter((entry) => entry !== moved);
        songs.forEach((song) => { if (song.name_id === moved.name_id) song.name_id = target.name_id; });
        return [200, target];
    },
    "POST /names/to_name": ({ body }) => {
        const owner = names.find((entry) => entry.name_alt.includes(body.name));
        if (!owner) return [404, { detail: "Alt name not found" }];
        owner.name_alt = owner.name_alt.filter((alternate) => alternate !== body.name);
        const entry = { name_id: nextNameId++, name: body.name, name_alt: [], blacklist: false };
        names.push(entry);
        return [200, entry];
    },
    "POST /names/blacklist": ({ body }) => {
        const entry = findName(body.name);
        if (!entry) return [404, { detail: "Name not found" }];
        entry.blacklist = true;
        return [200, entry];
    },
    "POST /names/unblacklist": ({ body }) => {
        const entry = findName(body.name);
        if (!entry) return [404, { detail: "Name not found" }];
        entry.blacklist = false;
        return [200, entry];
    },
    "DELETE /names/delete": ({ body }) => {
        const owner = names.find((entry) => entry.name_alt.includes(body.name));
        if (owner) {
            owner.name_alt = owner.name_alt.filter((alternate) => alternate !== body.name);
            return [200, owner];
        }
        const entry = findName(body.name);
        if (!entry) return [404, { detail: "Name not found" }];
        names = names.filter((other) => other !== entry);
        return [200, entry];
    },
    "DELETE /names/flush": () => { names = []; return [200, null]; },

    // Admin: pending operations. Matching one merges the alternate name into the primary one.
    "GET /operation/": () => [200, operations],
    "POST /operation/handle": ({ body }) => {
        const operation = operations.find((entry) => entry.po_id === body.po_id);
        if (!operation) return [404, { detail: "Operation not found" }];
        const [status, result] = routes["POST /names/to_alt"]({ body: operation });
        if (status !== 200) return [status, result];
        operations = operations.filter((entry) => entry !== operation);
        return [200, result];
    },
    "POST /operation/handle_all": () => {
        const handled = [];
        for (const { po_id } of [...operations]) {
            const [status, result] = routes["POST /operation/handle"]({ body: { po_id } });
            if (status === 200) handled.push(result);
        }
        return [200, handled];
    },
    "DELETE /operation/delete": ({ body }) => {
        const before = operations.length;
        operations = operations.filter((entry) => entry.po_id !== body.po_id);
        if (operations.length === before) return [404, { detail: "Operation not found" }];
        return [200, null];
    },
    "DELETE /operation/flush": () => { operations = []; return [200, { message: "Operations flushed" }]; },
};

const PUBLIC = new Set([
    "GET /ping",
    "GET /playlist/",
    "GET /playlist/now-playing",
    "GET /playlist/queue-finished",
    "GET /playlist/queue-settings",
    "GET /playlist/progress",
    "GET /playlist/search",
    "POST /playlist/add",
    "POST /auth/login",
    "POST /auth/logout",
]);

http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") return send(res, req, 204);
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const key = `${req.method} ${url.pathname}`;
    const handler = routes[key];
    if (!handler) return send(res, req, 404, { detail: `No sample route for ${key}` });
    if (!PUBLIC.has(key) && !(req.headers.cookie || "").includes(`${COOKIE}=1`)) {
        return send(res, req, 401, { detail: "Not logged in" });
    }
    const [status, body, headers] = handler({ body: await readBody(req), query: url.searchParams });
    send(res, req, status, body, headers);
}).listen(PORT, () => {
    console.log(`Sample backend on http://localhost:${PORT} (admin login: ${ADMIN.username} / ${ADMIN.password})`);
});
