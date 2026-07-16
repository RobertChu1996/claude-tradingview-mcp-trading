/**
 * 執行成本稽核：量化實盤與回測落差中「執行層」的部分
 *
 * 1. 滑價 — trades_dmc.csv 的 entry 是訊號價（4H 收盤），用 orderId 對 OKX
 *    fills-history 的實際成交均價，逐筆算滑價 bps（正 = 對我們不利）
 * 2. 手續費 — fills 的 fee 欄位加總（開倉側；平倉側用 bills 歸類）
 * 3. 資金費 — bills-archive type=8 加總（DMC 交易過的幣）
 *
 * 需要環境變數：OKX_API_KEY / OKX_SECRET_KEY / OKX_PASSPHRASE
 */
import { existsSync, readFileSync } from "fs";
import crypto from "crypto";

const D = process.env.DATA_DIR || ".";
const CSV_FILE = `${D}/trades_dmc.csv`;
const OKX_BASE = process.env.OKX_BASE_URL || "https://www.okx.com";

let _offset = 0;
async function initOkxTime() {
  try {
    const r = await fetch(`${OKX_BASE}/api/v5/public/time`);
    const d = await r.json();
    if (d.data?.[0]?.ts) _offset = parseInt(d.data[0].ts) - Date.now();
  } catch {}
}
function sign(ts, method, path) {
  return crypto.createHmac("sha256", process.env.OKX_SECRET_KEY)
    .update(`${ts}${method}${path}`).digest("base64");
}
async function okxGet(path) {
  const ts = new Date(Date.now() + _offset).toISOString();
  const res = await fetch(`${OKX_BASE}${path}`, {
    headers: {
      "OK-ACCESS-KEY":        process.env.OKX_API_KEY,
      "OK-ACCESS-SIGN":       sign(ts, "GET", path),
      "OK-ACCESS-TIMESTAMP":  ts,
      "OK-ACCESS-PASSPHRASE": process.env.OKX_PASSPHRASE,
    },
  });
  return res.json();
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchAllPages(basePath, key = "billId") {
  const out = [];
  let after = "";
  for (let page = 0; page < 30; page++) {
    const d = await okxGet(`${basePath}${after ? `&after=${after}` : ""}`);
    if (d.code !== "0") { console.error(`查詢失敗 ${basePath}:`, d.msg); break; }
    const batch = d.data || [];
    if (!batch.length) break;
    out.push(...batch);
    after = batch[batch.length - 1][key];
    await sleep(250);
  }
  return out;
}

async function main() {
  await initOkxTime();

  // ── CSV 開倉列（訊號價 + orderId）───────────────────────────────────────
  if (!existsSync(CSV_FILE)) { console.error("找不到 trades_dmc.csv"); process.exit(1); }
  let lines = readFileSync(CSV_FILE, "utf8").trim().split("\n").filter(Boolean);
  if (lines[0]?.startsWith("Date,")) lines = lines.slice(1);
  const opens = lines.map(l => l.split(","))
    .filter(p => p[7] === "開倉")
    .map(p => ({ date: p[0], symbol: p[2], side: p[3], sigPx: parseFloat(p[4]), ordId: p[9] }));
  console.log(`CSV 開倉筆數: ${opens.length}\n`);

  // ── 成交明細（3個月）────────────────────────────────────────────────────
  const fills = await fetchAllPages("/api/v5/trade/fills-history?instType=SWAP&limit=100");
  console.log(`OKX fills 共 ${fills.length} 筆`);

  // ordId → 成交彙總（均價、費用）
  const byOrd = {};
  for (const f of fills) {
    const o = byOrd[f.ordId] ??= { pxSz: 0, sz: 0, fee: 0, instId: f.instId };
    o.pxSz += parseFloat(f.fillPx) * parseFloat(f.fillSz);
    o.sz   += parseFloat(f.fillSz);
    o.fee  += parseFloat(f.fee);   // 負值 = 支出
  }

  // ── 逐筆滑價 ─────────────────────────────────────────────────────────────
  console.log("\n═══ 進場滑價（訊號價 vs 實際成交均價）═══");
  console.log("日期        幣種            方向   訊號價        成交均價      滑價bps   開倉費");
  let slipSum = 0, slipN = 0, entryFees = 0, worst = null;
  for (const o of opens) {
    const f = byOrd[o.ordId];
    if (!f || !f.sz) { console.log(`${o.date}  ${o.symbol.padEnd(14)} ${o.side.padEnd(5)}  ${String(o.sigPx).padEnd(12)}  無成交紀錄（>3個月或ID不符）`); continue; }
    const avgPx = f.pxSz / f.sz;
    // 正 = 不利：多單買貴、空單賣低
    const bps = (o.side === "long" ? (avgPx - o.sigPx) / o.sigPx : (o.sigPx - avgPx) / o.sigPx) * 10000;
    slipSum += bps; slipN++; entryFees += f.fee;
    if (!worst || bps > worst.bps) worst = { ...o, bps };
    console.log(`${o.date}  ${o.symbol.padEnd(14)} ${o.side.padEnd(5)}  ${String(o.sigPx).padEnd(12)}  ${avgPx.toPrecision(8).padEnd(12)}  ${bps.toFixed(1).padStart(7)}   $${f.fee.toFixed(4)}`);
  }
  if (slipN) {
    console.log(`\n平均進場滑價: ${(slipSum / slipN).toFixed(1)} bps（正=不利）｜最差: ${worst.symbol} ${worst.bps.toFixed(1)} bps`);
    console.log(`進場手續費合計: $${entryFees.toFixed(4)}`);
  }

  // ── 全部手續費（fills 口徑，含平倉側）────────────────────────────────────
  const totalFees = fills.reduce((s, f) => s + parseFloat(f.fee), 0);
  console.log(`\n═══ 手續費（fills 3個月全帳戶 SWAP）═══`);
  console.log(`合計: $${totalFees.toFixed(4)}（${fills.length} 筆成交）`);

  // ── 資金費（bills-archive type=8）────────────────────────────────────────
  const bills = await fetchAllPages("/api/v5/account/bills-archive?instType=SWAP&type=8&limit=100");
  const fundBySym = {};
  let fundTotal = 0;
  for (const b of bills) {
    const v = parseFloat(b.pnl || b.balChg || 0);
    fundBySym[b.instId] = (fundBySym[b.instId] || 0) + v;
    fundTotal += v;
  }
  console.log(`\n═══ 資金費（3個月，type=8，正=收入 負=支出）═══`);
  for (const [k, v] of Object.entries(fundBySym).sort((a, b) => a[1] - b[1]))
    console.log(`  ${k.padEnd(22)} $${v.toFixed(4)}`);
  console.log(`資金費合計: $${fundTotal.toFixed(4)}（${bills.length} 筆）`);

  console.log(`\n═══ 執行成本總結 ═══`);
  console.log(`手續費 $${totalFees.toFixed(2)} + 資金費 $${fundTotal.toFixed(2)} = $${(totalFees + fundTotal).toFixed(2)}`);
  if (slipN) console.log(`平均進場滑價 ${(slipSum / slipN).toFixed(1)} bps × ${slipN} 筆`);
}

main().catch(e => { console.error("Audit error:", e); process.exit(1); });
