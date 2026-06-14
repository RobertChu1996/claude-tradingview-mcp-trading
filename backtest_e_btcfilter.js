/**
 * 策略 E — BTC MA200 過濾器效果驗證
 * 對比：無過濾 vs 有過濾（牛市只做多/熊市只做空）
 * 測試組合：1H×TP2R, 1H×TP1.5R, 4H×TP2R, 4H×TP1.5R，各測有/無過濾 = 8組
 * 執行：node backtest_e_btcfilter.js
 */

const PORTFOLIO = 1000;
const RISK      = PORTFOLIO * 0.01;
const MAX_TRADE = 100;
const MAX_OPEN  = 4;
const LOOKBACK  = 60;

const COMBOS = [
  { id: "1H  2R  無濾", interval: "1h", msPerBar: 3600_000,     tpR: 2.0, btcFilter: false },
  { id: "1H  2R  BTC↑", interval: "1h", msPerBar: 3600_000,     tpR: 2.0, btcFilter: true  },
  { id: "1H  1.5R 無濾", interval: "1h", msPerBar: 3600_000,     tpR: 1.5, btcFilter: false },
  { id: "1H  1.5R BTC↑", interval: "1h", msPerBar: 3600_000,     tpR: 1.5, btcFilter: true  },
  { id: "4H  2R  無濾", interval: "4h", msPerBar: 4 * 3600_000,  tpR: 2.0, btcFilter: false },
  { id: "4H  2R  BTC↑", interval: "4h", msPerBar: 4 * 3600_000,  tpR: 2.0, btcFilter: true  },
  { id: "4H  1.5R 無濾", interval: "4h", msPerBar: 4 * 3600_000,  tpR: 1.5, btcFilter: false },
  { id: "4H  1.5R BTC↑", interval: "4h", msPerBar: 4 * 3600_000,  tpR: 1.5, btcFilter: true  },
];

// ─── 資料抓取 ─────────────────────────────────────────────────────────────────
async function fetchCandles(symbol, interval, msPerBar) {
  const oneYear = 365 * 24 * 3600_000;
  const need    = Math.ceil(oneYear / msPerBar) + LOOKBACK + 10;
  const all     = [];
  let endTime   = Date.now();

  while (all.length < need) {
    const limit = Math.min(1000, need - all.length);
    const url   = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&endTime=${endTime}&limit=${limit}`;
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

// BTC 日線 MA200 lookup table: date string → { ma200, close }
async function buildBtcMaTable() {
  const btc = await fetchCandles("BTCUSDT", "1d", 86400_000);
  const table = {};
  for (let i = 200; i < btc.length; i++) {
    const ma200 = btc.slice(i - 200, i).reduce((s, c) => s + c.close, 0) / 200;
    const dateStr = new Date(btc[i].time).toISOString().slice(0, 10);
    table[dateStr] = { ma200, close: btc[i].close, isBull: btc[i].close >= ma200 };
  }
  return table;
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
  for (let i = 1; i < sl.length; i++) { const d = sl[i] - sl[i - 1]; d > 0 ? (g += d) : (l -= d); }
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
    const up = c.high - candles[i].high, down = candles[i].low - c.low;
    return {
      plus:  up > down && up > 0 ? up : 0,
      minus: down > up && down > 0 ? down : 0,
      tr: Math.max(c.high - c.low, Math.abs(c.high - candles[i].close), Math.abs(c.low - candles[i].close)),
    };
  });
  const s = dms.slice(-period), sumTR = s.reduce((a, d) => a + d.tr, 0) || 1;
  const diP = s.reduce((a, d) => a + d.plus, 0) / sumTR * 100;
  const diM = s.reduce((a, d) => a + d.minus, 0) / sumTR * 100;
  return Math.abs(diP - diM) / ((diP + diM) || 1) * 100;
}

// ─── 策略 E 信號 ──────────────────────────────────────────────────────────────
function signalE(candles, isBull, btcFilter) {
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

  // 正確的 EMA21 斜率：用 3 根前的完整 EMA21
  const prevCloses   = candles.slice(0, -3).map(c => c.close);
  const e21_prev     = prevCloses.length >= 21 ? calcEMA(prevCloses, 21) : null;
  const ema21Rising  = e21_prev ? e21 > e21_prev * 1.0005 : false;
  const ema21Falling = e21_prev ? e21 < e21_prev * 0.9995 : false;

  const adxV       = calcADX(candles, 14);
  const trending   = adxV > 20;
  const avgVol     = candles.slice(-21, -1).reduce((s, c) => s + c.volume, 0) / 20;
  const volConfirm = last.volume > avgVol;

  const canLong  = !btcFilter || isBull;   // 牛市才做多
  const canShort = !btcFilter || !isBull;  // 熊市才做空

  if (canLong && e21 > e50 && price > e50 && r14 >= 35 && r14 <= 52
      && last.close > last.open && ema21Rising && trending && volConfirm) {
    const sl    = Math.min(...candles.slice(-9, -1).map(c => c.low)) - atrV * 0.1;
    const slPct = Math.abs(price - sl) / price * 100;
    if (slPct < 0.3 || slPct > 5 || sl >= price) return null;
    return { side: "long", stopLoss: sl };
  }
  if (canShort && e21 < e50 && price < e50 && r14 >= 48 && r14 <= 65
      && last.close < last.open && ema21Falling && trending && volConfirm) {
    const sl    = Math.max(...candles.slice(-9, -1).map(c => c.high)) + atrV * 0.1;
    const slPct = Math.abs(price - sl) / price * 100;
    if (slPct < 0.3 || slPct > 5 || sl <= price) return null;
    return { side: "short", stopLoss: sl };
  }
  return null;
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

function exitE(pos, candle, tpR) {
  pos.stopLoss   = trailingStop(pos, candle.close);
  const risk     = Math.abs(pos.entryPrice - pos.stopLoss);
  const tp       = pos.side === "long" ? pos.entryPrice + risk * tpR : pos.entryPrice - risk * tpR;
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

// ─── 回測 ─────────────────────────────────────────────────────────────────────
function runVariant(allData, times, cutoff, tpR, btcFilter, btcMaTable) {
  const openPos = [];
  const trades  = [];

  for (const ts of times) {
    for (const pos of [...openPos]) {
      const candles = allData[pos.symbol];
      const idx     = candles.findIndex(c => c.time === ts);
      if (idx < 0) continue;
      const { exit, ep } = exitE(pos, candles[idx], tpR);
      if (exit) {
        const pnl = pos.side === "long"
          ? (ep - pos.entryPrice) * pos.quantity
          : (pos.entryPrice - ep) * pos.quantity;
        trades.push({ exitTime: ts, symbol: pos.symbol, pnl, win: pnl > 0 });
        openPos.splice(openPos.indexOf(pos), 1);
      }
    }

    if (openPos.length >= MAX_OPEN) continue;

    const dateStr = new Date(ts).toISOString().slice(0, 10);
    const btcDay  = btcMaTable[dateStr];
    const isBull  = btcDay ? btcDay.isBull : true; // 預設牛市（資料不足時）

    for (const [symbol, candles] of Object.entries(allData)) {
      if (openPos.length >= MAX_OPEN) break;
      if (openPos.some(p => p.symbol === symbol)) continue;
      const idx = candles.findIndex(c => c.time === ts);
      if (idx < LOOKBACK) continue;
      const slice = candles.slice(0, idx + 1);
      const price = candles[idx].close;
      const sig   = signalE(slice, isBull, btcFilter);
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

// ─── 統計 ─────────────────────────────────────────────────────────────────────
function stats(trades) {
  if (!trades.length) return { n: 0, wr: 0, totalPnl: 0, pf: 0, avgW: 0, avgL: 0, maxDD: 0, profitMonths: 0, totalMonths: 0 };
  const wins     = trades.filter(t => t.win);
  const losses   = trades.filter(t => !t.win);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const sumWin   = wins.reduce((s, t) => s + t.pnl, 0);
  const sumLoss  = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf       = sumLoss > 0 ? sumWin / sumLoss : Infinity;
  let maxDD = 0, streak = 0;
  for (const t of trades) { streak = t.win ? 0 : streak + 1; maxDD = Math.max(maxDD, streak); }
  const byMonth  = {};
  for (const t of trades) {
    const m = new Date(t.exitTime).toISOString().slice(0, 7);
    byMonth[m] = (byMonth[m] || 0) + t.pnl;
  }
  const monthVals    = Object.values(byMonth);
  const profitMonths = monthVals.filter(v => v > 0).length;
  return { n: trades.length, wr: wins.length / trades.length * 100,
    totalPnl, pf, avgW: wins.length ? sumWin / wins.length : 0,
    avgL: losses.length ? sumLoss / losses.length : 0,
    maxDD, profitMonths, totalMonths: monthVals.length };
}

function printMonthly(label, trades) {
  const byMonth = {};
  for (const t of trades) {
    const m = new Date(t.exitTime).toISOString().slice(0, 7);
    if (!byMonth[m]) byMonth[m] = { n: 0, wins: 0, pnl: 0 };
    byMonth[m].n++; byMonth[m].pnl += t.pnl;
    if (t.win) byMonth[m].wins++;
  }
  console.log(`\n  【${label}】`);
  console.log(`  月份      筆   勝率     損益      累積`);
  let cum = 0;
  for (const m of Object.keys(byMonth).sort()) {
    const d = byMonth[m]; cum += d.pnl;
    const wr   = d.n ? ((d.wins / d.n) * 100).toFixed(0) : 0;
    const sign = d.pnl >= 0 ? "+" : "";
    const cs   = cum >= 0 ? "+" : "";
    console.log(`  ${m}  ${String(d.n).padStart(3)}  ${String(wr).padStart(3)}%  ${sign}${d.pnl.toFixed(2).padStart(8)}  ${cs}${cum.toFixed(2).padStart(8)}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const { readFileSync } = await import("fs");
  const rules    = JSON.parse(readFileSync("rules_e.json", "utf8"));
  const watchlist = rules.watchlist.slice(0, 65);
  const cutoff   = Date.now() - 365 * 24 * 3600_000;

  console.log(`\n${"═".repeat(72)}`);
  console.log(`  策略 E — BTC MA200 過濾效果驗證（8 種組合）`);
  console.log(`  ${watchlist.length} 幣種 | 12個月 | $${PORTFOLIO} 資金 | 牛市只做多/熊市只做空`);
  console.log(`${"═".repeat(72)}\n`);

  // 預先建立 BTC MA200 表（日線，共用）
  process.stdout.write("  建立 BTC MA200 日線表... ");
  const btcMaTable = await buildBtcMaTable();
  const bullDays   = Object.values(btcMaTable).filter(d => d.isBull).length;
  const totalDays  = Object.keys(btcMaTable).length;
  console.log(`完成 (${totalDays}天, 牛市${bullDays}天/${Math.round(bullDays/totalDays*100)}%)`);

  const results    = [];
  let lastInterval = "";

  for (const combo of COMBOS) {
    // 同框架的兩個組合共用資料（避免重複下載）
    if (combo.interval !== lastInterval) {
      lastInterval = combo.interval;
      console.log(`\n── ${combo.interval.toUpperCase()} 資料下載 ${"─".repeat(48)}`);

      // 共用的 allData/times（存在閉包中，下面兩個組合都用）
      var sharedData  = {};
      var sharedTimes = [];

      for (let i = 0; i < watchlist.length; i++) {
        const symbol = watchlist[i];
        process.stdout.write(`  [${i + 1}/${watchlist.length}] ${symbol}... `);
        try {
          const candles  = await fetchCandles(symbol, combo.interval, combo.msPerBar);
          const startIdx = candles.findIndex(c => c.time >= cutoff);
          if (startIdx < LOOKBACK) { console.log("資料不足"); continue; }
          sharedData[symbol] = candles;
          console.log(`${candles.length} 根`);
        } catch (e) { console.log(`錯誤: ${e.message}`); }
      }

      const timeSet = new Set();
      for (const c of Object.values(sharedData))
        c.filter(b => b.time >= cutoff).forEach(b => timeSet.add(b.time));
      sharedTimes = [...timeSet].sort((a, b) => a - b);
      console.log(`  → ${Object.keys(sharedData).length} 幣種，${sharedTimes.length} 個時間點`);
    }

    process.stdout.write(`  模擬 ${combo.id.padEnd(14)}... `);
    const trades = runVariant(sharedData, sharedTimes, cutoff, combo.tpR, combo.btcFilter, btcMaTable);
    const s      = stats(trades);
    results.push({ combo, trades, s });
    const pf   = s.pf === Infinity ? "∞" : s.pf.toFixed(2);
    const sign = s.totalPnl >= 0 ? "+" : "";
    console.log(`${trades.length} 筆 | WR ${s.wr.toFixed(1)}% | PnL ${sign}$${s.totalPnl.toFixed(2)} | PF ${pf} | 盈利月 ${s.profitMonths}/${s.totalMonths}`);
  }

  // ── 對照表 ──────────────────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(72)}`);
  console.log(`  BTC 過濾效果對照表`);
  console.log(`${"═".repeat(72)}`);
  console.log(`  配置              筆數   WR      PnL      PF    連敗  盈利月`);
  console.log(`  ${"─".repeat(67)}`);

  for (let i = 0; i < results.length; i++) {
    const { combo, s } = results[i];
    const pf   = s.pf === Infinity ? "   ∞" : s.pf.toFixed(2).padStart(5);
    const sign = s.totalPnl >= 0 ? "+" : "";
    const row = `  ${combo.id.padEnd(17)} ${String(s.n).padStart(5)}  ${s.wr.toFixed(1).padStart(5)}%  ${sign}${s.totalPnl.toFixed(2).padStart(8)}  ${pf}  ${String(s.maxDD).padStart(4)}  ${s.profitMonths}/${s.totalMonths}`;
    console.log(row);
    // 每對之間加分隔線
    if (i % 2 === 1) console.log(`  ${"─".repeat(67)}`);
  }

  // 最佳
  const bestPF = results.reduce((b, r) => r.s.pf > b.s.pf ? r : b);
  console.log(`\n  ★ 最佳組合：${bestPF.combo.id}（PF ${bestPF.s.pf === Infinity ? "∞" : bestPF.s.pf.toFixed(2)}, WR ${bestPF.s.wr.toFixed(1)}%, 盈利月 ${bestPF.s.profitMonths}/${bestPF.s.totalMonths}）`);

  // ── 月度明細（有 BTC 過濾的 4 組）────────────────────────────────────────
  console.log(`\n${"═".repeat(72)}`);
  console.log(`  有 BTC MA200 過濾 — 月度損益明細`);
  console.log(`${"═".repeat(72)}`);
  for (const { combo, trades } of results.filter(r => r.combo.btcFilter))
    printMonthly(combo.id, trades);

  console.log(`\n${"═".repeat(72)}\n`);
}

main().catch(console.error);
