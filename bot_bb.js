/**
 * Bollinger Bands Breakout + ATR Dynamic Stop Bot
 * 策略核心：BB 突破 + 成交量確認 + ATR 動態止損
 * 目標賺賠比 1:2，勝率 55-65%
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";
import { spawn } from "child_process";
import { LOG_BB_FILE as LOG_FILE, POSITIONS_BB_FILE as POSITIONS_FILE, STATS_FILE, PF_FILE, CSV_BB_FILE as CSV_FILE, RULES_BB_FILE } from "./paths.js";

// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG = {
  timeframe: "1H",
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "100"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "20"),
  paperTrading: process.env.BB_PAPER_TRADING !== "false",
  okx: {
    apiKey: process.env.OKX_API_KEY,
    secretKey: process.env.OKX_SECRET_KEY,
    passphrase: process.env.OKX_PASSPHRASE,
    baseUrl: process.env.OKX_BASE_URL || "https://www.okx.com",
  },
};

const CSV_HEADERS    = "Date,Time (UTC),Exchange,Symbol,Side,Quantity,Price,Total USD,Fee (est.),Net Amount,Order ID,Mode,Notes";
const MAX_CONSEC_LOSSES = 3; // 連虧幾次後暫停該幣

// ─── Market Data ─────────────────────────────────────────────────────────────

async function fetchCandles(symbol, interval, limit = 100) {
  const map = { "15m":"15m","1H":"1h","4H":"4h","1D":"1d" };
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${map[interval]||"1h"}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance API error: ${res.status}`);
  return (await res.json()).map((k) => ({
    time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
    low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
  }));
}

// ─── BB + ATR Indicators ─────────────────────────────────────────────────────

function calcBB(closes, period = 20, mult = 2) {
  const slice  = closes.slice(-period);
  const middle = slice.reduce((a, b) => a + b, 0) / period;
  const stdDev = Math.sqrt(slice.reduce((s, c) => s + (c - middle) ** 2, 0) / period);
  return { upper: middle + mult * stdDev, middle, lower: middle - mult * stdDev, stdDev };
}

function calcATR(candles, period = 14) {
  const trs = candles.slice(1).map((c, i) => {
    const prev = candles[i].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
  });
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcSMA(closes, period) {
  return closes.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcAvgVolume(volumes, period = 20) {
  return volumes.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// ─── BB Safety Check ─────────────────────────────────────────────────────────

function runBBSafetyCheck(candles) {
  const closes  = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const last    = candles[candles.length - 1];
  const prev    = candles[candles.length - 2];
  const price   = last.close;

  const bb      = calcBB(closes, 20, 2);
  const atr     = calcATR(candles, 14);
  const atrAvg  = calcATR(candles.slice(0, -4), 14);
  const sma20   = bb.middle;
  const sma20Prev = calcSMA(closes.slice(0, -5), 20);
  const avgVol  = calcAvgVolume(volumes, 20);
  const volRatio = last.volume / avgVol;
  const smaTrend = sma20 > sma20Prev * 1.001 ? "rising" : sma20 < sma20Prev * 0.999 ? "falling" : "flat";
  const atrExpanding = atr > atrAvg * 1.05;

  // 有效突破：收盤站穩（不只影線碰觸）
  const breakoutLong  = last.close > bb.upper && prev.close <= bb.upper;
  const breakoutShort = last.close < bb.lower && prev.close >= bb.lower;

  const results = [];
  let side = null;

  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    // 靜默記錄，不輸出每條條件
  };


  if (breakoutLong) {
    side = "long";
    check("收盤突破 BB 上軌", `> ${bb.upper.toFixed(4)}`, price.toFixed(4), breakoutLong);
    check("成交量放大", "> 1.5x 均量", `${volRatio.toFixed(2)}x`, volRatio > 1.5);
    check("SMA20 向上（趨勢確認）", "rising", smaTrend, smaTrend === "rising");
    check("ATR 擴張（動能充足）", "> ATR均值", `${atr.toFixed(4)} vs ${atrAvg.toFixed(4)}`, atrExpanding);

  } else if (breakoutShort) {
    side = "short";
    check("收盤跌破 BB 下軌", `< ${bb.lower.toFixed(4)}`, price.toFixed(4), breakoutShort);
    check("成交量放大", "> 1.5x 均量", `${volRatio.toFixed(2)}x`, volRatio > 1.5);
    check("SMA20 向下（趨勢確認）", "falling", smaTrend, smaTrend === "falling");
    check("ATR 擴張（動能充足）", "> ATR均值", `${atr.toFixed(4)} vs ${atrAvg.toFixed(4)}`, atrExpanding);

  } else {
    results.push({ label: "BB 突破", required: "突破上軌或下軌", actual: `帶內 $${price.toFixed(4)}`, pass: false });
  }

  const allPass = results.length > 0 && results.every((r) => r.pass);
  return { results, allPass, side, price, bb, atr };
}

function updateTrailingStop(position, currentPrice) {
  const { side, entryPrice, stopLoss } = position;
  const initialRisk = Math.abs(entryPrice - stopLoss);
  if (initialRisk < 0.000001) return null;
  const profit = side === "long" ? currentPrice - entryPrice : entryPrice - currentPrice;
  const profitR = profit / initialRisk;
  if (profitR < 1.0) return null;
  const lockR = Math.max(0, Math.floor(profitR * 2) / 2 - 1.0);
  const newStop = side === "long"
    ? entryPrice + initialRisk * lockR
    : entryPrice - initialRisk * lockR;
  if (side === "long" && newStop > stopLoss) return newStop;
  if (side === "short" && newStop < stopLoss) return newStop;
  return null;
}

// ─── Exit Check ──────────────────────────────────────────────────────────────

function checkBBExit(position, candles) {
  const closes = candles.map((c) => c.close);
  const price  = closes[closes.length - 1];
  const bb     = calcBB(closes, 20, 2);
  const { side, entryPrice, stopLoss } = position;
  const risk   = Math.abs(entryPrice - stopLoss);
  const tp     = side === "long" ? entryPrice + risk * 2 : entryPrice - risk * 2;

  if (side === "long") {
    if (price <= stopLoss)  return { exit: true, reason: `ATR 止損 ($${stopLoss.toFixed(4)})` };
    if (price >= tp)        return { exit: true, reason: `2:1止盈達成 $${tp.toFixed(4)}` };
    // 突破失效：前根收盤在帶外，當根收回帶內
    if (price < bb.upper && candles[candles.length-2].close > bb.upper)
                            return { exit: true, reason: "重新跌回 BB 帶內（突破失效）" };
  } else {
    if (price >= stopLoss)  return { exit: true, reason: `ATR 止損 ($${stopLoss.toFixed(4)})` };
    if (price <= tp)        return { exit: true, reason: `2:1止盈達成 $${tp.toFixed(4)}` };
    if (price > bb.lower && candles[candles.length-2].close < bb.lower)
                            return { exit: true, reason: "重新漲回 BB 帶內（突破失效）" };
  }
  return { exit: false };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadPositions() {
  if (!existsSync(POSITIONS_FILE)) return { open: [], closed: [] };
  return JSON.parse(readFileSync(POSITIONS_FILE, "utf8"));
}
function savePositions(p) { writeFileSync(POSITIONS_FILE, JSON.stringify(p, null, 2)); }

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}
function saveLog(l) {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  l.trades = l.trades.filter(t => t.timestamp > cutoff);
  writeFileSync(LOG_FILE, JSON.stringify(l, null, 2));
}

function loadStats() {
  if (!existsSync(STATS_FILE)) return {};
  return JSON.parse(readFileSync(STATS_FILE, "utf8"));
}
function saveStats(s) { writeFileSync(STATS_FILE, JSON.stringify(s, null, 2)); }

function getPFMultiplier(symbol) {
  try {
    if (!existsSync(PF_FILE)) return 1.0;
    const pf = JSON.parse(readFileSync(PF_FILE, "utf8"))?.C?.[symbol];
    if (!pf) return 1.0;
    if (pf >= 3.5) return 2.0;
    if (pf >= 2.0) return 1.5;
    if (pf >= 1.2) return 1.0;
    return 0.5;
  } catch { return 1.0; }
}

function updateSymbolStats(symbol, win) {
  const stats = loadStats();
  if (!stats[symbol]) stats[symbol] = { consecutiveLosses: 0, totalTrades: 0, wins: 0 };
  stats[symbol].totalTrades++;
  if (win) {
    stats[symbol].wins++;
    stats[symbol].consecutiveLosses = 0;
  } else {
    stats[symbol].consecutiveLosses++;
  }
  saveStats(stats);
  return stats[symbol];
}

function isSymbolPaused(symbol) {
  const stats = loadStats();
  const s = stats[symbol];
  if (!s) return false;
  if (s.consecutiveLosses >= MAX_CONSEC_LOSSES) {
    console.log(`  ⏸️  ${symbol} 連虧 ${s.consecutiveLosses} 次，本週暫停`);
    return true;
  }
  return false;
}

function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter((t) => t.timestamp.startsWith(today) && t.orderPlaced).length;
}

function initCsv() {
  if (!existsSync(CSV_FILE)) writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
}

// ─── OKX Order ───────────────────────────────────────────────────────────────

function signOKX(ts, method, path, body = "") {
  return crypto.createHmac("sha256", CONFIG.okx.secretKey).update(`${ts}${method}${path}${body}`).digest("base64");
}

const _contractSpecCache = {};
async function fetchContractSpec(instId) {
  if (_contractSpecCache[instId]) return _contractSpecCache[instId];
  const res = await fetch(`${CONFIG.okx.baseUrl}/api/v5/public/instruments?instType=SWAP&instId=${instId}`);
  const d = await res.json();
  const inst = d.data?.[0];
  if (!inst) throw new Error(`找不到合約規格: ${instId}`);
  const spec = { ctVal: parseFloat(inst.ctVal), minSz: parseFloat(inst.minSz), lotSz: parseFloat(inst.lotSz) };
  _contractSpecCache[instId] = spec;
  return spec;
}

function floorToLot(value, lotSz) {
  const factor = Math.pow(10, Math.round(-Math.log10(lotSz)));
  return Math.floor(value * factor) / factor;
}

async function placeOKXOrder(symbol, side, sizeUSD, price, stopLossPrice) {
  const tradeMode = process.env.TRADE_MODE || "spot";
  const instId = tradeMode === "spot"
    ? symbol.replace("USDT", "-USDT")
    : symbol.replace("USDT", "-USDT-SWAP");

  let sz;
  if (tradeMode === "futures") {
    const spec = await fetchContractSpec(instId);
    const rawContracts = sizeUSD / (price * spec.ctVal);
    sz = String(floorToLot(rawContracts, spec.lotSz));
    if (parseFloat(sz) < spec.minSz) {
      throw new Error(`倉位不足最小下單量：需 ${spec.minSz} 張，只能買 ${sz} 張 (ctVal=${spec.ctVal})`);
    }
    console.log(`  合約規格: ctVal=${spec.ctVal}, 張數=${sz}`);
  } else {
    sz = (sizeUSD / price).toFixed(6);
  }

  const ts   = new Date().toISOString();
  const path = "/api/v5/trade/order";
  const bodyObj = tradeMode === "spot"
    ? { instId, tdMode: "cash", side, ordType: "market", sz }
    : { instId, tdMode: "isolated", lever: String(process.env.LEVERAGE || "1"),
        side, posSide: side === "buy" ? "long" : "short", ordType: "market", sz };
  const body = JSON.stringify(bodyObj);
  const res = await fetch(`${CONFIG.okx.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "OK-ACCESS-KEY": CONFIG.okx.apiKey,
      "OK-ACCESS-SIGN": signOKX(ts, "POST", path, body),
      "OK-ACCESS-TIMESTAMP": ts,
      "OK-ACCESS-PASSPHRASE": CONFIG.okx.passphrase,
    },
    body,
  });
  const data = await res.json();
  if (data.code !== "0") throw new Error(`OKX: ${data.msg}`);
  const order = data.data[0];

  if (tradeMode === "futures" && stopLossPrice) {
    const exitSide   = side === "buy" ? "sell" : "buy";
    const exitPosSide = side === "buy" ? "long" : "short";
    // Strategy C SL = entryCandle.low/high ± ATR×0.5；TP = 進場價 ± |進場-SL| × 2（2:1 R:R）
    // OKX 市價單回應不含 avgPx，用下單時的 price 估算（誤差極小）
    const tpPx       = side === "buy"
      ? price + Math.abs(price - stopLossPrice) * 2
      : price - Math.abs(price - stopLossPrice) * 2;
    const slTs   = new Date().toISOString();
    const slPath = "/api/v5/trade/order-algo";
    const slBody = JSON.stringify({
      instId, tdMode: "isolated", side: exitSide,
      posSide: exitPosSide,
      ordType: "conditional", sz,
      slTriggerPx: stopLossPrice.toFixed(8), slOrdPx: "-1", slTriggerPxType: "last",
      tpTriggerPx: tpPx.toFixed(8),          tpOrdPx: "-1", tpTriggerPxType: "last",
    });
    const slSig = signOKX(slTs, "POST", slPath, slBody);
    const slRes = await fetch(`${CONFIG.okx.baseUrl}${slPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "OK-ACCESS-KEY": CONFIG.okx.apiKey,
        "OK-ACCESS-SIGN": slSig, "OK-ACCESS-TIMESTAMP": slTs, "OK-ACCESS-PASSPHRASE": CONFIG.okx.passphrase },
      body: slBody,
    });
    const slData = await slRes.json();
    if (slData.code === "0") {
      order.algoId = slData.data?.[0]?.algoId;
      console.log(`  🛡️ SL:${stopLossPrice.toFixed(6)} | 🎯 TP:${tpPx.toFixed(6)}`);
    } else {
      console.log(`  ⚠️ SL/TP 掛單失敗 — ${slData.msg}`);
    }
  }
  return order;
}

async function closeOKXPosition(position) {
  const instId      = position.symbol.replace("USDT", "-USDT-SWAP");
  const exitSide    = position.side === "long" ? "sell" : "buy";
  const exitPosSide = position.side === "long" ? "long" : "short";

  if (position.algoId) {
    const ts   = new Date().toISOString();
    const path = "/api/v5/trade/cancel-algos";
    const body = JSON.stringify([{ algoId: position.algoId, instId }]);
    await fetch(`${CONFIG.okx.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "OK-ACCESS-KEY": CONFIG.okx.apiKey,
        "OK-ACCESS-SIGN": signOKX(ts, "POST", path, body), "OK-ACCESS-TIMESTAMP": ts, "OK-ACCESS-PASSPHRASE": CONFIG.okx.passphrase },
      body,
    });
  }

  const spec = await fetchContractSpec(instId);
  const sz   = String(floorToLot(position.quantity / spec.ctVal, spec.lotSz));
  const ts   = new Date().toISOString();
  const path = "/api/v5/trade/order";
  const body = JSON.stringify({ instId, tdMode: "isolated", side: exitSide, posSide: exitPosSide, ordType: "market", sz });
  const res  = await fetch(`${CONFIG.okx.baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "OK-ACCESS-KEY": CONFIG.okx.apiKey,
      "OK-ACCESS-SIGN": signOKX(ts, "POST", path, body), "OK-ACCESS-TIMESTAMP": ts, "OK-ACCESS-PASSPHRASE": CONFIG.okx.passphrase },
    body,
  });
  const data = await res.json();
  if (data.code !== "0") throw new Error(`OKX 平倉失敗: ${data.msg}`);
  return data.data[0];
}

async function reconcileWithOKX(positions) {
  if (CONFIG.paperTrading || !positions.open.length) return;
  const ts = new Date().toISOString();
  const path = "/api/v5/account/positions?instType=SWAP";
  const sig = signOKX(ts, "GET", path);
  try {
    const res = await fetch(`${CONFIG.okx.baseUrl}${path}`, {
      headers: {
        "OK-ACCESS-KEY": CONFIG.okx.apiKey,
        "OK-ACCESS-SIGN": sig,
        "OK-ACCESS-TIMESTAMP": ts,
        "OK-ACCESS-PASSPHRASE": CONFIG.okx.passphrase,
      },
    });
    const data = await res.json();
    if (data.code !== "0") { console.log(`  ⚠️ OKX 對帳失敗: ${data.msg}`); return; }
    const okxOpen = new Set(data.data.map(p => p.instId.replace("-USDT-SWAP", "USDT")));
    const removed = [];
    for (const p of [...positions.open]) {
      if (okxOpen.has(p.symbol)) continue;

      let exitPrice = null, realPnl = null;
      try {
        const instId = p.symbol.replace("USDT", "-USDT-SWAP");
        const hTs    = new Date().toISOString();
        const hPath  = `/api/v5/account/positions-history?instType=SWAP&instId=${instId}&limit=1`;
        const hSig   = signOKX(hTs, "GET", hPath);
        const hRes   = await fetch(`${CONFIG.okx.baseUrl}${hPath}`, {
          headers: { "OK-ACCESS-KEY": CONFIG.okx.apiKey, "OK-ACCESS-SIGN": hSig,
            "OK-ACCESS-TIMESTAMP": hTs, "OK-ACCESS-PASSPHRASE": CONFIG.okx.passphrase },
        });
        const hData = await hRes.json();
        if (hData.code === "0" && hData.data?.[0]) {
          exitPrice = parseFloat(hData.data[0].closeAvgPx);
          realPnl   = parseFloat(hData.data[0].realizedPnl);
        }
      } catch (_) {}

      const exitReason = "OKX SL/TP 觸發";
      console.log(`  🔔 [BB對帳] ${p.symbol} 已平倉 | 出場$${exitPrice?.toFixed(4) ?? "?"} | P&L $${realPnl?.toFixed(4) ?? "?"}`);
      positions.closed.push({ ...p, exitPrice, exitTime: new Date().toISOString(), exitReason, pnl: realPnl });
      removed.push(p.symbol);

      if (exitPrice !== null) {
        const now = new Date();
        appendFileSync(CSV_FILE, [
          now.toISOString().slice(0, 10), now.toISOString().slice(11, 19),
          "OKX", p.symbol, p.side === "long" ? "SELL" : "BUY",
          p.quantity.toFixed(6), exitPrice.toFixed(4),
          Math.abs(realPnl + p.tradeSize).toFixed(2),
          (Math.abs(realPnl + p.tradeSize) * 0.001).toFixed(4),
          realPnl.toFixed(4),
          `EXIT-OKX-${Date.now()}`,
          "LIVE",
          `"OKX SL/TP 觸發"`,
        ].join(",") + "\n");
      }
    }
    positions.open = positions.open.filter(p => !removed.includes(p.symbol));
    savePositions(positions);
  } catch (e) {
    console.log(`  ⚠️ OKX 對帳例外: ${e.message}`);
  }
}

// ─── Stats ───────────────────────────────────────────────────────────────────

function generateStats() {
  const positions = loadPositions();
  const closed    = positions.closed || [];
  const open      = positions.open || [];

  console.log("\n══════════════════════════════════════════════════════════");
  console.log("  BB+ATR 策略績效統計");
  console.log("══════════════════════════════════════════════════════════");

  if (open.length > 0) {
    console.log(`\n  目前持倉 (${open.length} 筆):`);
    open.forEach((p) => console.log(`    ${p.side.toUpperCase()} ${p.symbol} — 進場 $${p.entryPrice.toFixed(4)} | 止損 $${p.stopLoss.toFixed(4)}`));
  }

  if (closed.length === 0) {
    console.log("\n  尚無已平倉交易 — 繼續讓機器人運行收集數據。");
    console.log("══════════════════════════════════════════════════════════\n");
    return;
  }

  const wins     = closed.filter((t) => t.win);
  const losses   = closed.filter((t) => !t.win);
  const totalPnl = closed.reduce((s, t) => s + t.pnl, 0);
  const winRate  = ((wins.length / closed.length) * 100).toFixed(1);
  const avgWin   = wins.length   ? (wins.reduce((s,t)=>s+t.pnl,0)/wins.length).toFixed(4)   : "0";
  const avgLoss  = losses.length ? (losses.reduce((s,t)=>s+t.pnl,0)/losses.length).toFixed(4) : "0";
  const best     = closed.reduce((a, b) => a.pnl > b.pnl ? a : b);
  const worst    = closed.reduce((a, b) => a.pnl < b.pnl ? a : b);

  console.log(`\n  已平倉交易    : ${closed.length} 筆`);
  console.log(`  勝率          : ${winRate}%  (${wins.length} 勝 / ${losses.length} 敗)`);
  console.log(`  總損益        : $${totalPnl.toFixed(4)}`);
  console.log(`  平均獲利      : $${avgWin}`);
  console.log(`  平均虧損      : $${avgLoss}`);
  console.log(`  最佳交易      : +$${best.pnl.toFixed(4)} (${best.symbol} ${best.side})`);
  console.log(`  最差交易      : $${worst.pnl.toFixed(4)} (${worst.symbol} ${worst.side})`);
  console.log(`\n  最近 5 筆:`);
  closed.slice(-5).reverse().forEach((t) => {
    console.log(`    ${t.win?"✅":"🔴"} ${t.symbol} ${t.side.toUpperCase()} | P&L: $${t.pnl.toFixed(4)} | ${t.exitReason}`);
  });
  console.log("══════════════════════════════════════════════════════════\n");
}

// ─── Run Symbol ──────────────────────────────────────────────────────────────

async function runSymbol(symbol, log, positions) {
  const hasOpenPos = positions.open.some((p) => p.symbol === symbol);
  if (!hasOpenPos && isSymbolPaused(symbol)) return false;

  const candles = await fetchCandles(symbol, CONFIG.timeframe, 60);
  const price   = candles[candles.length - 1].close;

  // 出場優先
  const openPos = positions.open.find((p) => p.symbol === symbol);
  if (openPos) {
    const newStop = updateTrailingStop(openPos, price);
    if (newStop !== null) {
      console.log(`  📈 [BB:${symbol}] 追蹤止損：$${openPos.stopLoss.toFixed(6)} → $${newStop.toFixed(6)}`);
      openPos.stopLoss = newStop;
      savePositions(positions);
    }
    const { exit, reason } = checkBBExit(openPos, candles);
    if (exit) {
      if (!CONFIG.paperTrading) {
        try {
          await closeOKXPosition(openPos);
          console.log(`  📤 [BB:${symbol}] OKX平倉送出`);
        } catch (err) {
          console.log(`  ⚠️ [BB:${symbol}] OKX平倉失敗 — ${err.message}（本地狀態仍會更新）`);
        }
      }

      const pnl = openPos.side === "long"
        ? (price - openPos.entryPrice) * openPos.quantity
        : (openPos.entryPrice - price) * openPos.quantity;
      const win = pnl > 0;
      console.log(`  ${win ? "✅" : "🔴"} [BB:${symbol}] 出場：${reason} | P&L: $${pnl.toFixed(4)}`);
      const symStats = updateSymbolStats(symbol, win);
      if (!win && symStats.consecutiveLosses >= MAX_CONSEC_LOSSES)
        console.log(`  ⚠️  [BB:${symbol}] 連虧${symStats.consecutiveLosses}次，暫停`);
      positions.open = positions.open.filter((p) => p.symbol !== symbol);
      positions.closed.push({ ...openPos, exitPrice: price, exitTime: new Date().toISOString(), exitReason: reason, pnl, win, paperTrading: CONFIG.paperTrading });
      savePositions(positions);
      appendFileSync(CSV_FILE, [
        new Date().toISOString().slice(0,10), new Date().toISOString().slice(11,19),
        "OKX", symbol, openPos.side === "long" ? "SELL" : "BUY",
        openPos.quantity.toFixed(6), price.toFixed(4),
        Math.abs(pnl + openPos.tradeSize).toFixed(2),
        (Math.abs(pnl + openPos.tradeSize)*0.001).toFixed(4),
        pnl.toFixed(4), `EXIT-${Date.now()}`,
        CONFIG.paperTrading ? "PAPER" : "LIVE",
        `"出場: ${reason} | P&L: $${pnl.toFixed(4)}"`,
      ].join(",") + "\n");
    }
    return false;
  }

  if (countTodaysTrades(log) >= CONFIG.maxTradesPerDay) return false;
  if (positions.open.length >= 4) {
    console.log(`  🚫 [${symbol}] 已達最大持倉數(4)，跳過`);
    return false;
  }
  if (price < 0.001) return false;

  const { results, allPass, side, atr } = runBBSafetyCheck(candles);
  const entryCandle = candles[candles.length - 1];
  const stopLoss = side === "long"
    ? entryCandle.low - atr * 0.5
    : entryCandle.high + atr * 0.5;
  const slPct = Math.abs(price - stopLoss) / price * 100;
  if (allPass && (slPct < 1.0 || slPct > 5)) return false;

  const pfMult      = getPFMultiplier(symbol);
  const riskAmount  = CONFIG.portfolioValue * 0.01 * pfMult;
  const stopLossPct = Math.abs(price - stopLoss) / price;
  const maxLeverage = parseFloat(process.env.LEVERAGE || "1");
  const rawSize     = stopLossPct > 0.001 ? riskAmount / stopLossPct : riskAmount;
  const tradeSize   = Math.min(rawSize, CONFIG.portfolioValue * maxLeverage, CONFIG.maxTradeSizeUSD);
  const quantity    = tradeSize / price;

  const logEntry = {
    timestamp: new Date().toISOString(), symbol,
    timeframe: CONFIG.timeframe, price,
    conditions: results, allPass, tradeSize,
    orderPlaced: false, orderId: null,
    paperTrading: CONFIG.paperTrading,
  };

  if (allPass) {
    console.log(`✅ [BB] 信號 — ${side.toUpperCase()} ${symbol} | 價$${price.toFixed(4)} | SL$${stopLoss.toFixed(4)}`);

    if (CONFIG.paperTrading) {
      console.log(`   📋 模擬 $${tradeSize.toFixed(2)}`);
      logEntry.orderPlaced = true;
      logEntry.orderId = `BB-PAPER-${Date.now()}`;
    } else {
      try {
        const order = await placeOKXOrder(symbol, side === "long" ? "buy" : "sell", tradeSize, price, stopLoss);
        logEntry.orderPlaced = true;
        logEntry.orderId = order.ordId;
        logEntry.algoId = order.algoId;
        console.log(`   🔴 下單成功 — ordId:${order.ordId}`);

        // TradingView 標記（本地有 TradingView 才執行，Railway 自動跳過）
        const tp = side === "long" ? price + Math.abs(price - stopLoss) * 2 : price - Math.abs(price - stopLoss) * 2;
        spawn("node", ["tv_mark_trade.js", symbol, side, String(price), String(stopLoss), String(tp)],
          { detached: true, stdio: "ignore" }).unref();
      } catch (err) {
        console.log(`❌ 下單失敗 — ${err.message}`);
        logEntry.error = err.message;
      }
    }

    if (logEntry.orderPlaced) {
      positions.open.push({ symbol, side, entryPrice: price, entryTime: new Date().toISOString(), tradeSize, quantity, orderId: logEntry.orderId, algoId: logEntry.algoId, stopLoss, riskAmount });
      savePositions(positions);
      appendFileSync(CSV_FILE, [
        new Date().toISOString().slice(0,10), new Date().toISOString().slice(11,19),
        "OKX", symbol, side === "long" ? "BUY" : "SELL",
        quantity.toFixed(6), price.toFixed(4), tradeSize.toFixed(2),
        (tradeSize*0.001).toFixed(4), (tradeSize-(tradeSize*0.001)).toFixed(2),
        logEntry.orderId, CONFIG.paperTrading ? "PAPER" : "LIVE",
        `"進場: BB突破 ${side} | 止損 $${stopLoss.toFixed(4)}"`,
      ].join(",") + "\n");
    }
  }

  log.trades.push(logEntry);
  saveLog(log);
  return logEntry.orderPlaced;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  initCsv();
  const rules     = JSON.parse(readFileSync(RULES_BB_FILE, "utf8"));
  const watchlist = rules.watchlist;
  const log       = loadLog();
  const positions = loadPositions();

  console.log(`[BB] ${new Date().toISOString()} | ${CONFIG.paperTrading ? "PAPER" : "LIVE"} | ${watchlist.length}幣 | 持倉:${positions.open.length}`);

  await reconcileWithOKX(positions);

  // 日熔斷：當日已實現虧損超過本金 5% 則停止入場
  const today = new Date().toISOString().slice(0, 10);
  const todayPnl = positions.closed
    .filter(t => t.exitTime?.startsWith(today) && t.pnl !== null)
    .reduce((sum, t) => sum + (t.pnl || 0), 0);
  if (todayPnl < -(CONFIG.portfolioValue * 0.05)) {
    console.log(`⚡ [C熔斷] 今日已虧 $${Math.abs(todayPnl).toFixed(2)}，超過本金 5%，暫停入場`);
    return;
  }

  const orphans = positions.open.filter(p => !watchlist.includes(p.symbol));
  for (const p of orphans) await runSymbol(p.symbol, log, positions);

  for (const symbol of watchlist) {
    const hasOpen = positions.open.some((p) => p.symbol === symbol);
    if (!hasOpen && countTodaysTrades(log) >= CONFIG.maxTradesPerDay) {
      if (!positions.open.some((p) => watchlist.slice(watchlist.indexOf(symbol)).includes(p.symbol))) break;
    }
    await runSymbol(symbol, log, positions);
  }

  console.log(`[BB] 掃描完成`);
}

if (process.argv.includes("--stats")) {
  generateStats();
} else {
  run().catch((err) => { console.error("BB Bot error:", err); process.exit(1); });
}
