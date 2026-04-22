/**
 * Bollinger Bands Breakout + ATR Dynamic Stop Bot
 * 策略核心：BB 突破 + 成交量確認 + ATR 動態止損
 * 目標賺賠比 1:2，勝率 55-65%
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";

// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG = {
  timeframe: "1H",
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "100"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "3"),
  paperTrading: process.env.PAPER_TRADING !== "false",
  okx: {
    apiKey: process.env.OKX_API_KEY,
    secretKey: process.env.OKX_SECRET_KEY,
    passphrase: process.env.OKX_PASSPHRASE,
    baseUrl: process.env.OKX_BASE_URL || "https://www.okx.com",
  },
};

const LOG_FILE       = "safety-check-log-bb.json";
const POSITIONS_FILE = "positions_bb.json";
const CSV_FILE       = "trades_bb.csv";
const CSV_HEADERS    = "Date,Time (UTC),Exchange,Symbol,Side,Quantity,Price,Total USD,Fee (est.),Net Amount,Order ID,Mode,Notes";

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
  const smaTrend = sma20 > sma20Prev * 1.0005 ? "rising" : sma20 < sma20Prev * 0.9995 ? "falling" : "flat";
  const atrExpanding = atr > atrAvg * 1.05;

  // 有效突破：收盤站穩（不只影線碰觸）
  const breakoutLong  = last.close > bb.upper && prev.close <= bb.upper;
  const breakoutShort = last.close < bb.lower && prev.close >= bb.lower;

  const results = [];
  let side = null;

  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    console.log(`  ${pass ? "✅" : "🚫"} ${label}`);
    console.log(`     Required: ${required} | Actual: ${actual}`);
  };

  console.log("\n── BB 安全檢查 ──────────────────────────────────────────\n");
  console.log(`  BB 上軌: $${bb.upper.toFixed(4)} | 中軌: $${bb.middle.toFixed(4)} | 下軌: $${bb.lower.toFixed(4)}`);
  console.log(`  ATR: ${atr.toFixed(4)} | ATR均值: ${atrAvg.toFixed(4)} | 波動: ${atrExpanding ? "擴張" : "收縮"}`);
  console.log(`  量比: ${volRatio.toFixed(2)}x | SMA20 趨勢: ${smaTrend}\n`);

  if (breakoutLong) {
    side = "long";
    console.log("  方向: 突破上軌，檢查做多條件\n");
    check("收盤突破 BB 上軌", `> ${bb.upper.toFixed(4)}`, price.toFixed(4), breakoutLong);
    check("成交量放大", "> 1.5x 均量", `${volRatio.toFixed(2)}x`, volRatio > 1.5);
    check("SMA20 向上（趨勢確認）", "rising", smaTrend, smaTrend === "rising");
    check("ATR 擴張（動能充足）", "> ATR均值", `${atr.toFixed(4)} vs ${atrAvg.toFixed(4)}`, atrExpanding);

  } else if (breakoutShort) {
    side = "short";
    console.log("  方向: 跌破下軌，檢查做空條件\n");
    check("收盤跌破 BB 下軌", `< ${bb.lower.toFixed(4)}`, price.toFixed(4), breakoutShort);
    check("成交量放大", "> 1.5x 均量", `${volRatio.toFixed(2)}x`, volRatio > 1.5);
    check("SMA20 向下（趨勢確認）", "falling", smaTrend, smaTrend === "falling");
    check("ATR 擴張（動能充足）", "> ATR均值", `${atr.toFixed(4)} vs ${atrAvg.toFixed(4)}`, atrExpanding);

  } else {
    console.log(`  價格在布林帶內 ($${bb.lower.toFixed(4)} ~ $${bb.upper.toFixed(4)})，等待突破。\n`);
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

  if (side === "long") {
    if (price <= stopLoss)   return { exit: true, reason: `ATR 動態止損 ($${stopLoss.toFixed(4)})` };
    if (price <= bb.middle)  return { exit: true, reason: "回到 BB 中軌（止盈）" };
    if (price < bb.upper && candles[candles.length-2].close > bb.upper)
                             return { exit: true, reason: "重新跌回 BB 帶內（突破失效）" };
  } else {
    if (price >= stopLoss)   return { exit: true, reason: `ATR 動態止損 ($${stopLoss.toFixed(4)})` };
    if (price >= bb.middle)  return { exit: true, reason: "回到 BB 中軌（止盈）" };
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
function saveLog(l) { writeFileSync(LOG_FILE, JSON.stringify(l, null, 2)); }

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

async function placeOKXOrder(symbol, side, sizeUSD, price, stopLossPrice) {
  const tradeMode = process.env.TRADE_MODE || "spot";
  const instId = tradeMode === "spot"
    ? symbol.replace("USDT", "-USDT")
    : symbol.replace("USDT", "-USDT-SWAP");
  const quantity = (sizeUSD / price).toFixed(6);
  const ts   = new Date().toISOString();
  const path = "/api/v5/trade/order";
  const bodyObj = tradeMode === "spot"
    ? { instId, tdMode: "cash", side, ordType: "market", sz: quantity }
    : { instId, tdMode: "isolated", lever: String(process.env.LEVERAGE || "1"),
        side, posSide: side === "buy" ? "long" : "short", ordType: "market", sz: quantity };
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
    const slSide = side === "buy" ? "sell" : "buy";
    const slTs = new Date().toISOString();
    const slPath = "/api/v5/trade/order-algo";
    const slBody = JSON.stringify({
      instId, tdMode: "isolated", side: slSide,
      posSide: side === "buy" ? "long" : "short",
      ordType: "conditional", sz: quantity,
      slTriggerPx: stopLossPrice.toFixed(8), slOrdPx: "-1", slTriggerPxType: "last",
    });
    const slSig = signOKX(slTs, "POST", slPath, slBody);
    const slRes = await fetch(`${CONFIG.okx.baseUrl}${slPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "OK-ACCESS-KEY": CONFIG.okx.apiKey,
        "OK-ACCESS-SIGN": slSig, "OK-ACCESS-TIMESTAMP": slTs, "OK-ACCESS-PASSPHRASE": CONFIG.okx.passphrase },
      body: slBody,
    });
    const slData = await slRes.json();
    console.log(slData.code === "0" ? `  🛡️ 止損單已掛 → ${stopLossPrice.toFixed(6)}` : `  ⚠️ 止損單失敗 — ${slData.msg}`);
  }
  return order;
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
  console.log(`\n${"─".repeat(57)}`);
  console.log(`  [BB] ${symbol}`);
  console.log(`${"─".repeat(57)}`);

  const candles = await fetchCandles(symbol, CONFIG.timeframe, 60);
  const price   = candles[candles.length - 1].close;
  console.log(`\n  Current price: $${price.toFixed(4)}`);

  // 出場優先
  const openPos = positions.open.find((p) => p.symbol === symbol);
  if (openPos) {
    const newStop = updateTrailingStop(openPos, price);
    if (newStop !== null) {
      console.log(`  📈 追蹤止損更新：$${openPos.stopLoss.toFixed(6)} → $${newStop.toFixed(6)}`);
      openPos.stopLoss = newStop;
      savePositions(positions);
    }
    console.log(`\n── 持倉檢查 (${openPos.side.toUpperCase()} 進場價: $${openPos.entryPrice.toFixed(4)} | 止損: $${openPos.stopLoss.toFixed(6)}) ──\n`);
    const { exit, reason } = checkBBExit(openPos, candles);
    if (exit) {
      const pnl = openPos.side === "long"
        ? (price - openPos.entryPrice) * openPos.quantity
        : (openPos.entryPrice - price) * openPos.quantity;
      const win = pnl > 0;
      console.log(`  ${win ? "✅" : "🔴"} 出場：${reason} | P&L: $${pnl.toFixed(4)}`);
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
    } else {
      console.log(`  持倉中，繼續持有。`);
    }
    return false;
  }

  // 進場
  if (countTodaysTrades(log) >= CONFIG.maxTradesPerDay) {
    console.log("  跳過 — 今日上限已達。");
    return false;
  }

  const { results, allPass, side, atr } = runBBSafetyCheck(candles);

  // 策略C 止損：進場K棒最低/高點 ± ATR×0.5 buffer（BB突破失效才出場）
  const entryCandle = candles[candles.length - 1];
  const stopLoss = side === "long"
    ? entryCandle.low - atr * 0.5    // 多單：進場棒最低點下方半個ATR
    : entryCandle.high + atr * 0.5;  // 空單：進場棒最高點上方半個ATR

  // 固定風險倉位：每筆最多虧本金 1%，倉位由止損距離反推
  const riskAmount  = CONFIG.portfolioValue * 0.01;
  const stopLossPct = Math.abs(price - stopLoss) / price;
  const maxLeverage = parseFloat(process.env.LEVERAGE || "1");
  const rawSize     = stopLossPct > 0.001 ? riskAmount / stopLossPct : riskAmount;
  const tradeSize   = Math.min(rawSize, CONFIG.portfolioValue * maxLeverage, CONFIG.maxTradeSizeUSD);
  const quantity    = tradeSize / price;

  console.log("\n── 決策 ─────────────────────────────────────────────────\n");

  const logEntry = {
    timestamp: new Date().toISOString(), symbol,
    timeframe: CONFIG.timeframe, price,
    conditions: results, allPass, tradeSize,
    orderPlaced: false, orderId: null,
    paperTrading: CONFIG.paperTrading,
  };

  if (!allPass) {
    const failed = results.filter((r) => !r.pass).map((r) => r.label);
    console.log(`🚫 不進場`);
    failed.forEach((f) => console.log(`   - ${f}`));
  } else {
    console.log(`✅ BB 突破確認 — ${side.toUpperCase()} ${symbol}`);
    console.log(`   止損: $${stopLoss.toFixed(4)} (ATR×1.5 = ${(atr*1.5).toFixed(4)})`);

    if (CONFIG.paperTrading) {
      console.log(`\n📋 紙上交易 — ${side} ${symbol}`);
      console.log(`   倉位: $${tradeSize.toFixed(2)} | 風險: $${riskAmount.toFixed(2)} (本金1%) | 止損: ${stopLoss.toFixed(6)} (ATR×1.5=${stopLossPct.toFixed(3)*100}%)`);
      logEntry.orderPlaced = true;
      logEntry.orderId = `BB-PAPER-${Date.now()}`;
    } else {
      try {
        const order = await placeOKXOrder(symbol, side === "long" ? "buy" : "sell", tradeSize, price, stopLoss);
        logEntry.orderPlaced = true;
        logEntry.orderId = order.orderId;
        console.log(`✅ 訂單成立 — ${order.orderId}`);
      } catch (err) {
        console.log(`❌ 下單失敗 — ${err.message}`);
        logEntry.error = err.message;
      }
    }

    if (logEntry.orderPlaced) {
      positions.open.push({ symbol, side, entryPrice: price, entryTime: new Date().toISOString(), tradeSize, quantity, orderId: logEntry.orderId, stopLoss, riskAmount });
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
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  BB+ATR Trading Bot");
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`);
  console.log("═══════════════════════════════════════════════════════════");

  const rules     = JSON.parse(readFileSync("rules_bb.json", "utf8"));
  const watchlist = rules.watchlist;
  console.log(`\nStrategy: ${rules.strategy.name}`);
  console.log(`Watchlist: ${watchlist.length} 個幣種 | Timeframe: ${CONFIG.timeframe}`);

  const log       = loadLog();
  const positions = loadPositions();

  if (positions.open.length > 0)
    console.log(`\n目前持倉: ${positions.open.map((p) => `${p.side.toUpperCase()} ${p.symbol}`).join(", ")}`);

  for (const symbol of watchlist) {
    const hasOpen = positions.open.some((p) => p.symbol === symbol);
    if (!hasOpen && countTodaysTrades(log) >= CONFIG.maxTradesPerDay) {
      if (!positions.open.some((p) => watchlist.slice(watchlist.indexOf(symbol)).includes(p.symbol))) break;
    }
    await runSymbol(symbol, log, positions);
  }

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  BB+ATR 掃描完成");
  console.log("═══════════════════════════════════════════════════════════\n");
}

if (process.argv.includes("--stats")) {
  generateStats();
} else {
  run().catch((err) => { console.error("BB Bot error:", err); process.exit(1); });
}
