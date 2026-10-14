// server.js — 6TV Control Hub backend
// Run with: node server.js
// Then open http://localhost:3000 in your browser
// Or open http://YOUR-PC-IP:3000 from your phone on the same Wi-Fi

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const roku = require("./roku");
const firetv = require("./firetv");

const app = express();
const PORT = 3000;
const TVS_FILE = path.join(__dirname, "tvs.json");

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadTVs() {
  try {
    const raw = fs.readFileSync(TVS_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function saveTVs(tvs) {
  fs.writeFileSync(TVS_FILE, JSON.stringify(tvs, null, 2), "utf8");
}

function findTV(id) {
  const tvs = loadTVs();
  return tvs.find((t) => t.id === id);
}

function respond(res, promise) {
  promise
    .then((result) => res.json({ success: true, ...result }))
    .catch((err) => res.status(500).json({ success: false, error: err.message }));
}

// ── TV Config Routes ──────────────────────────────────────────────────────────

// GET /api/tvs — list all TVs
app.get("/api/tvs", (req, res) => {
  res.json(loadTVs());
});

// POST /api/tvs — add a new TV
app.post("/api/tvs", (req, res) => {
  const { name, ip, type } = req.body;

  if (!name || !ip || !type) {
    return res.status(400).json({ success: false, error: "name, ip, and type are required" });
  }

  if (!["roku", "firetv"].includes(type)) {
    return res.status(400).json({ success: false, error: 'type must be "roku" or "firetv"' });
  }

  const tvs = loadTVs();
  const id = "tv" + Date.now();
  tvs.push({ id, name, ip, type });
  saveTVs(tvs);

  res.json({ success: true, id, message: `Added "${name}"` });
});

// PUT /api/tvs/:id — update a TV
app.put("/api/tvs/:id", (req, res) => {
  const { name, ip, type } = req.body;
  const tvs = loadTVs();
  const idx = tvs.findIndex((t) => t.id === req.params.id);

  if (idx === -1) {
    return res.status(404).json({ success: false, error: "TV not found" });
  }

  if (type && !["roku", "firetv"].includes(type)) {
    return res.status(400).json({ success: false, error: 'type must be "roku" or "firetv"' });
  }

  tvs[idx] = { ...tvs[idx], ...(name && { name }), ...(ip && { ip }), ...(type && { type }) };
  saveTVs(tvs);

  res.json({ success: true, message: `Updated "${tvs[idx].name}"` });
});

// DELETE /api/tvs/:id — remove a TV
app.delete("/api/tvs/:id", (req, res) => {
  const tvs = loadTVs();
  const filtered = tvs.filter((t) => t.id !== req.params.id);

  if (filtered.length === tvs.length) {
    return res.status(404).json({ success: false, error: "TV not found" });
  }

  saveTVs(filtered);
  res.json({ success: true, message: "TV removed" });
});

// ── Control Routes ────────────────────────────────────────────────────────────

// POST /api/control/:id/:command — send a command to one TV
app.post("/api/control/:id/:command", (req, res) => {
  const tv = findTV(req.params.id);
  const command = req.params.command.toLowerCase();

  if (!tv) {
    return res.status(404).json({ success: false, error: "TV not found" });
  }

  if (tv.type === "roku") {
    respond(res, roku.sendKey(tv.ip, command));
  } else if (tv.type === "firetv") {
    respond(res, firetv.sendKey(tv.ip, command));
  } else {
    res.status(400).json({ success: false, error: `Unknown device type: ${tv.type}` });
  }
});

// POST /api/youtube/:id — open YouTube on one TV
app.post("/api/youtube/:id", (req, res) => {
  const tv = findTV(req.params.id);

  if (!tv) {
    return res.status(404).json({ success: false, error: "TV not found" });
  }

  if (tv.type === "roku") {
    respond(res, roku.openYouTube(tv.ip));
  } else if (tv.type === "firetv") {
    respond(res, firetv.openYouTube(tv.ip));
  } else {
    res.status(400).json({ success: false, error: `Unknown device type: ${tv.type}` });
  }
});

// POST /api/ping/:id — test if a TV is reachable
app.post("/api/ping/:id", (req, res) => {
  const tv = findTV(req.params.id);

  if (!tv) {
    return res.status(404).json({ success: false, error: "TV not found" });
  }

  const pingFn = tv.type === "roku" ? roku.ping : firetv.ping;
  pingFn(tv.ip)
    .then((result) => res.json({ ...result, tv: tv.name }))
    .catch(() => res.json({ online: false, tv: tv.name }));
});

// ── Group Action Routes ───────────────────────────────────────────────────────

// POST /api/group/:command — send a command to ALL TVs
app.post("/api/group/:command", async (req, res) => {
  const command = req.params.command.toLowerCase();
  const tvs = loadTVs();

  const results = await Promise.allSettled(
    tvs.map(async (tv) => {
      try {
        let result;
        if (tv.type === "roku") {
          result = await roku.sendKey(tv.ip, command);
        } else {
          result = await firetv.sendKey(tv.ip, command);
        }
        return { id: tv.id, name: tv.name, success: true, message: result.message };
      } catch (err) {
        return { id: tv.id, name: tv.name, success: false, error: err.message };
      }
    })
  );

  const summary = results.map((r) => r.value || r.reason);
  res.json({ command, results: summary });
});

// POST /api/group/youtube — open YouTube on a list of selected TVs
app.post("/api/group/youtube", async (req, res) => {
  const { ids } = req.body; // array of TV ids
  const tvs = loadTVs().filter((t) => ids.includes(t.id));

  if (tvs.length === 0) {
    return res.status(400).json({ success: false, error: "No valid TV IDs provided" });
  }

  const results = await Promise.allSettled(
    tvs.map(async (tv) => {
      try {
        const fn = tv.type === "roku" ? roku.openYouTube : firetv.openYouTube;
        const result = await fn(tv.ip);
        return { id: tv.id, name: tv.name, success: true, message: result.message };
      } catch (err) {
        return { id: tv.id, name: tv.name, success: false, error: err.message };
      }
    })
  );

  res.json({ results: results.map((r) => r.value || r.reason) });
});

// ── Start Server ──────────────────────────────────────────────────────────────

app.listen(PORT, "0.0.0.0", () => {
  console.log("╔════════════════════════════════════════════╗");
  console.log("║        6TV Control Hub is running!        ║");
  console.log("╠════════════════════════════════════════════╣");
  console.log(`║  Local:   http://localhost:${PORT}           ║`);
  console.log(`║  Phone:   http://<YOUR-PC-IP>:${PORT}        ║`);
  console.log("║  (Find your PC IP: run 'ipconfig' or      ║");
  console.log("║   'ip a' and look for 192.168.x.x)        ║");
  console.log("╚════════════════════════════════════════════╝");
});
