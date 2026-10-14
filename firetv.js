// firetv.js — Controls Fire TV / Fire Stick devices via ADB over Wi-Fi
// ADB must be enabled on each Fire TV: Settings > My Fire TV > Developer Options > ADB Debugging ON
// First connection requires approval on the TV screen

const { exec } = require("child_process");
const { promisify } = require("util");

const execAsync = promisify(exec);
const ADB_PORT = 5555;
const ADB_TIMEOUT_MS = 8000; // ADB can be slow, give it more time

// Map our internal command names to Android KEYCODE values
// Full list: https://developer.android.com/reference/android/view/KeyEvent
const FIRETV_KEY_MAP = {
  power:      "KEYCODE_POWER",
  home:       "KEYCODE_HOME",
  back:       "KEYCODE_BACK",
  up:         "KEYCODE_DPAD_UP",
  down:       "KEYCODE_DPAD_DOWN",
  left:       "KEYCODE_DPAD_LEFT",
  right:      "KEYCODE_DPAD_RIGHT",
  ok:         "KEYCODE_DPAD_CENTER",
  volumeup:   "KEYCODE_VOLUME_UP",
  volumedown: "KEYCODE_VOLUME_DOWN",
  mute:       "KEYCODE_VOLUME_MUTE",
};

// Run an ADB command safely — wraps exec with timeout and error cleanup
async function runAdb(command) {
  try {
    const { stdout, stderr } = await Promise.race([
      execAsync(command),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("ADB command timed out")), ADB_TIMEOUT_MS)
      ),
    ]);

    return { stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err) {
    throw new Error(`ADB error: ${err.message}`);
  }
}

// Connect to a Fire TV device via ADB over Wi-Fi
// Must be called before sending commands — ADB needs a live connection
async function connect(ip) {
  try {
    const { stdout } = await runAdb(`adb connect ${ip}:${ADB_PORT}`);

    // ADB returns messages like "connected to IP:5555" or "already connected"
    if (stdout.includes("connected") || stdout.includes("already connected")) {
      return { success: true, message: stdout };
    }

    // "unable to connect" or other failure messages
    throw new Error(stdout || "Could not connect via ADB");

  } catch (err) {
    throw new Error(`Cannot connect to Fire TV at ${ip}:${ADB_PORT}. Make sure ADB Debugging is ON and you approved the connection on the TV screen. Detail: ${err.message}`);
  }
}

// Send a keypress to a Fire TV device
async function sendKey(ip, command) {
  const keyCode = FIRETV_KEY_MAP[command];

  if (!keyCode) {
    throw new Error(`Unknown Fire TV command: "${command}". Valid commands: ${Object.keys(FIRETV_KEY_MAP).join(", ")}`);
  }

  // Try to connect first (safe to call if already connected)
  await connect(ip);

  try {
    await runAdb(`adb -s ${ip}:${ADB_PORT} shell input keyevent ${keyCode}`);
    return { success: true, message: `Sent "${keyCode}" to Fire TV at ${ip}` };
  } catch (err) {
    throw new Error(`Failed to send key to Fire TV at ${ip}: ${err.message}`);
  }
}

// Launch YouTube on Fire TV using its package name
async function openYouTube(ip) {
  await connect(ip);

  const launchCmd = `adb -s ${ip}:${ADB_PORT} shell am start -n com.amazon.firetv.youtube/com.google.android.youtube.tv.app.MainActivity`;

  try {
    await runAdb(launchCmd);
    return { success: true, message: `Launched YouTube on Fire TV at ${ip}` };
  } catch (err) {
    // YouTube may not be installed — fall back to opening the app store search
    try {
      await runAdb(
        `adb -s ${ip}:${ADB_PORT} shell am start -a android.intent.action.VIEW -d "https://www.youtube.com"`
      );
      return { success: true, message: `Opened YouTube (browser fallback) on Fire TV at ${ip}` };
    } catch (err2) {
      throw new Error(`Could not open YouTube on Fire TV at ${ip}. Is the YouTube app installed? ${err.message}`);
    }
  }
}

// Check if ADB can reach a Fire TV (quick connection test)
async function ping(ip) {
  try {
    const { stdout } = await Promise.race([
      runAdb(`adb connect ${ip}:${ADB_PORT}`),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 4000)),
    ]);

    const online = stdout.includes("connected") || stdout.includes("already connected");
    return { online };
  } catch {
    return { online: false };
  }
}

module.exports = { sendKey, openYouTube, ping, connect };
