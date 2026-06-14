/**
 * 策略A 三時間框架對比回測
 * 1m vs 5m vs 15m — 1個月，前10幣
 */
import { readFileSync } from "fs";
const fetch = (await import("node-fetch")).default;

const PORTFOLIO = 388;
const RISK_PCT  = 0.01;
const MONTHS    = 1;
const SYMBOLS   = JSON.parse(readFileSync("./rules.json","utf8")).watchlist.slice(0,10);

async function fetchCandles(symbol, interval, months) {
  const msMap = { "1m":60000, "5m":300000, "15m":900000 };
  const ms = msMap[interval];
  const total = Math.ceil(months * 30 * 24 * 60 * 60 * 1000 / ms);
  const all = [];
  let endTime = Date.now();
  while (all.length < total) {
    const limit = Math.min(1000, total - all.length);
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&endTime=${endTime}&limit=${limit}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) break;
    all.unshift(...data.map(k => ({ time:+k[0],open:+k[1],high:+k[2],low:+k[3],close:+k[4],volume:+k[5] })));
    endTime = data[0][0] - 1;
    if (data.length < limit) break;
  }
  return all.sort((a,b) => a.time - b.time);
}

function ema(closes, n) {
  const k=2/(n+1); let v=closes[0];
  for(let i=1;i<closes.length;i++) v=closes[i]*k+v*(1-k);
  return v;
}
function rsi(closes, n=3) {
  if(closes.length<n+1) return null;
  const sl=closes.slice(-n-1); let g=0,l=0;
  for(let i=1;i<sl.length;i++){const d=sl[i]-sl[i-1];d>0?g+=d:l-=d;}
  return l===0?100:100-100/(1+g/l);
}
function calcATR(candles, n=14) {
  if(candles.length<n+1) return null;
  const trs=candles.slice(1).map((c,i)=>Math.max(c.high-c.low,Math.abs(c.high-candles[i].close),Math.abs(c.low-candles[i].close)));
  return trs.slice(-n).reduce((a,b)=>a+b,0)/n;
}

function backtest(candles) {
  const trades = [];
  let pos = null;
  for (let i=50; i<candles.length; i++) {
    const slice  = candles.slice(Math.max(0,i-500), i+1);
    const closes = slice.map(c=>c.close);
    const price  = closes.at(-1);
    if (price < 0.001) continue;

    const e8    = ema(closes.slice(-30), 8);
    const r3    = rsi(closes, 3);
    const atr14 = calcATR(slice, 14);
    // 近200根VWAP近似
    const vs = slice.slice(-200);
    let tv=0,v=0;
    for(const c of vs){const tp=(c.high+c.low+c.close)/3;tv+=tp*c.volume;v+=c.volume;}
    const vwap = v?tv/v:null;
    if(!vwap||r3===null||!atr14) continue;

    const vwapDist = Math.abs(price-vwap)/vwap*100;

    // 出場
    if (pos) {
      const ir = Math.abs(pos.entry-pos.sl);
      const tp = pos.side==='long'?pos.entry+ir*2:pos.entry-ir*2;
      const c  = candles[i];
      let ep=null, reason='';
      if(pos.side==='long'){
        if(c.low<=pos.sl)      {ep=pos.sl; reason='止損';}
        else if(c.high>=tp)    {ep=tp;     reason='2:1止盈';}
        else if(r3>50)         {ep=price;  reason='RSI回中';}
      } else {
        if(c.high>=pos.sl)     {ep=pos.sl; reason='止損';}
        else if(c.low<=tp)     {ep=tp;     reason='2:1止盈';}
        else if(r3<50)         {ep=price;  reason='RSI回中';}
      }
      if(ep!==null){
        const pnl=pos.side==='long'?(ep-pos.entry)*pos.qty:(pos.entry-ep)*pos.qty;
        trades.push({pnl,win:pnl>0,reason});
        pos=null;
      }
      continue;
    }

    // 進場
    const bull=price>vwap&&price>e8, bear=price<vwap&&price<e8;
    const longSig=bull&&r3<30&&vwapDist<1.5;
    const shortSig=bear&&r3>70&&vwapDist<1.5;
    if(!longSig&&!shortSig) continue;

    const side=longSig?'long':'short';
    const sl=side==='long'?vwap-atr14*0.15:vwap+atr14*0.15;
    const slPct=Math.abs(price-sl)/price*100;
    if(slPct<0.05||slPct>1.5) continue;

    const qty=Math.min((PORTFOLIO*RISK_PCT)/Math.abs(price-sl), PORTFOLIO/price);
    pos={side,entry:price,sl,qty};
  }
  return trades;
}

// ─── 主程式 ──────────────────────────────────────────────────────────────────
const TIMEFRAMES = ["1m","5m","15m"];
const results = {};

for (const tf of TIMEFRAMES) {
  let all=[];
  process.stdout.write(`[${tf}] 回測中`);
  for (const sym of SYMBOLS) {
    try {
      const candles = await fetchCandles(sym, tf, MONTHS);
      all = all.concat(backtest(candles));
      process.stdout.write('.');
    } catch(e){ process.stdout.write('x'); }
  }
  const wins=all.filter(t=>t.win), losses=all.filter(t=>!t.win);
  const gw=wins.reduce((s,t)=>s+t.pnl,0);
  const gl=Math.abs(losses.reduce((s,t)=>s+t.pnl,0));
  let peak=0,dd=0,run=0;
  for(const t of all){run+=t.pnl;if(run>peak)peak=run;dd=Math.max(dd,peak-run);}
  const byR={};
  for(const t of all) byR[t.reason]=(byR[t.reason]||0)+1;
  results[tf]={
    n:all.length, wr:all.length?(wins.length/all.length*100).toFixed(1):0,
    pnl:all.reduce((s,t)=>s+t.pnl,0).toFixed(2),
    pf:gl?(gw/gl).toFixed(2):'∞',
    aw:wins.length?(gw/wins.length).toFixed(3):0,
    al:losses.length?(gl/losses.length).toFixed(3):0,
    dd:dd.toFixed(2), byR
  };
  console.log(` 完成 (${all.length}筆)`);
}

console.log('\n═══════════════════════════════════════════════════════════');
console.log('  策略A 時間框架對比（過去1個月，10幣）');
console.log('═══════════════════════════════════════════════════════════');
console.log(`${''.padEnd(18)}${'1m'.padStart(8)}${'5m'.padStart(8)}${'15m'.padStart(8)}`);
console.log('─'.repeat(42));
const rows=[['總交易筆數','n'],['勝率','wr','%'],['總損益($)','pnl'],['Profit Factor','pf'],['平均獲利','aw'],['平均虧損','al'],['最大回撤','dd']];
for(const [lb,k,u=''] of rows){
  const vs=TIMEFRAMES.map(tf=>String(results[tf][k]||0)+u);
  console.log(`${lb.padEnd(18)}${vs[0].padStart(8)}${vs[1].padStart(8)}${vs[2].padStart(8)}`);
}
console.log('─'.repeat(42));
console.log('\n出場原因：');
for(const tf of TIMEFRAMES){
  const r=results[tf].byR;
  console.log(`  [${tf}]  止損:${r['止損']||0}  2:1止盈:${r['2:1止盈']||0}  RSI回中:${r['RSI回中']||0}`);
}
console.log('');
