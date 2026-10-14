// roku.js — Controls Roku devices via ECP (External Control Protocol)
// Roku ECP uses simple HTTP POST requests on port 8060
// No authentication required — works on local Wi-Fi

const fetch = require("node-fetch");

const ROKU_PORT = 8060;
const TIMEOUT_MS = 4000;

// Map our internal command names to Roku ECP key names
const ROKU_KEY_MAP = {
  power:      "Power",
  home:       "Home",
  back:       "Back",
  up:         "Up",
  down:       "Down",
  left:       "Left",
  right:      "Right",
  ok:         "Select",
  volumeup:   "VolumeUp",
  volumedown: "VolumeDown",
  mute:       "VolumeMute",
};

// Send a single keypress to a Roku device
async function sendKey(ip, command) {
  const rokuKey = ROKU_KEY_MAP[command];

  if (!rokuKey) {
    throw new Error(`Unknown Roku command: "${command}". Valid commands: ${Object.keys(ROKU_KEY_MAP).join(", ")}`);
  }

  const url = `http://${ip}:${ROKU_PORT}/keypress/${rokuKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      throw new Error(`Roku returned HTTP ${response.status} for key "${rokuKey}"`);
    }

    return { success: true, message: `Sent "${rokuKey}" to Roku at ${ip}` };

  } catch (err) {
    clearTimeout(timer);

    if (err.name === "AbortError") {
      throw new Error(`Timed out connecting to Roku at ${ip}:${ROKU_PORT} — is the IP correct and TV on?`);
    }

    throw new Error(`Failed to reach Roku at ${ip}: ${err.message}`);
  }
}

// Launch YouTube on a Roku device
// Roku YouTube channel ID is "tvinput.hdmi1" — but the real YouTube app ID is 2285
async function openYouTube(ip) {
  const url = `http://${ip}:${ROKU_PORT}/launch/2285`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      throw new Error(`Roku returned HTTP ${response.status} when launching YouTube`);
    }

    return { success: true, message: `Launched YouTube on Roku at ${ip}` };

  } catch (err) {
    clearTimeout(timer);

    if (err.name === "AbortError") {
      throw new Error(`Timed out connecting to Roku at ${ip} — is the TV on?`);
    }

    throw new Error(`Failed to launch YouTube on Roku at ${ip}: ${err.message}`);
  }
}

// Ping a Roku to check if it's online
async function ping(ip) {
  const url = `http://${ip}:${ROKU_PORT}/query/device-info`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);

  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return { online: response.ok };
  } catch (err) {
    clearTimeout(timer);
    return { online: false };
  }
}

module.exports = { sendKey, openYouTube, ping };
