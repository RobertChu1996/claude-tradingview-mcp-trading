/**
 * 模擬 4/22-4/23 策略D (ORB) 真實進場的損益
 * 進場：開盤區間突破 + 量能確認
 * 止損：區間另一側
 * 目標：2x 區間寬度（2:1 R:R）
 * 時間停損：UTC 08:00 收盤
 */
import fetch from "node-fetch";
import { readFileSync } from "fs";

const PORTFOLIO = 388;
const RISK      = 0.01; // 每筆 1% 本金
const DAYS      = ["2026-04-22", "2026-04-23"];

async function fetchCandles(symbol, interval, startTime, endTime) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${startTime}&endTime=${endTime}&limit=500`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data.map(k => ({ time:+k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5] }));
}

function calcATR(candles, n=14) {
  const trs = candles.slice(1).map((c,i) => Math.max(c.high-c.low, Math.abs(c.high-candles[i].close), Math.abs(c.low-candles[i].close)));
  return trs.slice(-n).reduce((a,b)=>a+b,0)/n;
}
function avgVol(candles, n=20) { return candles.slice(-n).reduce((s,c)=>s+c.volume,0)/n; }

async function simDay(symbol, dayStr) {
  const dayStart = new Date(dayStr + "T00:00:00Z").getTime();
  const dayEnd   = new Date(dayStr + "T23:59:59Z").getTime();
  // Fetch pre-day candles for ATR context + full day
  const allCandles = await fetchCandles(symbol, "15m", dayStart - 2*24*60*60*1000, dayEnd);
  if (allCandles.length < 20) return null;

  const dayCandles = allCandles.filter(c => c.time >= dayStart && c.time <= dayEnd);
  if (dayCandles.length < 4) return null;

  // Opening range: first 2 candles (UTC 00:00 - 00:30)
  const orbHigh = Math.max(dayCandles[0].high, dayCandles[1].high);
  const orbLow  = Math.min(dayCandles[0].low,  dayCandles[1].low);
  const orbRange = orbHigh - orbLow;
  if (orbRange <= 0) return null;

  // Context candles for ATR/vol
  const ctxIdx = allCandles.findIndex(c => c.time >= dayStart);
  const ctxCandles = allCandles.slice(Math.max(0, ctxIdx-30), ctxIdx+2);
  const atrVal = calcATR(ctxCandles, 14);
  const avgVolVal = avgVol(ctxCandles, 20);

  // Scan for entry (candles 2+, UTC 00:30 onwards, within entry window UTC 00:30-04:00)
  const entryWindowEnd = new Date(dayStr + "T04:00:00Z").getTime();
  const timeStop       = new Date(dayStr + "T08:00:00Z").getTime();

  for (let i=2; i<dayCandles.length; i++) {
    const c = dayCandles[i];
    if (c.time > entryWindowEnd) break;

    const volR = c.volume / avgVolVal;
    const atrR = atrVal / (ctxCandles.reduce((s,x)=>s+x.high-x.low,0)/ctxCandles.length || 1);

    let side = null;
    if (c.close > orbHigh && volR > 1.5) side = "long";
    else if (c.close < orbLow && volR > 1.5) side = "short";
    if (!side) continue;

    // Avoid chasing: entry price not too far from range
    const dist = side==="long" ? c.close - orbHigh : orbLow - c.close;
    if (dist > atrVal*3) continue;

    const entryPrice = c.close;
    const stopLoss   = side==="long" ? orbLow : orbHigh;
    const riskPct    = Math.abs(entryPrice - stopLoss) / entryPrice;
    if (riskPct < 0.001) continue;

    const target     = side==="long"
      ? entryPrice + orbRange * 2
      : entryPrice - orbRange * 2;

    const riskAmt  = PORTFOLIO * RISK;
    const qty      = riskAmt / Math.abs(entryPrice - stopLoss);
    const maxPnl   = Math.abs(target - entryPrice) * qty;
    const maxLoss  = riskAmt;

    // Simulate outcome: walk candles after entry
    let outcome = "time_stop";
    let exitPrice = null;
    for (let j=i+1; j<dayCandles.length; j++) {
      const ec = dayCandles[j];
      if (ec.time > timeStop) { exitPrice = ec.open; outcome = "time_stop"; break; }
      if (side==="long") {
        if (ec.low <= stopLoss)    { exitPrice = stopLoss;  outcome = "stop_loss"; break; }
        if (ec.high >= target)     { exitPrice = target;    outcome = "target_hit"; break; }
      } else {
        if (ec.high >= stopLoss)   { exitPrice = stopLoss;  outcome = "stop_loss"; break; }
        if (ec.low <= target)      { exitPrice = target;    outcome = "target_hit"; break; }
      }
    }
    if (!exitPrice) exitPrice = dayCandles.at(-1).close;

    const pnl = side==="long"
      ? (exitPrice - entryPrice) * qty
      : (entryPrice - exitPrice) * qty;

    return { symbol, day: dayStr, side, entryPrice, stopLoss, target, exitPrice, outcome, pnl, riskAmt, rr: (pnl/riskAmt).toFixed(2) };
  }
  return null;
}

const wlD = JSON.parse(readFileSync("rules_orb.json","utf8")).watchlist;

console.log("═".repeat(65));
console.log("  策略 D (ORB) — 4/22~4/23 真實模擬損益");
console.log("═".repeat(65));

let totalPnl=0, wins=0, losses=0, timeStops=0;
const trades = [];

for (const day of DAYS) {
  console.log(`\n── ${day} ─────────────────────────────────────────────`);
  for (const sym of wlD) {
    const t = await simDay(sym, day);
    if (!t) continue;
    trades.push(t);
    totalPnl += t.pnl;
    if (t.outcome==="target_hit") wins++;
    else if (t.outcome==="stop_loss") losses++;
    else timeStops++;
    const emoji = t.outcome==="target_hit"?"✅":t.outcome==="stop_loss"?"❌":"⏱️";
    console.log(`  ${emoji} ${sym.padEnd(14)} ${t.side.toUpperCase().padEnd(6)} 進$${t.entryPrice.toFixed(4)} → 出$${t.exitPrice.toFixed(4)}  P&L: ${t.pnl>=0?"+":""}$${t.pnl.toFixed(2)} (${t.rr}R)  [${t.outcome}]`);
  }
}

const total = wins+losses+timeStops;
console.log("\n" + "═".repeat(65));
console.log(`  總交易: ${total} 筆  ✅勝 ${wins}  ❌敗 ${losses}  ⏱️時停 ${timeStops}`);
console.log(`  勝率: ${total?(wins/total*100).toFixed(1):0}%`);
console.log(`  總損益: ${totalPnl>=0?"+":""}$${totalPnl.toFixed(2)}`);
console.log(`  平均每筆: ${total?(totalPnl/total).toFixed(2):0}`);
const gw=trades.filter(t=>t.pnl>0).reduce((s,t)=>s+t.pnl,0);
const gl=Math.abs(trades.filter(t=>t.pnl<0).reduce((s,t)=>s+t.pnl,0));
console.log(`  Profit Factor: ${gl>0?(gw/gl).toFixed(2):"∞"}`);
console.log("═".repeat(65));
