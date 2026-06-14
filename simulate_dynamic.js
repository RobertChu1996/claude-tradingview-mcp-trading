/**
 * 動態倉位模擬 vs 固定1%風險
 * 流程：
 *   Pass 1：用前2個月數據算每幣PF
 *   Pass 2：用PF加權倉位跑第3個月
 * 輸出：固定 vs 動態 績效對比
 *
 * 用法：node simulate_dynamic.js [A|B|C|D|ALL]
 */

import { readFileSync, existsSync } from "fs";

const TARGET = (process.argv[2] || "ALL").toUpperCase();
const PORTFOLIO = parseFloat(process.env.PORTFOLIO_VALUE_USD || "388");
const BASE_RISK = 0.01;

// PF → 風險倍數
function pfMultiplier(pf) {
  if (pf >= 3.5) return 2.0;
  if (pf >= 2.0) return 1.5;
  if (pf >= 1.2) return 1.0;
  return 0.5;
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

async function fetchCandles(symbol, interval, months) {
  const fetch = (await import("node-fetch")).default;
  const msMap = { "15m": 15*60*1000, "1h": 60*60*1000, "4h": 4*60*60*1000 };
  const ms    = msMap[interval] || 60*60*1000;
  const total = Math.ceil((months * 30 * 24 * 60 * 60 * 1000) / ms);
  const all   = [];
  let endTime = Date.now();
  while (all.length < total) {
    const limit = Math.min(1000, total - all.length);
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&endTime=${endTime}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.length) break;
    all.unshift(...data.map(k => ({ time:+k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5] })));
    endTime = data[0][0] - 1;
    if (data.length < limit) break;
  }
  return all.sort((a,b) => a.time - b.time);
}

// ─── Indicators ───────────────────────────────────────────────────────────────

const sma    = (a, n) => a.slice(-n).reduce((s,x)=>s+x,0)/n;
const ema    = (a, n) => { const k=2/(n+1); let v=a[0]; a.slice(1).forEach(x=>v=x*k+v*(1-k)); return v; };
const avgVol = (c, n=20) => c.slice(-n).reduce((s,x)=>s+x.volume,0)/n;

function atr(c, n=14) {
  if (c.length<n+1) return null;
  const trs=c.slice(1).map((x,i)=>Math.max(x.high-x.low,Math.abs(x.high-c[i].close),Math.abs(x.low-c[i].close)));
  return trs.slice(-n).reduce((a,b)=>a+b,0)/n;
}
function vwap(c) {
  const d=new Date(c.at(-1).time); d.setUTCHours(0,0,0,0);
  const s=c.filter(x=>x.time>=d.getTime());
  if (!s.length) return null;
  return s.reduce((t,x)=>t+((x.high+x.low+x.close)/3)*x.volume,0)/s.reduce((t,x)=>t+x.volume,0);
}
function rsi(a, n=3) {
  if (a.length<n+1) return null;
  const s=a.slice(-n-1); let g=0,l=0;
  for(let i=1;i<s.length;i++){const d=s[i]-s[i-1];d>0?g+=d:l-=d;}
  return 100-100/(1+g/(l||0.0001));
}
function bb(a, n=20, m=2) {
  if (a.length<n) return null;
  const s=a.slice(-n), mid=s.reduce((x,y)=>x+y,0)/n;
  const std=Math.sqrt(s.reduce((x,y)=>x+(y-mid)**2,0)/n);
  return {upper:mid+m*std,middle:mid,lower:mid-m*std};
}
function swingLow(c,lb=8)  { return Math.min(...c.slice(-lb-1,-1).map(x=>x.low)); }
function swingHigh(c,lb=8) { return Math.max(...c.slice(-lb-1,-1).map(x=>x.high)); }

function trailStop(pos, price) {
  const r=Math.abs(pos.entry-pos.sl); if(!r) return pos.sl;
  const pR=(pos.side==="long"?price-pos.entry:pos.entry-price)/r;
  if(pR<1) return pos.sl;
  const lockR=Math.max(0,Math.floor(pR*2)/2-1);
  const ns=pos.side==="long"?pos.entry+r*lockR:pos.entry-r*lockR;
  return pos.side==="long"?Math.max(pos.sl,ns):Math.min(pos.sl,ns);
}

// ─── Strategy signal/exit ─────────────────────────────────────────────────────

const STRATS = {
  A: {
    interval:"4h",
    signal(s) {
      if(s.length<30) return null;
      const cl=s.map(c=>c.close),pr=cl.at(-1),e8=ema(cl,8),v=vwap(s),r3=rsi(cl,3),atrV=atr(s,14);
      if(!v||!r3||!atrV) return null;
      if(pr>v&&pr>e8&&r3<30) return {side:"long", sl:v-atrV*0.3};
      if(pr<v&&pr<e8&&r3>70) return {side:"short",sl:v+atrV*0.3};
      return null;
    },
    exit(pos,s) {
      const cl=s.map(c=>c.close),pr=cl.at(-1),v=vwap(s),r3=rsi(cl,3),sl=trailStop(pos,pr);
      if(!v||!r3) return false;
      return pos.side==="long"?(pr<=sl||pr<=v||r3>50):(pr>=sl||pr>=v||r3<50);
    }
  },
  B: {
    interval:"15m",
    signal(s) {
      if(s.length<25) return null;
      const cl=s.map(c=>c.close),pr=cl.at(-1);
      const s20n=sma(cl,20),s20p=sma(cl.slice(0,-5),20);
      const last=s.at(-1),volR=last.volume/avgVol(s,20);
      const str=Math.abs(last.close-last.open)/((last.high-last.low)||0.0001);
      const r3=cl.slice(-3).reduce((a,b)=>a+b,0)/3,p3=cl.slice(-6,-3).reduce((a,b)=>a+b,0)/3;
      const atrV=atr(s,14); if(!atrV) return null;
      if(s20n>s20p&&pr>s20n&&volR>1.5&&last.close>last.open&&str>0.6&&r3>p3)
        return {side:"long", sl:swingLow(s,8)-atrV*0.1};
      if(s20n<s20p&&pr<s20n&&volR>1.5&&last.close<last.open&&str>0.6&&r3<p3)
        return {side:"short",sl:swingHigh(s,8)+atrV*0.1};
      return null;
    },
    exit(pos,s) {
      const cl=s.map(c=>c.close),pr=cl.at(-1),s20=sma(cl,20),last=s.at(-1);
      const str=Math.abs(last.close-last.open)/((last.high-last.low)||0.0001),sl=trailStop(pos,pr);
      return pos.side==="long"?(pr<=sl||pr<s20||(last.close<last.open&&str>0.6))
                               :(pr>=sl||pr>s20||(last.close>last.open&&str>0.6));
    }
  },
  C: {
    interval:"1h",
    signal(s) {
      if(s.length<25) return null;
      const cl=s.map(c=>c.close),pr=cl.at(-1),pv=cl.at(-2);
      const bbV=bb(cl,20,2),atrV=atr(s,14); if(!bbV||!atrV) return null;
      const avgA=(()=>{const v=[];for(let i=14;i<=Math.min(s.length-1,24);i++)v.push(atr(s.slice(0,i+1),14));return v.reduce((a,b)=>a+b,0)/(v.length||1);})();
      const volR=s.at(-1).volume/avgVol(s,20),s20n=sma(cl,20),s20p=sma(cl.slice(0,-1),20);
      if(pr>bbV.upper&&pv<=bbV.upper&&volR>1.5&&s20n>s20p&&atrV>avgA)
        return {side:"long", sl:s.at(-1).low -atrV*0.5};
      if(pr<bbV.lower&&pv>=bbV.lower&&volR>1.5&&s20n<s20p&&atrV>avgA)
        return {side:"short",sl:s.at(-1).high+atrV*0.5};
      return null;
    },
    exit(pos,s) {
      const cl=s.map(c=>c.close),pr=cl.at(-1),pv=cl.at(-2);
      const bbV=bb(cl,20,2),sl=trailStop(pos,pr); if(!bbV) return false;
      return pos.side==="long"?(pr<=sl||pr<=bbV.middle||(pr<bbV.upper&&pv>bbV.upper))
                               :(pr>=sl||pr>=bbV.middle||(pr>bbV.lower&&pv<bbV.lower));
    }
  },
  D: {
    interval:"15m",
    signal(s) {
      if(s.length<25) return null;
      const last=s.at(-1),mins=new Date(last.time).getUTCHours()*60+new Date(last.time).getUTCMinutes();
      if(mins<30||mins>240) return null;
      const mid=new Date(last.time); mid.setUTCHours(0,0,0,0);
      const today=s.filter(c=>c.time>=mid.getTime()&&c.time<last.time);
      if(today.length<2) return null;
      const orb=today.slice(0,2),oh=Math.max(...orb.map(c=>c.high)),ol=Math.min(...orb.map(c=>c.low));
      const atrV=atr(s,14),avgA=(()=>{const v=[];for(let i=14;i<=Math.min(s.length-1,34);i++)v.push(atr(s.slice(0,i+1),14));return v.reduce((a,b)=>a+b,0)/(v.length||1);})();
      const volR=last.volume/avgVol(s,20); if(!atrV) return null;
      if(last.close>oh&&volR>1.5&&atrV>avgA*0.8) return {side:"long", sl:ol-atrV*0.5,orb:{h:oh,l:ol}};
      if(last.close<ol&&volR>1.5&&atrV>avgA*0.8) return {side:"short",sl:oh+atrV*0.5,orb:{h:oh,l:ol}};
      return null;
    },
    exit(pos,s) {
      const pr=s.at(-1).close,sl=trailStop(pos,pr);
      const risk=Math.abs(pos.entry-pos.sl),tp=pos.side==="long"?pos.entry+risk*2:pos.entry-risk*2,orb=pos.orb;
      return pos.side==="long"?(pr<=sl||pr>=tp||(orb&&pr<orb.h))
                               :(pr>=sl||pr<=tp||(orb&&pr>orb.l));
    }
  }
};

const RULES = { A:"rules.json", B:"rules_dmc.json", C:"rules_bb.json", D:"rules_orb.json" };

// ─── Backtest one symbol ───────────────────────────────────────────────────────

async function backtestSymbol(symbol, strat, candles, riskMult=1.0) {
  const trades=[], risk=PORTFOLIO*BASE_RISK*riskMult;
  let pos=null;
  for(let i=30;i<candles.length;i++){
    const s=candles.slice(0,i+1),pr=s.at(-1).close;
    if(pos){
      pos.sl=trailStop(pos,pr);
      if(strat.exit(pos,s)){
        const pnl=pos.side==="long"?(pr-pos.entry)*pos.qty:(pos.entry-pr)*pos.qty;
        trades.push({win:pnl>0,pnl});
        pos=null;
      }
    } else {
      const sig=strat.signal(s);
      if(sig){
        if(sig.side==="long" &&sig.sl>=pr) continue;
        if(sig.side==="short"&&sig.sl<=pr) continue;
        const pct=Math.abs(pr-sig.sl)/pr;
        const qty=pct<0.001?risk*2/pr:Math.min(risk/pct,PORTFOLIO*2)/pr;
        pos={side:sig.side,entry:pr,sl:sig.sl,qty,orb:sig.orb};
      }
    }
  }
  if(pos){const pr=candles.at(-1).close;const pnl=pos.side==="long"?(pr-pos.entry)*pos.qty:(pos.entry-pr)*pos.qty;trades.push({win:pnl>0,pnl,open:true});}
  return trades;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function runStrategy(key, strat) {
  const file = RULES[key];
  if (!existsSync(file)) { console.log(`  ${file} 不存在，跳過`); return; }
  const watchlist = JSON.parse(readFileSync(file,"utf8")).watchlist;

  console.log(`\n${"─".repeat(60)}`);
  console.log(`  策略 ${key} [${strat.interval}] — ${watchlist.length} 幣`);
  console.log("─".repeat(60));

  let flatPnl=0, dynPnl=0, flatTrades=0, dynTrades=0;
  let flatWins=0, dynWins=0;

  for(const sym of watchlist){
    process.stdout.write(`  ${sym.padEnd(18)}`);
    try {
      const candles = await fetchCandles(sym, strat.interval, 3);
      if(candles.length<50){console.log("⚪ 數據不足");continue;}

      // Pass 1: flat sizing → 算PF
      const flatResult = await backtestSymbol(sym, strat, candles, 1.0);
      const closed1=flatResult.filter(t=>!t.open);
      const gw=closed1.filter(t=>t.win).reduce((s,t)=>s+t.pnl,0);
      const gl=Math.abs(closed1.filter(t=>!t.win).reduce((s,t)=>s+t.pnl,0));
      const pf=gl>0?gw/gl:gw>0?99:0;
      const mult=pfMultiplier(pf);

      // Pass 2: dynamic sizing
      const dynResult = await backtestSymbol(sym, strat, candles, mult);
      const closed2=dynResult.filter(t=>!t.open);

      const fp=closed1.reduce((s,t)=>s+t.pnl,0);
      const dp=closed2.reduce((s,t)=>s+t.pnl,0);

      flatPnl+=fp; dynPnl+=dp;
      flatTrades+=closed1.length; dynTrades+=closed2.length;
      flatWins+=closed1.filter(t=>t.win).length;
      dynWins+=closed2.filter(t=>t.win).length;

      const arrow=dp>fp?"↑":"↓";
      console.log(`PF ${String(pf.toFixed(1)).padEnd(5)} ×${mult} | Flat $${fp.toFixed(0).padStart(5)}  Dyn $${dp.toFixed(0).padStart(5)} ${arrow}`);
    } catch(e){
      console.log(`⚠️  ${e.message.slice(0,30)}`);
    }
  }

  const flatWR=(flatTrades?flatWins/flatTrades*100:0).toFixed(1);
  const dynWR=(dynTrades?dynWins/dynTrades*100:0).toFixed(1);
  const improve=((dynPnl-flatPnl)/Math.abs(flatPnl||1)*100).toFixed(1);

  console.log(`\n  ┌─────────────────────────────────────────────┐`);
  console.log(`  │  策略 ${key} 結果對比                          │`);
  console.log(`  ├─────────────────────────────────────────────┤`);
  console.log(`  │  固定1%   損益: $${String(flatPnl.toFixed(0)).padEnd(8)} 勝率: ${flatWR}%          │`);
  console.log(`  │  動態倉位 損益: $${String(dynPnl.toFixed(0)).padEnd(8)} 勝率: ${dynWR}%          │`);
  console.log(`  │  提升幅度: ${improve}%${" ".repeat(33)}│`);
  console.log(`  └─────────────────────────────────────────────┘`);

  return { key, flatPnl, dynPnl, improve };
}

async function main(){
  console.log("═".repeat(60));
  console.log("  動態倉位模擬 vs 固定1%風險");
  console.log(`  本金: $${PORTFOLIO} | PF加權倍數: 0.5x / 1x / 1.5x / 2x`);
  console.log("═".repeat(60));

  const keys = TARGET==="ALL" ? ["A","B","C","D"] : [TARGET];
  const results = [];

  for(const k of keys){
    if(!STRATS[k]){console.log(`未知策略: ${k}`);continue;}
    const r = await runStrategy(k, STRATS[k]);
    if(r) results.push(r);
  }

  if(results.length>1){
    console.log("\n\n" + "═".repeat(60));
    console.log("  總結");
    console.log("═".repeat(60));
    const totalFlat=results.reduce((s,r)=>s+r.flatPnl,0);
    const totalDyn=results.reduce((s,r)=>s+r.dynPnl,0);
    results.forEach(r=>console.log(`  策略${r.key}: $${r.flatPnl.toFixed(0)} → $${r.dynPnl.toFixed(0)} (${r.improve>0?"+":""}${r.improve}%)`));
    console.log(`  ─────────────────────────────`);
    console.log(`  合計: $${totalFlat.toFixed(0)} → $${totalDyn.toFixed(0)} (${((totalDyn-totalFlat)/Math.abs(totalFlat||1)*100).toFixed(1)}%)`);
  }
}

main().catch(console.error);
