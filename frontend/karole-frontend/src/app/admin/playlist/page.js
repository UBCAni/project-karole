"use client";

import { useEffect, useRef, useState } from "react";
import { BACKEND_URI } from "../../../lib/config";
import { adminFetch } from "../../../lib/admin-auth";
import AdminHeader from "../../../components/admin-header";
import SongThumbnail from "../../../components/song-thumbnail";
import QueueSettingsCard from "../../../components/queue-settings-card";
import { useQueueSettings } from "../../../lib/use-queue-settings";
import { fetchQueueFinished } from "../../../lib/use-playlist";
import { fetchMainScreen } from "../../../lib/main-screen";
import { fromSong, steerYouTubeWindow } from "../../../lib/youtube-window";
import { describeUnknownLengths, describeWaits, formatLength, heldAtStart, songElapsed, songLength, stampClock, totalLength } from "../../../lib/queue-time";
import shared from "../admin.module.css";
import styles from "./page.module.css";
import { getErrorMessage, statusMessage } from "../../../lib/api-error";

// A past session in the restore menu, e.g. "Oct 18, 1:51 AM · 4 songs (1 sung) · on "seasons"".
function describeSession(session) {
    const when = new Date(session.time * 1000).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
    });
    const count = `${session.song_count} ${session.song_count === 1 ? "song" : "songs"}`;
    const sung = session.sung_count ? ` (${session.sung_count} sung)` : "";
    const current = session.current_title ? ` · on "${session.current_title}"` : "";
    return `${when} · ${count}${sung}${current}`;
}

// Shows a length in seconds as minutes:seconds, for example 3725 becomes "62:05".
function formatDuration(totalSeconds) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = Math.floor(totalSeconds % 60);
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export default function AdminPlaylist() {
    const [songs, setSongs] = useState([]);
    // Songs deleted for being too long, which can't be added again until unblocked.
    const [blocked, setBlocked] = useState([]);
    // Past sessions that can be restored from the log: null until the admin asks for them.
    const [sessions, setSessions] = useState(null);
    const [restoreLine, setRestoreLine] = useState("");
    const [status, setStatus] = useState("loading");
    const [error, setError] = useState("");
    const [playback, setPlayback] = useState({ playing: false, song: null });
    const [openMenu, setOpenMenu] = useState(null);
    // Where the open song menu sits on screen. It floats above the page (position: fixed) so
    // the table's edges can't cut it off when there are only a few songs.
    const [menuPosition, setMenuPosition] = useState(null);

    // A floating menu would drift away from its song when the page scrolls, so close it. Not
    // while one of its boxes is being typed in, though: on a phone the keyboard coming up
    // scrolls and resizes the page, which would close the menu and with it the keyboard.
    const menuRef = useRef(null);
    useEffect(() => {
        if (openMenu === null) return;
        const close = () => {
            if (menuRef.current?.contains(document.activeElement)) return;
            setOpenMenu(null);
        };
        window.addEventListener("scroll", close, { passive: true });
        window.addEventListener("resize", close);
        return () => {
            window.removeEventListener("scroll", close);
            window.removeEventListener("resize", close);
        };
    }, [openMenu]);
    const [draggedId, setDraggedId] = useState(null);
    const [targetPositions, setTargetPositions] = useState({});
    const queue = useQueueSettings();
    // True once playback has run past the last song (playback.song is then that song).
    const [finished, setFinished] = useState(false);
    // Which device plays the video (set from Admin → View).
    const [mainScreen, setMainScreen] = useState(null);
    // This computer's clock, in seconds, moved on every second so Time left counts down.
    const [now, setNow] = useState(0);

    useEffect(() => {
        const tick = () => setNow(Date.now() / 1000);
        tick();
        const timer = window.setInterval(tick, 1000);
        return () => window.clearInterval(timer);
    }, []);

    useEffect(() => {
        let isActive = true;

        async function loadPlaylist() {
            try {
                // The playlist route is public but this one needs a login, so it is also what
                // notices a missing or expired one; adminFetch then goes to the login page.
                const playbackResponse = await adminFetch(`${BACKEND_URI}/playlist/current-play`, { cache: "no-store" });
                const response = await adminFetch(`${BACKEND_URI}/playlist/`, { cache: "no-store" });
                if (!playbackResponse.ok || !response.ok) {
                    throw new Error(statusMessage(response.status));
                }
                const nextPlayback = await playbackResponse.json();
                const playlist = await response.json();
                const queueFinished = await fetchQueueFinished();
                const blockedResponse = await adminFetch(`${BACKEND_URI}/playlist/blocked`, { cache: "no-store" });
                const blockedSongs = blockedResponse.ok ? await blockedResponse.json() : null;
                const screen = await fetchMainScreen().catch(() => null);
                if (isActive) {
                    if (screen) setMainScreen(screen);
                    if (blockedSongs) setBlocked(blockedSongs);
                    setPlayback(stampClock(nextPlayback));
                    setFinished(queueFinished);
                    setSongs(playlist.sort((first, second) => first.order_num - second.order_num));
                    setStatus("ready");
                    setError("");
                }
            } catch (requestError) {
                if (isActive) {
                    setError(requestError.message);
                    setStatus("error");
                }
            }
        }

        loadPlaylist();
        const refreshTimer = window.setInterval(loadPlaylist, 5000);
        return () => {
            isActive = false;
            window.clearInterval(refreshTimer);
        };
    }, []);

    async function refreshPlaylist() {
        const response = await adminFetch(`${BACKEND_URI}/playlist/`, { cache: "no-store" });
        if (!response.ok) {
            throw new Error(statusMessage(response.status));
        }
        setSongs((await response.json()).sort((first, second) => first.order_num - second.order_num));
        const blockedResponse = await adminFetch(`${BACKEND_URI}/playlist/blocked`, { cache: "no-store" });
        if (blockedResponse.ok) setBlocked(await blockedResponse.json());
        // Deleting or re-queueing songs can change what is playing.
        await refreshPlayback();
    }

    // Only runs after a change made on this page, which then also tells the YouTube window
    // directly rather than waiting for the player page to notice.
    async function refreshPlayback() {
        const response = await adminFetch(`${BACKEND_URI}/playlist/current-play`, { cache: "no-store" });
        if (!response.ok) {
            throw new Error(statusMessage(response.status));
        }
        const nextPlayback = await response.json();
        const nextFinished = await fetchQueueFinished();
        setPlayback(stampClock(nextPlayback));
        setFinished(nextFinished);
        steerYouTubeWindow(nextPlayback, nextFinished);
    }

    // Back, play/pause and skip: the same backend routes the player page uses.
    async function control(path) {
        setError("");
        try {
            const response = await adminFetch(`${BACKEND_URI}/playlist/${path}`, { method: "POST" });
            const result = await response.json().catch(() => null);
            if (!response.ok) {
                throw new Error(getErrorMessage(result, response));
            }
            await refreshPlayback();
        } catch (requestError) {
            setError(requestError.message);
        }
    }

    async function updatePlaylist(url, options) {
        setError("");
        try {
            const response = await adminFetch(`${BACKEND_URI}${url}`, options);
            const result = await response.json().catch(() => null);
            if (!response.ok) {
                throw new Error(getErrorMessage(result, response));
            }
            await refreshPlaylist();
            setOpenMenu(null);
        } catch (requestError) {
            setError(requestError.message);
        }
    }

    async function jumpSong(song) {
        setError("");
        try {
            const response = await adminFetch(`${BACKEND_URI}/playlist/jump`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ p_id: song.p_id }),
            });
            const result = await response.json().catch(() => null);
            if (!response.ok) {
                throw new Error(getErrorMessage(result, response));
            }
            setPlayback(stampClock(result));
            setFinished(false);
            steerYouTubeWindow(result, false);
        } catch (requestError) {
            setError(requestError.message);
        }
    }

    function moveSong(songId, targetIndex) {
        if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= songs.length) return;
        const song = songs.find((entry) => entry.p_id === songId);
        if (!song || song.order_num === targetIndex) return;
        updatePlaylist("/playlist/move", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ p_id: songId, order_num: targetIndex }),
        });
    }

    function swapSong(songId, targetPosition) {
        const targetIndex = Number(targetPosition) - 1;
        const song = songs.find((entry) => entry.p_id === songId);
        if (!song || !Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= songs.length) return;
        const target = songs[targetIndex];
        if (target.p_id === song.p_id) return;
        // By p_id, so the two songs shown are swapped even if the queue changed meanwhile.
        updatePlaylist("/playlist/swap", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ p_id: song.p_id, swap_p_id: target.p_id }),
        });
    }

    function deleteSong(song) {
        if (!window.confirm(`Delete "${song.youtube_title}" from the playlist?`)) return;
        updatePlaylist(`/playlist/delete?playlist_id=${song.p_id}`, { method: "DELETE" });
    }

    // Removes a too-long song and blocks it from being added again.
    function deleteTooLong(song) {
        updatePlaylist(`/playlist/delete_too_long?playlist_id=${song.p_id}`, { method: "DELETE" });
    }

    function unblock(blockedSong) {
        updatePlaylist(`/playlist/blocked?url_id=${encodeURIComponent(blockedSong.url_id)}`, { method: "DELETE" });
    }

    async function loadSessions() {
        setError("");
        try {
            const response = await adminFetch(`${BACKEND_URI}/playlist/sessions`, { cache: "no-store" });
            const result = await response.json().catch(() => null);
            if (!response.ok) {
                throw new Error(getErrorMessage(result, response));
            }
            setSessions(result);
            setRestoreLine(result.length ? String(result[0].line) : "");
        } catch (requestError) {
            setError(requestError.message);
        }
    }

    async function restoreSession() {
        const session = sessions?.find((entry) => String(entry.line) === restoreLine);
        if (!session) return;
        if (!window.confirm(`Restore the session from ${describeSession(session)}? It comes back paused.`)) return;
        await updatePlaylist(`/playlist/restore?line=${session.line}`, { method: "POST" });
        // The restore is itself logged, so the list now has a newer entry.
        await loadSessions();
    }

    function flushPlaylist() {
        if (!window.confirm("WARNING: this permanently deletes every song in the playlist.")) return;
        updatePlaylist("/playlist/flush", { method: "DELETE" });
    }

    function updateTarget(songId, value) {
        setTargetPositions((current) => ({ ...current, [songId]: value }));
    }

    // Time left counts the song playing now and everything after it.
    const currentIndex = songs.findIndex((song) => song.p_id === playback.song?.p_id);
    const remaining = currentIndex >= 0 ? songs.slice(currentIndex + (finished ? 1 : 0)) : songs;
    // Counts down while the song plays: the part of it already sung isn't left.
    const elapsed = currentIndex >= 0 && !finished ? songElapsed(playback, now) : 0;
    // A song whose length is only a guess (3 min) counts down to 0, never below.
    const timeLeft = Math.max(0, totalLength(remaining) - Math.min(elapsed, songLength(playback.song)));
    // With "Start each song paused", each song still to start waits first. The current song only
    // counts while it's held at the start (paused, not yet begun).
    const currentHeld = currentIndex >= 0 && !finished && heldAtStart(playback.playing, elapsed);
    const waitsLeft = remaining.filter((song) => song.p_id !== playback.song?.p_id || currentHeld).length;
    const timeLeftWaits = describeWaits(timeLeft, waitsLeft, queue);
    const wholeQueueWaits = describeWaits(totalLength(songs), songs.length, queue);
    // Songs with no known length count as 3 min, which makes a total an estimate until they've
    // been sung: marked with "~" and a line saying so.
    const timeLeftUnknown = describeUnknownLengths(remaining);
    const wholeQueueUnknown = describeUnknownLengths(songs);

    let playbackState = "Nothing is playing";
    if (finished) {
        playbackState = remaining.length > 0 ? "Queue ran out · press Play for the next song" : "Queue finished";
    } else if (playback.song) {
        playbackState = playback.playing ? "Now playing" : "Paused";
    }

    return (
        <main className={shared.page}>
            <AdminHeader />
            <section className={shared.panel}>
                <div className={shared.heading}>
                    <div>
                        <p className={shared.eyebrow}>Admin / Playlist</p>
                        <h1>Manage playlist</h1>
                    </div>
                </div>

                <div className={styles.queueBar}>
                    <dl className={styles.stats}>
                        <div>
                            <dt>Songs left</dt>
                            <dd>{remaining.length}</dd>
                        </div>
                        <div>
                            <dt>Time left</dt>
                            <dd>{timeLeftUnknown ? "~" : ""}{formatLength(timeLeft)}</dd>
                            {timeLeftWaits && <dd className={styles.statNote}>{timeLeftWaits}</dd>}
                            {timeLeftUnknown && <dd className={styles.statNote}>{timeLeftUnknown}</dd>}
                        </div>
                        <div>
                            <dt>Whole queue</dt>
                            <dd>{wholeQueueUnknown ? "~" : ""}{formatLength(totalLength(songs))}</dd>
                            {wholeQueueWaits && <dd className={styles.statNote}>{wholeQueueWaits}</dd>}
                            {wholeQueueUnknown && <dd className={styles.statNote}>{wholeQueueUnknown}</dd>}
                        </div>
                    </dl>
                    {mainScreen && (
                        <p className={styles.screenNote}>
                            {mainScreen.device_id
                                ? `Main screen: ${mainScreen.label || "a device"}`
                                : "No main screen yet: open Admin → View on the laptop for the TV"}
                        </p>
                    )}
                </div>

                <div className={`${styles.controls} ${playback.playing ? styles.isPlaying : ""}`}>
                    <SongThumbnail key={playback.song?.p_id} song={finished ? null : playback.song} className={styles.nowPlayingArt} />
                    <div className={styles.nowPlaying}>
                        <p className={styles.playbackState}>{playbackState}</p>
                        {playback.song && !finished && (
                            <p className={styles.nowPlayingTitle}>
                                {playback.song.youtube_title}
                                <span> sung by {playback.song.name}</span>
                            </p>
                        )}
                    </div>
                    <div className={styles.controlButtons}>
                        <button type="button" onClick={() => control(fromSong("back", playback.song?.p_id))} aria-label="Previous song">Back</button>
                        <button className={styles.playButton} type="button" onClick={() => control(playback.playing ? "pause" : "play")}>
                            {playback.playing ? "Pause" : "Play"}
                        </button>
                        <button type="button" onClick={() => control(fromSong("skip", playback.song?.p_id))} aria-label="Next song">Skip</button>
                    </div>
                </div>

                <QueueSettingsCard className={styles.settingsCard} queue={queue} onError={setError} />

                {error && <p className={shared.error} role="alert">{error}</p>}
                {songs.filter((song) => song.is_too_long).map((song) => (
                    <div className={styles.notice} role="alert" key={song.p_id}>
                        <p>
                            &quot;{song.youtube_title}&quot; added by {song.name} is {formatDuration(song.duration)} long,
                            which is over the limit.
                        </p>
                        <div className={styles.noticeActions}>
                            <button onClick={() => deleteTooLong(song)} title="Deletes it and blocks it from being added again">
                                Delete song
                            </button>
                            <button onClick={() => updatePlaylist(`/playlist/keep?playlist_id=${song.p_id}`, { method: "POST" })}>
                                Keep
                            </button>
                        </div>
                    </div>
                ))}
                {status === "loading" && <p className={shared.message}>Loading playlist...</p>}
                {status === "ready" && songs.length === 0 && <p className={shared.message}>No songs in the playlist.</p>}
                {status === "ready" && songs.length > 0 && (
                    <div className={shared.tableWrap}>
                        <table>
                            <thead>
                                <tr>
                                    <th>Order</th>
                                    <th>Name</th>
                                    <th>Channel</th>
                                    <th>YouTube Title</th>
                                    <th>Song Name</th>
                                    <th aria-label="Actions" />
                                </tr>
                            </thead>
                            <tbody>
                                {songs.map((song, index) => (
                                    <tr
                                        className={[
                                            styles.row,
                                            draggedId === song.p_id && styles.dragging,
                                            song.p_id === playback.song?.p_id && !finished && styles.currentRow,
                                            currentIndex >= 0 && (index < currentIndex || (finished && index === currentIndex)) && styles.sungRow,
                                        ].filter(Boolean).join(" ")}
                                        key={song.p_id}
                                        // Not while its menu is open: Firefox won't let anyone type in a box
                                        // inside something draggable.
                                        draggable={openMenu !== song.p_id}
                                        onClick={(event) => {
                                            if (draggedId !== null || event.target.closest(`button, input, a, .${styles.menu}`)) return;
                                            jumpSong(song);
                                        }}
                                        onDragStart={() => setDraggedId(song.p_id)}
                                        onDragEnd={() => setDraggedId(null)}
                                        onDragOver={(event) => event.preventDefault()}
                                        onDrop={() => {
                                            moveSong(draggedId, index);
                                            setDraggedId(null);
                                        }}
                                    >
                                        <td className={styles.order} data-label="Order">
                                            {index + 1}
                                            {song.p_id === playback.song?.p_id && !finished && (
                                                <span className={styles.rowBadge}>{playback.playing ? "Playing" : "Paused"}</span>
                                            )}
                                        </td>
                                        <td data-label="Name">{song.name}</td>
                                        <td className={styles.channelCell} data-label="Channel">
                                            <div className={styles.channel}>
                                                {/* Fallback: transparent 1x1 SVG if icon URL missing */}
                                                <img
                                                    className={styles.channelIcon}
                                                    src={song.url_channel_icon || "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxIiBoZWlnaHQ9IjEiPjwvc3ZnPg=="}
                                                    alt=""
                                                    onError={(e) => {
                                                        // If the provided URL fails to load, replace with transparent placeholder.
                                                        e.currentTarget.src = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxIiBoZWlnaHQ9IjEiPjwvc3ZnPg==";
                                                    }}
                                                />
                                                <span className={styles.channelName}>{song.url_creator}</span>
                                            </div>
                                        </td>
                                        <td data-label="YouTube Title">
                                            <a className={styles.songLink} href={song.url} target="_blank" rel="noreferrer">
                                                {song.youtube_title}
                                            </a>
                                        </td>
                                        <td data-label="Song Name">{song.song_name}</td>
                                        <td className={styles.actionCell}>
                                <button
                                    className={styles.menuButton}
                                    aria-label={`Actions for ${song.youtube_title}`}
                                    aria-expanded={openMenu === song.p_id}
                                    onClick={(event) => {
                                        if (openMenu === song.p_id) {
                                            setOpenMenu(null);
                                            return;
                                        }
                                        const button = event.currentTarget.getBoundingClientRect();
                                        // Open upwards when there isn't room below the button.
                                        const upwards = button.bottom + 340 > window.innerHeight && button.top > 340;
                                        setMenuPosition({
                                            right: Math.max(8, window.innerWidth - button.right),
                                            ...(upwards
                                                ? { bottom: window.innerHeight - button.top + 6 }
                                                : { top: button.bottom + 6 }),
                                        });
                                        setOpenMenu(song.p_id);
                                    }}
                                >
                                    ...
                                </button>
                                {openMenu === song.p_id && (
                                    <div
                                        className={styles.menu}
                                        style={menuPosition || undefined}
                                        ref={menuRef}
                                        // A tap anywhere in the menu, even on its empty space or a box's
                                        // label, never counts as a tap on the song (which would play it).
                                        onClick={(event) => event.stopPropagation()}
                                    >
                                        <button onClick={() => moveSong(song.p_id, index - 1)} disabled={index === 0}>Move up</button>
                                        <button onClick={() => moveSong(song.p_id, index + 1)} disabled={index === songs.length - 1}>Move down</button>
                                        <label>
                                            Move to
                                            <input
                                                type="number"
                                                min="1"
                                                max={songs.length}
                                                inputMode="numeric"
                                                pattern="[0-9]*"
                                                value={targetPositions[song.p_id] || ""}
                                                onChange={(event) => updateTarget(song.p_id, event.target.value)}
                                                onKeyDown={(event) => {
                                                    if (event.key === "Enter") moveSong(song.p_id, Number(targetPositions[song.p_id]) - 1);
                                                }}
                                            />
                                            <button onClick={() => moveSong(song.p_id, Number(targetPositions[song.p_id]) - 1)}>Move</button>
                                        </label>
                                        <label>
                                            Swap with
                                            <input
                                                type="number"
                                                min="1"
                                                max={songs.length}
                                                inputMode="numeric"
                                                pattern="[0-9]*"
                                                value={targetPositions[`swap-${song.p_id}`] || ""}
                                                onChange={(event) => updateTarget(`swap-${song.p_id}`, event.target.value)}
                                                onKeyDown={(event) => {
                                                    if (event.key === "Enter") swapSong(song.p_id, targetPositions[`swap-${song.p_id}`]);
                                                }}
                                            />
                                            <button onClick={() => swapSong(song.p_id, targetPositions[`swap-${song.p_id}`])}>Swap</button>
                                        </label>
                                        <button className={styles.delete} onClick={() => deleteSong(song)}>Delete</button>
                                    </div>
                                )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}

                {blocked.length > 0 && (
                    <div className={styles.blocked}>
                        <h2>Blocked for being too long</h2>
                        <p>Deleted from the warning above, so they can&apos;t be added again.</p>
                        <ul>
                            {blocked.map((blockedSong) => (
                                <li key={blockedSong.url_id}>
                                    <div>
                                        <a href={blockedSong.url} target="_blank" rel="noreferrer">
                                            {blockedSong.youtube_title}
                                        </a>
                                        <span>
                                            {blockedSong.duration ? formatDuration(blockedSong.duration) : "Unknown length"}
                                            {blockedSong.name && ` · added by ${blockedSong.name}`}
                                        </span>
                                    </div>
                                    <button type="button" onClick={() => unblock(blockedSong)}>
                                        Unblock
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}

                <div className={styles.restore}>
                    <h2>Restore a previous session</h2>
                    <p>
                        Brings back the queue from a past session, for example after the server stopped. Songs,
                        order and the current song come back as they were, paused.
                    </p>
                    {sessions === null && (
                        <button type="button" onClick={loadSessions}>Show previous sessions</button>
                    )}
                    {sessions?.length === 0 && <p>There are no previous sessions in the log yet.</p>}
                    {sessions?.length > 0 && (
                        <div className={styles.restoreRow}>
                            <select
                                value={restoreLine}
                                onChange={(event) => setRestoreLine(event.target.value)}
                                aria-label="Session to restore"
                            >
                                {sessions.map((session) => (
                                    <option key={session.line} value={session.line}>
                                        {describeSession(session)}
                                    </option>
                                ))}
                            </select>
                            <button type="button" onClick={restoreSession} disabled={songs.length > 0}>
                                Restore
                            </button>
                        </div>
                    )}
                    {sessions?.length > 0 && songs.length > 0 && (
                        <p className={styles.restoreHint}>
                            Restoring replaces the whole queue, so flush the playlist first (below).
                        </p>
                    )}
                </div>

                <div className={shared.dangerZone}>
                    <p>Destructive actions</p>
                    <button className={shared.flushButton} onClick={flushPlaylist}>
                        Flush playlist database
                    </button>
                </div>
            </section>
        </main>
    );
}