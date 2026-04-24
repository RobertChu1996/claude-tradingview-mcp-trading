/**
 * Claude + TradingView MCP — Automated Trading Bot
 *
 * Cloud mode: runs on Railway on a schedule. Pulls candle data direct from
 * Binance (free, no auth), calculates all indicators, runs safety check,
 * executes via BitGet if everything lines up.
 *
 * Local mode: run manually — node bot.js
 * Cloud mode: deploy to Railway, set env vars, Railway triggers on cron schedule
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";
import { execSync } from "child_process";
import { LOG_FILE, POSITIONS_FILE, PF_FILE, CSV_FILE } from "./paths.js";

// ─── Onboarding ───────────────────────────────────────────────────────────────

function checkOnboarding() {
  const required = ["OKX_API_KEY", "OKX_SECRET_KEY", "OKX_PASSPHRASE"];
  const missing = required.filter((k) => !process.env[k]);

  if (!existsSync(".env")) {
    console.log(
      "\n⚠️  No .env file found — opening it for you to fill in...\n",
    );
    writeFileSync(
      ".env",
      [
        "# BitGet credentials",
        "BITGET_API_KEY=",
        "BITGET_SECRET_KEY=",
        "BITGET_PASSPHRASE=",
        "",
        "# Trading config",
        "PORTFOLIO_VALUE_USD=1000",
        "MAX_TRADE_SIZE_USD=100",
        "MAX_TRADES_PER_DAY=3",
        "PAPER_TRADING=true",
        "SYMBOL=BTCUSDT",
        "TIMEFRAME=4H",
      ].join("\n") + "\n",
    );
    try {
      execSync("open .env");
    } catch {}
    console.log(
      "Fill in your BitGet credentials in .env then re-run: node bot.js\n",
    );
    process.exit(0);
  }

  if (missing.length > 0) {
    console.log(`\n⚠️  Missing credentials in .env: ${missing.join(", ")}`);
    console.log("Opening .env for you now...\n");
    try {
      execSync("open .env");
    } catch {}
    console.log("Add the missing values then re-run: node bot.js\n");
    process.exit(0);
  }

  // Always print the CSV location so users know where to find their trade log
  const csvPath = new URL("trades.csv", import.meta.url).pathname;
  console.log(`\n📄 Trade log: ${csvPath}`);
  console.log(
    `   Open in Google Sheets or Excel any time — or tell Claude to move it:\n` +
      `   "Move my trades.csv to ~/Desktop" or "Move it to my Documents folder"\n`,
  );
}

// ─── Config ────────────────────────────────────────────────────────────────

const CONFIG = {
  symbol: process.env.SYMBOL || "BTCUSDT",
  timeframe: process.env.TIMEFRAME || "4H",
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "100"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "3"),
  paperTrading: process.env.A_PAPER_TRADING !== "false",
  tradeMode: process.env.TRADE_MODE || "spot",
  okx: {
    apiKey: process.env.OKX_API_KEY,
    secretKey: process.env.OKX_SECRET_KEY,
    passphrase: process.env.OKX_PASSPHRASE,
    baseUrl: process.env.OKX_BASE_URL || "https://www.okx.com",
  },
};


function getPFMultiplier(symbol) {
  try {
    if (!existsSync(PF_FILE)) return 1.0;
    const pf = JSON.parse(readFileSync(PF_FILE,"utf8"))?.A?.[symbol];
    if (!pf) return 1.0;
    if (pf >= 3.5) return 2.0;
    if (pf >= 2.0) return 1.5;
    if (pf >= 1.2) return 1.0;
    return 0.5;
  } catch { return 1.0; }
}

// ─── Position Tracking ───────────────────────────────────────────────────────

function loadPositions() {
  if (!existsSync(POSITIONS_FILE)) return { open: [], closed: [] };
  return JSON.parse(readFileSync(POSITIONS_FILE, "utf8"));
}

function savePositions(positions) {
  writeFileSync(POSITIONS_FILE, JSON.stringify(positions, null, 2));
}

// 追蹤止損更新：依獲利 R 倍數向上/下移動止損，只鎖利不退讓
function updateTrailingStop(position, currentPrice) {
  const { side, entryPrice, stopLoss } = position;
  const initialRisk = Math.abs(entryPrice - stopLoss);
  if (initialRisk < 0.000001) return null;

  const profit = side === "long" ? currentPrice - entryPrice : entryPrice - currentPrice;
  const profitR = profit / initialRisk;
  if (profitR < 1.0) return null; // 未達 1R 不移動

  // 鎖住 (profitR - 1R)，最低保本
  const lockR = Math.max(0, Math.floor(profitR * 2) / 2 - 1.0);
  const newStop = side === "long"
    ? entryPrice + initialRisk * lockR
    : entryPrice - initialRisk * lockR;

  // 只移動，不退後
  if (side === "long" && newStop > stopLoss) return newStop;
  if (side === "short" && newStop < stopLoss) return newStop;
  return null;
}

function checkExitConditions(position, price, ema8, vwap, rsi3) {
  const { side, stopLoss } = position;

  if (side === "long") {
    if (price <= stopLoss)
      return { exit: true, reason: `止損觸發 $${stopLoss.toFixed(6)}` };
    if (price <= vwap)
      return { exit: true, reason: "價格跌破 VWAP（多頭論點失效）" };
    if (price < ema8)
      return { exit: true, reason: "價格跌破 EMA(8)（趨勢轉弱）" };
    if (rsi3 > 50)
      return { exit: true, reason: "RSI(3) 穿越 50（動能出場）" };
  } else {
    if (price >= stopLoss)
      return { exit: true, reason: `止損觸發 $${stopLoss.toFixed(6)}` };
    if (price >= vwap)
      return { exit: true, reason: "價格突破 VWAP（空頭論點失效）" };
    if (price > ema8)
      return { exit: true, reason: "價格突破 EMA(8)（趨勢轉弱）" };
    if (rsi3 < 50)
      return { exit: true, reason: "RSI(3) 穿越 50（動能出場）" };
  }

  return { exit: false };
}

// ─── Performance Stats ───────────────────────────────────────────────────────

function generateStats() {
  const positions = loadPositions();
  const closed = positions.closed || [];
  const open = positions.open || [];

  console.log("\n══════════════════════════════════════════════════════════");
  console.log("  機器人績效統計");
  console.log("══════════════════════════════════════════════════════════");

  if (open.length > 0) {
    console.log(`\n  目前持倉 (${open.length} 筆):`);
    open.forEach((p) => {
      console.log(`    ${p.side.toUpperCase()} ${p.symbol} — 進場 $${p.entryPrice.toFixed(4)} @ ${p.entryTime.slice(0, 16)}`);
    });
  }

  if (closed.length === 0) {
    console.log("\n  尚無已平倉交易 — 繼續讓機器人運行收集數據。");
    console.log("══════════════════════════════════════════════════════════\n");
    return;
  }

  const wins = closed.filter((t) => t.win);
  const losses = closed.filter((t) => !t.win);
  const totalPnl = closed.reduce((sum, t) => sum + t.pnl, 0);
  const winRate = ((wins.length / closed.length) * 100).toFixed(1);
  const avgWin = wins.length
    ? (wins.reduce((s, t) => s + t.pnl, 0) / wins.length).toFixed(4)
    : "0";
  const avgLoss = losses.length
    ? (losses.reduce((s, t) => s + t.pnl, 0) / losses.length).toFixed(4)
    : "0";
  const best = closed.reduce((a, b) => (a.pnl > b.pnl ? a : b));
  const worst = closed.reduce((a, b) => (a.pnl < b.pnl ? a : b));

  console.log(`\n  已平倉交易    : ${closed.length} 筆`);
  console.log(`  勝率          : ${winRate}%  (${wins.length} 勝 / ${losses.length} 敗)`);
  console.log(`  總損益        : $${totalPnl.toFixed(4)}`);
  console.log(`  平均獲利      : $${avgWin}`);
  console.log(`  平均虧損      : $${avgLoss}`);
  console.log(`  最佳交易      : +$${best.pnl.toFixed(4)} (${best.symbol} ${best.side})`);
  console.log(`  最差交易      : $${worst.pnl.toFixed(4)} (${worst.symbol} ${worst.side})`);

  console.log(`\n  最近 5 筆交易:`);
  closed.slice(-5).reverse().forEach((t) => {
    const icon = t.win ? "✅" : "🔴";
    console.log(`    ${icon} ${t.symbol} ${t.side.toUpperCase()} | P&L: $${t.pnl.toFixed(4)} | ${t.exitReason}`);
  });

  console.log("══════════════════════════════════════════════════════════\n");
}

// ─── Logging ────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(
    (t) => t.timestamp.startsWith(today) && t.orderPlaced,
  ).length;
}

// ─── Market Data (Binance public API — free, no auth) ───────────────────────

async function fetchCandles(symbol, interval, limit = 100) {
  // Map our timeframe format to Binance interval format
  const intervalMap = {
    "1m": "1m",
    "3m": "3m",
    "5m": "5m",
    "15m": "15m",
    "30m": "30m",
    "1H": "1h",
    "4H": "4h",
    "1D": "1d",
    "1W": "1w",
  };
  const binanceInterval = intervalMap[interval] || "1m";

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

// ─── Indicator Calculations ──────────────────────────────────────────────────

function calcEMA(closes, period) {
  const multiplier = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * multiplier + ema * (1 - multiplier);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0,
    losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// VWAP — session-based, resets at midnight UTC
function calcVWAP(candles) {
  const midnightUTC = new Date();
  midnightUTC.setUTCHours(0, 0, 0, 0);
  const sessionCandles = candles.filter((c) => c.time >= midnightUTC.getTime());
  if (sessionCandles.length === 0) return null;
  const cumTPV = sessionCandles.reduce(
    (sum, c) => sum + ((c.high + c.low + c.close) / 3) * c.volume,
    0,
  );
  const cumVol = sessionCandles.reduce((sum, c) => sum + c.volume, 0);
  return cumVol === 0 ? null : cumTPV / cumVol;
}

function calcATR(candles, period = 14) {
  const trs = candles.slice(1).map((c, i) => {
    const prev = candles[i].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
  });
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// 最近 N 根K棒的擺動低點/高點（含 buffer）
function swingStop(candles, side, lookback = 8, bufferMult = 0.1) {
  const recent = candles.slice(-lookback - 1, -1); // 不含當根
  const atr = calcATR(candles, 14);
  if (side === "long") {
    const swingLow = Math.min(...recent.map((c) => c.low));
    return swingLow - atr * bufferMult;
  } else {
    const swingHigh = Math.max(...recent.map((c) => c.high));
    return swingHigh + atr * bufferMult;
  }
}

// ─── Safety Check ───────────────────────────────────────────────────────────

function runSafetyCheck(price, ema8, vwap, rsi3, rules) {
  const results = [];

  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    const icon = pass ? "✅" : "🚫";
    console.log(`  ${icon} ${label}`);
    console.log(`     Required: ${required} | Actual: ${actual}`);
  };

  console.log("\n── Safety Check ─────────────────────────────────────────\n");

  // Determine bias first
  const bullishBias = price > vwap && price > ema8;
  const bearishBias = price < vwap && price < ema8;

  if (bullishBias) {
    console.log("  Bias: BULLISH — checking long entry conditions\n");

    // 1. Price above VWAP
    check(
      "Price above VWAP (buyers in control)",
      `> ${vwap.toFixed(2)}`,
      price.toFixed(2),
      price > vwap,
    );

    // 2. Price above EMA(8)
    check(
      "Price above EMA(8) (uptrend confirmed)",
      `> ${ema8.toFixed(2)}`,
      price.toFixed(2),
      price > ema8,
    );

    // 3. RSI(3) pullback
    check(
      "RSI(3) below 30 (snap-back setup in uptrend)",
      "< 30",
      rsi3.toFixed(2),
      rsi3 < 30,
    );

    // 4. Not overextended from VWAP
    const distFromVWAP = Math.abs((price - vwap) / vwap) * 100;
    check(
      "Price within 1.5% of VWAP (not overextended)",
      "< 1.5%",
      `${distFromVWAP.toFixed(2)}%`,
      distFromVWAP < 1.5,
    );
  } else if (bearishBias) {
    console.log("  Bias: BEARISH — checking short entry conditions\n");

    check(
      "Price below VWAP (sellers in control)",
      `< ${vwap.toFixed(2)}`,
      price.toFixed(2),
      price < vwap,
    );

    check(
      "Price below EMA(8) (downtrend confirmed)",
      `< ${ema8.toFixed(2)}`,
      price.toFixed(2),
      price < ema8,
    );

    check(
      "RSI(3) above 70 (reversal setup in downtrend)",
      "> 70",
      rsi3.toFixed(2),
      rsi3 > 70,
    );

    const distFromVWAP = Math.abs((price - vwap) / vwap) * 100;
    check(
      "Price within 1.5% of VWAP (not overextended)",
      "< 1.5%",
      `${distFromVWAP.toFixed(2)}%`,
      distFromVWAP < 1.5,
    );
  } else {
    console.log("  Bias: NEUTRAL — no clear direction. No trade.\n");
    results.push({
      label: "Market bias",
      required: "Bullish or bearish",
      actual: "Neutral",
      pass: false,
    });
  }

  const allPass = results.every((r) => r.pass);
  return { results, allPass };
}

// ─── Trade Limits ────────────────────────────────────────────────────────────

function checkTradeLimits(log) {
  const todayCount = countTodaysTrades(log);

  console.log("\n── Trade Limits ─────────────────────────────────────────\n");

  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(
      `🚫 Max trades per day reached: ${todayCount}/${CONFIG.maxTradesPerDay}`,
    );
    return false;
  }

  console.log(
    `✅ Trades today: ${todayCount}/${CONFIG.maxTradesPerDay} — within limit`,
  );

  const tradeSize = Math.min(
    CONFIG.portfolioValue * 0.01,
    CONFIG.maxTradeSizeUSD,
  );

  if (tradeSize > CONFIG.maxTradeSizeUSD) {
    console.log(
      `🚫 Trade size $${tradeSize.toFixed(2)} exceeds max $${CONFIG.maxTradeSizeUSD}`,
    );
    return false;
  }

  console.log(
    `✅ Trade size: $${tradeSize.toFixed(2)} — within max $${CONFIG.maxTradeSizeUSD}`,
  );

  return true;
}

// ─── OKX Execution ───────────────────────────────────────────────────────────

function signOKX(timestamp, method, path, body = "") {
  const message = `${timestamp}${method}${path}${body}`;
  return crypto
    .createHmac("sha256", CONFIG.okx.secretKey)
    .update(message)
    .digest("base64");
}

async function placeOKXOrder(symbol, side, sizeUSD, price, stopLossPrice) {
  const instId =
    CONFIG.tradeMode === "spot"
      ? symbol.replace("USDT", "-USDT")
      : symbol.replace("USDT", "-USDT-SWAP");

  const quantity = (sizeUSD / price).toFixed(6);
  const timestamp = new Date().toISOString();
  const path = "/api/v5/trade/order";

  const bodyObj =
    CONFIG.tradeMode === "spot"
      ? { instId, tdMode: "cash", side, ordType: "market", sz: quantity }
      : {
          instId,
          tdMode: "isolated",
          lever: String(process.env.LEVERAGE || "1"),
          side,
          posSide: side === "buy" ? "long" : "short",
          ordType: "market",
          sz: quantity,
        };

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

  // 合約模式：同步掛止損 algo 單（防爆倉）
  if (CONFIG.tradeMode === "futures" && stopLossPrice) {
    const slSide = side === "buy" ? "sell" : "buy";
    const slPosSide = side === "buy" ? "long" : "short";
    const slTs = new Date().toISOString();
    const slPath = "/api/v5/trade/order-algo";
    const slBody = JSON.stringify({
      instId,
      tdMode: "isolated",
      side: slSide,
      posSide: slPosSide,
      ordType: "conditional",
      sz: quantity,
      slTriggerPx: stopLossPrice.toFixed(8),
      slOrdPx: "-1", // market price
      slTriggerPxType: "last",
    });
    const slSig = signOKX(slTs, "POST", slPath, slBody);
    const slRes = await fetch(`${CONFIG.okx.baseUrl}${slPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "OK-ACCESS-KEY": CONFIG.okx.apiKey,
        "OK-ACCESS-SIGN": slSig,
        "OK-ACCESS-TIMESTAMP": slTs,
        "OK-ACCESS-PASSPHRASE": CONFIG.okx.passphrase,
      },
      body: slBody,
    });
    const slData = await slRes.json();
    if (slData.code === "0") {
      console.log(`  🛡️ 止損單已掛 → 觸發價 ${stopLossPrice.toFixed(6)}`);
    } else {
      console.log(`  ⚠️ 止損單失敗 — ${slData.msg}`);
    }
  }

  return order;
}

// ─── Tax CSV Logging ─────────────────────────────────────────────────────────

// Always ensure trades.csv exists with headers — open it in Excel/Sheets any time
function initCsv() {
  if (!existsSync(CSV_FILE)) {
    const funnyNote = `,,,,,,,,,,,"NOTE","Hey, if you're at this stage of the video, you must be enjoying it... perhaps you could hit subscribe now? :)"`;
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n" + funnyNote + "\n");
    console.log(
      `📄 Created ${CSV_FILE} — open in Google Sheets or Excel to track trades.`,
    );
  }
}
const CSV_HEADERS = [
  "Date",
  "Time (UTC)",
  "Exchange",
  "Symbol",
  "Side",
  "Quantity",
  "Price",
  "Total USD",
  "Fee (est.)",
  "Net Amount",
  "Order ID",
  "Mode",
  "Notes",
].join(",");

function writeTradeCsv(logEntry) {
  const now = new Date(logEntry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);

  let side = "";
  let quantity = "";
  let totalUSD = "";
  let fee = "";
  let netAmount = "";
  let orderId = "";
  let mode = "";
  let notes = "";

  if (!logEntry.allPass) {
    const failed = logEntry.conditions
      .filter((c) => !c.pass)
      .map((c) => c.label)
      .join("; ");
    mode = "BLOCKED";
    orderId = "BLOCKED";
    notes = `Failed: ${failed}`;
  } else if (logEntry.paperTrading) {
    side = "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "PAPER";
    notes = "All conditions met";
  } else {
    side = "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "LIVE";
    notes = logEntry.error ? `Error: ${logEntry.error}` : "All conditions met";
  }

  const row = [
    date,
    time,
    "OKX",
    logEntry.symbol,
    side,
    quantity,
    logEntry.price.toFixed(2),
    totalUSD,
    fee,
    netAmount,
    orderId,
    mode,
    `"${notes}"`,
  ].join(",");

  if (!existsSync(CSV_FILE)) {
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  }

  appendFileSync(CSV_FILE, row + "\n");
  console.log(`Tax record saved → ${CSV_FILE}`);
}

// Tax summary command: node bot.js --tax-summary
function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) {
    console.log("No trades.csv found — no trades have been recorded yet.");
    return;
  }

  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const rows = lines.slice(1).map((l) => l.split(","));

  const live = rows.filter((r) => r[11] === "LIVE");
  const paper = rows.filter((r) => r[11] === "PAPER");
  const blocked = rows.filter((r) => r[11] === "BLOCKED");

  const totalVolume = live.reduce((sum, r) => sum + parseFloat(r[7] || 0), 0);
  const totalFees = live.reduce((sum, r) => sum + parseFloat(r[8] || 0), 0);

  console.log("\n── Tax Summary ──────────────────────────────────────────\n");
  console.log(`  Total decisions logged : ${rows.length}`);
  console.log(`  Live trades executed   : ${live.length}`);
  console.log(`  Paper trades           : ${paper.length}`);
  console.log(`  Blocked by safety check: ${blocked.length}`);
  console.log(`  Total volume (USD)     : $${totalVolume.toFixed(2)}`);
  console.log(`  Total fees paid (est.) : $${totalFees.toFixed(4)}`);
  console.log(`\n  Full record: ${CSV_FILE}`);
  console.log("─────────────────────────────────────────────────────────\n");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function runSymbol(symbol, rules, log, positions) {
  console.log(`\n${"─".repeat(57)}`);
  console.log(`  ${symbol}`);
  console.log(`${"─".repeat(57)}`);

  console.log("\n── Fetching market data from Binance ───────────────────\n");
  const candles = await fetchCandles(symbol, CONFIG.timeframe, 500);
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];
  console.log(`  Current price: $${price.toFixed(4)}`);

  const ema8 = calcEMA(closes, 8);
  const vwap = calcVWAP(candles);
  const rsi3 = calcRSI(closes, 3);

  console.log(`  EMA(8):  $${ema8.toFixed(4)}`);
  console.log(`  VWAP:    $${vwap ? vwap.toFixed(4) : "N/A"}`);
  console.log(`  RSI(3):  ${rsi3 ? rsi3.toFixed(2) : "N/A"}`);

  if (!vwap || !rsi3) {
    console.log("\n⚠️  指標數據不足，跳過。");
    return false;
  }

  // ── 出場邏輯：先檢查是否有持倉需要平倉 ──────────────────
  const openPos = positions.open.find((p) => p.symbol === symbol);

  if (openPos) {
    // 追蹤止損：先更新 stopLoss 再判斷出場
    const newStop = updateTrailingStop(openPos, price);
    if (newStop !== null) {
      console.log(`  📈 追蹤止損更新：$${openPos.stopLoss.toFixed(6)} → $${newStop.toFixed(6)}`);
      openPos.stopLoss = newStop;
      savePositions(positions);
    }

    console.log(`\n── 持倉檢查 (${openPos.side.toUpperCase()} 進場價: $${openPos.entryPrice.toFixed(4)} | 止損: $${openPos.stopLoss.toFixed(6)}) ──\n`);
    const { exit, reason } = checkExitConditions(openPos, price, ema8, vwap, rsi3);

    if (exit) {
      const pnl =
        openPos.side === "long"
          ? (price - openPos.entryPrice) * openPos.quantity
          : (openPos.entryPrice - price) * openPos.quantity;
      const win = pnl > 0;

      console.log(`  ${win ? "✅" : "🔴"} 出場訊號：${reason}`);
      console.log(`  損益：$${pnl.toFixed(4)} (${win ? "獲利" : "虧損"})`);

      const closedTrade = {
        ...openPos,
        exitPrice: price,
        exitTime: new Date().toISOString(),
        exitReason: reason,
        pnl,
        win,
        paperTrading: CONFIG.paperTrading,
      };

      positions.open = positions.open.filter((p) => p.symbol !== symbol);
      positions.closed.push(closedTrade);
      savePositions(positions);

      // 寫入 CSV
      appendFileSync(
        CSV_FILE,
        [
          new Date().toISOString().slice(0, 10),
          new Date().toISOString().slice(11, 19),
          "OKX",
          symbol,
          openPos.side === "long" ? "SELL" : "BUY",
          openPos.quantity.toFixed(6),
          price.toFixed(4),
          Math.abs(pnl + openPos.tradeSize).toFixed(2),
          (Math.abs(pnl + openPos.tradeSize) * 0.001).toFixed(4),
          (pnl).toFixed(4),
          `EXIT-${Date.now()}`,
          CONFIG.paperTrading ? "PAPER" : "LIVE",
          `"出場: ${reason} | P&L: $${pnl.toFixed(4)}"`,
        ].join(",") + "\n"
      );
      console.log(`  記錄已儲存 → ${CSV_FILE}`);
    } else {
      console.log(`  持倉中，尚未達出場條件，繼續持有。`);
    }
    return false;
  }

  // ── 進場邏輯：沒有持倉才找新進場機會 ────────────────────
  const withinLimits = checkTradeLimits(log);
  if (!withinLimits) {
    console.log("  跳過 — 今日交易次數已達上限。");
    return false;
  }

  const { results, allPass } = runSafetyCheck(price, ema8, vwap, rsi3, rules);

  // 判斷方向
  const side = price > vwap && price > ema8 ? "long" : "short";

  // 策略A 止損：VWAP 另一側（跌破VWAP = 多頭論點失效）+ ATR buffer 避免雜訊觸發
  const atr14 = calcATR(candles, 14);
  const buffer = atr14 * 0.3;
  const stopLossPrice = side === "long"
    ? vwap - buffer          // 多單：VWAP 下方 0.3 ATR
    : vwap + buffer;         // 空單：VWAP 上方 0.3 ATR

  // 動態風險倉位：PF 加權 × 1%基礎風險，止損距離反推
  const pfMult       = getPFMultiplier(symbol);
  const riskAmount   = CONFIG.portfolioValue * 0.01 * pfMult;
  const stopLossPct  = Math.abs(price - stopLossPrice) / price;
  const maxLeverage  = parseFloat(process.env.LEVERAGE || "1");
  const rawSize      = stopLossPct > 0.001 ? riskAmount / stopLossPct : riskAmount * 3;
  const tradeSize    = Math.min(rawSize, CONFIG.portfolioValue * maxLeverage, CONFIG.maxTradeSizeUSD);
  const quantity     = tradeSize / price;

  console.log("\n── 決策 ─────────────────────────────────────────────────\n");

  const logEntry = {
    timestamp: new Date().toISOString(),
    symbol,
    timeframe: CONFIG.timeframe,
    price,
    indicators: { ema8, vwap, rsi3 },
    conditions: results,
    allPass,
    tradeSize,
    orderPlaced: false,
    orderId: null,
    paperTrading: CONFIG.paperTrading,
    limits: {
      maxTradeSizeUSD: CONFIG.maxTradeSizeUSD,
      maxTradesPerDay: CONFIG.maxTradesPerDay,
      tradesToday: countTodaysTrades(log),
    },
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
      logEntry.orderId = `PAPER-${Date.now()}`;
    } else {
      console.log(`\n🔴 實際下單 — $${tradeSize.toFixed(2)} ${side.toUpperCase()} ${symbol}`);
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
      positions.open.push({
        symbol,
        side,
        entryPrice: price,
        entryTime: new Date().toISOString(),
        tradeSize,
        quantity,
        orderId: logEntry.orderId,
        stopLoss: stopLossPrice,
        riskAmount,
      });
      savePositions(positions);
      console.log(`  持倉已記錄 → ${POSITIONS_FILE}`);
    }
  }

  log.trades.push(logEntry);
  saveLog(log);
  writeTradeCsv(logEntry);

  return logEntry.orderPlaced;
}

async function run() {
  checkOnboarding();
  initCsv();
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Claude Trading Bot");
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`);
  console.log("═══════════════════════════════════════════════════════════");

  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  const watchlist = rules.watchlist || [CONFIG.symbol];

  console.log(`\nStrategy: ${rules.strategy.name}`);
  console.log(`Watchlist: ${watchlist.join(", ")}`);
  console.log(`Timeframe: ${CONFIG.timeframe}`);

  const log = loadLog();
  const positions = loadPositions();

  // 顯示目前持倉狀況
  if (positions.open.length > 0) {
    console.log(`\n目前持倉: ${positions.open.map((p) => `${p.side.toUpperCase()} ${p.symbol}`).join(", ")}`);
  }

  // 先管理不在當前名單的孤立持倉（避免踢出名單後止損失效）
  const orphans = positions.open.filter(p => !watchlist.includes(p.symbol));
  if (orphans.length > 0) {
    console.log(`\n[A] 孤立持倉管理: ${orphans.map(p => p.symbol).join(", ")}`);
    for (const p of orphans) await runSymbol(p.symbol, log, positions);
  }

  for (const symbol of watchlist) {
    const todayCount = countTodaysTrades(log);
    const hasOpenPosition = positions.open.some((p) => p.symbol === symbol);
    // 有持倉的幣種不受每日交易次數限制（需要檢查出場）
    if (!hasOpenPosition && todayCount >= CONFIG.maxTradesPerDay) {
      console.log(`\n🚫 今日交易次數已達上限 (${CONFIG.maxTradesPerDay})，停止尋找新進場。`);
      // 但仍繼續檢查有持倉的幣種
      if (!positions.open.some((p) => watchlist.slice(watchlist.indexOf(symbol)).includes(p.symbol))) break;
    }
    await runSymbol(symbol, rules, log, positions);
  }

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log(`  Scan complete. Decision log → ${LOG_FILE}`);
  console.log("═══════════════════════════════════════════════════════════\n");
}

if (process.argv.includes("--tax-summary")) {
  generateTaxSummary();
} else if (process.argv.includes("--stats")) {
  generateStats();
} else {
  run().catch((err) => {
    console.error("Bot error:", err);
    process.exit(1);
  });
}
