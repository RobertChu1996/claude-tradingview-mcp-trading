/**
 * 自動週優化 — 策略 C 名單管理
 * 每週自動執行：
 *   1. 從 Binance 永續合約抓取 24h 成交量 > $20M 的所有 USDT 幣種
 *   2. 回測3個月，PF ≥ 0.9 且有效信號 ≥ 3 的幣留下
 *   3. 結果寫入 rules_bb.json + watchlist_master.json（快取）
 *   4. 重置連虧統計
 */

import { readFileSync, writeFileSync, existsSync } from "fs";

const MIN_PF        = parseFloat(process.argv[2] || "0.9");
const MIN_TRADES    = parseInt(process.argv[3]  || "3");
const MIN_VOL_M     = parseFloat(process.env.MIN_VOL_M || "20"); // 24h 成交量下限（百萬USD）
const PORTFOLIO     = parseFloat(process.env.PORTFOLIO_VALUE_USD || "388");
const RISK          = 0.01;
const LAST_RUN_FILE = "last_optimized.txt";

// 排除非加密貨幣或特殊合約
const EXCLUDE = new Set(["XAUUSDT","XAGUSDT","BTCDOMUSDT","DEFIUSDT","BNXUSDT"]);

async function fetchUniverse() {
  const fetch = (await import("node-fetch")).default;
  const res  = await fetch("https://fapi.binance.com/fapi/v1/ticker/24hr");
  const data = await res.json();
  const symbols = data
    .filter(t =>
      t.symbol.endsWith("USDT") &&
      !EXCLUDE.has(t.symbol) &&
      /^[A-Z0-9]+USDT$/.test(t.symbol) &&          // 只允許純英數字
      !/\d+(LONG|SHORT|UP|DOWN|BULL|BEAR)/.test(t.symbol) &&
      parseFloat(t.quoteVolume) >= MIN_VOL_M * 1e6
    )
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .map(t => t.symbol);

  // 快取到 watchlist_master.json
  writeFileSync("watchlist_master.json", JSON.stringify({ watchlist: symbols, updatedAt: new Date().toISOString(), minVolM: MIN_VOL_M }, null, 2));
  return symbols;
}

export async function runAutoOptimize(force = false) {
  // 週檢查：距上次優化未滿7天就跳過（除非 force）
  if (!force && existsSync(LAST_RUN_FILE)) {
    const lastRun  = new Date(readFileSync(LAST_RUN_FILE, "utf8").trim());
    const daysSince = (Date.now() - lastRun.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince < 7) {
      console.log(`[Auto-Optimize] 上次優化 ${daysSince.toFixed(1)} 天前，跳過（7天週期）`);
      return null;
    }
  }

  console.log("\n" + "═".repeat(60));
  console.log("  [Auto-Optimize] 開始週優化...");
  console.log(`  宇宙門檻: 24h 成交量 > $${MIN_VOL_M}M | PF ≥ ${MIN_PF} | 信號 ≥ ${MIN_TRADES}`);
  console.log("═".repeat(60));

  console.log("\n  [1/3] 從 Binance 永續合約抓取活躍幣種...");
  const symbols = await fetchUniverse();
  console.log(`  共 ${symbols.length} 個幣種符合成交量門檻\n`);
  console.log("  [2/3] 回測中（3個月）...\n");
  const results = [];

  for (const sym of symbols) {
    process.stdout.write(`  ${sym.padEnd(20)}`);
    try {
      const r = await backtestSymbol(sym);
      if (r) {
        results.push(r);
        const tag = r.pf >= 1.5 ? "✅" : r.pf >= 0.9 ? "🟡" : "❌";
        console.log(`${tag}  PF ${String(r.pf).padEnd(5)} WR ${r.winRate}%  PnL $${r.pnl.toFixed(2)} (${r.trades}筆)`);
      } else {
        console.log("⚪ 數據不足");
      }
    } catch (e) {
      console.log(`⚠️  ${e.message.slice(0,40)}`);
    }
  }

  console.log("\n  [3/3] 篩選結果...");
  results.sort((a, b) => b.pnl - a.pnl);
  const keep = results.filter(r => r.pf >= MIN_PF && r.trades >= MIN_TRADES).map(r => r.symbol);
  const drop = results.filter(r => r.pf < MIN_PF || r.trades < MIN_TRADES).map(r => r.symbol);

  // 更新 rules_bb.json
  const rules = JSON.parse(readFileSync("rules_bb.json", "utf8"));
  const prev  = rules.watchlist.length;
  rules.watchlist = keep;
  writeFileSync("rules_bb.json", JSON.stringify(rules, null, 2));

  // 重置連虧統計（新週期）
  if (existsSync("symbol_stats.json")) {
    const stats = JSON.parse(readFileSync("symbol_stats.json", "utf8"));
    keep.forEach(sym => {
      if (stats[sym]) stats[sym].consecutiveLosses = 0;
    });
    writeFileSync("symbol_stats.json", JSON.stringify(stats, null, 2));
  }

  // 記錄執行時間
  writeFileSync(LAST_RUN_FILE, new Date().toISOString());

  console.log(`\n  ✅ 優化完成：${prev} → ${keep.length} 幣（移除 ${drop.length} 幣）`);
  if (drop.length) console.log(`  移除：${drop.slice(0,10).join(", ")}${drop.length > 10 ? "..." : ""}`);
  console.log("═".repeat(60) + "\n");

  return { keep, drop };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchCandles(symbol) {
  const fetch = (await import("node-fetch")).default;
  const months = 3, ms = 60 * 60 * 1000;
  const total = Math.ceil((months * 30 * 24 * 60 * 60 * 1000) / ms);
  const all = [];
  let endTime = Date.now();
  while (all.length < total) {
    const limit = Math.min(1000, total - all.length);
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&endTime=${endTime}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.length) break;
    all.unshift(...data.map(k => ({ time:+k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5] })));
    endTime = data[0][0] - 1;
    if (data.length < limit) break;
  }
  return all.sort((a, b) => a.time - b.time);
}

function sma(arr, n) { const s = arr.slice(-n); return s.reduce((a,b)=>a+b,0)/s.length; }

function atr(candles, n = 14) {
  if (candles.length < n + 1) return null;
  const trs = candles.slice(1).map((c, i) =>
    Math.max(c.high-c.low, Math.abs(c.high-candles[i].close), Math.abs(c.low-candles[i].close))
  );
  return trs.slice(-n).reduce((a,b)=>a+b,0) / n;
}

function bb(closes, n = 20, mult = 2) {
  if (closes.length < n) return null;
  const sl = closes.slice(-n);
  const mid = sl.reduce((a,b)=>a+b,0)/n;
  const std = Math.sqrt(sl.reduce((s,c)=>s+(c-mid)**2,0)/n);
  return { upper: mid+mult*std, middle: mid, lower: mid-mult*std };
}

function avgVol(candles, n = 20) {
  return candles.slice(-n).reduce((s,c)=>s+c.volume,0)/n;
}

function calcSize(price, sl) {
  const risk = PORTFOLIO * RISK;
  const pct  = Math.abs(price - sl) / price;
  if (pct < 0.001) return risk * 2 / price;
  return Math.min(risk / pct, PORTFOLIO) / price;
}

function trailingStop(pos, price) {
  const r = Math.abs(pos.entryPrice - pos.stopLoss);
  if (!r) return pos.stopLoss;
  const profitR = (pos.side === "long" ? price - pos.entryPrice : pos.entryPrice - price) / r;
  if (profitR < 1.0) return pos.stopLoss;
  const lockR = Math.max(0, Math.floor(profitR * 2) / 2 - 1.0);
  const newSL = pos.side === "long" ? pos.entryPrice + r*lockR : pos.entryPrice - r*lockR;
  return pos.side === "long" ? Math.max(pos.stopLoss, newSL) : Math.min(pos.stopLoss, newSL);
}

async function backtestSymbol(symbol) {
  const candles = await fetchCandles(symbol);
  if (candles.length < 50) return null;

  const trades = [];
  let pos = null;

  for (let i = 30; i < candles.length; i++) {
    const slice = candles.slice(0, i + 1);
    const price = slice.at(-1).close;
    const closes = slice.map(c => c.close);
    const bbVal = bb(closes, 20, 2);
    const atrVal = atr(slice, 14);
    if (!bbVal || !atrVal) continue;

    if (pos) {
      pos.stopLoss = trailingStop(pos, price);
      let reason = null;
      const sl = pos.stopLoss;
      if (pos.side === "long") {
        if (price <= sl) reason = "止損";
        else if (price <= bbVal.middle) reason = "回中軌";
        else if (price < bbVal.upper && closes.at(-2) > bbVal.upper) reason = "突破失效";
      } else {
        if (price >= sl) reason = "止損";
        else if (price >= bbVal.middle) reason = "回中軌";
        else if (price > bbVal.lower && closes.at(-2) < bbVal.lower) reason = "突破失效";
      }
      if (reason) {
        const pnl = pos.side === "long"
          ? (price - pos.entryPrice) * pos.qty
          : (pos.entryPrice - price) * pos.qty;
        trades.push({ win: pnl > 0, pnl });
        pos = null;
      }
    } else {
      const avgATR = (() => {
        const vals = [];
        for (let j = 14; j <= Math.min(slice.length-1, 24); j++)
          vals.push(atr(slice.slice(0, j+1), 14));
        return vals.reduce((a,b)=>a+b,0)/(vals.length||1);
      })();
      const volR = slice.at(-1).volume / avgVol(slice, 20);
      const s20n = sma(closes, 20), s20p = sma(closes.slice(0,-1), 20);
      const prev = closes.at(-2);

      let sig = null;
      if (price > bbVal.upper && prev <= bbVal.upper && volR > 1.5 && s20n > s20p && atrVal > avgATR)
        sig = { side: "long",  stopLoss: slice.at(-1).low  - atrVal*0.5 };
      else if (price < bbVal.lower && prev >= bbVal.lower && volR > 1.5 && s20n < s20p && atrVal > avgATR)
        sig = { side: "short", stopLoss: slice.at(-1).high + atrVal*0.5 };

      if (sig) {
        if (sig.side === "long"  && sig.stopLoss >= price) continue;
        if (sig.side === "short" && sig.stopLoss <= price) continue;
        pos = { side: sig.side, entryPrice: price, stopLoss: sig.stopLoss, qty: calcSize(price, sig.stopLoss) };
      }
    }
  }

  if (pos) {
    const price = candles.at(-1).close;
    const pnl = pos.side === "long"
      ? (price - pos.entryPrice) * pos.qty
      : (pos.entryPrice - price) * pos.qty;
    trades.push({ win: pnl > 0, pnl, open: true });
  }

  const closed = trades.filter(t => !t.open);
  if (!closed.length) return { symbol, trades: 0, winRate: "0.0", pf: 0, pnl: 0 };

  const wins   = closed.filter(t => t.win);
  const losses = closed.filter(t => !t.win);
  const gw = wins.reduce((s,t)=>s+t.pnl,0);
  const gl = Math.abs(losses.reduce((s,t)=>s+t.pnl,0));
  const pf = gl > 0 ? gw/gl : gw > 0 ? 99 : 0;

  return {
    symbol,
    trades:  closed.length,
    winRate: (wins.length/closed.length*100).toFixed(1),
    pf:      parseFloat(pf.toFixed(2)),
    pnl:     parseFloat(closed.reduce((s,t)=>s+t.pnl,0).toFixed(2)),
  };
}

// 直接執行
const isMain = process.argv[1] && process.argv[1].endsWith("auto_optimize.js");
if (isMain) {
  runAutoOptimize(true).catch(console.error);
}
