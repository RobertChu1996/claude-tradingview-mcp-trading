/**
 * 策略 B (DMC) — Portfolio 回測，支援 MAX_OPEN 比較
 * 按時間順序跨幣種處理，全局共享倉位上限（與 GHA bot 一致）
 *
 * node backtest_dmc.js [max_open]        → 單一上限測試（預設6）
 * node backtest_dmc.js compare           → 4 vs 6 比較
 * node backtest_dmc.js 6 30              → MAX_OPEN=6，前30幣
 * node backtest_dmc.js filter            → 三路比較：基準 vs BTC過濾 vs BTC過濾+同向上限
 */

// ─── 參數（與 bot_dmc.js 完全一致）──────────────────────────────────────────
const SMA_PERIOD      = 25;
const VOL_RATIO       = 1.5;
const STRENGTH        = 0.7;
const SWING_LB        = 8;
const ATR_MULT        = 0.05;
const TP_RATIO        = 3.0;
const SMA_PREV_OFFSET = 5;
const COOLDOWN_BARS   = 2;   // 止損/止盈後冷卻 2 根4H棒
const MIN_PRICE       = 0.001;

const COMPARE_MODE  = process.argv[2] === "compare";
const FILTER_MODE   = process.argv[2] === "filter";
const OPTIMIZE_MODE = process.argv[2] === "optimize";
const MAX_OPEN      = (COMPARE_MODE || FILTER_MODE || OPTIMIZE_MODE) ? 6 : parseInt(process.argv[2] || "6");
const SYMBOL_LIMIT  = parseInt(process.argv[3] || "30");
const MONTHS        = parseInt(process.argv[4] || "12");
const PORTFOLIO     = 1000;
const RISK_PCT      = 0.01;
const MAX_TRADE_USD = 200;
const LOOKBACK      = SMA_PERIOD + SMA_PREV_OFFSET + 10;
const INTERVAL      = "4h";
const MS_CANDLE     = 4 * 3600 * 1000;

// ─── 幣種清單（與 bot_dmc.js 靜態清單一致）──────────────────────────────────
const WATCHLIST = [
  "BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT",
  "DOGEUSDT","ADAUSDT","AVAXUSDT","DOTUSDT","LINKUSDT",
  "LTCUSDT","UNIUSDT","ATOMUSDT","NEARUSDT","FTMUSDT",
  "MATICUSDT","SANDUSDT","MANAUSDT","AXSUSDT","GALAUSDT",
  "APEUSDT","OPUSDT","ARBUSDT","SUIUSDT","SEIUSDT",
  "TIAUSDT","INJUSDT","STXUSDT","ONDOUSDT","TONUSDT",
].slice(0, SYMBOL_LIMIT);

// ─── Binance 4H 歷史資料 ──────────────────────────────────────────────────────
async function fetchCandles(symbol) {
  const fetch   = (await import("node-fetch")).default;
  const need    = Math.ceil((MONTHS * 30 * 24 * 3600 * 1000) / MS_CANDLE) + LOOKBACK + 10;
  const all     = [];
  let endTime   = Date.now();

  while (all.length < need) {
    const limit = Math.min(1000, need - all.length);
    const url   = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${INTERVAL}&endTime=${endTime}&limit=${limit}`;
    const res   = await fetch(url);
    if (!res.ok) throw new Error(`Binance ${res.status}`);
    const data  = await res.json();
    if (!data.length) break;
    const candles = data.map(k => ({
      time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
    }));
    all.unshift(...candles);
    endTime = data[0][0] - 1;
    if (data.length < limit) break;
  }
  return all.sort((a, b) => a.time - b.time);
}

// ─── 指標（與 bot_dmc.js 一致）───────────────────────────────────────────────
function smaOf(closes, n) {
  return closes.slice(-n).reduce((a, b) => a + b, 0) / n;
}
function atrOf(candles, n = 14) {
  const trs = candles.slice(1).map((c, i) => {
    const p = candles[i].close;
    return Math.max(c.high - c.low, Math.abs(c.high - p), Math.abs(c.low - p));
  });
  return trs.slice(-n).reduce((a, b) => a + b, 0) / n;
}
function avgVolOf(candles, n = 20) {
  return candles.slice(-n).reduce((s, c) => s + c.volume, 0) / n;
}
function swingLowOf(candles, lb) {
  return Math.min(...candles.slice(-lb - 1, -1).map(c => c.low));
}
function swingHighOf(candles, lb) {
  return Math.max(...candles.slice(-lb - 1, -1).map(c => c.high));
}

// ─── 進場信號（volRatio 可調）────────────────────────────────────────────────
function checkSignal(candles, volRatio = VOL_RATIO) {
  if (candles.length < SMA_PERIOD + SMA_PREV_OFFSET + 10) return null;
  const closes   = candles.map(c => c.close);
  const price    = closes[closes.length - 1];
  if (price < MIN_PRICE) return null;

  const smaNow  = smaOf(closes, SMA_PERIOD);
  const smaPrev = smaOf(closes.slice(0, -SMA_PREV_OFFSET), SMA_PERIOD);
  const last    = candles[candles.length - 1];
  const volR    = last.volume / avgVolOf(candles, 20);
  const body    = Math.abs(last.close - last.open);
  const range   = last.high - last.low || 0.0001;
  const strength = body / range;
  const rec3    = closes.slice(-3).reduce((a, b) => a + b, 0) / 3;
  const prev3   = closes.slice(-6, -3).reduce((a, b) => a + b, 0) / 3;
  const atr     = atrOf(candles, 14);

  if (smaNow > smaPrev && price > smaNow && volR > volRatio &&
      last.close > last.open && strength > STRENGTH && rec3 > prev3) {
    const sl    = swingLowOf(candles, SWING_LB) - atr * ATR_MULT;
    const slPct = (price - sl) / price;
    if (sl >= price || slPct < 0.003 || slPct > 0.15) return null;
    const tp = price + (price - sl) * TP_RATIO;
    return { side: "long", stopLoss: sl, tp };
  }
  if (smaNow < smaPrev && price < smaNow && volR > volRatio &&
      last.close < last.open && strength > STRENGTH && rec3 < prev3) {
    const sl    = swingHighOf(candles, SWING_LB) + atr * ATR_MULT;
    const slPct = (sl - price) / price;
    if (sl <= price || slPct < 0.003 || slPct > 0.15) return null;
    const tp = price - (sl - price) * TP_RATIO;
    if (tp <= 0) return null;
    return { side: "short", stopLoss: sl, tp };
  }
  return null;
}

// ─── 1D SMA 方向（多時框確認，band 可調）────────────────────────────────────
function dailyTrend(dailyCandles, ts, band = 0.001) {
  const idx = dailyCandles.findLastIndex(c => c.time <= ts);
  if (idx < SMA_PERIOD + SMA_PREV_OFFSET) return 0;
  const closes  = dailyCandles.slice(0, idx + 1).map(c => c.close);
  const smaNow  = smaOf(closes, SMA_PERIOD);
  const smaPrev = smaOf(closes.slice(0, -SMA_PREV_OFFSET), SMA_PERIOD);
  if (smaNow > smaPrev * (1 + band)) return  1;
  if (smaNow < smaPrev * (1 - band)) return -1;
  return 0;
}

// ─── 追蹤止損（與 bot_dmc.js 一致）──────────────────────────────────────────
function trailingSL(pos, price) {
  const risk = Math.abs(pos.entryPrice - pos.stopLoss);
  if (!risk) return pos.stopLoss;
  const profit  = pos.side === "long" ? price - pos.entryPrice : pos.entryPrice - price;
  const profitR = profit / risk;
  if (profitR < 1) return pos.stopLoss;
  const lockR = Math.max(0, Math.floor(profitR * 2) / 2 - 1.0);
  const ns    = pos.side === "long"
    ? pos.entryPrice + risk * lockR
    : pos.entryPrice - risk * lockR;
  return pos.side === "long" ? Math.max(pos.stopLoss, ns) : Math.min(pos.stopLoss, ns);
}

// ─── 出場判斷（用 high/low 觸發，更準確）────────────────────────────────────
function checkExit(pos, candle) {
  const sl = trailingSL(pos, candle.close);
  pos.stopLoss = sl;

  if (pos.side === "long") {
    const slHit = candle.low  <= sl;
    const tpHit = candle.high >= pos.tp;
    if (slHit && tpHit) {
      const tpFirst = candle.close > candle.open;
      return { exit: true, ep: tpFirst ? pos.tp : sl, reason: tpFirst ? "止盈" : "止損" };
    }
    if (tpHit) return { exit: true, ep: pos.tp,  reason: "止盈" };
    if (slHit) return { exit: true, ep: sl,       reason: "止損" };
  } else {
    const slHit = candle.high >= sl;
    const tpHit = candle.low  <= pos.tp;
    if (slHit && tpHit) {
      const tpFirst = candle.close < candle.open;
      return { exit: true, ep: tpFirst ? pos.tp : sl, reason: tpFirst ? "止盈" : "止損" };
    }
    if (tpHit) return { exit: true, ep: pos.tp,  reason: "止盈" };
    if (slHit) return { exit: true, ep: sl,       reason: "止損" };
  }
  return { exit: false };
}

// ─── 月報輸出 ─────────────────────────────────────────────────────────────────
function printReport(label, trades, maxOpen) {
  const byMonth = {};
  for (const t of trades) {
    const m = new Date(t.exitTime).toISOString().slice(0, 7);
    if (!byMonth[m]) byMonth[m] = { trades: 0, wins: 0, pnl: 0 };
    byMonth[m].trades++;
    byMonth[m].pnl += t.pnl;
    if (t.win) byMonth[m].wins++;
  }

  console.log(`\n${"═".repeat(62)}`);
  console.log(`  策略 B (DMC) — MAX_OPEN=${maxOpen} — ${trades.length} 筆平倉`);
  console.log(`${"═".repeat(62)}`);
  console.log(`  月份      筆數   勝率     月損益    累積損益`);
  console.log(`  ${"─".repeat(55)}`);

  let cum = 0;
  for (const m of Object.keys(byMonth).sort()) {
    const d  = byMonth[m];
    const wr = d.trades ? ((d.wins / d.trades) * 100).toFixed(0) : "0";
    cum += d.pnl;
    console.log(`  ${m}   ${String(d.trades).padStart(4)}  ${wr.padStart(4)}%  ${((d.pnl >= 0 ? "+" : "") + d.pnl.toFixed(2)).padStart(9)}  ${((cum >= 0 ? "+" : "") + cum.toFixed(2)).padStart(10)}`);
  }

  const wins    = trades.filter(t => t.win);
  const losses  = trades.filter(t => !t.win);
  const wr      = trades.length ? (wins.length / trades.length * 100).toFixed(1) : "0";
  const allPnl  = trades.reduce((s, t) => s + t.pnl, 0);
  const sumWin  = wins.reduce((s, t) => s + t.pnl, 0);
  const sumLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf      = sumLoss > 0 ? (sumWin / sumLoss).toFixed(2) : "∞";
  const avgW    = wins.length   ? (sumWin / wins.length).toFixed(2)     : "0";
  const avgL    = losses.length ? (sumLoss / losses.length).toFixed(2)  : "0";
  const mdd     = calcMDD(trades);

  console.log(`  ${"─".repeat(55)}`);
  console.log(`  全期合計  ${String(trades.length).padStart(4)}  ${wr.padStart(4)}%  ${((allPnl >= 0 ? "+" : "") + allPnl.toFixed(2)).padStart(9)}`);
  console.log(`\n  平均獲利: +$${avgW} | 平均虧損: -$${avgL}`);
  console.log(`  Profit Factor: ${pf} | MDD: ${mdd.toFixed(1)}%`);
}

function calcMDD(trades) {
  let peak = 0, mdd = 0, cum = 0;
  for (const t of trades.sort((a, b) => a.exitTime - b.exitTime)) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    const dd = peak > 0 ? (peak - cum) / PORTFOLIO * 100 : 0;
    if (dd > mdd) mdd = dd;
  }
  return mdd;
}

// ─── BTC 趨勢方向（給定時間點的 SMA25 方向）────────────────────────────────
function btcTrend(btcCandles, ts) {
  const idx = btcCandles.findIndex(c => c.time === ts);
  if (idx < SMA_PERIOD + SMA_PREV_OFFSET) return 0;
  const closes  = btcCandles.slice(0, idx + 1).map(c => c.close);
  const smaNow  = smaOf(closes, SMA_PERIOD);
  const smaPrev = smaOf(closes.slice(0, -SMA_PREV_OFFSET), SMA_PERIOD);
  if (smaNow > smaPrev * 1.001) return  1;  // 上漲
  if (smaNow < smaPrev * 0.999) return -1;  // 下跌
  return 0;                                  // 橫盤
}

// ─── 核心模擬 ─────────────────────────────────────────────────────────────────
// opts: { btcFilter, maxSameDir, volRatio, timeFilter, partialTP, timeSL, dailyData }
function runSimulation(allData, times, cutoff, maxOpen, opts = {}) {
  const {
    btcFilter  = false,
    maxSameDir = maxOpen,
    volRatio   = VOL_RATIO,
    timeFilter = false,
    partialTP  = false,
    timeSL     = false,
    dailyData  = null,
    mtfBand    = 0.001,   // 1D SMA band threshold
  } = opts;

  const btcCandles = allData["BTCUSDT"] || [];
  const openPos    = [];
  const trades     = [];
  const cooldown   = {};

  for (const ts of times) {
    // ── 出場 ──────────────────────────────────────────────────────────────────
    for (const pos of [...openPos]) {
      const candles = allData[pos.symbol];
      const idx     = candles.findIndex(c => c.time === ts);
      if (idx < 0) continue;
      const candle  = candles[idx];

      // 時間止損：持倉 ≥10 根且未達 0.5R 獲利 → 平倉
      if (timeSL) {
        const barsHeld = (ts - pos.entryTime) / MS_CANDLE;
        if (barsHeld >= 10) {
          const risk   = Math.abs(pos.entryPrice - pos.stopLoss);
          const profit = pos.side === "long"
            ? candle.close - pos.entryPrice
            : pos.entryPrice - candle.close;
          if (profit < risk * 0.5) {
            const pnl = pos.side === "long"
              ? (candle.close - pos.entryPrice) * pos.quantity
              : (pos.entryPrice - candle.close) * pos.quantity;
            trades.push({ entryTime: pos.entryTime, exitTime: ts, symbol: pos.symbol, side: pos.side, pnl, win: pnl > 0, reason: "時間止損" });
            cooldown[pos.symbol] = ts;
            openPos.splice(openPos.indexOf(pos), 1);
            continue;
          }
        }
      }

      // 分批止盈：到達 1.5R 時平一半
      if (partialTP && !pos.halfClosed) {
        const risk      = Math.abs(pos.entryPrice - pos.stopLoss);
        const target15R = pos.side === "long" ? pos.entryPrice + risk * 1.5 : pos.entryPrice - risk * 1.5;
        const hit15R    = pos.side === "long" ? candle.high >= target15R : candle.low <= target15R;
        if (hit15R) {
          const halfQty = pos.quantity / 2;
          const pnl     = pos.side === "long"
            ? (target15R - pos.entryPrice) * halfQty
            : (pos.entryPrice - target15R) * halfQty;
          trades.push({ entryTime: pos.entryTime, exitTime: ts, symbol: pos.symbol, side: pos.side, pnl, win: true, reason: "分批止盈" });
          pos.quantity   = halfQty;
          pos.halfClosed = true;
        }
      }

      const { exit, ep, reason } = checkExit(pos, candle);
      if (exit) {
        const pnl = pos.side === "long"
          ? (ep - pos.entryPrice) * pos.quantity
          : (pos.entryPrice - ep) * pos.quantity;
        trades.push({ entryTime: pos.entryTime, exitTime: ts, symbol: pos.symbol, side: pos.side, pnl, win: pnl > 0, reason });
        cooldown[pos.symbol] = ts;
        openPos.splice(openPos.indexOf(pos), 1);
      }
    }

    // ── 入場 ──────────────────────────────────────────────────────────────────
    if (openPos.length >= maxOpen) continue;

    // 時段過濾：跳過 UTC 00:00–08:00 開盤的 4H 棒（低流動性）
    if (timeFilter) {
      const hourUtc = (ts % (24 * 3600 * 1000)) / 3600000;
      if (hourUtc < 8) continue;
    }

    const trend = btcFilter ? btcTrend(btcCandles, ts) : 0;

    for (const [symbol, candles] of Object.entries(allData)) {
      if (symbol === "BTCUSDT") continue;
      if (openPos.length >= maxOpen) break;
      if (openPos.some(p => p.symbol === symbol)) continue;
      if (cooldown[symbol] && ts - cooldown[symbol] < COOLDOWN_BARS * MS_CANDLE) continue;

      const idx = candles.findIndex(c => c.time === ts);
      if (idx < LOOKBACK || candles[idx].time < cutoff) continue;

      const slice = candles.slice(0, idx + 1);
      const price = candles[idx].close;
      const sig   = checkSignal(slice, volRatio);
      if (!sig) continue;

      // BTC 方向過濾
      if (btcFilter && trend !== 0) {
        if (trend === 1 && sig.side === "short") continue;
        if (trend === -1 && sig.side === "long")  continue;
      }

      // 多時框確認：個幣 1D SMA 方向需與信號一致
      if (dailyData && dailyData[symbol]) {
        const dTrend = dailyTrend(dailyData[symbol], ts, mtfBand);
        if (dTrend !== 0 && dTrend !== (sig.side === "long" ? 1 : -1)) continue;
      }

      // 同向持倉上限
      const sameDirCount = openPos.filter(p => p.side === sig.side).length;
      if (sameDirCount >= maxSameDir) continue;

      const slPct   = Math.abs(price - sig.stopLoss) / price;
      const rawSize = slPct > 0.001 ? (PORTFOLIO * RISK_PCT) / slPct : PORTFOLIO * RISK_PCT;
      const size    = Math.min(rawSize, MAX_TRADE_USD);
      openPos.push({
        symbol, side: sig.side, entryPrice: price,
        entryTime: ts, stopLoss: sig.stopLoss, tp: sig.tp,
        quantity: size / price, halfClosed: false,
      });
    }
  }

  return trades;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const cutoff = Date.now() - MONTHS * 30 * 24 * 3600 * 1000;

  console.log(`\n策略 B (DMC/SMA25) 回測｜${WATCHLIST.length} 幣種｜4H｜過去 ${MONTHS} 個月`);
  if (COMPARE_MODE) console.log("模式：MAX_OPEN 4 vs 6 比較");
  if (FILTER_MODE)  console.log("模式：基準 vs BTC過濾 vs BTC過濾+同向上限");
  console.log("═".repeat(62));

  // 下載資料（filter/optimize 模式需確保 BTCUSDT 在清單內）
  const fetchList = ((FILTER_MODE || OPTIMIZE_MODE) && !WATCHLIST.includes("BTCUSDT"))
    ? ["BTCUSDT", ...WATCHLIST]
    : WATCHLIST;

  const allData = {};
  for (let i = 0; i < fetchList.length; i++) {
    const symbol = fetchList[i];
    process.stdout.write(`  [${i + 1}/${fetchList.length}] ${symbol}... `);
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

  // 收集時序
  const timeSet = new Set();
  for (const c of Object.values(allData))
    c.filter(b => b.time >= cutoff).forEach(b => timeSet.add(b.time));
  const times = [...timeSet].sort((a, b) => a - b);
  console.log(`\n共 ${times.length} 個時間點，開始模擬...\n`);

  const pfOf = (t) => {
    const w = t.filter(x => x.win).reduce((s, x) => s + x.pnl, 0);
    const l = Math.abs(t.filter(x => !x.win).reduce((s, x) => s + x.pnl, 0));
    return l > 0 ? w / l : Infinity;
  };
  const summaryRow = (label, t) => {
    const wr  = t.length ? (t.filter(x => x.win).length / t.length * 100).toFixed(1) : "0";
    const pnl = t.reduce((s, x) => s + x.pnl, 0).toFixed(2);
    const pf  = pfOf(t).toFixed(2);
    const mdd = calcMDD(t).toFixed(1);
    return `  ${label.padEnd(22)} ${String(t.length).padStart(5)}  ${(wr+"%").padStart(6)}  ${("$"+pnl).padStart(9)}  ${pf.padStart(6)}  ${(mdd+"%").padStart(7)}`;
  };

  if (OPTIMIZE_MODE) {
    // 下載 1D 資料供 MTF 使用
    console.log("\n下載 1D 資料（多時框確認）...");
    const fetch1D  = (await import("node-fetch")).default;
    const dailyData = {};
    for (const symbol of Object.keys(allData)) {
      if (symbol === "BTCUSDT") continue;
      try {
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&limit=400`;
        const r   = await fetch1D(url);
        const d   = await r.json();
        if (Array.isArray(d) && d.length) {
          dailyData[symbol] = d.map(k => ({ time: k[0], close: +k[4] }));
          process.stdout.write(".");
        }
      } catch {}
    }
    console.log(`\n完成（${Object.keys(dailyData).length} 幣）\n`);

    const BASE = { btcFilter: true };  // BTC filter 已知有效，作為所有方案的基底

    const scenarios = [
      { label: "基準（BTC過濾）",              opts: { ...BASE } },
      { label: "+成交量門檻2x",                opts: { ...BASE, volRatio: 2.0 } },
      { label: "+成交量門檻2.5x",              opts: { ...BASE, volRatio: 2.5 } },
      { label: "+時段過濾(UTC≥8)",             opts: { ...BASE, timeFilter: true } },
      { label: "+分批止盈(1.5R平半)",          opts: { ...BASE, partialTP: true } },
      { label: "+時間止損(10棒<0.5R平)",       opts: { ...BASE, timeSL: true } },
      { label: "+1D MTF band=0.1%（現行）",    opts: { ...BASE, dailyData, mtfBand: 0.001 } },
      { label: "+1D MTF band=0.05%",           opts: { ...BASE, dailyData, mtfBand: 0.0005 } },
      { label: "+1D MTF band=0%（純方向）",    opts: { ...BASE, dailyData, mtfBand: 0 } },
      { label: "全組合(vol2x+時段+分批+時間)", opts: { ...BASE, volRatio: 2.0, timeFilter: true, partialTP: true, timeSL: true } },
    ];

    const results = [];
    for (const sc of scenarios) {
      process.stdout.write(`  ${sc.label}... `);
      const t = runSimulation(allData, times, cutoff, MAX_OPEN, sc.opts);
      const w = t.filter(x => x.win).reduce((s, x) => s + x.pnl, 0);
      const l = Math.abs(t.filter(x => !x.win).reduce((s, x) => s + x.pnl, 0));
      const pf  = l > 0 ? w / l : Infinity;
      const pnl = t.reduce((s, x) => s + x.pnl, 0);
      const wr  = t.length ? t.filter(x => x.win).length / t.length * 100 : 0;
      const mdd = calcMDD(t);
      console.log(`${t.length} 筆`);
      results.push({ label: sc.label, n: t.length, wr, pnl, pf, mdd });
    }

    console.log(`\n${"═".repeat(80)}`);
    console.log("  優化方案比較（12個月, 30幣, MAX_OPEN=6, BTC過濾為基底）");
    console.log(`${"─".repeat(80)}`);
    console.log(`  ${"方案".padEnd(28)} ${"筆數".padStart(5)}  ${"勝率".padStart(6)}  ${"總損益".padStart(9)}  ${"PF".padStart(6)}  ${"MDD".padStart(7)}`);
    console.log(`  ${"─".repeat(75)}`);
    for (const r of results) {
      const better = r !== results[0] && r.pf > results[0].pf ? " ✓" : "";
      console.log(
        `  ${r.label.padEnd(28)} ${String(r.n).padStart(5)}  ${(r.wr.toFixed(1)+"%").padStart(6)}` +
        `  ${("$"+r.pnl.toFixed(2)).padStart(9)}  ${r.pf.toFixed(2).padStart(6)}  ${(r.mdd.toFixed(1)+"%").padStart(7)}${better}`
      );
    }
    console.log(`${"═".repeat(80)}\n`);

  } else if (FILTER_MODE) {
    console.log("  [1/3] 基準（無過濾）...");
    const tBase = runSimulation(allData, times, cutoff, 6);
    console.log(`  完成：${tBase.length} 筆`);

    console.log("  [2/3] BTC 方向過濾...");
    const tBtc  = runSimulation(allData, times, cutoff, 6, { btcFilter: true });
    console.log(`  完成：${tBtc.length} 筆`);

    console.log("  [3/3] BTC 過濾 + 同向上限3...");
    const tBtcDir = runSimulation(allData, times, cutoff, 6, { btcFilter: true, maxSameDir: 3 });
    console.log(`  完成：${tBtcDir.length} 筆\n`);

    printReport("基準", tBase, 6);
    printReport("BTC過濾", tBtc, 6);
    printReport("BTC過濾+同向上限", tBtcDir, 6);

    console.log(`\n${"═".repeat(70)}`);
    console.log("  三路比較摘要");
    console.log(`${"─".repeat(70)}`);
    console.log(`  方案                    筆數    勝率      總損益      PF      MDD`);
    console.log(`  ${"─".repeat(65)}`);
    console.log(summaryRow("基準（無過濾）", tBase));
    console.log(summaryRow("BTC方向過濾", tBtc));
    console.log(summaryRow("BTC過濾+同向上限3", tBtcDir));
    console.log(`${"═".repeat(70)}\n`);

  } else if (COMPARE_MODE) {
    console.log("  模擬 MAX_OPEN=4...");
    const trades4 = runSimulation(allData, times, cutoff, 4);
    console.log(`  完成：${trades4.length} 筆\n`);

    console.log("  模擬 MAX_OPEN=6...");
    const trades6 = runSimulation(allData, times, cutoff, 6);
    console.log(`  完成：${trades6.length} 筆`);

    printReport("MAX_OPEN=4", trades4, 4);
    printReport("MAX_OPEN=6", trades6, 6);

    console.log(`\n${"═".repeat(62)}`);
    console.log("  比較摘要");
    console.log(`${"─".repeat(62)}`);
    console.log(`  項目            MAX_OPEN=4      MAX_OPEN=6`);
    console.log(`  筆數            ${String(trades4.length).padStart(8)}        ${String(trades6.length).padStart(8)}`);
    const wr4 = (trades4.filter(t => t.win).length / trades4.length * 100).toFixed(1);
    const wr6 = (trades6.filter(t => t.win).length / trades6.length * 100).toFixed(1);
    console.log(`  勝率            ${(wr4 + "%").padStart(8)}        ${(wr6 + "%").padStart(8)}`);
    const pnl4 = trades4.reduce((s, t) => s + t.pnl, 0).toFixed(2);
    const pnl6 = trades6.reduce((s, t) => s + t.pnl, 0).toFixed(2);
    console.log(`  總損益          ${("$" + pnl4).padStart(8)}        ${("$" + pnl6).padStart(8)}`);
    console.log(`  Profit Factor   ${String(pfOf(trades4).toFixed(2)).padStart(8)}        ${String(pfOf(trades6).toFixed(2)).padStart(8)}`);
    console.log(`  MDD             ${(calcMDD(trades4).toFixed(1) + "%").padStart(8)}        ${(calcMDD(trades6).toFixed(1) + "%").padStart(8)}`);
    console.log(`${"═".repeat(62)}\n`);
  } else {
    console.log(`  模擬 MAX_OPEN=${MAX_OPEN}...`);
    const trades = runSimulation(allData, times, cutoff, MAX_OPEN);
    console.log(`  完成：${trades.length} 筆`);
    printReport(`MAX_OPEN=${MAX_OPEN}`, trades, MAX_OPEN);
    console.log();
  }
}

main().catch(console.error);
