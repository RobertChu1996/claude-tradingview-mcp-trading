/**
 * Monte Carlo 模擬 — 策略 B (DMC/SMA25 4H)
 * 先跑 12 個月回測取得交易 PnL 分佈，再以 100,000 次模擬驗證策略可行性
 *
 * 用法：
 *   node montecarlo_dmc.js              → 100,000 次，模擬 1 年
 *   node montecarlo_dmc.js 50000 2      → 50,000 次，模擬 2 年
 */

// ─── 回測參數（與 bot_dmc.js 完全一致）──────────────────────────────────────
const SMA_PERIOD      = 25;
const VOL_RATIO       = 1.5;
const STRENGTH        = 0.7;
const SWING_LB        = 8;
const ATR_MULT        = 0.05;
const TP_RATIO        = 3.0;
const SMA_PREV_OFFSET = 5;
const COOLDOWN_BARS   = 2;
const MIN_PRICE       = 0.001;
const MAX_OPEN        = 6;
const MONTHS_BT       = 12;
const PORTFOLIO_BT    = 1000;
const RISK_PCT        = 0.01;
const MAX_TRADE_USD   = 200;
const LOOKBACK        = SMA_PERIOD + SMA_PREV_OFFSET + 10;
const MS_CANDLE       = 4 * 3600 * 1000;
const INTERVAL        = "4h";

// ─── Monte Carlo 參數 ─────────────────────────────────────────────────────────
const N_SIM     = parseInt(process.argv[2] || "100000");
const SIM_YEARS = parseFloat(process.argv[3] || "1");
const PORTFOLIO = 300;       // 真實本金
const RUIN_PCT  = 0.50;      // 歸零定義：虧損超過本金 50%

const WATCHLIST = [
  "BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT",
  "DOGEUSDT","ADAUSDT","AVAXUSDT","DOTUSDT","LINKUSDT",
  "LTCUSDT","UNIUSDT","ATOMUSDT","NEARUSDT","SANDUSDT",
  "MANAUSDT","AXSUSDT","GALAUSDT","APEUSDT","OPUSDT",
  "ARBUSDT","SUIUSDT","SEIUSDT","TIAUSDT","INJUSDT",
  "STXUSDT","ONDOUSDT","TONUSDT","NEARUSDT","BNBUSDT",
];

// ─── Binance K 線 ─────────────────────────────────────────────────────────────
async function fetchCandles(symbol) {
  const fetch  = (await import("node-fetch")).default;
  const need   = Math.ceil((MONTHS_BT * 30 * 24 * 3600 * 1000) / MS_CANDLE) + LOOKBACK + 10;
  const all    = [];
  let endTime  = Date.now();

  while (all.length < need) {
    const limit = Math.min(1000, need - all.length);
    const url   = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${INTERVAL}&endTime=${endTime}&limit=${limit}`;
    const res   = await fetch(url);
    if (!res.ok) throw new Error(`Binance ${res.status}`);
    const data  = await res.json();
    if (!data.length) break;
    all.unshift(...data.map(k => ({ time:+k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5] })));
    endTime = data[0][0] - 1;
    if (data.length < limit) break;
  }
  return all.sort((a, b) => a.time - b.time);
}

// ─── 指標 ─────────────────────────────────────────────────────────────────────
const smaOf    = (cls, n)  => cls.slice(-n).reduce((a,b)=>a+b,0)/n;
const avgVolOf = (cs, n)   => cs.slice(-n).reduce((s,c)=>s+c.volume,0)/n;
const swingLow = (cs, lb)  => Math.min(...cs.slice(-lb-1,-1).map(c=>c.low));
const swingHigh= (cs, lb)  => Math.max(...cs.slice(-lb-1,-1).map(c=>c.high));
function atrOf(cs, n=14) {
  const trs = cs.slice(1).map((c,i)=>{
    const p=cs[i].close;
    return Math.max(c.high-c.low,Math.abs(c.high-p),Math.abs(c.low-p));
  });
  return trs.slice(-n).reduce((a,b)=>a+b,0)/n;
}

function checkSignal(candles) {
  if (candles.length < SMA_PERIOD+SMA_PREV_OFFSET+10) return null;
  const cls   = candles.map(c=>c.close);
  const price = cls[cls.length-1];
  if (price < MIN_PRICE) return null;
  const smaNow  = smaOf(cls, SMA_PERIOD);
  const smaPrev = smaOf(cls.slice(0,-SMA_PREV_OFFSET), SMA_PERIOD);
  const last    = candles[candles.length-1];
  const volR    = last.volume/avgVolOf(candles,20);
  const body    = Math.abs(last.close-last.open);
  const range   = last.high-last.low||0.0001;
  const str     = body/range;
  const rec3    = cls.slice(-3).reduce((a,b)=>a+b,0)/3;
  const prev3   = cls.slice(-6,-3).reduce((a,b)=>a+b,0)/3;
  const atr     = atrOf(candles,14);

  if (smaNow>smaPrev&&price>smaNow&&volR>VOL_RATIO&&last.close>last.open&&str>STRENGTH&&rec3>prev3) {
    const sl=swingLow(candles,SWING_LB)-atr*ATR_MULT;
    const slPct=(price-sl)/price;
    if (sl>=price||slPct<0.003||slPct>0.15) return null;
    return { side:"long", stopLoss:sl, tp:price+(price-sl)*TP_RATIO };
  }
  if (smaNow<smaPrev&&price<smaNow&&volR>VOL_RATIO&&last.close<last.open&&str>STRENGTH&&rec3<prev3) {
    const sl=swingHigh(candles,SWING_LB)+atr*ATR_MULT;
    const slPct=(sl-price)/price;
    if (sl<=price||slPct<0.003||slPct>0.15) return null;
    const tp=price-(sl-price)*TP_RATIO;
    if (tp<=0) return null;
    return { side:"short", stopLoss:sl, tp };
  }
  return null;
}

function btcTrend(btcCandles, ts) {
  const idx = btcCandles.findIndex(c=>c.time===ts);
  if (idx < SMA_PERIOD+SMA_PREV_OFFSET) return 0;
  const cls   = btcCandles.slice(0,idx+1).map(c=>c.close);
  const smaNow  = smaOf(cls, SMA_PERIOD);
  const smaPrev = smaOf(cls.slice(0,-SMA_PREV_OFFSET), SMA_PERIOD);
  if (smaNow>smaPrev*1.001) return  1;
  if (smaNow<smaPrev*0.999) return -1;
  return 0;
}

function trailingSL(pos, price) {
  const risk=Math.abs(pos.entryPrice-pos.stopLoss);
  if (!risk) return pos.stopLoss;
  const profitR=(pos.side==="long"?price-pos.entryPrice:pos.entryPrice-price)/risk;
  if (profitR<1) return pos.stopLoss;
  const lockR=Math.max(0,Math.floor(profitR*2)/2-1.0);
  const ns=pos.side==="long"?pos.entryPrice+risk*lockR:pos.entryPrice-risk*lockR;
  return pos.side==="long"?Math.max(pos.stopLoss,ns):Math.min(pos.stopLoss,ns);
}

function checkExit(pos, candle) {
  pos.stopLoss = trailingSL(pos, candle.close);
  const sl=pos.stopLoss;
  if (pos.side==="long") {
    const slHit=candle.low<=sl, tpHit=candle.high>=pos.tp;
    if (slHit&&tpHit) return { exit:true, ep:candle.close>candle.open?pos.tp:sl };
    if (tpHit) return { exit:true, ep:pos.tp };
    if (slHit) return { exit:true, ep:sl };
  } else {
    const slHit=candle.high>=sl, tpHit=candle.low<=pos.tp;
    if (slHit&&tpHit) return { exit:true, ep:candle.close<candle.open?pos.tp:sl };
    if (tpHit) return { exit:true, ep:pos.tp };
    if (slHit) return { exit:true, ep:sl };
  }
  return { exit:false };
}

// ─── 回測（含 BTC 過濾）──────────────────────────────────────────────────────
function runBacktest(allData, times, cutoff) {
  const btcCandles = allData["BTCUSDT"]||[];
  const openPos=[], trades=[], cooldown={};

  for (const ts of times) {
    for (const pos of [...openPos]) {
      const cs  = allData[pos.symbol];
      const idx = cs.findIndex(c=>c.time===ts);
      if (idx<0) continue;
      const { exit, ep } = checkExit(pos, cs[idx]);
      if (exit) {
        const pnl=pos.side==="long"?(ep-pos.entryPrice)*pos.quantity:(pos.entryPrice-ep)*pos.quantity;
        trades.push({ pnl, win:pnl>0 });
        cooldown[pos.symbol]=ts;
        openPos.splice(openPos.indexOf(pos),1);
      }
    }

    if (openPos.length>=MAX_OPEN) continue;
    const trend=btcTrend(btcCandles, ts);

    for (const [symbol, cs] of Object.entries(allData)) {
      if (symbol==="BTCUSDT") continue;
      if (openPos.length>=MAX_OPEN) break;
      if (openPos.some(p=>p.symbol===symbol)) continue;
      if (cooldown[symbol]&&ts-cooldown[symbol]<COOLDOWN_BARS*MS_CANDLE) continue;
      const idx=cs.findIndex(c=>c.time===ts);
      if (idx<LOOKBACK||cs[idx].time<cutoff) continue;

      const slice=cs.slice(0,idx+1);
      const price=cs[idx].close;
      const sig=checkSignal(slice);
      if (!sig) continue;
      if (trend===1&&sig.side==="short") continue;
      if (trend===-1&&sig.side==="long") continue;

      const slPct=Math.abs(price-sig.stopLoss)/price;
      const rawSz=slPct>0.001?(PORTFOLIO_BT*RISK_PCT)/slPct:PORTFOLIO_BT*RISK_PCT;
      const size=Math.min(rawSz,MAX_TRADE_USD);
      openPos.push({ symbol, side:sig.side, entryPrice:price, stopLoss:sig.stopLoss, tp:sig.tp, quantity:size/price });
    }
  }
  return trades;
}

// ─── Monte Carlo ──────────────────────────────────────────────────────────────
function percentile(arr, p) {
  const s=[...arr].sort((a,b)=>a-b);
  return s[Math.floor(s.length*p/100)];
}

function runMonteCarlo(trades, nSim, simYears) {
  const pnls = trades.map(t=>t.pnl);
  // 換算為本金比例（回測以 $1000 計，真實以 $300）
  const scale = PORTFOLIO / PORTFOLIO_BT;
  const scaledPnls = pnls.map(p=>p*scale);

  // 每年預期交易筆數（依回測頻率推算）
  const tradesPerYear = Math.round(trades.length / MONTHS_BT * 12 * simYears);

  const finalPnls=[], mdds=[];
  let ruins=0;

  for (let s=0; s<nSim; s++) {
    let equity=PORTFOLIO, peak=PORTFOLIO, mdd=0;
    const n=tradesPerYear;

    for (let i=0; i<n; i++) {
      // 隨機抽一筆歷史交易 PnL（bootstrap）
      equity += scaledPnls[Math.floor(Math.random()*scaledPnls.length)];
      if (equity>peak) peak=equity;
      const dd=(peak-equity)/peak*100;
      if (dd>mdd) mdd=dd;
      if (equity<=PORTFOLIO*(1-RUIN_PCT)) { ruins++; break; }
    }

    finalPnls.push(equity-PORTFOLIO);
    mdds.push(mdd);
  }

  return { finalPnls, mdds, ruins, tradesPerYear };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const cutoff = Date.now() - MONTHS_BT*30*24*3600*1000;
  const symbols = [...new Set(["BTCUSDT",...WATCHLIST])];

  console.log(`\n策略 B Monte Carlo 模擬`);
  console.log(`回測：${MONTHS_BT}個月 4H | BTC過濾 ON | ${symbols.length-1} 幣種`);
  console.log(`模擬：${N_SIM.toLocaleString()} 次 × ${SIM_YEARS} 年 | 本金 $${PORTFOLIO}`);
  console.log("═".repeat(55));
  console.log("下載 K 線資料...");

  const allData={};
  for (let i=0; i<symbols.length; i++) {
    const sym=symbols[i];
    process.stdout.write(`  [${i+1}/${symbols.length}] ${sym}... `);
    try {
      const cs=await fetchCandles(sym);
      const si=cs.findIndex(c=>c.time>=cutoff);
      if (si<LOOKBACK) { console.log("資料不足"); continue; }
      allData[sym]=cs;
      console.log(`${cs.length} 根`);
    } catch(e) { console.log(`錯誤: ${e.message}`); }
  }

  const timeSet=new Set();
  for (const cs of Object.values(allData))
    cs.filter(b=>b.time>=cutoff).forEach(b=>timeSet.add(b.time));
  const times=[...timeSet].sort((a,b)=>a-b);

  console.log(`\n跑回測取得交易分佈...`);
  const trades=runBacktest(allData, times, cutoff);
  const wins=trades.filter(t=>t.win);
  const losses=trades.filter(t=>!t.win);
  const sumW=wins.reduce((s,t)=>s+t.pnl,0);
  const sumL=Math.abs(losses.reduce((s,t)=>s+t.pnl,0));
  const pf=sumL>0?sumW/sumL:Infinity;
  const wr=trades.length?(wins.length/trades.length*100).toFixed(1):"0";
  const totalPnl=trades.reduce((s,t)=>s+t.pnl,0);

  console.log(`回測結果：${trades.length} 筆 | WR=${wr}% | PF=${pf.toFixed(2)} | 總損益=$${totalPnl.toFixed(0)}`);
  console.log(`\n跑 Monte Carlo ${N_SIM.toLocaleString()} 次...`);

  const { finalPnls, mdds, ruins, tradesPerYear } = runMonteCarlo(trades, N_SIM, SIM_YEARS);

  const profitCount=finalPnls.filter(p=>p>0).length;
  const profitPct=(profitCount/N_SIM*100).toFixed(1);
  const ruinPct=(ruins/N_SIM*100).toFixed(2);
  const medianPnl=percentile(finalPnls,50);
  const p10Pnl=percentile(finalPnls,10);
  const p90Pnl=percentile(finalPnls,90);
  const p5Pnl=percentile(finalPnls,5);
  const p95Pnl=percentile(finalPnls,95);
  const medianMdd=percentile(mdds,50);
  const p90Mdd=percentile(mdds,90);
  const p95Mdd=percentile(mdds,95);
  const expectedPnl=finalPnls.reduce((s,p)=>s+p,0)/N_SIM;

  console.log(`\n${"═".repeat(55)}`);
  console.log(`  Monte Carlo 結果（${N_SIM.toLocaleString()} 次，${SIM_YEARS} 年）`);
  console.log(`  本金 $${PORTFOLIO} | 預計每年交易 ${tradesPerYear} 筆`);
  console.log(`${"─".repeat(55)}`);
  console.log(`  獲利機率          ${profitPct}%`);
  console.log(`  歸零機率（-50%）  ${ruinPct}%`);
  console.log(`${"─".repeat(55)}`);
  console.log(`  損益分佈（${SIM_YEARS}年後）`);
  console.log(`    中位數（P50）   $${medianPnl.toFixed(0)}`);
  console.log(`    期望值          $${expectedPnl.toFixed(0)}`);
  console.log(`    悲觀（P10）     $${p10Pnl.toFixed(0)}`);
  console.log(`    極悲觀（P5）    $${p5Pnl.toFixed(0)}`);
  console.log(`    樂觀（P90）     $${p90Pnl.toFixed(0)}`);
  console.log(`    極樂觀（P95）   $${p95Pnl.toFixed(0)}`);
  console.log(`${"─".repeat(55)}`);
  console.log(`  回撤分佈（MDD）`);
  console.log(`    中位數（P50）   ${medianMdd.toFixed(1)}%`);
  console.log(`    90th percentile ${p90Mdd.toFixed(1)}%`);
  console.log(`    95th percentile ${p95Mdd.toFixed(1)}%`);
  console.log(`${"═".repeat(55)}\n`);
}

main().catch(console.error);
