/**
 * 策略 A 參數優化
 * 測試多種條件組合，找出勝率最高 / PF 最好的設定
 *
 * 變數：
 *   rsiLong    : RSI(3) < X 才做多 (10/15/20/25/30)
 *   rsiShort   : RSI(3) > X 才做空 (70/75/80/85/90)
 *   vwapDist   : 距 VWAP 距離上限 % (0.5/1.0/1.5/2.0)
 *   ema21Filter: 是否加 EMA(21) 過濾（多單需在 EMA21 之上）
 *   volFilter  : 是否加成交量確認（> 1.2x 均量）
 *   adxFilter  : 是否加 ADX(14) > 20 趨勢確認
 */
import fetch from "node-fetch";
import { readFileSync } from "fs";

const PORTFOLIO = 388;
const RISK      = 0.01;
const MONTHS    = 3;

async function fetchCandles(symbol, interval) {
  const ms = { "4h": 4*60*60*1000 }[interval] || 3600000;
  const total = Math.ceil(MONTHS * 30 * 24 * 60 * 60 * 1000 / ms);
  const all = []; let endTime = Date.now();
  while (all.length < total) {
    const limit = Math.min(1000, total - all.length);
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&endTime=${endTime}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) break;
    const data = await res.json();
    if (!data.length) break;
    all.unshift(...data.map(k=>({time:+k[0],open:+k[1],high:+k[2],low:+k[3],close:+k[4],volume:+k[5]})));
    endTime = data[0][0] - 1;
    if (data.length < limit) break;
  }
  return all.sort((a,b)=>a.time-b.time);
}

function ema(closes, n) {
  const k=2/(n+1); let e=closes[0];
  for(let i=1;i<closes.length;i++) e=closes[i]*k+e*(1-k);
  return e;
}
function rsi(closes, n=3) {
  let g=0,l=0;
  for(let i=closes.length-n;i<closes.length;i++){const d=closes[i]-closes[i-1];d>0?g+=d:l-=d;}
  return l===0?100:100-100/(1+g/l);
}
function vwap(candles) {
  let tv=0,tpv=0;
  for(const c of candles){const tp=(c.high+c.low+c.close)/3;tpv+=tp*c.volume;tv+=c.volume;}
  return tv?tpv/tv:0;
}
function calcATR(candles, n=14) {
  const trs=candles.slice(1).map((c,i)=>Math.max(c.high-c.low,Math.abs(c.high-candles[i].close),Math.abs(c.low-candles[i].close)));
  return trs.slice(-n).reduce((a,b)=>a+b,0)/n;
}
function adx(candles, n=14) {
  if (candles.length < n+2) return 0;
  const dms = candles.slice(1).map((c,i)=>{
    const upMove = c.high - candles[i].high;
    const downMove = candles[i].low - c.low;
    return { plus: upMove > downMove && upMove > 0 ? upMove : 0,
             minus: downMove > upMove && downMove > 0 ? downMove : 0,
             tr: Math.max(c.high-c.low, Math.abs(c.high-candles[i].close), Math.abs(c.low-candles[i].close)) };
  });
  const s = dms.slice(-n);
  const sumTR = s.reduce((a,d)=>a+d.tr,0);
  const sumP  = s.reduce((a,d)=>a+d.plus,0);
  const sumM  = s.reduce((a,d)=>a+d.minus,0);
  if (!sumTR) return 0;
  const diP = sumP/sumTR*100, diM = sumM/sumTR*100;
  return Math.abs(diP-diM)/(diP+diM||1)*100;
}
function avgVol(candles, n=20) { return candles.slice(-n).reduce((s,c)=>s+c.volume,0)/n; }

function backtest(candles, cfg) {
  const trades = []; let pos = null;
  for (let i=30; i<candles.length; i++) {
    const slice = candles.slice(0, i+1);
    const c = slice.at(-1);
    const closes = slice.map(k=>k.close);
    const price = c.close;
    const e8  = ema(closes.slice(-20), 8);
    const e21 = ema(closes.slice(-30), 21);
    const vw  = vwap(slice.slice(-20));
    const r3  = rsi(closes);
    const atr = calcATR(slice, 14);
    const vol = c.volume / avgVol(slice, 20);
    const adxV = adx(slice, 14);

    if (pos) {
      let exit = null;
      if (pos.side==="long") {
        if (price<=pos.sl) exit="sl";
        else if (price<=vw) exit="vwap";
        else if (price<e8)  exit="ema8";
        else if (r3>50)     exit="rsi50";
      } else {
        if (price>=pos.sl) exit="sl";
        else if (price>=vw) exit="vwap";
        else if (price>e8)  exit="ema8";
        else if (r3<50)     exit="rsi50";
      }
      if (exit) {
        const pnl = pos.side==="long"?(price-pos.entry)*pos.qty:(pos.entry-price)*pos.qty;
        trades.push({ win:pnl>0, pnl });
        pos = null;
      }
      continue;
    }

    const bullish = price>vw && price>e8;
    const bearish = price<vw && price<e8;
    const dist = Math.abs(price-vw)/vw*100;

    // Filters
    if (cfg.volFilter && vol < 1.2) continue;
    if (cfg.adxFilter && adxV < 20) continue;

    let side = null;
    if (bullish && r3 < cfg.rsiLong && dist < cfg.vwapDist) {
      if (cfg.ema21Filter && price < e21) continue;
      side = "long";
    } else if (bearish && r3 > cfg.rsiShort && dist < cfg.vwapDist) {
      if (cfg.ema21Filter && price > e21) continue;
      side = "short";
    }
    if (!side) continue;

    const sl = side==="long" ? vw - atr*0.3 : vw + atr*0.3;
    const slPct = Math.abs(price-sl)/price;
    if (slPct < 0.001) continue;
    const qty = (PORTFOLIO*RISK) / Math.abs(price-sl);
    pos = { side, entry:price, sl, qty };
  }

  if (!trades.length) return null;
  const wins = trades.filter(t=>t.win);
  const loss = trades.filter(t=>!t.win);
  const gw = wins.reduce((s,t)=>s+t.pnl,0);
  const gl = Math.abs(loss.reduce((s,t)=>s+t.pnl,0));
  return {
    trades: trades.length,
    winRate: wins.length/trades.length,
    pf: gl>0 ? gw/gl : gw>0 ? 99 : 0,
    pnl: trades.reduce((s,t)=>s+t.pnl,0),
  };
}

const wlA = JSON.parse(readFileSync("rules.json","utf8")).watchlist;

// ── Parameter grid ────────────────────────────────────────────────────────────
const CONFIGS = [];
for (const rsiLong  of [15, 20, 25, 30])
for (const rsiShort of [70, 75, 80, 85])
for (const vwapDist of [0.8, 1.0, 1.5])
for (const ema21Filter of [false, true])
for (const volFilter   of [false, true])
for (const adxFilter   of [false, true]) {
  CONFIGS.push({ rsiLong, rsiShort, vwapDist, ema21Filter, volFilter, adxFilter });
}
console.log(`測試 ${CONFIGS.length} 種參數組合，${wlA.length} 個幣種...`);

// ── Run ───────────────────────────────────────────────────────────────────────
console.log("抓取 K 線資料...");
const allCandles = {};
for (const sym of wlA) {
  allCandles[sym] = await fetchCandles(sym, "4h");
  process.stdout.write(".");
}
console.log("\n開始回測...");

const results = [];
for (const cfg of CONFIGS) {
  let totalTrades=0, totalWins=0, totalPnl=0, totalGW=0, totalGL=0;
  for (const sym of wlA) {
    const candles = allCandles[sym];
    if (!candles?.length) continue;
    const r = backtest(candles, cfg);
    if (!r) continue;
    totalTrades += r.trades;
    totalWins   += Math.round(r.winRate * r.trades);
    totalPnl    += r.pnl;
    totalGW     += r.pf > 0 && r.pf < 99 ? r.pf * Math.abs(r.pnl - r.pnl/(r.pf+1)) : 0;
  }
  if (totalTrades < 10) continue;
  const wr = totalWins/totalTrades;
  results.push({ cfg, trades:totalTrades, winRate:wr, pnl:totalPnl });
}

// Sort by winRate desc, then PF
results.sort((a,b) => b.winRate - a.winRate || b.pnl - a.pnl);

console.log("\n" + "═".repeat(75));
console.log("  Top 10 參數組合（依勝率排序）");
console.log("═".repeat(75));
console.log("  勝率    損益     筆數  rsiL rsiS vwap% ema21 vol  adx");
console.log("  " + "─".repeat(71));

for (const r of results.slice(0,10)) {
  const c = r.cfg;
  console.log(`  ${(r.winRate*100).toFixed(1).padStart(5)}%  ${(r.pnl>=0?"+":"")+(r.pnl.toFixed(0)).padStart(7)}  ${String(r.trades).padStart(4)}  ${String(c.rsiLong).padStart(3)}  ${String(c.rsiShort).padStart(3)}  ${String(c.vwapDist).padStart(5)}  ${c.ema21Filter?"✅":"❌ "}    ${c.volFilter?"✅":"❌ "}  ${c.adxFilter?"✅":"❌"}`);
}

console.log("\n  基準（當前設定 rsiL<30 rsiS>70 vwap<1.5 無過濾）");
const base = results.find(r=>r.cfg.rsiLong===30&&r.cfg.rsiShort===70&&r.cfg.vwapDist===1.5&&!r.cfg.ema21Filter&&!r.cfg.volFilter&&!r.cfg.adxFilter);
if (base) console.log(`  ${(base.winRate*100).toFixed(1)}%  $${base.pnl.toFixed(0)}  ${base.trades}筆`);
console.log("═".repeat(75));
