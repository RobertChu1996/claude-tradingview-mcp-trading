/**
 * 日線回測：策略 A & E，ATR 止損，主流幣
 * 改動：1H→1D，止損改 2×ATR(14)，幣種縮至主流 12 個
 * 執行：node backtest_daily.js
 */

const SYMBOLS = [
  "BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT",
  "ADAUSDT","AVAXUSDT","LINKUSDT","DOTUSDT","DOGEUSDT",
  "LTCUSDT","NEARUSDT",
];

const INTERVAL  = "1d";
const MONTHS    = 24;   // 日線用 2 年，樣本更可靠
const PORTFOLIO = 1000;
const RISK      = 10;   // 1%
const MAX_TRADE = 200;
const MAX_OPEN  = 3;    // 主流幣少，上限 3
const LOOKBACK  = 60;
const TP_RATIO  = 2.0;
const ATR_SL_MULT = 2.0; // 止損 = 2×ATR

// ─── 抓資料 ───────────────────────────────────────────────────────────────────
async function fetchCandles(symbol) {
  const need = MONTHS * 30;
  let all = [], et = Date.now();
  while (all.length < need) {
    const limit = Math.min(1000, need - all.length);
    const url   = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${INTERVAL}&endTime=${et}&limit=${limit}`;
    const res   = await fetch(url);
    if (!res.ok) throw new Error(res.status);
    const data  = await res.json();
    if (!data.length) break;
    all.unshift(...data.map(k => ({ time:+k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5] })));
    et = data[0][0] - 1;
  }
  return all;
}

// ─── 預計算指標 ───────────────────────────────────────────────────────────────
function precompute(candles) {
  const n = candles.length;
  const closes = candles.map(c => c.close);
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);
  const vols   = candles.map(c => c.volume);
  const opens  = candles.map(c => c.open);

  function emaArr(period) {
    const k = 2/(period+1), out = new Float64Array(n).fill(NaN);
    if (n < period) return out;
    let v = closes.slice(0,period).reduce((a,b)=>a+b,0)/period;
    out[period-1] = v;
    for (let i = period; i < n; i++) { v = closes[i]*k + v*(1-k); out[i] = v; }
    return out;
  }

  // 簡單 RSI（與原版一致）
  function rsiArr(period) {
    const out = new Float64Array(n).fill(NaN);
    for (let i = period; i < n; i++) {
      let g = 0, l = 0;
      for (let j = i-period+1; j <= i; j++) {
        const d = closes[j] - closes[j-1];
        d > 0 ? g += d : l -= d;
      }
      out[i] = 100 - 100/(1 + g/(l||1e-9));
    }
    return out;
  }

  // ATR
  function atrArr(period) {
    const out = new Float64Array(n).fill(NaN);
    if (n < period+1) return out;
    let sum = 0;
    for (let i = 1; i <= period; i++)
      sum += Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1]));
    out[period] = sum/period;
    for (let i = period+1; i < n; i++) {
      const tr = Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1]));
      out[i] = (out[i-1]*(period-1) + tr)/period;
    }
    return out;
  }

  // ADX（完整：Wilder smooth TR/DM，再 smooth DX）
  function adxArr(period) {
    const out = new Float64Array(n).fill(0);
    if (n < period*2+2) return out;
    let sTR=0, sDMp=0, sDMm=0;
    for (let i=1; i<=period; i++) {
      const up=highs[i]-highs[i-1], dn=lows[i-1]-lows[i];
      sDMp += up>dn&&up>0?up:0; sDMm += dn>up&&dn>0?dn:0;
      sTR  += Math.max(highs[i]-lows[i],Math.abs(highs[i]-closes[i-1]),Math.abs(lows[i]-closes[i-1]));
    }
    const dx = new Float64Array(n).fill(0);
    const dxAt = (tr,dmp,dmm) => { const p=tr?dmp/tr*100:0,m=tr?dmm/tr*100:0; return (p+m)?Math.abs(p-m)/(p+m)*100:0; };
    dx[period] = dxAt(sTR,sDMp,sDMm);
    for (let i=period+1; i<n; i++) {
      const up=highs[i]-highs[i-1],dn=lows[i-1]-lows[i];
      const tr=Math.max(highs[i]-lows[i],Math.abs(highs[i]-closes[i-1]),Math.abs(lows[i]-closes[i-1]));
      sTR=sTR-sTR/period+tr; sDMp=sDMp-sDMp/period+(up>dn&&up>0?up:0); sDMm=sDMm-sDMm/period+(dn>up&&dn>0?dn:0);
      dx[i]=dxAt(sTR,sDMp,sDMm);
    }
    let adxV=0; for (let i=period;i<period*2;i++) adxV+=dx[i]; adxV/=period;
    out[period*2-1]=adxV;
    for (let i=period*2;i<n;i++) { adxV=(adxV*(period-1)+dx[i])/period; out[i]=adxV; }
    return out;
  }

  const e8=emaArr(8), e20=emaArr(20), e21=emaArr(21), e50=emaArr(50);
  const r3=rsiArr(3), r14=rsiArr(14);
  const atr=atrArr(14), adx=adxArr(14);

  // Volume 20-bar avg
  const va20 = new Float64Array(n).fill(NaN);
  for (let i=20;i<n;i++) { let s=0; for(let j=i-20;j<i;j++) s+=vols[j]; va20[i]=s/20; }

  return { closes, highs, lows, opens, vols, e8, e20, e21, e50, r3, r14, atr, adx, va20, n };
}

// ─── 策略 A 信號（日線版）─────────────────────────────────────────────────────
// 邏輯：EMA20 > EMA50 大趨勢，RSI-14 回調到 38-50，止損 2×ATR
function sigA(pc, i) {
  if (i < LOOKBACK) return null;
  const { closes, opens, e20, e50, r14, atr, adx } = pc;
  const price = closes[i];
  if (isNaN(e20[i]) || isNaN(e50[i]) || isNaN(r14[i]) || isNaN(atr[i])) return null;
  if (adx[i] < 18) return null;

  const isBullBar = closes[i] > opens[i];
  const isBearBar = closes[i] < opens[i];
  const e20Slope  = i >= 5 ? (e20[i]-e20[i-5])/e20[i-5] : 0;

  // 多單：EMA20 > EMA50 上升趨勢，RSI-14 回調至 38-52，看漲K棒
  if (e20[i] > e50[i] && price > e50[i] && r14[i] >= 38 && r14[i] <= 52 && isBullBar && e20Slope > 0) {
    const sl    = price - ATR_SL_MULT * atr[i];
    const slPct = (price-sl)/price*100;
    if (slPct < 0.5 || slPct > 12 || sl <= 0) return null;
    return { side: "long", stopLoss: sl };
  }
  // 空單：EMA20 < EMA50 下降趨勢，RSI-14 反彈至 48-62，看跌K棒
  if (e20[i] < e50[i] && price < e50[i] && r14[i] >= 48 && r14[i] <= 62 && isBearBar && e20Slope < 0) {
    const sl    = price + ATR_SL_MULT * atr[i];
    const slPct = (sl-price)/price*100;
    if (slPct < 0.5 || slPct > 12) return null;
    return { side: "short", stopLoss: sl };
  }
  return null;
}

// ─── 策略 E 信號（日線版）─────────────────────────────────────────────────────
// 邏輯：EMA21 > EMA50 大趨勢，價格回調至 EMA21 附近（±3%），RSI-14 40-55，看漲K棒
function sigE(pc, i) {
  if (i < LOOKBACK) return null;
  const { closes, opens, e21, e50, r14, atr, adx } = pc;
  const price = closes[i];
  if (isNaN(e21[i]) || isNaN(e50[i]) || isNaN(r14[i]) || isNaN(atr[i])) return null;
  if (adx[i] < 18) return null;

  const isBullBar = closes[i] > opens[i];
  const isBearBar = closes[i] < opens[i];
  const e21Slope  = i >= 5 ? (e21[i]-e21[i-5])/e21[i-5] : 0;

  // 多單：大趨勢向上，價格回調接近 EMA21（-5%~+3%），RSI-14 未超買
  const nearE21Long  = price >= e21[i]*0.96 && price <= e21[i]*1.03;
  // 空單：大趨勢向下，價格反彈接近 EMA21（-3%~+5%）
  const nearE21Short = price >= e21[i]*0.97 && price <= e21[i]*1.04;

  if (e21[i] > e50[i] && nearE21Long && r14[i] >= 38 && r14[i] <= 56 && isBullBar && e21Slope > 0) {
    const sl    = price - ATR_SL_MULT * atr[i];
    const slPct = (price-sl)/price*100;
    if (slPct < 0.5 || slPct > 12 || sl <= 0) return null;
    return { side: "long", stopLoss: sl };
  }
  if (e21[i] < e50[i] && nearE21Short && r14[i] >= 44 && r14[i] <= 62 && isBearBar && e21Slope < 0) {
    const sl    = price + ATR_SL_MULT * atr[i];
    const slPct = (sl-price)/price*100;
    if (slPct < 0.5 || slPct > 12) return null;
    return { side: "short", stopLoss: sl };
  }
  return null;
}

// ─── 出場（OCO high/low）────────────────────────────────────────────────────
function trailingStop(pos, cl) {
  const { side, entryPrice, stopLoss } = pos;
  const risk = Math.abs(entryPrice - stopLoss);
  if (!risk) return stopLoss;
  const profitR = (side==="long" ? cl-entryPrice : entryPrice-cl) / risk;
  if (profitR < 1.0) return stopLoss;
  const lockR   = Math.max(0, Math.floor(profitR*2)/2 - 1.0);
  const newStop = side==="long" ? entryPrice+risk*lockR : entryPrice-risk*lockR;
  return side==="long" ? Math.max(stopLoss,newStop) : Math.min(stopLoss,newStop);
}

function checkExit(pos, hi, lo, cl) {
  pos.stopLoss = trailingStop(pos, cl);
  const risk = Math.abs(pos.entryPrice - pos.stopLoss);
  const tp   = pos.side==="long" ? pos.entryPrice+risk*TP_RATIO : pos.entryPrice-risk*TP_RATIO;
  if (pos.side==="long") {
    const slHit=lo<=pos.stopLoss, tpHit=hi>=tp;
    if (slHit&&tpHit) return { exit:true, ep:pos.stopLoss };
    if (tpHit) return { exit:true, ep:tp };
    if (slHit) return { exit:true, ep:pos.stopLoss };
  } else {
    const slHit=hi>=pos.stopLoss, tpHit=lo<=tp;
    if (slHit&&tpHit) return { exit:true, ep:pos.stopLoss };
    if (tpHit) return { exit:true, ep:tp };
    if (slHit) return { exit:true, ep:pos.stopLoss };
  }
  return { exit:false };
}

// ─── 模擬 ─────────────────────────────────────────────────────────────────────
function runStrategy(sigFn, precomps, candles, idxMap, times, btcBull, label) {
  const openPos=[], trades=[], cooldown={};
  for (const ts of times) {
    for (const pos of [...openPos]) {
      const idx = idxMap[pos.symbol]?.[ts];
      if (idx===undefined) continue;
      const pc = precomps[pos.symbol];
      const { exit, ep } = checkExit(pos, pc.highs[idx], pc.lows[idx], pc.closes[idx]);
      if (exit) {
        const pnl = pos.side==="long"
          ? (ep-pos.entryPrice)*pos.quantity
          : (pos.entryPrice-ep)*pos.quantity;
        trades.push({ symbol:pos.symbol, pnl, win:pnl>0, entryTime:pos.entryTime, exitTime:ts });
        cooldown[pos.symbol] = ts;
        openPos.splice(openPos.indexOf(pos), 1);
      }
    }
    if (openPos.length >= MAX_OPEN) continue;
    const isBull = btcBull[ts];
    for (const symbol of Object.keys(precomps)) {
      if (openPos.length >= MAX_OPEN) break;
      if (openPos.some(p => p.symbol===symbol)) continue;
      // 日線冷卻：同幣出場後 3 天不再進
      if (cooldown[symbol] && ts - cooldown[symbol] < 3*24*3600*1000) continue;
      const idx = idxMap[symbol]?.[ts];
      if (idx===undefined || idx < LOOKBACK) continue;
      const pc  = precomps[symbol];
      const sig = sigFn(pc, idx, isBull);
      if (!sig) continue;
      const price   = pc.closes[idx];
      const slPct   = Math.abs(price - sig.stopLoss) / price;
      const rawSize = slPct > 0.001 ? RISK/slPct : RISK;
      const size    = Math.min(rawSize, PORTFOLIO, MAX_TRADE);
      openPos.push({ symbol, side:sig.side, entryPrice:price, entryTime:ts, stopLoss:sig.stopLoss, quantity:size/price });
    }
  }
  return trades;
}

// ─── 月報 ─────────────────────────────────────────────────────────────────────
function printReport(label, trades) {
  if (!trades.length) { console.log(`  ${label}: 無交易`); return; }
  const byMonth = {};
  for (const t of trades) {
    const m = new Date(t.exitTime).toISOString().slice(0,7);
    if (!byMonth[m]) byMonth[m] = { wins:0, losses:0, pnl:0 };
    byMonth[m].pnl += t.pnl;
    t.win ? byMonth[m].wins++ : byMonth[m].losses++;
  }
  const wins   = trades.filter(t=>t.win).length;
  const losses = trades.filter(t=>!t.win).length;
  const gross  = trades.filter(t=>t.win).reduce((s,t)=>s+t.pnl,0);
  const loss   = Math.abs(trades.filter(t=>!t.win).reduce((s,t)=>s+t.pnl,0));
  const totPnl = trades.reduce((s,t)=>s+t.pnl,0);
  const pf     = loss > 0 ? (gross/loss).toFixed(2) : "∞";

  console.log(`\n${"═".repeat(62)}`);
  console.log(`  ${label}`);
  console.log(`${"═".repeat(62)}`);
  console.log(`  月份      筆數   勝率     月損益    累積損益`);
  console.log(`  ${"─".repeat(52)}`);
  let cumPnl = 0;
  for (const [m, s] of Object.entries(byMonth).sort()) {
    cumPnl += s.pnl;
    const tot = s.wins + s.losses;
    const wr  = tot ? ((s.wins/tot)*100).toFixed(0)+"%" : "—";
    console.log(`  ${m}    ${String(tot).padStart(3)}   ${wr.padStart(4)}   ${s.pnl>=0?" ":""}${s.pnl.toFixed(2).padStart(7)}   ${cumPnl.toFixed(2).padStart(9)}`);
  }
  console.log(`  ${"─".repeat(52)}`);
  console.log(`  全期合計  ${trades.length}筆  勝率 ${((wins/trades.length)*100).toFixed(1)}%  總損益 $${totPnl.toFixed(2)}  PF ${pf}`);
  console.log(`  平均獲利 $${(gross/(wins||1)).toFixed(2)} | 平均虧損 $${(-(loss/(losses||1))).toFixed(2)}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n日線回測：ATR 止損｜${SYMBOLS.length} 主流幣｜${MONTHS}個月｜TP ${TP_RATIO}:1｜SL ${ATR_SL_MULT}×ATR\n`);

  const rawData = {};
  for (let i=0; i<SYMBOLS.length; i++) {
    const sym = SYMBOLS[i];
    process.stdout.write(`  [${i+1}/${SYMBOLS.length}] ${sym}...`);
    try {
      const c = await fetchCandles(sym);
      if (c.length < LOOKBACK*2) { console.log(" 不足"); continue; }
      rawData[sym] = c;
      console.log(` ${c.length}根`);
    } catch(e) { console.log(` 錯誤`); }
  }

  const cutoff = Date.now() - MONTHS*30*24*3600*1000;
  const allTs  = new Set();
  for (const c of Object.values(rawData)) c.forEach(x => { if (x.time>=cutoff) allTs.add(x.time); });
  const times  = [...allTs].sort((a,b)=>a-b);

  const idxMap = {};
  for (const [sym,c] of Object.entries(rawData)) {
    idxMap[sym] = {};
    for (let i=0;i<c.length;i++) idxMap[sym][c[i].time] = i;
  }

  console.log(`\n預計算指標...`);
  const precomps = {};
  for (const [sym,c] of Object.entries(rawData)) precomps[sym] = precompute(c);

  // BTC EMA50 趨勢
  const btcBull = {};
  if (precomps["BTCUSDT"]) {
    const btc=rawData["BTCUSDT"], pc=precomps["BTCUSDT"];
    for (let i=50;i<btc.length;i++) btcBull[btc[i].time] = pc.closes[i] > pc.e50[i];
  }

  console.log(`完成｜${times.length} 個交易日\n`);

  const tradesA = runStrategy((pc,i) => sigA(pc,i), precomps, rawData, idxMap, times, btcBull, "A");
  const tradesE = runStrategy((pc,i) => sigE(pc,i), precomps, rawData, idxMap, times, btcBull, "E");

  printReport("策略 A（EMA8+RSI3 日線，ATR止損）", tradesA);
  printReport("策略 E（EMA21/50 日線，ATR止損）", tradesE);
}

main().catch(console.error);
