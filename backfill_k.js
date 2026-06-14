/**
 * 策略 K 回推腳本
 * 模擬 2026-04-27 全天的 Keltner 信號，寫入 positions_k.json 和 trades_k.csv
 * 讓 K 的觀察起點與策略 E（4/27）對齊
 * 只跑一次：node backfill_k.js
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import { POSITIONS_K_FILE, CSV_K_FILE, RULES_K_FILE } from "./paths.js";

const START_TS  = new Date("2026-04-27T00:00:00Z").getTime();
const END_TS    = new Date("2026-04-28T00:00:00Z").getTime();
const PORTFOLIO = parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000");
const MAX_TRADE = parseFloat(process.env.MAX_TRADE_SIZE_USD  || "100");
const RISK      = PORTFOLIO * 0.01;

const CSV_HEADERS = "Date,Time (UTC),Exchange,Symbol,Side,Quantity,Price,Total USD,Fee (est.),Net Amount,Order ID,Mode,Notes";

// ─── Market Data ─────────────────────────────────────────────────────────────

async function fetchCandles(symbol, limit = 300) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${symbol}: ${res.status}`);
  return (await res.json()).map(k => ({
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

function calcSMA(closes, period) {
  return closes.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcATR(candles, period = 14) {
  const trs = candles.slice(1).map((c, i) => {
    const prev = candles[i].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
  });
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcAvgVolume(candles, period = 20) {
  return candles.slice(-period).reduce((s, c) => s + c.volume, 0) / period;
}

function calcKeltner(candles, emaPeriod = 20, atrPeriod = 14, mult = 2) {
  if (candles.length < emaPeriod) return null;
  const closes = candles.map(c => c.close);
  const middle = calcEMA(closes, emaPeriod);
  const atrVal = calcATR(candles, atrPeriod);
  return { upper: middle + mult * atrVal, middle, lower: middle - mult * atrVal };
}

function calcTrailingStop(pos, currentPrice) {
  const { side, entryPrice, stopLoss } = pos;
  const initialRisk = Math.abs(entryPrice - stopLoss);
  if (!initialRisk) return stopLoss;
  const profit  = side === "long" ? currentPrice - entryPrice : entryPrice - currentPrice;
  const profitR = profit / initialRisk;
  if (profitR < 1.0) return stopLoss;
  const lockR   = Math.max(0, Math.floor(profitR * 2) / 2 - 1.0);
  const newStop = side === "long"
    ? entryPrice + initialRisk * lockR
    : entryPrice - initialRisk * lockR;
  if (side === "long") return Math.max(stopLoss, newStop);
  return Math.min(stopLoss, newStop);
}

// ─── Signal / Exit（與 bot_k.js 完全一致）────────────────────────────────────

function checkSignal(candles) {
  if (candles.length < 25) return null;
  const closes    = candles.map(c => c.close);
  const price     = closes[closes.length - 1];
  const prevClose = closes[closes.length - 2];
  const last      = candles[candles.length - 1];
  const atrVal    = calcATR(candles, 14);
  const kc        = calcKeltner(candles, 20, 14, 2);
  const volR      = last.volume / calcAvgVolume(candles, 20);
  const s20now    = calcSMA(closes, 20);
  const s20prev   = calcSMA(closes.slice(0, -1), 20);
  if (!kc || !atrVal || price < 0.001) return null;

  const trendUp   = s20now > s20prev * 1.001;
  const trendDown = s20now < s20prev * 0.999;

  if (price > kc.upper && prevClose <= kc.upper && volR > 1.5 && trendUp) {
    const sl    = last.low - atrVal * 0.5;
    const slPct = Math.abs(price - sl) / price * 100;
    if (slPct < 0.5 || slPct > 5 || sl >= price) return null;
    return { side: "long", stopLoss: sl, kc, volR };
  }
  if (price < kc.lower && prevClose >= kc.lower && volR > 1.5 && trendDown) {
    const sl    = last.high + atrVal * 0.5;
    const slPct = Math.abs(price - sl) / price * 100;
    if (slPct < 0.5 || slPct > 5 || sl <= price) return null;
    return { side: "short", stopLoss: sl, kc, volR };
  }
  return null;
}

function checkExit(pos, candles) {
  const closes    = candles.map(c => c.close);
  const price     = closes[closes.length - 1];
  const prevClose = closes[closes.length - 2];
  const sl        = calcTrailingStop(pos, price);
  const risk      = Math.abs(pos.entryPrice - pos.stopLoss);
  const tp        = pos.side === "long" ? pos.entryPrice + risk * 2 : pos.entryPrice - risk * 2;
  const kc        = calcKeltner(candles, 20, 14, 2);

  if (pos.side === "long") {
    if (price <= sl)                                       return { exit: true, reason: `止損 $${sl.toFixed(6)}`, exitPrice: sl };
    if (price >= tp)                                       return { exit: true, reason: `2:1止盈達成 $${tp.toFixed(6)}`, exitPrice: tp };
    if (kc && price < kc.upper && prevClose > kc.upper)   return { exit: true, reason: "突破失效（收回通道）", exitPrice: price };
  } else {
    if (price >= sl)                                       return { exit: true, reason: `止損 $${sl.toFixed(6)}`, exitPrice: sl };
    if (price <= tp)                                       return { exit: true, reason: `2:1止盈達成 $${tp.toFixed(6)}`, exitPrice: tp };
    if (kc && price > kc.lower && prevClose < kc.lower)   return { exit: true, reason: "突破失效（收回通道）", exitPrice: price };
  }
  return { exit: false };
}

// ─── CSV 輔助 ─────────────────────────────────────────────────────────────────

function csvRow(time, symbol, side, quantity, price, pnl, tradeSize, orderId, note) {
  const dt = new Date(time);
  return [
    dt.toISOString().slice(0, 10),
    dt.toISOString().slice(11, 19),
    "OKX", symbol, side,
    quantity.toFixed(6), price.toFixed(4),
    tradeSize.toFixed(2), (tradeSize * 0.001).toFixed(4),
    pnl.toFixed(4), orderId, "PAPER",
    `"${note}"`,
  ].join(",");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // 避免重複跑（若已有實際交易數據則跳過）
  // 清空舊的回推資料重跑
  if (existsSync(CSV_K_FILE)) {
    const lines = readFileSync(CSV_K_FILE, "utf8").split("\n");
    writeFileSync(CSV_K_FILE, lines[0] + "\n"); // 只保留 header
  }

  const rules     = JSON.parse(readFileSync(RULES_K_FILE, "utf8"));
  const watchlist = rules.watchlist;

  if (!existsSync(CSV_K_FILE)) writeFileSync(CSV_K_FILE, CSV_HEADERS + "\n");

  const allClosed = [];
  const allOpen   = [];
  let counter     = 0;

  console.log(`\n策略 K 回推：2026-04-27 全天 | ${watchlist.length} 幣種`);

  for (const symbol of watchlist) {
    process.stdout.write(`  ${symbol}... `);
    try {
      const candles = await fetchCandles(symbol, 300);

      // 找到 4/27 00:00 UTC 之後的 K棒起始 index（需要足夠的 lookback）
      const startIdx = candles.findIndex(c => c.time >= START_TS);
      if (startIdx < 25) { console.log("lookback 不足"); continue; }

      let pos = null;

      for (let i = startIdx; i < candles.length; i++) {
        const slice = candles.slice(0, i + 1);
        const bar   = candles[i];
        const price = bar.close;
        const barTime = bar.time;

        if (pos) {
          pos.stopLoss = calcTrailingStop(pos, price);
          const { exit, reason, exitPrice } = checkExit(pos, slice);

          if (exit) {
            const ep  = exitPrice ?? price;
            const pnl = pos.side === "long"
              ? (ep - pos.entryPrice) * pos.quantity
              : (pos.entryPrice - ep) * pos.quantity;
            const win = pnl > 0;

            allClosed.push({
              ...pos,
              exitPrice: ep,
              exitTime: new Date(barTime).toISOString(),
              exitReason: reason,
              pnl, win, paperTrading: true,
            });

            appendFileSync(CSV_K_FILE, csvRow(
              barTime, symbol,
              pos.side === "long" ? "SELL" : "BUY",
              pos.quantity, ep, pnl, pos.tradeSize,
              `EXIT-BF-${barTime}`,
              `出場: ${reason} | P&L: $${pnl.toFixed(4)}`
            ) + "\n");

            console.log(`${win ? "✅" : "🔴"} ${pos.side} 進@${pos.entryPrice.toFixed(4)} 出@${ep.toFixed(4)} ${reason}`);
            pos = null;
            counter++;
          }
        } else if (barTime >= START_TS && barTime < END_TS) {
          // 只在 4/27 當天開新倉，且全局持倉上限 4 筆
          const totalOpen = allOpen.length + (pos ? 1 : 0);
          if (totalOpen >= 4) continue;
          const sig = checkSignal(slice);
          if (sig) {
            const stopLossPct = Math.abs(price - sig.stopLoss) / price;
            const rawSize     = stopLossPct > 0.001 ? RISK / stopLossPct : RISK;
            const tradeSize   = Math.min(rawSize, PORTFOLIO, MAX_TRADE);
            const quantity    = tradeSize / price;
            const orderId     = `K-PAPER-BF-${barTime}`;

            pos = {
              symbol, side: sig.side, entryPrice: price,
              entryTime: new Date(barTime).toISOString(),
              tradeSize, quantity, orderId, algoId: null,
              stopLoss: sig.stopLoss, riskAmount: RISK,
              paperTrading: true,
            };

            appendFileSync(CSV_K_FILE, csvRow(
              barTime, symbol,
              sig.side === "long" ? "BUY" : "SELL",
              quantity, price, tradeSize - tradeSize * 0.001, tradeSize,
              orderId,
              `進場: Keltner突破 ${sig.side} | SL$${sig.stopLoss.toFixed(4)}`
            ) + "\n");
          }
        }
      }

      // 4/27 結束時仍持倉 → 帶入 open（讓 bot_k.js 繼續管理）
      if (pos) {
        allOpen.push(pos);
        console.log(`持倉中 → 帶入 open`);
      } else {
        process.stdout.write("\n");
      }
    } catch (e) {
      console.log(`錯誤: ${e.message}`);
    }
  }

  writeFileSync(POSITIONS_K_FILE, JSON.stringify({
    open: allOpen,
    closed: allClosed,
    startDate: "2026-04-27",
  }, null, 2));

  console.log(`\n✅ 回推完成`);
  console.log(`   平倉交易: ${allClosed.length} 筆 | 持倉帶入: ${allOpen.length} 筆`);
  console.log(`   位置: ${POSITIONS_K_FILE}`);
}

main().catch(console.error);
