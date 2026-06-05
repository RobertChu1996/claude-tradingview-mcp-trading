/**
 * DMC 動態幣種清單優化器
 * 從 OKX 取得交易量前 150 的 USDT 現貨幣種，
 * 逐幣跑 DMC 回測（3個月 4H），篩選 PF >= MIN_PF 的幣種，
 * 寫入 watchlist_dmc.json（供 bot_dmc.js 讀取）
 *
 * 用法：
 *   node optimize_watchlist_dmc.js          → 預設門檻 PF=1.2，取前50
 *   node optimize_watchlist_dmc.js 1.5 40   → PF=1.5，取前40
 */

import { writeFileSync } from "fs";
import { WATCHLIST_DMC_FILE } from "./paths.js";

const MIN_PF      = parseFloat(process.argv[2] || "1.2");
const TOP_N       = parseInt(process.argv[3]   || "50");
const SCAN_LIMIT  = 150;   // 掃 OKX 交易量前 150 幣
const MONTHS      = 3;
const INTERVAL    = "4H";
const MS_CANDLE   = 4 * 3600 * 1000;
const OKX_BASE    = "https://www.okx.com";

// 策略參數（與 bot_dmc.js 完全一致）
const SMA_PERIOD      = 25;
const VOL_RATIO       = 1.5;
const STRENGTH        = 0.7;
const SWING_LB        = 8;
const ATR_MULT        = 0.05;
const TP_RATIO        = 3.0;
const SMA_PREV_OFFSET = 5;
const COOLDOWN_BARS   = 2;
const MIN_PRICE       = 0.001;
const LOOKBACK        = SMA_PERIOD + SMA_PREV_OFFSET + 10;

// 排除穩定幣
const EXCLUDE = new Set([
  "USDC-USDT","BUSD-USDT","TUSD-USDT","DAI-USDT","FDUSD-USDT",
]);

// OKX instId（BTC-USDT）↔ bot symbol（BTCUSDT）轉換
const toInstId  = s => s.replace("USDT", "-USDT");
const toSymbol  = s => s.replace("-USDT", "USDT");

// ─── OKX API ──────────────────────────────────────────────────────────────────
async function fetchTopSymbols() {
  const fetch = (await import("node-fetch")).default;
  const res   = await fetch(`${OKX_BASE}/api/v5/market/tickers?instType=SPOT`);
  if (!res.ok) throw new Error(`OKX tickers ${res.status}`);
  const { data } = await res.json();
  return data
    .filter(t => t.instId.endsWith("-USDT") && !EXCLUDE.has(t.instId) && parseFloat(t.last) >= MIN_PRICE)
    .sort((a, b) => parseFloat(b.volCcy24h) - parseFloat(a.volCcy24h))
    .slice(0, SCAN_LIMIT)
    .map(t => toSymbol(t.instId));
}

async function fetchCandles(symbol) {
  const fetch   = (await import("node-fetch")).default;
  const instId  = toInstId(symbol);
  const need    = Math.ceil((MONTHS * 30 * 24 * 3600 * 1000) / MS_CANDLE) + LOOKBACK + 10;
  const all   = [];
  let after   = "";   // OKX: after=ts 取「早於 ts」的資料（往舊翻頁）

  while (all.length < need) {
    const limit = Math.min(300, need - all.length);
    const url   = `${OKX_BASE}/api/v5/market/history-candles?instId=${instId}&bar=${INTERVAL}&limit=${limit}${after ? `&after=${after}` : ""}`;
    const res   = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { data } = await res.json();
    if (!data?.length) break;
    // OKX 回傳新→舊，翻轉後 unshift 到前面（舊的在前）
    const candles = [...data].reverse().map(k => ({
      time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
    }));
    all.unshift(...candles);
    after = data[data.length - 1][0];   // 這批最舊一根的 ts
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

function checkSignal(candles) {
  if (candles.length < SMA_PERIOD + SMA_PREV_OFFSET + 10) return null;
  const closes  = candles.map(c => c.close);
  const price   = closes[closes.length - 1];
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

  if (smaNow > smaPrev && price > smaNow && volR > VOL_RATIO &&
      last.close > last.open && strength > STRENGTH && rec3 > prev3) {
    const sl    = swingLowOf(candles, SWING_LB) - atr * ATR_MULT;
    const slPct = (price - sl) / price;
    if (sl >= price || slPct < 0.003 || slPct > 0.15) return null;
    return { side: "long", stopLoss: sl, tp: price + (price - sl) * TP_RATIO };
  }
  if (smaNow < smaPrev && price < smaNow && volR > VOL_RATIO &&
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

function trailingSL(pos, price) {
  const risk = Math.abs(pos.entryPrice - pos.stopLoss);
  if (!risk) return pos.stopLoss;
  const profitR = (pos.side === "long" ? price - pos.entryPrice : pos.entryPrice - price) / risk;
  if (profitR < 1) return pos.stopLoss;
  const lockR = Math.max(0, Math.floor(profitR * 2) / 2 - 1.0);
  const ns    = pos.side === "long" ? pos.entryPrice + risk * lockR : pos.entryPrice - risk * lockR;
  return pos.side === "long" ? Math.max(pos.stopLoss, ns) : Math.min(pos.stopLoss, ns);
}

// ─── 單幣回測（逐K棒，含追蹤止損+冷卻）──────────────────────────────────────
function backtestSymbol(candles) {
  const cutoff  = Date.now() - MONTHS * 30 * 24 * 3600 * 1000;
  const startI  = candles.findIndex(c => c.time >= cutoff);
  if (startI < LOOKBACK) return null;

  const trades  = [];
  let pos       = null;
  let cooldownUntil = 0;

  for (let i = startI; i < candles.length; i++) {
    const slice  = candles.slice(0, i + 1);
    const candle = candles[i];
    const price  = candle.close;

    if (pos) {
      pos.stopLoss = trailingSL(pos, price);
      const sl = pos.stopLoss;

      let exit = null;
      if (pos.side === "long") {
        const slHit = candle.low  <= sl;
        const tpHit = candle.high >= pos.tp;
        if (slHit && tpHit) exit = { ep: candle.close > candle.open ? pos.tp : sl };
        else if (tpHit)     exit = { ep: pos.tp };
        else if (slHit)     exit = { ep: sl };
      } else {
        const slHit = candle.high >= sl;
        const tpHit = candle.low  <= pos.tp;
        if (slHit && tpHit) exit = { ep: candle.close < candle.open ? pos.tp : sl };
        else if (tpHit)     exit = { ep: pos.tp };
        else if (slHit)     exit = { ep: sl };
      }

      if (exit) {
        const pnl = pos.side === "long"
          ? (exit.ep - pos.entryPrice) * pos.quantity
          : (pos.entryPrice - exit.ep) * pos.quantity;
        trades.push({ pnl, win: pnl > 0 });
        cooldownUntil = candle.time + COOLDOWN_BARS * MS_CANDLE;
        pos = null;
      }
    } else {
      if (candle.time < cooldownUntil) continue;
      const sig = checkSignal(slice);
      if (!sig) continue;
      const slPct = Math.abs(price - sig.stopLoss) / price;
      if (slPct < 0.001) continue;
      const size = Math.min((1000 * 0.01) / slPct, 200);
      pos = { side: sig.side, entryPrice: price, stopLoss: sig.stopLoss, tp: sig.tp, quantity: size / price };
    }
  }

  if (trades.length < 3) return null;

  const wins   = trades.filter(t => t.win);
  const losses = trades.filter(t => !t.win);
  const sumW   = wins.reduce((s, t) => s + t.pnl, 0);
  const sumL   = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf     = sumL > 0 ? sumW / sumL : (sumW > 0 ? Infinity : 0);
  const pnl    = trades.reduce((s, t) => s + t.pnl, 0);
  const wr     = wins.length / trades.length;

  return { trades: trades.length, wins: wins.length, wr, pf, pnl };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\nDMC 幣種優化器 | 掃前 ${SCAN_LIMIT} 幣 | PF≥${MIN_PF} | 取前 ${TOP_N}`);
  console.log(`回測：${MONTHS}個月 4H | 參數：SMA${SMA_PERIOD}/TP${TP_RATIO}:1\n`);

  console.log("取得 OKX 交易量排名...");
  const symbols = await fetchTopSymbols();
  console.log(`候選幣種：${symbols.length} 個\n`);

  const results = [];
  let ok = 0, skip = 0, err = 0;

  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    process.stdout.write(`  [${i + 1}/${symbols.length}] ${symbol.padEnd(14)} `);
    try {
      const candles = await fetchCandles(symbol);
      const r       = backtestSymbol(candles);
      if (!r) {
        process.stdout.write("資料不足\n");
        skip++;
        continue;
      }
      const tag = r.pf >= MIN_PF ? "✓" : "✗";
      process.stdout.write(`${tag} PF=${r.pf === Infinity ? "∞" : r.pf.toFixed(2)} | ${r.trades}筆 | WR=${(r.wr * 100).toFixed(0)}% | PnL=$${r.pnl.toFixed(1)}\n`);
      results.push({ symbol, ...r });
      if (r.pf >= MIN_PF) ok++;
      else skip++;
    } catch (e) {
      process.stdout.write(`錯誤: ${e.message}\n`);
      err++;
    }
  }

  // 排序：PF 優先，同 PF 取 PnL 高者
  const qualified = results
    .filter(r => r.pf >= MIN_PF)
    .sort((a, b) => b.pf - a.pf || b.pnl - a.pnl)
    .slice(0, TOP_N);

  console.log(`\n${"═".repeat(55)}`);
  console.log(`  結果：${ok} 幣達標（PF≥${MIN_PF}），取前 ${qualified.length} 入清單`);
  console.log(`  跳過：${skip} | 錯誤：${err}`);
  console.log(`${"─".repeat(55)}`);
  console.log("  排名  幣種              PF     WR     PnL");
  for (let i = 0; i < Math.min(qualified.length, 20); i++) {
    const r = qualified[i];
    const pf = r.pf === Infinity ? "  ∞  " : r.pf.toFixed(2).padStart(5);
    console.log(`  ${String(i + 1).padStart(3)}.  ${r.symbol.padEnd(16)} ${pf}  ${(r.wr * 100).toFixed(0).padStart(3)}%  $${r.pnl.toFixed(1)}`);
  }
  if (qualified.length > 20) console.log(`  ... 以及另外 ${qualified.length - 20} 幣`);
  console.log(`${"═".repeat(55)}\n`);

  const output = {
    updatedAt: new Date().toISOString(),
    minPf: MIN_PF,
    symbols: qualified.map(r => r.symbol),
    stats: qualified.map(({ symbol, trades, wins, wr, pf, pnl }) => ({
      symbol, trades, wins,
      wr: parseFloat((wr * 100).toFixed(1)),
      pf: pf === Infinity ? 999 : parseFloat(pf.toFixed(2)),
      pnl: parseFloat(pnl.toFixed(2)),
    })),
  };

  writeFileSync(WATCHLIST_DMC_FILE, JSON.stringify(output, null, 2));
  console.log(`已寫入 ${WATCHLIST_DMC_FILE}（${qualified.length} 幣）`);
}

main().catch(console.error);
