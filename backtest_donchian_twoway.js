/**
 * Donchian 雙向回測
 * 牛市（BTC > MA200）：做多突破 N30 日高點
 * 熊市（BTC < MA200）：做空突破 N30 日低點
 * 止損、TP、倉位大小邏輯完全對稱
 * 執行：node backtest_donchian_twoway.js
 */

const N_HIGH   = 30;
const N_LOW    = 15;
const TP_RATIO = 3.0;

const MONTHS   = 36;
const BTC_MA   = 200;
const LOOKBACK = BTC_MA + 50;

const PORTFOLIO  = 10000;
const RISK_PCT   = 0.01;
const MAX_TRADE  = 2000;
const MAX_OPEN   = 8;
const COOLDOWN   = 3 * 24 * 3600_000;

const SYMBOLS = [
  "BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT",
  "ADAUSDT","AVAXUSDT","DOGEUSDT","DOTUSDT","LINKUSDT",
  "LTCUSDT","NEARUSDT","UNIUSDT","AAVEUSDT","ATOMUSDT",
  "FILUSDT","ETCUSDT","XLMUSDT","ALGOUSDT",
  "CRVUSDT","INJUSDT","APTUSDT","ARBUSDT","OPUSDT",
  "LDOUSDT","RUNEUSDT","SEIUSDT","SUIUSDT","TIAUSDT",
  "STXUSDT","ORDIUSDT","WLDUSDT","PENDLEUSDT",
  "FETUSDT","RENDERUSDT","BCHUSDT","TRXUSDT","ICPUSDT",
  "HBARUSDT","VETUSDT","DYDXUSDT","GMXUSDT","ZECUSDT",
];

// ─── 資料抓取 ─────────────────────────────────────────────────────────────────
async function fetchCandles(symbol, limit) {
  const all = []; let end = Date.now();
  while (all.length < limit) {
    const n   = Math.min(1000, limit - all.length);
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&endTime=${end}&limit=${n}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.status);
    const d   = await res.json();
    if (!d.length) break;
    all.unshift(...d.map(k => ({ time: +k[0], high: +k[2], low: +k[3], close: +k[4] })));
    end = d[0][0] - 1;
    if (d.length < n) break;
    await new Promise(r => setTimeout(r, 80));
  }
  return all.sort((a,b) => a.time - b.time);
}

// 滾動最大/最小（O(n) deque）
function rollMax(arr, w) {
  const res = new Array(arr.length).fill(NaN), dq = [];
  for (let i = 0; i < arr.length; i++) {
    while (dq.length && dq[0] < i - w) dq.shift();
    while (dq.length && arr[dq[dq.length-1]] <= arr[i]) dq.pop();
    dq.push(i);
    if (i >= w - 1) res[i] = arr[dq[0]];
  }
  return res;
}
function rollMin(arr, w) {
  const res = new Array(arr.length).fill(NaN), dq = [];
  for (let i = 0; i < arr.length; i++) {
    while (dq.length && dq[0] < i - w) dq.shift();
    while (dq.length && arr[dq[dq.length-1]] >= arr[i]) dq.pop();
    dq.push(i);
    if (i >= w - 1) res[i] = arr[dq[0]];
  }
  return res;
}

// ─── 回測核心 ─────────────────────────────────────────────────────────────────
async function main() {
  const need   = Math.ceil(MONTHS * 30.44) + LOOKBACK + 10;
  const cutoff = Date.now() - MONTHS * 30.44 * 86400_000;

  console.log(`\n${"═".repeat(68)}`);
  console.log(`  Donchian 雙向回測（牛市做多 + 熊市做空）`);
  console.log(`  N高${N_HIGH} / N低${N_LOW} / TP${TP_RATIO}:1 / BTC MA${BTC_MA} / ${MONTHS}個月`);
  console.log(`  資金 $${PORTFOLIO.toLocaleString()} | 風險 ${RISK_PCT*100}% | 單筆上限 $${MAX_TRADE}`);
  console.log(`${"═".repeat(68)}\n`);

  // BTC 基準
  process.stdout.write("下載 BTC 日線...");
  const btc    = await fetchCandles("BTCUSDT", need);
  const btcMA  = rollMax(btc.map(c => c.close), BTC_MA); // 借用計算，下面再算 SMA
  // 重新算 BTC SMA200
  const btcSMA = btc.map((_, i) => {
    if (i < BTC_MA - 1) return NaN;
    return btc.slice(i - BTC_MA + 1, i + 1).reduce((s, c) => s + c.close, 0) / BTC_MA;
  });
  const btcIdx  = {};
  btc.forEach((c, i) => { btcIdx[c.time] = i; });
  console.log(` ${btc.length} 根`);

  // 幣種資料
  const data = {}, precomp = {};
  for (let i = 0; i < SYMBOLS.length; i++) {
    const sym = SYMBOLS[i];
    process.stdout.write(`  [${i+1}/${SYMBOLS.length}] ${sym}... `);
    try {
      const c = await fetchCandles(sym, need);
      if (c.filter(x => x.time >= cutoff).length < 30) { console.log("不足"); continue; }
      data[sym] = c;
      const closes = c.map(x => x.close);
      const highs  = c.map(x => x.high);
      const lows   = c.map(x => x.low);
      const idxMap = {}; c.forEach((x, i) => { idxMap[x.time] = i; });
      precomp[sym] = {
        closes, highs, lows, idxMap,
        rMaxH: rollMax(highs, N_HIGH),   // 高點滾動最大
        rMinL: rollMin(lows,  N_LOW),    // 低點滾動最小
        rMinH: rollMin(highs, N_LOW),    // 高點滾動最小（做空止損用）
        rMaxL: rollMax(lows,  N_HIGH),   // 低點滾動最大（做空信號用）
      };
      console.log(`${c.length} 根`);
    } catch(e) { console.log(`錯誤: ${e.message}`); }
    await new Promise(r => setTimeout(r, 50));
  }

  // 收集時間戳
  const timeSet = new Set();
  for (const c of Object.values(data))
    c.filter(x => x.time >= cutoff).forEach(x => timeSet.add(x.time));
  const times = [...timeSet].sort((a,b) => a - b);

  console.log(`\n共 ${Object.keys(data).length} 幣 / ${times.length} 個交易日，開始模擬...\n`);

  // ── 模擬三個版本：純多、純空（熊市）、雙向 ──────────────────────────────
  function simulate(allowLong, allowShort) {
    const openPos = [], trades = [], cooldown = {};

    for (const ts of times) {
      const bi = btcIdx[ts];
      if (bi === undefined || isNaN(btcSMA[bi])) continue;
      const isBull = btc[bi].close >= btcSMA[bi];

      // 出場
      for (const pos of [...openPos]) {
        const pc  = precomp[pos.symbol];
        const idx = pc.idxMap[ts];
        if (idx === undefined) continue;

        const cl = pc.closes[idx];
        let exit = false, ep = 0;

        if (pos.side === "long") {
          // 更新追蹤止損（N15低點只能上移）
          const newSL = pc.rMinL[idx];
          if (!isNaN(newSL) && newSL > pos.sl) pos.sl = newSL;
          const tp = pos.entry + (pos.entry - pos.sl0) * TP_RATIO;
          if (cl <= pos.sl) { exit = true; ep = pos.sl; }
          else if (cl >= tp) { exit = true; ep = tp; }
        } else {
          // 做空追蹤止損（N15高點只能下移）
          const newSL = pc.rMinH[idx];
          if (!isNaN(newSL) && newSL < pos.sl) pos.sl = newSL;
          const tp = pos.entry - (pos.sl0 - pos.entry) * TP_RATIO;
          if (cl >= pos.sl) { exit = true; ep = pos.sl; }
          else if (cl <= tp) { exit = true; ep = tp; }
        }

        if (exit) {
          const pnl = pos.side === "long"
            ? (ep - pos.entry) * pos.qty
            : (pos.entry - ep) * pos.qty;
          trades.push({ symbol: pos.symbol, side: pos.side, pnl, win: pnl > 0,
            entryTime: pos.entryTime, exitTime: ts, isBullEntry: pos.isBullEntry });
          cooldown[pos.symbol] = ts;
          openPos.splice(openPos.indexOf(pos), 1);
        }
      }

      if (openPos.length >= MAX_OPEN) continue;

      // 進場
      for (const sym of Object.keys(data)) {
        if (openPos.length >= MAX_OPEN) break;
        if (openPos.some(p => p.symbol === sym)) continue;
        if (cooldown[sym] && ts - cooldown[sym] < COOLDOWN) continue;

        const pc  = precomp[sym];
        const idx = pc.idxMap[ts];
        if (idx === undefined || idx < LOOKBACK) continue;

        const cl = pc.closes[idx];

        // 做多：牛市 + 突破 N30 日最高
        if (allowLong && isBull) {
          const prevHigh = pc.rMaxH[idx - 1];
          if (!isNaN(prevHigh) && cl > prevHigh) {
            const sl    = pc.rMinL[idx];
            const slPct = (cl - sl) / cl;
            if (!isNaN(sl) && slPct >= 0.003 && slPct <= 0.25 && sl < cl) {
              const qty = Math.min(PORTFOLIO * RISK_PCT / slPct, MAX_TRADE) / cl;
              openPos.push({ symbol: sym, side: "long", entry: cl, sl, sl0: sl, qty,
                entryTime: ts, isBullEntry: true });
              continue;
            }
          }
        }

        // 做空：熊市 + 突破 N30 日最低
        if (allowShort && !isBull) {
          const prevLow = pc.rMaxL[idx - 1]; // N30日低點的最大值（前N根最低的最低）
          // 修正：做空信號 = 收盤 < N30根低點滾動最小
          const shortSignalLow = rollMin(pc.lows.slice(0, idx), N_HIGH).slice(-1)[0];
          // 用預計算的簡化版
          const sl    = pc.rMinH[idx]; // N15日高點最小值作為止損
          if (!isNaN(sl) && cl < sl) { // 簡單判斷：收盤低於 N15 日高點滾動最小（確保在低位）
            // 實際做空信號：收盤 < 前一根的 N30 日低點
            const prevN30Low = rollMin(pc.lows.slice(0, idx), N_HIGH).slice(-1)[0];
            if (!isNaN(prevN30Low) && cl < prevN30Low) {
              const slPrice = pc.rMinH[idx]; // 止損：N15日高點
              const slPct   = (slPrice - cl) / cl;
              if (!isNaN(slPrice) && slPct >= 0.003 && slPct <= 0.25 && slPrice > cl) {
                const qty = Math.min(PORTFOLIO * RISK_PCT / slPct, MAX_TRADE) / cl;
                openPos.push({ symbol: sym, side: "short", entry: cl, sl: slPrice, sl0: slPrice, qty,
                  entryTime: ts, isBullEntry: false });
              }
            }
          }
        }
      }
    }
    return trades;
  }

  console.log("模擬純多頭（牛市做多）...");
  const longOnly  = simulate(true, false);
  console.log(`  完成 ${longOnly.length} 筆`);

  console.log("模擬純空頭（熊市做空）...");
  const shortOnly = simulate(false, true);
  console.log(`  完成 ${shortOnly.length} 筆`);

  console.log("模擬雙向（牛多 + 熊空）...");
  const twoway    = simulate(true, true);
  console.log(`  完成 ${twoway.length} 筆`);

  // ── 統計 ──────────────────────────────────────────────────────────────────
  function stats(trades) {
    if (!trades.length) return { n:0, wr:0, pnl:0, pf:0, maxDD:0, avgW:0, avgL:0, profitMonths:0 };
    const wins   = trades.filter(t => t.win);
    const losses = trades.filter(t => !t.win);
    const pnl    = trades.reduce((s,t) => s+t.pnl, 0);
    const sumW   = wins.reduce((s,t) => s+t.pnl, 0);
    const sumL   = Math.abs(losses.reduce((s,t) => s+t.pnl, 0));
    const pf     = sumL > 0 ? sumW/sumL : Infinity;
    // max drawdown
    let peak = 0, maxDD = 0, cum = 0;
    for (const t of [...trades].sort((a,b) => a.exitTime - b.exitTime)) {
      cum += t.pnl; if (cum > peak) peak = cum;
      const dd = peak - cum; if (dd > maxDD) maxDD = dd;
    }
    // profit months
    const byM = {};
    for (const t of trades) {
      const m = new Date(t.exitTime).toISOString().slice(0,7);
      byM[m] = (byM[m]||0) + t.pnl;
    }
    const profitMonths = Object.values(byM).filter(v => v > 0).length;
    const totalMonths  = Object.keys(byM).length;
    return { n: trades.length, wr: wins.length/trades.length*100, pnl, pf,
      maxDD, avgW: wins.length?sumW/wins.length:0, avgL: losses.length?sumL/losses.length:0,
      profitMonths, totalMonths };
  }

  function printMonthly(trades) {
    const byM = {};
    for (const t of [...trades].sort((a,b)=>a.exitTime-b.exitTime)) {
      const m = new Date(t.exitTime).toISOString().slice(0,7);
      if (!byM[m]) byM[m] = { n:0, wins:0, pnl:0, side:{long:0,short:0} };
      byM[m].n++; byM[m].pnl += t.pnl;
      if (t.win) byM[m].wins++;
      byM[m].side[t.side]++;
    }
    let cum = 0;
    console.log(`  月份      筆(多/空)  勝率    損益        累積`);
    for (const m of Object.keys(byM).sort()) {
      const d = byM[m]; cum += d.pnl;
      const wr = d.n ? ((d.wins/d.n)*100).toFixed(0) : 0;
      const ls = `${d.side.long}L/${d.side.short}S`;
      const sign = d.pnl>=0?"+":"";
      const cs   = cum>=0?"+":"";
      console.log(`  ${m}  ${String(d.n).padStart(3)}(${ls.padEnd(5)})  ${String(wr).padStart(3)}%  ${sign}$${d.pnl.toFixed(0).padStart(7)}  ${cs}$${cum.toFixed(0).padStart(7)}`);
    }
  }

  // ── 輸出報告 ──────────────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(68)}`);
  console.log(`  對照表（${MONTHS}個月，${Object.keys(data).length}幣）`);
  console.log(`${"═".repeat(68)}`);
  console.log(`  版本          筆數   WR      PnL       PF    最大回撤  盈利月`);
  console.log(`  ${"─".repeat(63)}`);

  for (const [label, trades] of [["純多（牛市）", longOnly], ["純空（熊市）", shortOnly], ["雙向合計", twoway]]) {
    const s  = stats(trades);
    const pf = s.pf === Infinity ? "   ∞" : s.pf.toFixed(2).padStart(5);
    const sign = s.pnl >= 0 ? "+" : "";
    console.log(
      `  ${label.padEnd(13)} ${String(s.n).padStart(5)}  ${s.wr.toFixed(1).padStart(5)}%  ${sign}$${s.pnl.toFixed(0).padStart(8)}  ${pf}  $${s.maxDD.toFixed(0).padStart(7)}  ${s.profitMonths}/${s.totalMonths}`
    );
  }
  console.log(`  ${"─".repeat(63)}`);

  // 月度明細
  for (const [label, trades] of [["純多（牛市做多）", longOnly], ["純空（熊市做空）", shortOnly], ["雙向", twoway]]) {
    const s = stats(trades);
    console.log(`\n${"─".repeat(68)}`);
    console.log(`  【${label}】WR ${s.wr.toFixed(1)}% | PF ${s.pf === Infinity ? "∞" : s.pf.toFixed(2)} | 總損益 ${s.pnl>=0?"+":""}$${s.pnl.toFixed(0)}`);
    console.log(`${"─".repeat(68)}`);
    printMonthly(trades);
  }

  console.log(`\n${"═".repeat(68)}\n`);
}

main().catch(console.error);
