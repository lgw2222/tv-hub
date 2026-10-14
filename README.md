# 📺 6TV Control Hub — Setup Guide

A local web dashboard to control all 6 of your TVs from one screen.
Works from your PC browser **and** your phone on the same Wi-Fi network.

---

## 📁 Project Structure

```
6tv-control-hub/
├── server.js          ← Express backend (the brain)
├── roku.js            ← Roku ECP controller
├── firetv.js          ← Fire TV ADB controller
├── tvs.json           ← Your TV config (auto-created/saved)
├── package.json       ← Node.js dependencies
├── public/
│   └── index.html     ← The web dashboard UI
└── README.md          ← This file
```

---

## 🚀 Step 1 — Install Prerequisites

### Node.js
Download and install from: https://nodejs.org (choose the LTS version)
Verify with: `node --version`

### ADB (Android Debug Bridge) — Required for Fire TV only
ADB lets your PC talk to Fire TV over Wi-Fi.

**Windows:**
1. Download Platform Tools: https://developer.android.com/studio/releases/platform-tools
2. Extract the zip to a folder like `C:\platform-tools`
3. Add that folder to your PATH:
   - Search "Environment Variables" in Start Menu
   - Edit "Path" under System Variables
   - Add `C:\platform-tools`
4. Open a new Command Prompt and test: `adb version`

**Mac:**
```bash
brew install android-platform-tools
```
Then test: `adb version`

**Linux:**
```bash
sudo apt install adb
```

---

## 🚀 Step 2 — Install the Project

Open a terminal/command prompt in the `6tv-control-hub` folder:

```bash
npm install
```

This installs Express, node-fetch, and cors.

---

## 📺 Step 3 — Set Up Your Roku Devices

Roku devices work over Wi-Fi with NO extra configuration needed!
Just make sure:
- Your Roku and PC are on the **same Wi-Fi network**
- Find your Roku's IP: **Settings → Network → About → IP Address**

That's it! No developer mode needed for Roku.

---

## 🔥 Step 4 — Set Up Your Fire TV Devices

Fire TVs need ADB Debugging enabled. Do this **once** per device:

### 4a. Enable Developer Options
1. Go to **Settings → My Fire TV → About**
2. Click **"Fire TV Stick"** (or your device name) **7 times rapidly**
3. A message says "You are now a developer!" 🎉

### 4b. Enable ADB Debugging
1. Go back to **Settings → My Fire TV → Developer Options**
2. Turn ON **"ADB Debugging"**
3. Turn ON **"Apps from Unknown Sources"** (optional but recommended)

### 4c. Find Your Fire TV's IP Address
Go to **Settings → My Fire TV → About → Network** → note the IP address

### 4d. First-Time Connection (must do for EACH Fire TV)
Run this command in your terminal (replace with your Fire TV's IP):

```bash
adb connect 192.168.1.102:5555
```

**Look at your TV screen** — a dialog will appear:
> "Allow USB debugging from this computer?"

Click **"Allow"** (check "Always allow" to skip this step next time).

You should see in terminal: `connected to 192.168.1.102:5555`

Repeat for each Fire TV device.

### 4e. Test ADB is working
```bash
adb -s 192.168.1.102:5555 shell input keyevent KEYCODE_HOME
```
Your Fire TV should go to the Home screen!

---

## 🚀 Step 5 — Start the Server

```bash
node server.js
```

You'll see:
```
╔════════════════════════════════════════════╗
║        6TV Control Hub is running!        ║
╠════════════════════════════════════════════╣
║  Local:   http://localhost:3000           ║
║  Phone:   http://<YOUR-PC-IP>:3000        ║
╚════════════════════════════════════════════╝
```

### Find your PC's IP address:
- **Windows:** Open Command Prompt → `ipconfig` → look for "IPv4 Address" (like 192.168.1.50)
- **Mac/Linux:** `ip a` or `ifconfig` → look for 192.168.x.x

Open the dashboard on your PC: http://localhost:3000
Open on your phone: `http://192.168.1.50:3000` (use YOUR PC's IP)

---

## 📝 Step 6 — Add Your TVs

1. Click the **"+ Add TV"** button in the top right
2. Enter a name (e.g. "Living Room Roku")
3. Enter the IP address (e.g. 192.168.1.101)
4. Choose the device type (Roku or Fire TV)
5. Click **Save TV**

Repeat for all 6 TVs. Your config is saved to `tvs.json` automatically.

---

## 🔍 Step 7 — Test Each TV

1. Click the **🔍 (ping) button** on any TV card to test if it's reachable
   - 🟢 Green dot = online
   - 🔴 Red dot = offline/unreachable

2. Try the **Home** button first — safest test command

3. Use **"🔍 Ping All"** in the header to check all TVs at once

---

## 🎮 Remote Buttons Reference

| Button | Roku Command | Fire TV Keycode |
|--------|-------------|-----------------|
| Power | Power | KEYCODE_POWER |
| Home | Home | KEYCODE_HOME |
| Back | Back | KEYCODE_BACK |
| Up | Up | KEYCODE_DPAD_UP |
| Down | Down | KEYCODE_DPAD_DOWN |
| Left | Left | KEYCODE_DPAD_LEFT |
| Right | Right | KEYCODE_DPAD_RIGHT |
| OK/Select | Select | KEYCODE_DPAD_CENTER |
| Volume Up | VolumeUp | KEYCODE_VOLUME_UP |
| Volume Down | VolumeDown | KEYCODE_VOLUME_DOWN |
| Mute | VolumeMute | KEYCODE_VOLUME_MUTE |

---

## 🌐 Group Controls

| Button | Action |
|--------|--------|
| ⏻ Power All | Sends power to ALL TVs |
| ⌂ Home All | Sends Home to ALL TVs |
| 🔇 Mute All | Mutes ALL TVs |
| ▶ YouTube on Selected… | Opens YouTube picker — choose which TVs |

---

## ❌ Troubleshooting

### Roku not responding
- Double-check IP: Settings → Network → About
- Make sure Roku and PC are on the SAME Wi-Fi network
- Try pinging from terminal: `ping 192.168.1.101`
- Restart the Roku and try again

### Fire TV not connecting via ADB
- Confirm ADB Debugging is ON in Developer Options
- Re-run: `adb connect YOUR_FIRETV_IP:5555`
- Check the TV screen for an approval dialog
- If ADB is installed, `adb devices` should list the device

### "adb: command not found"
- ADB isn't in your PATH — see Step 1 above
- Restart your terminal after adding to PATH

### App works on PC but not phone
- Make sure your phone is on the same Wi-Fi network (not mobile data)
- Use your PC's local IP (192.168.x.x), not "localhost"
- Check if Windows Firewall is blocking port 3000:
  - Allow it: Windows Firewall → Allow an app → add Node.js

### YouTube doesn't open on Fire TV
- Make sure the YouTube app is installed on that Fire TV
- Try launching it manually first to confirm it works
- The app ID used: `com.amazon.firetv.youtube`

---

## 🔧 Tips

- **Auto-start on boot (Windows):** Add `node server.js` to Task Scheduler
- **Keep it running:** Install nodemon → `npm run dev` for auto-restart on code changes
- **Bookmark on phone:** Open the URL in your phone's browser → Add to Home Screen

---

## 📡 How It Works

```
Your Phone/PC Browser
        ↓  HTTP request
  Express Server (server.js)
     ↓            ↓
  roku.js       firetv.js
     ↓            ↓
HTTP POST      ADB command
to :8060       to :5555
     ↓            ↓
  Roku TV      Fire TV
```

- **Roku:** Uses Roku's built-in ECP (External Control Protocol) — simple HTTP
- **Fire TV:** Uses ADB (Android Debug Bridge) over Wi-Fi — requires ADB installed
