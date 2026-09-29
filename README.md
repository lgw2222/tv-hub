# TV Control Hub

One phone remote for all your Rokus and Google TVs. A small server runs on your PC; your phone opens it in the browser on the same Wi-Fi.

## 1. Install Node.js (once)
Download the LTS version from https://nodejs.org and install it.

## 2. Install ADB (once, only needed for Google TVs)
1. Download "SDK Platform-Tools for Windows": https://developer.android.com/tools/releases/platform-tools
2. Unzip it to `C:\platform-tools`
3. Add it to PATH: Start menu, search "environment variables", Edit the system environment variables, Environment Variables, select Path under your user, Edit, New, `C:\platform-tools`, OK.
4. Open a new Command Prompt and run `adb version` to check.

Don't want to touch PATH? Start the server with `set ADB_PATH=C:\platform-tools\adb.exe` before `node server.js`.

## 3. Prep each TV

**Roku**
- Find the IP: Settings > Network > About.
- Make sure Settings > System > Advanced system settings > Control by mobile apps > Network access is not Disabled or Limited.
- For "Turn on" to work from off: Settings > System > Power > Fast TV start: On (Roku TVs).

**Fire TV / Fire Stick**
1. Settings > My Fire TV > About > click the device name 7 times until it says you're a developer.
2. Settings > My Fire TV > Developer options > turn on **ADB debugging**.
3. Find the IP: Settings > My Fire TV > About > Network.
4. Add it in the dashboard, tap **Connect**, then check "Always allow from this computer" and tap Allow on the TV.

**Google TV**
1. Settings > System > About > scroll to "Android TV OS build" and press OK 7 times until it says you're a developer.
2. Settings > System > Developer options > turn on **USB debugging**. (Despite the name, this also allows network control.)
3. Find the IP: Settings > Network & Internet > your Wi-Fi network.
4. In the dashboard, add the TV, then tap **Connect**. A prompt appears on the TV: check "Always allow from this computer" and tap **Allow**.

If Connect keeps failing on a newer Google TV (Android 14 / Google TV Streamer), use the "Pair with a code" section in the dashboard with Developer options > Wireless debugging.

**Newer Fire Sticks (Vega OS, e.g. Fire TV Stick 4K Select)**
These have no ADB. If "Developer options" shows a code screen instead of an ADB switch, it's a Vega stick.
1. Find the IP: Settings > My Fire TV > About > Network.
2. In the dashboard, add it with type **Fire TV (Vega)**, then tap **Pair**.
3. A PIN appears on the TV. Type it in. You only do this once; the hub remembers it.
Volume isn't available over Wi-Fi on these sticks, so use the TV's remote for volume.

## 4. Run it
Double-click `start.bat` (first run installs everything). Or in this folder:
```
npm install
node server.js
```
The window prints the address for your phone, like `http://192.168.1.20:3000`. Open that on your phone, then use Share > Add to Home Screen so it opens like an app.

Keep the window open while you use the remote.

## Using it
- Tap a TV at the top to control it. Turn on **Control several** to tap more than one, or tap **All TVs**.
- Dots: green on, yellow asleep, red can't reach.
- D-pad and volume repeat when held.
- The app buttons only show apps installed on the TVs you picked.
- On a PC, arrow keys, Enter and Backspace work too.

## Harmony Hub (most reliable power)
A TV that's fully off drops off Wi-Fi, but it always listens for its own remote's infrared signal.
If you have a Logitech Harmony Hub, the hub can send each TV's power code through it:
1. In the Harmony app, add each TV as a device, and turn on Settings > Harmony Setup > Add/Edit Devices & Activities > Remote & Hub > Enable XMPP.
2. In Manage TVs > Harmony Hub, enter the Harmony Hub's IP and tap Connect.
3. Edit each TV and pick its Harmony device. Use Test IR to check.
Turn on / Turn off / Power then go through Harmony for that TV. Everything else still goes over Wi-Fi.

## Presets
Tap **+ New preset**, name it (like "Game Day"), and add steps: pick a TV (or All TVs) and an action:
turn on/off, open an app, press a button, type text, or wait a few seconds. **Test it** runs it without saving.
Tap a preset to run it. Tap **Edit** above the presets to change or delete one. Presets are saved on the PC,
so every phone and iPad sees the same ones, and they survive updates.

## Voice and typed commands
Type or say things like "Game Day", "ESPN on the Hisense", "turn off all TVs", "pause the Roku Ultra",
or "search for Ted Lasso on the TCL". On iPhone, iPad and Android, tap the mic key on the keyboard to dictate
(browsers block the built-in mic on plain http pages, so the blue mic button focuses the box for you).

## iPad
On an iPad the remote sits on the left and presets, commands and apps on the right, in portrait or landscape.
Use Share > Add to Home Screen so it opens full screen like an app.

## Tips
- Give each TV a reserved IP in your router settings so addresses never change.
- Google TVs can drop the ADB connection after a reboot. The hub reconnects automatically; if it doesn't, tap Connect.
- If Windows Firewall asks about Node.js, allow it on Private networks or your phone can't reach the hub.

## Running and updating it

This app is meant to run inside **Server Hub**. Upload this folder to GitHub Pages with
your uploader, paste its address into Server Hub's "Add an app", and it installs, gets a
port, and starts. To update later, upload the new folder and tap Update on its card.
`tvs.json` is listed as a keep file, so your saved TVs survive updates.

To run it on its own instead, use `npm install` then `node server.js` in this folder.


## Sonos speakers
The Speakers section finds your Sonos speakers on its own. You can play, pause and skip; set the group volume or each speaker's volume; mute; and use "Group with…", "Change group" or "Group all" the same way the Sonos app does. A Sub or surrounds bonded to a soundbar are part of that room and don't show up separately.

## Lights (MagicLight / Magic Home)
Tap Find in the Lights section. Your lights' names from the MagicLight app can't be read over the local network, so each light shows up as "Light" plus the last 6 characters of its MAC address. Tap ⋯, tap Blink it to see which light flashes, then rename it. Tapping a light's tile turns it on or off. Lights that are offline in the MagicLight app will show as offline here too.

Voice/typed examples: "lights off", "window light blue", "bottom clouds 50%", "Sonos volume 30", "pause the music", "group all speakers".


## Music on Sonos and Spotify
Each speaker group shows the album art, a progress bar you can drag, Shuffle/Repeat, and a **Music** button:
- **Favorites**: your Sonos favorites (Spotify playlists, radio stations, anything you've saved in the Sonos app). Tap to play now, or use Next / + Queue.
- **Spotify**: paste any Spotify share link to play it (no setup needed). To search, connect a Spotify developer app (steps are shown in the app; the owner needs Premium, and the login has to be done once on the PC at http://127.0.0.1:3000).
- **Playlists**: saved Sonos playlists.
- **Queue**: see what's up next, jump to a song, remove songs, clear.
Once Spotify is connected, a Spotify card at the top of Speakers shows what your account is playing on any device (phone, PC, Sonos), with controls, volume and "Play on" to move it.
Voice/typed: "play Harvest Moon on the TV Room", "play my Chill Vibes playlist", "play <a Sonos favorite>".


## Lights to the music
Lights → **Music sync**. The iPad (or PC) microphone listens to the room and flashes the chosen lights on the beat, like the MagicLight app's Music tab. Effects: Color jump, Pulse (one color), Rainbow, Strobe; adjust Sensitivity if it misses beats or flashes too much. When you stop, each light goes back to how it was.
The mic only works on a secure page. The hub also runs one at **https://192.168.1.40:3443** (port = app port + 443). Open it on the iPad, accept the "not private" warning once (it's your own PC's self-made certificate), and add that page to the Home Screen. That also makes the voice-command mic button work.
No mic? Tap the "Tap here on the beat" button a few times and the lights keep that tempo.

## TV sound on Sonos
Speaker cards with a soundbar (Beam, Arc, Ray…) have a **TV** button that switches that group to the TV's HDMI sound; the other speakers in the group keep playing along. Speakers with a line-in (Five, Port, Amp) get a **Line-in** button. Tapping **Music** and picking something switches back to music. Voice/typed: "switch the Sonos to TV".

## Spotify button
The green **Spotify** button in Speakers opens the full Spotify player (the Spotify app on iPad/phone, open.spotify.com on the PC). Spotify Connect keeps every player in sync, so you can see Up Next and skip songs that are playing on your Sonos.

## Control all lights, scenes and light shows
Lights → **Control all**: pick all lights or just some, turn them on/off, choose a color, warm/soft/daylight white, a custom color, brightness, one-tap scenes (Movie night, Relax, Bright, Party, Chill, Night light), save your own scenes from how the lights look right now, and start the lights' built-in shows (fades, jumps, strobes) with a speed slider. Each light's ⋯ sheet has light shows too.

## Rearranging the screen
Tap the grid icon at the top (next to settings). Press and hold a panel and drag it, or use the arrows; ⇆ moves it to the other column on the iPad; the eye hides it. The phone and iPad each remember their own layout.

## Button feedback
In layout editing: Vibrate (Android phones; iPhones on iOS 18+ get a light tap), Click sound (good for the iPad, which can't vibrate), Both, or Off.

## Alexa
The hub shows up to Alexa as a Philips Hue bridge on your network (works with 2nd-gen and newer Echo devices, no skill or account linking). Say "Alexa, discover devices". TVs and presets appear as plugs (on/off), lights as color lights (on/off, color, white temperature, brightness), Sonos rooms as dimmable devices (on = play, off = pause, percent = volume), and the Beam's room gets a "TV sound" switch. Manage names and which devices Alexa sees in Settings → Alexa. Requires port 80 on the PC to be free.
