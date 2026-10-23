# Karole YouTube Controller (browser extension)

Plays the karaoke queue in a real YouTube window instead of the backend's video stream.
Every video that plays on youtube.com plays here, including ones that refuse to play on other
sites (Sing King karaoke videos, for example). Playback doesn't touch the backend, so YouTube's
"confirm you're not a bot" block doesn't affect it.

Install it only on the computer that drives the karaoke screen.

## Install (once, about a minute)

1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this folder (`frontend/karole-youtube-extension`).
4. "Karole YouTube Controller" now appears in the list. Leave it switched on.

After changing any file in this folder, click the reload arrow on the extension's card, then
reload the Karole player page. The extension takes the existing YouTube window over again
instead of opening a second one. If the player page says the YouTube window isn't responding,
click "Reconnect the YouTube window", or reload the player page.

### Edge, Brave, Opera, Vivaldi, Arc

These are built on Chrome, so the same folder works as it is. Open the browser's extensions page
(`edge://extensions`, `brave://extensions`, `opera://extensions`, `vivaldi:extensions`; in Arc,
`arc://extensions`), turn on **Developer mode**, click **Load unpacked** and choose this folder.

### Firefox

Firefox has its own copy in `../karole-youtube-extension-firefox` (Manifest V2, which this
Chrome version can't use since Chrome dropped V2). See the README there for installing it.

Safari isn't supported: it would need converting with Xcode and signing with an Apple
developer account.

## Using it

1. Sign in to YouTube in that Chrome. Age-restricted videos need a signed-in account, and
   YouTube Premium removes ads.
2. Open the player page at the live site, **https://karaoke.ubcani.com/admin/view** (from 1.8.1),
   or at **http://localhost:3000/admin/view**, or at the Tailscale address
   (https://dhairyas-macbook-pro.tail512d14.ts.net/admin/view). Use `localhost`, not
   `127.0.0.1`; the extension only works on the addresses listed in `manifest.json` (add any new
   address of the site there, in both extensions).
3. When the page finds the extension, it says "Video plays in the YouTube window", and as soon
   as a song is up it opens a YouTube window showing only the video.
4. Drag that window onto the karaoke screen and click **Full screen** on the player page to switch it on.
5. Keep the player page open on the laptop. It's the remote, with every control in one panel:
   Back, Play/Pause, Skip, a seek bar, volume and mute, slower/faster (0.25× to 2×, click the
   speed to go back to 1×), a captions menu (off, or any caption track the video has), full screen
   on or off, YouTube's own controls on or off, and reload. Volume, speed and the controls setting
   carry over to every song; captions are chosen per song. In the YouTube window,
   drag the captions to move them, and double-click them to put them back in the centre. The admin playlist page's buttons
   work too. When a song ends, the next one starts by itself.

If YouTube blocks the first song from starting with sound, click once on the video in the
YouTube window; later songs then start on their own. The player page says so when it happens
("YouTube is waiting to start").

### Letting songs start without a click (Chrome)

For Firefox, see `../karole-youtube-extension-firefox/README.md`.


Chrome only lets a page play with sound after someone has clicked in it, unless it already
trusts the site (a computer that watches a lot of YouTube in Chrome usually does). On a computer
where songs keep waiting for a click, add YouTube to Chrome's autoplay allow list, once:

- **Mac:** in Terminal, run
  `defaults write com.google.Chrome AutoplayAllowlist -array "https://www.youtube.com"`,
  then quit Chrome completely (Cmd+Q) and open it again.
- **Windows:** in Registry Editor, create the key
  `HKEY_CURRENT_USER\Software\Policies\Google\Chrome\AutoplayAllowlist` and add a string value
  named `1` with the data `https://www.youtube.com`, then restart Chrome.

Open `chrome://policy` and click **Reload policies**: `AutoplayAllowlist` should be listed with
YouTube in it. Every song then starts playing with sound the moment the window opens. To undo it
on a Mac, run `defaults delete com.google.Chrome AutoplayAllowlist` and restart Chrome; on
Windows, delete the registry key.

Without the extension, the player page is a remote (controls only, no video), unless that device
is made the main screen: then it plays the video in the built-in player (the backend's stream).

## Putting the site online

Add the site's address to the `"matches"` list for `site-bridge.js` in `manifest.json`, e.g.
`"https://karaoke.ubcani.com/*"`, then reload the extension.

## How it works

When changing a script here, make the same change in `../karole-youtube-extension-firefox`. Its
copies differ only in using `browser.` where these use `chrome.`, and in loading
`youtube-main.js` through `youtube-main-loader.js`.

| File | Job |
| --- | --- |
| `site-bridge.js` | Runs on the Karole site and passes messages between the player page and the extension. |
| `background.js` | Opens the YouTube window (one only), points it at each song, relays commands and status, and moves the queue on when a song ends. |
| `youtube-player.js` | Runs on youtube.com, but only takes over the window the extension opened: it hides everything but the video, turns off YouTube's "autoplay next", applies play/pause, and reports what's playing. |
| `youtube-main.js` | Runs inside YouTube's own page so it can use YouTube's player controls (`playVideo`, `pauseVideo`, `seekTo`). Jumping by setting the video's time directly makes YouTube's player stall. |

Ads are left alone: while one plays the player page shows "Ad playing" and waits.

Since 1.6.0 the player page doesn't have to stay awake. Browsers freeze a tab that has sat in
the background for a while, and the player page used to be the only thing telling the YouTube
window what to do. Now the admin Playlist page also steers the window when you change the song
or press play/pause there (it never opens one; that's still the player page's job). When a song
ends, the extension itself checks the backend still has that song current, moves the queue on and
loads the next one, through the site's `/backend` pass-through with the admin login of this
browser. If it can't reach the backend, the player page does it as before. The same song sent
twice (say by the Playlist page, then by the player page when it wakes up) isn't restarted.

Since 1.6.2, a song that should start paused ("Start each song paused" on the Playlist or View
page) opens with `karole=paused` in its address. `youtube-main.js` reads it before YouTube's player
loads and stops the video the instant it starts (muted until stopped, so nothing is heard), until
Play is pressed on the site. Ads are left to play; the song after them is held the same way.
Since 1.6.3 the held song isn't allowed to start at all (its `play()` is refused like a blocked
autoplay), so it sits at 0:00 with no sound or movement; the instant stop above is kept as a backup.
Since 1.7.0, with "Auto-play after a delay" on (1.7.1) and its seconds set on the site, the window
counts down once the held song is ready (after any ad), then asks the background to press Play,
which first checks the backend that it's still the same song and still paused. Pressing Play or
Pause on the site during the countdown cancels it for that song. Each step is logged in the YouTube
window's console (and the extension's background console) as "Karole auto-play: ...".
Since 1.7.1 a held song is also stopped when YouTube moves on to it from an ad, which it does
without starting the video again.

Since 1.7.2 the extension also checks the backend itself, at most once a second while the YouTube
window is open (on the window's status reports), and makes the window match: another song is
loaded, the same song only gets play or pause. So the queue can be run from a phone (admin Playlist
page, or View, which opens as a remote on phones) with no Karole page awake on this computer. A song
that just ended is left to the extension's own move to the next song, so it's never replayed, and a
check that only repeats the current state doesn't cancel an auto-play countdown. Changes are logged
in the background console as "Karole sync: ...".
Since 1.7.3 the extension's own presses can't clash with someone else's: auto-play presses Play
(`/playlist/play`) rather than toggling, and moving on after a song ends names that song
(`/playlist/skip?from_p_id=`), so a Skip from a phone at the same moment doesn't skip two songs.
Since 1.7.4 the window tells the backend where the song really is (`POST /playlist/position`)
whenever the song itself starts, pauses, resumes or jumps, for the admin page's live "Time left".
It only sends on those changes, never every second.
Since 1.7.5 the player page asks the window for its state every 2 seconds, and the window answers at
once. A hidden window (minimized, covered, on another screen) that's paused gets its own report
timer slowed by the browser to as little as once a minute, which made the player page think it had
disconnected; being asked works anyway. Updating or reloading the extension still cuts off the open
pages: the player page then says "The extension was updated", and reloading it and reopening the
YouTube window fixes it.

Since 1.8.0 only the **main screen** plays (see "The main screen" in the site's README). The
extension gives its browser an ID (kept in the extension's local storage, the same at every address
of the site), the player page uses it to claim the main screen, and every second while its YouTube
window is open the extension checks that it still is: if another device has taken over, it closes
its window, even with no Karole page open. The first player page with the extension claims the main
screen by itself while no device has it.

Since 1.8.2 the window follows one copy of the site only: the one whose player page loaded its
song. With two copies open on the same computer (say the laptop's own at localhost and the hosted
https://karaoke.ubcani.com), which have different queues, the window used to follow whichever page
spoke to the extension last and kept pausing or switching songs. Now the other copy's pages can't
steer it (their loads, Play/Pause and other commands are ignored) while the driving player page is
open. To move the window to the other copy on purpose, press "Open/Reopen YouTube window" on that
copy's player page; closing the driving page also lets the other one take over. Best during an
event: keep only one copy of the site open on the screen's laptop.

Since 1.8.3 the position reports also carry the song's real length. A song added without one (when
nothing could look the video up) gets it filled in on the site as soon as it plays, so the time
totals stop estimating it.
