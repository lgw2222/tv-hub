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
const TYPES = ["roku", "googletv", "firetv"];

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

// ---------- device-agnostic actions ----------
async function sendKey(tv, cmd) {
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
  const ids = await installedIds(tv);
  return APPS.filter((a) => (tv.type === "roku" ? a.roku : pkgsFor(tv, a)).some((id) => ids.has(id))).map((a) => a.key);
}

async function launchApp(tv, key) {
  const entry = APPS.find((a) => a.key === key);
  if (!entry) throw new Error("Unknown app");
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
    if (tv.type === "roku") {
      const xml = await rokuReq(tv, "GET", "/query/device-info", 2500);
      const mode = xmlTag(xml, "power-mode") || "";
      return { online: true, awake: mode ? mode === "PowerOn" : true, model: xmlTag(xml, "model-name") };
    }
    const out = await adbShell(tv, "dumpsys", "power");
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

app.get("/api/tvs", (req, res) => res.json(tvs));

app.post("/api/tvs", (req, res) => {
  const { name, ip, type, adbPort } = req.body || {};
  if (!name || !ip || !TYPES.includes(type)) return res.status(400).json({ error: "Name, IP address and type are required." });
  const tv = { id: Date.now().toString(36), name: name.trim(), ip: ip.trim(), type };
  if (type !== "roku") tv.adbPort = Number(adbPort) || 5555;
  tvs.push(tv); saveTvs(tvs); res.json(tv);
});

app.put("/api/tvs/:id", (req, res) => {
  const tv = findTv(req.params.id);
  if (!tv) return res.status(404).json({ error: "TV not found" });
  const { name, ip, type, adbPort } = req.body || {};
  if (name) tv.name = name.trim();
  if (ip) tv.ip = ip.trim();
  if (type && TYPES.includes(type)) tv.type = type;
  if (tv.type !== "roku") tv.adbPort = Number(adbPort) || tv.adbPort || 5555; else delete tv.adbPort;
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

app.post("/api/tvs/:id/connect", wrap(async (req, res) => {
  const tv = findTv(req.params.id);
  if (!tv || tv.type === "roku") return res.status(400).json({ error: "Connect is only for Google TV and Fire TV" });
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

// ---------- start ----------
app.listen(PORT, "0.0.0.0", async () => {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => i.address);
  console.log("\n  TV Control Hub is running");
  console.log(`  On this PC:  http://localhost:${PORT}`);
  ips.forEach((ip) => console.log(`  On your phone: http://${ip}:${PORT}`));
  console.log("\n  Keep this window open while you use the remote.\n");
  // warm up ADB connections so the first button press is fast
  for (const tv of tvs.filter((t) => t.type !== "roku")) adbEnsure(tv).catch(() => {});
});
