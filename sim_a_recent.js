/**
 * 模擬 4/22-4/23 策略A (VWAP+RSI+EMA 4H) 真實進場損益
 * 進場：bullish/bearish bias + RSI(3) 極值 + VWAP 距離 < 1.5%
 * 止損：VWAP ± 0.3 ATR
 * 出場：跌破VWAP / EMA8 / RSI(3)穿越50
 */
import fetch from "node-fetch";
import { readFileSync } from "fs";

const PORTFOLIO = 388;
const RISK      = 0.01;
const DATE_FROM = new Date("2026-04-22T00:00:00Z").getTime();
const DATE_TO   = new Date("2026-04-24T00:00:00Z").getTime();

async function fetchCandles(symbol, interval, startTime, endTime) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${startTime}&endTime=${endTime}&limit=500`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data.map(k => ({ time:+k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5] }));
}

function ema(closes, n) {
  const k = 2/(n+1); let e = closes[0];
  for (let i=1;i<closes.length;i++) e = closes[i]*k + e*(1-k);
  return e;
}
function rsi(closes, n=3) {
  let g=0,l=0;
  for (let i=closes.length-n;i<closes.length;i++) {
    const d=closes[i]-closes[i-1]; d>0?g+=d:l-=d;
  }
  return l===0?100:100-100/(1+g/l);
}
function vwap(candles) {
  let tv=0,tpv=0;
  for (const c of candles) { const tp=(c.high+c.low+c.close)/3; tpv+=tp*c.volume; tv+=c.volume; }
  return tv?tpv/tv:0;
}
function calcATR(candles, n=14) {
  const trs=candles.slice(1).map((c,i)=>Math.max(c.high-c.low,Math.abs(c.high-candles[i].close),Math.abs(c.low-candles[i].close)));
  return trs.slice(-n).reduce((a,b)=>a+b,0)/n;
}

async function simSymbol(symbol) {
  // 拉 4/20 開始的4H蠟燭，確保有足夠 context
  const candles = await fetchCandles(symbol, "4h",
    DATE_FROM - 10*24*60*60*1000, DATE_TO);
  if (candles.length < 30) return [];

  const trades = [];
  let pos = null;

  for (let i=20; i<candles.length; i++) {
    const slice = candles.slice(0, i+1);
    const c = slice.at(-1);
    const closes = slice.map(k=>k.close);
    const price = c.close;
    const e8  = ema(closes.slice(-20), 8);
    const vw  = vwap(slice.slice(-20));
    const r3  = rsi(closes);
    const atr = calcATR(slice, 14);

    // 管理持倉（出場）
    if (pos) {
      let exitReason = null;
      if (pos.side==="long") {
        if (price <= pos.stopLoss)  exitReason = "止損";
        else if (price <= vw)       exitReason = "跌破VWAP";
        else if (price < e8)        exitReason = "跌破EMA8";
        else if (r3 > 50)           exitReason = "RSI穿越50";
      } else {
        if (price >= pos.stopLoss)  exitReason = "止損";
        else if (price >= vw)       exitReason = "突破VWAP";
        else if (price > e8)        exitReason = "突破EMA8";
        else if (r3 < 50)           exitReason = "RSI穿越50";
      }
      if (exitReason) {
        const pnl = pos.side==="long"
          ? (price - pos.entryPrice) * pos.qty
          : (pos.entryPrice - price) * pos.qty;
        const rr = (pnl / (PORTFOLIO * RISK)).toFixed(2);
        trades.push({ ...pos, exitPrice: price, exitTime: new Date(c.time).toISOString().slice(0,16), exitReason, pnl, rr });
        pos = null;
      }
      continue;
    }

    // 只掃描 4/22-4/23 的 K 棒進場
    if (c.time < DATE_FROM || c.time >= DATE_TO) continue;

    const bullish = price > vw && price > e8;
    const bearish = price < vw && price < e8;
    const dist = Math.abs(price - vw)/vw*100;

    let side = null;
    if (bullish && r3 < 30 && dist < 1.5) side = "long";
    else if (bearish && r3 > 70 && dist < 1.5) side = "short";
    if (!side) continue;

    const stopLoss = side==="long" ? vw - atr*0.3 : vw + atr*0.3;
    const slPct = Math.abs(price - stopLoss)/price;
    if (slPct < 0.001) continue;

    const riskAmt = PORTFOLIO * RISK;
    const qty = riskAmt / Math.abs(price - stopLoss);
    pos = { symbol, side, entryPrice: price, entryTime: new Date(c.time).toISOString().slice(0,16), stopLoss, qty, riskAmt, r3: r3.toFixed(1) };
  }

  // 持倉到期末未出場
  if (pos) {
    const lastPrice = candles.at(-1).close;
    const pnl = pos.side==="long"
      ? (lastPrice - pos.entryPrice) * pos.qty
      : (pos.entryPrice - lastPrice) * pos.qty;
    trades.push({ ...pos, exitPrice: lastPrice, exitTime: "持倉中", exitReason: "持倉中", pnl, rr: (pnl/(PORTFOLIO*RISK)).toFixed(2) });
  }
  return trades;
}

const wlA = JSON.parse(readFileSync("rules.json","utf8")).watchlist;

console.log("═".repeat(65));
console.log("  策略 A (VWAP+RSI+EMA 4H) — 4/22~4/23 真實模擬損益");
console.log("═".repeat(65));

let totalPnl=0, wins=0, losses=0, open=0;
const all = [];

for (const sym of wlA) {
  const trades = await simSymbol(sym);
  for (const t of trades) {
    all.push(t);
    totalPnl += t.pnl;
    if (t.exitReason==="持倉中") open++;
    else if (t.pnl > 0) wins++;
    else losses++;
    const emoji = t.exitReason==="持倉中"?"📂":t.pnl>0?"✅":"❌";
    console.log(`  ${emoji} ${t.symbol.padEnd(14)} ${t.side.toUpperCase().padEnd(6)} 進$${t.entryPrice.toFixed(4)} → 出$${t.exitPrice.toFixed(4)}  P&L:${t.pnl>=0?"+":""}$${t.pnl.toFixed(2)} (${t.rr}R)  [${t.exitReason}]  進場:${t.entryTime}  RSI:${t.r3}`);
  }
}

const total = wins+losses+open;
const closed = wins+losses;
const gw = all.filter(t=>t.pnl>0).reduce((s,t)=>s+t.pnl,0);
const gl = Math.abs(all.filter(t=>t.pnl<0&&t.exitReason!=="持倉中").reduce((s,t)=>s+t.pnl,0));

console.log("\n" + "═".repeat(65));
console.log(`  總進場: ${total} 筆  ✅勝 ${wins}  ❌敗 ${losses}  📂持倉中 ${open}`);
console.log(`  勝率(已結): ${closed?(wins/closed*100).toFixed(1):0}%`);
console.log(`  總損益: ${totalPnl>=0?"+":""}$${totalPnl.toFixed(2)}`);
console.log(`  平均每筆: ${total?(totalPnl/total).toFixed(2):0}`);
console.log(`  Profit Factor: ${gl>0?(gw/gl).toFixed(2):"∞"}`);
console.log("═".repeat(65));
