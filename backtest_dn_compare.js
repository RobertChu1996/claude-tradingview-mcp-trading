/**
 * Donchian 新舊版本正式對比回測
 * 原版：1D N30/N15（日線，每日一次）
 * 新版：4H N180/N90（4H等效日線，每15分鐘一次）
 * 36個月，43幣，雙向（牛多/熊空）
 */

const MONTHS    = 36;
const PORTFOLIO = 10000;
const RISK_PCT  = 0.01;
const MAX_TRADE = 2000;
const TP_RATIO  = 3.0;
const COOLDOWN  = 3 * 24 * 3600 * 1000;
const BTC_MA    = 200;

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

const VERSIONS = [
  { name: "原版 1D N30/15 ", tf: "1d", nH: 30,  nL: 15  },
  { name: "新版 4H N180/90", tf: "4h", nH: 180, nL: 90  },
];

// ─── 資料下載（分頁支援）──────────────────────────────────────────────────────
async function fetchKlines(symbol, interval, totalBars) {
  const PER = 1000;
  const all = [];
  let endTime = Date.now();
  while (all.length < totalBars) {
    const need = Math.min(PER, totalBars - all.length);
    const url  = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${need}&endTime=${endTime}`;
    const res  = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    if (!raw.length) break;
    all.unshift(...raw.map(k => ({ t: +k[0], h: +k[2], l: +k[3], c: +k[4] })));
    endTime = raw[0][0] - 1;
    if (raw.length < need) break;
    await new Promise(r => setTimeout(r, 60));
  }
  return all;
}

// BTC MA200 日期地圖
async function buildBtcMap(days) {
  process.stdout.write("  BTC日線...");
  const bars = await fetchKlines("BTCUSDT", "1d", BTC_MA + days + 10);
  const map  = {};
  for (let i = BTC_MA; i < bars.length; i++) {
    const ma  = bars.slice(i - BTC_MA, i).reduce((s, b) => s + b.c, 0) / BTC_MA;
    map[new Date(bars[i].t).toISOString().slice(0, 10)] = bars[i].c >= ma;
  }
  console.log(` ${Object.keys(map).length} 天`);
  return map;
}

function toDate(ts) { return new Date(ts).toISOString().slice(0, 10); }
function rollH(arr, n) { return Math.max(...arr.slice(-n)); }
function rollL(arr, n) { return Math.min(...arr.slice(-n)); }

// ─── 核心回測 ────────────────────────────────────────────────────────────────
function simulate(allBars, btcMap, nH, nL, tf) {
  const startMs = Date.now() - MONTHS * 30 * 86400000;
  const h4ms    = 4 * 3600 * 1000;

  // 決定「已完成 K 棒」的截止時間戳
  const completedBefore = tf === "1d"
    ? new Date().setUTCHours(0, 0, 0, 0)
    : Math.floor(Date.now() / h4ms) * h4ms;

  const needed = nH + nL;
  let equity = PORTFOLIO, maxEq = PORTFOLIO, maxDD = 0;
  let wins = 0, losses = 0, grossW = 0, grossL = 0;
  const monthly = {};
  const symStats = {};
  const trades = [];
  const cooldown = {};
  const openGlobal = [];  // 跨幣全局持倉上限

  for (const [sym, bars] of Object.entries(allBars)) {
    const completed = bars.filter(b => b.t < completedBefore);
    symStats[sym] = { trades: 0, wins: 0, pnl: 0 };
    const openSym = [];

    for (let i = needed; i < completed.length; i++) {
      const bar = completed[i];
      if (bar.t < startMs) continue;

      const dateStr = toDate(bar.t);
      const isBull  = btcMap[dateStr] ?? true;

      // 出場
      for (let pi = openSym.length - 1; pi >= 0; pi--) {
        const pos = openSym[pi];
        let exitPx = null, reason = null;

        if (pos.side === "long") {
          const newSL = rollL(completed.slice(Math.max(0, i - nL), i + 1).map(b => b.l), nL);
          if (newSL > pos.sl) pos.sl = newSL;
          if (bar.l <= pos.sl) { exitPx = pos.sl; reason = "SL"; }
          else if (bar.h >= pos.tp) { exitPx = pos.tp; reason = "TP"; }
        } else {
          const newSL = rollH(completed.slice(Math.max(0, i - nL), i + 1).map(b => b.h), nL);
          if (newSL < pos.sl) pos.sl = newSL;
          if (bar.h >= pos.sl) { exitPx = pos.sl; reason = "SL"; }
          else if (bar.l <= pos.tp) { exitPx = pos.tp; reason = "TP"; }
        }

        if (exitPx !== null) {
          const sign = pos.side === "long" ? 1 : -1;
          const pnl  = sign * (exitPx - pos.entry) * pos.qty;
          equity += pnl;
          maxEq   = Math.max(maxEq, equity);
          maxDD   = Math.max(maxDD, maxEq - equity);
          if (pnl > 0) { wins++; grossW += pnl; } else { losses++; grossL += Math.abs(pnl); }
          const mon = dateStr.slice(0, 7);
          monthly[mon] = (monthly[mon] || 0) + pnl;
          symStats[sym].trades++;
          symStats[sym].pnl += pnl;
          if (pnl > 0) symStats[sym].wins++;
          trades.push({ sym, side: pos.side, pnl, reason });
          cooldown[sym] = bar.t;
          openSym.splice(pi, 1);
          openGlobal.splice(openGlobal.indexOf(pos), 1);
        }
      }

      // 進場
      if (cooldown[sym] && bar.t - cooldown[sym] < COOLDOWN) continue;
      if (openGlobal.length >= 8) continue;
      if (openSym.some(p => p.sym === sym)) continue;

      const prev = completed.slice(i - nH, i);
      const win  = completed.slice(i - nL, i + 1);
      let sig = null;

      if (isBull) {
        const pH = rollH(prev.map(b => b.h), nH);
        if (bar.c > pH) {
          const sl = rollL(win.map(b => b.l), nL);
          const sp = (bar.c - sl) / bar.c;
          if (sl < bar.c && sp >= 0.003 && sp <= 0.25)
            sig = { side: "long", entry: bar.c, sl, tp: bar.c + (bar.c - sl) * TP_RATIO, qty: Math.min(PORTFOLIO * RISK_PCT / sp, MAX_TRADE) / bar.c };
        }
      } else {
        const pL = rollL(prev.map(b => b.l), nH);
        if (bar.c < pL) {
          const sl = rollH(win.map(b => b.h), nL);
          const sp = (sl - bar.c) / bar.c;
          const tp = bar.c - (sl - bar.c) * TP_RATIO;
          if (sl > bar.c && sp >= 0.003 && sp <= 0.25 && tp > 0)
            sig = { side: "short", entry: bar.c, sl, tp, qty: Math.min(PORTFOLIO * RISK_PCT / sp, MAX_TRADE) / bar.c };
        }
      }

      if (sig) {
        const pos = { sym, ...sig };
        openSym.push(pos);
        openGlobal.push(pos);
      }
    }
  }

  const total = wins + losses;
  const pf    = grossL > 0 ? grossW / grossL : (grossW > 0 ? Infinity : 0);
  return { equity, maxDD, wins, losses, total, pf, grossW, grossL, monthly, symStats, trades };
}

// ─── 報告格式 ─────────────────────────────────────────────────────────────────
function printReport(name, r) {
  const pnl    = r.equity - PORTFOLIO;
  const wr     = r.total > 0 ? (r.wins / r.total * 100).toFixed(1) : "0";
  const pf     = r.pf === Infinity ? "∞" : r.pf.toFixed(2);
  const annRet = ((r.equity / PORTFOLIO) ** (1 / (MONTHS / 12)) - 1) * 100;
  const calmar = r.maxDD > 0 ? (annRet / (r.maxDD / PORTFOLIO * 100)) : 0;
  const mons   = Object.values(r.monthly);
  const profMon = mons.filter(v => v > 0).length;
  const totMon  = mons.length;
  const avgWin  = r.wins  > 0 ? r.grossW / r.wins  : 0;
  const avgLoss = r.losses > 0 ? r.grossL / r.losses : 0;
  const tpHits  = r.trades.filter(t => t.reason === "TP").length;

  const line = "─".repeat(68);
  console.log(`\n${"═".repeat(68)}`);
  console.log(`  ${name}`);
  console.log(`${"═".repeat(68)}`);
  console.log(`  總交易筆數   : ${r.total} 筆`);
  console.log(`  勝率         : ${wr}%（${r.wins}勝/${r.losses}敗）`);
  console.log(`  獲利因子(PF) : ${pf}`);
  console.log(`  總損益       : ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}（初始 $${PORTFOLIO}）`);
  console.log(`  年化報酬率   : ${annRet >= 0 ? "+" : ""}${annRet.toFixed(1)}%`);
  console.log(`  最大回撤     : -$${r.maxDD.toFixed(2)}（${(r.maxDD/PORTFOLIO*100).toFixed(1)}%）`);
  console.log(`  Calmar Ratio : ${calmar.toFixed(2)}`);
  console.log(`  止盈達成率   : ${tpHits}/${r.total}（${(tpHits/r.total*100).toFixed(1)}%）`);
  console.log(`  平均獲利     : +$${avgWin.toFixed(2)}`);
  console.log(`  平均虧損     : -$${avgLoss.toFixed(2)}`);
  console.log(`  風報比(R:R)  : ${avgLoss > 0 ? (avgWin/avgLoss).toFixed(2) : "∞"}:1`);

  console.log(`\n  月度損益（${totMon} 個月，獲利 ${profMon} 個月）`);
  console.log("  " + line);
  let cum = 0;
  for (const [mon, pnl] of Object.entries(r.monthly).sort()) {
    cum += pnl;
    const bar = pnl >= 0
      ? "🟢" + "▓".repeat(Math.min(12, Math.round(Math.abs(pnl)/120)))
      : "🔴" + "░".repeat(Math.min(12, Math.round(Math.abs(pnl)/120)));
    console.log(`  ${mon}  ${(pnl>=0?"+":"") + "$"+Math.abs(pnl).toFixed(0).padStart(6)}  累積 ${(cum>=0?"+":"")+"$"+cum.toFixed(0).padStart(7)}  ${bar}`);
  }

  // 幣種前5/後5
  const ranked = Object.entries(r.symStats)
    .filter(([,s]) => s.trades > 0)
    .sort(([,a],[,b]) => b.pnl - a.pnl);
  console.log(`\n  幣種績效（前5 / 後5）`);
  console.log("  " + line);
  const show = [...ranked.slice(0, 5), null, ...ranked.slice(-5)];
  for (const item of show) {
    if (!item) { console.log("  ..."); continue; }
    const [sym, s] = item;
    const wr = s.trades > 0 ? (s.wins/s.trades*100).toFixed(0) : "0";
    const mark = s.pnl >= 0 ? "✅" : "⚠️";
    console.log(`  ${sym.padEnd(12)} ${String(s.trades).padStart(2)}筆  WR${wr.padStart(3)}%  ${(s.pnl>=0?"+":"")+"$"+s.pnl.toFixed(0).padStart(6)}  ${mark}`);
  }
  console.log(`${"═".repeat(68)}`);
}

// ─── 主流程 ───────────────────────────────────────────────────────────────────
async function main() {
  console.log("\n════════════════════════════════════════════════════════════════════");
  console.log("  Donchian 新舊版對比回測（36個月，43幣，雙向）");
  console.log("════════════════════════════════════════════════════════════════════\n");

  const totalDays = MONTHS * 31 + 10;
  const btcMap    = await buildBtcMap(totalDays);

  // 每種 tf 只下載一次
  const tfSet   = [...new Set(VERSIONS.map(v => v.tf))];
  const cache   = {};

  console.log("\n下載 K 線資料...");
  for (const tf of tfSet) {
    const bpd      = tf === "1d" ? 1 : 6;
    const totalBars = totalDays * bpd + 800;
    for (let i = 0; i < SYMBOLS.length; i++) {
      const sym = SYMBOLS[i];
      process.stdout.write(`\r  [${tf}] ${i+1}/${SYMBOLS.length} ${sym}          `);
      try { cache[`${sym}_${tf}`] = await fetchKlines(sym, tf, totalBars); }
      catch(e) { cache[`${sym}_${tf}`] = []; }
      await new Promise(r => setTimeout(r, 80));
    }
    console.log();
  }

  // 對比表
  console.log("\n  ┌──────────────────┬──────┬──────┬──────┬──────────┬──────────┬──────────┬──────────┐");
  console.log("  │ 版本             │ 筆數 │ 勝率 │  PF  │  總損益  │   年化   │ 最大回撤 │ Calmar  │");
  console.log("  ├──────────────────┼──────┼──────┼──────┼──────────┼──────────┼──────────┼──────────┤");

  const allResults = [];
  for (const ver of VERSIONS) {
    const allBars = {};
    for (const sym of SYMBOLS) {
      const k = `${sym}_${ver.tf}`;
      if (cache[k]?.length) allBars[sym] = cache[k];
    }
    process.stdout.write(`\n  模擬 ${ver.name}...`);
    const r   = simulate(allBars, btcMap, ver.nH, ver.nL, ver.tf);
    const pnl = r.equity - PORTFOLIO;
    const wr  = r.total > 0 ? (r.wins/r.total*100).toFixed(1) : "0";
    const pf  = r.pf === Infinity ? "∞" : r.pf.toFixed(2);
    const ann = ((r.equity/PORTFOLIO)**(1/(MONTHS/12))-1)*100;
    const cal = r.maxDD > 0 ? (ann/(r.maxDD/PORTFOLIO*100)).toFixed(2) : "∞";
    console.log(` done (${r.total}筆)`);
    allResults.push({ ver, r, pnl, wr, pf, ann, cal });

    console.log(
      `  │ ${ver.name.padEnd(16)} │ ${String(r.total).padStart(4)} │${wr.padStart(5)}%│ ${pf.padStart(4)} │` +
      ` ${(pnl>=0?"+":"")+"$"+(Math.abs(pnl).toFixed(0)).padStart(7)} │` +
      ` ${(ann>=0?"+":"")+(ann.toFixed(1)+"%").padStart(7)} │` +
      ` ${("$"+r.maxDD.toFixed(0)).padStart(8)} │ ${cal.padStart(7)} │`
    );
  }
  console.log("  └──────────────────┴──────┴──────┴──────┴──────────┴──────────┴──────────┴──────────┘");

  // 改善幅度
  const [oldR, newR] = allResults;
  const pfOld = oldR.r.pf, pfNew = newR.r.pf;
  const pfImprove = pfOld > 0 && pfNew !== Infinity ? ((pfNew - pfOld) / pfOld * 100).toFixed(1) : "N/A";
  const annImprove = (newR.ann - oldR.ann).toFixed(1);
  const ddChange   = (newR.r.maxDD - oldR.r.maxDD).toFixed(0);
  console.log(`\n  改善幅度：PF ${pfImprove}% | 年化 ${annImprove >= 0 ? "+" : ""}${annImprove}pp | 回撤變化 ${ddChange >= 0 ? "+" : ""}$${ddChange}`);

  // 完整報告
  for (const { ver, r } of allResults) printReport(ver.name, r);
}

main().catch(e => { console.error(e.message); process.exit(1); });
