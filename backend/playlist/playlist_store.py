# Owns the playlist while the server runs: the songs in play order, which song is
# playing, and the append-only JSON log of every change. Nothing is read back at
# startup; the admin restores a past session from the log instead (list_sessions,
# Playlist.restore).
import json
import os
import time

from models import NameEntry, PlaylistEntry

# How long a person's later songs wait at the back of the queue, in seconds: the 2nd song
# 10 minutes, each one after that 5 more, never more than 30 minutes.
SECOND_SONG_DELAY = 10 * 60
EXTRA_SONG_DELAY = 5 * 60
MAX_SONG_DELAY = 30 * 60


def line_up_time(priority: int, added_time: float) -> float:
    # priority is which of the person's songs this is tonight: 1 for their first, 2 for the
    # second, and so on.
    if priority <= 1:
        return added_time
    delay = SECOND_SONG_DELAY + EXTRA_SONG_DELAY * (priority - 2)
    return added_time + min(delay, MAX_SONG_DELAY)


# One JSON object per line, appended after every change.
PLAYLIST_LOG_PATH = os.path.join(os.path.dirname(__file__), "playlist_log.jsonl")


class Playlist:
    def __init__(self, log_path: str):
        self.log_path = log_path
        self.songs: list[PlaylistEntry] = []
        self.current_song: PlaylistEntry | None = None
        # How far into the current song playback is: `position` seconds at server time
        # `position_at`, plus the time since then while playing. Kept in memory only (not in the
        # log), for the admin page's live "Time left"; the YouTube window corrects it (set_position).
        self.position = 0.0
        self.position_at = time.time()
        self._playing = False
        # True once playback has run past the last song. current_song then stays on that
        # last song, so everything up to it counts as sung and new songs play next.
        self.finished = False

    @property
    def playing(self) -> bool:
        return self._playing

    @playing.setter
    def playing(self, playing: bool) -> None:
        # Pausing banks the time played so far; playing restarts the clock from where it was.
        now = time.time()
        if self._playing:
            self.position += now - self.position_at
        self.position_at = now
        self._playing = playing

    def reset_position(self) -> None:
        # A different song (or the same one from the start) begins at 0.
        self.position = 0.0
        self.position_at = time.time()

    def set_position(self, p_id: int, position: float, duration: float | None = None, too_long_after: float | None = None) -> bool:
        # The real position, reported by the YouTube window; ignored if it's about another song.
        if self.current_song is None or self.current_song.p_id != p_id:
            return False
        # A song added without a length (nothing could look it up) gets its real one from the
        # window once it plays, and is flagged if that's over the limit (it keeps playing). A
        # known length is never changed. Logged, so a restored session keeps it.
        if duration and not self.current_song.duration:
            self.current_song.duration = float(duration)
            if too_long_after is not None and duration > too_long_after:
                self.current_song.is_too_long = True
            self.renumber_and_log()
        if self.current_song.duration:
            position = min(position, self.current_song.duration)
        self.position = max(0.0, position)
        self.position_at = time.time()
        return True

    def renumber_and_log(self) -> None:
        # order_num always mirrors the position in the list, so it never has gaps or duplicates.
        for index, song in enumerate(self.songs):
            song.order_num = index

        current_song_p_id = None
        if self.current_song is not None:
            current_song_p_id = self.current_song.p_id
        log_entry = {
            "time": time.time(),
            "playing": self.playing,
            "current_song_p_id": current_song_p_id,
            "finished": self.finished,
            "songs": [song.model_dump() for song in self.songs],
        }
        with open(self.log_path, "a", encoding="utf-8") as log_file:
            log_file.write(json.dumps(log_entry, ensure_ascii=False) + "\n")

    def find_index(self, p_id: int) -> int | None:
        for index, song in enumerate(self.songs):
            if song.p_id == p_id:
                return index
        return None

    def find_current_index(self) -> int | None:
        for index, song in enumerate(self.songs):
            if song is self.current_song:
                return index
        return None

    def find_next_song(self) -> PlaylistEntry | None:
        current_index = self.find_current_index()
        if current_index is None or current_index + 1 >= len(self.songs):
            return None
        return self.songs[current_index + 1]

    def find_song_by_url(self, service: str | None, url_id: str | None) -> PlaylistEntry | None:
        for song in self.songs:
            if song.service == service and song.url_id == url_id:
                return song
        return None

    def next_p_id(self) -> int:
        highest_p_id = -1
        for song in self.songs:
            if song.p_id > highest_p_id:
                highest_p_id = song.p_id
        return highest_p_id + 1

    def find_priority_for_name(self, name_id: int) -> int:
        # A person's songs are numbered 1, 2, 3... so everyone gets a first turn
        # before anyone gets a second one. Returns 0 when they have no songs yet. Songs a person
        # had under two names before those were joined can share numbers (two 1s, two 2s), so
        # how many songs they have counts too.
        highest_priority = 0
        song_count = 0
        for song in self.songs:
            if song.name_id == name_id:
                song_count += 1
                highest_priority = max(highest_priority, song.priority_num)
        return max(highest_priority, song_count)

    def find_insert_index(self, priority: int, added_time: float) -> int:
        # Songs line up by when they were added plus a delay that grows with how many songs
        # that person already has queued (see line_up_time). A person's 2nd song is held at
        # the back for 10 minutes, letting everyone who adds a song meanwhile go ahead; after
        # that its place is fixed. New songs never go before the song playing now (or the
        # last one sung), and songs the admin moved by hand keep their places.
        new_line_up = line_up_time(priority, added_time)
        current_index = self.find_current_index()
        start = current_index + 1 if current_index is not None else 0
        for index in range(start, len(self.songs)):
            song = self.songs[index]
            if line_up_time(song.priority_num, song.time) > new_line_up:
                return index
        return len(self.songs)

    def add_song(self, song_info: dict, priority: int) -> PlaylistEntry:
        insert_index = self.find_insert_index(priority, song_info["time"])
        song = PlaylistEntry(
            **song_info,
            p_id=self.next_p_id(),
            order_num=insert_index,
            priority_num=priority,
        )
        self.songs.insert(insert_index, song)
        self.renumber_and_log()
        return song

    def delete_song(self, p_id: int) -> PlaylistEntry | None:
        index = self.find_index(p_id)
        if index is None:
            return None
        song = self.songs.pop(index)
        if song is self.current_song:
            # The playing song was removed, so playback continues with the song that took its place.
            self.select_song(index)
        self.renumber_and_log()
        return song

    def keep_long_song(self, p_id: int) -> PlaylistEntry | None:
        # The admin chose to let a too-long song play, so stop flagging it.
        index = self.find_index(p_id)
        if index is None:
            return None
        song = self.songs[index]
        song.is_too_long = False
        self.renumber_and_log()
        return song

    def move_song(self, p_id: int, new_index: int) -> PlaylistEntry | None:
        index = self.find_index(p_id)
        if index is None:
            return None
        song = self.songs.pop(index)
        self.songs.insert(new_index, song)
        self.renumber_and_log()
        return song

    def swap_songs(self, first_index: int, second_index: int) -> bool:
        song_count = len(self.songs)
        if not (0 <= first_index < song_count and 0 <= second_index < song_count):
            return False
        first_song = self.songs[first_index]
        self.songs[first_index] = self.songs[second_index]
        self.songs[second_index] = first_song
        self.renumber_and_log()
        return True

    def swap_songs_by_id(self, first_p_id: int, second_p_id: int) -> bool:
        first_index = self.find_index(first_p_id)
        second_index = self.find_index(second_p_id)
        if first_index is None or second_index is None:
            return False
        return self.swap_songs(first_index, second_index)

    def flush(self) -> None:
        self.songs = []
        self.current_song = None
        self.playing = False
        self.finished = False
        self.reset_position()
        self.renumber_and_log()

    def requeue_songs_under_name(self, old_name_id: int, name_entry: NameEntry, combine_queues: bool = True) -> None:
        # With combine_queues off, songs only change owner and keep their places. Otherwise,
        # queue the combined owner's remaining songs as if both names had always been one:
        # derive turn numbers from their original add times, then use those turns and times
        # to rebuild their positions. Keep songs already sung and the current song in place.
        current_index = self.find_current_index()
        original_positions = {song.p_id: index for index, song in enumerate(self.songs)}
        for song in self.songs:
            if song.name_id == old_name_id:
                # Keep the display name from when the song was added; only ownership changes.
                song.name_id = name_entry.name_id

        if combine_queues:
            combined_songs = [song for song in self.songs if song.name_id == name_entry.name_id]
            for priority, song in enumerate(
                sorted(combined_songs, key=lambda item: (item.time, original_positions[item.p_id])),
                start=1,
            ):
                song.priority_num = priority

            start = current_index + 1 if current_index is not None else 0
            queued_combined = [
                song for song in self.songs[start:] if song.name_id == name_entry.name_id
            ]
            queued_ids = {song.p_id for song in queued_combined}
            self.songs = [song for song in self.songs if song.p_id not in queued_ids]
            queued_combined.sort(
                key=lambda song: (
                    line_up_time(song.priority_num, song.time),
                    song.time,
                    original_positions[song.p_id],
                )
            )
            for song in queued_combined:
                self.songs.insert(
                    self.find_insert_index(song.priority_num, song.time),
                    song,
                )

        self.renumber_and_log()

    def restore(self, songs: list[PlaylistEntry], current_p_id: int | None, finished: bool) -> None:
        # Puts a past session back exactly as it was logged, but paused, so nothing starts
        # playing on its own. The restore is logged like any other change.
        self.songs = songs
        self.current_song = None
        for song in songs:
            if song.p_id == current_p_id:
                self.current_song = song
        self.playing = False
        self.finished = finished and self.current_song is not None
        self.reset_position()
        self.renumber_and_log()

    def playback_state(self) -> dict:
        # position is as of position_at; server_time lets a page allow for its own clock being off.
        return {
            "playing": self.playing,
            "song": self.current_song,
            "position": self.position,
            "position_at": self.position_at,
            "server_time": time.time(),
        }

    def select_song(self, index: int) -> None:
        # Plays the song at this position. Past the end it stops on the last song (see
        # finished); before the start it stops with nothing selected.
        self.finished = False
        if 0 <= index < len(self.songs):
            self.current_song = self.songs[index]
            self.playing = True
        elif self.songs and index >= len(self.songs):
            self.current_song = self.songs[-1]
            self.playing = False
            self.finished = True
        else:
            self.current_song = None
            self.playing = False
        self.reset_position()

    def play_pause(self) -> bool:
        current_index = self.find_current_index()
        if self.finished and current_index is not None:
            # Play starts the first song added since the queue ran out, or plays the last
            # song again when nothing new has been added.
            next_index = current_index + 1
            self.select_song(next_index if next_index < len(self.songs) else current_index)
            self.renumber_and_log()
            return self.playing
        if self.current_song is None:
            if not self.songs:
                return False
            self.current_song = self.songs[0]
            self.reset_position()
        self.playing = not self.playing
        self.renumber_and_log()
        return self.playing

    def set_playing(self, playing: bool) -> bool:
        # Play or Pause as pressed, rather than a toggle, so several people pressing the same
        # button at once agree instead of undoing each other. Play works as in play_pause (after
        # the queue ran out it starts the next song).
        if playing == self.playing:
            return self.playing
        return self.play_pause()

    def skip(self) -> None:
        current_index = self.find_current_index()
        if current_index is None:
            self.select_song(0)
        else:
            self.select_song(current_index + 1)
        self.renumber_and_log()

    def back(self) -> None:
        current_index = self.find_current_index()
        if current_index is None:
            # Already before the first song: stay there rather than wrapping round to the end.
            pass
        elif self.finished:
            # After the queue ran out, back replays the last song.
            self.select_song(current_index)
        else:
            self.select_song(current_index - 1)
        self.renumber_and_log()

    def jump(self, index: int) -> None:
        self.select_song(index)
        self.renumber_and_log()


# Reading the log back, to restore a past session.
# Log lines written before these fields were renamed use their old names.
OLD_FIELD_NAMES = {"author": "song_name", "url_title": "youtube_title"}


def read_log(log_path: str) -> list[tuple[int, dict]]:
    # Every snapshot with its line number (counting from 1). A line cut short, say by the
    # server stopping mid-write, is skipped.
    snapshots = []
    try:
        with open(log_path, encoding="utf-8") as log_file:
            for line_number, line in enumerate(log_file, start=1):
                try:
                    snapshot = json.loads(line)
                except ValueError:
                    continue
                if isinstance(snapshot, dict) and isinstance(snapshot.get("songs"), list):
                    snapshots.append((line_number, snapshot))
    except FileNotFoundError:
        pass
    return snapshots


def is_fresh_start(previous: dict, current: dict) -> bool:
    # Every change keeps at least one song as it was, so a snapshot that shares no song
    # (same p_id, same video) with the one before it comes from a restarted server.
    previous_songs = {song.get("p_id"): song.get("url_id") for song in previous["songs"]}
    return not any(previous_songs.get(song.get("p_id"), object()) == song.get("url_id") for song in current["songs"])


def describe_session(line_number: int, snapshot: dict) -> dict:
    songs = snapshot["songs"]
    current = None
    for index, song in enumerate(songs):
        if song.get("p_id") == snapshot.get("current_song_p_id"):
            current = (index, song)
    return {
        "line": line_number,
        "time": snapshot.get("time"),
        "song_count": len(songs),
        # Songs before the current one were sung (the current one too, once the queue ran out).
        "sung_count": 0 if current is None else current[0] + (1 if snapshot.get("finished") else 0),
        "current_title": None if current is None else current[1].get("youtube_title") or current[1].get("url_title"),
    }


def list_sessions(log_path: str, limit: int = 30) -> list[dict]:
    # The last snapshot of each session, newest first. A session ends when the playlist is
    # emptied (flush, or its last song deleted) or the server restarts.
    sessions = []
    last = None
    for line_number, snapshot in read_log(log_path):
        if not snapshot["songs"]:
            if last is not None:
                sessions.append(describe_session(*last))
            last = None
            continue
        if last is not None and is_fresh_start(last[1], snapshot):
            sessions.append(describe_session(*last))
        last = (line_number, snapshot)
    if last is not None:
        sessions.append(describe_session(*last))
    return list(reversed(sessions))[:limit]


def read_snapshot(log_path: str, line_number: int) -> dict | None:
    for number, snapshot in read_log(log_path):
        if number == line_number:
            return snapshot
    return None


def songs_from_snapshot(snapshot: dict) -> list[PlaylistEntry]:
    # Raises pydantic's ValidationError if a logged song no longer fits PlaylistEntry.
    songs = []
    for song in snapshot["songs"]:
        renamed = {OLD_FIELD_NAMES.get(key, key): value for key, value in song.items()}
        songs.append(PlaylistEntry(**renamed))
    return songs


playlist_store = Playlist(PLAYLIST_LOG_PATH)
