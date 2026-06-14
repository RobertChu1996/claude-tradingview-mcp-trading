/**
 * 策略 E — 止損結構對照回測
 * 測試 6 種止損配置，找出最不容易被小波段掃出的設定
 * 執行：node backtest_sl_variants.js
 */

const PORTFOLIO = 1000;
const RISK      = PORTFOLIO * 0.01;   // $10 / 筆
const MAX_TRADE = 100;
const MAX_OPEN  = 4;
const LOOKBACK  = 60;
const INTERVAL  = "1h";

// ─── 6 種止損配置 ─────────────────────────────────────────────────────────────
const VARIANTS = [
  { id: "Baseline",  slType: "swing", swingLb: 8,  slMax: 3, atrMult: 0.1 },
  { id: "V1 寬上限", slType: "swing", swingLb: 8,  slMax: 6, atrMult: 0.1 },
  { id: "V2 ATR×2", slType: "atr",   swingLb: 8,  slMax: 6, atrMult: 2.0 },
  { id: "V3 Swing20",slType: "swing", swingLb: 20, slMax: 3, atrMult: 0.1 },
  { id: "V1+V3",    slType: "swing", swingLb: 20, slMax: 6, atrMult: 0.1 },
  { id: "V1+V2",    slType: "atr",   swingLb: 8,  slMax: 6, atrMult: 2.0 },
];

// ─── 資料抓取 ─────────────────────────────────────────────────────────────────
async function fetchCandles(symbol) {
  const oneYear = 365 * 24 * 60 * 60 * 1000;
  const need    = Math.ceil(oneYear / (3600 * 1000)) + LOOKBACK + 10;
  const all     = [];
  let endTime   = Date.now();

  while (all.length < need) {
    const limit = Math.min(1000, need - all.length);
    const url   = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${INTERVAL}&endTime=${endTime}&limit=${limit}`;
    const res   = await fetch(url);
    if (!res.ok) throw new Error(`${res.status}`);
    const data  = await res.json();
    if (!data.length) break;
    all.unshift(...data.map(k => ({ time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] })));
    endTime = data[0][0] - 1;
    if (data.length < limit) break;
    await new Promise(r => setTimeout(r, 80));
  }
  return all.sort((a, b) => a.time - b.time);
}

// ─── 指標 ─────────────────────────────────────────────────────────────────────
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
  const s     = dms.slice(-period);
  const sumTR = s.reduce((a, d) => a + d.tr, 0) || 1;
  const diP   = s.reduce((a, d) => a + d.plus,  0) / sumTR * 100;
  const diM   = s.reduce((a, d) => a + d.minus, 0) / sumTR * 100;
  return Math.abs(diP - diM) / ((diP + diM) || 1) * 100;
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

// ─── 策略 E 信號（可配置止損結構）──────────────────────────────────────────────
function signalE(candles, cfg) {
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

  const closes3    = candles.slice(-4, -1).map(c => c.close);
  const e21_3bars  = calcEMA(closes3.concat([closes3[closes3.length - 1]]), Math.min(21, closes3.length));
  const ema21Rising  = e21 > e21_3bars * 1.0005;
  const ema21Falling = e21 < e21_3bars * 0.9995;
  const adxV         = calcADX(candles, 14);
  const trending     = adxV > 20;
  const avgVol       = candles.slice(-21, -1).reduce((s, c) => s + c.volume, 0) / 20;
  const volConfirm   = last.volume > avgVol;

  function computeSL(side) {
    if (cfg.slType === "atr") {
      return side === "long"
        ? price - atrV * cfg.atrMult
        : price + atrV * cfg.atrMult;
    }
    // swing-based
    return side === "long"
      ? Math.min(...candles.slice(-cfg.swingLb - 1, -1).map(c => c.low))  - atrV * 0.1
      : Math.max(...candles.slice(-cfg.swingLb - 1, -1).map(c => c.high)) + atrV * 0.1;
  }

  if (e21 > e50 && price > e50 && r14 >= 35 && r14 <= 52 && last.close > last.open
      && ema21Rising && trending && volConfirm) {
    const sl    = computeSL("long");
    const slPct = Math.abs(price - sl) / price * 100;
    if (slPct < 0.3 || slPct > cfg.slMax || sl >= price) return null;
    return { side: "long", stopLoss: sl };
  }
  if (e21 < e50 && price < e50 && r14 >= 48 && r14 <= 65 && last.close < last.open
      && ema21Falling && trending && volConfirm) {
    const sl    = computeSL("short");
    const slPct = Math.abs(price - sl) / price * 100;
    if (slPct < 0.3 || slPct > cfg.slMax || sl <= price) return null;
    return { side: "short", stopLoss: sl };
  }
  return null;
}

function exitE(pos, candle) {
  pos.stopLoss   = trailingStop(pos, candle.close);
  const risk     = Math.abs(pos.entryPrice - pos.stopLoss);
  const tp       = pos.side === "long" ? pos.entryPrice + risk * 2 : pos.entryPrice - risk * 2;
  if (pos.side === "long") {
    const slHit = candle.low  <= pos.stopLoss;
    const tpHit = candle.high >= tp;
    if (slHit && tpHit) return { exit: true, ep: pos.stopLoss };
    if (tpHit)          return { exit: true, ep: tp };
    if (slHit)          return { exit: true, ep: pos.stopLoss };
  } else {
    const slHit = candle.high >= pos.stopLoss;
    const tpHit = candle.low  <= tp;
    if (slHit && tpHit) return { exit: true, ep: pos.stopLoss };
    if (tpHit)          return { exit: true, ep: tp };
    if (slHit)          return { exit: true, ep: pos.stopLoss };
  }
  return { exit: false };
}

// ─── 回測執行 ─────────────────────────────────────────────────────────────────
function runVariant(cfg, allData, times, cutoff) {
  const openPos = [];
  const trades  = [];

  const symIdx = {};
  for (const sym of Object.keys(allData))
    symIdx[sym] = allData[sym].findIndex(c => c.time >= cutoff);

  for (const ts of times) {
    // 出場優先
    for (const pos of [...openPos]) {
      const candles = allData[pos.symbol];
      const idx     = candles.findIndex(c => c.time === ts);
      if (idx < 0) continue;
      const { exit, ep } = exitE(pos, candles[idx]);
      if (exit) {
        const pnl = pos.side === "long"
          ? (ep - pos.entryPrice) * pos.quantity
          : (pos.entryPrice - ep) * pos.quantity;
        trades.push({ exitTime: ts, symbol: pos.symbol, pnl, win: pnl > 0, slPct: pos.slPct });
        openPos.splice(openPos.indexOf(pos), 1);
      }
    }

    if (openPos.length >= MAX_OPEN) continue;

    for (const [symbol, candles] of Object.entries(allData)) {
      if (openPos.length >= MAX_OPEN) break;
      if (openPos.some(p => p.symbol === symbol)) continue;
      const idx = candles.findIndex(c => c.time === ts);
      if (idx < LOOKBACK) continue;
      const slice = candles.slice(0, idx + 1);
      const price = candles[idx].close;
      const sig   = signalE(slice, cfg);
      if (!sig) continue;

      const slPct   = Math.abs(price - sig.stopLoss) / price;
      const rawSize = slPct > 0.001 ? RISK / slPct : RISK;
      const size    = Math.min(rawSize, PORTFOLIO, MAX_TRADE);
      openPos.push({
        symbol, side: sig.side, entryPrice: price,
        entryTime: ts, stopLoss: sig.stopLoss,
        quantity: size / price, slPct,
      });
    }
  }
  return trades;
}

// ─── 統計 & 報告 ──────────────────────────────────────────────────────────────
function stats(trades) {
  const wins    = trades.filter(t => t.win);
  const losses  = trades.filter(t => !t.win);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const sumWin   = wins.reduce((s, t) => s + t.pnl, 0);
  const sumLoss  = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf       = sumLoss > 0 ? sumWin / sumLoss : Infinity;
  const avgSl    = trades.length ? trades.reduce((s, t) => s + t.slPct * 100, 0) / trades.length : 0;
  const avgW     = wins.length   ? sumWin  / wins.length   : 0;
  const avgL     = losses.length ? sumLoss / losses.length : 0;

  // 最大連敗
  let maxDD = 0, streak = 0;
  for (const t of trades) { streak = t.win ? 0 : streak + 1; maxDD = Math.max(maxDD, streak); }

  // 月度損益（用於計算最差月）
  const byMonth = {};
  for (const t of trades) {
    const m = new Date(t.exitTime).toISOString().slice(0, 7);
    byMonth[m] = (byMonth[m] || 0) + t.pnl;
  }
  const worstMonth = Math.min(...Object.values(byMonth), 0);

  return {
    n: trades.length, wr: wins.length / (trades.length || 1) * 100,
    totalPnl, pf, avgW, avgL, maxDD, worstMonth, avgSl,
  };
}

function printMonthly(label, trades) {
  const byMonth = {};
  for (const t of trades) {
    const m = new Date(t.exitTime).toISOString().slice(0, 7);
    if (!byMonth[m]) byMonth[m] = { n: 0, wins: 0, pnl: 0 };
    byMonth[m].n++;
    byMonth[m].pnl += t.pnl;
    if (t.win) byMonth[m].wins++;
  }
  console.log(`\n  【${label}】月度損益`);
  console.log(`  月份      筆   勝率    損益     累積`);
  let cum = 0;
  for (const m of Object.keys(byMonth).sort()) {
    const d  = byMonth[m];
    cum += d.pnl;
    const wr = d.n ? ((d.wins / d.n) * 100).toFixed(0) : 0;
    console.log(`  ${m}  ${String(d.n).padStart(3)}  ${String(wr).padStart(3)}%  ${(d.pnl >= 0 ? "+" : "") + d.pnl.toFixed(2).padStart(7)}  ${(cum >= 0 ? "+" : "") + cum.toFixed(2).padStart(7)}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const { readFileSync } = await import("fs");
  const rules    = JSON.parse(readFileSync("rules_e.json", "utf8"));
  const watchlist = rules.watchlist.slice(0, 65);
  const cutoff   = Date.now() - 365 * 24 * 60 * 60 * 1000;

  console.log(`\n${"═".repeat(68)}`);
  console.log(`  策略 E 止損結構對照回測 — 6 種配置`);
  console.log(`  ${watchlist.length} 幣種 | 1H | 過去 12 個月 | 資金 $${PORTFOLIO} | 風險 1%/筆`);
  console.log(`${"═".repeat(68)}\n`);

  // ── 下載資料（所有配置共用）────────────────────────────────────────────────
  const allData = {};
  for (let i = 0; i < watchlist.length; i++) {
    const symbol = watchlist[i];
    process.stdout.write(`  [${i + 1}/${watchlist.length}] ${symbol}... `);
    try {
      const candles  = await fetchCandles(symbol);
      const startIdx = candles.findIndex(c => c.time >= cutoff);
      if (startIdx < LOOKBACK) { console.log("資料不足"); continue; }
      allData[symbol] = candles;
      console.log(`${candles.length} 根`);
    } catch (e) {
      console.log(`錯誤: ${e.message}`);
    }
  }

  const timeSet = new Set();
  for (const c of Object.values(allData))
    c.filter(b => b.time >= cutoff).forEach(b => timeSet.add(b.time));
  const times = [...timeSet].sort((a, b) => a - b);
  console.log(`\n${Object.keys(allData).length} 幣種資料就緒，${times.length} 個時間點\n`);

  // ── 跑每個變體 ──────────────────────────────────────────────────────────────
  const results = [];
  for (const cfg of VARIANTS) {
    process.stdout.write(`  模擬 ${cfg.id.padEnd(12)}... `);
    const trades = runVariant(cfg, allData, times, cutoff);
    const s      = stats(trades);
    results.push({ cfg, trades, s });
    console.log(`完成 ${trades.length} 筆 | WR ${s.wr.toFixed(1)}% | PnL $${s.totalPnl.toFixed(2)} | PF ${s.pf === Infinity ? "∞" : s.pf.toFixed(2)}`);
  }

  // ── 對照表 ──────────────────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(68)}`);
  console.log(`  止損配置對照表`);
  console.log(`${"═".repeat(68)}`);
  console.log(`  配置           筆數  勝率    PnL      PF    平均SL%  連敗  最差月`);
  console.log(`  ${"─".repeat(63)}`);

  for (const { cfg, s } of results) {
    const pf = s.pf === Infinity ? "   ∞" : s.pf.toFixed(2).padStart(5);
    console.log(
      `  ${cfg.id.padEnd(13)}` +
      `  ${String(s.n).padStart(4)}` +
      `  ${s.wr.toFixed(1).padStart(5)}%` +
      `  ${(s.totalPnl >= 0 ? "+" : "") + s.totalPnl.toFixed(2).padStart(8)}` +
      `  ${pf}` +
      `  ${s.avgSl.toFixed(2).padStart(7)}%` +
      `  ${String(s.maxDD).padStart(4)}` +
      `  $${s.worstMonth.toFixed(2).padStart(7)}`
    );
  }
  console.log(`  ${"─".repeat(63)}`);

  // ── 最佳配置建議 ──────────────────────────────────────────────────────────
  const best = results.reduce((b, r) => r.s.pf > b.s.pf ? r : b);
  const bestWr = results.reduce((b, r) => r.s.wr > b.s.wr ? r : b);
  console.log(`\n  PF 最高：${best.cfg.id} (PF ${best.s.pf === Infinity ? "∞" : best.s.pf.toFixed(2)}, WR ${best.s.wr.toFixed(1)}%)`);
  console.log(`  勝率最高：${bestWr.cfg.id} (WR ${bestWr.s.wr.toFixed(1)}%, PF ${bestWr.s.pf === Infinity ? "∞" : bestWr.s.pf.toFixed(2)})`);

  // ── 詳細月度報告（前三名）────────────────────────────────────────────────
  const top3 = [...results].sort((a, b) => b.s.pf - a.s.pf).slice(0, 3);
  console.log(`\n${"═".repeat(68)}`);
  console.log(`  前三名配置月度明細`);
  console.log(`${"═".repeat(68)}`);
  for (const { cfg, trades } of top3) printMonthly(cfg.id, trades);

  console.log(`\n${"═".repeat(68)}\n`);
}

main().catch(console.error);
