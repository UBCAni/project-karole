// Adds up song lengths for the "total queue time" shown to singers and admins.

// Seconds as "1:02:05" or "4:07".
export function formatLength(totalSeconds) {
    const seconds = Math.round(totalSeconds);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = String(seconds % 60).padStart(2, "0");
    return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

// Seconds as "about 1 h 5 min" or "about 23 min", for quick reading.
export function describeLength(totalSeconds) {
    const minutes = Math.round(totalSeconds / 60);
    if (minutes < 1) return "under a minute";
    if (minutes < 60) return `about ${minutes} min`;
    const rest = minutes % 60;
    return `about ${Math.floor(minutes / 60)} h${rest ? ` ${rest} min` : ""}`;
}

// Some songs (live streams) have no known length; they are counted as zero.
// A song added when nothing could look the video up has no length (nor do live streams). Time
// totals count each as this long, and say they're estimates while such a song is still ahead.
export const UNKNOWN_SONG_SECONDS = 180;

export function songLength(song) {
    return song?.duration || UNKNOWN_SONG_SECONDS;
}

export function totalLength(songs) {
    return songs.reduce((sum, song) => sum + songLength(song), 0);
}

// How many of these songs have no known length (so the totals are estimates).
export function countUnknownLength(songs) {
    return songs.filter((song) => !song.duration).length;
}

// The line saying a total is an estimate, or null when every length is known.
export function describeUnknownLengths(songs) {
    const count = countUnknownLength(songs);
    if (!count) return null;
    return `estimate: ${count === 1 ? "1 song's length" : `${count} songs' lengths`} unknown, counted as ${UNKNOWN_SONG_SECONDS / 60} min${count === 1 ? "" : " each"}`;
}

// Notes how far this computer's clock is from the backend's, from a playback state the backend
// just sent (its server_time), so songElapsed can use this computer's clock.
export function stampClock(playback) {
    if (typeof playback?.server_time !== "number") return playback;
    return { ...playback, clockOffset: Date.now() / 1000 - playback.server_time };
}

// How far into the current song playback is at `nowSeconds` (this computer's clock, in seconds):
// the backend's position plus the time since, while playing; held between 0 and the song's length.
export function songElapsed(playback, nowSeconds) {
    if (!playback?.song || typeof playback.position !== "number") return 0;
    let elapsed = playback.position;
    if (playback.playing) elapsed += nowSeconds - (playback.clockOffset || 0) - playback.position_at;
    return Math.min(Math.max(elapsed, 0), playback.song.duration || Infinity);
}

// The small line under a total when "Start each song paused" is on: with auto-play, the waits
// before `waitCount` songs and the total with them; without it, the waits are however long the
// host takes to press Play, so they have no number. Nothing when the switch is off.
export function describeWaits(lengthSeconds, waitCount, settings) {
    if (!settings.pause_before_songs) return null;
    if (!settings.auto_play) return "+ pauses";
    const waits = waitCount * settings.auto_play_seconds;
    return `+ ${formatLength(waits)} delays = ${formatLength(lengthSeconds + waits)}`;
}

// Whether the current song is still held at the start by "Start each song paused": not playing
// and not yet begun. Only then does its start delay still lie ahead.
export function heldAtStart(playing, elapsed) {
    return !playing && elapsed < 0.5;
}

// Minutes as "40 min", "1 h" or "1 h 5 min".
function minutesText(minutes) {
    if (minutes < 60) return `${minutes} min`;
    const rest = minutes % 60;
    return `${Math.floor(minutes / 60)} h${rest ? ` ${rest} min` : ""}`;
}

// The public pages' estimate, live: "about 40–45 min" (plus `suffix`, e.g. " to go"). The low end
// is the songs still to sing, less what's been sung of the current one; the high end adds the
// auto-play delay before each song that hasn't started (the host may press Play sooner). One
// value when both round to the same minute, or with no delays; with "Start each song paused" but
// no auto-play, the pauses last until someone presses Play, so they're only mentioned.
// `upcoming` is from usePlaylist (the current song first, unless the queue has run out),
// `progress` from /playlist/progress.
export function describeEstimate(upcoming, progress, nowSeconds, suffix = "") {
    const text = estimateText(upcoming, progress, nowSeconds, suffix);
    // Songs with no known length are counted as UNKNOWN_SONG_SECONDS; say so while one is ahead.
    return countUnknownLength(upcoming) ? `${text} (some lengths estimated)` : text;
}

function estimateText(upcoming, progress, nowSeconds, suffix) {
    const current = progress && !progress.finished && upcoming[0]?.p_id === progress.p_id ? upcoming[0] : null;
    // The current song counts down to 0, never below, even when its length is only a guess.
    const elapsed = current ? Math.min(songElapsed({ ...progress, song: current }, nowSeconds), songLength(current)) : 0;
    const low = Math.max(0, totalLength(upcoming) - elapsed);
    const lowText = `${describeLength(low)}${suffix}`;
    if (!progress?.pause_before_songs) return lowText;
    if (!progress.auto_play) return `${lowText}, plus short pauses`;

    const notStarted = upcoming.filter((song) => song !== current || heldAtStart(progress.playing, elapsed)).length;
    const lowMinutes = Math.round(low / 60);
    const highMinutes = Math.round((low + notStarted * progress.auto_play_seconds) / 60);
    if (highMinutes <= lowMinutes) return lowText;
    if (lowMinutes < 1) return `up to about ${minutesText(highMinutes)}${suffix}`;
    const range = lowMinutes < 60 && highMinutes < 60
        ? `${lowMinutes}–${highMinutes} min`
        : `${minutesText(lowMinutes)} – ${minutesText(highMinutes)}`;
    return `about ${range}${suffix}`;
}
