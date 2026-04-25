/**
 * Lightweight data API server — serves Railway Volume files over HTTP.
 * Endpoints:
 *   GET /             → status + summary
 *   GET /trades       → trades.csv (Strategy A)
 *   GET /trades_bb    → trades_bb.csv (Strategy C)
 *   GET /trades_dmc   → trades_dmc.csv
 *   GET /trades_orb   → trades_orb.csv
 *   GET /positions    → positions.json (Strategy A)
 *   GET /positions_bb → positions_bb.json
 *   GET /stats        → today's P&L summary across all strategies
 */
import { createServer } from "http";
import { readFileSync, existsSync } from "fs";
import crypto from "crypto";

// OKX 直接查詢（Railway 上有正確的系統時鐘）
function signOKX(ts, method, path, body = "") {
  return crypto.createHmac("sha256", process.env.OKX_SECRET_KEY || "")
    .update(`${ts}${method}${path}${body}`).digest("base64");
}
async function okxGet(path) {
  const ts  = new Date().toISOString();
  const res = await fetch(`${process.env.OKX_BASE_URL || "https://www.okx.com"}${path}`, {
    headers: {
      "OK-ACCESS-KEY": process.env.OKX_API_KEY || "",
      "OK-ACCESS-SIGN": signOKX(ts, "GET", path),
      "OK-ACCESS-TIMESTAMP": ts,
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

function parseCsv(csv) {
  if (!csv) return [];
  return csv.trim().split("\n").map(line => {
    // CSV: date,time,exchange,symbol,side,qty,price,gross,fee,pnl,orderId,mode,note
    const parts = line.split(",");
    return {
      date:    parts[0],
      time:    parts[1],
      symbol:  parts[3],
      side:    parts[4],
      price:   parseFloat(parts[6]),
      size:    parseFloat(parts[7]),
      pnl:     parseFloat(parts[9]) || 0,
      orderId: parts[10],
      mode:    parts[11],
    };
  });
}

function todaySummary() {
  const today = new Date().toISOString().slice(0, 10);
  const files = ["trades.csv", "trades_bb.csv", "trades_dmc.csv", "trades_orb.csv"];
  let totalPnl = 0, wins = 0, losses = 0, trades = [];

  for (const f of files) {
    const csv = readFile(`${D}/${f}`);
    if (!csv) continue;
    // 只計算出場行（orderId 以 EXIT- 開頭）且今日且真實交易
    const rows = parseCsv(csv).filter(r =>
      r.date === today && r.mode === "LIVE" && r.orderId && r.orderId.startsWith("EXIT-")
    );
    for (const r of rows) {
      totalPnl += r.pnl;
      r.pnl > 0 ? wins++ : losses++;
      trades.push(r);
    }
  }

  const posA  = JSON.parse(readFile(`${D}/positions.json`)   || '{"open":[]}');
  const posBB = JSON.parse(readFile(`${D}/positions_bb.json`) || '{"open":[]}');

  return {
    date: today,
    closedTrades: wins + losses,
    wins, losses,
    winRate: wins + losses > 0 ? ((wins / (wins + losses)) * 100).toFixed(1) + "%" : "N/A",
    totalPnl: totalPnl.toFixed(4),
    openPositions: {
      strategyA:  posA.open.map(p => ({ symbol: p.symbol, side: p.side, entry: p.entryPrice, sl: p.stopLoss })),
      strategyBB: posBB.open.filter(p => !p.orderId?.startsWith("BB-PAPER")).map(p => ({ symbol: p.symbol, side: p.side, entry: p.entryPrice, sl: p.stopLoss })),
    },
  };
}

const asyncRoutes = {
  // OKX 即時倉位（地面真相）
  "/okx": async () => {
    // 取得開倉
    const pos = await okxGet("/api/v5/account/positions?instType=SWAP");

    // 今日開始時間戳（台灣時間 UTC+8 的 00:00）
    const now = new Date();
    const TWN_OFFSET = 8 * 60 * 60 * 1000;
    const todayTWN = new Date(now.getTime() + TWN_OFFSET);
    todayTWN.setUTCHours(0, 0, 0, 0);
    const todayStartMs = todayTWN.getTime() - TWN_OFFSET; // 轉回 UTC ms

    // OKX positions-history：用 before/after 時間戳分頁，每次最多100筆
    // 一次拉100筆，過濾今日（TWN 00:00 = UTC-8h 之後）
    const hist = await okxGet("/api/v5/account/positions-history?instType=SWAP&limit=100");
    const allClosed = (hist.data || []).filter(p => {
      const ts = parseInt(p.uTime || p.cTime || 0);
      return ts >= todayStartMs;
    });

    const wins   = allClosed.filter(p => parseFloat(p.realizedPnl) > 0).length;
    const losses = allClosed.filter(p => parseFloat(p.realizedPnl) <= 0).length;
    const totalPnl = allClosed.reduce((s, p) => s + parseFloat(p.realizedPnl), 0);

    return JSON.stringify({
      asOf: new Date().toISOString(),
      openOnOKX: (pos.data || []).map(p => ({
        symbol: p.instId.replace("-USDT-SWAP", "USDT"),
        side: p.posSide, contracts: p.pos,
        avgPx: parseFloat(p.avgPx),
        upl: parseFloat(p.upl),
      })),
      todaySummary: {
        totalTrades: allClosed.length,
        wins, losses,
        winRate: allClosed.length ? ((wins / allClosed.length) * 100).toFixed(1) + "%" : "N/A",
        totalPnl: totalPnl.toFixed(4),
      },
      todayClosedOnOKX: allClosed.map(p => {
        const ts = p.uTime || p.cTime;
        return {
          symbol: p.instId.replace("-USDT-SWAP", "USDT"),
          side: p.direction,
          closeAvgPx: parseFloat(p.closeAvgPx),
          realizedPnl: parseFloat(p.realizedPnl),
          closeTime: ts ? new Date(parseInt(ts)).toISOString() : null,
        };
      }).sort((a, b) => new Date(a.closeTime) - new Date(b.closeTime)),
    }, null, 2);
  },
};

const routes = {
  "/":             () => JSON.stringify(todaySummary(), null, 2),
  "/trades":       () => readFile(`${D}/trades.csv`)     || "no data",
  "/trades_bb":    () => readFile(`${D}/trades_bb.csv`)  || "no data",
  "/trades_dmc":   () => readFile(`${D}/trades_dmc.csv`) || "no data",
  "/trades_orb":   () => readFile(`${D}/trades_orb.csv`) || "no data",
  "/positions":    () => readFile(`${D}/positions.json`)    || "{}",
  "/positions_bb": () => readFile(`${D}/positions_bb.json`) || "{}",
  "/log":          () => readFile(`${D}/safety-check-log.json`) || "{}",
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
