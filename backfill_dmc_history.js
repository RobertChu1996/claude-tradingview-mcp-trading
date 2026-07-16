/**
 * 一次性回填腳本：
 * OCO 在 OKX 端觸發的平倉過去沒有寫入 trades_dmc.csv（reconcile 只標記、不記帳），
 * 導致報表統計嚴重失真。此腳本：
 *   1. 讀 trades_dmc.csv 的「開倉」列，找出沒有對應出場列的交易
 *   2. 查 OKX positions-history 比對（instId + 方向 + 開倉時間），取真實出場價與 realizedPnl
 *   3. 依平倉時間排序補寫出場列，並確保 CSV 有標頭
 *   4. 同步把 positions_dmc.json closed[] 內對應紀錄的 pnl / exitPrice 補上
 *
 * 需要環境變數：OKX_API_KEY / OKX_SECRET_KEY / OKX_PASSPHRASE
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import crypto from "crypto";

const D = process.env.DATA_DIR || ".";
const CSV_FILE = `${D}/trades_dmc.csv`;
const POSITIONS_FILE = `${D}/positions_dmc.json`;
const CSV_HEADERS = "Date,Time(UTC),Symbol,Side,Entry,Exit,PnL,Reason,Mode,OrderID";
const OKX_BASE = process.env.OKX_BASE_URL || "https://www.okx.com";
const SINCE = Date.parse("2026-05-29T00:00:00Z");   // 策略起始日
const OPEN_TIME_TOLERANCE = 12 * 3600 * 1000;       // 開倉時間比對容差

// ─── OKX API ─────────────────────────────────────────────────────────────────
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

function toOkxInstId(sym) {
  return sym.replace(/USDT$/, "-USDT");
}

// ─── 讀 CSV ──────────────────────────────────────────────────────────────────
function parseCsv() {
  if (!existsSync(CSV_FILE)) { console.error("找不到 trades_dmc.csv"); process.exit(1); }
  let lines = readFileSync(CSV_FILE, "utf8").trim().split("\n").filter(Boolean);
  if (lines[0]?.startsWith("Date,")) lines = lines.slice(1);
  return lines.map(line => {
    const p = line.split(",");
    return {
      raw: line, date: p[0], time: p[1], symbol: p[2], side: p[3],
      entry: parseFloat(p[4]), exit: p[5], pnl: p[6], reason: p[7],
      mode: p[8], orderId: p[9],
      ts: Date.parse(`${p[0]}T${p[1]}Z`),
    };
  });
}

async function main() {
  await initOkxTime();
  const rows = parseCsv();
  const opens = rows.filter(r => r.reason === "開倉");
  const exits = rows.filter(r => r.reason !== "開倉");

  // 已有出場列的 key（symbol，依時間先後配對用）
  const exitedCount = {};
  for (const e of exits) exitedCount[e.symbol] = (exitedCount[e.symbol] || 0) + 1;

  // 分頁抓取策略起始日以來所有平倉歷史
  const hist = [];
  let after = "";
  for (let page = 0; page < 20; page++) {
    const d = await okxGet(`/api/v5/account/positions-history?instType=SWAP&limit=100${after ? `&after=${after}` : ""}`);
    if (d.code !== "0") { console.error("OKX 查詢失敗:", d.msg); process.exit(1); }
    const batch = d.data || [];
    if (!batch.length) break;
    hist.push(...batch);
    const oldest = parseInt(batch[batch.length - 1].uTime);
    if (oldest < SINCE) break;
    after = batch[batch.length - 1].uTime;
  }
  console.log(`OKX 平倉歷史共 ${hist.length} 筆`);

  // 每筆未平倉的「開倉」列 → 找對應的平倉歷史
  const usedHist = new Set();
  const newExits = [];
  for (const o of opens) {
    // 該 symbol 已有的出場列先抵掉（6 月中前的舊資料）
    if (exitedCount[o.symbol] > 0) { exitedCount[o.symbol]--; continue; }

    const instId = toOkxInstId(o.symbol) + "-SWAP";
    const match = hist.find(h =>
      !usedHist.has(h.posId + h.uTime) &&
      h.instId === instId &&
      h.direction === o.side &&
      Math.abs(parseInt(h.cTime) - o.ts) < OPEN_TIME_TOLERANCE
    );
    if (!match) { console.log(`  ─ ${o.symbol} ${o.side} 開於 ${o.date} → 尚未平倉或查無紀錄，略過`); continue; }
    usedHist.add(match.posId + match.uTime);

    const pnl = parseFloat(match.realizedPnl);
    const exitPx = parseFloat(match.closeAvgPx);
    const dt = new Date(parseInt(match.uTime)).toISOString();
    newExits.push({
      ts: parseInt(match.uTime),
      line: `${dt.slice(0, 10)},${dt.slice(11, 19)},${o.symbol},${o.side},` +
            `${o.entry},${exitPx.toFixed(6)},${pnl.toFixed(2)},` +
            `${pnl >= 0 ? "止盈" : "止損"},LIVE,${o.orderId}`,
      symbol: o.symbol, side: o.side, pnl, exitPx,
    });
    console.log(`  ✚ ${o.symbol} ${o.side} 開 ${o.date} ${o.entry} → 平 ${dt.slice(0, 16)} ${exitPx} PnL=$${pnl.toFixed(2)}`);
  }

  if (!newExits.length) { console.log("沒有需要回填的平倉紀錄"); }

  // 重寫 CSV：標頭 + 原資料列 + 回填列（依平倉時間排序）
  newExits.sort((a, b) => a.ts - b.ts);
  const out = [CSV_HEADERS, ...rows.map(r => r.raw), ...newExits.map(e => e.line)];
  writeFileSync(CSV_FILE, out.join("\n") + "\n");
  console.log(`CSV 已重寫：${rows.length} 原列 + ${newExits.length} 回填列（含標頭）`);

  // 同步 positions_dmc.json closed[] 的 pnl / exitPrice
  if (existsSync(POSITIONS_FILE)) {
    const positions = JSON.parse(readFileSync(POSITIONS_FILE, "utf8"));
    let patched = 0;
    for (const c of positions.closed || []) {
      if (c.pnl != null) continue;
      const m = newExits.find(e => e.symbol === c.symbol && e.side === c.side &&
        Math.abs(e.ts - (c.exitTime || 0)) < 48 * 3600 * 1000);
      if (m) { c.pnl = m.pnl; c.exitPrice = m.exitPx; patched++; }
    }
    writeFileSync(POSITIONS_FILE, JSON.stringify(positions, null, 2));
    console.log(`positions_dmc.json closed[] 補上 ${patched} 筆 pnl`);
  }

  const total = newExits.reduce((s, e) => s + e.pnl, 0);
  console.log(`\n回填合計 PnL: $${total.toFixed(2)}`);
}

main().catch(e => { console.error("Backfill error:", e); process.exit(1); });
