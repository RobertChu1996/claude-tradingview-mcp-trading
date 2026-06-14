/**
 * Donchian Breakout 最終驗證報告
 * 參數：N高30 / N低15 / TP3.0 / Donchian止損 / BTC 200日MA過濾
 * 執行：node backtest_validate.js
 */

// ─── 最佳參數（固定）────────────────────────────────────────────────────────
const N_HIGH   = 30;
const N_LOW    = 15;
const TP_RATIO = 3.0;
const SL_MODE  = "donchian";

const INTERVAL    = "1d";
const MONTHS_FULL = 36;     // 3年總樣本
const BTC_MA_BARS = 200;
const LOOKBACK    = BTC_MA_BARS + 50;
const ATR_PERIOD  = 14;

// 資金模擬
const PORTFOLIO   = 10000;  // $10,000 初始資金（更真實）
const RISK_PCT    = 0.01;   // 每筆冒 1%
const MAX_TRADE   = 2000;   // 單筆上限 $2000
const MAX_OPEN    = 8;
const COOLDOWN_MS = 3 * 24 * 3600 * 1000;

const SYMBOLS = [
  "BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT",
  "ADAUSDT","AVAXUSDT","DOGEUSDT","DOTUSDT","LINKUSDT",
  "LTCUSDT","NEARUSDT","UNIUSDT","AAVEUSDT","ATOMUSDT",
  "FILUSDT","ETCUSDT","XLMUSDT","ALGOUSDT","MATICUSDT",
  "CRVUSDT","INJUSDT","APTUSDT","ARBUSDT","OPUSDT",
  "LDOUSDT","RUNEUSDT","SEIUSDT","SUIUSDT","TIAUSDT",
  "STXUSDT","ORDIUSDT","WLDUSDT","BLURUSDT","PENDLEUSDT",
  "FETUSDT","RENDERUSDT","JUPUSDT","ENAUSDT","ONDOUSDT",
  "EIGENUSDT","BCHUSDT","TRXUSDT","ICPUSDT","HBARUSDT",
  "VETUSDT","SANDUSDT","MANAUSDT","AXSUSDT","GALAUSDT",
  "DYDXUSDT","ENSUSDT","GMXUSDT","SNXUSDT","YFIUSDT",
  "COMPUSDT","SUSHIUSDT","1INCHUSDT","ZECUSDT",
];

// ─── 抓 K 線 ─────────────────────────────────────────────────────────────────
async function fetchCandles(symbol) {
  const need = MONTHS_FULL * 31 + LOOKBACK + 20;
  let all = [], et = Date.now();
  while (all.length < need) {
    const limit = Math.min(1000, need - all.length + 20);
    const url   = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${INTERVAL}&endTime=${et}&limit=${limit}`;
    const res   = await fetch(url);
    if (!res.ok) throw new Error(`${res.status}`);
    const data  = await res.json();
    if (!data.length) break;
    all.unshift(...data.map(k => ({
      time:+k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5]
    })));
    et = data[0][0] - 1;
    if (data.length < limit) break;
  }
  return all;
}

// ─── 預計算指標 ───────────────────────────────────────────────────────────────
function precompute(candles) {
  const n      = candles.length;
  const closes = candles.map(c => c.close);
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);

  // ATR
  const atr = new Float64Array(n).fill(NaN);
  if (n > ATR_PERIOD) {
    let s = 0;
    for (let i = 1; i <= ATR_PERIOD; i++)
      s += Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1]));
    atr[ATR_PERIOD] = s / ATR_PERIOD;
    for (let i = ATR_PERIOD+1; i < n; i++) {
      const tr = Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1]));
      atr[i] = (atr[i-1] * (ATR_PERIOD-1) + tr) / ATR_PERIOD;
    }
  }

  // BTC 200日 SMA
  const maTrend = new Float64Array(n).fill(NaN);
  for (let i = BTC_MA_BARS-1; i < n; i++) {
    let s = 0;
    for (let j = i-BTC_MA_BARS+1; j <= i; j++) s += closes[j];
    maTrend[i] = s / BTC_MA_BARS;
  }

  // Donchian Max/Min（deque 優化）
  const rollMax = {}, rollMin = {};
  for (const p of [N_HIGH, N_LOW]) {
    rollMax[p] = new Float64Array(n).fill(NaN);
    rollMin[p] = new Float64Array(n).fill(NaN);
    const maxDq = [], minDq = [];
    for (let i = 0; i < n; i++) {
      while (maxDq.length && highs[maxDq[maxDq.length-1]] <= highs[i]) maxDq.pop();
      while (minDq.length && lows[minDq[minDq.length-1]] >= lows[i]) minDq.pop();
      maxDq.push(i); minDq.push(i);
      if (maxDq[0] <= i-p) maxDq.shift();
      if (minDq[0] <= i-p) minDq.shift();
      if (i >= p-1) { rollMax[p][i] = highs[maxDq[0]]; rollMin[p][i] = lows[minDq[0]]; }
    }
  }

  return { closes, highs, lows, atr, maTrend, rollMax, rollMin, n };
}

// ─── 回測引擎 ─────────────────────────────────────────────────────────────────
function runBacktest(precomps, idxMap, times, loaded) {
  const openPos = [], trades = [], cooldown = {};
  const btcPc = precomps["BTCUSDT"];
  const btcIdx = idxMap["BTCUSDT"] || {};

  for (const ts of times) {
    // 出場
    for (const pos of [...openPos]) {
      const idx = idxMap[pos.symbol]?.[ts];
      if (idx === undefined) continue;
      const pc = precomps[pos.symbol];
      const hi = pc.highs[idx], lo = pc.lows[idx];

      // Donchian 追蹤止損
      if (idx >= N_LOW && !isNaN(pc.rollMin[N_LOW][idx])) {
        const newSl = pc.rollMin[N_LOW][idx];
        if (newSl > pos.sl) pos.sl = newSl;
      }

      const slHit = lo <= pos.sl;
      const tpHit = hi >= pos.tp;
      if (slHit || tpHit) {
        const ep  = (slHit && tpHit) ? pos.sl : tpHit ? pos.tp : pos.sl;
        const pnl = (ep - pos.entry) * pos.qty;
        trades.push({
          symbol:    pos.symbol,
          side:      "long",
          entry:     pos.entry,
          exit:      ep,
          pnl,
          win:       pnl > 0,
          hitTp:     tpHit && !slHit,
          entryTime: pos.entryTime,
          exitTime:  ts,
          holdDays:  Math.round((ts - pos.entryTime) / 86400000),
        });
        cooldown[pos.symbol] = ts;
        openPos.splice(openPos.indexOf(pos), 1);
      }
    }

    if (openPos.length >= MAX_OPEN) continue;

    // BTC 趨勢過濾
    const bi = btcIdx[ts];
    if (bi === undefined || isNaN(btcPc?.maTrend?.[bi])) continue;
    const isBull = btcPc.closes[bi] >= btcPc.maTrend[bi];
    if (!isBull) continue;

    // 進場
    for (const symbol of loaded) {
      if (openPos.length >= MAX_OPEN) break;
      if (openPos.some(p => p.symbol === symbol)) continue;
      if (cooldown[symbol] && ts - cooldown[symbol] < COOLDOWN_MS) continue;

      const idx = idxMap[symbol]?.[ts];
      if (idx === undefined || idx < LOOKBACK) continue;

      const pc = precomps[symbol];
      if (isNaN(pc.rollMax[N_HIGH]?.[idx-1])) continue;
      if (isNaN(pc.rollMin[N_LOW]?.[idx])) continue;
      if (isNaN(pc.atr[idx])) continue;

      const prevHigh = pc.rollMax[N_HIGH][idx-1];
      const cl       = pc.closes[idx];
      if (cl <= prevHigh) continue;

      const sl    = pc.rollMin[N_LOW][idx];
      const slPct = (cl - sl) / cl;
      if (slPct <= 0.003 || slPct > 0.25) continue;

      const tp   = cl + (cl - sl) * TP_RATIO;
      const risk = PORTFOLIO * RISK_PCT;
      const qty  = Math.min(risk / slPct, MAX_TRADE) / cl;
      openPos.push({ symbol, entry: cl, sl, tp, qty, entryTime: ts });
    }
  }
  return trades;
}

// ─── 分析工具 ─────────────────────────────────────────────────────────────────
function calcDrawdown(trades) {
  let peak = 0, maxDD = 0, cumPnl = 0;
  const sorted = [...trades].sort((a,b) => a.exitTime - b.exitTime);
  for (const t of sorted) {
    cumPnl += t.pnl;
    if (cumPnl > peak) peak = cumPnl;
    const dd = peak - cumPnl;
    if (dd > maxDD) maxDD = dd;
  }
  return { maxDD, finalPnl: cumPnl };
}

function maxConsecLoss(trades) {
  const sorted = [...trades].sort((a,b) => a.exitTime - b.exitTime);
  let max = 0, cur = 0;
  for (const t of sorted) {
    if (!t.win) { cur++; if (cur > max) max = cur; }
    else cur = 0;
  }
  return max;
}

function byMonth(trades) {
  const map = {};
  for (const t of trades) {
    const m = new Date(t.exitTime).toISOString().slice(0,7);
    if (!map[m]) map[m] = { wins:0, losses:0, pnl:0, n:0 };
    map[m].pnl += t.pnl; map[m].n++;
    t.win ? map[m].wins++ : map[m].losses++;
  }
  return map;
}

function bySymbol(trades) {
  const map = {};
  for (const t of trades) {
    if (!map[t.symbol]) map[t.symbol] = { wins:0, losses:0, pnl:0, n:0 };
    map[t.symbol].pnl += t.pnl; map[t.symbol].n++;
    t.win ? map[t.symbol].wins++ : map[t.symbol].losses++;
  }
  return map;
}

function pf(trades) {
  const gross = trades.filter(t=>t.win).reduce((s,t)=>s+t.pnl,0);
  const loss  = Math.abs(trades.filter(t=>!t.win).reduce((s,t)=>s+t.pnl,0));
  return loss > 0 ? gross/loss : Infinity;
}

function bar(val, max, width=20) {
  const filled = Math.round((val/max)*width);
  return "█".repeat(Math.max(0,filled)) + "░".repeat(Math.max(0,width-filled));
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`  Donchian Breakout 最終驗證報告`);
  console.log(`  策略：突破N${N_HIGH}日最高 | 止損：N${N_LOW}日最低 | TP：${TP_RATIO}:1 | 只做多`);
  console.log(`  BTC過濾：收盤 > 200日均線 | 冷卻：3天 | 資金：$${PORTFOLIO.toLocaleString()}`);
  console.log(`${"═".repeat(70)}\n`);

  // 抓資料
  process.stdout.write("下載資料");
  const rawData = {};
  for (let i = 0; i < SYMBOLS.length; i++) {
    const sym = SYMBOLS[i];
    try {
      const c = await fetchCandles(sym);
      if (c.length >= LOOKBACK + 100) rawData[sym] = c;
    } catch(e) {}
    process.stdout.write(".");
    if ((i+1) % 20 === 0) await new Promise(r => setTimeout(r, 500));
  }
  const loaded = Object.keys(rawData);
  console.log(` ${loaded.length}幣 OK\n`);

  // 建索引
  const cutoff   = Date.now() - MONTHS_FULL * 30 * 24 * 3600 * 1000;
  const allTs    = new Set();
  for (const c of Object.values(rawData)) c.forEach(x => { if (x.time >= cutoff) allTs.add(x.time); });
  const times    = [...allTs].sort((a,b) => a-b);
  const idxMap   = {};
  for (const [sym,c] of Object.entries(rawData)) {
    idxMap[sym] = {};
    for (let i=0;i<c.length;i++) idxMap[sym][c[i].time] = i;
  }

  // 預計算
  const precomps = {};
  for (const [sym,c] of Object.entries(rawData)) precomps[sym] = precompute(c);

  // 全樣本回測
  const allTrades = runBacktest(precomps, idxMap, times, loaded);

  // 切分：In-Sample (前2年) vs Out-of-Sample (最後1年)
  const splitTs   = Date.now() - 12 * 30 * 24 * 3600 * 1000;
  const inSample  = allTrades.filter(t => t.exitTime < splitTs);
  const outSample = allTrades.filter(t => t.exitTime >= splitTs);

  // BTC 牛熊分期
  const btcPc = precomps["BTCUSDT"];
  const btcC  = rawData["BTCUSDT"];
  const tradesBull = allTrades.filter(t => {
    const bi = idxMap["BTCUSDT"]?.[t.entryTime];
    return bi !== undefined && !isNaN(btcPc.maTrend[bi]) && btcC[bi].close >= btcPc.maTrend[bi];
  });

  // ─── 報告區塊 ─────────────────────────────────────────────────────────────

  // 1. 整體摘要
  const wins   = allTrades.filter(t=>t.win);
  const losses = allTrades.filter(t=>!t.win);
  const gross  = wins.reduce((s,t)=>s+t.pnl,0);
  const lossAmt= Math.abs(losses.reduce((s,t)=>s+t.pnl,0));
  const totPnl = gross - lossAmt;
  const pfAll  = pf(allTrades);
  const { maxDD } = calcDrawdown(allTrades);
  const avgHold= allTrades.length ? (allTrades.reduce((s,t)=>s+t.holdDays,0)/allTrades.length).toFixed(1) : 0;
  const tpHits = allTrades.filter(t=>t.hitTp).length;

  console.log(`【1】整體績效（${MONTHS_FULL}個月，${loaded.length}幣）`);
  console.log(`${"─".repeat(70)}`);
  console.log(`  總交易筆數   : ${allTrades.length} 筆（月均 ${(allTrades.length/MONTHS_FULL).toFixed(1)} 筆）`);
  console.log(`  勝率         : ${((wins.length/allTrades.length)*100).toFixed(1)}%（${wins.length}勝 / ${losses.length}敗）`);
  console.log(`  獲利因子(PF) : ${pfAll.toFixed(2)}`);
  console.log(`  總損益       : +$${totPnl.toFixed(2)}（初始資金 $${PORTFOLIO.toLocaleString()}）`);
  console.log(`  年化報酬率   : ${((totPnl/PORTFOLIO/3)*100).toFixed(1)}%`);
  console.log(`  最大回撤     : -$${maxDD.toFixed(2)}（${((maxDD/PORTFOLIO)*100).toFixed(1)}%）`);
  console.log(`  最大連虧筆數 : ${maxConsecLoss(allTrades)} 筆`);
  console.log(`  平均持倉天數 : ${avgHold} 天`);
  console.log(`  止盈達成率   : ${((tpHits/allTrades.length)*100).toFixed(1)}%（${tpHits}/${allTrades.length}）`);
  console.log(`  平均獲利     : +$${(gross/(wins.length||1)).toFixed(2)}`);
  console.log(`  平均虧損     : -$${(lossAmt/(losses.length||1)).toFixed(2)}`);
  console.log(`  風報比(R:R)  : ${((gross/(wins.length||1))/(lossAmt/(losses.length||1))).toFixed(2)}:1`);

  // 2. In-Sample vs Out-of-Sample
  console.log(`\n【2】樣本內 vs 樣本外驗證`);
  console.log(`${"─".repeat(70)}`);
  const fmtPeriod = (ts) => new Date(ts).toISOString().slice(0,10);
  console.log(`  ┌─────────────────────┬──────┬──────┬────────┬──────────┐`);
  console.log(`  │ 期間                │ 筆數 │ 勝率 │   PF   │   損益   │`);
  console.log(`  ├─────────────────────┼──────┼──────┼────────┼──────────┤`);

  for (const [label, set] of [["樣本內（前2年）", inSample], ["樣本外（近1年）", outSample]]) {
    if (!set.length) { console.log(`  │ ${label.padEnd(20)}│  無  │  無  │   無   │    無    │`); continue; }
    const w = set.filter(t=>t.win).length;
    const p = pf(set);
    const pnlStr = `$${set.reduce((s,t)=>s+t.pnl,0).toFixed(0)}`.padStart(8);
    console.log(
      `  │ ${label.padEnd(20)}│ ${String(set.length).padStart(4)} │` +
      ` ${((w/set.length)*100).toFixed(0)}% │` +
      ` ${p.toFixed(2).padStart(6)} │${pnlStr}  │`
    );
  }
  console.log(`  └─────────────────────┴──────┴──────┴────────┴──────────┘`);

  const pfIn  = pf(inSample);
  const pfOut = pf(outSample);
  const degradation = pfIn > 0 ? ((pfIn - pfOut) / pfIn * 100).toFixed(1) : "—";
  console.log(`  PF 退化幅度：${degradation}%（樣本內 ${pfIn.toFixed(2)} → 樣本外 ${pfOut.toFixed(2)}）`);
  if (pfOut >= 1.2) console.log(`  ✅ 樣本外 PF ≥ 1.2，策略未過度擬合`);
  else if (pfOut >= 1.0) console.log(`  ⚠️  樣本外 PF 1.0~1.2，輕微退化，仍有正期望值`);
  else console.log(`  ❌ 樣本外 PF < 1.0，策略可能過度擬合`);

  // 3. 月度損益
  console.log(`\n【3】月度損益（全樣本）`);
  console.log(`${"─".repeat(70)}`);
  const monthly = byMonth(allTrades);
  let cumPnl = 0;
  const monthPnls = Object.values(monthly).map(m => m.pnl);
  const maxAbsPnl = Math.max(...monthPnls.map(Math.abs), 1);
  let profMonths = 0, lossMonths = 0;

  console.log(`  月份      筆  勝率   月損益      累積        圖示`);
  console.log(`  ${"─".repeat(62)}`);
  for (const [m, s] of Object.entries(monthly).sort()) {
    cumPnl += s.pnl;
    const wr  = s.n ? ((s.wins/s.n)*100).toFixed(0)+"%" : "—";
    const sign = s.pnl >= 0 ? "+" : "";
    const barStr = s.pnl >= 0
      ? "▓".repeat(Math.round((s.pnl/maxAbsPnl)*15))
      : "░".repeat(Math.round((-s.pnl/maxAbsPnl)*15));
    console.log(
      `  ${m}  ${String(s.n).padStart(3)}  ${wr.padStart(4)}  ` +
      `${sign}${s.pnl.toFixed(0).padStart(7)}  ` +
      `${cumPnl>=0?"+":""}${cumPnl.toFixed(0).padStart(8)}  ${s.pnl>=0?"🟢":"🔴"}${barStr}`
    );
    s.pnl >= 0 ? profMonths++ : lossMonths++;
  }
  console.log(`  ${"─".repeat(62)}`);
  console.log(`  獲利月份：${profMonths} 個月 / 虧損月份：${lossMonths} 個月（獲利月比例 ${((profMonths/(profMonths+lossMonths))*100).toFixed(0)}%）`);

  // 4. 盈虧分佈
  console.log(`\n【4】單筆損益分佈`);
  console.log(`${"─".repeat(70)}`);
  const pnlBuckets = { "大賺(>2R)":0, "小賺(0~2R)":0, "小虧(0~1R)":0, "大虧(>1R)":0 };
  const avgRisk = allTrades.length
    ? allTrades.reduce((s,t) => s + Math.abs(t.entry - (t.exit < t.entry ? t.exit : 0)), 0) / allTrades.length
    : 1;
  for (const t of allTrades) {
    const rMultiple = t.pnl / (PORTFOLIO * RISK_PCT);
    if (rMultiple > 2)       pnlBuckets["大賺(>2R)"]++;
    else if (rMultiple > 0)  pnlBuckets["小賺(0~2R)"]++;
    else if (rMultiple > -1) pnlBuckets["小虧(0~1R)"]++;
    else                     pnlBuckets["大虧(>1R)"]++;
  }
  const maxBucket = Math.max(...Object.values(pnlBuckets));
  for (const [label, count] of Object.entries(pnlBuckets)) {
    const pct = allTrades.length ? ((count/allTrades.length)*100).toFixed(0) : 0;
    console.log(`  ${label.padEnd(12)} ${String(count).padStart(3)}筆 (${String(pct).padStart(2)}%)  ${bar(count, maxBucket, 25)}`);
  }

  // 5. 幣種分析
  console.log(`\n【5】幣種績效（前10名 vs 後5名）`);
  console.log(`${"─".repeat(70)}`);
  const symStats = bySymbol(allTrades);
  const symArr   = Object.entries(symStats)
    .map(([sym, s]) => ({
      sym, ...s,
      wr: s.n ? ((s.wins/s.n)*100).toFixed(0)+"%" : "—",
      pfSym: s.losses > 0 ? (s.wins*1/(s.losses||1)).toFixed(2) : "—",
    }))
    .sort((a,b) => b.pnl - a.pnl);

  console.log(`  幣種           筆  勝率    損益      排名`);
  console.log(`  ${"─".repeat(50)}`);
  for (const r of symArr.slice(0,10)) {
    console.log(`  ${r.sym.padEnd(14)} ${String(r.n).padStart(3)}  ${r.wr.padStart(4)}  ${(r.pnl>=0?"+":"")+(r.pnl.toFixed(0)).padStart(7)}  ✅`);
  }
  console.log(`  ...`);
  for (const r of symArr.slice(-5)) {
    console.log(`  ${r.sym.padEnd(14)} ${String(r.n).padStart(3)}  ${r.wr.padStart(4)}  ${(r.pnl>=0?"+":"")+(r.pnl.toFixed(0)).padStart(7)}  ⚠️`);
  }

  // 6. 牛熊市分析
  console.log(`\n【6】市場環境分析（BTC 200日均線）`);
  console.log(`${"─".repeat(70)}`);
  // 所有進場都是在牛市（BTC > 200MA）
  console.log(`  本策略100%在 BTC > 200日均線期間進場（篩選條件）`);
  const btcData = rawData["BTCUSDT"] || [];
  let bullDays = 0, bearDays = 0;
  for (const c of btcData) {
    const idx = idxMap["BTCUSDT"]?.[c.time];
    if (idx === undefined) continue;
    if (c.time < cutoff) continue;
    const ma = btcPc.maTrend[idx];
    if (isNaN(ma)) continue;
    c.close >= ma ? bullDays++ : bearDays++;
  }
  const totalDays = bullDays + bearDays;
  console.log(`  過去3年：牛市 ${bullDays}天(${((bullDays/totalDays)*100).toFixed(0)}%) / 熊市 ${bearDays}天(${((bearDays/totalDays)*100).toFixed(0)}%)`);
  console.log(`  策略只在牛市做多，熊市 0 開倉 → 有效避開大跌段`);

  // 7. 風險評估
  console.log(`\n【7】風險評估`);
  console.log(`${"─".repeat(70)}`);
  const maxDDPct = (maxDD/PORTFOLIO)*100;
  const calmarRatio = maxDD > 0 ? ((totPnl/PORTFOLIO/3*100) / maxDDPct).toFixed(2) : "∞";
  const expectancy  = allTrades.length ? (totPnl / allTrades.length).toFixed(2) : 0;

  console.log(`  最大回撤         : -$${maxDD.toFixed(0)} (${maxDDPct.toFixed(1)}%)`);
  if (maxDDPct < 15) console.log(`    → ✅ 回撤 < 15%，風險可控`);
  else if (maxDDPct < 30) console.log(`    → ⚠️  回撤 15~30%，尚可接受`);
  else console.log(`    → ❌ 回撤 > 30%，需降低倉位`);

  console.log(`  Calmar Ratio     : ${calmarRatio}（年化報酬 / 最大回撤%）`);
  if (+calmarRatio > 1) console.log(`    → ✅ Calmar > 1，報酬風險比良好`);
  else console.log(`    → ⚠️  Calmar < 1，報酬補償不足`);

  console.log(`  每筆期望值       : +$${expectancy}（${((+expectancy/PORTFOLIO)*100*100).toFixed(2)}% 資金）`);
  console.log(`  最大連虧         : ${maxConsecLoss(allTrades)} 筆（估計最大虧損 $${(maxConsecLoss(allTrades) * PORTFOLIO * RISK_PCT).toFixed(0)}）`);

  // 8. 最終結論
  const pfScore    = pfAll >= 1.8 ? 3 : pfAll >= 1.4 ? 2 : pfAll >= 1.0 ? 1 : 0;
  const ddScore    = maxDDPct <= 15 ? 3 : maxDDPct <= 25 ? 2 : maxDDPct <= 35 ? 1 : 0;
  const ooScore    = pfOut >= 1.4 ? 3 : pfOut >= 1.1 ? 2 : pfOut >= 1.0 ? 1 : 0;
  const freqScore  = allTrades.length/MONTHS_FULL >= 4 ? 3 : allTrades.length/MONTHS_FULL >= 2 ? 2 : 1;
  const totalScore = pfScore + ddScore + ooScore + freqScore;

  console.log(`\n【8】最終結論`);
  console.log(`${"═".repeat(70)}`);
  console.log(`  評分項目（各3分滿分）：`);
  console.log(`    獲利因子 PF   : ${"★".repeat(pfScore)}${"☆".repeat(3-pfScore)} (${pfAll.toFixed(2)})`);
  console.log(`    最大回撤      : ${"★".repeat(ddScore)}${"☆".repeat(3-ddScore)} (${maxDDPct.toFixed(1)}%)`);
  console.log(`    樣本外穩健度  : ${"★".repeat(ooScore)}${"☆".repeat(3-ooScore)} (PF ${pfOut.toFixed(2)})`);
  console.log(`    信號頻率      : ${"★".repeat(freqScore)}${"☆".repeat(3-freqScore)} (月均 ${(allTrades.length/MONTHS_FULL).toFixed(1)}筆)`);
  console.log(`  ${"─".repeat(40)}`);
  console.log(`  總分：${totalScore}/12`);

  if (totalScore >= 10) {
    console.log(`\n  ✅✅ 建議上線 — 策略各項指標均優秀`);
  } else if (totalScore >= 7) {
    console.log(`\n  ✅  建議上線 — 策略整體穩健，有正期望值`);
  } else if (totalScore >= 5) {
    console.log(`\n  ⚠️  謹慎上線 — 建議先小倉位測試（RISK 0.5%）`);
  } else {
    console.log(`\n  ❌  不建議上線 — 需要重新優化策略`);
  }

  console.log(`\n  策略摘要：`);
  console.log(`    • 日線突破N30最高，BTC站200均線才進場`);
  console.log(`    • 止損：N15日最低（動態追蹤）`);
  console.log(`    • 止盈：入場風險 × 3.0`);
  console.log(`    • 59幣輪動，每月約 ${(allTrades.length/MONTHS_FULL).toFixed(1)} 筆`);
  console.log(`    • 3年 PF ${pfAll.toFixed(2)}，年化 ${((totPnl/PORTFOLIO/3)*100).toFixed(1)}%，最大回撤 ${maxDDPct.toFixed(1)}%`);
  console.log(`${"═".repeat(70)}\n`);
}

main().catch(console.error);
