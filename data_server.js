/**
 * Lightweight data API server — serves Railway Volume files over HTTP.
 * Endpoints:
 *   GET /          → today's summary + open positions
 *   GET /report    → full DN strategy report with unrealized PnL
 *   GET /positions → positions_dn.json
 *   GET /trades    → trades_dn.csv
 *   GET /balance   → OKX account balance
 *   GET /okx       → OKX live positions + today's closed trades
 *   GET /log       → safety-check-log-dn.json
 */
import { createServer } from "http";
import { readFileSync, existsSync } from "fs";
import crypto from "crypto";

function signOKX(ts, method, path, body = "") {
  return crypto.createHmac("sha256", process.env.OKX_SECRET_KEY || "")
    .update(`${ts}${method}${path}${body}`).digest("base64");
}
async function okxGet(path) {
  const ts  = new Date().toISOString();
  const res = await fetch(`${process.env.OKX_BASE_URL || "https://www.okx.com"}${path}`, {
    headers: {
      "OK-ACCESS-KEY":        process.env.OKX_API_KEY || "",
      "OK-ACCESS-SIGN":       signOKX(ts, "GET", path),
      "OK-ACCESS-TIMESTAMP":  ts,
      "OK-ACCESS-PASSPHRASE": process.env.OKX_PASSPHRASE || "",
    },
  });
  return res.json();
}

const PORT = process.env.PORT || 3000;
const D    = process.env.DATA_DIR || ".";

function readFile(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

// 批次抓 Binance 即時價格（現貨 + 合約雙重保障）
async function fetchPrices(symbols) {
  if (!symbols.length) return {};
  const out = {};
  try {
    const encoded = encodeURIComponent(JSON.stringify(symbols));
    const r1  = await fetch(`https://api.binance.com/api/v3/ticker/price?symbols=${encoded}`);
    if (r1.ok) {
      const list = await r1.json();
      if (Array.isArray(list)) for (const t of list) out[t.symbol] = parseFloat(t.price);
    }
    const missing = symbols.filter(s => !out[s]);
    if (missing.length) {
      const enc2 = encodeURIComponent(JSON.stringify(missing));
      const r2   = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbols=${enc2}`);
      if (r2.ok) {
        const list2 = await r2.json();
        if (Array.isArray(list2)) for (const t of list2) out[t.symbol] = parseFloat(t.price);
      }
    }
  } catch(e) { console.error("[fetchPrices]", e.message); }
  return out;
}

// 單策略統計：從 CSV + positions JSON 計算全期及今日績效
function strategyStats(csvFile, posFile, label, prices = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const csv   = readFile(`${D}/${csvFile}`);

  // CSV: Date,Time(UTC),Symbol,Side,Entry,Exit,PnL,Reason,Mode,OrderID
  function parseCsv(raw) {
    if (!raw) return [];
    return raw.trim().split("\n").slice(1).map(line => {
      const p = line.split(",");
      return { date: p[0], symbol: p[2], side: p[3], pnl: parseFloat(p[6]) || 0, reason: p[7], mode: p[8], orderId: p[9] };
    }).filter(r => r.orderId && r.reason !== "開倉");
  }

  const exits   = parseCsv(csv);
  const todayEx = exits.filter(r => r.date === today);

  function calcStats(rows) {
    if (!rows.length) return { trades: 0, wins: 0, losses: 0, winRate: "N/A", totalPnl: 0, avgWin: 0, avgLoss: 0 };
    const wins   = rows.filter(r => r.pnl > 0);
    const losses = rows.filter(r => r.pnl <= 0);
    return {
      trades:   rows.length,
      wins:     wins.length,
      losses:   losses.length,
      winRate:  ((wins.length / rows.length) * 100).toFixed(1) + "%",
      totalPnl: rows.reduce((s, r) => s + r.pnl, 0).toFixed(4),
      avgWin:   wins.length ? (wins.reduce((s, r) => s + r.pnl, 0) / wins.length).toFixed(4) : "0",
      avgLoss:  losses.length ? (losses.reduce((s, r) => s + r.pnl, 0) / losses.length).toFixed(4) : "0",
    };
  }

  const pos = posFile ? JSON.parse(readFile(`${D}/${posFile}`) || '{"open":[],"closed":[]}') : { open: [], closed: [] };

  const openPositions = (pos.open || []).map(p => {
    const curPx = prices[p.symbol];
    const entry = p.entryPrice;
    const sign  = p.side === "short" ? -1 : 1;
    const pct   = curPx && entry ? sign * (curPx - entry) / entry * 100 : null;
    const qty   = p.quantity ?? p.qty ?? p.size ?? null;
    const uPnl  = (pct !== null && qty) ? sign * (curPx - entry) * qty : null;
    return {
      symbol:        p.symbol,
      side:          p.side,
      entry:         entry,
      currentPrice:  curPx ?? null,
      sl:            p.currentSL ?? p.stopLoss ?? null,
      tp:            p.tp ?? null,
      unrealizedPct: pct !== null ? parseFloat(pct.toFixed(2)) : null,
      unrealizedPnl: uPnl !== null ? parseFloat(uPnl.toFixed(2)) : null,
      since:         p.entryTime ? new Date(p.entryTime).toISOString().slice(0, 16) : undefined,
    };
  });

  const totalUnrealized = openPositions.reduce((s, p) => s + (p.unrealizedPnl ?? 0), 0);

  return {
    label,
    overall: calcStats(exits),
    today:   calcStats(todayEx),
    openPositions,
    totalUnrealizedPnl: parseFloat(totalUnrealized.toFixed(2)),
  };
}

async function fullReport() {
  const today = new Date().toISOString().slice(0, 10);

  // 收集開倉幣種一次抓價格
  const symbols = new Set();
  try {
    const p = JSON.parse(readFile(`${D}/positions_dn.json`) || '{"open":[]}');
    (p.open || []).forEach(pos => { if (pos.symbol) symbols.add(pos.symbol); });
  } catch {}
  const prices = await fetchPrices([...symbols]);

  const strategy = strategyStats("trades_dn.csv", "positions_dn.json", "DN: Donchian Breakout [4H] 起:2026-05-13", prices);

  return {
    reportDate:  today,
    generatedAt: new Date().toISOString(),
    todayCombined: {
      trades:             strategy.today.trades,
      wins:               strategy.today.wins,
      losses:             strategy.today.losses,
      winRate:            strategy.today.winRate,
      totalPnl:           strategy.today.totalPnl,
      totalUnrealizedPnl: strategy.totalUnrealizedPnl,
    },
    strategy,
  };
}

const asyncRoutes = {
  "/":       async () => JSON.stringify(await fullReport(), null, 2),
  "/report": async () => JSON.stringify(await fullReport(), null, 2),

  "/balance": async () => {
    const r = await okxGet("/api/v5/account/balance");
    const details  = (r.data?.[0]?.details || []).filter(d => parseFloat(d.cashBal) > 0);
    const totalEq  = parseFloat(r.data?.[0]?.totalEq || 0);
    return JSON.stringify({
      asOf: new Date().toISOString(),
      totalEquityUSD: totalEq.toFixed(2),
      assets: details.map(d => ({
        currency: d.ccy,
        balance:  parseFloat(d.cashBal).toFixed(4),
        usdValue: parseFloat(d.eqUsd || 0).toFixed(2),
      })),
    }, null, 2);
  },

  "/okx": async () => {
    const pos = await okxGet("/api/v5/account/positions?instType=SWAP");

    const now = new Date();
    const TWN_OFFSET = 8 * 60 * 60 * 1000;
    const todayTWN = new Date(now.getTime() + TWN_OFFSET);
    todayTWN.setUTCHours(0, 0, 0, 0);
    const todayStartMs = todayTWN.getTime() - TWN_OFFSET;

    const hist = await okxGet("/api/v5/account/positions-history?instType=SWAP&limit=100");
    const allClosed = (hist.data || []).filter(p => {
      const ts = parseInt(p.uTime || p.cTime || 0);
      return ts >= todayStartMs;
    });

    const wins    = allClosed.filter(p => parseFloat(p.realizedPnl) > 0).length;
    const losses  = allClosed.filter(p => parseFloat(p.realizedPnl) <= 0).length;
    const totalPnl = allClosed.reduce((s, p) => s + parseFloat(p.realizedPnl), 0);

    return JSON.stringify({
      asOf: new Date().toISOString(),
      openOnOKX: (pos.data || []).map(p => ({
        symbol:    p.instId.replace("-USDT-SWAP", "USDT"),
        side:      p.posSide, contracts: p.pos,
        avgPx:     parseFloat(p.avgPx),
        upl:       parseFloat(p.upl),
      })),
      todaySummary: {
        totalTrades: allClosed.length, wins, losses,
        winRate:  allClosed.length ? ((wins / allClosed.length) * 100).toFixed(1) + "%" : "N/A",
        totalPnl: totalPnl.toFixed(4),
      },
      todayClosedOnOKX: allClosed.map(p => {
        const ts = p.uTime || p.cTime;
        return {
          symbol:      p.instId.replace("-USDT-SWAP", "USDT"),
          side:        p.direction,
          closeAvgPx:  parseFloat(p.closeAvgPx),
          realizedPnl: parseFloat(p.realizedPnl),
          closeTime:   ts ? new Date(parseInt(ts)).toISOString() : null,
        };
      }).sort((a, b) => new Date(a.closeTime) - new Date(b.closeTime)),
    }, null, 2);
  },
};

const routes = {
  "/positions": () => readFile(`${D}/positions_dn.json`) || "{}",
  "/trades":    () => readFile(`${D}/trades_dn.csv`)     || "no data",
  "/log":       () => readFile(`${D}/safety-check-log-dn.json`) || "{}",
};

const server = createServer(async (req, res) => {
  const path = req.url.split("?")[0];
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (asyncRoutes[path]) {
    res.writeHead(200);
    try { res.end(await asyncRoutes[path]()); }
    catch (e) { res.end(JSON.stringify({ error: e.message })); }
    return;
  }
  const handler = routes[path];
  if (!handler) { res.writeHead(404); res.end(JSON.stringify({ error: "not found" })); return; }
  res.writeHead(200);
  res.end(handler());
});

server.listen(PORT, () => console.log(`[data-server] http://localhost:${PORT}`));

export default server;
