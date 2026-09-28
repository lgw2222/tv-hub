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
];

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
function vegaRaw(tv, method, pathQ, body, scheme, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const lib = scheme === "http" ? http : https;
    const data = body == null ? null : JSON.stringify(body);
    const headers = { "X-Api-Key": VEGA_KEY, "Content-Type": "application/json; charset=utf-8", "User-Agent": "okhttp/4.10.0" };
    if (tv.vegaToken) headers["X-Client-Token"] = tv.vegaToken;
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
async function vegaReq(tv, method, pathQ, body) {
  const order = tv.vegaScheme ? [tv.vegaScheme, tv.vegaScheme === "https" ? "http" : "https"] : ["https", "http"];
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const scheme of order) {
      try {
        const r = await vegaRaw(tv, method, pathQ, body, scheme);
        if (r.status === 401 || r.status === 403) throw Object.assign(new Error(`${tv.name} needs to be paired again. Open Manage TVs and tap Pair.`), { fatal: true });
        if (r.status >= 400) throw Object.assign(new Error(`${tv.name} returned ${r.status}${r.body ? ": " + r.body.slice(0, 120) : ""}`), { fatal: true });
        if (tv.vegaScheme !== scheme) { tv.vegaScheme = scheme; saveTvs(tvs); }
        return r.body;
      } catch (e) { if (e.fatal) throw e; lastErr = e; }
    }
    await vegaWake(tv); // remote service may be asleep; wake it and retry once
    await new Promise((r) => setTimeout(r, 1200));
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
    if (/^(volup|voldown|mute)$/.test(cmd)) throw new Error(`Volume isn't available on ${tv.name} over Wi-Fi. Use the TV's own remote for volume.`);
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
  const names = { poweron: ["PowerOn", "On"], poweroff: ["PowerOff", "Off"], power: ["PowerToggle", "Power"] }[want] || [want];
  for (const n of names) { const c = dev.commands.find((x) => x.name.toLowerCase() === n.toLowerCase()); if (c) return c; }
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
  if (!c) throw new Error(`${dev.label} has no power command in Harmony.`);
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
    ids = new Set([...xml.matchAll(/<app id="(\d+)"/g)].map((m) => m[1]));
  } else {
    const out = await adbShell(tv, "pm", "list", "packages");
    ids = new Set(out.split("\n").map((l) => l.replace("package:", "").trim()).filter(Boolean));
  }
  appCache.set(tv.id, { at: Date.now(), ids });
  return ids;
}

async function availableApps(tv) {
  if (tv.type === "vega") return APPS.filter((a) => a.fire || /netflix|disney|max|peacock|paramount|espn|spotify|plex|pluto|youtubetv/.test(a.key)).map((a) => a.key);
  const ids = await installedIds(tv);
  return APPS.filter((a) => (tv.type === "roku" ? a.roku : pkgsFor(tv, a)).some((id) => ids.has(id))).map((a) => a.key);
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
  const list = tv.type === "roku" ? entry.roku : pkgsFor(tv, entry);
  const id = list.find((x) => ids.has(x)) || list[0];
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

// Vega pairing: step 1 shows a PIN on the TV, step 2 sends it back and stores the token
app.post("/api/tvs/:id/vega/pin", wrap(async (req, res) => {
  const tv = findTv(req.params.id);
  if (!tv || tv.type !== "vega") return res.status(400).json({ error: "Pairing is only for Fire TV (Vega)" });
  delete tv.vegaToken;
  await vegaWake(tv);
  await new Promise((r) => setTimeout(r, 800));
  await vegaReq(tv, "POST", "/v1/FireTV/pin/display", { friendlyName: "TV Remote Hub" });
  res.json({ ok: true });
}));
app.post("/api/tvs/:id/vega/verify", wrap(async (req, res) => {
  const tv = findTv(req.params.id);
  const pin = String((req.body || {}).pin || "").trim();
  if (!tv || tv.type !== "vega" || !pin) return res.status(400).json({ error: "Enter the PIN shown on the TV." });
  const body = await vegaReq(tv, "POST", "/v1/FireTV/pin/verify", { pin });
  let token; try { token = JSON.parse(body).description; } catch {}
  if (!token) throw new Error("The TV didn't accept that PIN. Tap Pair to get a new one.");
  tv.vegaToken = token; saveTvs(tvs);
  res.json({ ok: true });
}));

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
  plex: ["plex"], pluto: ["pluto", "pluto tv"],
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
