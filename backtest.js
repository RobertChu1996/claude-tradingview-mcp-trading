/**
 * 四策略歷史回測
 * 從 Binance 下載過去 3 個月歷史數據，模擬策略邏輯逐K棒走訪
 * 輸出：勝率、R:R、最大回撤、總損益
 *
 * 用法：
 *   node backtest.js          → 回測全部四個策略（前20個幣種）
 *   node backtest.js A        → 只回測策略A
 *   node backtest.js B 50     → 策略B，前50個幣種
 */

import { readFileSync } from "fs";

const STRATEGY = process.argv[2]?.toUpperCase() || "ALL";
const SYMBOL_LIMIT = parseInt(process.argv[3] || "20");
const USE_MASTER = process.argv.includes("--master");
const PORTFOLIO = 388;
const RISK_PER_TRADE = 0.01; // 1%

// ─── Binance Historical Data ──────────────────────────────────────────────────

async function fetchHistoricalCandles(symbol, interval, months = 3) {
  const fetch = (await import("node-fetch")).default;
  const msPerCandle = { "15m": 15*60*1000, "1h": 60*60*1000, "4h": 4*60*60*1000 };
  const ms = msPerCandle[interval] || 60*60*1000;
  const totalCandles = Math.ceil((months * 30 * 24 * 60 * 60 * 1000) / ms);
  const allCandles = [];
  let endTime = Date.now();

  while (allCandles.length < totalCandles) {
    const limit = Math.min(1000, totalCandles - allCandles.length);
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&endTime=${endTime}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance ${res.status}`);
    const data = await res.json();
    if (!data.length) break;
    const candles = data.map(k => ({
      time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
      low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
    }));
    allCandles.unshift(...candles);
    endTime = data[0][0] - 1;
    if (data.length < limit) break;
  }
  return allCandles.sort((a, b) => a.time - b.time);
}

// ─── Indicators ───────────────────────────────────────────────────────────────

function ema(closes, period) {
  const k = 2 / (period + 1);
  let val = closes[0];
  for (let i = 1; i < closes.length; i++) val = closes[i] * k + val * (1 - k);
  return val;
}

function sma(closes, period) {
  const sl = closes.slice(-period);
  return sl.reduce((a, b) => a + b, 0) / sl.length;
}

function rsi(closes, period) {
  if (closes.length < period + 1) return null;
  const sl = closes.slice(-period - 1);
  let gains = 0, losses = 0;
  for (let i = 1; i < sl.length; i++) {
    const d = sl[i] - sl[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const rs = gains / (losses || 0.0001);
  return 100 - 100 / (1 + rs);
}

function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = candles.slice(1).map((c, i) => {
    const prev = candles[i].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
  });
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function vwap(candles) {
  const midnight = new Date(candles[candles.length - 1].time);
  midnight.setUTCHours(0, 0, 0, 0);
  const session = candles.filter(c => c.time >= midnight.getTime());
  if (!session.length) return null;
  const tpv = session.reduce((s, c) => s + ((c.high + c.low + c.close) / 3) * c.volume, 0);
  const vol = session.reduce((s, c) => s + c.volume, 0);
  return vol ? tpv / vol : null;
}

function bb(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  const sl = closes.slice(-period);
  const mid = sl.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(sl.reduce((s, c) => s + (c - mid) ** 2, 0) / period);
  return { upper: mid + mult * std, middle: mid, lower: mid - mult * std };
}

function avgVol(candles, period = 20) {
  return candles.slice(-period).reduce((s, c) => s + c.volume, 0) / period;
}

function swingLow(candles, lookback = 8) {
  return Math.min(...candles.slice(-lookback - 1, -1).map(c => c.low));
}

function swingHigh(candles, lookback = 8) {
  return Math.max(...candles.slice(-lookback - 1, -1).map(c => c.high));
}

// ─── Position Sizing ──────────────────────────────────────────────────────────

function calcSize(price, stopLossPrice, portfolio = PORTFOLIO) {
  const risk = portfolio * RISK_PER_TRADE;
  const pct = Math.abs(price - stopLossPrice) / price;
  if (pct < 0.001) return { tradeSize: risk * 2, quantity: (risk * 2) / price };
  const tradeSize = Math.min(risk / pct, portfolio);
  return { tradeSize, quantity: tradeSize / price };
}

// ─── Trailing Stop ────────────────────────────────────────────────────────────

function calcTrailingStop(pos, currentPrice) {
  const { side, entryPrice, stopLoss } = pos;
  const initialRisk = Math.abs(entryPrice - stopLoss);
  if (!initialRisk) return stopLoss;
  const profit = side === "long" ? currentPrice - entryPrice : entryPrice - currentPrice;
  const profitR = profit / initialRisk;
  if (profitR < 1.0) return stopLoss;
  const lockR = Math.max(0, Math.floor(profitR * 2) / 2 - 1.0);
  const newStop = side === "long"
    ? entryPrice + initialRisk * lockR
    : entryPrice - initialRisk * lockR;
  if (side === "long") return Math.max(stopLoss, newStop);
  return Math.min(stopLoss, newStop);
}

// ─── Strategy Signal Functions ────────────────────────────────────────────────

function adx(candles, period = 14) {
  if (candles.length < period + 2) return 0;
  const dms = candles.slice(1).map((c, i) => {
    const upMove = c.high - candles[i].high;
    const downMove = candles[i].low - c.low;
    return {
      plus: upMove > downMove && upMove > 0 ? upMove : 0,
      minus: downMove > upMove && downMove > 0 ? downMove : 0,
      tr: Math.max(c.high - c.low, Math.abs(c.high - candles[i].close), Math.abs(c.low - candles[i].close)),
    };
  });
  const s = dms.slice(-period);
  const sumTR = s.reduce((a, d) => a + d.tr, 0);
  const sumP  = s.reduce((a, d) => a + d.plus, 0);
  const sumM  = s.reduce((a, d) => a + d.minus, 0);
  if (!sumTR) return 0;
  const diP = sumP / sumTR * 100;
  const diM = sumM / sumTR * 100;
  return Math.abs(diP - diM) / ((diP + diM) || 1) * 100;
}

function signalA(candles) {
  // VWAP + RSI(3) + EMA(8)
  if (candles.length < 30) return null;
  const closes = candles.map(c => c.close);
  const price = closes[closes.length - 1];
  const e8 = ema(closes, 8);
  const v = vwap(candles);
  const r3 = rsi(closes, 3);
  if (!v || !r3) return null;

  const atrVal = atr(candles, 14);
  if (!atrVal) return null;

  // 微價幣過濾：price < $0.001 的幣 spread/滑點會穿透止損
  if (price < 0.001) return null;

  const adxVal = adx(candles, 14);
  if (adxVal < 25) return null; // ADX > 25 趨勢強度過濾（收緊）

  if (price > v && price > e8 && r3 < 20) { // RSI < 20（收緊，原 30）
    const sl = v - atrVal * 0.15;
    const slPct = Math.abs(price - sl) / price * 100;
    if (slPct < 0.2 || slPct > 1.5) return null;
    return { side: "long", stopLoss: sl };
  }
  if (price < v && price < e8 && r3 > 80) { // RSI > 80（收緊，原 70）
    const sl = v + atrVal * 0.15;
    const slPct = Math.abs(price - sl) / price * 100;
    if (slPct < 0.2 || slPct > 1.5) return null;
    return { side: "short", stopLoss: sl };
  }
  return null;
}

function exitA(pos, candles) {
  const closes = candles.map(c => c.close);
  const price = closes[closes.length - 1];
  const sl = calcTrailingStop(pos, price);

  const initialRisk = Math.abs(pos.entryPrice - pos.stopLoss);
  const tp = pos.side === "long"
    ? pos.entryPrice + initialRisk * 2
    : pos.entryPrice - initialRisk * 2;

  // 只留 SL + 2:1 TP，移除 VWAP/RSI 中途出場
  if (pos.side === "long") {
    if (price <= sl) return `止損 $${sl.toFixed(4)}`;
    if (price >= tp) return "2:1止盈達成";
  } else {
    if (price >= sl) return `止損 $${sl.toFixed(4)}`;
    if (price <= tp) return "2:1止盈達成";
  }
  return null;
}

function signalB(candles) {
  // DMC: SMA20 + Volume + Candle Strength + Structure
  if (candles.length < 25) return null;
  const closes = candles.map(c => c.close);
  const price = closes[closes.length - 1];
  const s20now = sma(closes, 20);
  const s20prev = sma(closes.slice(0, -5), 20);
  const last = candles[candles.length - 1];
  const volR = last.volume / avgVol(candles, 20);
  const body = Math.abs(last.close - last.open);
  const range = last.high - last.low || 0.0001;
  const strength = body / range;

  const rec3 = closes.slice(-3).reduce((a, b) => a + b, 0) / 3;
  const prev3 = closes.slice(-6, -3).reduce((a, b) => a + b, 0) / 3;

  if (s20now > s20prev && price > s20now && volR > 1.5 &&
      last.close > last.open && strength > 0.6 && rec3 > prev3) {
    const sl = swingLow(candles, 8) - atr(candles, 14) * 0.1;
    return { side: "long", stopLoss: sl };
  }
  if (s20now < s20prev && price < s20now && volR > 1.5 &&
      last.close < last.open && strength > 0.6 && rec3 < prev3) {
    const sl = swingHigh(candles, 8) + atr(candles, 14) * 0.1;
    return { side: "short", stopLoss: sl };
  }
  return null;
}

function exitB(pos, candles) {
  const closes = candles.map(c => c.close);
  const price = closes[closes.length - 1];
  const sl = calcTrailingStop(pos, price);
  const risk = Math.abs(pos.entryPrice - pos.stopLoss);
  const tp = pos.side === "long" ? pos.entryPrice + risk * 2 : pos.entryPrice - risk * 2;

  // 只留 SL + 2:1 TP，移除 SMA20/強勢K棒中途出場
  if (pos.side === "long") {
    if (price <= sl) return `止損 $${sl.toFixed(4)}`;
    if (price >= tp) return "2:1止盈達成";
  } else {
    if (price >= sl) return `止損 $${sl.toFixed(4)}`;
    if (price <= tp) return "2:1止盈達成";
  }
  return null;
}

function signalC(candles) {
  // BB Breakout + ATR
  if (candles.length < 25) return null;
  const closes = candles.map(c => c.close);
  const price = closes[closes.length - 1];
  const prevClose = closes[closes.length - 2];
  const bbVal = bb(closes, 20, 2);
  const atrVal = atr(candles, 14);
  const avgAtrVal = (() => {
    const vals = [];
    for (let i = 14; i <= Math.min(candles.length - 1, 24); i++)
      vals.push(atr(candles.slice(0, i + 1), 14));
    return vals.reduce((a, b) => a + b, 0) / (vals.length || 1);
  })();
  const volR = candles[candles.length - 1].volume / avgVol(candles, 20);
  const s20now = sma(closes, 20);
  const s20prev = sma(closes.slice(0, -1), 20);

  if (!bbVal || !atrVal) return null;
  if (price < 0.001) return null;  // 微價幣過濾

  // SMA20 斜率 0.1% 閾值（拒絕橫盤）
  const smaTrendUp   = s20now > s20prev * 1.001;
  const smaTrendDown = s20now < s20prev * 0.999;

  if (price > bbVal.upper && prevClose <= bbVal.upper &&
      volR > 1.5 && smaTrendUp && atrVal > avgAtrVal) {
    const entryCandle = candles[candles.length - 1];
    const sl = entryCandle.low - atrVal * 0.5;
    const slPct = Math.abs(price - sl) / price * 100;
    if (slPct < 1.0 || slPct > 5) return null; // 最小SL 1%
    return { side: "long", stopLoss: sl };
  }
  if (price < bbVal.lower && prevClose >= bbVal.lower &&
      volR > 1.5 && smaTrendDown && atrVal > avgAtrVal) {
    const entryCandle = candles[candles.length - 1];
    const sl = entryCandle.high + atrVal * 0.5;
    const slPct = Math.abs(price - sl) / price * 100;
    if (slPct < 1.0 || slPct > 5) return null;
    return { side: "short", stopLoss: sl };
  }
  return null;
}

function exitC(pos, candles) {
  const closes = candles.map(c => c.close);
  const price = closes[closes.length - 1];
  const bbVal = bb(closes, 20, 2);
  const sl = calcTrailingStop(pos, price);
  const risk = Math.abs(pos.entryPrice - pos.stopLoss);
  const tp = pos.side === "long" ? pos.entryPrice + risk * 2 : pos.entryPrice - risk * 2;
  if (!bbVal) return null;

  // 移除 BB 中軌出場，保留 SL + 2:1 TP + 突破失效
  if (pos.side === "long") {
    if (price <= sl) return `ATR止損 $${sl.toFixed(4)}`;
    if (price >= tp) return "2:1止盈達成";
    if (price < bbVal.upper && closes[closes.length - 2] > bbVal.upper)
                     return "突破失效";
  } else {
    if (price >= sl) return `ATR止損 $${sl.toFixed(4)}`;
    if (price <= tp) return "2:1止盈達成";
    if (price > bbVal.lower && closes[closes.length - 2] < bbVal.lower)
                     return "突破失效";
  }
  return null;
}

function signalD(candles) {
  // ORB: UTC 00:00 開盤區間突破
  if (candles.length < 25) return null;
  const last = candles[candles.length - 1];
  const utcH = new Date(last.time).getUTCHours();
  const utcM = new Date(last.time).getUTCMinutes();
  const mins = utcH * 60 + utcM;
  if (mins < 30 || mins > 240) return null; // 只在 00:30-04:00 UTC

  const midnight = new Date(last.time);
  midnight.setUTCHours(0, 0, 0, 0);
  const todayC = candles.filter(c => c.time >= midnight.getTime() && c.time < last.time);
  if (todayC.length < 2) return null;
  const orbC = todayC.slice(0, 2);
  const orbHigh = Math.max(...orbC.map(c => c.high));
  const orbLow  = Math.min(...orbC.map(c => c.low));

  const atrVal = atr(candles, 14);
  const avgAtrVal = (() => {
    const vals = [];
    for (let i = 14; i <= Math.min(candles.length - 1, 34); i++)
      vals.push(atr(candles.slice(0, i + 1), 14));
    return vals.reduce((a, b) => a + b, 0) / (vals.length || 1);
  })();
  const volR = last.volume / avgVol(candles, 20);
  if (!atrVal) return null;

  if (last.close > orbHigh && volR > 1.5 && atrVal > avgAtrVal * 0.8) {
    return { side: "long", stopLoss: orbLow - atrVal * 0.5, orb: { high: orbHigh, low: orbLow } };
  }
  if (last.close < orbLow && volR > 1.5 && atrVal > avgAtrVal * 0.8) {
    return { side: "short", stopLoss: orbHigh + atrVal * 0.5, orb: { high: orbHigh, low: orbLow } };
  }
  return null;
}

function exitD(pos, candles) {
  const price = candles[candles.length - 1].close;
  const sl = calcTrailingStop(pos, price);
  const orb = pos.orb;
  const risk = Math.abs(pos.entryPrice - pos.stopLoss);
  const tp = pos.side === "long" ? pos.entryPrice + risk * 2 : pos.entryPrice - risk * 2;

  if (pos.side === "long") {
    if (price <= sl) return `止損 $${sl.toFixed(4)}`;
    if (price >= tp) return "1:2止盈達成";
    if (orb && price < orb.high) return "突破失效";
  } else {
    if (price >= sl) return `止損 $${sl.toFixed(4)}`;
    if (price <= tp) return "1:2止盈達成";
    if (orb && price > orb.low) return "突破失效";
  }
  return null;
}

// ─── Indicator Helpers (H/I/J/K) ─────────────────────────────────────────────

function calcMACDObj(closes) {
  if (closes.length < 36) return null;
  const emaArr = (arr, p) => {
    const k = 2 / (p + 1);
    let v = arr.slice(0, p).reduce((a, b) => a + b) / p;
    const out = [v];
    for (let i = p; i < arr.length; i++) { v = arr[i] * k + v * (1 - k); out.push(v); }
    return out;
  };
  const fast = emaArr(closes, 12);
  const slow = emaArr(closes, 26);
  const macdLine = slow.map((s, i) => fast[fast.length - slow.length + i] - s);
  const k9 = 2 / 10;
  let sig = macdLine.slice(0, 9).reduce((a, b) => a + b) / 9;
  const sigArr = [sig];
  for (let i = 9; i < macdLine.length; i++) { sig = macdLine[i] * k9 + sig * (1 - k9); sigArr.push(sig); }
  return {
    macd: macdLine[macdLine.length - 1], signal: sigArr[sigArr.length - 1],
    prevMacd: macdLine[macdLine.length - 2], prevSignal: sigArr[sigArr.length - 2],
  };
}

function calcStochK(candles, period = 14, smooth = 3) {
  if (candles.length < period + smooth) return null;
  const rawKs = [];
  for (let i = candles.length - smooth; i < candles.length; i++) {
    const sl = candles.slice(i - period + 1, i + 1);
    const lo = Math.min(...sl.map(c => c.low));
    const hi = Math.max(...sl.map(c => c.high));
    rawKs.push(hi === lo ? 50 : (candles[i].close - lo) / (hi - lo) * 100);
  }
  return rawKs.reduce((a, b) => a + b) / rawKs.length;
}

function calcIchimoku(candles) {
  if (candles.length < 80) return null;
  const mid = (arr, n) => {
    const sl = arr.slice(-n);
    return (Math.max(...sl.map(c => c.high)) + Math.min(...sl.map(c => c.low))) / 2;
  };
  const tenkan = mid(candles, 9);
  const kijun  = mid(candles, 26);
  const past   = candles.slice(0, -26);
  const spanA  = (mid(past, 9) + mid(past, 26)) / 2;
  const spanB  = mid(past, 52);
  const prev   = candles.slice(0, -1);
  return {
    tenkan, kijun,
    cloudTop: Math.max(spanA, spanB), cloudBottom: Math.min(spanA, spanB),
    prevTenkan: mid(prev, 9), prevKijun: mid(prev, 26),
  };
}

function calcKeltner(candles, emaPeriod = 20, atrPeriod = 14, mult = 2) {
  if (candles.length < emaPeriod) return null;
  const closes = candles.map(c => c.close);
  const k = 2 / (emaPeriod + 1);
  let mid = closes.slice(0, emaPeriod).reduce((a, b) => a + b) / emaPeriod;
  for (let i = emaPeriod; i < closes.length; i++) mid = closes[i] * k + mid * (1 - k);
  const a = atr(candles, atrPeriod);
  return { upper: mid + mult * a, middle: mid, lower: mid - mult * a };
}

// ─── Strategy H: MACD + EMA50 趨勢過濾 (1H) ──────────────────────────────────
// EMA50 決定方向，MACD 線穿越訊號線時進場，2:1 TP

function signalH(candles) {
  if (candles.length < 60) return null;
  const closes = candles.map(c => c.close);
  const price  = closes[closes.length - 1];
  const e50    = ema(closes, 50);
  const atrVal = atr(candles, 14);
  const macd   = calcMACDObj(closes);
  if (!macd || !atrVal || price < 0.001) return null;

  if (price > e50 && macd.prevMacd < macd.prevSignal && macd.macd > macd.signal) {
    const sl    = swingLow(candles, 8) - atrVal * 0.1;
    const slPct = Math.abs(price - sl) / price * 100;
    if (slPct < 0.3 || slPct > 4 || sl >= price) return null;
    return { side: "long", stopLoss: sl };
  }
  if (price < e50 && macd.prevMacd > macd.prevSignal && macd.macd < macd.signal) {
    const sl    = swingHigh(candles, 8) + atrVal * 0.1;
    const slPct = Math.abs(price - sl) / price * 100;
    if (slPct < 0.3 || slPct > 4 || sl <= price) return null;
    return { side: "short", stopLoss: sl };
  }
  return null;
}

function exitH(pos, candles) {
  const price = candles[candles.length - 1].close;
  const sl    = calcTrailingStop(pos, price);
  const risk  = Math.abs(pos.entryPrice - pos.stopLoss);
  const tp    = pos.side === "long" ? pos.entryPrice + risk * 2 : pos.entryPrice - risk * 2;
  if (pos.side === "long") {
    if (price <= sl) return `止損 $${sl.toFixed(4)}`;
    if (price >= tp) return "2:1止盈達成";
  } else {
    if (price >= sl) return `止損 $${sl.toFixed(4)}`;
    if (price <= tp) return "2:1止盈達成";
  }
  return null;
}

// ─── Strategy I: Stochastic + EMA 趨勢 (1H) ──────────────────────────────────
// EMA21/50 確認趨勢，Stochastic %K 超賣/超買區進場，2:1 TP

function signalI(candles) {
  if (candles.length < 60) return null;
  const closes = candles.map(c => c.close);
  const price  = closes[closes.length - 1];
  const e21    = ema(closes, 21);
  const e50    = ema(closes, 50);
  const atrVal = atr(candles, 14);
  const stoch  = calcStochK(candles, 14, 3);
  const last   = candles[candles.length - 1];
  if (stoch === null || !atrVal || price < 0.001) return null;

  if (e21 > e50 && price > e50 && stoch < 25 && last.close > last.open) {
    const sl    = swingLow(candles, 8) - atrVal * 0.1;
    const slPct = Math.abs(price - sl) / price * 100;
    if (slPct < 0.3 || slPct > 3 || sl >= price) return null;
    return { side: "long", stopLoss: sl };
  }
  if (e21 < e50 && price < e50 && stoch > 75 && last.close < last.open) {
    const sl    = swingHigh(candles, 8) + atrVal * 0.1;
    const slPct = Math.abs(price - sl) / price * 100;
    if (slPct < 0.3 || slPct > 3 || sl <= price) return null;
    return { side: "short", stopLoss: sl };
  }
  return null;
}

function exitI(pos, candles) {
  const price = candles[candles.length - 1].close;
  const sl    = calcTrailingStop(pos, price);
  const risk  = Math.abs(pos.entryPrice - pos.stopLoss);
  const tp    = pos.side === "long" ? pos.entryPrice + risk * 2 : pos.entryPrice - risk * 2;
  if (pos.side === "long") {
    if (price <= sl) return `止損 $${sl.toFixed(4)}`;
    if (price >= tp) return "2:1止盈達成";
  } else {
    if (price >= sl) return `止損 $${sl.toFixed(4)}`;
    if (price <= tp) return "2:1止盈達成";
  }
  return null;
}

// ─── Strategy J: Ichimoku Cloud (1H) ─────────────────────────────────────────
// 價格在雲上/下，Tenkan 穿越 Kijun 進場，2:1 TP

function signalJ(candles) {
  if (candles.length < 85) return null;
  const closes = candles.map(c => c.close);
  const price  = closes[closes.length - 1];
  const atrVal = atr(candles, 14);
  const ichi   = calcIchimoku(candles);
  if (!ichi || !atrVal || price < 0.001) return null;
  const { tenkan, kijun, cloudTop, cloudBottom, prevTenkan, prevKijun } = ichi;

  if (price > cloudTop && prevTenkan <= prevKijun && tenkan > kijun) {
    const sl    = Math.min(kijun, cloudTop) - atrVal * 0.1;
    const slPct = Math.abs(price - sl) / price * 100;
    if (slPct < 0.3 || slPct > 5 || sl >= price) return null;
    return { side: "long", stopLoss: sl };
  }
  if (price < cloudBottom && prevTenkan >= prevKijun && tenkan < kijun) {
    const sl    = Math.max(kijun, cloudBottom) + atrVal * 0.1;
    const slPct = Math.abs(price - sl) / price * 100;
    if (slPct < 0.3 || slPct > 5 || sl <= price) return null;
    return { side: "short", stopLoss: sl };
  }
  return null;
}

function exitJ(pos, candles) {
  const price = candles[candles.length - 1].close;
  const sl    = calcTrailingStop(pos, price);
  const risk  = Math.abs(pos.entryPrice - pos.stopLoss);
  const tp    = pos.side === "long" ? pos.entryPrice + risk * 2 : pos.entryPrice - risk * 2;
  if (pos.side === "long") {
    if (price <= sl) return `止損 $${sl.toFixed(4)}`;
    if (price >= tp) return "2:1止盈達成";
  } else {
    if (price >= sl) return `止損 $${sl.toFixed(4)}`;
    if (price <= tp) return "2:1止盈達成";
  }
  return null;
}

// ─── Strategy K: Keltner Channel 突破 (1H) ───────────────────────────────────
// Keltner Channel 突破 + 成交量確認 + SMA20 趨勢，比 BB 假突破少，2:1 TP

function signalK(candles) {
  if (candles.length < 25) return null;
  const closes   = candles.map(c => c.close);
  const price    = closes[closes.length - 1];
  const prevClose = closes[closes.length - 2];
  const atrVal   = atr(candles, 14);
  const kc       = calcKeltner(candles, 20, 14, 2);
  const volR     = candles[candles.length - 1].volume / avgVol(candles, 20);
  const s20now   = sma(closes, 20);
  const s20prev  = sma(closes.slice(0, -1), 20);
  if (!kc || !atrVal || price < 0.001) return null;

  const trendUp   = s20now > s20prev * 1.001;
  const trendDown = s20now < s20prev * 0.999;

  if (price > kc.upper && prevClose <= kc.upper && volR > 1.5 && trendUp) {
    const sl    = candles[candles.length - 1].low - atrVal * 0.5;
    const slPct = Math.abs(price - sl) / price * 100;
    if (slPct < 0.5 || slPct > 5 || sl >= price) return null;
    return { side: "long", stopLoss: sl };
  }
  if (price < kc.lower && prevClose >= kc.lower && volR > 1.5 && trendDown) {
    const sl    = candles[candles.length - 1].high + atrVal * 0.5;
    const slPct = Math.abs(price - sl) / price * 100;
    if (slPct < 0.5 || slPct > 5 || sl <= price) return null;
    return { side: "short", stopLoss: sl };
  }
  return null;
}

function exitK(pos, candles) {
  const closes = candles.map(c => c.close);
  const price  = closes[closes.length - 1];
  const kc     = calcKeltner(candles, 20, 14, 2);
  const sl     = calcTrailingStop(pos, price);
  const risk   = Math.abs(pos.entryPrice - pos.stopLoss);
  const tp     = pos.side === "long" ? pos.entryPrice + risk * 2 : pos.entryPrice - risk * 2;
  if (pos.side === "long") {
    if (price <= sl) return `止損 $${sl.toFixed(4)}`;
    if (price >= tp) return "2:1止盈達成";
    if (kc && price < kc.upper && closes[closes.length - 2] > kc.upper) return "突破失效";
  } else {
    if (price >= sl) return `止損 $${sl.toFixed(4)}`;
    if (price <= tp) return "2:1止盈達成";
    if (kc && price > kc.lower && closes[closes.length - 2] < kc.lower) return "突破失效";
  }
  return null;
}

// ─── Strategy E: EMA Trend Pullback (1H) ─────────────────────────────────────
// 邏輯：EMA21>EMA50 確認趨勢，RSI14 拉回到 35-52 超賣區，bullish K棒進場
// 只留 SL + 2:1 TP

function signalE(candles) {
  if (candles.length < 55) return null;
  const closes = candles.map(c => c.close);
  const price  = closes[closes.length - 1];
  const e21    = ema(closes, 21);
  const e50    = ema(closes, 50);
  const r14    = rsi(closes, 14);
  const last   = candles[candles.length - 1];
  const atrVal = atr(candles, 14);
  if (!r14 || !atrVal || price < 0.001) return null;

  if (e21 > e50 && price > e50 && r14 >= 35 && r14 <= 52 && last.close > last.open) {
    const sl    = swingLow(candles, 8) - atrVal * 0.1;
    const slPct = Math.abs(price - sl) / price * 100;
    if (slPct < 0.3 || slPct > 3) return null;
    return { side: "long", stopLoss: sl };
  }
  if (e21 < e50 && price < e50 && r14 >= 48 && r14 <= 65 && last.close < last.open) {
    const sl    = swingHigh(candles, 8) + atrVal * 0.1;
    const slPct = Math.abs(price - sl) / price * 100;
    if (slPct < 0.3 || slPct > 3) return null;
    return { side: "short", stopLoss: sl };
  }
  return null;
}

function exitE(pos, candles) {
  const closes = candles.map(c => c.close);
  const price  = closes[closes.length - 1];
  const sl     = calcTrailingStop(pos, price);
  const risk   = Math.abs(pos.entryPrice - pos.stopLoss);
  const tp     = pos.side === "long" ? pos.entryPrice + risk * 2 : pos.entryPrice - risk * 2;
  if (pos.side === "long") {
    if (price <= sl) return `止損 $${sl.toFixed(4)}`;
    if (price >= tp) return "2:1止盈達成";
  } else {
    if (price >= sl) return `止損 $${sl.toFixed(4)}`;
    if (price <= tp) return "2:1止盈達成";
  }
  return null;
}

// ─── Strategy F: Supertrend 趨勢跟隨 (4H) ────────────────────────────────────
// 邏輯：Supertrend(14, 3) 翻轉方向時進場，SL 放在 Supertrend 線，3:1 TP

function calcSupertrendSeries(candles, period = 14, mult = 3) {
  if (candles.length < period + 2) return [];
  const trs = candles.slice(1).map((c, i) => Math.max(
    c.high - c.low,
    Math.abs(c.high - candles[i].close),
    Math.abs(c.low  - candles[i].close)
  ));
  let atrSmooth = trs.slice(0, period).reduce((a, b) => a + b) / period;
  const atrs = [atrSmooth];
  for (let i = period; i < trs.length; i++) {
    atrSmooth = (atrSmooth * (period - 1) + trs[i]) / period;
    atrs.push(atrSmooth);
  }
  const result = [];
  let upper = 0, lower = 0, dir = 1;
  for (let i = 0; i < atrs.length; i++) {
    const c        = candles[i + 1];
    const prevClose = i > 0 ? candles[i].close : c.open;
    const hl2      = (c.high + c.low) / 2;
    const bu       = hl2 + mult * atrs[i];
    const bl       = hl2 - mult * atrs[i];
    const newUpper = bu < upper || prevClose > upper ? bu : upper;
    const newLower = bl > lower || prevClose < lower ? bl : lower;
    const prevDir  = dir;
    if (i === 0)        dir = c.close >= hl2 ? 1 : -1;
    else if (dir === 1) dir = c.close < newLower ? -1 : 1;
    else                dir = c.close > newUpper ?  1 : -1;
    upper = newUpper; lower = newLower;
    result.push({ dir, value: dir === 1 ? newLower : newUpper, prevDir });
  }
  return result;
}

function signalF(candles) {
  if (candles.length < 20) return null;
  const series = calcSupertrendSeries(candles, 14, 3);
  if (series.length < 2) return null;
  const curr = series[series.length - 1];
  const prev = series[series.length - 2];
  if (curr.dir === prev.dir) return null; // 只在翻轉時進場
  const price  = candles[candles.length - 1].close;
  const atrVal = atr(candles, 14);
  if (price < 0.001) return null;
  if (curr.dir === 1) { // 翻多
    const sl    = curr.value - atrVal * 0.1;
    const slPct = Math.abs(price - sl) / price * 100;
    if (slPct < 0.3 || slPct > 6) return null;
    return { side: "long", stopLoss: sl };
  } else { // 翻空
    const sl    = curr.value + atrVal * 0.1;
    const slPct = Math.abs(price - sl) / price * 100;
    if (slPct < 0.3 || slPct > 6) return null;
    return { side: "short", stopLoss: sl };
  }
}

function exitF(pos, candles) {
  const series = calcSupertrendSeries(candles, 14, 3);
  if (!series.length) return null;
  const curr  = series[series.length - 1];
  const price = candles[candles.length - 1].close;
  const sl    = calcTrailingStop(pos, price);
  const risk  = Math.abs(pos.entryPrice - pos.stopLoss);
  const tp    = pos.side === "long" ? pos.entryPrice + risk * 3 : pos.entryPrice - risk * 3;
  if (pos.side === "long") {
    if (price <= sl)   return `止損 $${sl.toFixed(4)}`;
    if (price >= tp)   return "3:1止盈達成";
    if (curr.dir === -1) return "Supertrend翻空（出場）";
  } else {
    if (price >= sl)   return `止損 $${sl.toFixed(4)}`;
    if (price <= tp)   return "3:1止盈達成";
    if (curr.dir === 1)  return "Supertrend翻多（出場）";
  }
  return null;
}

// ─── Strategy G: 多時框 RSI 共振 (1H) ────────────────────────────────────────
// 邏輯：RSI14 + RSI56（≈4H RSI14）雙重超賣/超買才進場，EMA50 確認趨勢方向
// 訊號稀少但品質高，TP 放 3:1

function signalG(candles) {
  if (candles.length < 60) return null;
  const closes = candles.map(c => c.close);
  const price  = closes[closes.length - 1];
  const r14    = rsi(closes, 14);  // 1H RSI
  const r56    = rsi(closes, 56);  // 近似 4H RSI（14×4）
  const e50    = ema(closes, 50);
  const atrVal = atr(candles, 14);
  if (!r14 || !r56 || !atrVal || price < 0.001) return null;

  if (r14 < 40 && r56 < 48 && price > e50) {
    const sl    = swingLow(candles, 8) - atrVal * 0.1;
    const slPct = Math.abs(price - sl) / price * 100;
    if (slPct < 0.3 || slPct > 4) return null;
    return { side: "long", stopLoss: sl };
  }
  if (r14 > 65 && r56 > 58 && price < e50) {
    const sl    = swingHigh(candles, 8) + atrVal * 0.1;
    const slPct = Math.abs(price - sl) / price * 100;
    if (slPct < 0.3 || slPct > 4) return null;
    return { side: "short", stopLoss: sl };
  }
  return null;
}

function exitG(pos, candles) {
  const closes = candles.map(c => c.close);
  const price  = closes[closes.length - 1];
  const sl     = calcTrailingStop(pos, price);
  const risk   = Math.abs(pos.entryPrice - pos.stopLoss);
  const tp     = pos.side === "long" ? pos.entryPrice + risk * 3 : pos.entryPrice - risk * 3;
  if (pos.side === "long") {
    if (price <= sl) return `止損 $${sl.toFixed(4)}`;
    if (price >= tp) return "3:1止盈達成";
  } else {
    if (price >= sl) return `止損 $${sl.toFixed(4)}`;
    if (price <= tp) return "3:1止盈達成";
  }
  return null;
}

// ─── Backtester Core ──────────────────────────────────────────────────────────

async function backtestStrategy(name, symbols, interval, signalFn, exitFn) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  策略 ${name} 回測中... (${symbols.length} 個幣種, ${interval})`);
  console.log(`${"═".repeat(60)}`);

  const allTrades = [];
  let errors = 0;

  for (const symbol of symbols) {
    try {
      process.stdout.write(`  ${symbol}... `);
      const candles = await fetchHistoricalCandles(symbol, interval, 3);
      if (candles.length < 50) { console.log("數據不足"); continue; }

      let pos = null;
      const MIN_LOOKBACK = 30;

      for (let i = MIN_LOOKBACK; i < candles.length; i++) {
        const slice = candles.slice(0, i + 1);
        const price = slice[slice.length - 1].close;

        if (pos) {
          // 更新追蹤止損
          pos.stopLoss = calcTrailingStop(pos, price);

          const reason = exitFn(pos, slice);
          if (reason) {
            // 止損觸發時用止損價出場（避免跳空放大虧損），其他出場用收盤價
            const isStopHit = reason.startsWith("止損");
            const exitPrice = isStopHit ? pos.stopLoss : price;
            const pnl = pos.side === "long"
              ? (exitPrice - pos.entryPrice) * pos.quantity
              : (pos.entryPrice - exitPrice) * pos.quantity;
            allTrades.push({ symbol, ...pos, exitPrice, exitReason: reason, pnl, win: pnl > 0 });
            pos = null;
          }
        } else {
          const sig = signalFn(slice);
          if (sig) {
            // 避免止損比進場還貴（止損在錯誤方向）
            if (sig.side === "long" && sig.stopLoss >= price) continue;
            if (sig.side === "short" && sig.stopLoss <= price) continue;

            const { tradeSize, quantity } = calcSize(price, sig.stopLoss);
            pos = { symbol, side: sig.side, entryPrice: price, stopLoss: sig.stopLoss, tradeSize, quantity, orb: sig.orb };
          }
        }
      }
      // 未平倉按最後收盤算浮動
      if (pos) {
        const price = candles[candles.length - 1].close;
        const pnl = pos.side === "long"
          ? (price - pos.entryPrice) * pos.quantity
          : (pos.entryPrice - price) * pos.quantity;
        allTrades.push({ ...pos, exitPrice: price, exitReason: "持倉中(期末)", pnl, win: pnl > 0, open: true });
      }
      console.log(`${allTrades.filter(t => t.symbol === symbol).length} 筆`);
    } catch (e) {
      console.log(`錯誤: ${e.message}`);
      errors++;
    }
  }

  return { name, trades: allTrades, errors };
}

// ─── Report ───────────────────────────────────────────────────────────────────

function report(result) {
  const { name, trades } = result;
  const closed = trades.filter(t => !t.open);
  if (!closed.length) { console.log(`\n策略 ${name}: 無平倉交易`); return; }

  const wins = closed.filter(t => t.win);
  const losses = closed.filter(t => !t.win);
  const winRate = (wins.length / closed.length * 100).toFixed(1);
  const totalPnl = closed.reduce((s, t) => s + t.pnl, 0);
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 1;
  const rr = (avgWin / avgLoss).toFixed(2);

  // Max drawdown
  let peak = 0, maxDD = 0, running = 0;
  closed.forEach(t => {
    running += t.pnl;
    if (running > peak) peak = running;
    const dd = peak - running;
    if (dd > maxDD) maxDD = dd;
  });

  // Profit Factor
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : "∞";

  console.log(`\n┌${"─".repeat(55)}┐`);
  console.log(`│  策略 ${name} 回測結果 (3個月)${" ".repeat(27 - name.length)}│`);
  console.log(`├${"─".repeat(55)}┤`);
  console.log(`│  總交易筆數: ${closed.length.toString().padEnd(6)} 勝: ${wins.length}  敗: ${losses.length}${" ".repeat(18)}│`);
  console.log(`│  勝率:       ${winRate.padEnd(10)} Profit Factor: ${pf.padEnd(8)}│`);
  console.log(`│  平均獲利:   $${avgWin.toFixed(2).padEnd(9)} 平均虧損: $${avgLoss.toFixed(2).padEnd(8)}│`);
  console.log(`│  R:R 比:     ${rr.padEnd(10)} 最大回撤: $${maxDD.toFixed(2).padEnd(8)}│`);
  console.log(`│  3個月總損益: $${totalPnl.toFixed(2).padEnd(44)}│`);
  console.log(`└${"─".repeat(55)}┘`);

  // Top 5 trades
  const top5 = [...closed].sort((a, b) => b.pnl - a.pnl).slice(0, 3);
  const bot5 = [...closed].sort((a, b) => a.pnl - b.pnl).slice(0, 3);
  console.log(`\n  最佳交易：`);
  top5.forEach(t => console.log(`    ${t.symbol} ${t.side.toUpperCase()} $${t.pnl.toFixed(2)} (${t.exitReason})`));
  console.log(`  最差交易：`);
  bot5.forEach(t => console.log(`    ${t.symbol} ${t.side.toUpperCase()} $${t.pnl.toFixed(2)} (${t.exitReason})`));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const rulesFile = USE_MASTER ? "watchlist_master.json" : "rules_bb.json";
  const rules = JSON.parse(readFileSync(rulesFile, "utf8"));
  const symbols = rules.watchlist.slice(0, SYMBOL_LIMIT);

  console.log("═".repeat(60));
  console.log("  四策略歷史回測");
  console.log(`  期間: 過去3個月 | 幣種: 前${SYMBOL_LIMIT}個 | 本金: $${PORTFOLIO}`);
  console.log(`  每筆風險: ${RISK_PER_TRADE * 100}% ($${(PORTFOLIO * RISK_PER_TRADE).toFixed(2)})`);
  console.log("═".repeat(60));

  const strategies = {
    A: { interval: "1h",  signalFn: signalA, exitFn: exitA },
    B: { interval: "1h",  signalFn: signalB, exitFn: exitB },
    C: { interval: "1h",  signalFn: signalC, exitFn: exitC },
    D: { interval: "15m", signalFn: signalD, exitFn: exitD },
    E: { interval: "1h",  signalFn: signalE, exitFn: exitE }, // EMA 趨勢拉回
    F: { interval: "4h",  signalFn: signalF, exitFn: exitF }, // Supertrend
    G: { interval: "1h",  signalFn: signalG, exitFn: exitG }, // 多時框 RSI 共振
    H: { interval: "1h",  signalFn: signalH, exitFn: exitH }, // MACD + EMA50
    I: { interval: "1h",  signalFn: signalI, exitFn: exitI }, // Stochastic + EMA
    J: { interval: "1h",  signalFn: signalJ, exitFn: exitJ }, // Ichimoku Cloud
    K: { interval: "1h",  signalFn: signalK, exitFn: exitK }, // Keltner Channel
  };

  const toRun = STRATEGY === "ALL" ? Object.keys(strategies) : [STRATEGY];
  const results = [];

  for (const key of toRun) {
    if (!strategies[key]) { console.log(`未知策略: ${key}`); continue; }
    const { interval, signalFn, exitFn } = strategies[key];
    const result = await backtestStrategy(key, symbols, interval, signalFn, exitFn);
    results.push(result);
  }

  console.log("\n\n" + "═".repeat(60));
  console.log("  回測結果總覽");
  console.log("═".repeat(60));
  results.forEach(report);

  if (results.length > 1) {
    console.log("\n\n  📊 策略排名（依 3個月總損益）");
    const ranked = results
      .map(r => {
        const closed = r.trades.filter(t => !t.open);
        const pnl = closed.reduce((s, t) => s + t.pnl, 0);
        const wr = closed.length ? (closed.filter(t => t.win).length / closed.length * 100).toFixed(1) : "0";
        return { name: r.name, pnl, wr, trades: closed.length };
      })
      .sort((a, b) => b.pnl - a.pnl);
    ranked.forEach((r, i) =>
      console.log(`  ${i + 1}. 策略${r.name}: $${r.pnl.toFixed(2)} | 勝率 ${r.wr}% | ${r.trades}筆`)
    );
    console.log(`\n  👑 建議使用：策略 ${ranked[0].name}`);
  }
}

main().catch(console.error);
