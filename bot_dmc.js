/**
 * DMC-Inspired Trading Bot
 * 策略核心：市場結構 + 成交量確認 + K線實體強度
 * 裸K邏輯：不用 RSI/VWAP，純看價格行為與資金動能
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";

// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG = {
  timeframe: "15m",
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

const LOG_FILE = "safety-check-log-dmc.json";
const POSITIONS_FILE = "positions_dmc.json";
const CSV_FILE = "trades_dmc.csv";
const CSV_HEADERS = "Date,Time (UTC),Exchange,Symbol,Side,Quantity,Price,Total USD,Fee (est.),Net Amount,Order ID,Mode,Notes";

// ─── Market Data ─────────────────────────────────────────────────────────────

async function fetchCandles(symbol, interval, limit = 100) {
  const intervalMap = { "1m":"1m","5m":"5m","15m":"15m","30m":"30m","1H":"1h","4H":"4h","1D":"1d" };
  const binanceInterval = intervalMap[interval] || "15m";
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${binanceInterval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance API error: ${res.status}`);
  const data = await res.json();
  return data.map((k) => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

function calcATR(candles, period = 14) {
  const trs = candles.slice(1).map((c, i) => {
    const prev = candles[i].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
  });
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function swingStop(candles, side, lookback = 8, bufferMult = 0.1) {
  const recent = candles.slice(-lookback - 1, -1);
  const atr = calcATR(candles, 14);
  if (side === "long") {
    return Math.min(...recent.map((c) => c.low)) - atr * bufferMult;
  } else {
    return Math.max(...recent.map((c) => c.high)) + atr * bufferMult;
  }
}

// ─── DMC Indicators ──────────────────────────────────────────────────────────

function calcSMA(closes, period) {
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function calcAvgVolume(volumes, period = 20) {
  const slice = volumes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

// K線實體強度：實體 / 全範圍（含影線）
function calcCandleStrength(candle) {
  const body = Math.abs(candle.close - candle.open);
  const range = candle.high - candle.low;
  if (range === 0) return 0;
  return body / range;
}

// 市場結構：比較近3根 vs 前3根收盤均值
function calcStructureTrend(closes) {
  const recent = (closes.slice(-3).reduce((a, b) => a + b, 0)) / 3;
  const prev   = (closes.slice(-6, -3).reduce((a, b) => a + b, 0)) / 3;
  if (recent > prev * 1.001) return "bullish";
  if (recent < prev * 0.999) return "bearish";
  return "neutral";
}

// ─── DMC Safety Check ────────────────────────────────────────────────────────

function runDMCSafetyCheck(candles) {
  const closes  = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const last    = candles[candles.length - 1];
  const price   = last.close;

  const sma20Now  = calcSMA(closes, 20);
  const sma20Prev = calcSMA(closes.slice(0, -5), 20);
  const avgVol    = calcAvgVolume(volumes, 20);
  const volRatio  = last.volume / avgVol;
  const strength  = calcCandleStrength(last);
  const structure = calcStructureTrend(closes);
  const smaTrend  = sma20Now > sma20Prev * 1.001 ? "bullish" : sma20Now < sma20Prev * 0.999 ? "bearish" : "neutral";
  const aboveSMA  = price > sma20Now;
  const bullishK  = last.close > last.open;

  const results = [];
  let side = null;

  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    console.log(`  ${pass ? "✅" : "🚫"} ${label}`);
    console.log(`     Required: ${required} | Actual: ${actual}`);
  };

  console.log("\n── DMC 安全檢查 ─────────────────────────────────────────\n");
  console.log(`  SMA20: $${sma20Now.toFixed(4)} | 5根前 SMA20: $${sma20Prev.toFixed(4)}`);
  console.log(`  均線結構: ${smaTrend} | 市場結構: ${structure}`);
  console.log(`  量比: ${volRatio.toFixed(2)}x | K棒實體強度: ${(strength * 100).toFixed(0)}%\n`);

  if (smaTrend === "bullish" && structure === "bullish") {
    side = "long";
    console.log("  方向: 多頭結構，檢查做多條件\n");

    check("均線向上（多頭結構）", "SMA20 上升", `${smaTrend}`, smaTrend === "bullish");
    check("價格在 SMA20 之上", `> ${sma20Now.toFixed(4)}`, price.toFixed(4), aboveSMA);
    check("成交量放大（動能真實）", "> 1.5x 均量", `${volRatio.toFixed(2)}x`, volRatio > 1.5);
    check("強勢多頭K棒", "收紅 + 實體 > 60%", `${bullishK ? "收紅" : "收黑"} ${(strength * 100).toFixed(0)}%`, bullishK && strength > 0.6);
    check("市場結構延續（高點抬高）", "近3根 > 前3根均值", structure, structure === "bullish");

  } else if (smaTrend === "bearish" && structure === "bearish") {
    side = "short";
    console.log("  方向: 空頭結構，檢查做空條件\n");

    check("均線向下（空頭結構）", "SMA20 下降", `${smaTrend}`, smaTrend === "bearish");
    check("價格在 SMA20 之下", `< ${sma20Now.toFixed(4)}`, price.toFixed(4), !aboveSMA);
    check("成交量放大（動能真實）", "> 1.5x 均量", `${volRatio.toFixed(2)}x`, volRatio > 1.5);
    check("強勢空頭K棒", "收黑 + 實體 > 60%", `${!bullishK ? "收黑" : "收紅"} ${(strength * 100).toFixed(0)}%`, !bullishK && strength > 0.6);
    check("市場結構延續（低點下移）", "近3根 < 前3根均值", structure, structure === "bearish");

  } else {
    console.log("  方向: 結構不明確，不交易\n");
    results.push({ label: "市場結構", required: "多頭或空頭", actual: `均線:${smaTrend} 結構:${structure}`, pass: false });
  }

  const allPass = results.length > 0 && results.every((r) => r.pass);
  return { results, allPass, side, price, sma20: sma20Now, volRatio, strength };
}

// ─── Exit Check ──────────────────────────────────────────────────────────────

function checkDMCExit(position, candles) {
  const closes = candles.map((c) => c.close);
  const last   = candles[candles.length - 1];
  const price  = last.close;
  const sma20  = calcSMA(closes, 20);
  const strength = calcCandleStrength(last);
  const { side, entryPrice } = position;

  if (side === "long") {
    if (price <= entryPrice * 0.995) return { exit: true, reason: "止損觸發 (-0.5%)" };
    if (price < sma20)               return { exit: true, reason: "價格跌破 SMA20（結構破壞）" };
    if (last.close < last.open && strength > 0.6) return { exit: true, reason: "強勢空頭K棒出現（反轉訊號）" };
  } else {
    if (price >= entryPrice * 1.005) return { exit: true, reason: "止損觸發 (+0.5%)" };
    if (price > sma20)               return { exit: true, reason: "價格突破 SMA20（結構破壞）" };
    if (last.close > last.open && strength > 0.6) return { exit: true, reason: "強勢多頭K棒出現（反轉訊號）" };
  }
  return { exit: false };
}

// ─── Position & Log Helpers ──────────────────────────────────────────────────

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

function appendCsvRow(row) { appendFileSync(CSV_FILE, row + "\n"); }

// ─── OKX Order ───────────────────────────────────────────────────────────────

function signOKX(timestamp, method, path, body = "") {
  return crypto.createHmac("sha256", CONFIG.okx.secretKey).update(`${timestamp}${method}${path}${body}`).digest("base64");
}

async function placeOKXOrder(symbol, side, sizeUSD, price, stopLossPrice) {
  const tradeMode = process.env.TRADE_MODE || "spot";
  const instId = tradeMode === "spot"
    ? symbol.replace("USDT", "-USDT")
    : symbol.replace("USDT", "-USDT-SWAP");
  const quantity = (sizeUSD / price).toFixed(6);
  const timestamp = new Date().toISOString();
  const path = "/api/v5/trade/order";
  const bodyObj = tradeMode === "spot"
    ? { instId, tdMode: "cash", side, ordType: "market", sz: quantity }
    : { instId, tdMode: "isolated", lever: String(process.env.LEVERAGE || "1"),
        side, posSide: side === "buy" ? "long" : "short", ordType: "market", sz: quantity };
  const body = JSON.stringify(bodyObj);
  const signature = signOKX(timestamp, "POST", path, body);
  const res = await fetch(`${CONFIG.okx.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "OK-ACCESS-KEY": CONFIG.okx.apiKey,
      "OK-ACCESS-SIGN": signature,
      "OK-ACCESS-TIMESTAMP": timestamp,
      "OK-ACCESS-PASSPHRASE": CONFIG.okx.passphrase,
    },
    body,
  });
  const data = await res.json();
  if (data.code !== "0") throw new Error(`OKX order failed: ${data.msg}`);
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
  const closed = positions.closed || [];
  const open   = positions.open || [];

  console.log("\n══════════════════════════════════════════════════════════");
  console.log("  DMC 策略績效統計");
  console.log("══════════════════════════════════════════════════════════");

  if (open.length > 0) {
    console.log(`\n  目前持倉 (${open.length} 筆):`);
    open.forEach((p) => console.log(`    ${p.side.toUpperCase()} ${p.symbol} — 進場 $${p.entryPrice.toFixed(4)} @ ${p.entryTime.slice(0,16)}`));
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
  const best     = closed.reduce((a,b) => a.pnl > b.pnl ? a : b);
  const worst    = closed.reduce((a,b) => a.pnl < b.pnl ? a : b);

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
  console.log(`  [DMC] ${symbol}`);
  console.log(`${"─".repeat(57)}`);

  const candles = await fetchCandles(symbol, CONFIG.timeframe, 60);
  const price = candles[candles.length - 1].close;
  console.log(`\n  Current price: $${price.toFixed(4)}`);

  // 出場優先
  const openPos = positions.open.find((p) => p.symbol === symbol);
  if (openPos) {
    console.log(`\n── 持倉檢查 (${openPos.side.toUpperCase()} 進場價: $${openPos.entryPrice.toFixed(4)}) ──\n`);
    const { exit, reason } = checkDMCExit(openPos, candles);
    if (exit) {
      const pnl = openPos.side === "long"
        ? (price - openPos.entryPrice) * openPos.quantity
        : (openPos.entryPrice - price) * openPos.quantity;
      const win = pnl > 0;
      console.log(`  ${win ? "✅" : "🔴"} 出場：${reason} | P&L: $${pnl.toFixed(4)}`);
      const closed = { ...openPos, exitPrice: price, exitTime: new Date().toISOString(), exitReason: reason, pnl, win, paperTrading: CONFIG.paperTrading };
      positions.open = positions.open.filter((p) => p.symbol !== symbol);
      positions.closed.push(closed);
      savePositions(positions);
      appendCsvRow([
        new Date().toISOString().slice(0,10),
        new Date().toISOString().slice(11,19),
        "OKX", symbol,
        openPos.side === "long" ? "SELL" : "BUY",
        openPos.quantity.toFixed(6), price.toFixed(4),
        Math.abs(pnl + openPos.tradeSize).toFixed(2),
        (Math.abs(pnl + openPos.tradeSize) * 0.001).toFixed(4),
        pnl.toFixed(4), `EXIT-${Date.now()}`,
        CONFIG.paperTrading ? "PAPER" : "LIVE",
        `"出場: ${reason} | P&L: $${pnl.toFixed(4)}"`,
      ].join(","));
    } else {
      console.log(`  持倉中，繼續持有。`);
    }
    return false;
  }

  // 進場檢查
  const todayCount = countTodaysTrades(log);
  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log("  跳過 — 今日上限已達。");
    return false;
  }

  const { results, allPass, side } = runDMCSafetyCheck(candles);

  // 策略B 止損：最近8根擺動低/高點下方（結構破壞才出場）
  const stopLossPrice = swingStop(candles, side, 8, 0.1);

  // 固定風險倉位：每筆最多虧本金 1%，倉位由止損距離反推
  const riskAmount  = CONFIG.portfolioValue * 0.01;
  const stopLossPct = Math.abs(price - stopLossPrice) / price;
  const maxLeverage = parseFloat(process.env.LEVERAGE || "1");
  const rawSize     = stopLossPct > 0.001 ? riskAmount / stopLossPct : riskAmount * 2;
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
    console.log(`✅ 所有條件符合 — ${side.toUpperCase()} ${symbol}`);
    if (CONFIG.paperTrading) {
      console.log(`\n📋 紙上交易 — ${side} ${symbol}`);
      console.log(`   倉位: $${tradeSize.toFixed(2)} | 風險: $${riskAmount.toFixed(2)} (本金1%) | 止損: ${stopLossPrice.toFixed(6)}`);
      logEntry.orderPlaced = true;
      logEntry.orderId = `DMC-PAPER-${Date.now()}`;
    } else {
      try {
        const order = await placeOKXOrder(symbol, side === "long" ? "buy" : "sell", tradeSize, price, stopLossPrice);
        logEntry.orderPlaced = true;
        logEntry.orderId = order.orderId;
        console.log(`✅ 訂單成立 — ${order.orderId}`);
      } catch (err) {
        console.log(`❌ 下單失敗 — ${err.message}`);
        logEntry.error = err.message;
      }
    }

    if (logEntry.orderPlaced) {
      positions.open.push({ symbol, side, entryPrice: price, entryTime: new Date().toISOString(), tradeSize, quantity, orderId: logEntry.orderId, stopLoss: stopLossPrice, riskAmount });
      savePositions(positions);
      appendCsvRow([
        new Date().toISOString().slice(0,10),
        new Date().toISOString().slice(11,19),
        "OKX", symbol, side === "long" ? "BUY" : "SELL",
        quantity.toFixed(6), price.toFixed(4),
        tradeSize.toFixed(2), (tradeSize*0.001).toFixed(4),
        (tradeSize-(tradeSize*0.001)).toFixed(2),
        logEntry.orderId, CONFIG.paperTrading ? "PAPER" : "LIVE",
        `"進場: DMC ${side}"`,
      ].join(","));
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
  console.log("  DMC-Inspired Trading Bot");
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`);
  console.log("═══════════════════════════════════════════════════════════");

  const rules     = JSON.parse(readFileSync("rules_dmc.json", "utf8"));
  const watchlist = rules.watchlist;
  console.log(`\nStrategy: ${rules.strategy.name}`);
  console.log(`Watchlist: ${watchlist.length} 個幣種 | Timeframe: ${CONFIG.timeframe}`);

  const log       = loadLog();
  const positions = loadPositions();

  if (positions.open.length > 0)
    console.log(`\n目前持倉: ${positions.open.map((p) => `${p.side.toUpperCase()} ${p.symbol}`).join(", ")}`);

  for (const symbol of watchlist) {
    const hasOpen    = positions.open.some((p) => p.symbol === symbol);
    const todayCount = countTodaysTrades(log);
    if (!hasOpen && todayCount >= CONFIG.maxTradesPerDay) {
      if (!positions.open.some((p) => watchlist.slice(watchlist.indexOf(symbol)).includes(p.symbol))) break;
    }
    await runSymbol(symbol, log, positions);
  }

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  DMC 掃描完成");
  console.log("═══════════════════════════════════════════════════════════\n");
}

if (process.argv.includes("--stats")) {
  generateStats();
} else {
  run().catch((err) => { console.error("DMC Bot error:", err); process.exit(1); });
}
