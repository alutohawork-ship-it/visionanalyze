// api/analyze.js — Vercel Serverless Function
// Env var wajib: OPENAI_API_KEY. Opsional: OPENAI_MODEL (default gpt-4o)

const MODES = {
  scalping: { label: "Scalping",    htf: "M15", ltf: "M1" },
  daytrade: { label: "Day Trading", htf: "M30", ltf: "M3" },
  intraday: { label: "Intraday",    htf: "H1",  ltf: "M5" },
  swing:    { label: "Swing",       htf: "H4",  ltf: "M15" },
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
- reason_entry: 2 sampai 5 poin singkat, sebutkan bukti dari chart (sweep, CHoCH, FVG, bias).
- Semua teks dalam Bahasa Indonesia. Balas hanya dengan JSON sesuai skema.`;

const num = { anyOf: [{ type: "number" }, { type: "null" }] };

const SCHEMA = {
  name: "trade_signal",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["signal", "confidence", "bias", "entry", "stop_loss", "tp1", "tp2", "tp3",
      "reason_entry", "invalidation", "summary", "key_levels"],
    properties: {
      signal: { type: "string", enum: ["BUY", "SELL", "NO_TRADE"] },
      confidence: { type: "integer" },
      bias: { type: "string", enum: ["BULLISH", "BEARISH", "RANGE"] },
      entry: num,
      stop_loss: num,
      tp1: num,
      tp2: num,
      tp3: num,
      reason_entry: { type: "array", items: { type: "string" } },
      invalidation: { type: "string" },
      summary: { type: "string" },
      key_levels: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["label", "price", "kind"],
          properties: {
            label: { type: "string" },
            price: { type: "number" },
            kind: { type: "string", enum: ["support", "resistance", "liquidity", "fvg", "order_block"] },
          },
        },
      },
    },
  },
};

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

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4o",
        temperature: 0,
        max_tokens: 1500,
        response_format: { type: "json_schema", json_schema: SCHEMA },
        messages: [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: [
              { type: "text", text: `Pair: ${symbol}. Mode: ${m.label}. Gambar 1 = HTF ${m.htf}, gambar 2 = LTF ${m.ltf}.` },
              ...images.map(url => ({ type: "image_url", image_url: { url, detail: "high" } })),
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(55000),
    });

    const data = await r.json();
    if (!r.ok) return res.status(502).json({ error: data.error?.message || "Permintaan ke OpenAI gagal." });

    const out = JSON.parse(data.choices[0].message.content);
    return res.status(200).json(finalize(out));
  } catch (e) {
    const msg = e.name === "TimeoutError"
      ? "Analisa terlalu lama. Coba gambar yang lebih kecil."
      : "Terjadi kesalahan di server.";
    return res.status(500).json({ error: msg });
  }
};
