/**
 * 策略 C 逐幣分析 — 找出優質幣 / 拖累幣
 * 輸出排名 + 自動寫入 rules_bb_optimized.json
 *
 * 用法：node optimize_watchlist.js [min_pf] [min_trades]
 *   min_pf     最低 Profit Factor 門檻 (預設 1.0)
 *   min_trades 最低交易筆數 (預設 3)
 */

import { readFileSync, writeFileSync } from "fs";

const MIN_PF     = parseFloat(process.argv[2] || "1.0");
const MIN_TRADES = parseInt(process.argv[3]  || "3");
const PORTFOLIO  = 388;
const RISK       = 0.01;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchCandles(symbol, interval = "1h", months = 3) {
  const fetch = (await import("node-fetch")).default;
  const ms = 60 * 60 * 1000;
  const total = Math.ceil((months * 30 * 24 * 60 * 60 * 1000) / ms);
  const all = [];
  let endTime = Date.now();
  while (all.length < total) {
    const limit = Math.min(1000, total - all.length);
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&endTime=${endTime}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
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

function sma(arr, n) { const s = arr.slice(-n); return s.reduce((a,b) => a+b,0)/s.length; }

function atr(candles, n = 14) {
  if (candles.length < n + 1) return null;
  const trs = candles.slice(1).map((c, i) =>
    Math.max(c.high - c.low, Math.abs(c.high - candles[i].close), Math.abs(c.low - candles[i].close))
  );
  return trs.slice(-n).reduce((a,b) => a+b,0) / n;
}

function bb(closes, n = 20, mult = 2) {
  if (closes.length < n) return null;
  const sl = closes.slice(-n);
  const mid = sl.reduce((a,b) => a+b,0) / n;
  const std = Math.sqrt(sl.reduce((s,c) => s + (c-mid)**2, 0) / n);
  return { upper: mid + mult*std, middle: mid, lower: mid - mult*std };
}

function avgVol(candles, n = 20) {
  return candles.slice(-n).reduce((s,c) => s+c.volume, 0) / n;
}

function calcSize(price, sl) {
  const risk = PORTFOLIO * RISK;
  const pct  = Math.abs(price - sl) / price;
  if (pct < 0.001) return risk * 2 / price;
  return Math.min(risk / pct, PORTFOLIO) / price;
}

function trailingStop(pos, price) {
  const { side, entryPrice, stopLoss } = pos;
  const r = Math.abs(entryPrice - stopLoss);
  if (!r) return stopLoss;
  const profit = side === "long" ? price - entryPrice : entryPrice - price;
  const profitR = profit / r;
  if (profitR < 1.0) return stopLoss;
  const lockR = Math.max(0, Math.floor(profitR * 2) / 2 - 1.0);
  const newSL = side === "long" ? entryPrice + r * lockR : entryPrice - r * lockR;
  return side === "long" ? Math.max(stopLoss, newSL) : Math.min(stopLoss, newSL);
}

// ─── Strategy C Signal / Exit ─────────────────────────────────────────────────

function signalC(candles) {
  if (candles.length < 25) return null;
  const closes = candles.map(c => c.close);
  const price = closes.at(-1), prev = closes.at(-2);
  const bbVal = bb(closes, 20, 2);
  const atrVal = atr(candles, 14);
  if (!bbVal || !atrVal) return null;

  const avgATR = (() => {
    const vals = [];
    for (let i = 14; i <= Math.min(candles.length-1, 24); i++)
      vals.push(atr(candles.slice(0, i+1), 14));
    return vals.reduce((a,b) => a+b,0) / (vals.length||1);
  })();

  const volR  = candles.at(-1).volume / avgVol(candles, 20);
  const s20n  = sma(closes, 20);
  const s20p  = sma(closes.slice(0,-1), 20);

  if (price > bbVal.upper && prev <= bbVal.upper && volR > 1.5 && s20n > s20p && atrVal > avgATR)
    return { side: "long",  stopLoss: candles.at(-1).low  - atrVal * 0.5 };
  if (price < bbVal.lower && prev >= bbVal.lower && volR > 1.5 && s20n < s20p && atrVal > avgATR)
    return { side: "short", stopLoss: candles.at(-1).high + atrVal * 0.5 };
  return null;
}

function exitC(pos, candles) {
  const closes = candles.map(c => c.close);
  const price  = closes.at(-1), prev = closes.at(-2);
  const bbVal  = bb(closes, 20, 2);
  const sl     = trailingStop(pos, price);
  if (!bbVal) return null;

  if (pos.side === "long") {
    if (price <= sl)       return `止損`;
    if (price <= bbVal.middle) return "回中軌";
    if (price < bbVal.upper && prev > bbVal.upper) return "突破失效";
  } else {
    if (price >= sl)       return `止損`;
    if (price >= bbVal.middle) return "回中軌";
    if (price > bbVal.lower && prev < bbVal.lower) return "突破失效";
  }
  return null;
}

// ─── Per-symbol backtest ──────────────────────────────────────────────────────

async function backtestSymbol(symbol) {
  const candles = await fetchCandles(symbol, "1h", 3);
  if (candles.length < 50) return null;

  const trades = [];
  let pos = null;

  for (let i = 30; i < candles.length; i++) {
    const slice = candles.slice(0, i + 1);
    const price = slice.at(-1).close;

    if (pos) {
      pos.stopLoss = trailingStop(pos, price);
      const reason = exitC(pos, slice);
      if (reason) {
        const pnl = pos.side === "long"
          ? (price - pos.entryPrice) * pos.qty
          : (pos.entryPrice - price) * pos.qty;
        trades.push({ win: pnl > 0, pnl });
        pos = null;
      }
    } else {
      const sig = signalC(slice);
      if (sig) {
        if (sig.side === "long"  && sig.stopLoss >= price) continue;
        if (sig.side === "short" && sig.stopLoss <= price) continue;
        pos = { side: sig.side, entryPrice: price, stopLoss: sig.stopLoss, qty: calcSize(price, sig.stopLoss) };
      }
    }
  }

  // open position at end
  if (pos) {
    const price = candles.at(-1).close;
    const pnl   = pos.side === "long"
      ? (price - pos.entryPrice) * pos.qty
      : (pos.entryPrice - price) * pos.qty;
    trades.push({ win: pnl > 0, pnl, open: true });
  }

  const closed = trades.filter(t => !t.open);
  if (!closed.length) return { symbol, trades: 0, winRate: 0, pf: 0, pnl: 0 };

  const wins   = closed.filter(t => t.win);
  const losses = closed.filter(t => !t.win);
  const gw = wins.reduce((s,t) => s+t.pnl, 0);
  const gl = Math.abs(losses.reduce((s,t) => s+t.pnl, 0));
  const pf = gl > 0 ? gw / gl : gw > 0 ? 99 : 0;

  return {
    symbol,
    trades:  closed.length,
    winRate: (wins.length / closed.length * 100).toFixed(1),
    pf:      parseFloat(pf.toFixed(2)),
    pnl:     parseFloat(closed.reduce((s,t) => s+t.pnl, 0).toFixed(2)),
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const rules   = JSON.parse(readFileSync("rules_bb.json", "utf8"));
  const symbols = rules.watchlist;

  console.log(`\n分析 ${symbols.length} 個幣種中 (策略C, 1H, 3個月)...\n`);

  const results = [];
  for (const sym of symbols) {
    process.stdout.write(`  ${sym.padEnd(20)}`);
    try {
      const r = await backtestSymbol(sym);
      if (r) {
        results.push(r);
        const tag = r.pf >= 1.5 ? "✅" : r.pf >= 1.0 ? "🟡" : "❌";
        console.log(`${tag}  PF ${String(r.pf).padEnd(6)} WR ${r.winRate}%  PnL $${r.pnl.toFixed(2)}  (${r.trades}筆)`);
      } else {
        console.log("⚪ 數據不足");
      }
    } catch (e) {
      console.log(`錯誤: ${e.message}`);
    }
  }

  // Sort by PnL descending
  results.sort((a, b) => b.pnl - a.pnl);

  console.log(`\n${"═".repeat(65)}`);
  console.log(`  排名 (依 PnL)  |  門檻: PF ≥ ${MIN_PF}, 交易筆數 ≥ ${MIN_TRADES}`);
  console.log(`${"═".repeat(65)}`);

  const keep = [];
  const drop = [];

  for (const r of results) {
    const pass = r.pf >= MIN_PF && r.trades >= MIN_TRADES;
    if (pass) keep.push(r.symbol);
    else      drop.push(r.symbol);
    const tag = pass ? "✅" : "❌";
    console.log(`  ${tag} ${r.symbol.padEnd(18)} PF ${String(r.pf).padEnd(6)} WR ${r.winRate}%  PnL $${r.pnl.toFixed(2)}  (${r.trades}筆)`);
  }

  console.log(`\n  保留: ${keep.length} 幣 | 移除: ${drop.length} 幣`);

  if (drop.length) {
    console.log(`\n  移除幣種：`);
    console.log(`  ${drop.join(", ")}`);
  }

  // Write optimized list
  const optimized = { ...rules, watchlist: keep };
  writeFileSync("rules_bb_optimized.json", JSON.stringify(optimized, null, 2));
  console.log(`\n  已寫入 rules_bb_optimized.json (${keep.length} 幣)`);
  console.log(`  確認後執行: cp rules_bb_optimized.json rules_bb.json`);
}

main().catch(console.error);
