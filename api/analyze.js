// api/analyze.js — Vercel Serverless Function
// Env wajib:    OPENAI_API_KEY   (key sk-guts-... dari gutsai.id/console)
// Env opsional: OPENAI_BASE_URL  (default https://api.gutsai.id/v1)
//               OPENAI_MODEL     (default claude-sonnet-5.5, harus bisa menerima gambar)

const DEFAULT_BASE = "https://api.gutsai.id/v1";
const DEFAULT_MODEL = "claude-sonnet-5.5";

const MODES = {
  scalping: { label: "Scalping",    htf: "M15", ltf: "M1" },
  daytrade: { label: "Day Trading", htf: "M30", ltf: "M3" },
  intraday: { label: "Intraday",    htf: "H1",  ltf: "M5" },
  swing:    { label: "Swing",       htf: "H4",  ltf: "M15" },
};

const HINTS = {
  401: "API key tidak valid. Cek OPENAI_API_KEY di Vercel.",
  402: "Saldo Guts AI habis. Top up dulu di gutsai.id/console.",
  403: "Model ini tidak bisa dipakai dengan key kamu. Coba ganti OPENAI_MODEL.",
  404: "Model tidak ditemukan. Cek OPENAI_MODEL.",
  429: "Terlalu banyak permintaan. Coba lagi sebentar.",
};

const SYSTEM = `Kamu analis trading profesional (Smart Money Concepts, price action, supply & demand, likuiditas).
Kamu menerima screenshot chart. Gambar pertama = HTF (penentu bias), gambar kedua = LTF (penentu entry).

Alur analisa:
1. HTF: tentukan bias dari struktur (HH/HL = bullish, LH/LL = bearish), area supply/demand, dan likuiditas terdekat.
2. LTF: tunggu urutan konfirmasi liquidity sweep -> CHoCH (atau CISD) -> FVG/order block. Entry di zona FVG/OB setelah konfirmasi, searah bias HTF.
3. Jika urutan belum lengkap, atau bias HTF berlawanan tanpa konfirmasi jelas, signal = NO_TRADE.
4. Stop loss di luar sweep/swing terakhir dengan sedikit buffer.
5. TP1 di likuiditas/swing terdekat, TP2 dan TP3 di level berikutnya. TP1 minimal RR 1:1.5.

Aturan ketat:
- Baca harga HANYA dari skala harga yang terlihat di chart. Jangan mengarang angka. Jika skala tidak terbaca, signal = NO_TRADE dan jelaskan.
- BUY: SL < Entry < TP1 < TP2 < TP3. SELL: SL > Entry > TP1 > TP2 > TP3.
- Keputusan harus konsisten: chart yang sama harus menghasilkan keputusan yang sama.
- Semua teks dalam Bahasa Indonesia.

Balas HANYA dengan objek JSON berikut, tanpa teks atau markdown lain:
{
  "signal": "BUY | SELL | NO_TRADE",
  "confidence": <angka 0-100>,
  "bias": "BULLISH | BEARISH | RANGE",
  "entry": <angka harga atau null>,
  "stop_loss": <angka harga atau null>,
  "tp1": <angka harga atau null>,
  "tp2": <angka harga atau null>,
  "tp3": <angka harga atau null>,
  "reason_entry": ["2 sampai 5 poin singkat, sebut bukti dari chart"],
  "invalidation": "kondisi yang membatalkan setup",
  "summary": "ringkasan 1 sampai 2 kalimat",
  "key_levels": [{"label": "nama level", "price": <angka harga>, "kind": "support | resistance | liquidity | fvg | order_block"}]
}
Untuk NO_TRADE, isi entry, stop_loss, tp1, tp2, dan tp3 dengan null.`;

function parseJson(text) {
  return JSON.parse(String(text || "").replace(/```json|```/g, "").trim());
}

const num = v => (typeof v === "number" && Number.isFinite(v) ? v : null);

// Rapikan bentuk jawaban model agar selalu punya semua field.
function normalize(s) {
  return {
    signal: ["BUY", "SELL"].includes(s.signal) ? s.signal : "NO_TRADE",
    confidence: Math.max(0, Math.min(100, Math.round(Number(s.confidence) || 0))),
    bias: ["BULLISH", "BEARISH", "RANGE"].includes(s.bias) ? s.bias : "RANGE",
    entry: num(s.entry),
    stop_loss: num(s.stop_loss),
    tp1: num(s.tp1),
    tp2: num(s.tp2),
    tp3: num(s.tp3),
    reason_entry: Array.isArray(s.reason_entry) ? s.reason_entry.map(String).slice(0, 6) : [],
    invalidation: String(s.invalidation || ""),
    summary: String(s.summary || ""),
    key_levels: (Array.isArray(s.key_levels) ? s.key_levels : [])
      .filter(k => k && num(k.price) !== null)
      .slice(0, 12)
      .map(k => ({ label: String(k.label || ""), price: k.price, kind: String(k.kind || "") })),
  };
}

// Pastikan urutan level masuk akal. Jika tidak, sinyal dibatalkan.
function finalize(s) {
  if (s.signal !== "NO_TRADE") {
    const { entry: e, stop_loss: sl, tp1: t1, tp2: t2, tp3: t3 } = s;
    const valid = [e, sl, t1, t2, t3].every(Number.isFinite) && (s.signal === "BUY"
      ? sl < e && e < t1 && t1 < t2 && t2 < t3
      : sl > e && e > t1 && t1 > t2 && t2 > t3);
    if (valid) {
      const risk = Math.abs(e - sl);
      return { ...s, rr: [t1, t2, t3].map(t => +(Math.abs(t - e) / risk).toFixed(2)) };
    }
    s = { ...s, signal: "NO_TRADE",
      reason_entry: [...s.reason_entry, "Level harga dari analisa tidak konsisten, sinyal dibatalkan."] };
  }
  const cleared = { ...s, rr: null };
  for (const k of ["entry", "stop_loss", "tp1", "tp2", "tp3"]) cleared[k] = null;
  return cleared;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Gunakan POST." });
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: "OPENAI_API_KEY belum diisi di Environment Variables Vercel." });
  }

  const { pair = "", mode = "", images = [] } = req.body || {};
  const m = Object.hasOwn(MODES, mode) ? MODES[mode] : null;
  if (!m) return res.status(400).json({ error: "Mode tidak dikenal." });
  if (!Array.isArray(images) || images.length !== 2 ||
      !images.every(i => typeof i === "string" && /^data:image\/(jpeg|png|webp);base64,/.test(i) && i.length < 6_000_000)) {
    return res.status(400).json({ error: "Unggah dua chart: HTF dan LTF." });
  }

  const symbol = String(pair).toUpperCase().replace(/[^A-Z0-9._/-]/g, "").slice(0, 12) || "UNKNOWN";
  const base = (process.env.OPENAI_BASE_URL || DEFAULT_BASE).replace(/\/+$/, "");
  const model = process.env.OPENAI_MODEL || DEFAULT_MODEL;

  try {
    const r = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 1500,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: [
              { type: "text", text: `Pair: ${symbol}. Mode: ${m.label}. Gambar 1 = HTF ${m.htf}, gambar 2 = LTF ${m.ltf}.` },
              ...images.map(url => ({ type: "image_url", image_url: { url } })),
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(55000),
    });

    const raw = await r.text();
    if (!r.ok) {
      console.error("gateway error", r.status, raw.slice(0, 500));
      return res.status(502).json({ error: HINTS[r.status] || "Permintaan ke AI gagal. Coba lagi." });
    }

    let parsed;
    try {
      parsed = parseJson(JSON.parse(raw).choices?.[0]?.message?.content);
    } catch {
      console.error("bad model output", raw.slice(0, 500));
      return res.status(502).json({ error: "Jawaban AI tidak bisa dibaca. Coba analisa ulang." });
    }

    return res.status(200).json(finalize(normalize(parsed)));
  } catch (e) {
    console.error("analyze failed", e);
    const msg = e.name === "TimeoutError"
      ? "Analisa terlalu lama. Coba gambar yang lebih kecil."
      : "Terjadi kesalahan di server.";
    return res.status(500).json({ error: msg });
  }
};
