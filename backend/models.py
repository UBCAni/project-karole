from pydantic import BaseModel, Field, ConfigDict, model_validator, StringConstraints
from typing import Optional, Annotated
from dotenv import load_dotenv, dotenv_values 
import os
import re2 as re

load_dotenv()

max_length_name = os.getenv("MAX_NAME_LENGTH")

if (max_length_name != None): 
    max_length_name = int(max_length_name)
else:
    max_length_name = 30

# Song names can be longer than people's names, and may use any letters, numbers, punctuation and
# symbols (titles are often in other languages or full of punctuation), but not line breaks.
max_length_song_name = 70

# Group 1 is the 11 character video id. The final optional group allows extra
# parameters after it, such as "?si=..." on share links or "&t=42s".
url_match = re.compile(r"^(?:https?:\/\/)?(?:www\.)?(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|playlist\?|watch\?v=|watch\?.+(?:&|&#38;)v=))([a-zA-Z0-9\-_]{11})?(?:(?:\?|&|&#38;)index=((?:\d){1,3}))?(?:(?:\?|&|&#38;)?list=([a-zA-Z\-_0-9]{34}))?(?:[?&#].*)?$")
    
class NameInput(BaseModel):
    name: str = Field(pattern=r"^[\p{L}0-9_\s]+$")
        
    model_config = ConfigDict(str_max_length=max_length_name)
    
class NameChange(BaseModel):
    name: str = Field(pattern=r"^[\p{L}0-9_\s]+$")
    name_alt: str = Field(pattern=r"^[\p{L}0-9_\s]+$")
    
    model_config = ConfigDict(str_max_length=max_length_name)

class NameEntry(BaseModel):
    name_id: int
    name: str = Field(pattern=r"^[\p{L}0-9_\s]+$")
    name_alt: list[Annotated[str, StringConstraints(pattern=r"^[\p{L}0-9_\s]+$")]]
    blacklist: bool
    
    model_config = ConfigDict(str_max_length=max_length_name)
    
class OperationInput(BaseModel):
    name: str = Field(pattern=r"^[\p{L}0-9_\s]+$")
    name_alt: str = Field(pattern=r"^[\p{L}0-9_\s]+$")
    score: float
    
    model_config = ConfigDict(str_max_length=max_length_name)
    
class OperationID(BaseModel):
    po_id: int
    
class OperationEntry(BaseModel):
    po_id: int
    name: str = Field(pattern=r"^[\p{L}0-9_\s]+$")
    name_alt: str = Field(pattern=r"^[\p{L}0-9_\s]+$")
    score: float
    model_config = ConfigDict(str_max_length=max_length_name)

class PlaylistInput(BaseModel):
    url: str = Field(max_length=100)
    name: str = Field(pattern=r"^[\p{L}0-9_\s]+$")
    song_name: str = Field(max_length=max_length_song_name, pattern=r"^[\p{L}\p{M}\p{N}\p{P}\p{S}\p{Zs}]+$")
    url_id: str | None = None
    service: str | None = None
    
    model_config = ConfigDict(str_max_length=max_length_name)
    
    @model_validator(mode="after")
    def extract(self):
        m = url_match.match(self.url)

        if not m:
            raise ValueError("Invalid YouTube Video URL")

        if (not m.group(1) or m.group(1) == "videoseries"):
            raise ValueError("Invalid YouTube Video URL")
            
        object.__setattr__(self, 'url_id', m.group(1))
        object.__setattr__(self, 'service', "youtube")
        return self
    
class PlaylistEntry(BaseModel):
    p_id: int
    order_num: int
    priority_num: int
    name_id: int
    time: float
    name: str = Field(pattern=r"^[\p{L}0-9_\s]+$")
    song_name: str = Field(max_length=max_length_song_name, pattern=r"^[\p{L}\p{M}\p{N}\p{P}\p{S}\p{Zs}]+$")
    service: str | None = None
    url: str = Field(max_length=100)
    url_id: str | None = None
    # Empty when the video couldn't be looked up at all (see lookup_video in playlist.py).
    url_creator: str | None = Field(default=None, max_length=100)
    youtube_title: str = Field(max_length=100)
    url_channel_icon: str | None = Field(default=None, max_length=2048)
    # Length in seconds. is_too_long is set when it is over MAX_SONG_LENGTH_SECONDS,
    # and cleared again if the admin decides to keep the song.
    duration: float | None = None
    is_too_long: bool = False
    file_loc: Optional[str] = None
    is_downloaded: bool
    
    model_config = ConfigDict(str_max_length=max_length_name)

    @model_validator(mode="after")
    def validate_file_loc(self):
        if self.is_downloaded and not self.file_loc:
            raise ValueError("file_loc is required when is_downloaded is true")
        return self
    
# Songs are best named by p_id, which never changes; a place in the queue (order_num) can point at
# another song by the time the request arrives if someone else changed the queue meanwhile.
class PlaylistSwap(BaseModel):
    # Either the two songs' p_ids, or (older callers) their places.
    p_id: int | None = None
    swap_p_id: int | None = None
    original: int | None = None
    swap: int | None = None

    @model_validator(mode="after")
    def validate_songs(self):
        if (self.p_id is None or self.swap_p_id is None) and (self.original is None or self.swap is None):
            raise ValueError("Give p_id and swap_p_id, or original and swap")
        return self

class PlaylistMove(BaseModel):
    p_id: int
    order_num: int

class PlaylistJump(BaseModel):
    # Either the song's p_id, or (older callers) its place.
    p_id: int | None = None
    order_num: int | None = None

    @model_validator(mode="after")
    def validate_song(self):
        if self.p_id is None and self.order_num is None:
            raise ValueError("Give p_id or order_num")
        return self

# Where the YouTube window really is in a song, reported when it starts, pauses, resumes or jumps.
class PlaylistPosition(BaseModel):
    p_id: int
    position: float = Field(ge=0)
    # The song's real length, as the YouTube window sees it (from extension 1.8.3).
    duration: float | None = Field(default=None, gt=0)

# The device that plays the video (the "main screen"): a random ID its browser made up, and a
# short label to show admins which one it is, e.g. "Chrome on macOS".
class ScreenInput(BaseModel):
    device_id: str = Field(pattern=r"^[A-Za-z0-9-]{8,64}$")
    label: str = Field(default="", max_length=60)

class QueueSettingsInput(BaseModel):
    # Either or both; a setting left out keeps its value.
    open: bool | None = None
    pause_before_songs: bool | None = None
    # Whether a held song plays by itself, and after how many seconds.
    auto_play: bool | None = None
    auto_play_seconds: int | None = Field(default=None, ge=1, le=300, strict=True)