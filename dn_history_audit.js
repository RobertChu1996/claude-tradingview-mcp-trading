/**
 * DN 歷史稽核：用 dnbot01 金鑰查 OKX 真實歷史，確認那 6 筆「幽靈倉」當初是否成交、
 * 何時平倉、已實現損益多少，並列出帳戶餘額變動（印證用戶看到的本金波動）。
 * 需環境變數 OKX_API_KEY/OKX_SECRET_KEY/OKX_PASSPHRASE（workflow 傳入 OKX_DN_*）。
 */
import crypto from "crypto";
const BASE = process.env.OKX_BASE_URL || "https://www.okx.com";

// 狀態檔裡的 6 筆（symbol / orderId / 記錄進場價 / 記錄進場時間）
const STATE = [
  { s: "BTCUSDT",  ord: "3863056425908899840", entry: 80486.1,  t: "2026-08-25T04:00" },
  { s: "GMXUSDT",  ord: "3876585746904584192", entry: 8.197,    t: "2026-08-29T20:00" },
  { s: "BNBUSDT",  ord: "3890597950469378048", entry: 727.8,    t: "2026-09-03T16:00" },
  { s: "NEARUSDT", ord: "3893980027231342592", entry: 2.167,    t: "2026-09-04T20:00" },
  { s: "DYDXUSDT", ord: "3972981137593536512", entry: 0.15295,  t: "2026-10-02T02:00" },
  { s: "AAVEUSDT", ord: "3973222416675966976", entry: 176.64,   t: "2026-10-02T04:00" },
];

let _off = 0;
async function initTime() { try { const r = await fetch(`${BASE}/api/v5/public/time`); const d = await r.json(); if (d.data?.[0]?.ts) _off = parseInt(d.data[0].ts) - Date.now(); } catch {} }
function sign(ts, m, p, b = "") { return crypto.createHmac("sha256", process.env.OKX_SECRET_KEY).update(`${ts}${m}${p}${b}`).digest("base64"); }
async function get(path) {
  const ts = new Date(Date.now() + _off).toISOString();
  const r = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(20000), headers: {
    "OK-ACCESS-KEY": process.env.OKX_API_KEY, "OK-ACCESS-SIGN": sign(ts, "GET", path),
    "OK-ACCESS-TIMESTAMP": ts, "OK-ACCESS-PASSPHRASE": process.env.OKX_PASSPHRASE } });
  return r.json();
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function pages(base, key = "billId", max = 20) {
  const out = []; let after = "";
  for (let i = 0; i < max; i++) {
    const d = await get(`${base}${after ? `&after=${after}` : ""}`);
    if (d.code !== "0") { console.log(`  查詢失敗 ${base}: ${d.code} ${d.msg}`); break; }
    const b = d.data || []; if (!b.length) break;
    out.push(...b); after = b[b.length - 1][key]; await sleep(200);
  }
  return out;
}
const iso = ms => ms ? new Date(+ms).toISOString().slice(0, 16).replace("T", " ") : "—";
const instOf = s => s.replace("USDT", "-USDT-SWAP");

async function main() {
  await initTime();
  console.log("═".repeat(72));
  console.log("DN (dnbot01) 歷史稽核");
  console.log("═".repeat(72));

  // 1. 餘額
  const bal = await get("/api/v5/account/balance");
  const usdt = bal.data?.[0]?.details?.find(d => d.ccy === "USDT");
  console.log(`\n【當前餘額】USDT 權益 $${usdt ? parseFloat(usdt.eq).toFixed(4) : "N/A"} | 可用 $${usdt ? parseFloat(usdt.availBal).toFixed(4) : "N/A"}`);

  // 2. 當前持倉
  const pos = await get("/api/v5/account/positions?instType=SWAP");
  const live = (pos.data || []).filter(p => parseFloat(p.pos) !== 0);
  const realInst = new Set(live.map(p => p.instId));
  console.log(`【當前持倉】${live.length} 筆` + (live.length ? ": " + live.map(p => `${p.instId}(${p.pos})`).join(", ") : "（空）"));

  // 2b. 當前 pending OCO 委託（檢查孤兒）
  const algo = await get("/api/v5/trade/orders-algo-pending?instType=SWAP&ordType=oco");
  const algos = algo.data || [];
  const orphanAlgos = algos.filter(a => !realInst.has(a.instId));
  console.log(`【當前 pending OCO 委託】${algos.length} 筆` + (algos.length ? ": " + algos.map(a => `${a.instId}${realInst.has(a.instId) ? "✅有持倉" : "⚠️孤兒"}`).join(", ") : "（無）"));
  console.log(`  → 孤兒委託（無對應持倉）: ${orphanAlgos.length} 筆` + (orphanAlgos.length ? " ⚠️ " + orphanAlgos.map(a => a.instId).join(", ") : " ✅ 無"));

  // 3. 歷史平倉（positions-history）＝ 真正成交並平掉的倉，含已實現損益
  const ph = await pages("/api/v5/account/positions-history?instType=SWAP&limit=100", "posId");
  console.log(`\n【歷史平倉 positions-history】共 ${ph.length} 筆`);
  console.log("  開倉時間          平倉時間          幣種           方向   開均價       平均價       已實現PnL   類型");
  let realized = 0;
  const bySym = {};
  for (const p of ph.sort((a, b) => +a.cTime - +b.cTime)) {
    const rp = parseFloat(p.realizedPnl || p.pnl || 0); realized += rp;
    (bySym[p.instId] ??= []).push(p);
    console.log(`  ${iso(p.cTime)}  ${iso(p.uTime)}  ${p.instId.padEnd(14)} ${(p.direction||p.posSide||"").padEnd(5)}  ${String(p.openAvgPx).padEnd(11)}  ${String(p.closeAvgPx).padEnd(11)}  ${rp.toFixed(4).padStart(9)}  ${p.type}`);
  }
  console.log(`  ─────────────────────────────────────────────────────────────`);
  console.log(`  已實現損益合計: $${realized.toFixed(4)}（${ph.length} 筆平倉）`);

  // 4. 比對狀態檔那 6 筆：用 fills-history 確認 orderId 是否成交
  const fills = await pages("/api/v5/trade/fills-history?instType=SWAP&limit=100", "billId");
  const fillByOrd = {};
  for (const f of fills) { const o = (fillByOrd[f.ordId] ??= { px: 0, sz: 0, t: 0 }); o.px += parseFloat(f.fillPx) * parseFloat(f.fillSz); o.sz += parseFloat(f.fillSz); o.t = f.ts || f.fillTime; }
  console.log(`\n【狀態檔 6 筆 vs 實際成交】（fills-history 近3個月 ${fills.length} 筆成交）`);
  console.log("  幣種           記錄進場     orderId 是否成交        實際均價      對應歷史平倉");
  for (const st of STATE) {
    const f = fillByOrd[st.ord];
    const closed = (bySym[instOf(st.s)] || []);
    const closedInfo = closed.length ? closed.map(c => `平@${iso(c.uTime)} PnL$${parseFloat(c.realizedPnl||c.pnl||0).toFixed(2)}`).join(" / ") : "（歷史無平倉紀錄）";
    const fillInfo = f ? `✅成交 均價${(f.px / f.sz).toPrecision(6)}` : "❌無成交紀錄(>3月或未成交)";
    console.log(`  ${st.s.padEnd(14)} ${String(st.entry).padEnd(11)} ${fillInfo.padEnd(22)} ${closedInfo}`);
  }

  // 5. 帳戶餘額變動（bills-archive 全類型）＝ 印證本金波動
  const bills = await pages("/api/v5/account/bills-archive?instType=SWAP&limit=100", "billId");
  const byType = {};
  const TYPE = { "1":"劃轉","2":"交易","5":"資金費","8":"資金費","3":"交割","4":"強平","6":"保證金劃轉","7":"手續費回扣","12":"折算","13":"強減" };
  let net = 0;
  for (const b of bills) { const v = parseFloat(b.balChg || b.pnl || 0); net += v; const t = TYPE[b.type] || `type${b.type}`; (byType[t] ??= { n: 0, v: 0 }); byType[t].n++; byType[t].v += v; }
  console.log(`\n【帳戶流水 bills-archive】近3個月 ${bills.length} 筆，淨變動 $${net.toFixed(4)}`);
  for (const [k, v] of Object.entries(byType).sort((a, b) => a[1].v - b[1].v)) console.log(`  ${k.padEnd(8)} ${String(v.n).padStart(4)} 筆  $${v.v.toFixed(4)}`);

  console.log("\n" + "═".repeat(72));
  console.log(`結論數據：歷史平倉 ${ph.length} 筆、已實現 $${realized.toFixed(2)}；當前持倉 ${live.length} 筆、權益 $${usdt ? parseFloat(usdt.eq).toFixed(2) : "?"}`);
  console.log("═".repeat(72));
}
main().catch(e => { console.error("稽核錯誤:", e); process.exit(1); });
