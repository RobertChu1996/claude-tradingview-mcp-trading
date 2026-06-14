/**
 * 產生 report.json（給 GitHub Actions 用）
 * 直接查 OKX API 取得餘額與持倉，讀取 trades_dmc.csv 計算歷史統計
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import crypto from "crypto";

const D = process.env.DATA_DIR || ".";
const OKX_BASE = process.env.OKX_BASE_URL || "https://www.okx.com";
const DMC_LABEL = "B: DMC/SMA25 [4H] 起:2026-05-29";

// ─── OKX API ─────────────────────────────────────────────────────────────────
let _serverTimeOffset = 0;
async function initOkxTime() {
  try {
    const r = await fetch(`${OKX_BASE}/api/v5/public/time`);
    const d = await r.json();
    if (d.data?.[0]?.ts) _serverTimeOffset = parseInt(d.data[0].ts) - Date.now();
  } catch {}
}

function okxSign(ts, method, path, body = "") {
  return crypto.createHmac("sha256", process.env.OKX_SECRET_KEY)
    .update(`${ts}${method}${path}${body}`).digest("base64");
}
async function okxGet(path) {
  const ts  = new Date(Date.now() + _serverTimeOffset).toISOString();
  const res = await fetch(`${OKX_BASE}${path}`, {
    headers: {
      "OK-ACCESS-KEY":       process.env.OKX_API_KEY,
      "OK-ACCESS-SIGN":      okxSign(ts, "GET", path),
      "OK-ACCESS-TIMESTAMP": ts,
      "OK-ACCESS-PASSPHRASE":process.env.OKX_PASSPHRASE,
    },
  });
  return res.json();
}

function toOkxInstId(sym) {
  for (const q of ["USDT", "USDC", "BTC", "ETH"]) {
    if (sym.endsWith(q)) return `${sym.slice(0, -q.length)}-${q}`;
  }
  return sym;
}

// ─── 從 OKX 取得即時持倉 ──────────────────────────────────────────────────────
async function fetchOkxPositions() {
  const res = await okxGet("/api/v5/account/positions?instType=SWAP");
  if (!res.data) return [];
  return res.data
    .filter(p => parseFloat(p.pos) !== 0)
    .map(p => {
      const instId  = p.instId.replace("-SWAP", "");
      const sym     = instId.replace(/-/g, "");
      const side    = p.posSide;
      const entry   = parseFloat(p.avgPx);
      const curPx   = parseFloat(p.markPx || p.last || 0);
      const upl     = parseFloat(p.upl);
      const qty     = Math.abs(parseFloat(p.pos)) * parseFloat(p.ctVal || 1);
      const slDist  = (curPx && p.liqPx) ? null : null;  // liquidation px only; SL not in this endpoint
      const pct     = entry ? (side === "short" ? (entry - curPx) / entry : (curPx - entry) / entry) * 100 : null;
      return {
        symbol:        sym,
        side,
        entry,
        currentPrice:  curPx,
        sl:            null,
        tp:            null,
        slDistPct:     null,
        tpDistPct:     null,
        unrealizedPct: pct  !== null ? parseFloat(pct.toFixed(2))  : null,
        unrealizedPnl: parseFloat(upl.toFixed(2)),
        since:         p.cTime ? new Date(+p.cTime).toISOString().slice(0, 16) : undefined,
      };
    });
}

// ─── 從 OKX 取得 USDT 餘額 ────────────────────────────────────────────────────
async function fetchOkxBalance() {
  const res = await okxGet("/api/v5/account/balance");
  const usdt = res.data?.[0]?.details?.find(d => d.ccy === "USDT");
  if (!usdt) return null;
  return {
    totalEq:   parseFloat(parseFloat(usdt.eq).toFixed(4)),
    availBal:  parseFloat(parseFloat(usdt.availBal).toFixed(4)),
    frozenBal: parseFloat(parseFloat(usdt.frozenBal || 0).toFixed(4)),
  };
}

// ─── 讀 CSV 歷史成交 ──────────────────────────────────────────────────────────
function readExits(csvFile) {
  if (!existsSync(csvFile)) return [];
  return readFileSync(csvFile, "utf8")
    .trim().split("\n").slice(1)
    .map(line => {
      const p = line.split(",");
      return { date: p[0], symbol: p[2], side: p[3], pnl: parseFloat(p[6]) || 0, reason: p[7] };
    })
    .filter(r => r.reason && r.reason !== "開倉");
}

function calcStats(rows) {
  if (!rows.length) return { trades: 0, wins: 0, losses: 0, winRate: "N/A", totalPnl: "0.0000" };
  const wins   = rows.filter(r => r.pnl > 0);
  const losses = rows.filter(r => r.pnl <= 0);
  return {
    trades:   rows.length,
    wins:     wins.length,
    losses:   losses.length,
    winRate:  ((wins.length / rows.length) * 100).toFixed(1) + "%",
    totalPnl: rows.reduce((s, r) => s + r.pnl, 0).toFixed(4),
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const hasOkxCreds = process.env.OKX_API_KEY && process.env.OKX_SECRET_KEY && process.env.OKX_PASSPHRASE;

  await initOkxTime();

  // Fetch OKX data if credentials available
  let openPositions = [];
  let balance = null;
  if (hasOkxCreds) {
    try {
      [openPositions, balance] = await Promise.all([fetchOkxPositions(), fetchOkxBalance()]);
      console.log(`[report] OKX 持倉: ${openPositions.length} 筆 | USDT 餘額: $${balance?.totalEq ?? "N/A"}`);
    } catch(e) {
      console.error("[report] OKX 查詢失敗:", e.message);
    }
  } else {
    console.warn("[report] 無 OKX API 憑證，跳過持倉查詢");
  }

  const totalUnrealized = openPositions.reduce((s, p) => s + (p.unrealizedPnl ?? 0), 0);

  const exits       = readExits(`${D}/trades_dmc.csv`);
  const todayExits  = exits.filter(r => r.date === today);

  console.log(`[report][dmc] 開倉:${openPositions.length} | 未實現:$${totalUnrealized.toFixed(2)}`);

  const report = {
    reportDate:  today,
    generatedAt: new Date().toISOString(),
    balance,
    todayCombined: {
      ...calcStats(todayExits),
      totalUnrealizedPnl: parseFloat(totalUnrealized.toFixed(2)),
    },
    strategies: {
      dmc: {
        label:              DMC_LABEL,
        overall:            calcStats(exits),
        today:              calcStats(todayExits),
        openPositions,
        totalUnrealizedPnl: parseFloat(totalUnrealized.toFixed(2)),
      },
    },
    strategy: {
      label:              DMC_LABEL,
      overall:            calcStats(exits),
      today:              calcStats(todayExits),
      openPositions,
      totalUnrealizedPnl: parseFloat(totalUnrealized.toFixed(2)),
    },
  };

  writeFileSync(`${D}/report.json`, JSON.stringify(report, null, 2));
  console.log(`[report] ${today} | 總未實現:$${totalUnrealized.toFixed(2)}`);
}

main().catch(e => { console.error("Report error:", e.message); process.exit(1); });
