# Karole YouTube Controller (Firefox)

The Firefox version of `../karole-youtube-extension`: it plays the karaoke queue in a real
YouTube window, controlled from the player page at `/admin/view`. Everything in that folder's
README about using it applies here too.

This copy uses Manifest V2 and needs Firefox 115 or newer (Firefox menu > Help > About Firefox
shows the version and updates it).

## Install

- **Try it now (until Firefox closes):** go to `about:debugging#/runtime/this-firefox`, click
  **Load Temporary Add-on...** and choose `manifest.json` in this folder. Firefox removes it
  when it quits, so this is the way to test, or to use it for one night.
- **Keep it installed:** Firefox only keeps add-ons signed by Mozilla. Make a zip of this
  folder's contents (in Terminal, from this folder:
  `zip -r ../karole-youtube-extension-firefox.zip . -x ".*" "README.md"`), sign in at
  https://addons.mozilla.org/developers/, choose **Submit a New Add-on**, pick **On your own**
  (unlisted, so it never appears in the store) and upload the zip. Signing is free and
  automatic; download the signed `.xpi` it gives back and open it in Firefox to install.
  Each new version needs uploading again, with a higher `version` in `manifest.json`.

If the player page doesn't find the extension, open `about:addons`, click the extension, open
**Permissions** and make sure the Karole site and youtube.com are allowed.

## Letting songs start without a click

Firefox blocks videos from starting with sound until someone clicks in the page. To lift that
for YouTube: open youtube.com, click the permissions icon left of the address, and set
**Autoplay** to **Allow Audio and Video**. Every song then starts the moment the window opens.

## How it differs from the Chrome version

| File | Difference |
| --- | --- |
| `manifest.json` | Manifest V2: a background script instead of a service worker, and Firefox's add-on id. |
| `youtube-main-loader.js` | Only here. V2 can't run a content script inside YouTube's own page, so this adds `youtube-main.js` to the page as a `<script>`. |
| `background.js`, `site-bridge.js`, `youtube-player.js` | Same as Chrome's, but call `browser.` instead of `chrome.` (Firefox's `chrome.` calls don't return promises). |
| `youtube-main.js` | Identical. |

When changing a script, make the same change in the Chrome folder.

## Since 1.6.0

The admin Playlist page also steers the YouTube window when you change the song or press
play/pause there, and the extension moves the queue on by itself when a song ends, so the player
page can sit frozen in a background tab without holding anything up. See "How it works" in
`../karole-youtube-extension/README.md`; the two extensions work the same way.

Since 1.6.2, songs that should start paused open already stopped and silent; see the same README.
Since 1.6.3 such a song isn't allowed to start at all, so it sits at 0:00 with no sound or movement.
Since 1.7.0 it can also play by itself, with "Auto-play after a delay" on and its seconds set on the
site (1.7.1); pressing Play or Pause during the countdown cancels it.
Since 1.7.2 the window follows the backend by itself, so the queue can be run from a phone with no
Karole page awake on this computer.
Since 1.7.3 its auto-play and its move to the next song can't clash with presses from a phone at the
same moment.
Since 1.7.4 it reports where the song really is when it starts, pauses, resumes or jumps, for the
admin page's live "Time left".
Since 1.7.5 the player page asks the window for its state every 2 seconds, so a hidden, paused
window no longer looks disconnected. After updating the extension, reload the player page and
reopen the YouTube window.
Since 1.8.0 only the main screen plays; if another device becomes the main screen, this window
closes by itself.
Since 1.8.1 it also works on the live site, https://karaoke.ubcani.com.
Since 1.8.2 the window follows only the copy of the site whose player page drives it, so a second
copy open in another tab (say localhost and the hosted site) can't make it pause or switch songs.
Press "Open/Reopen YouTube window" on the other copy's player page to move it there on purpose.
Since 1.8.3 it also reports a playing song's real length, filling it in for songs added without one.
