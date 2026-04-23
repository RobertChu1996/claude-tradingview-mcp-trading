/**
 * 四策略全幣種優化
 * 從 Binance 永續合約宇宙（>$20M 24h vol）逐幣回測所有策略
 * PF ≥ 0.9 且信號 ≥ 3 的幣寫入各策略的 rules 檔
 *
 * 用法：node optimize_all.js [min_pf] [min_trades]
 */

import { readFileSync, writeFileSync, existsSync } from "fs";

// symbol_pf.json 格式: { A: { BTCUSDT: 2.4, ... }, B: {...}, C: {...}, D: {...} }
const PF_FILE = "symbol_pf.json";

const MIN_PF     = parseFloat(process.argv[2] || "0.9");
const MIN_TRADES = parseInt(process.argv[3]  || "3");
const MIN_VOL_M  = parseFloat(process.env.MIN_VOL_M || "20");
const PORTFOLIO  = parseFloat(process.env.PORTFOLIO_VALUE_USD || "388");
const RISK       = 0.01;
const EXCLUDE    = new Set(["XAUUSDT","XAGUSDT","BTCDOMUSDT","DEFIUSDT","BNXUSDT"]);

// ─── Fetch universe ───────────────────────────────────────────────────────────

async function fetchUniverse() {
  const fetch = (await import("node-fetch")).default;
  const res  = await fetch("https://fapi.binance.com/fapi/v1/ticker/24hr");
  const data = await res.json();
  return data
    .filter(t =>
      t.symbol.endsWith("USDT") &&
      !EXCLUDE.has(t.symbol) &&
      /^[A-Z0-9]+USDT$/.test(t.symbol) &&
      !/\d+(LONG|SHORT|UP|DOWN|BULL|BEAR)/.test(t.symbol) &&
      parseFloat(t.quoteVolume) >= MIN_VOL_M * 1e6
    )
    .sort((a,b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .map(t => t.symbol);
}

// ─── Fetch candles ────────────────────────────────────────────────────────────

async function fetchCandles(symbol, interval = "1h", months = 3) {
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

const sma    = (arr, n) => arr.slice(-n).reduce((a,b)=>a+b,0)/n;
const ema    = (arr, n) => { const k=2/(n+1); let v=arr[0]; arr.slice(1).forEach(x=>v=x*k+v*(1-k)); return v; };
const avgVol = (c, n=20) => c.slice(-n).reduce((s,x)=>s+x.volume,0)/n;

function atr(candles, n=14) {
  if (candles.length < n+1) return null;
  const trs = candles.slice(1).map((c,i) =>
    Math.max(c.high-c.low, Math.abs(c.high-candles[i].close), Math.abs(c.low-candles[i].close)));
  return trs.slice(-n).reduce((a,b)=>a+b,0)/n;
}

function vwap(candles) {
  const mid = new Date(candles.at(-1).time); mid.setUTCHours(0,0,0,0);
  const sess = candles.filter(c=>c.time>=mid.getTime());
  if (!sess.length) return null;
  const tpv = sess.reduce((s,c)=>s+((c.high+c.low+c.close)/3)*c.volume,0);
  const vol = sess.reduce((s,c)=>s+c.volume,0);
  return vol ? tpv/vol : null;
}

function rsi(closes, n=3) {
  if (closes.length < n+1) return null;
  const sl = closes.slice(-n-1);
  let g=0, l=0;
  for (let i=1;i<sl.length;i++) { const d=sl[i]-sl[i-1]; if(d>0)g+=d; else l-=d; }
  return 100-100/(1+g/(l||0.0001));
}

function bb(closes, n=20, mult=2) {
  if (closes.length<n) return null;
  const sl=closes.slice(-n), mid=sl.reduce((a,b)=>a+b,0)/n;
  const std=Math.sqrt(sl.reduce((s,c)=>s+(c-mid)**2,0)/n);
  return { upper:mid+mult*std, middle:mid, lower:mid-mult*std };
}

function swingLow(c, lb=8)  { return Math.min(...c.slice(-lb-1,-1).map(x=>x.low)); }
function swingHigh(c, lb=8) { return Math.max(...c.slice(-lb-1,-1).map(x=>x.high)); }

// ─── Position sizing & trailing stop ─────────────────────────────────────────

function calcSize(price, sl) {
  const risk=PORTFOLIO*RISK, pct=Math.abs(price-sl)/price;
  return pct<0.001 ? risk*2/price : Math.min(risk/pct,PORTFOLIO)/price;
}

function trailStop(pos, price) {
  const r=Math.abs(pos.entryPrice-pos.stopLoss); if(!r) return pos.stopLoss;
  const pR=(pos.side==="long"?price-pos.entryPrice:pos.entryPrice-price)/r;
  if(pR<1.0) return pos.stopLoss;
  const lockR=Math.max(0,Math.floor(pR*2)/2-1.0);
  const ns=pos.side==="long"?pos.entryPrice+r*lockR:pos.entryPrice-r*lockR;
  return pos.side==="long"?Math.max(pos.stopLoss,ns):Math.min(pos.stopLoss,ns);
}

// ─── Strategy definitions ─────────────────────────────────────────────────────

const STRATEGIES = {
  A: {
    interval: "4h",
    signal(slice) {
      if (slice.length<30) return null;
      const closes=slice.map(c=>c.close), price=closes.at(-1);
      const e8=ema(closes,8), v=vwap(slice), r3=rsi(closes,3), atrVal=atr(slice,14);
      if (!v||!r3||!atrVal) return null;
      if (price>v&&price>e8&&r3<30) return { side:"long",  stopLoss:v-atrVal*0.3 };
      if (price<v&&price<e8&&r3>70) return { side:"short", stopLoss:v+atrVal*0.3 };
      return null;
    },
    exit(pos, slice) {
      const closes=slice.map(c=>c.close), price=closes.at(-1);
      const e8=ema(closes,8), v=vwap(slice), r3=rsi(closes,3);
      const sl=trailStop(pos,price);
      if (!v||!r3) return null;
      if (pos.side==="long") {
        if (price<=sl||price<=v||r3>50) return "exit";
      } else {
        if (price>=sl||price>=v||r3<50) return "exit";
      }
      return null;
    },
  },
  B: {
    interval: "15m",
    signal(slice) {
      if (slice.length<25) return null;
      const closes=slice.map(c=>c.close), price=closes.at(-1);
      const s20n=sma(closes,20), s20p=sma(closes.slice(0,-5),20);
      const last=slice.at(-1), volR=last.volume/avgVol(slice,20);
      const body=Math.abs(last.close-last.open), range=last.high-last.low||0.0001;
      const str=body/range;
      const rec3=closes.slice(-3).reduce((a,b)=>a+b,0)/3;
      const prev3=closes.slice(-6,-3).reduce((a,b)=>a+b,0)/3;
      const atrVal=atr(slice,14);
      if (!atrVal) return null;
      if (s20n>s20p&&price>s20n&&volR>1.5&&last.close>last.open&&str>0.6&&rec3>prev3)
        return { side:"long",  stopLoss:swingLow(slice,8)-atrVal*0.1 };
      if (s20n<s20p&&price<s20n&&volR>1.5&&last.close<last.open&&str>0.6&&rec3<prev3)
        return { side:"short", stopLoss:swingHigh(slice,8)+atrVal*0.1 };
      return null;
    },
    exit(pos, slice) {
      const closes=slice.map(c=>c.close), price=closes.at(-1);
      const s20=sma(closes,20), last=slice.at(-1);
      const str=Math.abs(last.close-last.open)/((last.high-last.low)||0.0001);
      const sl=trailStop(pos,price);
      if (pos.side==="long") {
        if (price<=sl||price<s20||(last.close<last.open&&str>0.6)) return "exit";
      } else {
        if (price>=sl||price>s20||(last.close>last.open&&str>0.6)) return "exit";
      }
      return null;
    },
  },
  C: {
    interval: "1h",
    signal(slice) {
      if (slice.length<25) return null;
      const closes=slice.map(c=>c.close), price=closes.at(-1), prev=closes.at(-2);
      const bbVal=bb(closes,20,2), atrVal=atr(slice,14);
      if (!bbVal||!atrVal) return null;
      const avgATR=(()=>{ const v=[]; for(let i=14;i<=Math.min(slice.length-1,24);i++) v.push(atr(slice.slice(0,i+1),14)); return v.reduce((a,b)=>a+b,0)/(v.length||1); })();
      const volR=slice.at(-1).volume/avgVol(slice,20);
      const s20n=sma(closes,20), s20p=sma(closes.slice(0,-1),20);
      if (price>bbVal.upper&&prev<=bbVal.upper&&volR>1.5&&s20n>s20p&&atrVal>avgATR)
        return { side:"long",  stopLoss:slice.at(-1).low -atrVal*0.5 };
      if (price<bbVal.lower&&prev>=bbVal.lower&&volR>1.5&&s20n<s20p&&atrVal>avgATR)
        return { side:"short", stopLoss:slice.at(-1).high+atrVal*0.5 };
      return null;
    },
    exit(pos, slice) {
      const closes=slice.map(c=>c.close), price=closes.at(-1), prev=closes.at(-2);
      const bbVal=bb(closes,20,2), sl=trailStop(pos,price);
      if (!bbVal) return null;
      if (pos.side==="long") {
        if (price<=sl||price<=bbVal.middle||(price<bbVal.upper&&prev>bbVal.upper)) return "exit";
      } else {
        if (price>=sl||price>=bbVal.middle||(price>bbVal.lower&&prev<bbVal.lower)) return "exit";
      }
      return null;
    },
  },
  D: {
    interval: "15m",
    signal(slice) {
      if (slice.length<25) return null;
      const last=slice.at(-1);
      const mins=new Date(last.time).getUTCHours()*60+new Date(last.time).getUTCMinutes();
      if (mins<30||mins>240) return null;
      const midnight=new Date(last.time); midnight.setUTCHours(0,0,0,0);
      const todayC=slice.filter(c=>c.time>=midnight.getTime()&&c.time<last.time);
      if (todayC.length<2) return null;
      const orbC=todayC.slice(0,2);
      const orbHigh=Math.max(...orbC.map(c=>c.high)), orbLow=Math.min(...orbC.map(c=>c.low));
      const atrVal=atr(slice,14);
      const avgATR=(()=>{ const v=[]; for(let i=14;i<=Math.min(slice.length-1,34);i++) v.push(atr(slice.slice(0,i+1),14)); return v.reduce((a,b)=>a+b,0)/(v.length||1); })();
      const volR=last.volume/avgVol(slice,20);
      if (!atrVal) return null;
      if (last.close>orbHigh&&volR>1.5&&atrVal>avgATR*0.8)
        return { side:"long",  stopLoss:orbLow -atrVal*0.5, orb:{high:orbHigh,low:orbLow} };
      if (last.close<orbLow &&volR>1.5&&atrVal>avgATR*0.8)
        return { side:"short", stopLoss:orbHigh+atrVal*0.5, orb:{high:orbHigh,low:orbLow} };
      return null;
    },
    exit(pos, slice) {
      const price=slice.at(-1).close, sl=trailStop(pos,price);
      const risk=Math.abs(pos.entryPrice-pos.stopLoss);
      const tp=pos.side==="long"?pos.entryPrice+risk*2:pos.entryPrice-risk*2;
      const orb=pos.orb;
      if (pos.side==="long") {
        if (price<=sl||price>=tp||(orb&&price<orb.high)) return "exit";
      } else {
        if (price>=sl||price<=tp||(orb&&price>orb.low)) return "exit";
      }
      return null;
    },
  },
};

// ─── Per-symbol backtest ──────────────────────────────────────────────────────

async function backtestSymbol(symbol, strat) {
  const candles = await fetchCandles(symbol, strat.interval, 3);
  if (candles.length < 50) return null;

  const trades = [];
  let pos = null;

  for (let i = 30; i < candles.length; i++) {
    const slice = candles.slice(0, i+1);
    const price = slice.at(-1).close;

    if (pos) {
      pos.stopLoss = trailStop(pos, price);
      if (strat.exit(pos, slice)) {
        const pnl = pos.side==="long"?(price-pos.entryPrice)*pos.qty:(pos.entryPrice-price)*pos.qty;
        trades.push({ win:pnl>0, pnl });
        pos = null;
      }
    } else {
      const sig = strat.signal(slice);
      if (sig) {
        if (sig.side==="long"  && sig.stopLoss>=price) continue;
        if (sig.side==="short" && sig.stopLoss<=price) continue;
        pos = { side:sig.side, entryPrice:price, stopLoss:sig.stopLoss, qty:calcSize(price,sig.stopLoss), orb:sig.orb };
      }
    }
  }

  if (pos) {
    const price=candles.at(-1).close;
    const pnl=pos.side==="long"?(price-pos.entryPrice)*pos.qty:(pos.entryPrice-price)*pos.qty;
    trades.push({ win:pnl>0, pnl, open:true });
  }

  const closed=trades.filter(t=>!t.open);
  if (!closed.length) return { symbol, trades:0, winRate:"0.0", pf:0, pnl:0 };
  const wins=closed.filter(t=>t.win), losses=closed.filter(t=>!t.win);
  const gw=wins.reduce((s,t)=>s+t.pnl,0), gl=Math.abs(losses.reduce((s,t)=>s+t.pnl,0));
  const pf=gl>0?gw/gl:gw>0?99:0;
  return { symbol, trades:closed.length, winRate:(wins.length/closed.length*100).toFixed(1), pf:parseFloat(pf.toFixed(2)), pnl:parseFloat(closed.reduce((s,t)=>s+t.pnl,0).toFixed(2)) };
}

// ─── Rules file map ───────────────────────────────────────────────────────────

const RULES_FILES = { A:"rules.json", B:"rules_dmc.json", C:"rules_bb.json", D:"rules_orb.json" };

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("═".repeat(60));
  console.log("  四策略逐幣優化");
  console.log(`  門檻: PF ≥ ${MIN_PF} | 信號 ≥ ${MIN_TRADES} | 24h vol > $${MIN_VOL_M}M`);
  console.log("═".repeat(60));

  console.log("\n抓取 Binance 永續合約宇宙...");
  const universe = await fetchUniverse();
  console.log(`宇宙: ${universe.length} 幣\n`);

  const summary = {};

  for (const [key, strat] of Object.entries(STRATEGIES)) {
    console.log("\n" + "─".repeat(60));
    console.log(`  策略 ${key} [${strat.interval}] 回測中...`);
    console.log("─".repeat(60));

    const results = [];
    for (const sym of universe) {
      process.stdout.write(`  ${sym.padEnd(18)}`);
      try {
        const r = await backtestSymbol(sym, strat);
        if (r && r.trades > 0) {
          results.push(r);
          const tag = r.pf>=1.5?"✅":r.pf>=MIN_PF?"🟡":"❌";
          console.log(`${tag}  PF ${String(r.pf).padEnd(5)} WR ${r.winRate}%  $${r.pnl.toFixed(0).padStart(6)} (${r.trades}筆)`);
        } else {
          console.log("⚪ 無信號");
        }
      } catch(e) {
        console.log(`⚠️  ${e.message.slice(0,30)}`);
      }
    }

    results.sort((a,b) => b.pnl-a.pnl);
    const keep = results.filter(r => r.pf>=MIN_PF && r.trades>=MIN_TRADES).map(r => r.symbol);
    const totalPnl = results.filter(r=>keep.includes(r.symbol)).reduce((s,r)=>s+r.pnl,0);

    // 更新 rules 檔的 watchlist
    const file = RULES_FILES[key];
    const rules = existsSync(file) ? JSON.parse(readFileSync(file,"utf8")) : {};
    const prev  = (rules.watchlist||[]).length;
    rules.watchlist = keep;
    writeFileSync(file, JSON.stringify(rules, null, 2));

    // 儲存每幣 PF 供動態倉位使用
    const pfData = existsSync(PF_FILE) ? JSON.parse(readFileSync(PF_FILE,"utf8")) : {};
    pfData[key] = {};
    results.forEach(r => { pfData[key][r.symbol] = r.pf; });
    writeFileSync(PF_FILE, JSON.stringify(pfData, null, 2));

    summary[key] = { keep:keep.length, prev, totalPnl:totalPnl.toFixed(0), top5:results.slice(0,5).map(r=>`${r.symbol}($${r.pnl.toFixed(0)})`).join(" ") };
    console.log(`\n  ✅ 策略${key}: ${prev} → ${keep.length} 幣 | 預期損益 $${totalPnl.toFixed(0)}`);
  }

  console.log("\n\n" + "═".repeat(60));
  console.log("  優化結果總覽");
  console.log("═".repeat(60));
  for (const [k,v] of Object.entries(summary)) {
    console.log(`  策略${k}: ${v.prev}→${v.keep}幣 | 預期+$${v.totalPnl} | Top: ${v.top5}`);
  }
  console.log(`\n  檔案更新: ${Object.values(RULES_FILES).join(", ")}`);
  console.log("═".repeat(60));
}

main().catch(console.error);
