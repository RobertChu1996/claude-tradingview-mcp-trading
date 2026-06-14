/**
 * 回掃 4/22-4/23 各策略有無合適進場信號
 */
import { readFileSync } from "fs";
import fetch from "node-fetch";

const DATE_FROM = new Date("2026-04-22T00:00:00Z").getTime();
const DATE_TO   = new Date("2026-04-24T00:00:00Z").getTime();

async function fetchCandles(symbol, interval, from, to) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${from}&endTime=${to}&limit=500`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data.map(k => ({ time:+k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5] }));
}

// ── Indicators ────────────────────────────────────────────────────────────────
function ema(closes, n) {
  const k = 2/(n+1); let e = closes[0];
  for (let i=1;i<closes.length;i++) e = closes[i]*k + e*(1-k);
  return e;
}
function sma(arr, n) { return arr.slice(-n).reduce((a,b)=>a+b,0)/n; }
function rsi(closes, n=3) {
  let gains=0,losses=0;
  for (let i=closes.length-n;i<closes.length;i++) {
    const d=closes[i]-closes[i-1]; d>0?gains+=d:losses-=d;
  }
  const rs = losses===0?100:gains/losses;
  return 100-100/(1+rs);
}
function vwap(candles) {
  let tv=0,tpv=0;
  for (const c of candles) { const tp=(c.high+c.low+c.close)/3; tpv+=tp*c.volume; tv+=c.volume; }
  return tv?tpv/tv:0;
}
function bb(closes, n=20, mult=2) {
  const sl=closes.slice(-n), mid=sl.reduce((a,b)=>a+b,0)/n;
  const std=Math.sqrt(sl.reduce((s,c)=>s+(c-mid)**2,0)/n);
  return { upper:mid+mult*std, middle:mid, lower:mid-mult*std };
}
function atr(candles, n=14) {
  const trs=candles.slice(1).map((c,i)=>Math.max(c.high-c.low,Math.abs(c.high-candles[i].close),Math.abs(c.low-candles[i].close)));
  return trs.slice(-n).reduce((a,b)=>a+b,0)/n;
}
function avgVol(candles, n=20) { return candles.slice(-n).reduce((s,c)=>s+c.volume,0)/n; }

// ── Strategy A: VWAP+RSI+EMA 4H ──────────────────────────────────────────────
async function scanA(symbol) {
  const extra = await fetchCandles(symbol, "4h", DATE_FROM - 30*24*60*60*1000, DATE_TO);
  if (!extra.length) return null;
  const signals = [];
  for (let i=50; i<extra.length; i++) {
    const slice = extra.slice(0, i+1);
    const c = slice.at(-1);
    if (c.time < DATE_FROM) continue;
    const closes = slice.map(k=>k.close);
    const e8 = ema(closes.slice(-20), 8);
    const vw = vwap(slice.slice(-20));
    const r3 = rsi(closes);
    const bullish = c.close > vw && c.close > e8;
    const bearish = c.close < vw && c.close < e8;
    const dist = Math.abs(c.close - vw)/vw*100;
    if (bullish && r3 < 30 && dist < 1.5)
      signals.push({ time: new Date(c.time).toISOString().slice(0,16), side:"LONG", price:c.close, rsi:r3.toFixed(1) });
    if (bearish && r3 > 70 && dist < 1.5)
      signals.push({ time: new Date(c.time).toISOString().slice(0,16), side:"SHORT", price:c.close, rsi:r3.toFixed(1) });
  }
  return signals;
}

// ── Strategy C: BB+ATR 1H ─────────────────────────────────────────────────────
async function scanC(symbol) {
  const extra = await fetchCandles(symbol, "1h", DATE_FROM - 5*24*60*60*1000, DATE_TO);
  if (!extra.length) return null;
  const signals = [];
  for (let i=30; i<extra.length; i++) {
    const slice = extra.slice(0, i+1);
    const c = slice.at(-1);
    if (c.time < DATE_FROM) continue;
    const closes = slice.map(k=>k.close);
    const bbv = bb(closes, 20, 2);
    const atrv = atr(slice, 14);
    const avgA = atr(slice.slice(-15), 14);
    const volR = c.volume / avgVol(slice, 20);
    const prev = closes.at(-2);
    const s20n = sma(closes, 20), s20p = sma(closes.slice(0,-1), 20);
    if (c.close > bbv.upper && prev <= bbv.upper && volR > 1.5 && s20n > s20p && atrv > avgA)
      signals.push({ time: new Date(c.time).toISOString().slice(0,16), side:"LONG", price:c.close.toFixed(4), volR:volR.toFixed(2) });
    if (c.close < bbv.lower && prev >= bbv.lower && volR > 1.5 && s20n < s20p && atrv > avgA)
      signals.push({ time: new Date(c.time).toISOString().slice(0,16), side:"SHORT", price:c.close.toFixed(4), volR:volR.toFixed(2) });
  }
  return signals;
}

// ── Strategy D: ORB 15m ───────────────────────────────────────────────────────
async function scanD(symbol) {
  const extra = await fetchCandles(symbol, "15m", DATE_FROM, DATE_TO);
  if (!extra.length) return null;
  const signals = [];
  // Group by day
  const days = {};
  for (const c of extra) {
    const day = new Date(c.time).toISOString().slice(0,10);
    if (!days[day]) days[day] = [];
    days[day].push(c);
  }
  for (const [day, candles] of Object.entries(days)) {
    if (candles.length < 4) continue;
    const orbHigh = Math.max(candles[0].high, candles[1].high);
    const orbLow  = Math.min(candles[0].low,  candles[1].low);
    const avgV = candles.slice(0,8).reduce((s,c)=>s+c.volume,0)/8;
    for (let i=2; i<Math.min(candles.length, 16); i++) {
      const c = candles[i];
      if (c.close > orbHigh && c.volume > avgV*1.5)
        signals.push({ time: new Date(c.time).toISOString().slice(0,16), side:"LONG", price:c.close });
      if (c.close < orbLow && c.volume > avgV*1.5)
        signals.push({ time: new Date(c.time).toISOString().slice(0,16), side:"SHORT", price:c.close });
    }
  }
  return signals;
}

// ── Main ──────────────────────────────────────────────────────────────────────
const wlA = JSON.parse(readFileSync("rules.json","utf8")).watchlist;
const wlC = JSON.parse(readFileSync("rules_bb.json","utf8")).watchlist;
const wlD = JSON.parse(readFileSync("rules_orb.json","utf8")).watchlist;

console.log("═".repeat(60));
console.log("  回掃 2026-04-22 ~ 04-23 進場信號");
console.log("═".repeat(60));

async function main() {
  // Strategy A
  console.log("\n【策略 A — VWAP+RSI 4H】");
  let foundA = 0;
  for (const sym of wlA) {
    const sigs = await scanA(sym);
    if (sigs?.length) { sigs.forEach(s => console.log(`  ${sym} ${s.side} @ $${s.price} | ${s.time} | RSI ${s.rsi}`)); foundA += sigs.length; }
  }
  if (!foundA) console.log("  無信號");

  // Strategy C
  console.log("\n【策略 C — BB+ATR 1H】");
  let foundC = 0;
  for (const sym of wlC) {
    const sigs = await scanC(sym);
    if (sigs?.length) { sigs.forEach(s => console.log(`  ${sym} ${s.side} @ $${s.price} | ${s.time} | 量比 ${s.volR}x`)); foundC += sigs.length; }
  }
  if (!foundC) console.log("  無信號");

  // Strategy D
  console.log("\n【策略 D — ORB 15m】");
  let foundD = 0;
  for (const sym of wlD.slice(0,20)) {
    const sigs = await scanD(sym);
    if (sigs?.length) { sigs.forEach(s => console.log(`  ${sym} ${s.side} @ $${s.price} | ${s.time}`)); foundD += sigs.length; }
  }
  if (!foundD) console.log("  無信號");

  console.log("\n" + "═".repeat(60));
  console.log(`  合計: A=${foundA} C=${foundC} D=${foundD} 個信號`);
  console.log("═".repeat(60));
}

main().catch(console.error);
