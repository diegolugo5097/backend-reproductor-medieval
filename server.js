import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";
import http from "http";

/* ============================================================
   CAFÉ MEDIEVAL · Backend
   - Cola de canciones compartida en memoria
   - Búsqueda en YouTube (YouTube Data API v3)
   - WebSocket: avisa a TODAS las apps cuando la cola cambia
   ============================================================ */

// 👉 PEGA AQUÍ TU API KEY de YouTube Data API v3
//    (Google Cloud Console → APIs → YouTube Data API v3 → Credenciales)
//    También puedes ponerla como variable de entorno: YOUTUBE_API_KEY
const YOUTUBE_API_KEY =
  process.env.YOUTUBE_API_KEY || "AIzaSyBeW9mvJpXMzuOfL797fTwU3LJSIcv0uDg";

const PORT = process.env.PORT || 4000;

/* ---------------- Usuario administrador ----------------
   EN PRODUCCIÓN (Render): define ADMIN_USER y ADMIN_PASS como
   variables de entorno en el panel de Render. NO uses los valores
   por defecto de abajo en producción: son solo para pruebas locales. */
const ADMIN_USER = process.env.ADMIN_USER || "medievalAlfonso";
const ADMIN_PASS = process.env.ADMIN_PASS || "cafeMedievalAlfonso";

// Token de sesión válido (en memoria). Cada login genera uno nuevo.
const adminTokens = new Set();

function makeToken() {
  return (
    Math.random().toString(36).slice(2) +
    Math.random().toString(36).slice(2) +
    Date.now().toString(36)
  );
}

// Middleware: protege rutas de admin. El cliente manda el token
// en la cabecera "x-admin-token".
function requireAdmin(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (token && adminTokens.has(token)) return next();
  return res
    .status(401)
    .json({ error: "No autorizado. Inicia sesión como administrador." });
}

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/* ---------------- Estado en memoria ---------------- */
let queue = []; // canciones en espera: [{ id, videoId, title, channel, thumbnail, addedBy, addedAt }]
let nowPlaying = null; // canción reproduciéndose actualmente
let history = []; // canciones ya reproducidas (máx 50)
let paused = false; // estado de pausa (controlado por el admin)

function snapshot() {
  return {
    type: "state",
    nowPlaying,
    queue,
    paused,
    history: history.slice(0, 20),
  };
}

function broadcast() {
  const msg = JSON.stringify(snapshot());
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(msg);
  });
}

wss.on("connection", (ws) => {
  // Al conectar, mandamos el estado actual
  ws.send(JSON.stringify(snapshot()));
});

/* ---------------- Caché de búsquedas ----------------
   Guarda resultados por término para no gastar cuota de YouTube
   en búsquedas repetidas. Cada entrada vive CACHE_TTL ms. */
const searchCache = new Map(); // q (en minúsculas) -> { items, expires }
const CACHE_TTL = 12 * 60 * 60 * 1000; // 12 horas
const CACHE_MAX = 500; // máximo de términos guardados

function cacheGet(key) {
  const hit = searchCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    searchCache.delete(key);
    return null;
  }
  return hit.items;
}

function cacheSet(key, items) {
  if (searchCache.size >= CACHE_MAX) {
    const oldest = searchCache.keys().next().value;
    searchCache.delete(oldest);
  }
  searchCache.set(key, { items, expires: Date.now() + CACHE_TTL });
}

/* ---------------- Búsqueda en YouTube ---------------- */
app.get("/api/search", async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.json({ items: [] });

  if (YOUTUBE_API_KEY === "TU_API_KEY_AQUI") {
    return res.status(500).json({
      error:
        "Falta la API KEY de YouTube. Edita backend/server.js y pon tu clave.",
    });
  }

  // 1) ¿Está en caché? → no gastamos cuota
  const cacheKey = q.toLowerCase();
  const cached = cacheGet(cacheKey);
  if (cached) {
    return res.json({ items: cached, cached: true });
  }

  try {
    const url =
      "https://www.googleapis.com/youtube/v3/search?" +
      new URLSearchParams({
        part: "snippet",
        type: "video",
        videoEmbeddable: "true",
        maxResults: "10",
        q,
        key: YOUTUBE_API_KEY,
      });

    const r = await fetch(url);
    const data = await r.json();

    if (data.error) {
      return res.status(400).json({ error: data.error.message });
    }

    const items = (data.items || []).map((it) => ({
      videoId: it.id.videoId,
      title: decodeHtml(it.snippet.title),
      channel: decodeHtml(it.snippet.channelTitle),
      thumbnail:
        it.snippet.thumbnails?.medium?.url ||
        it.snippet.thumbnails?.default?.url,
    }));

    cacheSet(cacheKey, items); // guardar para futuras búsquedas iguales
    res.json({ items, cached: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al buscar en YouTube." });
  }
});

function decodeHtml(s = "") {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/* ---------------- Login de administrador ---------------- */
app.post("/api/login", (req, res) => {
  const { user, pass } = req.body || {};
  if (user === ADMIN_USER && pass === ADMIN_PASS) {
    const token = makeToken();
    adminTokens.add(token);
    return res.json({ ok: true, token });
  }
  return res.status(401).json({ error: "Usuario o contraseña incorrectos." });
});

app.post("/api/logout", (req, res) => {
  const token = req.headers["x-admin-token"];
  if (token) adminTokens.delete(token);
  res.json({ ok: true });
});

// Verifica si un token sigue siendo válido (al recargar la página)
app.get("/api/verify", (req, res) => {
  const token = req.headers["x-admin-token"];
  res.json({ valid: !!(token && adminTokens.has(token)) });
});

/* ---------------- Estado actual (REST) ---------------- */
app.get("/api/state", (_req, res) => res.json(snapshot()));

/* ---------------- Agregar a la cola ---------------- */
app.post("/api/queue", (req, res) => {
  const { videoId, title, channel, thumbnail, addedBy } = req.body || {};
  if (!videoId || !title)
    return res.status(400).json({ error: "Faltan datos de la canción." });

  const song = {
    id: cryptoId(),
    videoId,
    title,
    channel: channel || "",
    thumbnail: thumbnail || "",
    addedBy: (addedBy || "Anónimo").slice(0, 30),
    addedAt: Date.now(),
  };

  queue.push(song);

  // Si no hay nada sonando, esta arranca directo
  if (!nowPlaying) {
    nowPlaying = queue.shift();
  }

  broadcast();
  res.json({ ok: true, song });
});

/* ---------------- Quitar de la cola (admin) ---------------- */
app.delete("/api/queue/:id", requireAdmin, (req, res) => {
  queue = queue.filter((s) => s.id !== req.params.id);
  broadcast();
  res.json({ ok: true });
});

/* ---------------- Pasar a la siguiente (la usa el reproductor) ---------------- */
app.post("/api/next", (_req, res) => {
  if (nowPlaying) history.unshift(nowPlaying);
  history = history.slice(0, 50);
  nowPlaying = queue.shift() || null;
  paused = false; // al cambiar de canción siempre arranca sonando
  broadcast();
  res.json({ ok: true, nowPlaying });
});

/* ---------------- Pausar / reanudar (admin) ---------------- */
app.post("/api/pause", requireAdmin, (_req, res) => {
  paused = true;
  broadcast();
  res.json({ ok: true, paused });
});

app.post("/api/play", requireAdmin, (_req, res) => {
  paused = false;
  broadcast();
  res.json({ ok: true, paused });
});

app.post("/api/toggle-pause", requireAdmin, (_req, res) => {
  paused = !paused;
  broadcast();
  res.json({ ok: true, paused });
});

/* ---------------- Saltar / borrar todo (admin) ---------------- */
app.post("/api/skip", requireAdmin, (_req, res) => {
  if (nowPlaying) history.unshift(nowPlaying);
  history = history.slice(0, 50);
  nowPlaying = queue.shift() || null;
  paused = false;
  broadcast();
  res.json({ ok: true, nowPlaying });
});

app.post("/api/clear", requireAdmin, (_req, res) => {
  queue = [];
  broadcast();
  res.json({ ok: true });
});

function cryptoId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

server.listen(PORT, () => {
  console.log(
    `\n🏰 Café Medieval backend escuchando en http://localhost:${PORT}`,
  );
  console.log(`   WebSocket en ws://localhost:${PORT}`);
  console.log(
    `   👤 Admin → usuario: "${ADMIN_USER}"  contraseña: "${ADMIN_PASS}"`,
  );
  if (YOUTUBE_API_KEY === "TU_API_KEY_AQUI") {
    console.log("\n⚠️  Recuerda pegar tu YOUTUBE_API_KEY en server.js\n");
  }
});
