// Pixel IA : serveur gratuit (Cloudflare Worker) qui garde la clé Gemini secrète.
// La clé est stockée dans le secret GEMINI_API_KEY de Cloudflare, jamais dans GitHub.

const ALLOWED = "https://erwan4829-design.github.io"; // ton site GitHub Pages
const DEFAULTS = {
  flash: ["gemini-3.6-flash", "gemini-2.5-flash-lite", "gemini-2.5-flash"],
  think: ["gemini-3.6-flash", "gemini-2.5-flash", "gemini-2.5-flash-lite"],
  pro: ["gemini-3.6-pro", "gemini-3.5-pro", "gemini-2.5-pro", "gemini-3.6-flash"],
};
const API = "https://generativelanguage.googleapis.com/v1beta";
let cache = null;

const json = (obj, status, cors) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...cors } });

async function listModels(key) {
  if (cache && Date.now() - cache.t < 3600e3) return cache.v;
  try {
    const r = await fetch(API + "/models?pageSize=200", { headers: { "x-goog-api-key": key } });
    const j = await r.json();
    if (!r.ok) return [];
    const v = (j.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent") && /^models\/gemini-/.test(m.name) &&
        !/preview|exp|image|tts|live|audio|embed|vision|robotics|computer|thinking|customtools|learnlm|latest|-0\d\d/i.test(m.name))
      .map((m) => ({ n: m.name.replace("models/", ""), v: parseFloat((m.name.match(/gemini-(\d+(?:\.\d+)?)/) || [0, 0])[1]) }));
    cache = { t: Date.now(), v };
    return v;
  } catch (e) { return []; }
}

function chain(list, k) {
  const pick = (re, ex) => list.filter((x) => re.test(x.n) && !(ex && ex.test(x.n))).sort((a, b) => b.v - a.v).map((x) => x.n);
  const lite = pick(/flash-lite/), fl = pick(/flash/, /lite/), pr = pick(/pro/);
  const c = k === "flash" ? lite.concat(fl) : k === "think" ? fl.concat(lite) : pr.concat(fl, lite);
  const u = c.filter((v, i, a) => a.indexOf(v) === i).slice(0, 4);
  return u.length ? u : DEFAULTS[k];
}

export default {
  async fetch(req, env) {
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      Vary: "Origin",
    };
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (req.method !== "POST") return json({ error: "Méthode non autorisée" }, 405, cors);
    if (req.headers.get("Origin") !== ALLOWED) return json({ error: "Origine refusée" }, 403, cors);
    if (!env.GEMINI_API_KEY) return json({ error: "Clé GEMINI_API_KEY absente sur le serveur" }, 500, cors);

    let body;
    try { body = await req.json(); } catch (e) { return json({ error: "Requête invalide" }, 400, cors); }
    const k = DEFAULTS[body.model] ? body.model : "flash";
    const msgs = Array.isArray(body.messages) ? body.messages.slice(-20) : [];
    if (!msgs.length) return json({ error: "Aucun message" }, 400, cors);

    let system = "";
    const contents = msgs.map((m, i) => {
      let t = String(m.content || "").slice(0, 8000);
      if (i === 0) {
        const mt = t.match(/^\[Consignes : ([\s\S]*?)\]\n\n/);
        if (mt) { system = mt[1]; t = t.slice(mt[0].length); }
      }
      return { role: m.role === "user" ? "user" : "model", parts: [{ text: t }] };
    });
    const payload = { contents };
    if (system) payload.systemInstruction = { parts: [{ text: system }] };

    const models = chain(await listModels(env.GEMINI_API_KEY), k);
    let err = "erreur inconnue", status = 502;
    for (const m of models) {
      try {
        const r = await fetch(`${API}/models/${m}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
          body: JSON.stringify(payload),
        });
        const j = await r.json();
        if (!r.ok) { err = (j.error && j.error.message) || "HTTP " + r.status; status = r.status === 429 ? 429 : 502; continue; }
        const text = ((j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [])
          .map((p) => p.text || "").join("");
        if (text) return json({ text }, 200, cors);
        err = "réponse vide";
      } catch (e) { err = String(e.message || e); }
    }
    return json({ error: err }, status, cors);
  },
};
