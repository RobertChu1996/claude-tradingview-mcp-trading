/**
 * Strategy E: EMA Trend Pullback (1H)
 * EMA21 > EMA50 確認趨勢，RSI14 回調至 35-52，看漲K棒進場
 * 止損：8根擺動低/高點，目標 2:1 R:R
 * 回測結果（3個月）：勝率 49%，PF 1.41，+$884
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";
import { spawn } from "child_process";
import { LOG_E_FILE as LOG_FILE, POSITIONS_E_FILE as POSITIONS_FILE, PF_FILE, CSV_E_FILE as CSV_FILE, RULES_E_FILE } from "./paths.js";

// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG = {
  timeframe: "1H",
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "100"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "20"),
  paperTrading: process.env.E_PAPER_TRADING !== "false",
  okx: {
    apiKey: process.env.OKX_API_KEY,
    secretKey: process.env.OKX_SECRET_KEY,
    passphrase: process.env.OKX_PASSPHRASE,
    baseUrl: process.env.OKX_BASE_URL || "https://www.okx.com",
  },
};

const CSV_HEADERS = "Date,Time (UTC),Exchange,Symbol,Side,Quantity,Price,Total USD,Fee (est.),Net Amount,Order ID,Mode,Notes";

// ─── Market Data ─────────────────────────────────────────────────────────────

async function fetchCandles(symbol, interval, limit = 100) {
  const map = { "1H": "1h", "4H": "4h", "1D": "1d" };
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${map[interval] || "1h"}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance API error: ${res.status}`);
  return (await res.json()).map((k) => ({
    time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
    low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
  }));
}

// ─── Indicators ──────────────────────────────────────────────────────────────

function calcEMA(closes, period) {
  const k = 2 / (period + 1);
  let val = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) val = closes[i] * k + val * (1 - k);
  return val;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const sl = closes.slice(-(period + 1));
  let gains = 0, losses = 0;
  for (let i = 1; i < sl.length; i++) {
    const d = sl[i] - sl[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const rs = gains / (losses || 0.0001);
  return 100 - 100 / (1 + rs);
}

function calcATR(candles, period = 14) {
  const trs = candles.slice(1).map((c, i) => {
    const prev = candles[i].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
  });
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function swingLow(candles, lookback = 8) {
  return Math.min(...candles.slice(-lookback - 1, -1).map(c => c.low));
}

function swingHigh(candles, lookback = 8) {
  return Math.max(...candles.slice(-lookback - 1, -1).map(c => c.high));
}

// ─── Signal ───────────────────────────────────────────────────────────────────

function checkSignal(candles) {
  if (candles.length < 55) return null;
  const closes = candles.map(c => c.close);
  const price  = closes[closes.length - 1];
  const last   = candles[candles.length - 1];
  const e21    = calcEMA(closes, 21);
  const e50    = calcEMA(closes, 50);
  const r14    = calcRSI(closes, 14);
  const atrVal = calcATR(candles, 14);

  if (!r14 || !atrVal || price < 0.001) return null;

  // 多單：EMA21>EMA50 上升趨勢，RSI14 在 35-52 回調區，看漲K棒
  if (e21 > e50 && price > e50 && r14 >= 35 && r14 <= 52 && last.close > last.open) {
    const sl    = swingLow(candles, 8) - atrVal * 0.1;
    const slPct = Math.abs(price - sl) / price * 100;
    if (slPct < 0.3 || slPct > 3) return null;
    if (sl >= price) return null;
    return { side: "long", stopLoss: sl, atrVal, e21, e50, r14 };
  }

  // 空單：EMA21<EMA50 下降趨勢，RSI14 在 48-65 反彈區，看跌K棒
  if (e21 < e50 && price < e50 && r14 >= 48 && r14 <= 65 && last.close < last.open) {
    const sl    = swingHigh(candles, 8) + atrVal * 0.1;
    const slPct = Math.abs(price - sl) / price * 100;
    if (slPct < 0.3 || slPct > 3) return null;
    if (sl <= price) return null;
    return { side: "short", stopLoss: sl, atrVal, e21, e50, r14 };
  }

  return null;
}

// ─── Exit ─────────────────────────────────────────────────────────────────────

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

function checkExit(position, price) {
  const { side, entryPrice, stopLoss } = position;
  const risk = Math.abs(entryPrice - stopLoss);
  const tp   = side === "long" ? entryPrice + risk * 2 : entryPrice - risk * 2;

  if (side === "long") {
    if (price <= stopLoss) return { exit: true, reason: `止損 $${stopLoss.toFixed(6)}`, exitPrice: stopLoss };
    if (price >= tp)       return { exit: true, reason: `2:1止盈達成 $${tp.toFixed(6)}`, exitPrice: tp };
  } else {
    if (price >= stopLoss) return { exit: true, reason: `止損 $${stopLoss.toFixed(6)}`, exitPrice: stopLoss };
    if (price <= tp)       return { exit: true, reason: `2:1止盈達成 $${tp.toFixed(6)}`, exitPrice: tp };
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

function getPFMultiplier(symbol) {
  try {
    if (!existsSync(PF_FILE)) return 1.0;
    const pf = JSON.parse(readFileSync(PF_FILE, "utf8"))?.E?.[symbol];
    if (!pf || pf < 1.2) return 0.5;
    return 1.0;
  } catch { return 1.0; }
}

function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter((t) => t.timestamp.startsWith(today) && t.orderPlaced).length;
}

function initCsv() {
  if (!existsSync(CSV_FILE)) writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
}

// ─── OKX ─────────────────────────────────────────────────────────────────────

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
    if (parseFloat(sz) < spec.minSz)
      throw new Error(`倉位不足最小下單量：需 ${spec.minSz} 張，只能買 ${sz} 張 (ctVal=${spec.ctVal})`);
    console.log(`  合約規格: ctVal=${spec.ctVal}, 張數=${sz}`);
  } else {
    sz = (sizeUSD / price).toFixed(6);
  }

  const ts = new Date().toISOString();
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
    const exitSide    = side === "buy" ? "sell" : "buy";
    const exitPosSide = side === "buy" ? "long" : "short";
    const tpPx = side === "buy"
      ? price + Math.abs(price - stopLossPrice) * 2
      : price - Math.abs(price - stopLossPrice) * 2;
    const slTs   = new Date().toISOString();
    const slPath = "/api/v5/trade/order-algo";
    const slBody = JSON.stringify({
      instId, tdMode: "isolated", side: exitSide, posSide: exitPosSide,
      ordType: "oco", sz,
      slTriggerPx: stopLossPrice.toFixed(8), slOrdPx: "-1", slTriggerPxType: "last",
      tpTriggerPx: tpPx.toFixed(8),          tpOrdPx: "-1", tpTriggerPxType: "last",
    });
    const slRes = await fetch(`${CONFIG.okx.baseUrl}${slPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "OK-ACCESS-KEY": CONFIG.okx.apiKey,
        "OK-ACCESS-SIGN": signOKX(slTs, "POST", slPath, slBody),
        "OK-ACCESS-TIMESTAMP": slTs,
        "OK-ACCESS-PASSPHRASE": CONFIG.okx.passphrase,
      },
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
        "OK-ACCESS-SIGN": signOKX(ts, "POST", path, body), "OK-ACCESS-TIMESTAMP": ts,
        "OK-ACCESS-PASSPHRASE": CONFIG.okx.passphrase },
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
      "OK-ACCESS-SIGN": signOKX(ts, "POST", path, body), "OK-ACCESS-TIMESTAMP": ts,
      "OK-ACCESS-PASSPHRASE": CONFIG.okx.passphrase },
    body,
  });
  const data = await res.json();
  if (data.code !== "0") throw new Error(`OKX 平倉失敗: ${data.msg}`);
  return data.data[0];
}

async function reconcileWithOKX(positions, watchlist) {
  if (CONFIG.paperTrading || !positions.open.length) return;
  const ts   = new Date().toISOString();
  const path = "/api/v5/account/positions?instType=SWAP";
  try {
    const res = await fetch(`${CONFIG.okx.baseUrl}${path}`, {
      headers: {
        "OK-ACCESS-KEY": CONFIG.okx.apiKey,
        "OK-ACCESS-SIGN": signOKX(ts, "GET", path),
        "OK-ACCESS-TIMESTAMP": ts,
        "OK-ACCESS-PASSPHRASE": CONFIG.okx.passphrase,
      },
    });
    const data = await res.json();
    if (data.code !== "0") { console.log(`  ⚠️ OKX 對帳失敗: ${data.msg}`); return; }

    const okxOpen = new Set(
      (data.data || []).filter(p => parseFloat(p.pos) !== 0)
        .map(p => p.instId.replace("-USDT-SWAP", "USDT"))
    );
    const removed = [];
    for (const p of [...positions.open]) {
      if (okxOpen.has(p.symbol)) continue;
      let exitPrice = null, realPnl = null;
      try {
        const instId = p.symbol.replace("USDT", "-USDT-SWAP");
        const hTs    = new Date().toISOString();
        const hPath  = `/api/v5/account/positions-history?instType=SWAP&instId=${instId}&limit=1`;
        const hRes   = await fetch(`${CONFIG.okx.baseUrl}${hPath}`, {
          headers: { "OK-ACCESS-KEY": CONFIG.okx.apiKey,
            "OK-ACCESS-SIGN": signOKX(hTs, "GET", hPath),
            "OK-ACCESS-TIMESTAMP": hTs, "OK-ACCESS-PASSPHRASE": CONFIG.okx.passphrase },
        });
        const hData = await hRes.json();
        if (hData.code === "0" && hData.data?.[0]) {
          exitPrice = parseFloat(hData.data[0].closeAvgPx);
          realPnl   = parseFloat(hData.data[0].realizedPnl);
        }
      } catch (_) {}

      console.log(`  🔔 [E對帳] ${p.symbol} 已平倉 | 出場$${exitPrice?.toFixed(4) ?? "?"} | P&L $${realPnl?.toFixed(4) ?? "?"}`);
      positions.closed.push({ ...p, exitPrice, exitTime: new Date().toISOString(), exitReason: "OKX SL/TP 觸發", pnl: realPnl });
      removed.push(p.symbol);

      if (exitPrice !== null) {
        const now = new Date();
        appendFileSync(CSV_FILE, [
          now.toISOString().slice(0, 10), now.toISOString().slice(11, 19),
          "OKX", p.symbol, p.side === "long" ? "SELL" : "BUY",
          p.quantity.toFixed(6), exitPrice.toFixed(4),
          Math.abs(realPnl + p.tradeSize).toFixed(2),
          (Math.abs(realPnl + p.tradeSize) * 0.001).toFixed(4),
          realPnl.toFixed(4), `EXIT-OKX-${Date.now()}`, "LIVE", `"OKX SL/TP 觸發"`,
        ].join(",") + "\n");
      }
    }
    positions.open = positions.open.filter(p => !removed.includes(p.symbol));
    savePositions(positions);
  } catch (e) {
    console.log(`  ⚠️ OKX 對帳例外: ${e.message}`);
  }
}

// ─── Run Symbol ───────────────────────────────────────────────────────────────

async function runSymbol(symbol, log, positions) {
  const candles = await fetchCandles(symbol, CONFIG.timeframe, 100);
  const price   = candles[candles.length - 1].close;

  // 出場優先
  const openPos = positions.open.find((p) => p.symbol === symbol);
  if (openPos) {
    if (!openPos.quantity || openPos.quantity === 0) return false;

    const newStop = updateTrailingStop(openPos, price);
    if (newStop !== null) {
      console.log(`  📈 [E:${symbol}] 追蹤止損：$${openPos.stopLoss.toFixed(6)} → $${newStop.toFixed(6)}`);
      openPos.stopLoss = newStop;
      savePositions(positions);
    }

    const { exit, reason, exitPrice: intendedEp } = checkExit(openPos, price);
    if (exit) {
      if (!CONFIG.paperTrading) {
        try {
          await closeOKXPosition(openPos);
          console.log(`  📤 [E:${symbol}] OKX平倉送出`);
        } catch (err) {
          console.log(`  ⚠️ [E:${symbol}] OKX平倉失敗 — ${err.message}（本地狀態仍會更新）`);
        }
      }
      const ep = CONFIG.paperTrading ? (intendedEp ?? price) : price;
      const pnl = openPos.side === "long"
        ? (ep - openPos.entryPrice) * openPos.quantity
        : (openPos.entryPrice - ep) * openPos.quantity;
      const win = pnl > 0;
      console.log(`  ${win ? "✅" : "🔴"} [E:${symbol}] 出場：${reason} | P&L: $${pnl.toFixed(4)}`);
      positions.open = positions.open.filter((p) => p.symbol !== symbol);
      positions.closed.push({ ...openPos, exitPrice: ep, exitTime: new Date().toISOString(), exitReason: reason, pnl, win, paperTrading: CONFIG.paperTrading });
      savePositions(positions);
      appendFileSync(CSV_FILE, [
        new Date().toISOString().slice(0, 10), new Date().toISOString().slice(11, 19),
        "OKX", symbol, openPos.side === "long" ? "SELL" : "BUY",
        openPos.quantity.toFixed(6), price.toFixed(4),
        Math.abs(pnl + openPos.tradeSize).toFixed(2),
        (Math.abs(pnl + openPos.tradeSize) * 0.001).toFixed(4),
        pnl.toFixed(4), `EXIT-${Date.now()}`,
        CONFIG.paperTrading ? "PAPER" : "LIVE",
        `"出場: ${reason} | P&L: $${pnl.toFixed(4)}"`,
      ].join(",") + "\n");
    }
    return false;
  }

  // 進場
  if (countTodaysTrades(log) >= CONFIG.maxTradesPerDay) return false;
  if (positions.open.length >= 4) {
    console.log(`  🚫 [E:${symbol}] 已達最大持倉數(4)，跳過`);
    return false;
  }
  if (price < 0.001) return false;

  const sig = checkSignal(candles);
  if (!sig) return false;

  const pfMult      = getPFMultiplier(symbol);
  const riskAmount  = CONFIG.portfolioValue * 0.01 * pfMult;
  const stopLossPct = Math.abs(price - sig.stopLoss) / price;
  const maxLeverage = parseFloat(process.env.LEVERAGE || "1");
  const rawSize     = stopLossPct > 0.001 ? riskAmount / stopLossPct : riskAmount;
  const tradeSize   = Math.min(rawSize, CONFIG.portfolioValue * maxLeverage, CONFIG.maxTradeSizeUSD);
  const quantity    = tradeSize / price;

  console.log(`✅ [E] 信號 — ${sig.side.toUpperCase()} ${symbol} | 價$${price.toFixed(4)} | EMA21:${sig.e21.toFixed(4)} EMA50:${sig.e50.toFixed(4)} RSI:${sig.r14.toFixed(1)} | SL$${sig.stopLoss.toFixed(4)}`);

  const logEntry = {
    timestamp: new Date().toISOString(), symbol, timeframe: CONFIG.timeframe, price,
    indicators: { e21: sig.e21, e50: sig.e50, r14: sig.r14 },
    allPass: true, tradeSize, orderPlaced: false, orderId: null,
    paperTrading: CONFIG.paperTrading,
  };

  if (CONFIG.paperTrading) {
    console.log(`   📋 模擬 $${tradeSize.toFixed(2)}`);
    logEntry.orderPlaced = true;
    logEntry.orderId = `E-PAPER-${Date.now()}`;
  } else {
    try {
      const order = await placeOKXOrder(symbol, sig.side === "long" ? "buy" : "sell", tradeSize, price, sig.stopLoss);
      logEntry.orderPlaced = true;
      logEntry.orderId = order.ordId;
      logEntry.algoId  = order.algoId;
      console.log(`   🔴 下單成功 — ordId:${order.ordId}`);
      const tp = sig.side === "long" ? price + Math.abs(price - sig.stopLoss) * 2 : price - Math.abs(price - sig.stopLoss) * 2;
      spawn("node", ["tv_mark_trade.js", symbol, sig.side, String(price), String(sig.stopLoss), String(tp)],
        { detached: true, stdio: "ignore" }).unref();
    } catch (err) {
      console.log(`   ❌ 下單失敗 — ${err.message}`);
      logEntry.error = err.message;
    }
  }

  if (logEntry.orderPlaced) {
    positions.open.push({
      symbol, side: sig.side, entryPrice: price,
      entryTime: new Date().toISOString(), tradeSize, quantity,
      orderId: logEntry.orderId, algoId: logEntry.algoId,
      stopLoss: sig.stopLoss, riskAmount,
    });
    savePositions(positions);
    appendFileSync(CSV_FILE, [
      new Date().toISOString().slice(0, 10), new Date().toISOString().slice(11, 19),
      "OKX", symbol, sig.side === "long" ? "BUY" : "SELL",
      quantity.toFixed(6), price.toFixed(4), tradeSize.toFixed(2),
      (tradeSize * 0.001).toFixed(4), (tradeSize - tradeSize * 0.001).toFixed(2),
      logEntry.orderId, CONFIG.paperTrading ? "PAPER" : "LIVE",
      `"進場: EMA拉回 ${sig.side} | RSI:${sig.r14.toFixed(1)} | SL $${sig.stopLoss.toFixed(4)}"`,
    ].join(",") + "\n");
  }

  log.trades.push(logEntry);
  saveLog(log);
  return logEntry.orderPlaced;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  initCsv();
  const rules     = JSON.parse(readFileSync(RULES_E_FILE, "utf8"));
  const watchlist = rules.watchlist;
  const log       = loadLog();
  const positions = loadPositions();

  console.log(`[E] ${new Date().toISOString()} | ${CONFIG.paperTrading ? "PAPER" : "LIVE"} | ${watchlist.length}幣 | 持倉:${positions.open.length}`);

  // 偵測 PAPER→LIVE 切換：清除舊模擬持倉並跳過本輪進場，避免立刻開真實單
  if (!CONFIG.paperTrading) {
    const paperOpen = positions.open.filter(p => p.orderId?.startsWith("E-PAPER-"));
    if (paperOpen.length > 0) {
      console.log(`⚠️ [E] 偵測到 PAPER→LIVE 切換，清除 ${paperOpen.length} 筆模擬持倉，本輪跳過進場`);
      positions.open = positions.open.filter(p => !p.orderId?.startsWith("E-PAPER-"));
      savePositions(positions);
      return;
    }
  }

  await reconcileWithOKX(positions, watchlist);

  const today = new Date().toISOString().slice(0, 10);
  const todayPnl = positions.closed
    .filter(t => t.exitTime?.startsWith(today) && t.pnl !== null)
    .reduce((sum, t) => sum + (t.pnl || 0), 0);
  if (todayPnl < -(CONFIG.portfolioValue * 0.05)) {
    console.log(`⚡ [E熔斷] 今日已虧 $${Math.abs(todayPnl).toFixed(2)}，超過本金 5%，暫停入場`);
    return;
  }

  const orphans = positions.open.filter(p => !watchlist.includes(p.symbol));
  for (const p of orphans) await runSymbol(p.symbol, log, positions);

  for (const symbol of watchlist) {
    await runSymbol(symbol, log, positions);
  }

  console.log(`[E] 掃描完成`);
}

run().catch((err) => { console.error("Bot E error:", err); process.exit(1); });
