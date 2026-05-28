/**
 * 產生 report.json（給 GitHub Actions 用）
 * 讀取本地 positions_dn.json + trades_dn.csv，抓 Binance 即時價，輸出 report.json
 */

import { existsSync, readFileSync, writeFileSync } from "fs";

const D = process.env.DATA_DIR || ".";
const STRATEGIES = [
  { key: "dn",  posFile: "positions_dn.json",  csvFile: "trades_dn.csv",  label: "DN: Donchian Breakout [4H] 起:2026-05-13" },
  { key: "dmc", posFile: "positions_dmc.json", csvFile: "trades_dmc.csv", label: "B: DMC/SMA25 [4H] 起:2026-05-29" },
];

function toOkxInstId(sym) {
  for (const q of ["USDT", "USDC", "BTC", "ETH"]) {
    if (sym.endsWith(q)) return `${sym.slice(0, -q.length)}-${q}`;
  }
  return sym;
}

async function fetchPrices(symbols) {
  if (!symbols.length) return {};
  const out = {};
  await Promise.all(symbols.map(async (sym) => {
    const instId = toOkxInstId(sym);
    try {
      const r = await fetch(`https://www.okx.com/api/v5/market/ticker?instId=${instId}`);
      if (r.ok) {
        const data = await r.json();
        if (data.data?.[0]?.last) out[sym] = parseFloat(data.data[0].last);
        else console.error(`fetchPrices ${sym}: no data`, JSON.stringify(data).slice(0, 100));
      } else {
        console.error(`fetchPrices ${sym}: HTTP ${r.status}`);
      }
    } catch(e) { console.error(`fetchPrices ${sym}:`, e.message); }
  }));
  return out;
}

function buildPositions(pos, prices) {
  return (pos.open || []).map(p => {
    const curPx  = prices[p.symbol];
    const entry  = p.entryPrice;
    const sl     = p.currentSL ?? p.stopLoss ?? null;
    const tp     = p.tp ?? null;
    const sign   = p.side === "short" ? -1 : 1;
    const pct    = curPx && entry ? sign * (curPx - entry) / entry * 100 : null;
    const qty    = p.quantity ?? null;
    const uPnl   = (pct !== null && qty) ? sign * (curPx - entry) * qty : null;
    const slDist = (curPx && sl) ? (p.side === "short" ? (sl - curPx) / curPx * 100 : (curPx - sl) / curPx * 100) : null;
    const tpDist = (curPx && tp) ? (p.side === "short" ? (curPx - tp) / curPx * 100 : (tp - curPx) / curPx * 100) : null;
    const tpPnl  = (entry && tp && qty) ? Math.abs(entry - tp) * qty : null;
    const slPnl  = (entry && sl && qty) ? -Math.abs(entry - sl) * qty : null;
    return {
      symbol:        p.symbol,
      side:          p.side,
      entry,
      currentPrice:  curPx ?? null,
      sl,
      tp,
      slDistPct:     slDist !== null ? parseFloat(slDist.toFixed(2)) : null,
      tpDistPct:     tpDist !== null ? parseFloat(tpDist.toFixed(2)) : null,
      unrealizedPct: pct    !== null ? parseFloat(pct.toFixed(2))    : null,
      unrealizedPnl: uPnl   !== null ? parseFloat(uPnl.toFixed(2))   : null,
      tpPnl:         tpPnl  !== null ? parseFloat(tpPnl.toFixed(2))  : null,
      slPnl:         slPnl  !== null ? parseFloat(slPnl.toFixed(2))  : null,
      since:         p.entryTime ? new Date(p.entryTime).toISOString().slice(0, 16) : undefined,
    };
  });
}

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

async function main() {
  const today = new Date().toISOString().slice(0, 10);

  // 收集所有策略的開倉幣種 → 一次抓價格
  const allSymbols = new Set();
  const stratData  = {};
  for (const s of STRATEGIES) {
    const pos = existsSync(`${D}/${s.posFile}`)
      ? JSON.parse(readFileSync(`${D}/${s.posFile}`, "utf8"))
      : { open: [], closed: [], cooldown: {} };
    stratData[s.key] = { pos };
    (pos.open || []).forEach(p => p.symbol && allSymbols.add(p.symbol));
  }

  const prices = await fetchPrices([...allSymbols]);

  let totalUnrealizedAll = 0;
  const todayExitsAll    = [];
  const stratReports     = {};

  for (const s of STRATEGIES) {
    const { pos } = stratData[s.key];
    const openPositions = buildPositions(pos, prices);
    const totalUnrealized = openPositions.reduce((sum, p) => sum + (p.unrealizedPnl ?? 0), 0);
    totalUnrealizedAll += totalUnrealized;

    const exits     = readExits(`${D}/${s.csvFile}`);
    const todayExits = exits.filter(r => r.date === today);
    todayExitsAll.push(...todayExits);

    stratReports[s.key] = {
      label:             s.label,
      overall:           calcStats(exits),
      today:             calcStats(todayExits),
      openPositions,
      totalUnrealizedPnl: parseFloat(totalUnrealized.toFixed(2)),
    };

    console.log(`[report][${s.key}] 開倉:${openPositions.length} | 未實現:$${totalUnrealized.toFixed(2)}`);
  }

  const report = {
    reportDate:  today,
    generatedAt: new Date().toISOString(),
    todayCombined: {
      ...calcStats(todayExitsAll),
      totalUnrealizedPnl: parseFloat(totalUnrealizedAll.toFixed(2)),
    },
    strategies: stratReports,
    // 向下相容舊格式（保留 strategy 欄位指向 DN）
    strategy: stratReports["dn"],
  };

  writeFileSync(`${D}/report.json`, JSON.stringify(report, null, 2));
  console.log(`[report] ${today} | 總未實現:$${totalUnrealizedAll.toFixed(2)}`);
}

main().catch(e => { console.error("Report error:", e.message); process.exit(1); });
