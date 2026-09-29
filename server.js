// TV Control Hub: control Roku and Google TV devices from one phone dashboard.
// Roku  -> ECP over HTTP port 8060 (IP only, no pairing)
// Google TV -> ADB over the network (one-time "Allow" prompt on the TV)

const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");
const dgram = require("dgram");
const { execFile } = require("child_process");

const PORT = process.env.PORT || 3000;
const ADB = process.env.ADB_PATH || "adb";
const TVS_FILE = path.join(__dirname, "tvs.json");
const TYPES = ["roku", "googletv", "firetv", "vega"];
const https = require("https");
const http = require("http");

const app = express();
app.use(express.json());
// index.html can live in a "public" subfolder or right next to this file
const WEB_DIR = fs.existsSync(path.join(__dirname, "public", "index.html"))
  ? path.join(__dirname, "public")
  : __dirname;
app.use(express.static(WEB_DIR));

// ---------- storage ----------
function loadTvs() {
  try { return JSON.parse(fs.readFileSync(TVS_FILE, "utf8")); } catch { return []; }
}
function saveTvs(tvs) { fs.writeFileSync(TVS_FILE, JSON.stringify(tvs, null, 2)); }
let tvs = loadTvs();
const findTv = (id) => tvs.find((t) => t.id === id);

// ---------- key maps ----------
const ROKU_KEYS = {
  power: "Power", poweron: "PowerOn", poweroff: "PowerOff",
  home: "Home", back: "Back", menu: "Info",
  up: "Up", down: "Down", left: "Left", right: "Right", ok: "Select",
  volup: "VolumeUp", voldown: "VolumeDown", mute: "VolumeMute",
  play: "Play", rew: "Rev", ff: "Fwd", replay: "InstantReplay",
};
const ADB_KEYS = {
  power: "KEYCODE_POWER", poweron: "KEYCODE_WAKEUP", poweroff: "KEYCODE_SLEEP",
  home: "KEYCODE_HOME", back: "KEYCODE_BACK", menu: "KEYCODE_MENU",
  up: "KEYCODE_DPAD_UP", down: "KEYCODE_DPAD_DOWN", left: "KEYCODE_DPAD_LEFT",
  right: "KEYCODE_DPAD_RIGHT", ok: "KEYCODE_DPAD_CENTER",
  volup: "KEYCODE_VOLUME_UP", voldown: "KEYCODE_VOLUME_DOWN", mute: "KEYCODE_VOLUME_MUTE",
  play: "KEYCODE_MEDIA_PLAY_PAUSE", rew: "KEYCODE_MEDIA_REWIND", ff: "KEYCODE_MEDIA_FAST_FORWARD",
  replay: "KEYCODE_MEDIA_PREVIOUS",
};

// ---------- app catalog (one name, per-platform IDs) ----------
const APPS = [
  { key: "youtube",   name: "YouTube",     roku: ["837"],    android: ["com.google.android.youtube.tv"], fire: ["com.amazon.firetv.youtube", "com.google.android.youtube.tv"] },
  { key: "netflix",   name: "Netflix",     roku: ["12"],     android: ["com.netflix.ninja"] },
  { key: "youtubetv", name: "YouTube TV",  roku: ["195316"], android: ["com.google.android.youtube.tvunplugged"] },
  { key: "hulu",      name: "Hulu",        roku: ["2285"],   android: ["com.hulu.livingroomplus"], fire: ["com.hulu.plus", "com.hulu.livingroomplus"] },
  { key: "disney",    name: "Disney+",     roku: ["291097"], android: ["com.disney.disneyplus"] },
  { key: "prime",     name: "Prime Video", roku: ["13"],     android: ["com.amazon.amazonvideo.livingroom"], fire: ["com.amazon.avod", "com.amazon.amazonvideo.livingroom"] },
  { key: "max",       name: "Max",         roku: ["61322"],  android: ["com.wbd.stream", "com.hbo.hbonow"] },
  { key: "peacock",   name: "Peacock",     roku: ["593099"], android: ["com.peacocktv.peacockandroid"] },
  { key: "paramount", name: "Paramount+",  roku: ["31440"],  android: ["com.cbs.ott"] },
  { key: "espn",      name: "ESPN",        roku: ["34376"],  android: ["com.espn.score_center"] },
  { key: "appletv",   name: "Apple TV",    roku: ["551012"], android: ["com.apple.atve.androidtv.appletv"], fire: ["com.apple.atve.amazon.appletv"] },
  { key: "spotify",   name: "Spotify",     roku: ["22297"],  android: ["com.spotify.tv.android"] },
  { key: "plex",      name: "Plex",        roku: ["13535"],  android: ["com.plexapp.android"] },
  { key: "pluto",     name: "Pluto TV",    roku: ["74519"],  android: ["tv.pluto.android"] },
  { key: "mlb",       name: "MLB",         roku: [], rokuName: /^MLB(\.TV)?$/i, android: ["com.bamnetworks.mobile.android.gameday.atbat"],
    asin: "B007FIJ9EI", rokuStore: "https://channelstore.roku.com/details/d281bf597911a8730e5d0d8aecdf670b/mlb" },
];
// app-store info for installing (Fire TV: Amazon ASIN, Roku: channel-store page for apps without a known number)
const rokuIdsFor = (entry, tvId) => { const names = (appCache.get(tvId) || {}).names || new Map(); const extra = entry.rokuName ? [...names].filter(([, n]) => entry.rokuName.test(n)).map(([id]) => id) : []; return [...entry.roku, ...extra]; };

// which package list applies to a device
const pkgsFor = (tv, entry) => (tv.type === "firetv" && entry.fire ? entry.fire : entry.android);

// ---------- Roku (ECP) ----------
async function rokuReq(tv, method, p, timeout = 3000) {
  let res;
  try {
    res = await fetch(`http://${tv.ip}:8060${p}`, { method, signal: AbortSignal.timeout(timeout) });
  } catch {
    throw new Error(`Can't reach ${tv.ip}. Check that the Roku is plugged in and on the same Wi-Fi.`);
  }
  if (!res.ok) {
    if (res.status === 403) throw new Error("Roku blocked the command. Turn on Settings > System > Advanced system settings > Control by mobile apps.");
    throw new Error(`Roku returned ${res.status}`);
  }
  return res.text();
}
const xmlTag = (xml, tag) => (xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`)) || [])[1];

// ---------- Google TV (ADB) ----------
function run(args, timeout = 8000) {
  return new Promise((resolve, reject) => {
    execFile(ADB, args, { timeout }, (err, stdout, stderr) => {
      if (err && err.code === "ENOENT") return reject(new Error("ADB isn't installed or isn't on your PATH. See README step 2."));
      if (err) return reject(new Error((stderr || err.message).trim()));
      resolve(stdout.trim());
    });
  });
}
const serial = (tv) => `${tv.ip}:${tv.adbPort || 5555}`;

async function adbEnsure(tv) {
  const state = await run(["-s", serial(tv), "get-state"], 4000).catch(() => "");
  if (state === "device") return;
  const out = await run(["connect", serial(tv)], 8000);
  if (/unauthorized/i.test(out)) throw new Error("Check the TV and tap Allow on the debugging prompt.");
  if (!/connected/i.test(out) || /cannot|failed|refused/i.test(out)) throw new Error(`Couldn't reach ${tv.name}: ${out}`);
  const after = await run(["-s", serial(tv), "get-state"], 4000).catch((e) => e.message);
  if (after !== "device") throw new Error(/unauthorized/i.test(after) ? "Check the TV and tap Allow on the debugging prompt." : `ADB state: ${after}`);
}
async function adbShell(tv, ...cmd) {
  await adbEnsure(tv);
  return run(["-s", serial(tv), "shell", ...cmd]);
}

// ---------- Fire TV (Vega OS) via the Fire TV phone-app API ----------
// Newer Fire Sticks (Vega OS) have no ADB. They accept the same local API the Fire TV phone app uses:
// DIAL wake on :8009, then JSON over :8080 with a one-time PIN pairing that returns a client token.
const VEGA_KEY = "0987654321";
function vegaRaw(tv, method, pathQ, body, scheme, timeout = 5000, noToken = false) {
  return new Promise((resolve, reject) => {
    const lib = scheme === "http" ? http : https;
    const data = body == null ? null : JSON.stringify(body);
    const headers = { "X-Api-Key": VEGA_KEY, "Content-Type": "application/json; charset=utf-8", "User-Agent": "okhttp/4.10.0" };
    if (tv.vegaToken && !noToken) headers["X-Client-Token"] = tv.vegaToken;
    if (data) headers["Content-Length"] = Buffer.byteLength(data);
    const req = lib.request({ host: tv.ip, port: 8080, path: pathQ, method, headers, timeout, rejectUnauthorized: false }, (res) => {
      let out = ""; res.on("data", (c) => (out += c));
      res.on("end", () => resolve({ status: res.statusCode, body: out }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
function vegaWake(tv) {
  return new Promise((resolve) => {
    const req = http.request({ host: tv.ip, port: 8009, path: "/apps/FireTVRemote", method: "POST", timeout: 4000, headers: { "Content-Length": 0 } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("timeout", () => req.destroy()); req.on("error", () => resolve(0)); req.end();
  });
}
async function vegaReq(tv, method, pathQ, body, noToken = false) {
  const order = tv.vegaScheme ? [tv.vegaScheme, tv.vegaScheme === "https" ? "http" : "https"] : ["https", "http"];
  let lastErr, authFail = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const scheme of order) {
      try {
        const r = await vegaRaw(tv, method, pathQ, body, scheme, 5000, noToken);
        if (r.status === 401 || r.status === 403) {
          // Right after the stick wakes, its remote service can reject a valid token for a moment. Wake it and try again before blaming the pairing.
          authFail++; lastErr = new Error("not accepted");
          if (authFail >= 2) {
            tv.vegaAuthFails = (tv.vegaAuthFails || 0) + 1; saveTvs(tvs);
            throw Object.assign(new Error(/FireTV\/app\//.test(pathQ) ? `${tv.name} won't open that app from the hub.` : `${tv.name} didn't accept the hub's saved pairing. If it happens again, tap Pair in Manage TVs (the old pairing is kept until the new PIN works).`), { fatal: true });
          }
          break;
        }
        if (r.status >= 400) throw Object.assign(new Error(`${tv.name} returned ${r.status}${r.body ? ": " + r.body.slice(0, 120) : ""}`), { fatal: true });
        if (tv.vegaScheme !== scheme || tv.vegaAuthFails) { tv.vegaScheme = scheme; delete tv.vegaAuthFails; saveTvs(tvs); }
        return r.body;
      } catch (e) { if (e.fatal) throw e; lastErr = e; }
    }
    if (lastErr && lastErr.message === "not accepted") { await new Promise((r) => setTimeout(r, 1500)); lastErr = null; continue; } // it answered, just not ready: wait, don't re-wake
    await vegaWake(tv); // remote service may be asleep; wake it and retry
    await new Promise((r) => setTimeout(r, attempt ? 2000 : 1200));
  }
  throw new Error(`Can't reach ${tv.name} at ${tv.ip}. Make sure it's on and on the same Wi-Fi. (${lastErr ? lastErr.message : "no answer"})`);
}
const VEGA_KEYS = {
  up: ["FireTV", "dpad_up"], down: ["FireTV", "dpad_down"], left: ["FireTV", "dpad_left"], right: ["FireTV", "dpad_right"],
  ok: ["FireTV", "select"], home: ["FireTV", "home"], back: ["FireTV", "back"], menu: ["FireTV", "menu"],
  play: ["media", "play"], rew: ["media", "scan", { direction: "back" }], ff: ["media", "scan", { direction: "forward" }],
  replay: ["media", "scan", { direction: "back" }],
  volup: ["FireTV", "volume_up"], voldown: ["FireTV", "volume_down"], mute: ["FireTV", "mute"],
  power: ["FireTV", "sleep"], poweroff: ["FireTV", "sleep"], poweron: ["FireTV", "home"],
};
async function vegaKey(tv, cmd) {
  if (!tv.vegaToken) throw new Error(`Pair ${tv.name} first: Manage TVs, then Pair.`);
  const k = VEGA_KEYS[cmd];
  if (!k) throw new Error(`Unknown command ${cmd}`);
  try { return await vegaReq(tv, "POST", `/v1/${k[0]}?action=${k[1]}`, k[2] || {}); }
  catch (e) {
    if (/^(volup|voldown|mute)$/.test(cmd)) throw new Error(`Volume isn't available on ${tv.name} over Wi-Fi. Pick its TV under "Harmony device" in Manage TVs and volume will go through Harmony.`);
    throw e;
  }
}

// ---------- Logitech Harmony Hub (infrared power) ----------
// IR works even when a TV is fully off, so the hub can ask Harmony to send the TV's own power code.
// Local API: POST :8088 for the hub id, then a WebSocket on :8088 for config and commands.
const HARMONY_FILE = path.join(__dirname, "harmony.json");
let harmony = (() => { try { return JSON.parse(fs.readFileSync(HARMONY_FILE, "utf8")); } catch { return { ip: "" }; } })();
const saveHarmony = () => fs.writeFileSync(HARMONY_FILE, JSON.stringify(harmony, null, 2));
function harmonyHubId(ip) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ id: 1, cmd: "setup.account?getProvisionInfo", params: {} });
    const req = http.request({ host: ip, port: 8088, path: "/", method: "POST", timeout: 5000,
      headers: { "Content-Type": "application/json", Accept: "utf-8", Origin: "http://sl.dhg.myharmony.com", "Content-Length": Buffer.byteLength(body) } }, (res) => {
      let out = ""; res.on("data", (c) => (out += c));
      res.on("end", () => { try { const j = JSON.parse(out); const id = j.data && (j.data.activeRemoteId || j.data.remoteId); id ? resolve(String(id)) : reject(new Error("Harmony Hub didn't return its id")); } catch { reject(new Error("Unexpected answer from Harmony Hub")); } });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => reject(new Error(`Can't reach the Harmony Hub at ${ip} (${e.message}). Check the IP, and in the Harmony app turn on Settings > Harmony Setup > Add/Edit Devices & Activities > Remote & Hub > Enable XMPP.`)));
    req.write(body); req.end();
  });
}
let hws = null, hwsReady = null, hwsSeq = 1;
const hwsWait = new Map();
async function harmonySocket() {
  if (!harmony.ip) throw new Error("Set up the Harmony Hub first (Manage TVs, Harmony Hub).");
  if (hws && hws.readyState === 1) return hws;
  if (hwsReady) return hwsReady;
  if (typeof WebSocket !== "function") throw new Error("Harmony needs Node.js 22 or newer on the PC. Update Node from nodejs.org.");
  hwsReady = (async () => {
    if (!harmony.hubId) { harmony.hubId = await harmonyHubId(harmony.ip); saveHarmony(); }
    const ws = new WebSocket(`ws://${harmony.ip}:8088/?domain=svcs.myharmony.com&hubId=${harmony.hubId}`);
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("Harmony Hub didn't answer")), 6000);
      ws.onopen = () => { clearTimeout(t); res(); };
      ws.onerror = () => { clearTimeout(t); rej(new Error(`Can't connect to the Harmony Hub at ${harmony.ip}`)); };
    });
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString()); } catch { return; }
      const w = hwsWait.get(String(m.id));
      if (w) { hwsWait.delete(String(m.id)); w(m); }
    };
    ws.onclose = () => { hws = null; };
    const ping = setInterval(() => { if (ws.readyState !== 1) return clearInterval(ping); try { ws.send(JSON.stringify({ hubId: harmony.hubId, timeout: 30, hbus: { cmd: "vnd.logitech.connect/vnd.logitech.pingvnd.logitech.ping", id: String(hwsSeq++), params: {} } })); } catch {} }, 50000);
    hws = ws;
    return ws;
  })().finally(() => { hwsReady = null; });
  return hwsReady;
}
async function harmonyCall(cmd, params, wait = true) {
  let ws;
  try { ws = await harmonySocket(); }
  catch (e) { if (harmony.hubId) { delete harmony.hubId; saveHarmony(); } throw e; }
  const id = String(hwsSeq++);
  const msg = JSON.stringify({ hubId: harmony.hubId, timeout: 30, hbus: { cmd, id, params } });
  if (!wait) { ws.send(msg); return null; }
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { hwsWait.delete(id); reject(new Error("Harmony Hub timed out")); }, 8000);
    hwsWait.set(id, (m) => { clearTimeout(t); resolve(m); });
    ws.send(msg);
  });
}
let harmonyCache = { at: 0, devices: [] };
async function harmonyDevices(force) {
  if (!force && harmonyCache.devices.length && Date.now() - harmonyCache.at < 10 * 60 * 1000) return harmonyCache.devices;
  const r = await harmonyCall("vnd.logitech.harmony/vnd.logitech.harmony.engine?config", { verb: "get" });
  const devs = ((r && r.data && r.data.device) || []).map((d) => {
    const cmds = [];
    for (const g of d.controlGroup || []) for (const f of g.function || []) cmds.push({ name: f.name, label: f.label || f.name, group: g.name, action: f.action });
    return { id: String(d.id), label: d.label, model: d.model, manufacturer: d.manufacturer, type: d.type, commands: cmds };
  });
  harmonyCache = { at: Date.now(), devices: devs };
  return devs;
}
function harmonyPick(dev, want) {
  const names = { poweron: ["PowerOn", "On"], poweroff: ["PowerOff", "Off"], power: ["PowerToggle", "Power"],
    volup: ["VolumeUp", "Volume Up", "VolUp"], voldown: ["VolumeDown", "Volume Down", "VolDown"], mute: ["Mute", "MuteToggle", "Mute Toggle"] }[want] || [want];
  for (const n of names) { const c = dev.commands.find((x) => x.name.toLowerCase() === n.toLowerCase()); if (c) return c; }
  if (/^(volup|voldown|mute)$/.test(want)) return null;
  // fall back to the toggle for on/off if the device has no discrete codes
  if (want !== "power") return harmonyPick(dev, "power");
  // no toggle code: "Power" acts as "Turn on" (the remote's off button still works through Turn off)
  return dev.commands.find((x) => /^(poweron|on)$/i.test(x.name)) || null;
}
async function harmonySend(tv, want) {
  const devs = await harmonyDevices();
  const dev = devs.find((d) => d.id === String(tv.harmonyDevice));
  if (!dev) throw new Error(`${tv.name}'s Harmony device wasn't found. Pick it again in Manage TVs.`);
  const c = harmonyPick(dev, want);
  if (!c) throw new Error(`${dev.label} has no ${/^(volup|voldown|mute)$/.test(want) ? "volume" : "power"} command in Harmony.`);
  const base = { timestamp: "0", verb: "render", action: c.action };
  await harmonyCall("vnd.logitech.harmony/vnd.logitech.harmony.engine?holdAction", { status: "press", ...base }, false);
  await new Promise((r) => setTimeout(r, 150));
  await harmonyCall("vnd.logitech.harmony/vnd.logitech.harmony.engine?holdAction", { status: "release", ...base }, false);
  return `${dev.label}: ${c.label}`;
}

// ---------- Wake-on-LAN ----------
// When a TV is fully off its network goes quiet, so commands can't reach it. A "magic packet"
// to its MAC address wakes TVs that support it (Roku TVs with Fast TV start, many Google/Fire TVs
// with network standby on). The hub learns each TV's MAC automatically while the TV is on.
const normMac = (m) => { const h = String(m || "").replace(/[^0-9a-f]/gi, "").toLowerCase(); return h.length === 12 ? h.match(/../g).join(":") : ""; };
function learnMac(tv) {
  if (tv.mac) return;
  const cmd = process.platform === "win32" ? ["arp", ["-a", tv.ip]] : ["arp", ["-n", tv.ip]];
  execFile(cmd[0], cmd[1], { timeout: 3000, windowsHide: true }, (err, out) => {
    const m = String(out || "").match(/([0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i);
    const mac = m && normMac(m[0]);
    if (mac && mac !== "ff:ff:ff:ff:ff:ff" && !tv.mac) { tv.mac = mac; saveTvs(tvs); }
  });
}
function sendWol(tv) {
  const mac = normMac(tv.mac);
  if (!mac) return Promise.resolve(false);
  const hex = Buffer.from(mac.replace(/:/g, ""), "hex");
  const pkt = Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(hex)]);
  const subnetBcast = tv.ip.split(".").slice(0, 3).join(".") + ".255";
  return new Promise((resolve) => {
    const sock = dgram.createSocket("udp4");
    sock.on("error", () => { try { sock.close(); } catch {} resolve(false); });
    sock.bind(() => {
      sock.setBroadcast(true);
      let n = 0;
      const fire = () => {
        for (const addr of [subnetBcast, "255.255.255.255"]) for (const port of [9, 7]) sock.send(pkt, port, addr, () => {});
        if (++n < 3) setTimeout(fire, 250); else setTimeout(() => { try { sock.close(); } catch {} resolve(true); }, 300);
      };
      fire();
    });
  });
}
// try a command; if the TV can't be reached and we're turning it on, wake it and keep trying for a bit
async function withWake(tv, fn, wakeIt) {
  try { return await fn(); }
  catch (e) {
    if (!wakeIt || !tv.mac) {
      if (wakeIt) throw new Error(`${e.message} ${tv.name} is fully off and the hub doesn't know its MAC address yet, so it can't wake it. Add the MAC in Manage TVs, or turn it on once with the remote.`);
      throw e;
    }
    await sendWol(tv);
    const until = Date.now() + 25000;
    let last = e;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 2500));
      try { return await fn(); } catch (err) { last = err; }
      if (Date.now() + 5000 < until) sendWol(tv);
    }
    throw new Error(`${tv.name} didn't wake up. Turn on its network standby setting (see the hint in Manage TVs). (${last.message})`);
  }
}

// ---------- device-agnostic actions ----------
async function sendKey(tv, cmd) {
  const waking = cmd === "poweron" || cmd === "power";
  const powerCmd = cmd === "poweron" || cmd === "poweroff" || cmd === "power";
  if (powerCmd && tv.harmonyDevice && harmony.ip) {
    // Infrared through Harmony is the most reliable way to switch a TV on or off.
    // Also send Wake-on-LAN so the TV's network comes up quickly for the next command.
    if (waking && tv.mac) sendWol(tv);
    return harmonySend(tv, cmd);
  }
  if (/^(volup|voldown|mute)$/.test(cmd) && tv.harmonyDevice && harmony.ip) {
    // Volume goes to the TV itself by infrared through Harmony (Fire Sticks can't change TV volume over Wi-Fi)
    try { return await harmonySend(tv, cmd); }
    catch (e) { if (tv.type === "vega") throw e; } // other TVs: fall back to Wi-Fi volume
  }
  if (waking && tv.mac) sendWol(tv); // fire a wake packet up front; harmless if the TV is already on
  return withWake(tv, () => sendKeyRaw(tv, cmd), waking);
}
async function sendKeyRaw(tv, cmd) {
  if (tv.type === "vega") return vegaKey(tv, cmd);
  if (tv.type === "roku") {
    const k = ROKU_KEYS[cmd];
    if (!k) throw new Error(`Unknown command ${cmd}`);
    return rokuReq(tv, "POST", `/keypress/${k}`);
  }
  const k = ADB_KEYS[cmd];
  if (!k) throw new Error(`Unknown command ${cmd}`);
  return adbShell(tv, "input", "keyevent", k);
}

async function sendText(tv, text) {
  if (tv.type === "vega") {
    if (!tv.vegaToken) throw new Error(`Pair ${tv.name} first.`);
    return vegaReq(tv, "POST", "/v1/FireTV/text", { text });
  }
  if (tv.type === "roku") {
    for (const ch of text) await rokuReq(tv, "POST", `/keypress/Lit_${encodeURIComponent(ch)}`);
    return;
  }
  const escaped = text.replace(/[^A-Za-z0-9 ]/g, (c) => "\\" + c).replace(/ /g, "%s");
  return adbShell(tv, "input", "text", escaped);
}

const appCache = new Map(); // tvId -> { at, ids:Set }
async function installedIds(tv) {
  const hit = appCache.get(tv.id);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.ids;
  let ids;
  if (tv.type === "roku") {
    const xml = await rokuReq(tv, "GET", "/query/apps");
    const all = [...xml.matchAll(/<app id="(\d+)"[^>]*>([^<]*)<\/app>/g)];
    ids = new Set(all.map((m) => m[1]));
    appCache.set(tv.id, { at: Date.now(), ids, names: new Map(all.map((m) => [m[1], m[2].replace(/&amp;/g, "&").trim()])) });
    return ids;
  } else {
    const out = await adbShell(tv, "pm", "list", "packages");
    ids = new Set(out.split("\n").map((l) => l.replace("package:", "").trim()).filter(Boolean));
  }
  appCache.set(tv.id, { at: Date.now(), ids });
  return ids;
}

async function availableApps(tv) {
  if (tv.type === "vega") return APPS.filter((a) => a.fire || /netflix|disney|max|peacock|paramount|espn|spotify|plex|pluto|youtubetv|mlb/.test(a.key)).map((a) => a.key);
  const ids = await installedIds(tv);
  return APPS.filter((a) => (tv.type === "roku" ? rokuIdsFor(a, tv.id) : pkgsFor(tv, a)).some((id) => ids.has(id))).map((a) => a.key);
}

async function launchApp(tv, key) {
  const entry = APPS.find((a) => a.key === key);
  if (!entry) throw new Error("Unknown app");
  if (tv.type === "vega") {
    if (!tv.vegaToken) throw new Error(`Pair ${tv.name} first.`);
    let err;
    for (const id of [...(entry.fire || []), ...entry.android]) {
      try { return await vegaReq(tv, "POST", `/v1/FireTV/app/${id}`, {}); } catch (e) { err = e; }
    }
    throw new Error(`Couldn't open ${entry.name} on ${tv.name}${err ? ": " + err.message : ""}`);
  }
  const ids = await installedIds(tv).catch(() => new Set());
  const list = tv.type === "roku" ? rokuIdsFor(entry, tv.id) : pkgsFor(tv, entry);
  const id = list.find((x) => ids.has(x)) || list[0];
  if (!id) throw new Error(`${entry.name} isn't installed on ${tv.name}`);
  if (!ids.has(id) && ids.size) throw new Error(`${entry.name} isn't installed on ${tv.name}`);
  if (tv.type === "roku") return rokuReq(tv, "POST", `/launch/${id}`);
  const out = await adbShell(tv, "monkey", "-p", id, "-c", "android.intent.category.LEANBACK_LAUNCHER", "1");
  if (/No activities found/i.test(out)) return adbShell(tv, "monkey", "-p", id, "1");
  return out;
}

async function status(tv) {
  try {
    if (tv.type === "vega") {
      const ok = await new Promise((resolve) => {
        const sock = require("net").connect({ host: tv.ip, port: 8009, timeout: 2000 }, () => { sock.destroy(); resolve(true); });
        sock.on("error", () => resolve(false)); sock.on("timeout", () => { sock.destroy(); resolve(false); });
      });
      if (!ok) return { online: false, error: `Can't reach ${tv.ip}` };
      learnMac(tv);
      return tv.vegaToken ? { online: true, awake: true } : { online: false, error: "Not paired yet" };
    }
    if (tv.type === "roku") {
      const xml = await rokuReq(tv, "GET", "/query/device-info", 2500);
      learnMac(tv);
      const mode = xmlTag(xml, "power-mode") || "";
      return { online: true, awake: mode ? mode === "PowerOn" : true, model: xmlTag(xml, "model-name") };
    }
    const out = await adbShell(tv, "dumpsys", "power");
    learnMac(tv);
    const w = (out.match(/mWakefulness=(\w+)/) || [])[1];
    return { online: true, awake: w ? w === "Awake" : true };
  } catch (e) {
    return { online: false, error: e.message };
  }
}

// run an action across many TVs, report per-TV result
async function fanOut(ids, fn) {
  const targets = ids.map(findTv).filter(Boolean);
  const results = await Promise.allSettled(targets.map(fn));
  return results.map((r, i) => ({
    id: targets[i].id, name: targets[i].name,
    ok: r.status === "fulfilled", error: r.status === "rejected" ? r.reason.message : undefined,
  }));
}

// ---------- Roku network scan (SSDP) ----------
function scanRokus(ms = 3000) {
  return new Promise((resolve) => {
    const found = new Map();
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const msg = Buffer.from('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nST: roku:ecp\r\nMX: 2\r\n\r\n');
    sock.on("message", (buf) => {
      const loc = (buf.toString().match(/LOCATION:\s*http:\/\/([\d.]+):8060/i) || [])[1];
      if (loc) found.set(loc, true);
    });
    sock.on("error", () => { try { sock.close(); } catch {} resolve([]); });
    sock.bind(() => {
      sock.send(msg, 1900, "239.255.255.250");
      setTimeout(() => sock.send(msg, 1900, "239.255.255.250"), 600);
    });
    setTimeout(async () => {
      try { sock.close(); } catch {}
      const out = await Promise.all([...found.keys()].map(async (ip) => {
        try {
          const xml = await rokuReq({ ip }, "GET", "/query/device-info", 2000);
          return { ip, name: xmlTag(xml, "user-device-name") || xmlTag(xml, "friendly-device-name") || xmlTag(xml, "model-name") || "Roku" };
        } catch { return { ip, name: "Roku" }; }
      }));
      resolve(out);
    }, ms);
  });
}

// ---------- routes ----------
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => res.status(500).json({ error: e.message }));

const publicTv = ({ vegaToken, ...t }) => ({ ...t, paired: t.type === "vega" ? !!vegaToken : undefined });
app.get("/api/tvs", (req, res) => res.json(tvs.map(publicTv)));

app.post("/api/tvs", (req, res) => {
  const { name, ip, type, adbPort, mac, harmonyDevice } = req.body || {};
  if (!name || !ip || !TYPES.includes(type)) return res.status(400).json({ error: "Name, IP address and type are required." });
  const tv = { id: Date.now().toString(36), name: name.trim(), ip: ip.trim(), type };
  if (harmonyDevice) tv.harmonyDevice = String(harmonyDevice);
  if (normMac(mac)) tv.mac = normMac(mac);
  if (type === "googletv" || type === "firetv") tv.adbPort = Number(adbPort) || 5555;
  tvs.push(tv); saveTvs(tvs); res.json(tv);
});

app.put("/api/tvs/:id", (req, res) => {
  const tv = findTv(req.params.id);
  if (!tv) return res.status(404).json({ error: "TV not found" });
  const { name, ip, type, adbPort, mac, harmonyDevice } = req.body || {};
  if (harmonyDevice !== undefined) { if (harmonyDevice) tv.harmonyDevice = String(harmonyDevice); else delete tv.harmonyDevice; }
  if (name) tv.name = name.trim();
  if (ip && ip.trim() !== tv.ip) { tv.ip = ip.trim(); delete tv.mac; }
  if (mac !== undefined) { if (normMac(mac)) tv.mac = normMac(mac); else if (!String(mac).trim()) delete tv.mac; }
  if (type && TYPES.includes(type)) tv.type = type;
  if (tv.type === "googletv" || tv.type === "firetv") tv.adbPort = Number(adbPort) || tv.adbPort || 5555; else delete tv.adbPort;
  if (tv.type !== "vega") { delete tv.vegaToken; delete tv.vegaScheme; }
  appCache.delete(tv.id); saveTvs(tvs); res.json(tv);
});

app.delete("/api/tvs/:id", (req, res) => {
  tvs = tvs.filter((t) => t.id !== req.params.id); saveTvs(tvs); res.json({ ok: true });
});

app.post("/api/tvs/order", (req, res) => {
  const order = req.body.ids || [];
  tvs.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)); saveTvs(tvs); res.json(tvs);
});

app.get("/api/status", wrap(async (req, res) => {
  const out = await Promise.all(tvs.map(async (tv) => ({ id: tv.id, ...(await status(tv)) })));
  res.json(out);
}));

app.post("/api/key", wrap(async (req, res) => res.json(await fanOut(req.body.ids || [], (tv) => sendKey(tv, req.body.cmd)))));
app.post("/api/text", wrap(async (req, res) => res.json(await fanOut(req.body.ids || [], (tv) => sendText(tv, String(req.body.text || ""))))));
app.post("/api/launch", wrap(async (req, res) => res.json(await fanOut(req.body.ids || [], (tv) => launchApp(tv, req.body.app)))));

app.get("/api/apps", wrap(async (req, res) => {
  const ids = String(req.query.ids || "").split(",").filter(Boolean);
  const per = await Promise.all(ids.map(findTv).filter(Boolean).map(async (tv) => ({ id: tv.id, apps: await availableApps(tv).catch(() => null) })));
  res.json({ catalog: APPS.map(({ key, name }) => ({ key, name })), per });
}));


// ---------- installing apps on the TVs ----------
async function installApp(tv, key) {
  const e = APPS.find((a) => a.key === key);
  if (!e) throw new Error("Unknown app");
  appCache.delete(tv.id);
  const have = await availableApps(tv).catch(() => null);
  if (have && have.includes(key) && tv.type !== "vega") return `${e.name} is already installed`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  if (tv.type === "roku") {
    const id = e.roku[0];
    if (id) { await rokuReq(tv, "POST", `/install/${id}`); await sleep(4500); await rokuReq(tv, "POST", "/keypress/Select").catch(() => {}); return "Opened the Roku Channel Store and pressed Add. Check the TV screen."; }
    throw Object.assign(new Error(`Add ${e.name} from the Roku website: it installs on every Roku on your account at once.`), { link: e.rokuStore });
  }
  if (tv.type === "vega") throw Object.assign(new Error(`Send ${e.name} to this Fire Stick from Amazon's website ("Deliver to" → pick the stick).`), { link: e.asin ? `https://www.amazon.com/dp/${e.asin}` : "" });
  const pkg = e.android[0];
  if (tv.type === "firetv") {
    if (!e.asin) throw new Error(`No Amazon Appstore listing saved for ${e.name}.`);
    await adbShell(tv, "am", "start", "-a", "android.intent.action.VIEW", "-d", `amzn://apps/android?asin=${e.asin}`);
  } else {
    await adbShell(tv, "am", "start", "-a", "android.intent.action.VIEW", "-d", `market://details?id=${pkg}`);
  }
  await sleep(6000);
  await adbShell(tv, "input", "keyevent", "KEYCODE_DPAD_CENTER").catch(() => {});
  return tv.type === "firetv" ? "Opened the Appstore page and pressed Get/Download. Check the TV screen." : "Opened Google Play and pressed Install. Check the TV screen.";
}
app.post("/api/install", wrap(async (req, res) => {
  const { app: key, ids } = req.body || {};
  const results = await Promise.all((ids || []).map(findTv).filter(Boolean).map(async (tv) => {
    try { return { id: tv.id, name: tv.name, ok: true, msg: await installApp(tv, key) }; }
    catch (e) { return { id: tv.id, name: tv.name, ok: false, error: e.message, link: e.link || "" }; }
  }));
  res.json({ results });
}));
app.get("/api/apps/status", wrap(async (req, res) => {
  const key = String(req.query.app || "");
  const out = await Promise.all(tvs.map(async (tv) => {
    if (tv.type === "vega") return { id: tv.id, name: tv.name, type: tv.type, installed: null };
    appCache.delete(tv.id);
    const have = await availableApps(tv).catch(() => null);
    return { id: tv.id, name: tv.name, type: tv.type, installed: have ? have.includes(key) : null };
  }));
  res.json({ tvs: out });
}));

// ---------- search any app across the TVs, then install it where it's missing ----------
const squash = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9]/g, "");
function pkgLabel(pkg, qn) {
  const known = pkgToApp(pkg); if (known) return known;
  const segs = String(pkg).split(".").filter((w) => !/^(com|tv|android|amazon|google|app|apps|firetv|mobile|ott|prod|release)$/i.test(w));
  const pick = segs.find((w) => squash(w).includes(qn)) || segs[segs.length - 1] || pkg;
  return pick.charAt(0).toUpperCase() + pick.slice(1);
}
app.get("/api/appsearch", wrap(async (req, res) => {
  const q = String(req.query.q || "").trim(); const qn = squash(q);
  if (qn.length < 2) return res.json({ q, results: [] });
  const inv = await Promise.all(tvs.map(async (tv) => {
    if (tv.type === "vega") return { tv, ok: false };
    try { const ids = await installedIds(tv); return { tv, ok: true, ids, names: (appCache.get(tv.id) || {}).names || new Map() }; }
    catch { return { tv, ok: false }; }
  }));
  const cands = [];
  const add = (c) => {
    const key = squash(c.name);
    let hit = cands.find((x) => squash(x.name) === key || (c.rokuId && x.rokuId === c.rokuId) || (c.pkg && x.pkg === c.pkg));
    if (!hit) { hit = { name: c.name, rokuId: "", pkg: "", asin: "", rokuStore: "" }; cands.push(hit); }
    for (const k of ["rokuId", "pkg", "asin", "rokuStore"]) if (c[k] && !hit[k]) hit[k] = c[k];
  };
  for (const a of APPS) if (squash(a.name).includes(qn) || qn.includes(squash(a.name))) add({ name: a.name, rokuId: a.roku[0] || "", pkg: a.android[0], asin: a.asin, rokuStore: a.rokuStore });
  for (const x of inv) if (x.ok && x.tv.type === "roku") for (const [id, n] of x.names) if (squash(n).includes(qn)) add({ name: n, rokuId: id });
  const pkgs = new Set();
  for (const x of inv) if (x.ok && x.tv.type !== "roku") for (const p of x.ids) if (squash(p).includes(qn) && !/^com\.(android|google\.android\.(gms|gsf|tv\.remote|katniss))/.test(p)) pkgs.add(p);
  for (const p of pkgs) {
    // attach to a same-named Roku result when there's an obvious match, otherwise list it by itself
    const label = pkgLabel(p, qn);
    const lone = cands.filter((c) => c.rokuId && !c.pkg);
    const match = cands.find((c) => !c.pkg && (squash(c.name).includes(squash(label)) || squash(label).includes(squash(c.name)))) || (lone.length === 1 && pkgs.size === 1 ? lone[0] : null);
    if (match) match.pkg = p; else add({ name: label, pkg: p });
  }
  const results = cands.slice(0, 12).map((c) => ({ ...c, tvs: inv.map((x) => ({ id: x.tv.id, name: x.tv.name, type: x.tv.type,
    installed: !x.ok ? null : x.tv.type === "roku" ? (c.rokuId ? x.ids.has(c.rokuId) : false) : (c.pkg ? x.ids.has(c.pkg) : false) })) }));
  res.json({ q, results });
}));
async function installFound(tv, c, q) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  appCache.delete(tv.id);
  const name = c.name || q;
  if (tv.type === "roku") {
    if (c.rokuId) { await rokuReq(tv, "POST", `/install/${c.rokuId}`); await sleep(4500); await rokuReq(tv, "POST", "/keypress/Select").catch(() => {}); return `Opened ${name} in the Roku Channel Store and pressed Add. Check the TV.`; }
    await rokuReq(tv, "POST", `/search/browse?keyword=${encodeURIComponent(q || name)}&type=channel`).catch(() => {});
    throw Object.assign(new Error(`Showing Roku search results for "${q || name}" on the TV; pick it with the remote. Or add it from Roku's website (adds to every Roku).`), { link: c.rokuStore || `https://channelstore.roku.com/search/${encodeURIComponent(q || name)}` });
  }
  if (tv.type === "vega") throw Object.assign(new Error(`Send ${name} to this Fire Stick from Amazon's website ("Deliver to").`), { link: c.asin ? `https://www.amazon.com/dp/${c.asin}` : `https://www.amazon.com/s?k=${encodeURIComponent(q || name)}&i=mobile-apps` });
  const uri = tv.type === "firetv"
    ? (c.asin ? `amzn://apps/android?asin=${c.asin}` : c.pkg ? `amzn://apps/android?p=${c.pkg}` : `amzn://apps/android?s=${encodeURIComponent(q || name)}`)
    : (c.pkg ? `market://details?id=${c.pkg}` : `market://search?q=${encodeURIComponent(q || name)}&c=apps`);
  await adbShell(tv, "am", "start", "-a", "android.intent.action.VIEW", "-d", `'${uri}'`);
  if (!c.pkg && !c.asin) return `Opened the ${tv.type === "firetv" ? "Appstore" : "Google Play"} search for "${q || name}" on the TV; pick it with the remote.`;
  await sleep(6000);
  await adbShell(tv, "input", "keyevent", "KEYCODE_DPAD_CENTER").catch(() => {});
  return `Opened ${name} in ${tv.type === "firetv" ? "the Appstore" : "Google Play"} and pressed ${tv.type === "firetv" ? "Get" : "Install"}. Check the TV.`;
}
app.post("/api/appinstall", wrap(async (req, res) => {
  const { app: c = {}, ids = [], q = "" } = req.body || {};
  const results = await Promise.all(ids.map(findTv).filter(Boolean).map(async (tv) => {
    try { return { id: tv.id, name: tv.name, ok: true, msg: await installFound(tv, c, q) }; }
    catch (e) { return { id: tv.id, name: tv.name, ok: false, error: e.message, link: e.link || "" }; }
  }));
  res.json({ results });
}));

// Vega pairing: step 1 shows a PIN on the TV, step 2 sends it back and stores the token

// ---------- what's on each TV: screenshots (Fire TV / Google TV over ADB) and "now playing" (all) ----------
const shotCache = new Map(); // tvId -> { at, buf, pending }
function adbScreencap(tv) {
  return new Promise((resolve, reject) => {
    execFile(ADB, ["-s", serial(tv), "exec-out", "screencap", "-p"], { timeout: 12000, encoding: "buffer", maxBuffer: 40 * 1024 * 1024, windowsHide: true }, (err, out, stderr) => {
      if (err) return reject(new Error(err.code === "ENOENT" ? "ADB isn't installed." : (String(stderr || "") || err.message).trim()));
      const i = out.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47])); // skip any junk before the PNG header
      if (i < 0) return reject(new Error("The TV didn't send a picture."));
      resolve(i ? out.subarray(i) : out);
    });
  });
}
app.get("/api/tvs/:id/screen", wrap(async (req, res) => {
  const tv = findTv(req.params.id);
  if (!tv) return res.status(404).json({ error: "TV not found" });
  if (tv.type !== "firetv" && tv.type !== "googletv") return res.status(415).json({ error: tv.type === "roku" ? "Rokus don't allow screen pictures." : "This Fire Stick doesn't allow screen pictures." });
  let c = shotCache.get(tv.id);
  if (c && c.buf && Date.now() - c.at < 3500) return res.type("png").set("Cache-Control", "no-store").send(c.buf);
  if (!c || !c.pending) {
    c = c || {}; shotCache.set(tv.id, c);
    c.pending = (async () => { await adbEnsure(tv); return adbScreencap(tv); })()
      .then((buf) => { c.buf = buf; c.at = Date.now(); return buf; })
      .finally(() => { c.pending = null; });
  }
  const buf = await c.pending;
  res.type("png").set("Cache-Control", "no-store").send(buf);
}));
const pkgToApp = (pkg) => { for (const a of APPS) if ([...(a.android || []), ...(a.fire || [])].includes(pkg)) return a.name; return null; };
const prettyPkg = (pkg) => { const known = { "com.amazon.tv.launcher": "Home screen", "com.amazon.firebat": "Home screen", "com.google.android.tvlauncher": "Home screen", "com.google.android.apps.tv.launcherx": "Home screen", "com.amazon.tv.settings.v2": "Settings", "com.android.tv.settings": "Settings", "com.amazon.avod": "Prime Video", "com.amazon.firetv.youtube": "YouTube" }; if (known[pkg]) return known[pkg]; const last = String(pkg || "").split(".").filter((w) => !/^(com|tv|android|amazon|google|app|apps|firetv)$/.test(w)).pop() || pkg; return last ? last.charAt(0).toUpperCase() + last.slice(1) : ""; };
app.get("/api/tvs/:id/now", wrap(async (req, res) => {
  const tv = findTv(req.params.id);
  if (!tv) return res.status(404).json({ error: "TV not found" });
  const out = { id: tv.id, name: tv.name, type: tv.type, canShot: tv.type === "firetv" || tv.type === "googletv" };
  try {
    if (tv.type === "roku") {
      const [aa, dev] = await Promise.all([rokuReq(tv, "GET", "/query/active-app", 2500), rokuReq(tv, "GET", "/query/device-info", 2500).catch(() => "")]);
      const m = aa.match(/<app id="([^"]*)"[^>]*>([^<]*)<\/app>/);
      const pm = xmlTag(dev, "power-mode") || "";
      out.on = !/DisplayOff|Ready|Standby/i.test(pm);
      if (m) { out.app = xmlUnescape(m[2]); out.appId = m[1]; out.icon = `/api/tvs/${tv.id}/icon?app=${encodeURIComponent(m[1])}`; }
      if (!m || /^Roku$/i.test(out.app || "")) { out.app = "Home screen"; out.icon = null; }
      try {
        const mp = await rokuReq(tv, "GET", "/query/media-player", 2500);
        out.state = (mp.match(/<player[^>]*state="([^"]+)"/) || [])[1] || "";
        out.position = Math.round(parseInt(xmlTag(mp, "position") || "0", 10) / 1000) || 0;
        out.duration = Math.round(parseInt(xmlTag(mp, "duration") || "0", 10) / 1000) || 0;
      } catch {}
    } else if (tv.type === "firetv" || tv.type === "googletv") {
      const w = await adbShell(tv, "dumpsys window | grep -E 'mCurrentFocus|mFocusedApp' | head -2").catch(() => "");
      const pkg = (w.match(/ ([a-zA-Z0-9_.]+)\/[a-zA-Z0-9_.$]+/) || [])[1] || "";
      out.pkg = pkg; out.app = pkgToApp(pkg) || prettyPkg(pkg) || "";
      const pw = await adbShell(tv, "dumpsys power | grep -m1 mWakefulness=").catch(() => "");
      out.on = !/Asleep|Dozing/i.test(pw);
    } else if (tv.type === "vega") {
      out.on = null; out.note = "This Fire Stick doesn't share what's playing.";
    }
    out.online = true;
  } catch (e) { out.online = false; out.error = e.message; }
  res.json(out);
}));
app.get("/api/tvs/:id/icon", async (req, res) => {
  const tv = findTv(req.params.id);
  if (!tv || tv.type !== "roku") return res.status(404).end();
  try {
    const r = await fetch(`http://${tv.ip}:8060/query/icon/${encodeURIComponent(String(req.query.app || ""))}`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return res.status(404).end();
    res.type(r.headers.get("content-type") || "image/png").set("Cache-Control", "max-age=86400").send(Buffer.from(await r.arrayBuffer()));
  } catch { res.status(502).end(); }
});
// optional room camera (an old phone running an IP-camera app, or any camera with a snapshot/MJPEG address)
const VIEW_FILE = path.join(__dirname, "view.json");
let viewCfg = (() => { try { return JSON.parse(fs.readFileSync(VIEW_FILE, "utf8")); } catch { return {}; } })();
app.get("/api/view", (req, res) => res.json({ camera: viewCfg.camera || "" }));
app.post("/api/view", (req, res) => {
  const cam = String((req.body || {}).camera || "").trim();
  if (cam && !/^https?:\/\/(10|127|172\.(1[6-9]|2\d|3[01])|192\.168)\.[\d.]+(:\d+)?\//.test(cam)) return res.status(400).json({ error: "Use the camera's address on your home network, like http://192.168.1.50:8080/video" });
  viewCfg.camera = cam; fs.writeFileSync(VIEW_FILE, JSON.stringify(viewCfg, null, 2)); res.json({ ok: true });
});
app.get("/api/camera", (req, res) => {
  if (!viewCfg.camera) return res.status(404).end();
  const lib = viewCfg.camera.startsWith("https") ? https : http;
  const r = lib.get(viewCfg.camera, { timeout: 8000, rejectUnauthorized: false }, (cr) => {
    res.status(cr.statusCode || 502); if (cr.headers["content-type"]) res.set("Content-Type", cr.headers["content-type"]); res.set("Cache-Control", "no-store");
    cr.pipe(res); req.on("close", () => cr.destroy());
  });
  r.on("error", () => { if (!res.headersSent) res.status(502).end(); }); r.on("timeout", () => r.destroy());
});

app.post("/api/tvs/:id/vega/pin", wrap(async (req, res) => {
  const tv = findTv(req.params.id);
  if (!tv || tv.type !== "vega") return res.status(400).json({ error: "Pairing is only for Fire TV (Vega)" });
  // keep the current pairing until the new PIN is confirmed, so cancelling doesn't un-pair the TV
  await vegaWake(tv);
  await new Promise((r) => setTimeout(r, 800));
  await vegaReq(tv, "POST", "/v1/FireTV/pin/display", { friendlyName: "TV Remote Hub" }, true);
  res.json({ ok: true });
}));
app.post("/api/tvs/:id/vega/verify", wrap(async (req, res) => {
  const tv = findTv(req.params.id);
  const pin = String((req.body || {}).pin || "").trim();
  if (!tv || tv.type !== "vega" || !pin) return res.status(400).json({ error: "Enter the PIN shown on the TV." });
  const body = await vegaReq(tv, "POST", "/v1/FireTV/pin/verify", { pin }, true);
  let token; try { token = JSON.parse(body).description; } catch {}
  if (!token) throw new Error("The TV didn't accept that PIN. Tap Pair to get a new one.");
  tv.vegaToken = token; tv.vegaPairedAt = new Date().toISOString(); delete tv.vegaAuthFails; saveTvs(tvs);
  res.json({ ok: true });
}));


// ---------- Sonos music + Spotify routes ----------
app.get("/api/sonos/favorites", wrap(async (req, res) => { const ip = await sonosAnyIp(); const r = await sonosBrowse(ip, "FV:2"); r.items.forEach((it) => { if (/spotify/i.test(it.uri)) learnSpotifyAccount(it.uri, it.meta); }); res.json(r); }));
app.get("/api/sonos/playlists", wrap(async (req, res) => { const ip = await sonosAnyIp(); res.json(await sonosBrowse(ip, "SQ:")); }));
app.get("/api/sonos/queue", wrap(async (req, res) => { const g = await coordFor(req.query.group); const r = await sonosBrowse(g.coordinator.ip, "Q:0", 0, 200); res.json({ ...r, current: g.isQueue ? g.track : 0 }); }));
app.post("/api/sonos/play-item", wrap(async (req, res) => {
  const { group, source, index, mode } = req.body || {};
  const g = await coordFor(group);
  const list = await sonosBrowse(await sonosAnyIp(), source === "playlists" ? "SQ:" : "FV:2");
  const it = list.items[Number(index)];
  if (!it) return res.status(404).json({ error: "That item wasn't found. Refresh the list." });
  await playItem(g, it, mode || "now");
  res.json({ ok: true, did: `${mode === "add" ? "Added" : mode === "next" ? "Playing next:" : "Playing"} ${it.title}` });
}));
app.post("/api/sonos/queue/jump", wrap(async (req, res) => { const g = await coordFor((req.body || {}).group); await playQueueFrom(g, Number(req.body.track)); res.json({ ok: true }); }));
app.post("/api/sonos/queue/clear", wrap(async (req, res) => { const g = await coordFor((req.body || {}).group); await sonosSoap(g.coordinator.ip, "AVTransport", "RemoveAllTracksFromQueue", { InstanceID: 0 }); res.json({ ok: true }); }));
app.post("/api/sonos/queue/remove", wrap(async (req, res) => {
  const g = await coordFor((req.body || {}).group);
  await sonosSoap(g.coordinator.ip, "AVTransport", "RemoveTrackFromQueue", { InstanceID: 0, ObjectID: `Q:0/${Number(req.body.track)}`, UpdateID: 0 });
  res.json({ ok: true });
}));
app.post("/api/sonos/seek", wrap(async (req, res) => { const g = await coordFor((req.body || {}).group); await sonosSoap(g.coordinator.ip, "AVTransport", "Seek", { InstanceID: 0, Unit: "REL_TIME", Target: secToHms(req.body.seconds) }); res.json({ ok: true }); }));
app.post("/api/sonos/playmode", wrap(async (req, res) => {
  const { group, shuffle, repeat } = req.body || {}; // repeat: "off" | "all" | "one"
  const modes = { "0off": "NORMAL", "0all": "REPEAT_ALL", "0one": "REPEAT_ONE", "1off": "SHUFFLE_NOREPEAT", "1all": "SHUFFLE", "1one": "SHUFFLE_REPEAT_ONE" };
  const g = await coordFor(group);
  await sonosSoap(g.coordinator.ip, "AVTransport", "SetPlayMode", { InstanceID: 0, NewPlayMode: modes[(shuffle ? 1 : 0) + (repeat || "off")] });
  res.json({ ok: true });
}));
app.post("/api/sonos/spotify", wrap(async (req, res) => {
  const { group, link, mode, title } = req.body || {};
  const g = await coordFor(group);
  await playSpotifyOnSonos(g, link, mode || "now", title || "");
  res.json({ ok: true, did: `${mode === "add" ? "Added to queue" : mode === "next" ? "Playing next" : "Playing"} on ${g.name}` });
}));

app.get("/api/spotify", (req, res) => res.json({ clientId: spotify.clientId || "", connected: !!spotify.refreshToken, user: spotify.user || "", redirect: spotifyRedirect() }));
app.post("/api/spotify/setup", (req, res) => {
  const id = String((req.body || {}).clientId || "").trim();
  if (!/^[0-9a-f]{32}$/i.test(id)) return res.status(400).json({ error: "That Client ID doesn't look right. It's 32 letters and numbers from your Spotify app's page." });
  spotify = { clientId: id }; saveSpotify(); res.json({ ok: true });
});
app.get("/api/spotify/login", (req, res) => {
  if (!spotify.clientId) return res.status(400).send("Add your Spotify Client ID in TV Remote Hub first.");
  const verifier = crypto.randomBytes(48).toString("base64url");
  const state = crypto.randomBytes(12).toString("hex");
  pkce = { verifier, state };
  const q = new URLSearchParams({ client_id: spotify.clientId, response_type: "code", redirect_uri: spotifyRedirect(), scope: SPOTIFY_SCOPES, state,
    code_challenge_method: "S256", code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url") });
  res.redirect("https://accounts.spotify.com/authorize?" + q);
});
app.get("/api/spotify/callback", async (req, res) => {
  const page = (msg) => res.send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font:18px system-ui;background:#232833;color:#e9ebf1;padding:40px;text-align:center"><p>${msg}</p><p><a style="color:#8fb4ff" href="/">Back to TV Remote</a></p></body>`);
  try {
    if (req.query.error) return page(`Spotify said: ${String(req.query.error).replace(/[<>&]/g, "")}`);
    if (!pkce || req.query.state !== pkce.state) return page("That login link expired. Go back and tap Log in with Spotify again.");
    const j = await formPost("accounts.spotify.com", "/api/token", { grant_type: "authorization_code", code: String(req.query.code), redirect_uri: spotifyRedirect(), client_id: spotify.clientId, code_verifier: pkce.verifier });
    pkce = null;
    Object.assign(spotify, { accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt: Date.now() + (j.expires_in || 3600) * 1000 });
    saveSpotify();
    try { const me = await spotifyApi("GET", "/me"); spotify.user = me.display_name || me.id; saveSpotify(); } catch {}
    page("Spotify is connected. You can close this tab.");
  } catch (e) { page("Couldn't finish connecting: " + String(e.message).replace(/[<>&]/g, "")); }
});
app.post("/api/spotify/logout", (req, res) => { spotify = { clientId: spotify.clientId }; saveSpotify(); res.json({ ok: true }); });
app.get("/api/spotify/search", wrap(async (req, res) => {
  const q = String(req.query.q || "").trim(); if (!q) return res.json({ tracks: [], albums: [], playlists: [] });
  const j = await spotifyApi("GET", `/search?${new URLSearchParams({ q, type: "track,album,playlist", limit: "10" })}`);
  res.json({ tracks: (j.tracks?.items || []).filter(Boolean).map((x) => slimSpotify(x, "track")),
    albums: (j.albums?.items || []).filter(Boolean).map((x) => slimSpotify(x, "album")),
    playlists: (j.playlists?.items || []).filter(Boolean).map((x) => slimSpotify(x, "playlist")) });
}));
app.get("/api/spotify/playlists", wrap(async (req, res) => {
  const j = await spotifyApi("GET", "/me/playlists?limit=50");
  res.json({ playlists: (j.items || []).filter(Boolean).map((x) => slimSpotify(x, "playlist")) });
}));
app.get("/api/spotify/recent", wrap(async (req, res) => {
  const j = await spotifyApi("GET", "/me/player/recently-played?limit=20");
  const seen = new Set(); const out = [];
  for (const it of j.items || []) { if (it.track && !seen.has(it.track.uri)) { seen.add(it.track.uri); out.push(slimSpotify(it.track, "track")); } }
  res.json({ tracks: out });
}));
app.get("/api/spotify/player", wrap(async (req, res) => {
  const [p, d] = await Promise.all([spotifyApi("GET", "/me/player").catch(() => null), spotifyApi("GET", "/me/player/devices").catch(() => ({ devices: [] }))]);
  const it = p && p.item;
  res.json({ playing: !!(p && p.is_playing), device: p && p.device ? { id: p.device.id, name: p.device.name, type: p.device.type, volume: p.device.volume_percent } : null,
    shuffle: !!(p && p.shuffle_state), repeat: (p && p.repeat_state) || "off",
    track: it ? { name: it.name, sub: (it.artists || []).map((a) => a.name).join(", ") || (it.show && it.show.name) || "", art: pickImg((it.album && it.album.images) || it.images), duration: Math.round((it.duration_ms || 0) / 1000) } : null,
    position: p ? Math.round((p.progress_ms || 0) / 1000) : 0,
    devices: (d.devices || []).map((x) => ({ id: x.id, name: x.name, type: x.type, active: x.is_active, volume: x.volume_percent })) });
}));
app.post("/api/spotify/control", wrap(async (req, res) => {
  const { action, device, volume, uri, seconds } = req.body || {};
  const dq = device ? `?device_id=${encodeURIComponent(device)}` : "";
  switch (action) {
    case "play": await spotifyApi("PUT", "/me/player/play" + dq, uri ? (/:track:/.test(uri) ? { uris: [uri] } : { context_uri: uri }) : undefined); break;
    case "pause": await spotifyApi("PUT", "/me/player/pause"); break;
    case "next": await spotifyApi("POST", "/me/player/next"); break;
    case "previous": await spotifyApi("POST", "/me/player/previous"); break;
    case "volume": await spotifyApi("PUT", `/me/player/volume?volume_percent=${clamp(volume)}`); break;
    case "seek": await spotifyApi("PUT", `/me/player/seek?position_ms=${Math.max(0, Math.round(seconds * 1000))}`); break;
    case "shuffle": await spotifyApi("PUT", `/me/player/shuffle?state=${!!req.body.state}`); break;
    case "repeat": await spotifyApi("PUT", `/me/player/repeat?state=${["off", "context", "track"].includes(req.body.state) ? req.body.state : "off"}`); break;
    case "transfer": await spotifyApi("PUT", "/me/player", { device_ids: [device], play: true }); break;
    default: return res.status(400).json({ error: "Unknown Spotify action" });
  }
  res.json({ ok: true });
}));

// ---------- Sonos + lights routes ----------
app.get("/api/sonos", wrap(async (req, res) => res.json({ groups: await sonosState() })));
app.post("/api/sonos/volume", wrap(async (req, res) => {
  const { uuid, group, volume } = req.body || {};
  if (group) { const { g } = await sonosFind(group); await sonosGroupVolume(g.coordinator.ip, volume); }
  else { const { m } = await sonosFind(uuid); await sonosSoap(m.ip, "RenderingControl", "SetVolume", { InstanceID: 0, Channel: "Master", DesiredVolume: clamp(volume) }); }
  res.json({ ok: true });
}));
app.post("/api/sonos/mute", wrap(async (req, res) => {
  const { uuid, group, mute } = req.body || {};
  if (group) { const { g } = await sonosFind(group); await sonosSoap(g.coordinator.ip, "GroupRenderingControl", "SetGroupMute", { InstanceID: 0, DesiredMute: mute ? 1 : 0 }); }
  else { const { m } = await sonosFind(uuid); await sonosSoap(m.ip, "RenderingControl", "SetMute", { InstanceID: 0, Channel: "Master", DesiredMute: mute ? 1 : 0 }); }
  res.json({ ok: true });
}));
app.post("/api/sonos/transport", wrap(async (req, res) => {
  const { group, action } = req.body || {};
  const { g } = await sonosFind(group);
  const map = { play: ["Play", { InstanceID: 0, Speed: 1 }], pause: ["Pause", { InstanceID: 0 }], next: ["Next", { InstanceID: 0 }], previous: ["Previous", { InstanceID: 0 }] };
  let a = map[action]; if (action === "toggle") a = /PLAYING/.test(g.state) ? map.pause : map.play;
  if (!a) return res.status(400).json({ error: "Unknown action" });
  await sonosSoap(g.coordinator.ip, "AVTransport", a[0], a[1]);
  res.json({ ok: true });
}));
app.post("/api/sonos/join", wrap(async (req, res) => {
  const { uuid, to } = req.body || {};
  const { m, groups } = await sonosFind(uuid);
  const target = groups.find((g) => g.id === to || g.members.some((x) => x.uuid === to));
  if (!target) return res.status(400).json({ error: "Group not found" });
  await sonosSoap(m.ip, "AVTransport", "SetAVTransportURI", { InstanceID: 0, CurrentURI: `x-rincon:${target.coordinator.uuid}`, CurrentURIMetaData: "" });
  res.json({ ok: true });
}));
app.post("/api/sonos/input", wrap(async (req, res) => {
  const { uuid, kind } = req.body || {};
  const { src } = await sonosInput(uuid, kind === "linein" ? "linein" : "tv");
  res.json({ ok: true, did: `${src.name} switched to ${kind === "linein" ? "line-in" : "TV"}` });
}));
app.post("/api/sonos/leave", wrap(async (req, res) => {
  const { m } = await sonosFind((req.body || {}).uuid);
  await sonosSoap(m.ip, "AVTransport", "BecomeCoordinatorOfStandaloneGroup", { InstanceID: 0 });
  res.json({ ok: true });
}));
app.post("/api/sonos/all", wrap(async (req, res) => {
  const groups = await sonosState();
  const into = (req.body || {}).to ? groups.find((g) => g.id === req.body.to) : groups[0];
  if (!into) return res.status(400).json({ error: "No speakers" });
  for (const g of groups) for (const m of g.members) if (g !== into)
    await sonosSoap(m.ip, "AVTransport", "SetAVTransportURI", { InstanceID: 0, CurrentURI: `x-rincon:${into.coordinator.uuid}`, CurrentURIMetaData: "" }).catch(() => {});
  res.json({ ok: true });
}));

app.get("/api/lights", wrap(async (req, res) => {
  const out = await Promise.all(lights.map(async (l) => ({ ...l, ...(await lightStatus(l)) })));
  res.json({ lights: out });
}));
app.post("/api/lights/scan", wrap(async (req, res) => {
  const found = await lightsDiscover();
  let added = 0;
  for (const f of found) {
    const ex = lights.find((l) => (f.mac && l.mac === f.mac) || l.ip === f.ip);
    if (ex) { ex.ip = f.ip; if (f.mac) ex.mac = f.mac; continue; }
    lights.push({ id: Date.now().toString(36) + added, name: `Light ${(f.mac || f.ip).replace(/:/g, "").slice(-6).toUpperCase()}`, ip: f.ip, mac: f.mac, model: f.model });
    added++;
  }
  saveLights();
  res.json({ found: found.length, added });
}));
app.post("/api/lights", (req, res) => {
  const { name, ip } = req.body || {};
  if (!name || !ip) return res.status(400).json({ error: "Name and IP are required." });
  const l = { id: Date.now().toString(36), name: String(name).trim(), ip: String(ip).trim() };
  lights.push(l); saveLights(); res.json(l);
});
app.post("/api/lights/stream", (req, res) => {
  // body: { frames: [{ id, c: "#rrggbb" }] } or { ids: [...], c: "#rrggbb" }
  const b = req.body || {};
  if (!streamActive) return res.json({ ok: false, stopped: true });
  clearTimeout(streamStopTimer); streamStopTimer = setTimeout(() => { streamActive = false; }, 30000); // auto-off if the page vanishes
  const frames = Array.isArray(b.frames) ? b.frames : (b.ids || []).map((id) => ({ id, c: b.c }));
  for (const f of frames) { const l = findLight(f.id); const rgb = hexToRgb(f.c); if (l && rgb) streamColor(l, ...rgb); }
  res.json({ ok: true });
});
app.post("/api/lights/stream/start", wrap(async (req, res) => {
  const ids = (req.body || {}).ids || [];
  const sel = lights.filter((l) => ids.includes(l.id));
  const before = await Promise.all(sel.map(async (l) => ({ id: l.id, ...(await lightStatus(l)) })));
  await Promise.allSettled(sel.filter((l, i) => before[i].online && !before[i].on).map((l) => lightPower(l, true)));
  streamActive = true;
  sel.forEach((l) => lightSock(l));
  res.json({ before });
}));
app.post("/api/lights/stream/stop", wrap(async (req, res) => {
  const before = (req.body || {}).before || [];
  streamActive = false;
  for (const st of lightSocks.values()) { clearTimeout(st.timer); st.pending = null; }
  for (const st of lightSocks.values()) { try { st.sock.destroy(); } catch {} }
  lightSocks.clear();
  await new Promise((r) => setTimeout(r, 150));
  await Promise.allSettled(before.filter((x) => x.online).map(async (x) => {
    const l = findLight(x.id); if (!l) return;
    if (x.r || x.g || x.b) await lightColor(l, x.r, x.g, x.b);
    if (!x.on) await lightPower(l, false);
  }));
  res.json({ ok: true });
}));
app.get("/api/art", (req, res) => { // album art proxy so pictures also load on the secure (https) page
  const u = String(req.query.u || "");
  if (!/^http:\/\/(10|127|172\.(1[6-9]|2\d|3[01])|192\.168)\.[\d.]+:1400\//.test(u)) return res.status(400).end();
  http.get(u, { timeout: 5000 }, (r) => { res.status(r.statusCode || 502); if (r.headers["content-type"]) res.set("Content-Type", r.headers["content-type"]); res.set("Cache-Control", "max-age=3600"); r.pipe(res); })
    .on("error", () => res.status(502).end()).on("timeout", function () { this.destroy(); });
});
app.get("/api/secure", (req, res) => res.json({ port: HTTPS_PORT, ok: !!httpsUp }));
// body: { ids?: [...], on?, color?, brightness?, effect?: { pattern, speed } } — no ids = every light
app.post("/api/lights/all", wrap(async (req, res) => {
  const b = req.body || {};
  const sel = Array.isArray(b.ids) && b.ids.length ? lights.filter((l) => b.ids.includes(l.id)) : lights;
  const results = await Promise.allSettled(sel.map(async (l) => {
    if (b.effect) { await lightPower(l, true); return lightEffect(l, b.effect.pattern, b.effect.speed); }
    if (b.color || b.brightness != null) return setLight(l, { on: true, color: b.color, brightness: b.brightness });
    return lightPower(l, b.on !== false && !!b.on);
  }));
  res.json({ ok: true, failed: results.filter((r) => r.status === "rejected").length });
}));
app.post("/api/lights/:id", wrap(async (req, res) => {
  const l = findLight(req.params.id);
  if (!l) return res.status(404).json({ error: "Light not found" });
  const b = req.body || {};
  if (b.name !== undefined) { l.name = String(b.name).trim().slice(0, 40) || l.name; saveLights(); }
  if (b.blink) { const s = await lightStatus(l); for (let i = 0; i < 3; i++) { await lightPower(l, false); await new Promise((r) => setTimeout(r, 400)); await lightPower(l, true); await new Promise((r) => setTimeout(r, 400)); } if (s.online && !s.on) await lightPower(l, false); }
  if (b.effect) { await lightPower(l, true); await lightEffect(l, b.effect.pattern, b.effect.speed); }
  else if (b.on !== undefined || b.color || b.brightness != null) await setLight(l, b);
  res.json({ ok: true });
}));
app.delete("/api/lights/:id", (req, res) => { lights = lights.filter((l) => l.id !== req.params.id); saveLights(); res.json({ ok: true }); });

app.post("/api/tvs/:id/connect", wrap(async (req, res) => {
  const tv = findTv(req.params.id);
  if (!tv || tv.type === "roku" || tv.type === "vega") return res.status(400).json({ error: "Connect is only for Google TV and Fire TV" });
  await run(["disconnect", serial(tv)]).catch(() => {});
  await adbEnsure(tv);
  res.json({ ok: true });
}));

// Android 11+ "Wireless debugging" pairing (only needed if USB debugging over 5555 isn't available)
app.post("/api/tvs/:id/pair", wrap(async (req, res) => {
  const tv = findTv(req.params.id);
  const { pairPort, code } = req.body || {};
  if (!tv || !pairPort || !code) return res.status(400).json({ error: "Pairing port and code are required." });
  const out = await run(["pair", `${tv.ip}:${pairPort}`, String(code)], 15000);
  if (!/success/i.test(out)) throw new Error(out || "Pairing failed");
  res.json({ ok: true, message: out });
}));

app.get("/api/scan", wrap(async (req, res) => res.json(await scanRokus())));

// ---------- Sonos (local UPnP on port 1400) ----------
const SONOS_FILE = path.join(__dirname, "sonos.json");
let sonosKnown = (() => { try { return JSON.parse(fs.readFileSync(SONOS_FILE, "utf8")); } catch { return { ips: [] }; } })();
const saveSonos = () => fs.writeFileSync(SONOS_FILE, JSON.stringify(sonosKnown, null, 2));
const xmlUnescape = (s) => String(s || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const xmlEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const SONOS_SVC = {
  AVTransport: ["/MediaRenderer/AVTransport/Control", "urn:schemas-upnp-org:service:AVTransport:1"],
  RenderingControl: ["/MediaRenderer/RenderingControl/Control", "urn:schemas-upnp-org:service:RenderingControl:1"],
  GroupRenderingControl: ["/MediaRenderer/GroupRenderingControl/Control", "urn:schemas-upnp-org:service:GroupRenderingControl:1"],
  ZoneGroupTopology: ["/ZoneGroupTopology/Control", "urn:schemas-upnp-org:service:ZoneGroupTopology:1"],
  ContentDirectory: ["/MediaServer/ContentDirectory/Control", "urn:schemas-upnp-org:service:ContentDirectory:1"],
};
function sonosSoap(ip, svc, action, args = {}) {
  const [p, urn] = SONOS_SVC[svc];
  const inner = Object.entries(args).map(([k, v]) => `<${k}>${xmlEsc(v)}</${k}>`).join("");
  const body = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${urn}">${inner}</u:${action}></s:Body></s:Envelope>`;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: ip, port: 1400, path: p, method: "POST", timeout: 4000,
      headers: { "Content-Type": 'text/xml; charset="utf-8"', SOAPACTION: `"${urn}#${action}"`, "Content-Length": Buffer.byteLength(body) } }, (res) => {
      let out = ""; res.on("data", (c) => (out += c));
      res.on("end", () => (res.statusCode === 200 ? resolve(out) : reject(new Error(`Sonos ${ip} said ${res.statusCode} to ${action}`))));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => reject(new Error(`Can't reach Sonos at ${ip} (${e.message})`)));
    req.write(body); req.end();
  });
}
const tag = (x, t) => { const m = String(x).match(new RegExp(`<(?:[\\w]+:)?${t}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w]+:)?${t}>`)); return m ? m[1] : ""; };
function sonosDiscover(ms = 2500) {
  return new Promise((resolve) => {
    const found = new Set();
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const msg = Buffer.from('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: urn:schemas-upnp-org:device:ZonePlayer:1\r\n\r\n');
    sock.on("message", (buf, r) => { if (/ZonePlayer|Sonos/i.test(buf.toString())) found.add(r.address); });
    sock.on("error", () => { try { sock.close(); } catch {} resolve([...found]); });
    sock.bind(() => { sock.send(msg, 1900, "239.255.255.250"); setTimeout(() => { try { sock.send(msg, 1900, "239.255.255.250"); } catch {} }, 700); });
    setTimeout(() => { try { sock.close(); } catch {} resolve([...found]); }, ms);
  });
}
async function sonosAnyIp() {
  for (const ip of sonosKnown.ips) { try { await sonosSoap(ip, "ZoneGroupTopology", "GetZoneGroupState"); return ip; } catch {} }
  const ips = await sonosDiscover();
  if (ips.length) { sonosKnown.ips = ips; saveSonos(); return ips[0]; }
  throw new Error("No Sonos speakers found. Make sure the PC is on the same network as the speakers.");
}
async function sonosState() {
  const ip = await sonosAnyIp();
  const raw = xmlUnescape(tag(await sonosSoap(ip, "ZoneGroupTopology", "GetZoneGroupState"), "ZoneGroupState"));
  const groups = [];
  const allIps = new Set(sonosKnown.ips);
  for (const g of raw.match(/<ZoneGroup [\s\S]*?<\/ZoneGroup>/g) || []) {
    const coord = (g.match(/Coordinator="([^"]+)"/) || [])[1];
    const members = [];
    for (const m of g.match(/<ZoneGroupMember [^>]*?\/?>/g) || []) {
      const a = (k) => (m.match(new RegExp(` ${k}="([^"]*)"`)) || [])[1] || "";
      if (a("Invisible") === "1") continue; // bonded Sub / surrounds ride along with their room
      const mip = (a("Location").match(/\/\/([\d.]+):/) || [])[1];
      if (!mip) continue;
      allIps.add(mip);
      members.push({ uuid: a("UUID"), name: a("ZoneName"), ip: mip, coordinator: a("UUID") === coord });
    }
    if (!members.length) continue;
    members.sort((x, y) => (y.coordinator - x.coordinator) || x.name.localeCompare(y.name));
    groups.push({ id: coord, coordinator: members.find((m) => m.coordinator) || members[0], members });
  }
  sonosKnown.ips = [...allIps]; saveSonos();
  await Promise.all(groups.map(async (g) => {
    const cip = g.coordinator.ip;
    await Promise.all(g.members.map(async (m) => {
      try { m.volume = Number(tag(await sonosSoap(m.ip, "RenderingControl", "GetVolume", { InstanceID: 0, Channel: "Master" }), "CurrentVolume")); } catch { m.volume = null; }
      try { m.muted = tag(await sonosSoap(m.ip, "RenderingControl", "GetMute", { InstanceID: 0, Channel: "Master" }), "CurrentMute") === "1"; } catch {}
    }));
    try { g.volume = Number(tag(await sonosSoap(cip, "GroupRenderingControl", "GetGroupVolume", { InstanceID: 0 }), "CurrentVolume")); } catch { g.volume = g.members[0].volume; }
    try { g.state = tag(await sonosSoap(cip, "AVTransport", "GetTransportInfo", { InstanceID: 0 }), "CurrentTransportState"); } catch { g.state = ""; }
    try {
      const pos = await sonosSoap(cip, "AVTransport", "GetPositionInfo", { InstanceID: 0 });
      const meta = xmlUnescape(tag(pos, "TrackMetaData"));
      g.title = xmlUnescape(tag(meta, "title")); g.artist = xmlUnescape(tag(meta, "creator"));
      g.album = xmlUnescape(tag(meta, "album"));
      const stream = xmlUnescape(tag(meta, "streamContent")); if (stream && !g.artist) g.artist = stream;
      g.art = artUrl(cip, xmlUnescape(tag(meta, "albumArtURI")));
      g.track = Number(tag(pos, "Track")) || 0;
      g.position = hmsToSec(tag(pos, "RelTime")); g.duration = hmsToSec(tag(pos, "TrackDuration"));
      g.uri = xmlUnescape(tag(pos, "TrackURI"));
      if (/x-sonos-spotify|spotify%3a/i.test(g.uri)) learnSpotifyAccount(g.uri, meta);
    } catch {}
    try { g.playMode = tag(await sonosSoap(cip, "AVTransport", "GetTransportSettings", { InstanceID: 0 }), "PlayMode"); } catch {}
    try { const mi = await sonosSoap(cip, "AVTransport", "GetMediaInfo", { InstanceID: 0 }); g.source = xmlUnescape(tag(mi, "CurrentURI")); } catch {}
    g.isQueue = /^x-rincon-queue:/.test(g.source || "");
    g.isTv = /^x-sonos-htastream:/.test(g.source || "");
    if (g.isTv && !g.title) g.title = "TV audio";
    await Promise.all(g.members.map(async (m) => { const d = await sonosModel(m.ip); m.model = d.model; m.hasTv = d.tv; m.hasLineIn = d.lineIn; }));
    g.tvMember = (g.members.find((m) => m.hasTv) || {}).uuid || "";
    g.lineInMember = (g.members.find((m) => m.hasLineIn) || {}).uuid || "";
    g.isLineIn = /^x-rincon-stream:/.test(g.source || "");
    if (g.isLineIn && !g.title) g.title = "Line-in";
    g.name = g.members.map((m) => m.name).join(" + ");
  }));
  return groups;
}
async function sonosFind(uuid) {
  const groups = await sonosState();
  for (const g of groups) for (const m of g.members) if (m.uuid === uuid) return { g, m, groups };
  throw new Error("That Sonos speaker wasn't found. Tap Refresh.");
}
const clamp = (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
async function sonosGroupVolume(coordIp, vol) {
  await sonosSoap(coordIp, "GroupRenderingControl", "SnapshotGroupVolume", { InstanceID: 0 }).catch(() => {});
  return sonosSoap(coordIp, "GroupRenderingControl", "SetGroupVolume", { InstanceID: 0, DesiredVolume: clamp(vol) });
}



// which speakers have an HDMI/TV input (Beam, Arc, Ray, Playbar, Playbase, Amp) or a line-in (Five, Play:5, Port, Connect, Amp)
const sonosModels = new Map();
function sonosModel(ip) {
  if (sonosModels.has(ip)) return Promise.resolve(sonosModels.get(ip));
  return new Promise((resolve) => {
    http.get({ host: ip, port: 1400, path: "/xml/device_description.xml", timeout: 3000 }, (r) => {
      let x = ""; r.on("data", (c) => (x += c));
      r.on("end", () => {
        const model = xmlUnescape(tag(x, "modelName")) || "";
        const d = { model, tv: /HTControl/.test(x) || /beam|arc|ray|playbar|playbase|amp/i.test(model),
          lineIn: /five|play:5|port|connect|amp/i.test(model) };
        sonosModels.set(ip, d); resolve(d);
      });
    }).on("error", () => resolve({ model: "", tv: false, lineIn: false })).on("timeout", function () { this.destroy(); });
  });
}
// Switch a group to the soundbar's TV (HDMI) input or a speaker's line-in, keeping everyone else in the group listening
async function sonosInput(uuid, kind) {
  const groups = await sonosState();
  const g = groups.find((x) => x.members.some((m) => m.uuid === uuid));
  if (!g) throw new Error("Speaker not found. Tap Refresh.");
  const src = g.members.find((m) => m.uuid === uuid);
  const others = g.members.filter((m) => m.uuid !== uuid);
  const uri = kind === "tv" ? `x-sonos-htastream:${uuid}:spdif` : `x-rincon-stream:${uuid}`;
  await sonosSoap(src.ip, "AVTransport", "SetAVTransportURI", { InstanceID: 0, CurrentURI: uri, CurrentURIMetaData: "" });
  if (kind !== "tv") await sonosSoap(src.ip, "AVTransport", "Play", { InstanceID: 0, Speed: 1 }).catch(() => {});
  for (const m of others) await sonosSoap(m.ip, "AVTransport", "SetAVTransportURI", { InstanceID: 0, CurrentURI: `x-rincon:${uuid}`, CurrentURIMetaData: "" }).catch(() => {});
  return { g, src };
}
// ---------- Sonos music: favorites, playlists, queue, Spotify links ----------
const hmsToSec = (t) => { const p = String(t || "").split(":").map(Number); return p.length === 3 && p.every((n) => !isNaN(n)) ? p[0] * 3600 + p[1] * 60 + p[2] : 0; };
const secToHms = (n) => { n = Math.max(0, Math.round(n)); return `${Math.floor(n / 3600)}:${String(Math.floor(n / 60) % 60).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`; };
const artUrl = (ip, a) => { if (!a) return ""; const u = /^https?:/i.test(a) ? a : `http://${ip}:1400${a.startsWith("/") ? "" : "/"}${a}`; return /^https:/i.test(u) ? u : "/api/art?u=" + encodeURIComponent(u); };
function learnSpotifyAccount(uri, meta) {
  const sn = (uri.match(/[?&]sn=(\d+)/) || [])[1];
  const svc = (String(meta || "").match(/SA_RINCON(\d+)_/) || [])[1];
  let changed = false;
  if (sn && sonosKnown.spotifySn !== sn) { sonosKnown.spotifySn = sn; changed = true; }
  if (svc && /spotify/i.test(uri) && sonosKnown.spotifySvc !== svc) { sonosKnown.spotifySvc = svc; changed = true; }
  if (changed) saveSonos();
}
function parseDidl(xml, ip) {
  const didl = xmlUnescape(tag(xml, "Result"));
  const out = [];
  for (const m of didl.match(/<(item|container)\b[\s\S]*?<\/\1>/g) || []) {
    const attr = (k) => (m.match(new RegExp(`\\b${k}="([^"]*)"`)) || [])[1] || "";
    const resMD = xmlUnescape(tag(m, "resMD"));
    const cls = tag(m, "class") || tag(resMD, "class");
    out.push({ id: xmlUnescape(attr("id")), title: xmlUnescape(tag(m, "title")), artist: xmlUnescape(tag(m, "creator") || tag(m, "artist")),
      album: xmlUnescape(tag(m, "album")), uri: xmlUnescape(tag(m, "res")), meta: resMD, cls, art: artUrl(ip, xmlUnescape(tag(m, "albumArtURI") || tag(resMD, "albumArtURI"))) });
  }
  return { items: out, total: Number(tag(xml, "TotalMatches")) || out.length };
}
async function sonosBrowse(ip, id, start = 0, count = 100) {
  const r = await sonosSoap(ip, "ContentDirectory", "Browse", { ObjectID: id, BrowseFlag: "BrowseDirectChildren", Filter: "*", StartingIndex: start, RequestedCount: count, SortCriteria: "" });
  return parseDidl(r, ip);
}
async function coordFor(group) {
  const groups = await sonosState();
  const g = groups.find((x) => x.id === group || x.members.some((m) => m.uuid === group)) || (!group && groups[0]);
  if (!g) throw new Error("Speaker group not found. Tap Refresh.");
  return g;
}
async function playQueueFrom(g, trackNr) {
  const ip = g.coordinator.ip;
  await sonosSoap(ip, "AVTransport", "SetAVTransportURI", { InstanceID: 0, CurrentURI: `x-rincon-queue:${g.coordinator.uuid}#0`, CurrentURIMetaData: "" });
  if (trackNr) await sonosSoap(ip, "AVTransport", "Seek", { InstanceID: 0, Unit: "TRACK_NR", Target: trackNr });
  await sonosSoap(ip, "AVTransport", "Play", { InstanceID: 0, Speed: 1 });
}
// mode: "now" = replace the queue and play, "next" = play after the current song, "add" = add to the end
async function enqueue(g, uri, meta, mode = "now") {
  const ip = g.coordinator.ip;
  if (mode === "now") await sonosSoap(ip, "AVTransport", "RemoveAllTracksFromQueue", { InstanceID: 0 }).catch(() => {});
  const pos = mode === "next" && g.isQueue && g.track ? g.track + 1 : 0;
  const r = await sonosSoap(ip, "AVTransport", "AddURIToQueue", { InstanceID: 0, EnqueuedURI: uri, EnqueuedURIMetaData: meta || "", DesiredFirstTrackNumberEnqueued: pos, EnqueueAsNext: mode === "next" ? 1 : 0 });
  const first = Number(tag(r, "FirstTrackNumberEnqueued")) || 1;
  if (mode === "now") await playQueueFrom(g, first);
  else if (mode === "next" && !g.isQueue) await playQueueFrom(g, first);
  return first;
}
const isContainer = (it) => /container|playlist/i.test(it.cls || "") || /^x-rincon-cpcontainer:|^file:\/\/\/jffs|savedqueues/i.test(it.uri || "");
async function playItem(g, it, mode = "now") {
  const ip = g.coordinator.ip;
  // radio / streams / TV / line-in can't go in the queue: play them directly
  const direct = /^(x-sonosapi-radio|x-sonosapi-stream|x-sonosapi-hls|x-rincon-mp3radio|aac|hls-radio|x-sonos-htastream|x-rincon-stream|x-sonosprog-http)/i.test(it.uri) || /audioBroadcast/i.test(it.cls || "");
  if (direct) {
    await sonosSoap(ip, "AVTransport", "SetAVTransportURI", { InstanceID: 0, CurrentURI: it.uri, CurrentURIMetaData: it.meta || "" });
    return sonosSoap(ip, "AVTransport", "Play", { InstanceID: 0, Speed: 1 });
  }
  return enqueue(g, it.uri, it.meta, mode);
}
const SPOTIFY_MAGIC = {
  album: ["x-rincon-cpcontainer:1004206c", "00040000", "object.container.album.musicAlbum"],
  track: ["", "00032020", "object.item.audioItem.musicTrack"],
  episode: ["", "00032020", "object.item.audioItem.musicTrack"],
  playlist: ["x-rincon-cpcontainer:1006206c", "1006206c", "object.container.playlistContainer"],
  show: ["x-rincon-cpcontainer:1006206c", "1006206c", "object.container.playlistContainer"],
};
function spotifyCanon(link) {
  const m = String(link || "").match(/spotify.*?[:/](album|episode|playlist|show|track)[:/]([A-Za-z0-9]+)/);
  return m ? { type: m[1], id: m[2], uri: `spotify:${m[1]}:${m[2]}` } : null;
}
// Plays a Spotify link/URI on Sonos through the Spotify account linked in the Sonos app (same trick the SoCo library uses).
async function playSpotifyOnSonos(g, link, mode = "now", title = "") {
  const c = spotifyCanon(link);
  if (!c) throw new Error("That doesn't look like a Spotify link. In Spotify tap Share, then Copy link.");
  const enc = c.uri.replace(/:/g, "%3a");
  const [prefix, key, cls] = SPOTIFY_MAGIC[c.type];
  const svcs = [...new Set([sonosKnown.spotifySvc, "2311", "3079"].filter(Boolean))];
  let lastErr;
  for (const svc of svcs) {
    const meta = `<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"><item id="${key}${enc}" parentID="-1" restricted="true"><dc:title>${xmlEsc(title)}</dc:title><upnp:class>${cls}</upnp:class><desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">SA_RINCON${svc}_X_#Svc${svc}-0-Token</desc></item></DIDL-Lite>`;
    try {
      await enqueue(g, prefix + enc, meta, mode);
      if (sonosKnown.spotifySvc !== svc) { sonosKnown.spotifySvc = svc; saveSonos(); }
      return;
    } catch (e) { lastErr = e; }
  }
  throw new Error(`Sonos wouldn't play that from Spotify. Make sure Spotify is added in the Sonos app (Settings → Services). (${lastErr && lastErr.message})`);
}

// ---------- Spotify account (Web API, PKCE login; needs Spotify Premium) ----------
const crypto = require("crypto");
const SPOTIFY_FILE = path.join(__dirname, "spotify.json");
let spotify = (() => { try { return JSON.parse(fs.readFileSync(SPOTIFY_FILE, "utf8")); } catch { return {}; } })();
const saveSpotify = () => fs.writeFileSync(SPOTIFY_FILE, JSON.stringify(spotify, null, 2));
const SPOTIFY_SCOPES = "user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-read-private playlist-read-collaborative user-read-recently-played";
const spotifyRedirect = () => `http://127.0.0.1:${PORT}/api/spotify/callback`;
let pkce = null;
function formPost(host, pth, form) {
  const body = new URLSearchParams(form).toString();
  return new Promise((resolve, reject) => {
    const req = https.request({ host, path: pth, method: "POST", timeout: 8000, headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) } }, (res) => {
      let out = ""; res.on("data", (c) => (out += c));
      res.on("end", () => { let j = {}; try { j = JSON.parse(out); } catch {} res.statusCode < 300 ? resolve(j) : reject(new Error(j.error_description || j.error || `Spotify said ${res.statusCode}`)); });
    });
    req.on("timeout", () => req.destroy(new Error("Spotify timed out"))); req.on("error", reject); req.write(body); req.end();
  });
}
async function spotifyToken() {
  if (!spotify.refreshToken) throw new Error("Spotify isn't connected yet. Open the Spotify tab to set it up.");
  if (spotify.accessToken && spotify.expiresAt > Date.now() + 30000) return spotify.accessToken;
  const j = await formPost("accounts.spotify.com", "/api/token", { grant_type: "refresh_token", refresh_token: spotify.refreshToken, client_id: spotify.clientId });
  spotify.accessToken = j.access_token; spotify.expiresAt = Date.now() + (j.expires_in || 3600) * 1000;
  if (j.refresh_token) spotify.refreshToken = j.refresh_token;
  saveSpotify();
  return spotify.accessToken;
}
async function spotifyApi(method, pth, body) {
  const token = await spotifyToken();
  const data = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = https.request({ host: "api.spotify.com", path: "/v1" + pth, method, timeout: 8000,
      headers: { Authorization: `Bearer ${token}`, ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : { "Content-Length": 0 }) } }, (res) => {
      let out = ""; res.on("data", (c) => (out += c));
      res.on("end", () => {
        let j = null; try { j = out ? JSON.parse(out) : null; } catch {}
        if (res.statusCode < 300) return resolve(j);
        const msg = (j && j.error && (j.error.message || j.error)) || `Spotify said ${res.statusCode}`;
        reject(new Error(res.statusCode === 403 && /premium/i.test(msg) ? "Spotify Premium is needed for playback control." : res.statusCode === 404 && /device/i.test(msg) ? "No active Spotify device. Start playing something in Spotify first, or pick a device." : msg));
      });
    });
    req.on("timeout", () => req.destroy(new Error("Spotify timed out"))); req.on("error", reject);
    if (data) req.write(data); req.end();
  });
}
const pickImg = (imgs) => (imgs && imgs.length ? (imgs[imgs.length > 1 ? 1 : 0] || imgs[0]).url : "");
const slimSpotify = (x, type) => x && ({ type, uri: x.uri, name: x.name,
  sub: type === "track" ? (x.artists || []).map((a) => a.name).join(", ") : type === "album" ? (x.artists || []).map((a) => a.name).join(", ") : type === "playlist" ? (x.owner && x.owner.display_name) || "" : "",
  art: pickImg(type === "track" ? x.album && x.album.images : x.images) });

// ---------- MagicLight / Magic Home / ZENGGE lights (local TCP 5577) ----------
const LIGHTS_FILE = path.join(__dirname, "lights.json");
let lights = (() => { try { return JSON.parse(fs.readFileSync(LIGHTS_FILE, "utf8")); } catch { return []; } })();
const saveLights = () => fs.writeFileSync(LIGHTS_FILE, JSON.stringify(lights, null, 2));
const withSum = (arr) => Buffer.from([...arr, arr.reduce((a, b) => a + b, 0) & 0xff]);
function lightSend(ip, bytes, expect = 0) {
  return new Promise((resolve, reject) => {
    const sock = require("net").connect({ host: ip, port: 5577 });
    let buf = Buffer.alloc(0), done = false;
    const fin = (err, val) => { if (done) return; done = true; sock.destroy(); err ? reject(err) : resolve(val); };
    sock.setTimeout(3000, () => fin(expect ? new Error(`Light at ${ip} didn't answer`) : null, buf));
    sock.on("connect", () => { sock.write(withSum(bytes)); if (!expect) setTimeout(() => fin(null, buf), 150); });
    sock.on("data", (d) => { buf = Buffer.concat([buf, d]); if (expect && buf.length >= expect) fin(null, buf); });
    sock.on("error", (e) => fin(new Error(`Can't reach the light at ${ip} (${e.code || e.message})`)));
  });
}
async function lightStatus(l) {
  try {
    const r = await lightSend(l.ip, [0x81, 0x8a, 0x8b], 14);
    const i = r.indexOf(0x81); const s = i >= 0 ? r.slice(i) : r;
    return { online: true, on: s[2] === 0x23, r: s[6], g: s[7], b: s[8], w: s[9], model: s[1] };
  } catch (e) { return { online: false, error: e.message }; }
}
const lightPower = (l, on) => lightSend(l.ip, [0x71, on ? 0x23 : 0x24, 0x0f]);
function lightColor(l, r, g, b) {
  // RGB write; the 0xF0 mask tells controllers with a white channel to leave white alone
  return lightSend(l.ip, [0x31, r & 255, g & 255, b & 255, 0x00, 0x00, 0xf0, 0x0f]);
}
function lightsDiscover(ms = 2500) {
  return new Promise((resolve) => {
    const found = [];
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    sock.on("message", (buf, r) => {
      const t = buf.toString().trim();
      if (!/^\d+\.\d+\.\d+\.\d+,/.test(t)) return;
      const [ip, mac, model] = t.split(",");
      if (!found.some((f) => f.ip === ip)) found.push({ ip, mac: normMac(mac), model: model || "" });
    });
    sock.on("error", () => { try { sock.close(); } catch {} resolve(found); });
    sock.bind(() => {
      sock.setBroadcast(true);
      const probe = Buffer.from("HF-A11ASSISTHREAD");
      const send = () => { try { sock.send(probe, 48899, "255.255.255.255"); } catch {} for (const l of lights) { try { sock.send(probe, 48899, l.ip); } catch {} } };
      send(); setTimeout(send, 800);
    });
    setTimeout(() => { try { sock.close(); } catch {} resolve(found); }, ms);
  });
}
function hexToRgb(h) { const m = String(h || "").replace("#", "").match(/^([0-9a-f]{6})$/i); if (!m) return null; const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
async function setLight(l, { on, color, brightness }) {
  if (on === false) return lightPower(l, false);
  if (on === true && color == null && brightness == null) return lightPower(l, true);
  let rgb = color ? hexToRgb(color) : null;
  if (!rgb) { const s = await lightStatus(l); rgb = s.online && (s.r || s.g || s.b) ? [s.r, s.g, s.b] : [255, 255, 255]; if (!color && brightness != null && s.online) { const mx = Math.max(s.r, s.g, s.b) || 255; rgb = [s.r, s.g, s.b].map((v) => (v / mx) * 255); } }
  if (brightness != null) { const k = Math.max(1, Math.min(100, Number(brightness))) / 100; const mx = Math.max(...rgb) || 255; rgb = rgb.map((v) => Math.round((v / mx) * 255 * k)); }
  if (on === true) await lightPower(l, true);
  if (color) l.color = color;
  if (brightness != null) l.brightness = Number(brightness);
  saveLights();
  return lightColor(l, ...rgb);
}

// built-in light shows (Magic Home preset patterns 0x25-0x38). speed 1-100 (100 = fastest)
const LIGHT_EFFECTS = { fade7: 0x25, fadeRed: 0x26, fadeGreen: 0x27, fadeBlue: 0x28, fadeYellow: 0x29, fadeCyan: 0x2a, fadePurple: 0x2b, fadeWhite: 0x2c,
  crossRG: 0x2d, crossRB: 0x2e, crossGB: 0x2f, strobe7: 0x30, strobeRed: 0x31, strobeGreen: 0x32, strobeBlue: 0x33, strobeYellow: 0x34, strobeCyan: 0x35, strobePurple: 0x36, strobeWhite: 0x37, jump7: 0x38 };
function lightEffect(l, pattern, speed = 60) {
  const p = typeof pattern === "number" ? pattern : LIGHT_EFFECTS[pattern];
  if (!p) throw new Error("Unknown effect");
  const delay = Math.max(1, Math.min(31, Math.round(31 - (Math.max(1, Math.min(100, Number(speed) || 60)) / 100) * 30)));
  return lightSend(l.ip, [0x61, p, delay, 0x0f]);
}
const findLight = (id) => lights.find((l) => l.id === id);

// ---------- light music sync: fast color stream over kept-open connections ----------
const lightSocks = new Map(); // id -> { sock, ready, pending, timer, last }
let streamActive = false, streamStopTimer = null;
function lightSock(l) {
  let st = lightSocks.get(l.id);
  if (st && st.ip === l.ip && !st.dead) return st;
  st = { ip: l.ip, ready: false, dead: false, pending: null, busyUntil: 0 };
  const sock = require("net").connect({ host: l.ip, port: 5577 });
  sock.setNoDelay(true);
  sock.on("connect", () => { st.ready = true; flushLight(st); });
  sock.on("data", () => {});
  const kill = () => { st.dead = true; st.ready = false; try { sock.destroy(); } catch {} };
  sock.on("error", kill); sock.on("close", kill);
  sock.setTimeout(20000, kill); // closes itself when music mode stops
  st.sock = sock;
  lightSocks.set(l.id, st);
  return st;
}
function flushLight(st) {
  if (!st.ready || !st.pending) return;
  const now = Date.now();
  if (now < st.busyUntil) { clearTimeout(st.timer); st.timer = setTimeout(() => flushLight(st), st.busyUntil - now); return; }
  st.sock.write(st.pending); st.pending = null; st.busyUntil = now + 45; // controllers choke above ~20 updates/sec
}
function streamColor(l, r, g, b) {
  const st = lightSock(l);
  st.pending = withSum([0x31, r & 255, g & 255, b & 255, 0x00, 0x00, 0xf0, 0x0f]);
  flushLight(st);
}


// ---------- presets ----------
const PRESETS_FILE = path.join(__dirname, "presets.json");
let presets = (() => { try { return JSON.parse(fs.readFileSync(PRESETS_FILE, "utf8")); } catch { return []; } })();
const savePresets = () => fs.writeFileSync(PRESETS_FILE, JSON.stringify(presets, null, 2));
const STEP_ACTIONS = ["poweron", "poweroff", "power", "app", "key", "text", "wait"];
function cleanSteps(steps) {
  return (Array.isArray(steps) ? steps : []).slice(0, 40).map((st) => ({
    tv: String(st.tv || "all"), action: STEP_ACTIONS.includes(st.action) ? st.action : "poweron",
    value: st.value == null ? "" : String(st.value).slice(0, 120),
  }));
}
const stepTargets = (st) => (st.tv === "all" ? tvs.map((t) => t.id) : [st.tv]).filter(findTv);
async function runSteps(steps) {
  const log = [];
  for (const st of steps) {
    if (st.action === "wait") { await new Promise((r) => setTimeout(r, Math.min(30, Math.max(0, Number(st.value) || 2)) * 1000)); continue; }
    const ids = stepTargets(st);
    if (!ids.length) continue;
    const fn = st.action === "app" ? (tv) => launchApp(tv, st.value)
      : st.action === "text" ? (tv) => sendText(tv, st.value)
      : st.action === "key" ? (tv) => sendKey(tv, st.value)
      : (tv) => sendKey(tv, st.action);
    // "turn on" for Rokus in deep standby can need a moment; send in parallel across TVs
    log.push(...(await fanOut(ids, fn)));
  }
  return log;
}
app.get("/api/harmony", (req, res) => res.json({ ip: harmony.ip || "", connected: !!harmony.hubId }));
app.post("/api/harmony", wrap(async (req, res) => {
  const ip = String((req.body || {}).ip || "").trim();
  if (hws) { try { hws.close(); } catch {} hws = null; }
  harmony = { ip }; harmonyCache = { at: 0, devices: [] }; saveHarmony();
  if (!ip) return res.json({ ok: true, devices: [] });
  const devs = await harmonyDevices(true);
  res.json({ ok: true, devices: devs.map(({ id, label, manufacturer, model }) => ({ id, label, manufacturer, model })) });
}));
app.get("/api/harmony/devices", wrap(async (req, res) => {
  if (!harmony.ip) return res.json({ devices: [] });
  const devs = await harmonyDevices(req.query.refresh === "1");
  res.json({ devices: devs.map(({ id, label, manufacturer, model, commands }) => ({ id, label, manufacturer, model, power: commands.filter((c) => c.group === "Power").map((c) => c.name) })) });
}));
app.post("/api/tvs/:id/harmony-test", wrap(async (req, res) => {
  const tv = findTv(req.params.id);
  if (!tv || !tv.harmonyDevice) return res.status(400).json({ error: "Pick a Harmony device for this TV first." });
  res.json({ ok: true, sent: await harmonySend(tv, "poweron") });
}));

app.get("/api/presets", (req, res) => res.json(presets));
app.post("/api/presets", (req, res) => {
  const { name, steps } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: "Give the preset a name." });
  const p = { id: Date.now().toString(36), name: String(name).trim().slice(0, 40), steps: cleanSteps(steps) };
  presets.push(p); savePresets(); res.json(p);
});
app.put("/api/presets/:id", (req, res) => {
  const p = presets.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: "Preset not found" });
  const { name, steps } = req.body || {};
  if (name) p.name = String(name).trim().slice(0, 40);
  if (steps) p.steps = cleanSteps(steps);
  savePresets(); res.json(p);
});
app.delete("/api/presets/:id", (req, res) => { presets = presets.filter((x) => x.id !== req.params.id); savePresets(); res.json({ ok: true }); });
app.post("/api/presets/order", (req, res) => {
  const order = (req.body || {}).ids || [];
  presets.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)); savePresets(); res.json(presets);
});
app.post("/api/presets/test", wrap(async (req, res) => res.json({ results: await runSteps(cleanSteps((req.body || {}).steps)) })));
app.post("/api/presets/:id/run", wrap(async (req, res) => {
  const p = presets.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: "Preset not found" });
  res.json({ name: p.name, results: await runSteps(p.steps) });
}));

// ---------- voice / typed commands ----------
const norm = (t) => String(t || "").toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9+ ]+/g, " ").replace(/\s+/g, " ").trim();
const APP_WORDS = {
  youtube: ["youtube"], netflix: ["netflix"], youtubetv: ["youtube tv", "youtubetv"], hulu: ["hulu"], disney: ["disney", "disney plus", "disney+"],
  prime: ["prime", "prime video", "amazon prime", "amazon video"], max: ["max", "hbo", "hbo max"], peacock: ["peacock"],
  paramount: ["paramount", "paramount plus", "paramount+"], espn: ["espn"], appletv: ["apple tv", "apple"], spotify: ["spotify"],
  plex: ["plex"], pluto: ["pluto", "pluto tv"], mlb: ["mlb", "mlb tv", "baseball", "the game"],
};
const KEY_WORDS = [
  ["poweroff", /\b(turn|switch|shut|power) (it |them )?off\b|\b(turn|shut|switch) off\b|\bpower off\b|\bsleep\b/],
  ["poweron", /\b(turn|switch|power) (it |them )?on\b|\bwake( up)?\b|\bpower on\b/],
  ["play", /\b(play|pause|resume|unpause)\b/],
  ["home", /\b(go )?home\b/], ["back", /\bgo back\b|^back$/],
  ["mute", /\b(mute|unmute)\b/], ["volup", /\b(volume up|louder|turn it up)\b/], ["voldown", /\b(volume down|quieter|softer|turn it down)\b/],
  ["ff", /\b(fast forward|skip ahead)\b/], ["rew", /\b(rewind|go back 10)\b/],
];
function matchTvs(text, fallbackIds) {
  if (/\b(all|every|everything|all the)\b( tvs?| the tvs| televisions)?/.test(text) && /\b(tvs|televisions|all|everything)\b/.test(text))
    return tvs.map((t) => t.id);
  const hits = [];
  for (const tv of tvs) {
    const n = norm(tv.name);
    const words = n.split(" ").filter((w) => w.length > 2 && !["the", "and", "roku", "tv", "fire"].includes(w));
    if (n && text.includes(n)) { hits.push({ id: tv.id, score: 100 + n.length }); continue; }
    const score = words.filter((w) => new RegExp(`\\b${w}\\b`).test(text)).length;
    if (score) hits.push({ id: tv.id, score });
  }
  if (!hits.length) {
    // type words: "the roku", "the fire tv", "google tv"
    const byType = (re, ok) => (re.test(text) ? tvs.filter(ok).map((t) => t.id) : []);
    const t = [...byType(/\bgoogle( tv)?\b/, (x) => x.type === "googletv"), ...byType(/\bfire( tv| stick)?\b/, (x) => x.type === "firetv" || x.type === "vega")];
    if (t.length) return t;
    return fallbackIds;
  }
  const top = Math.max(...hits.map((h) => h.score));
  return hits.filter((h) => h.score === top || h.score >= 100).map((h) => h.id);
}
function matchApp(text) {
  let best = null;
  for (const [key, words] of Object.entries(APP_WORDS))
    for (const w of words) if (new RegExp(`\\b${w.replace("+", "\\+")}\\b`).test(text) && (!best || w.length > best.len)) best = { key, len: w.length };
  return best && best.key;
}
app.post("/api/command", wrap(async (req, res) => {
  const raw = String((req.body || {}).text || "");
  const text = norm(raw);
  const fallback = ((req.body || {}).ids || []).filter(findTv);
  if (!text) return res.status(400).json({ error: "Say or type a command." });
  // 1. preset by name ("game day", "run game day", "start movie night")
  const pText = text.replace(/^(run|start|do|play|activate|set up|setup)\s+/, "").replace(/\s+(preset|mode|scene)$/, "");
  const preset = presets.find((p) => norm(p.name) === pText) || presets.find((p) => text.includes(norm(p.name)) && norm(p.name).length > 2);
  if (preset) return res.json({ did: `Running ${preset.name}`, results: await runSteps(preset.steps) });
  // 1b. lights ("turn on the lights", "bottom clouds off", "make the window light blue")
  const namedLights = lights.filter((l) => { const n = norm(l.name); return n && (text.includes(n) || n.split(" ").filter((w) => w.length > 3 && !["light", "lights", "bottom", "front"].includes(w)).some((w) => new RegExp(`\\b${w}\\b`).test(text))); });
  if (lights.length && (/\b(light|lights|lamp|lamps|bulb|bulbs|strip)\b/.test(text) || namedLights.length) && !tvs.some((t) => text.includes(norm(t.name)))) {
    const named = namedLights;
    const which = named.length ? named : lights;
    const COLORS = { red: "#ff0000", green: "#00ff00", blue: "#0000ff", purple: "#8000ff", pink: "#ff3399", orange: "#ff6a00", yellow: "#ffd000", white: "#ffffff", cyan: "#00ffff", teal: "#00c8a0" };
    const col = Object.keys(COLORS).find((c) => new RegExp(`\\b${c}\\b`).test(text));
    const off = /\b(off|out)\b/.test(text);
    const pct = (raw.toLowerCase().match(/(\d{1,3}) ?(%|percent)/) || text.match(/\b(?:brightness|to|at) (\d{1,3})\b/) || [])[1];
    const body = off ? { on: false } : { on: true, ...(col ? { color: COLORS[col] } : {}), ...(pct ? { brightness: Number(pct) } : {}) };
    const results = await Promise.allSettled(which.map((l) => setLight(l, body)));
    return res.json({ did: `${off ? "Turning off" : "Setting"} ${which.length === lights.length ? "all lights" : which.map((l) => l.name).join(", ")}${col ? " to " + col : ""}`,
      results: results.map((r, i) => ({ id: which[i].id, name: which[i].name, ok: r.status === "fulfilled", error: r.reason && r.reason.message })) });
  }
  // 1b2. "play harvest moon on the tv room" / "play my chill playlist on sonos" / "play <favorite>"
  const pm = text.match(/^(?:play|put on|listen to)\s+(.+?)(?:\s+on\s+(?:the\s+)?(.+?))?(?:\s+on spotify)?$/);
  if (pm && !matchApp(text)) {
    let groups = null; try { groups = await sonosState(); } catch {}
    if (groups && groups.length) {
      const where = norm(pm[2] || "");
      const byRoom = where && groups.find((g) => g.members.some((m) => where.includes(norm(m.name)) || norm(m.name).includes(where)));
      const saidMusic = /\b(sonos|speakers?|spotify|music|song|playlist|album)\b/.test(text) || byRoom;
      const what = pm[1].replace(/\b(the |my )?(song|playlist|album|music|by)\b/g, (w) => (/by/.test(w) ? " " : " ")).replace(/\s+/g, " ").trim();
      let fav = null;
      try { fav = (await sonosBrowse(groups[0].coordinator.ip, "FV:2")).items.find((f) => norm(f.title) === norm(what) || (norm(what).length > 3 && norm(f.title).includes(norm(what)))); } catch {}
      if ((fav || saidMusic) && !(!byRoom && pm[2] && tvs.some((t) => norm(pm[2]).includes(norm(t.name))))) {
        const g = byRoom || groups.find((x) => /PLAYING/.test(x.state)) || groups[0];
        if (fav) { await playItem(g, fav, "now"); return res.json({ did: `Playing ${fav.title} on ${g.name}`, results: [] }); }
        if (spotify.refreshToken && what) {
          const type = /\bplaylist\b/.test(pm[1]) ? "playlist" : /\balbum\b/.test(pm[1]) ? "album" : "track";
          const j = await spotifyApi("GET", `/search?${new URLSearchParams({ q: what, type, limit: "1" })}`);
          const hit = j[type + "s"] && j[type + "s"].items.filter(Boolean)[0];
          if (!hit) return res.status(404).json({ error: `Couldn't find "${what}" on Spotify.` });
          await playSpotifyOnSonos(g, hit.uri, "now", hit.name);
          return res.json({ did: `Playing ${hit.name}${hit.artists ? " by " + hit.artists.map((a) => a.name).join(", ") : ""} on ${g.name}`, results: [] });
        }
        if (saidMusic) return res.status(400).json({ error: "Connect Spotify in the Music tab to play songs by name, or save it as a Sonos favorite." });
      }
    }
  }
  // 1c0. "sonos tv" / "switch the speakers to tv" / "tv sound on the beam"
  if (/\b(sonos|speakers?|soundbar|beam|sound bar|music)\b/.test(text) && /\b(tv|hdmi|television)\b/.test(text) && !/\b(volume|louder|quieter|mute)\b/.test(text)) {
    const groups = await sonosState();
    const byRoom = groups.find((g) => g.members.some((m) => m.hasTv && text.includes(norm(m.name))));
    const g = byRoom || groups.find((x) => x.tvMember);
    if (!g) return res.status(400).json({ error: "None of your Sonos speakers has a TV (HDMI) input." });
    await sonosInput(g.tvMember, "tv");
    return res.json({ did: `${g.name}: switched to TV`, results: [] });
  }
  // 1c. Sonos ("sonos volume 30", "pause the music", "group all speakers")
  if (/\b(sonos|music|speaker|speakers)\b/.test(text)) {
    const groups = await sonosState();
    if (/\bgroup\b.*\b(all|every)/.test(text) || /\b(all|every)\b.*\bgroup/.test(text)) {
      const into = groups[0];
      for (const g of groups.slice(1)) for (const m of g.members) await sonosSoap(m.ip, "AVTransport", "SetAVTransportURI", { InstanceID: 0, CurrentURI: `x-rincon:${into.coordinator.uuid}`, CurrentURIMetaData: "" }).catch(() => {});
      return res.json({ did: "Grouping all speakers", results: [] });
    }
    const g = groups.find((x) => x.members.some((m) => text.includes(norm(m.name)))) || groups[0];
    if (!g) return res.status(400).json({ error: "No Sonos speakers found." });
    const v = (text.match(/\b(\d{1,3})\b/) || [])[1];
    if (/\bvolume\b/.test(text) && v) { await sonosGroupVolume(g.coordinator.ip, v); return res.json({ did: `${g.name} volume ${v}`, results: [] }); }
    if (/\b(louder|volume up|turn it up)\b/.test(text)) { await sonosGroupVolume(g.coordinator.ip, (g.volume || 0) + 8); return res.json({ did: `${g.name} louder`, results: [] }); }
    if (/\b(quieter|softer|volume down|turn it down)\b/.test(text)) { await sonosGroupVolume(g.coordinator.ip, (g.volume || 0) - 8); return res.json({ did: `${g.name} quieter`, results: [] }); }
    if (/\b(pause|stop)\b/.test(text)) { await sonosSoap(g.coordinator.ip, "AVTransport", "Pause", { InstanceID: 0 }); return res.json({ did: `Paused ${g.name}`, results: [] }); }
    if (/\b(play|resume)\b/.test(text)) { await sonosSoap(g.coordinator.ip, "AVTransport", "Play", { InstanceID: 0, Speed: 1 }); return res.json({ did: `Playing ${g.name}`, results: [] }); }
    if (/\b(skip|next)\b/.test(text)) { await sonosSoap(g.coordinator.ip, "AVTransport", "Next", { InstanceID: 0 }); return res.json({ did: `Next on ${g.name}`, results: [] }); }
  }
  const ids = matchTvs(text, fallback);
  const names = (list) => (list.length === tvs.length && list.length > 1 ? "all TVs" : list.map((id) => findTv(id).name).join(", "));
  // 2. app on TV ("put espn on the hisense", "netflix on the roku ultra")
  const appKey = matchApp(text);
  if (appKey && !/\b(turn|power|shut) (it |them )?off\b/.test(text)) {
    if (!ids.length) return res.status(400).json({ error: "Which TV? Say its name, like \"ESPN on the Hisense\"." });
    const entry = APPS.find((a) => a.key === appKey);
    return res.json({ did: `Opening ${entry.name} on ${names(ids)}`, results: await fanOut(ids, (tv) => launchApp(tv, appKey)) });
  }
  // 3. button commands
  const key = KEY_WORDS.find(([, re]) => re.test(text));
  if (key) {
    if (!ids.length) return res.status(400).json({ error: "Which TV? Say its name, or \"all TVs\"." });
    return res.json({ did: `${{ poweroff: "Turning off", poweron: "Turning on", play: "Play/pause on", home: "Home on", back: "Back on", mute: "Mute on", volup: "Volume up on", voldown: "Volume down on", ff: "Fast forward on", rew: "Rewind on" }[key[0]]} ${names(ids)}`,
      results: await fanOut(ids, (tv) => sendKey(tv, key[0])) });
  }
  // 4. search ("search for ted lasso on the tcl")
  const m = text.match(/^(search( for)?|find|type)\s+(.+?)(\s+on\s+.+)?$/);
  if (m && ids.length) return res.json({ did: `Typing "${m[3]}" on ${names(ids)}`, results: await fanOut(ids, (tv) => sendText(tv, m[3])) });
  res.status(400).json({ error: `Didn't catch that. Try a preset name, "ESPN on the Hisense", or "turn off all TVs".` });
}));

// ---------- start ----------
// ---------- HTTPS (self-signed) so the iPad's microphone works for voice + light music sync ----------
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || Number(PORT) + 443;
const CERT_FILE = path.join(__dirname, "cert.json");
let httpsUp = false;
function derLen(n) { if (n < 128) return Buffer.from([n]); const b = []; while (n) { b.unshift(n & 255); n >>= 8; } return Buffer.from([0x80 | b.length, ...b]); }
const der = (tagByte, ...parts) => { const c = Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p)))); return Buffer.concat([Buffer.from([tagByte]), derLen(c.length), c]); };
const dSeq = (...x) => der(0x30, ...x), dSet = (...x) => der(0x31, ...x);
const dInt = (buf) => { if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0]), buf]); return der(0x02, buf); };
const dOid = (str) => { const p = str.split(".").map(Number); const out = [40 * p[0] + p[1]]; for (const n of p.slice(2)) { const b = [n & 127]; let v = n >> 7; while (v) { b.unshift(0x80 | (v & 127)); v >>= 7; } out.push(...b); } return der(0x06, Buffer.from(out)); };
const dUtc = (d) => der(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z"));
const localIps = () => Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === "IPv4").map((i) => i.address);
function makeCert(ips) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const alg = dSeq(dOid("1.2.840.113549.1.1.11"), Buffer.from([0x05, 0x00]));
  const name = dSeq(dSet(dSeq(dOid("2.5.4.3"), der(0x0c, "TV Remote Hub"))));
  const now = new Date(Date.now() - 86400000), until = new Date(Date.now() + 800 * 86400000);
  const san = dSeq(...ips.map((ip) => der(0x87, Buffer.from(ip.split(".").map(Number)))), der(0x82, "localhost"));
  const exts = der(0xa3, dSeq(
    dSeq(dOid("2.5.29.17"), der(0x04, san)),
    dSeq(dOid("2.5.29.19"), der(0x04, dSeq())),
    dSeq(dOid("2.5.29.37"), der(0x04, dSeq(dOid("1.3.6.1.5.5.7.3.1")))),
  ));
  const tbs = dSeq(der(0xa0, dInt(Buffer.from([2]))), dInt(crypto.randomBytes(12)), alg, name, dSeq(dUtc(now), dUtc(until)), name,
    publicKey.export({ type: "spki", format: "der" }), exts);
  const sig = crypto.sign("sha256", tbs, privateKey);
  const certDer = dSeq(tbs, alg, der(0x03, Buffer.concat([Buffer.from([0]), sig])));
  const pem = "-----BEGIN CERTIFICATE-----\n" + certDer.toString("base64").match(/.{1,64}/g).join("\n") + "\n-----END CERTIFICATE-----\n";
  return { cert: pem, key: privateKey.export({ type: "pkcs8", format: "pem" }), ips, until: until.getTime() };
}
function startHttps() {
  try {
    const ips = localIps();
    let c = null; try { c = JSON.parse(fs.readFileSync(CERT_FILE, "utf8")); } catch {}
    if (!c || c.until < Date.now() + 7 * 86400000 || ips.some((ip) => !c.ips.includes(ip))) { c = makeCert(ips); fs.writeFileSync(CERT_FILE, JSON.stringify(c)); }
    https.createServer({ cert: c.cert, key: c.key }, app).on("error", (e) => console.log(`  (Secure page not started: ${e.message})`))
      .listen(HTTPS_PORT, "0.0.0.0", () => { httpsUp = true; ips.filter((ip) => ip !== "127.0.0.1").forEach((ip) => console.log(`  Secure (for the iPad mic): https://${ip}:${HTTPS_PORT}`)); });
  } catch (e) { console.log("  (Secure page not started: " + e.message + ")"); }
}
// ---------- Alexa: the hub pretends to be a Philips Hue bridge so Echo speakers find and control things locally ----------
const ALEXA_FILE = path.join(__dirname, "alexa.json");
let alexaCfg = (() => { try { return JSON.parse(fs.readFileSync(ALEXA_FILE, "utf8")); } catch { return {}; } })();
alexaCfg.ids = alexaCfg.ids || {}; alexaCfg.names = alexaCfg.names || {}; alexaCfg.off = alexaCfg.off || []; alexaCfg.nextId = alexaCfg.nextId || 1;
const saveAlexa = () => fs.writeFileSync(ALEXA_FILE, JSON.stringify(alexaCfg, null, 2));
const ALEXA_PORT = Number(process.env.ALEXA_PORT) || 80;
let alexaStatus = { http: false, ssdp: false, error: "" };
const alexaState = new Map(); // key -> { on, bri, hue, sat, ct, xy, colormode }
const cleanName = (n) => String(n || "").replace(/"/g, " inch").replace(/[^\w\s'&+-]/g, " ").replace(/\s+/g, " ").trim();
function alexaDevices() {
  const out = [];
  const add = (key, def, kind, extra = {}) => out.push({ key, name: alexaCfg.names[key] || cleanName(def), defName: cleanName(def), kind, enabled: !alexaCfg.off.includes(key), ...extra });
  for (const tv of tvs) add("tv:" + tv.id, tv.name, "tv", { tvId: tv.id });
  for (const p of presets) add("preset:" + p.id, p.name, "preset", { presetId: p.id });
  for (const l of lights) add("light:" + l.id, l.name, "light", { lightId: l.id });
  if (lights.length) add("lights:all", "All lights", "lightsAll");
  for (const sp of sonosLastRooms) {
    add("sonos:" + sp.uuid, `${sp.name} speakers`, "sonos", { uuid: sp.uuid });
    if (sp.hasTv) add("sonostv:" + sp.uuid, `${sp.name} TV sound`, "sonosTv", { uuid: sp.uuid });
  }
  for (const d of out) if (!alexaCfg.ids[d.key]) { alexaCfg.ids[d.key] = String(alexaCfg.nextId++); saveAlexa(); }
  out.forEach((d) => (d.id = alexaCfg.ids[d.key]));
  return out;
}
let sonosLastRooms = [];
const refreshSonosRooms = async () => { try { const gs = await sonosState(); sonosLastRooms = gs.flatMap((g) => g.members.map((m) => ({ uuid: m.uuid, name: m.name, hasTv: m.hasTv, volume: m.volume, playing: /PLAYING/.test(g.state || "") }))); } catch {} };
setTimeout(refreshSonosRooms, 4000); setInterval(refreshSonosRooms, 5 * 60 * 1000);

const macHex = (() => { const i = Object.values(os.networkInterfaces()).flat().find((x) => x && !x.internal && x.mac && x.mac !== "00:00:00:00:00:00"); return (i ? i.mac : "02:00:00:aa:bb:cc").replace(/:/g, ""); })();
function alexaIp() {
  const ifs = os.networkInterfaces(); const list = [];
  for (const [name, arr] of Object.entries(ifs)) for (const i of arr || []) if (i.family === "IPv4" && !i.internal) list.push({ name, ip: i.address });
  list.sort((a, b) => (/wi-?fi|wlan|wireless/i.test(a.name) - /wi-?fi|wlan|wireless/i.test(b.name)) || (b.ip.startsWith("192.168.1.") - a.ip.startsWith("192.168.1.")));
  return (list[0] || { ip: "127.0.0.1" }).ip;
}
function hueLight(d) {
  const st = alexaState.get(d.key) || { on: false, bri: 254 };
  const color = d.kind === "light" || d.kind === "lightsAll";
  const dim = color || d.kind === "sonos";
  const uid = `00:17:88:01:00:${("000000" + Number(d.id).toString(16)).slice(-6).match(/../g).join(":")}-0b`;
  const base = { state: { on: !!st.on, bri: Math.max(1, Math.min(254, st.bri || 254)), alert: "none", mode: "homeautomation", reachable: true },
    name: d.name, uniqueid: uid, manufacturername: "Philips", swversion: "1.46.13_r26312" };
  if (color) return { ...base, state: { ...base.state, hue: st.hue || 0, sat: st.sat || 0, effect: "none", xy: st.xy || [0.3227, 0.329], ct: st.ct || 366, colormode: st.colormode || "hs" },
    type: "Extended color light", modelid: "LCT015", productname: "Hue color lamp" };
  if (dim) return { ...base, type: "Dimmable light", modelid: "LWB010", productname: "Hue white lamp" };
  const { bri, ...onOnly } = base.state;
  return { ...base, state: onOnly, type: "On/Off plug-in unit", modelid: "LOM001", productname: "Hue Smart plug" };
}
// color helpers for Alexa's requests
function hsToHex(h, s) { return hsv((h / 65535) * 360, s / 254, 1); }
function xyToHex([x, y]) {
  const z = 1 - x - y, Y = 1, X = (Y / y) * x, Z = (Y / y) * z;
  let r = X * 1.656492 - Y * 0.354851 - Z * 0.255038, g = -X * 0.707196 + Y * 1.655397 + Z * 0.036152, b = X * 0.051713 - Y * 0.121364 + Z * 1.01153;
  const gam = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
  [r, g, b] = [r, g, b].map((v) => Math.max(0, gam(v))); const m = Math.max(r, g, b, 1e-6);
  return "#" + [r, g, b].map((v) => Math.round((v / m) * 255).toString(16).padStart(2, "0")).join("");
}
function ctToHex(mired) {
  const t = 1e6 / mired / 100; let r, g, b;
  if (t <= 66) { r = 255; g = 99.47 * Math.log(t) - 161.12; b = t <= 19 ? 0 : 138.52 * Math.log(t - 10) - 305.04; }
  else { r = 329.7 * Math.pow(t - 60, -0.1332); g = 288.12 * Math.pow(t - 60, -0.0755); b = 255; }
  return "#" + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
}
function hsv(h, s, v) { h = (((h % 360) + 360) % 360) / 60; const c = v * s, x = c * (1 - Math.abs((h % 2) - 1)), m = v - c; const [r, g, b] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x]; return "#" + [r, g, b].map((n) => Math.round((n + m) * 255).toString(16).padStart(2, "0")).join(""); }

async function alexaAct(d, body) {
  const st = { ...(alexaState.get(d.key) || { on: false, bri: 254 }) };
  if (body.on !== undefined) st.on = !!body.on;
  if (body.bri !== undefined) { st.bri = body.bri; st.on = true; }
  let color = null;
  if (body.hue !== undefined || body.sat !== undefined) { st.hue = body.hue ?? st.hue ?? 0; st.sat = body.sat ?? st.sat ?? 254; st.colormode = "hs"; color = hsToHex(st.hue, st.sat); st.on = true; }
  if (body.xy) { st.xy = body.xy; st.colormode = "xy"; color = xyToHex(body.xy); st.on = true; }
  if (body.ct) { st.ct = body.ct; st.colormode = "ct"; color = ctToHex(body.ct); st.on = true; }
  alexaState.set(d.key, st);
  const pct = Math.max(1, Math.round((st.bri / 254) * 100));
  const run = async () => {
    if (d.kind === "tv") { const tv = findTv(d.tvId); if (tv) await sendKey(tv, st.on ? "poweron" : "poweroff"); }
    else if (d.kind === "preset") { const p = presets.find((x) => x.id === d.presetId); if (p && st.on) await runSteps(p.steps); setTimeout(() => alexaState.set(d.key, { ...st, on: false }), 5000); }
    else if (d.kind === "light" || d.kind === "lightsAll") {
      const sel = d.kind === "light" ? [findLight(d.lightId)].filter(Boolean) : lights;
      await Promise.allSettled(sel.map((l) => (!st.on ? lightPower(l, false) : color || body.bri !== undefined ? setLight(l, { on: true, color: color || undefined, brightness: body.bri !== undefined ? pct : undefined }) : lightPower(l, true))));
    } else if (d.kind === "sonos") {
      const g = await coordFor(d.uuid);
      if (body.bri !== undefined) await sonosGroupVolume(g.coordinator.ip, pct);
      if (body.on !== undefined) await sonosSoap(g.coordinator.ip, "AVTransport", st.on ? "Play" : "Pause", st.on ? { InstanceID: 0, Speed: 1 } : { InstanceID: 0 }).catch(() => {});
    } else if (d.kind === "sonosTv") {
      if (st.on) await sonosInput(d.uuid, "tv"); else { const g = await coordFor(d.uuid); await sonosSoap(g.coordinator.ip, "AVTransport", "Pause", { InstanceID: 0 }).catch(() => {}); }
    }
  };
  run().catch((e) => console.log("Alexa action failed:", d.name, e.message)); // answer Alexa right away; the work happens in the background
  return st;
}
function startAlexa() {
  const hue = express();
  hue.use(express.text({ type: "*/*" }));
  const bodyOf = (req) => { try { return JSON.parse(req.body || "{}"); } catch { return {}; } };
  const enabled = () => alexaDevices().filter((d) => d.enabled);
  const lightsMap = () => Object.fromEntries(enabled().map((d) => [d.id, hueLight(d)]));
  hue.get("/description.xml", (req, res) => {
    const ip = alexaIp();
    res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8" ?><root xmlns="urn:schemas-upnp-org:device-1-0"><specVersion><major>1</major><minor>0</minor></specVersion><URLBase>http://${ip}:${ALEXA_PORT}/</URLBase><device><deviceType>urn:schemas-upnp-org:device:Basic:1</deviceType><friendlyName>TV Remote Hub (${ip})</friendlyName><manufacturer>Royal Philips Electronics</manufacturer><manufacturerURL>http://www.philips.com</manufacturerURL><modelDescription>Philips hue Personal Wireless Lighting</modelDescription><modelName>Philips hue bridge 2012</modelName><modelNumber>929000226503</modelNumber><modelURL>http://www.meethue.com</modelURL><serialNumber>${macHex}</serialNumber><UDN>uuid:2f402f80-da50-11e1-9b23-${macHex}</UDN><presentationURL>index.html</presentationURL></device></root>`);
  });
  hue.post("/api", (req, res) => res.json([{ success: { username: "tvremotehub" + macHex.slice(-6) } }]));
  hue.get("/api/:user", (req, res) => res.json({ lights: lightsMap(), groups: {}, scenes: {}, schedules: {}, sensors: {}, rules: {}, config: { name: "TV Remote Hub", mac: macHex.match(/../g).join(":"), bridgeid: macHex.slice(0, 6).toUpperCase() + "FFFE" + macHex.slice(6).toUpperCase(), modelid: "BSB002", apiversion: "1.17.0", swversion: "1711151408", ipaddress: alexaIp() } }));
  hue.get("/api/:user/config", (req, res) => res.json({ name: "TV Remote Hub", mac: macHex.match(/../g).join(":"), bridgeid: macHex.slice(0, 6).toUpperCase() + "FFFE" + macHex.slice(6).toUpperCase(), modelid: "BSB002", apiversion: "1.17.0", swversion: "1711151408", ipaddress: alexaIp() }));
  hue.get("/api/:user/lights", (req, res) => res.json(lightsMap()));
  hue.get("/api/:user/groups", (req, res) => res.json({}));
  hue.get("/api/:user/lights/:id", (req, res) => { const d = enabled().find((x) => x.id === req.params.id); d ? res.json(hueLight(d)) : res.status(404).json([{ error: { type: 3, address: `/lights/${req.params.id}`, description: "resource not available" } }]); });
  hue.put("/api/:user/lights/:id/state", async (req, res) => {
    const d = enabled().find((x) => x.id === req.params.id);
    if (!d) return res.status(404).json([{ error: { type: 3, address: `/lights/${req.params.id}`, description: "resource not available" } }]);
    const body = bodyOf(req);
    await alexaAct(d, body);
    res.json(Object.entries(body).map(([k, v]) => ({ success: { [`/lights/${d.id}/state/${k}`]: v } })));
  });
  hue.listen(ALEXA_PORT, "0.0.0.0", () => { alexaStatus.http = true; console.log(`  Alexa bridge ready (say "Alexa, discover devices")`); })
    .on("error", (e) => { alexaStatus.error = e.code === "EADDRINUSE" ? `Port ${ALEXA_PORT} is already used by another program on this PC.` : e.code === "EACCES" ? `Not allowed to use port ${ALEXA_PORT}.` : e.message; console.log("  (Alexa bridge off: " + alexaStatus.error + ")"); });
  // answer Echo's "is there a Hue bridge here?" search
  const ssdp = dgram.createSocket({ type: "udp4", reuseAddr: true });
  ssdp.on("message", (msg, r) => {
    const t = msg.toString();
    if (!/^M-SEARCH/i.test(t) || !/(ssdp:all|upnp:rootdevice|device:basic:1)/i.test(t)) return;
    const ip = alexaIp();
    for (const st of ["upnp:rootdevice", `uuid:2f402f80-da50-11e1-9b23-${macHex}`, "urn:schemas-upnp-org:device:basic:1"]) {
      const reply = `HTTP/1.1 200 OK\r\nHOST: 239.255.255.250:1900\r\nEXT:\r\nCACHE-CONTROL: max-age=100\r\nLOCATION: http://${ip}:${ALEXA_PORT}/description.xml\r\nSERVER: Linux/3.14.0 UPnP/1.0 IpBridge/1.17.0\r\nhue-bridgeid: ${macHex.slice(0, 6).toUpperCase()}FFFE${macHex.slice(6).toUpperCase()}\r\nST: ${st}\r\nUSN: uuid:2f402f80-da50-11e1-9b23-${macHex}${st.startsWith("uuid") ? "" : "::" + st}\r\n\r\n`;
      ssdp.send(reply, r.port, r.address);
    }
  });
  ssdp.on("error", (e) => { alexaStatus.ssdp = false; console.log("  (Alexa discovery off: " + e.message + ")"); });
  ssdp.bind(1900, () => { try { for (const i of Object.values(os.networkInterfaces()).flat()) if (i && i.family === "IPv4" && !i.internal) ssdp.addMembership("239.255.255.250", i.address); alexaStatus.ssdp = true; } catch (e) { try { ssdp.addMembership("239.255.255.250"); alexaStatus.ssdp = true; } catch {} } });
}
startAlexa();
// keep light states Alexa sees roughly in sync with reality
setInterval(async () => {
  for (const l of lights) { const s = await lightStatus(l); if (!s.online) continue; const k = "light:" + l.id; const st = alexaState.get(k) || { bri: 254 }; alexaState.set(k, { ...st, on: s.on }); }
  for (const sp of sonosLastRooms) { const k = "sonos:" + sp.uuid; const st = alexaState.get(k) || {}; alexaState.set(k, { ...st, on: sp.playing, bri: Math.max(1, Math.round(((sp.volume || 0) / 100) * 254)) }); }
}, 60000);
app.get("/api/alexa", async (req, res) => { if (!sonosLastRooms.length) await refreshSonosRooms(); res.json({ status: { ...alexaStatus, port: ALEXA_PORT, ip: alexaIp() }, devices: alexaDevices() }); });
app.post("/api/alexa", (req, res) => {
  const { key, name, enabled } = req.body || {};
  if (!key) return res.status(400).json({ error: "Missing device" });
  if (name !== undefined) { const n = cleanName(name); if (n) alexaCfg.names[key] = n; else delete alexaCfg.names[key]; }
  if (enabled !== undefined) { alexaCfg.off = alexaCfg.off.filter((k) => k !== key); if (!enabled) alexaCfg.off.push(key); }
  saveAlexa(); res.json({ ok: true });
});

startHttps();

app.listen(PORT, "0.0.0.0", async () => {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => i.address);
  console.log("\n  TV Control Hub is running");
  console.log(`  On this PC:  http://localhost:${PORT}`);
  ips.forEach((ip) => console.log(`  On your phone: http://${ip}:${PORT}`));
  console.log("\n  Keep this window open while you use the remote.\n");
  // warm up ADB connections so the first button press is fast
  for (const tv of tvs.filter((t) => t.type === "googletv" || t.type === "firetv")) adbEnsure(tv).catch(() => {});
});
