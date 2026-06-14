/**
 * 策略 A vs E — 真實 bot 行為模擬回測
 * 按時間順序跨幣種處理，全局共享 4 倉上限（與 Railway bot 一致）
 *
 * node backtest_ae.js [symbol_limit]
 */

import { readFileSync } from "fs";

const SYMBOL_LIMIT = parseInt(process.argv[2] || "65");
const PORTFOLIO    = 1000;
const RISK         = PORTFOLIO * 0.01;
const MAX_TRADE    = 100;
const MAX_OPEN     = 4;
const LOOKBACK     = 60; // 最少需要的 lookback 根數

// ─── Binance 1H 歷史資料（12 個月 + lookback）────────────────────────────────

const INTERVAL    = process.argv[3] || "1h"; // node backtest_ae.js 65 4h
const MS_CANDLE   = INTERVAL === "4h" ? 4*60*60*1000 : 60*60*1000;

async function fetchCandles(symbol) {
  const oneYear     = 365 * 24 * 60 * 60 * 1000;
  const msPerCandle = MS_CANDLE;
  const need        = Math.ceil(oneYear / msPerCandle) + LOOKBACK + 10;
  const all         = [];
  let endTime       = Date.now();

  while (all.length < need) {
    const limit = Math.min(1000, need - all.length);
    const url   = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${INTERVAL}&endTime=${endTime}&limit=${limit}`;
    const res   = await fetch(url);
    if (!res.ok) throw new Error(`${res.status}`);
    const data  = await res.json();
    if (!data.length) break;
    all.unshift(...data.map(k => ({
      time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
    })));
    endTime = data[0][0] - 1;
    if (data.length < limit) break;
    await new Promise(r => setTimeout(r, 80));
  }
  return all.sort((a, b) => a.time - b.time);
}

// ─── Indicators ───────────────────────────────────────────────────────────────

function calcEMA(closes, period) {
  const k = 2 / (period + 1);
  let v = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) v = closes[i] * k + v * (1 - k);
  return v;
}

function calcRSI(closes, period) {
  if (closes.length < period + 1) return null;
  const sl = closes.slice(-(period + 1));
  let g = 0, l = 0;
  for (let i = 1; i < sl.length; i++) {
    const d = sl[i] - sl[i - 1];
    d > 0 ? (g += d) : (l -= d);
  }
  return 100 - 100 / (1 + g / (l || 0.0001));
}

function calcATR(candles, period = 14) {
  const trs = candles.slice(1).map((c, i) => {
    const p = candles[i].close;
    return Math.max(c.high - c.low, Math.abs(c.high - p), Math.abs(c.low - p));
  });
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcVWAP(candles) {
  const midnight = new Date(candles[candles.length - 1].time);
  midnight.setUTCHours(0, 0, 0, 0);
  const sess = candles.filter(c => c.time >= midnight.getTime());
  if (!sess.length) return null;
  const tpv = sess.reduce((s, c) => s + ((c.high + c.low + c.close) / 3) * c.volume, 0);
  const vol  = sess.reduce((s, c) => s + c.volume, 0);
  return vol ? tpv / vol : null;
}

function calcADX(candles, period = 14) {
  if (candles.length < period + 2) return 0;
  const dms = candles.slice(1).map((c, i) => {
    const up   = c.high - candles[i].high;
    const down = candles[i].low - c.low;
    return {
      plus:  up > down && up > 0 ? up : 0,
      minus: down > up && down > 0 ? down : 0,
      tr: Math.max(c.high - c.low, Math.abs(c.high - candles[i].close), Math.abs(c.low - candles[i].close)),
    };
  });
  const s    = dms.slice(-period);
  const sumTR = s.reduce((a, d) => a + d.tr, 0) || 1;
  const diP  = s.reduce((a, d) => a + d.plus,  0) / sumTR * 100;
  const diM  = s.reduce((a, d) => a + d.minus, 0) / sumTR * 100;
  return Math.abs(diP - diM) / ((diP + diM) || 1) * 100;
}

function swingLow(candles, lb = 8) {
  return Math.min(...candles.slice(-lb - 1, -1).map(c => c.low));
}
function swingHigh(candles, lb = 8) {
  return Math.max(...candles.slice(-lb - 1, -1).map(c => c.high));
}

function trailingStop(pos, price) {
  const { side, entryPrice, stopLoss } = pos;
  const risk = Math.abs(entryPrice - stopLoss);
  if (!risk) return stopLoss;
  const profitR = (side === "long" ? price - entryPrice : entryPrice - price) / risk;
  if (profitR < 1.0) return stopLoss;
  const lockR   = Math.max(0, Math.floor(profitR * 2) / 2 - 1.0);
  const newStop = side === "long" ? entryPrice + risk * lockR : entryPrice - risk * lockR;
  return side === "long" ? Math.max(stopLoss, newStop) : Math.min(stopLoss, newStop);
}

// ─── Strategy A: VWAP + RSI(3) + EMA(8) + ADX ────────────────────────────────

function signalA(candles) {
  if (candles.length < 30) return null;
  const closes = candles.map(c => c.close);
  const price  = closes[closes.length - 1];
  if (price < 0.001) return null;
  const e8   = calcEMA(closes, 8);
  const v    = calcVWAP(candles);
  const r3   = calcRSI(closes, 3);
  const adxV = calcADX(candles, 14);
  const atrV = calcATR(candles, 14);
  if (!v || !r3 || !atrV || adxV < 25) return null;

  if (price > v && price > e8 && r3 < 20) {
    const sl = v - atrV * 0.15;
    const slPct = Math.abs(price - sl) / price * 100;
    if (slPct < 0.2 || slPct > 1.5 || sl >= price) return null;
    return { side: "long", stopLoss: sl };
  }
  if (price < v && price < e8 && r3 > 80) {
    const sl = v + atrV * 0.15;
    const slPct = Math.abs(price - sl) / price * 100;
    if (slPct < 0.2 || slPct > 1.5 || sl <= price) return null;
    return { side: "short", stopLoss: sl };
  }
  return null;
}

function exitA(pos, candle) {
  const sl   = trailingStop(pos, candle.close); // 追蹤止損用收盤更新
  pos.stopLoss = sl;
  const risk = Math.abs(pos.entryPrice - pos.stopLoss);
  const tp   = pos.side === "long" ? pos.entryPrice + risk * 2 : pos.entryPrice - risk * 2;
  if (pos.side === "long") {
    const slHit = candle.low  <= sl;
    const tpHit = candle.high >= tp;
    if (slHit && tpHit) return { exit: true, ep: sl }; // 同根K棒兩者都觸及→保守取SL
    if (tpHit) return { exit: true, ep: tp };
    if (slHit) return { exit: true, ep: sl };
  } else {
    const slHit = candle.high >= sl;
    const tpHit = candle.low  <= tp;
    if (slHit && tpHit) return { exit: true, ep: sl };
    if (tpHit) return { exit: true, ep: tp };
    if (slHit) return { exit: true, ep: sl };
  }
  return { exit: false };
}

// ─── Strategy E: EMA21/50 Trend Pullback ──────────────────────────────────────

function signalE(candles) {
  if (candles.length < 55) return null;
  const closes = candles.map(c => c.close);
  const price  = closes[closes.length - 1];
  const last   = candles[candles.length - 1];
  if (price < 0.001) return null;
  const e21  = calcEMA(closes, 21);
  const e50  = calcEMA(closes, 50);
  const r14  = calcRSI(closes, 14);
  const atrV = calcATR(candles, 14);
  if (!r14 || !atrV) return null;

  // 新增過濾條件：
  // 1. EMA21 斜率：EMA21 確實在上升（非橫盤）
  const closes3 = candles.slice(-4, -1).map(c => c.close);
  const e21_3bars = calcEMA(closes3.concat([closes3[closes3.length-1]]), Math.min(21, closes3.length));
  const ema21Rising  = e21 > e21_3bars * 1.0005;
  const ema21Falling = e21 < e21_3bars * 0.9995;
  // 2. ADX > 20：市場有趨勢，非震盪
  const adxV = calcADX(candles, 14);
  const trending = adxV > 20;
  // 3. 成交量確認：當根成交量 > 近 20 根平均（回調後反彈有量）
  const avgVol = candles.slice(-21, -1).reduce((s, c) => s + c.volume, 0) / 20;
  const volConfirm = last.volume > avgVol * 1.0;

  if (e21 > e50 && price > e50 && r14 >= 35 && r14 <= 52 && last.close > last.open
      && ema21Rising && trending && volConfirm) {
    const sl = swingLow(candles, 8) - atrV * 0.1;
    const slPct = Math.abs(price - sl) / price * 100;
    if (slPct < 0.3 || slPct > 3 || sl >= price) return null;
    return { side: "long", stopLoss: sl };
  }
  if (e21 < e50 && price < e50 && r14 >= 48 && r14 <= 65 && last.close < last.open
      && ema21Falling && trending && volConfirm) {
    const sl = swingHigh(candles, 8) + atrV * 0.1;
    const slPct = Math.abs(price - sl) / price * 100;
    if (slPct < 0.3 || slPct > 3 || sl <= price) return null;
    return { side: "short", stopLoss: sl };
  }
  return null;
}

function exitE(pos, candle) {
  pos.stopLoss = trailingStop(pos, candle.close); // 追蹤止損用收盤更新
  const risk = Math.abs(pos.entryPrice - pos.stopLoss);
  const tp   = pos.side === "long" ? pos.entryPrice + risk * 2 : pos.entryPrice - risk * 2;
  if (pos.side === "long") {
    const slHit = candle.low  <= pos.stopLoss;
    const tpHit = candle.high >= tp;
    if (slHit && tpHit) return { exit: true, ep: pos.stopLoss };
    if (tpHit) return { exit: true, ep: tp };
    if (slHit) return { exit: true, ep: pos.stopLoss };
  } else {
    const slHit = candle.high >= pos.stopLoss;
    const tpHit = candle.low  <= tp;
    if (slHit && tpHit) return { exit: true, ep: pos.stopLoss };
    if (tpHit) return { exit: true, ep: tp };
    if (slHit) return { exit: true, ep: pos.stopLoss };
  }
  return { exit: false };
}

// ─── Monthly Report ───────────────────────────────────────────────────────────

function monthKey(ts) { return new Date(ts).toISOString().slice(0, 7); }

function printReport(label, trades) {
  const byMonth = {};
  for (const t of trades) {
    const m = monthKey(t.exitTime);
    if (!byMonth[m]) byMonth[m] = { trades: 0, wins: 0, pnl: 0 };
    byMonth[m].trades++;
    byMonth[m].pnl += t.pnl;
    if (t.win) byMonth[m].wins++;
  }

  console.log(`\n${"═".repeat(58)}`);
  console.log(`  策略 ${label} — 月報（${trades.length} 筆平倉，全局 4 倉限制）`);
  console.log(`${"═".repeat(58)}`);
  console.log(`  月份      筆數   勝率     月損益    累積損益`);
  console.log(`  ${"─".repeat(53)}`);

  let cum = 0;
  for (const m of Object.keys(byMonth).sort()) {
    const d   = byMonth[m];
    const wr  = d.trades ? ((d.wins / d.trades) * 100).toFixed(0) : "0";
    cum       += d.pnl;
    const ps  = (d.pnl  >= 0 ? "+" : "") + d.pnl.toFixed(2);
    const cs  = (cum    >= 0 ? "+" : "") + cum.toFixed(2);
    console.log(`  ${m}   ${String(d.trades).padStart(4)}  ${wr.padStart(4)}%  ${ps.padStart(9)}  ${cs.padStart(10)}`);
  }

  const allPnl  = trades.reduce((s, t) => s + t.pnl, 0);
  const wins    = trades.filter(t => t.win).length;
  const losses  = trades.length - wins;
  const wr      = trades.length ? ((wins / trades.length) * 100).toFixed(1) : "0";
  const sumWin  = trades.filter(t => t.win).reduce((s, t) => s + t.pnl, 0);
  const sumLoss = Math.abs(trades.filter(t => !t.win).reduce((s, t) => s + t.pnl, 0));
  const pf      = sumLoss > 0 ? (sumWin / sumLoss).toFixed(2) : "∞";
  const avgW    = wins   ? (sumWin  / wins).toFixed(2)   : "0";
  const avgL    = losses ? (sumLoss / losses).toFixed(2) : "0";

  console.log(`  ${"─".repeat(53)}`);
  console.log(`  全年合計  ${String(trades.length).padStart(4)}  ${wr.padStart(4)}%  ${((allPnl>=0?"+":"")+allPnl.toFixed(2)).padStart(9)}`);
  console.log(`\n  平均獲利: +$${avgW} | 平均虧損: -$${avgL} | Profit Factor: ${pf}`);
}

// ─── Main：按時間順序跨幣種模擬 ───────────────────────────────────────────────

async function main() {
  const rules    = JSON.parse(readFileSync("rules_e.json", "utf8"));
  const watchlist = rules.watchlist.slice(0, SYMBOL_LIMIT);
  const cutoff   = Date.now() - 365 * 24 * 60 * 60 * 1000;

  console.log(`\n回測 A vs E｜${watchlist.length} 幣種｜${INTERVAL.toUpperCase()}｜過去 12 個月`);
  console.log(`模式：按時間順序跨幣種，全局共享 4 倉上限（模擬真實 bot）`);
  console.log("═".repeat(58));

  // ── Step 1: 下載所有幣種資料 ──────────────────────────────────────────────
  const allData = {}; // symbol → candles[]
  for (let i = 0; i < watchlist.length; i++) {
    const symbol = watchlist[i];
    process.stdout.write(`  [${i+1}/${watchlist.length}] ${symbol}... `);
    try {
      const candles = await fetchCandles(symbol);
      const startIdx = candles.findIndex(c => c.time >= cutoff);
      if (startIdx < LOOKBACK) { console.log("資料不足"); continue; }
      allData[symbol] = candles;
      console.log(`${candles.length} 根`);
    } catch (e) {
      console.log(`錯誤: ${e.message}`);
    }
  }

  // ── Step 2: 收集所有時間戳，按時序排列 ───────────────────────────────────
  const timeSet = new Set();
  for (const c of Object.values(allData))
    c.filter(b => b.time >= cutoff).forEach(b => timeSet.add(b.time));
  const times = [...timeSet].sort((a, b) => a - b);

  console.log(`\n共 ${times.length} 個時間點，開始模擬...`);

  // ── Step 3: 按時序模擬兩個策略 ───────────────────────────────────────────

  function runStrategy(signalFn, exitFn, label) {
    const openPos  = []; // 全局持倉（最多 4）
    const trades   = [];
    const symIdx   = {}; // symbol → current candle index
    const cooldown = {}; // symbol → last exit timestamp（4H 冷卻，策略A用）

    // 初始化每個幣種的 index 到 cutoff 前
    for (const [sym, candles] of Object.entries(allData)) {
      symIdx[sym] = candles.findIndex(c => c.time >= cutoff);
      if (symIdx[sym] < 0) symIdx[sym] = candles.length;
    }

    for (const ts of times) {
      // 先處理所有出場（優先）
      for (const pos of [...openPos]) {
        const candles = allData[pos.symbol];
        const idx     = candles.findIndex(c => c.time === ts);
        if (idx < 0) continue;
        const { exit, ep } = exitFn(pos, candles[idx]);
        if (exit) {
          const pnl = pos.side === "long"
            ? (ep - pos.entryPrice) * pos.quantity
            : (pos.entryPrice - ep) * pos.quantity;
          trades.push({ entryTime: pos.entryTime, exitTime: ts, symbol: pos.symbol, pnl, win: pnl > 0 });
          cooldown[pos.symbol] = ts;
          openPos.splice(openPos.indexOf(pos), 1);
        }
      }

      // 再處理所有入場
      if (openPos.length >= MAX_OPEN) continue;

      for (const [symbol, candles] of Object.entries(allData)) {
        if (openPos.length >= MAX_OPEN) break;
        // 同幣種已有持倉，跳過
        if (openPos.some(p => p.symbol === symbol)) continue;
        // 4H 冷卻（策略 A 有此限制）
        if (label === "A" && cooldown[symbol] && ts - cooldown[symbol] < 4 * 3600 * 1000) continue;

        const idx = candles.findIndex(c => c.time === ts);
        if (idx < LOOKBACK) continue;
        const slice = candles.slice(0, idx + 1);
        const price = candles[idx].close;
        const sig   = signalFn(slice);
        if (!sig) continue;

        const slPct   = Math.abs(price - sig.stopLoss) / price;
        const rawSize = slPct > 0.001 ? RISK / slPct : RISK;
        const size    = Math.min(rawSize, PORTFOLIO, MAX_TRADE);
        openPos.push({
          symbol, side: sig.side, entryPrice: price,
          entryTime: ts, stopLoss: sig.stopLoss,
          quantity: size / price,
        });
      }
    }

    return trades;
  }

  console.log("  模擬策略 A...");
  const tradesA = runStrategy(signalA, exitA, "A");
  console.log(`  策略 A 完成：${tradesA.length} 筆`);

  console.log("  模擬策略 E...");
  const tradesE = runStrategy(signalE, exitE, "E");
  console.log(`  策略 E 完成：${tradesE.length} 筆`);

  printReport("A（VWAP+RSI(3)+EMA+ADX，4H冷卻）", tradesA);
  printReport("E（EMA21/50 回調進場）", tradesE);

  console.log("\n");
}

main().catch(console.error);
