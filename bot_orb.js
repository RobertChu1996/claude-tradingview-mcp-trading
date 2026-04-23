/**
 * Strategy D: Opening Range Breakout (ORB)
 * 每天 UTC 00:00 後第一個30分鐘建立開盤區間（2根15m K棒）
 * 收盤突破上軌做多 / 跌破下軌做空 + 成交量 + ATR 過濾
 * 止損：區間另一側（結構性止損）
 * 目標賺賠比 1:2，文獻記錄勝率 74.56%
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";

// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG = {
  timeframe: "15m",
  orbCandles: 2,           // 開盤區間用幾根 15m K棒（2根 = 30分鐘）
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "388"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "3"),
  paperTrading: process.env.PAPER_TRADING !== "false",
  okx: {
    apiKey: process.env.OKX_API_KEY,
    secretKey: process.env.OKX_SECRET_KEY,
    passphrase: process.env.OKX_PASSPHRASE,
    baseUrl: process.env.OKX_BASE_URL || "https://www.okx.com",
  },
};

const LOG_FILE       = "safety-check-log-orb.json";
const POSITIONS_FILE = "positions_orb.json";
const CSV_FILE       = "trades_orb.csv";
const CSV_HEADERS    = "Date,Time (UTC),Exchange,Symbol,Side,Quantity,Price,Total USD,Fee (est.),Net Amount,Order ID,Mode,Notes";

// ─── Market Data ─────────────────────────────────────────────────────────────

async function fetchCandles(symbol, interval, limit = 200) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const fetch = (await import("node-fetch")).default;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance API error: ${res.status}`);
  const data = await res.json();
  return data.map((k) => ({
    time:   k[0],
    open:   parseFloat(k[1]),
    high:   parseFloat(k[2]),
    low:    parseFloat(k[3]),
    close:  parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// ─── Indicators ──────────────────────────────────────────────────────────────

function calcATR(candles, period = 14) {
  const trs = candles.slice(1).map((c, i) => {
    const prev = candles[i].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
  });
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcAvgATR(candles, period = 14, avgPeriod = 20) {
  // 過去 avgPeriod 根的 ATR 平均，用來判斷目前波動是否夠大
  const results = [];
  for (let i = period; i <= candles.length - 1; i++) {
    const slice = candles.slice(0, i + 1);
    results.push(calcATR(slice, period));
  }
  return results.slice(-avgPeriod).reduce((a, b) => a + b, 0) / Math.min(results.length, avgPeriod);
}

function calcAvgVolume(candles, period = 20) {
  return candles.slice(-period).reduce((s, c) => s + c.volume, 0) / period;
}

// ─── Opening Range ────────────────────────────────────────────────────────────

/**
 * 計算今天 UTC 00:00 後的開盤區間
 * 找出今天第一根 00:00 UTC 15m K棒，取前 orbCandles 根的最高/最低
 */
function calcOpeningRange(candles, orbCandles = 2) {
  const now = Date.now();
  const todayUTCMidnight = new Date();
  todayUTCMidnight.setUTCHours(0, 0, 0, 0);
  const midnight = todayUTCMidnight.getTime();

  // 找今天 UTC 00:00 開始的 K棒
  const todayCandles = candles.filter((c) => c.time >= midnight && c.time < now);

  if (todayCandles.length < orbCandles) {
    return null; // 開盤區間還沒形成
  }

  const orbSlice = todayCandles.slice(0, orbCandles);
  const rangeHigh = Math.max(...orbSlice.map((c) => c.high));
  const rangeLow  = Math.min(...orbSlice.map((c) => c.low));

  return {
    high: rangeHigh,
    low: rangeLow,
    range: rangeHigh - rangeLow,
    formedAt: orbSlice[orbSlice.length - 1].time,
    candles: orbSlice,
  };
}

// ─── Safety Check ────────────────────────────────────────────────────────────

function runORBCheck(candles, orb) {
  const results = [];
  const current = candles[candles.length - 1];
  const price   = current.close;
  const atr     = calcATR(candles, 14);
  const avgAtr  = calcAvgATR(candles, 14, 20);
  const avgVol  = calcAvgVolume(candles, 20);
  const volRatio = current.volume / avgVol;
  const atrRatio = atr / avgAtr;

  const aboveRange = current.close > orb.high;
  const belowRange = current.close < orb.low;

  let side = null;
  if (aboveRange) side = "long";
  else if (belowRange) side = "short";

  const check = (label, pass, detail) => results.push({ label, pass, detail });

  check(
    "收盤突破開盤區間",
    aboveRange || belowRange,
    aboveRange ? `收盤 ${price.toFixed(4)} > 區間上軌 ${orb.high.toFixed(4)}`
    : belowRange ? `收盤 ${price.toFixed(4)} < 區間下軌 ${orb.low.toFixed(4)}`
    : `收盤 ${price.toFixed(4)} 在區間內 [${orb.low.toFixed(4)}, ${orb.high.toFixed(4)}]`
  );

  check(
    "成交量放大 (>1.5x 均量)",
    volRatio > 1.5,
    `當根量 ${volRatio.toFixed(2)}x 均量`
  );

  check(
    "ATR 波動夠大 (>0.8x 均值)",
    atrRatio > 0.8,
    `ATR ${atr.toFixed(6)} vs 均值 ${avgAtr.toFixed(6)} (${atrRatio.toFixed(2)}x)`
  );

  check(
    "突破幅度合理 (不超過 3x ATR)",
    Math.abs(price - (aboveRange ? orb.high : orb.low)) < atr * 3,
    "避免追漲殺跌 — 突破後還沒走太遠"
  );

  const allPass = results.every((r) => r.pass) && side !== null;
  return { results, allPass, side, atr, orb };
}

// ─── Persistence ─────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  try { return JSON.parse(readFileSync(LOG_FILE, "utf8")); }
  catch { return { trades: [] }; }
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function loadPositions() {
  if (!existsSync(POSITIONS_FILE)) return { open: [], closed: [] };
  try { return JSON.parse(readFileSync(POSITIONS_FILE, "utf8")); }
  catch { return { open: [], closed: [] }; }
}

function savePositions(p) {
  writeFileSync(POSITIONS_FILE, JSON.stringify(p, null, 2));
}

function initCsv() {
  if (!existsSync(CSV_FILE)) writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
}

function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter((t) => t.timestamp.startsWith(today) && t.orderPlaced).length;
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

// ─── Exit Logic ──────────────────────────────────────────────────────────────

function checkExitConditions(pos, currentPrice, orb) {
  // 1. 止損：結構性止損觸發
  if (pos.side === "long" && currentPrice <= pos.stopLoss)
    return { exit: true, reason: `止損觸發 ${currentPrice.toFixed(6)} ≤ ${pos.stopLoss.toFixed(6)}` };
  if (pos.side === "short" && currentPrice >= pos.stopLoss)
    return { exit: true, reason: `止損觸發 ${currentPrice.toFixed(6)} ≥ ${pos.stopLoss.toFixed(6)}` };

  // 2. 止盈：達到 1:2 R:R
  const risk = Math.abs(pos.entryPrice - pos.stopLoss);
  const takeProfit = pos.side === "long"
    ? pos.entryPrice + risk * 2
    : pos.entryPrice - risk * 2;

  if (pos.side === "long" && currentPrice >= takeProfit)
    return { exit: true, reason: `止盈 1:2 達成 ${currentPrice.toFixed(6)} ≥ ${takeProfit.toFixed(6)}` };
  if (pos.side === "short" && currentPrice <= takeProfit)
    return { exit: true, reason: `止盈 1:2 達成 ${currentPrice.toFixed(6)} ≤ ${takeProfit.toFixed(6)}` };

  // 3. 價格回到開盤區間內（突破失效）
  if (pos.side === "long" && orb && currentPrice < orb.high)
    return { exit: true, reason: `突破失效：收盤跌回區間內 ${currentPrice.toFixed(6)} < ${orb.high.toFixed(6)}` };
  if (pos.side === "short" && orb && currentPrice > orb.low)
    return { exit: true, reason: `突破失效：收盤漲回區間內 ${currentPrice.toFixed(6)} > ${orb.low.toFixed(6)}` };

  return { exit: false, reason: null };
}

// ─── OKX Execution ───────────────────────────────────────────────────────────

function signOKX(ts, method, path, body = "") {
  return crypto.createHmac("sha256", CONFIG.okx.secretKey)
    .update(`${ts}${method}${path}${body}`).digest("base64");
}

async function placeOKXOrder(symbol, side, sizeUSD, price, stopLossPrice) {
  const fetch = (await import("node-fetch")).default;
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
    const slTs   = new Date().toISOString();
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
        "OK-ACCESS-SIGN": slSig, "OK-ACCESS-TIMESTAMP": slTs,
        "OK-ACCESS-PASSPHRASE": CONFIG.okx.passphrase },
      body: slBody,
    });
    const slData = await slRes.json();
    console.log(slData.code === "0"
      ? `  🛡️ 止損單已掛 → 觸發價 ${stopLossPrice.toFixed(6)}`
      : `  ⚠️ 止損單失敗 — ${slData.msg}`);
  }
  return order;
}

// ─── Stats ───────────────────────────────────────────────────────────────────

function generateStats() {
  const positions = loadPositions();
  const closed = positions.closed || [];
  if (closed.length === 0) {
    console.log("\n📊 策略D (ORB) — 尚無平倉記錄\n");
    return;
  }
  const wins = closed.filter((t) => t.win).length;
  const totalPnl = closed.reduce((s, t) => s + (t.pnl || 0), 0);
  const winRate = ((wins / closed.length) * 100).toFixed(1);
  const avgWin  = closed.filter((t) => t.win).reduce((s, t) => s + t.pnl, 0) / (wins || 1);
  const avgLoss = closed.filter((t) => !t.win).reduce((s, t) => s + t.pnl, 0) / ((closed.length - wins) || 1);
  const rr = Math.abs(avgWin / avgLoss).toFixed(2);
  console.log(`\n📊 策略D (ORB) 統計`);
  console.log(`  平倉次數: ${closed.length} | 勝率: ${winRate}% | 總損益: $${totalPnl.toFixed(2)}`);
  console.log(`  均獲利: $${avgWin.toFixed(2)} | 均虧損: $${avgLoss.toFixed(2)} | R:R ${rr}`);
  console.log(`  開倉: ${positions.open.length} 筆\n`);
}

// ─── Main per-symbol ─────────────────────────────────────────────────────────

async function runSymbol(symbol, log, positions) {
  console.log(`\n${"─".repeat(57)}`);
  console.log(`  ${symbol}`);
  console.log(`${"─".repeat(57)}`);

  const candles = await fetchCandles(symbol, CONFIG.timeframe, 200);
  const price   = candles[candles.length - 1].close;
  console.log(`  現價: $${price.toFixed(6)}`);

  const orb = calcOpeningRange(candles, CONFIG.orbCandles);
  if (!orb) {
    console.log("  ⏳ 開盤區間尚未形成（UTC 00:00 後不足 30 分鐘），跳過。");
    return false;
  }
  console.log(`  📐 開盤區間: $${orb.low.toFixed(6)} – $${orb.high.toFixed(6)} (range: ${orb.range.toFixed(6)})`);

  // ── 出場邏輯 ──────────────────────────────────────────────
  const openPos = positions.open.find((p) => p.symbol === symbol);
  if (openPos) {
    const newStop = updateTrailingStop(openPos, price);
    if (newStop !== null) {
      console.log(`  📈 追蹤止損更新：$${openPos.stopLoss.toFixed(6)} → $${newStop.toFixed(6)}`);
      openPos.stopLoss = newStop;
      savePositions(positions);
    }
    console.log(`\n── 持倉檢查 (${openPos.side.toUpperCase()} 進場: $${openPos.entryPrice.toFixed(6)} | 止損: $${openPos.stopLoss.toFixed(6)}) ──\n`);
    const { exit, reason } = checkExitConditions(openPos, price, orb);

    if (exit) {
      const pnl = openPos.side === "long"
        ? (price - openPos.entryPrice) * openPos.quantity
        : (openPos.entryPrice - price) * openPos.quantity;
      const win = pnl > 0;

      console.log(`  ${win ? "✅" : "🔴"} 出場：${reason}`);
      console.log(`  損益：$${pnl.toFixed(4)} (${win ? "獲利" : "虧損"})`);

      const closedTrade = { ...openPos, exitPrice: price, exitTime: new Date().toISOString(), exitReason: reason, pnl, win };
      positions.closed.push(closedTrade);
      positions.open = positions.open.filter((p) => p.symbol !== symbol);
      savePositions(positions);

      appendFileSync(CSV_FILE, [
        new Date().toISOString().slice(0, 10), new Date().toISOString().slice(11, 19),
        "OKX", symbol, openPos.side === "long" ? "SELL" : "BUY",
        openPos.quantity.toFixed(6), price.toFixed(6),
        Math.abs(pnl + openPos.tradeSize).toFixed(2),
        (Math.abs(pnl + openPos.tradeSize) * 0.001).toFixed(4),
        pnl.toFixed(4), `EXIT-${Date.now()}`,
        CONFIG.paperTrading ? "PAPER" : "LIVE",
        `"出場: ${reason} | P&L: $${pnl.toFixed(4)}"`,
      ].join(",") + "\n");
    } else {
      const floatPnl = openPos.side === "long"
        ? (price - openPos.entryPrice) * openPos.quantity
        : (openPos.entryPrice - price) * openPos.quantity;
      console.log(`  持倉中，浮動損益: $${floatPnl.toFixed(4)}`);
    }
    return false;
  }

  // ── 時間窗口：只在 UTC 00:30 ~ 04:00 找進場 ──────────────
  const utcHour = new Date().getUTCHours();
  const utcMin  = new Date().getUTCMinutes();
  const utcMins = utcHour * 60 + utcMin;
  const inWindow = utcMins >= 30 && utcMins <= 240; // 00:30 ~ 04:00
  if (!inWindow) {
    console.log(`  ⏰ 進場窗口外 (UTC ${utcHour}:${String(utcMin).padStart(2,"0")})，只管理持倉。`);
    return false;
  }

  // ── 進場邏輯 ──────────────────────────────────────────────
  if (countTodaysTrades(log) >= CONFIG.maxTradesPerDay) {
    console.log("  跳過 — 今日上限已達。");
    return false;
  }

  const { results, allPass, side, atr } = runORBCheck(candles, orb);

  // 止損：區間另一側 + 0.5 ATR buffer（結構性止損）
  const stopLossPrice = side === "long"
    ? orb.low - atr * 0.5
    : orb.high + atr * 0.5;

  // 固定風險倉位：每筆最多虧本金 1%
  const riskAmount  = CONFIG.portfolioValue * 0.01;
  const stopLossPct = Math.abs(price - stopLossPrice) / price;
  const maxLeverage = parseFloat(process.env.LEVERAGE || "1");
  const rawSize     = stopLossPct > 0.001 ? riskAmount / stopLossPct : riskAmount * 2;
  const tradeSize   = Math.min(rawSize, CONFIG.portfolioValue * maxLeverage, CONFIG.maxTradeSizeUSD);
  const quantity    = tradeSize / price;

  console.log("\n── 決策 ─────────────────────────────────────────────────\n");
  results.forEach((r) => console.log(`  ${r.pass ? "✅" : "❌"} ${r.label}: ${r.detail}`));

  const logEntry = {
    timestamp: new Date().toISOString(), symbol,
    timeframe: CONFIG.timeframe, price,
    orb: { high: orb.high, low: orb.low },
    conditions: results, allPass, tradeSize,
    orderPlaced: false, orderId: null,
    paperTrading: CONFIG.paperTrading,
  };

  if (!allPass) {
    const failed = results.filter((r) => !r.pass).map((r) => r.label);
    console.log(`\n🚫 不進場`);
    failed.forEach((f) => console.log(`   - ${f}`));
  } else {
    console.log(`\n✅ ORB 突破確認 — ${side.toUpperCase()} ${symbol}`);
    console.log(`   倉位: $${tradeSize.toFixed(2)} | 風險: $${riskAmount.toFixed(2)} (本金1%) | 止損: ${stopLossPrice.toFixed(6)}`);
    const risk = Math.abs(price - stopLossPrice);
    const tp = side === "long" ? price + risk * 2 : price - risk * 2;
    console.log(`   止盈目標: ${tp.toFixed(6)} (1:2 R:R)`);

    if (CONFIG.paperTrading) {
      logEntry.orderPlaced = true;
      logEntry.orderId = `ORB-PAPER-${Date.now()}`;
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
      positions.open.push({
        symbol, side, entryPrice: price,
        entryTime: new Date().toISOString(),
        tradeSize, quantity, orderId: logEntry.orderId,
        stopLoss: stopLossPrice, riskAmount,
        orb: { high: orb.high, low: orb.low },
      });
      savePositions(positions);

      appendFileSync(CSV_FILE, [
        new Date().toISOString().slice(0, 10), new Date().toISOString().slice(11, 19),
        "OKX", symbol, side === "long" ? "BUY" : "SELL",
        quantity.toFixed(6), price.toFixed(6), tradeSize.toFixed(2),
        (tradeSize * 0.001).toFixed(4), (tradeSize * 0.999).toFixed(2),
        logEntry.orderId, CONFIG.paperTrading ? "PAPER" : "LIVE",
        `"ORB 突破 | 區間: ${orb.low.toFixed(6)}-${orb.high.toFixed(6)} | 止損: ${stopLossPrice.toFixed(6)}"`,
      ].join(",") + "\n");
    }
  }

  log.trades.push(logEntry);
  saveLog(log);
  return logEntry.orderPlaced;
}

// ─── Entry ───────────────────────────────────────────────────────────────────

async function run() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  策略D：Opening Range Breakout (ORB)");
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`);
  console.log(`  開盤區間：UTC 00:00 後前 ${CONFIG.orbCandles * 15} 分鐘`);
  console.log("═══════════════════════════════════════════════════════════");

  if (process.argv[2] === "--stats") { generateStats(); return; }

  const orbFile = existsSync("rules_orb.json") ? "rules_orb.json" : "rules_bb.json";
  const rules = JSON.parse(readFileSync(orbFile, "utf8"));
  const log = loadLog();
  const positions = loadPositions();

  let entered = 0;
  for (const symbol of rules.watchlist) {
    try {
      const traded = await runSymbol(symbol, log, positions);
      if (traded) entered++;
    } catch (err) {
      console.error(`  ⚠️ ${symbol} 錯誤: ${err.message}`);
    }
  }

  console.log(`\n✅ ORB 掃描完成 — 今日進場 ${entered} 筆\n`);
}

run().catch(console.error);
