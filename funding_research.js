/**
 * 資金費率套利 歷史研究
 * 分析過去12個月 OKX 主流幣資金費率
 * 計算：年化報酬、正費率比例、最佳幣種、實際淨收益（扣手續費）
 * 執行：node funding_research.js
 */

const SYMBOLS = [
  "BTC-USDT-SWAP","ETH-USDT-SWAP","SOL-USDT-SWAP","BNB-USDT-SWAP",
  "XRP-USDT-SWAP","DOGE-USDT-SWAP","ADA-USDT-SWAP","AVAX-USDT-SWAP",
  "LINK-USDT-SWAP","DOT-USDT-SWAP","UNI-USDT-SWAP","NEAR-USDT-SWAP",
  "INJ-USDT-SWAP","OP-USDT-SWAP","ARB-USDT-SWAP","SUI-USDT-SWAP",
  "TRX-USDT-SWAP","LDO-USDT-SWAP","ATOM-USDT-SWAP","FIL-USDT-SWAP",
];

// 手續費
const SPOT_FEE    = 0.001;   // 0.1% taker
const FUTURES_FEE = 0.0005;  // 0.05% taker
const ROUND_TRIP  = (SPOT_FEE + FUTURES_FEE) * 2; // 開+平 = 0.3%

const BASE_URL = "https://www.okx.com";

// ─── 抓歷史資金費率（OKX，每次最多100筆）─────────────────────────────────────
async function fetchFundingHistory(instId, months = 12) {
  const need   = months * 30 * 3; // 每天3次(8h)
  const all    = [];
  let before   = "";              // OKX 用 before 做分頁（取更舊的）

  while (all.length < need) {
    const url = `${BASE_URL}/api/v5/public/funding-rate-history?instId=${instId}&limit=100${before ? "&before=" + before : ""}`;
    const res  = await fetch(url);
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();
    if (!data.data?.length) break;

    all.push(...data.data.map(d => ({
      time:        +d.fundingTime,
      rate:        +d.fundingRate,
      instId:      d.instId,
    })));

    // 下一頁：取最早那筆的 fundingTime 作為 before
    const oldest = data.data[data.data.length - 1];
    before = oldest.fundingTime;

    if (data.data.length < 100) break;
    await new Promise(r => setTimeout(r, 100)); // 小停頓
  }

  // 只保留近 months 個月
  const cutoff = Date.now() - months * 30 * 24 * 3600 * 1000;
  return all.filter(d => d.time >= cutoff).sort((a,b) => a.time - b.time);
}

// ─── 分析單一幣種 ─────────────────────────────────────────────────────────────
function analyzeCoin(instId, history) {
  if (!history.length) return null;

  const rates     = history.map(h => h.rate);
  const posRates  = rates.filter(r => r > 0);
  const negRates  = rates.filter(r => r < 0);
  const avgRate   = rates.reduce((s,r) => s+r, 0) / rates.length;
  const annualized = avgRate * 3 * 365 * 100; // 每天3次，年化

  // 模擬策略：只在費率 > 閾值時才開倉
  // 假設：$10,000 部位，同等金額開現貨多 + 合約空
  const THRESHOLD_ANNUAL = 0.10; // 10% 年化才值得開
  const THRESHOLD_RATE   = THRESHOLD_ANNUAL / 365 / 3;
  const POS_SIZE         = 10000;

  let totalIncome  = 0;
  let openDays     = 0;
  let openPeriods  = 0;
  let closedPeriods = 0;
  let isOpen       = false;
  let entryFeePaid = 0;

  const monthly = {};

  for (const h of history) {
    const m = new Date(h.time).toISOString().slice(0,7);
    if (!monthly[m]) monthly[m] = 0;

    if (!isOpen && h.rate >= THRESHOLD_RATE) {
      // 開倉：扣手續費
      isOpen = true;
      totalIncome -= POS_SIZE * ROUND_TRIP / 2; // 只算開倉費（平倉費在關閉時扣）
      entryFeePaid += POS_SIZE * ROUND_TRIP / 2;
      openPeriods++;
    }

    if (isOpen) {
      const income = h.rate * POS_SIZE;
      totalIncome  += income;
      monthly[m]   += income;
      openDays++;

      // 費率跌破關閉閾值 → 平倉
      if (h.rate < 0) {
        totalIncome -= POS_SIZE * ROUND_TRIP / 2;
        isOpen = false;
        closedPeriods++;
      }
    }
  }

  // 收盤時若還開著，平倉費
  if (isOpen) {
    totalIncome -= POS_SIZE * ROUND_TRIP / 2;
    closedPeriods++;
  }

  const months    = history.length / (30 * 3);
  const netAnnual = (totalIncome / POS_SIZE / months * 12) * 100;

  return {
    instId,
    symbol:      instId.replace("-USDT-SWAP",""),
    totalPeriods: history.length,
    avgRate:     avgRate * 100,
    annualized,
    posRatePct:  (posRates.length / rates.length) * 100,
    maxRate:     Math.max(...rates) * 100,
    minRate:     Math.min(...rates) * 100,
    totalIncome: totalIncome.toFixed(2),
    netAnnual:   netAnnual.toFixed(2),
    openPeriods,
    monthly,
  };
}

// ─── 最佳開倉時機分析 ────────────────────────────────────────────────────────
function analyzeOptimalEntry(history) {
  const byHour = Array(24).fill(null).map(() => ({ sum: 0, n: 0 }));
  for (const h of history) {
    const hour = new Date(h.time).getUTCHours();
    byHour[hour].sum += h.rate;
    byHour[hour].n++;
  }
  // OKX 結算時間：00:00, 08:00, 16:00 UTC
  return [0, 8, 16].map(h => ({
    hour: h,
    avgRate: byHour[h].n ? (byHour[h].sum / byHour[h].n * 100).toFixed(4) : "—"
  }));
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${"═".repeat(72)}`);
  console.log(`  資金費率套利 歷史研究報告`);
  console.log(`  資料來源：OKX | 回測期間：12個月 | 模擬部位：$10,000 / 幣`);
  console.log(`  手續費假設：現貨 0.1% + 合約 0.05%（來回 0.3%）`);
  console.log(`${"═".repeat(72)}\n`);

  const results = [];

  for (let i = 0; i < SYMBOLS.length; i++) {
    const sym = SYMBOLS[i];
    process.stdout.write(`  [${String(i+1).padStart(2)}/${SYMBOLS.length}] ${sym.padEnd(20)}`);
    try {
      const history = await fetchFundingHistory(sym, 12);
      const analysis = analyzeCoin(sym, history);
      if (analysis) {
        results.push(analysis);
        console.log(`${history.length}筆 | 年化 ${analysis.annualized.toFixed(2)}% | 正費率 ${analysis.posRatePct.toFixed(0)}%`);
      } else {
        console.log(`無資料`);
      }
    } catch(e) {
      console.log(`錯誤(${e.message})`);
    }
    await new Promise(r => setTimeout(r, 200));
  }

  if (!results.length) { console.log("\n無結果"); return; }

  // 排序
  results.sort((a,b) => +b.netAnnual - +a.netAnnual);

  // ─── 報告 1：幣種排行 ────────────────────────────────────────────────────
  console.log(`\n【1】幣種年化費率排行（$10,000 部位，扣手續費後淨收益）`);
  console.log(`${"─".repeat(72)}`);
  console.log(`  幣種       筆數  平均費率    年化費率  正費率%  淨年化    12月收益`);
  console.log(`  ${"─".repeat(65)}`);
  for (const r of results) {
    const netSign = +r.netAnnual >= 0 ? "+" : "";
    console.log(
      `  ${r.symbol.padEnd(10)} ${String(r.totalPeriods).padStart(4)}` +
      `  ${r.avgRate.toFixed(4).padStart(9)}%` +
      `  ${r.annualized.toFixed(2).padStart(8)}%` +
      `  ${r.posRatePct.toFixed(0).padStart(6)}%` +
      `  ${netSign}${r.netAnnual.padStart(6)}%` +
      `  $${r.totalIncome.padStart(8)}`
    );
  }

  // ─── 報告 2：月度收益（前5名合計）────────────────────────────────────────
  const top5 = results.slice(0, 5);
  console.log(`\n【2】月度收益（前5名幣種合計，各 $10,000 部位）`);
  console.log(`${"─".repeat(72)}`);

  const allMonths = new Set();
  top5.forEach(r => Object.keys(r.monthly).forEach(m => allMonths.add(m)));
  const sortedMonths = [...allMonths].sort();

  let grandTotal = 0;
  console.log(`  月份      ${top5.map(r=>r.symbol.padStart(8)).join("")}  合計`);
  console.log(`  ${"─".repeat(65)}`);
  for (const m of sortedMonths) {
    const vals  = top5.map(r => r.monthly[m] || 0);
    const total = vals.reduce((s,v) => s+v, 0);
    grandTotal += total;
    console.log(
      `  ${m}  ${vals.map(v=>`${v>=0?" ":""}${v.toFixed(0)}`.padStart(8)).join("")}  ${total>=0?"+":""}${total.toFixed(0).padStart(7)}`
    );
  }
  console.log(`  ${"─".repeat(65)}`);
  console.log(`  12月合計  ${top5.map(r=>`$${(+r.totalIncome).toFixed(0)}`.padStart(8)).join("")}  $${grandTotal.toFixed(0).padStart(7)}`);

  // ─── 報告 3：風險分析 ─────────────────────────────────────────────────────
  console.log(`\n【3】風險分析`);
  console.log(`${"─".repeat(72)}`);

  const btcData = results.find(r => r.symbol === "BTC");
  const ethData = results.find(r => r.symbol === "ETH");

  console.log(`  ┌──────────────────────────────────────────────────────────┐`);
  console.log(`  │ 風險項目              說明                               │`);
  console.log(`  ├──────────────────────────────────────────────────────────┤`);
  console.log(`  │ 負費率風險            費率轉負時需付費，須即時平倉       │`);
  console.log(`  │ 基差風險              現貨與合約價差可能虧損（通常<0.1%）│`);
  console.log(`  │ 交易所風險            現貨+合約都在 OKX，集中風險        │`);
  console.log(`  │ 流動性風險            大部位開平倉有滑點                 │`);
  console.log(`  │ 爆倉風險              合約空單需維持保證金               │`);
  console.log(`  └──────────────────────────────────────────────────────────┘`);

  if (btcData) {
    console.log(`\n  BTC 負費率出現頻率：${(100 - btcData.posRatePct).toFixed(1)}%（${(1096 * (1-btcData.posRatePct/100)).toFixed(0)} 次 / 3年估計）`);
    console.log(`  BTC 歷史最低費率：${btcData.minRate.toFixed(4)}%（單期最大虧損：$${(10000 * btcData.minRate/100).toFixed(2)}）`);
  }

  // ─── 報告 4：策略建議 ─────────────────────────────────────────────────────
  console.log(`\n【4】策略建議`);
  console.log(`${"─".repeat(72)}`);

  const best3 = results.slice(0, 3);
  const totalCapital = best3.length * 10000;
  const totalNet     = best3.reduce((s,r) => s + +r.totalIncome, 0);
  const blendedAnnual = (totalNet / totalCapital / 1 * 100).toFixed(1); // 1年

  console.log(`  建議幣種：${best3.map(r=>r.symbol).join("、")} 各 $10,000`);
  console.log(`  總部位：$${totalCapital.toLocaleString()}（現貨 $${totalCapital.toLocaleString()} + 合約保證金 $${(totalCapital*0.2).toFixed(0)}）`);
  console.log(`  12個月估計淨收益：$${totalNet.toFixed(0)}（混合年化 ${blendedAnnual}%）`);
  console.log(`\n  執行流程：`);
  console.log(`    1. 每小時掃描費率，年化 > 15% 才開倉`);
  console.log(`    2. 現貨買入 + 合約等量空單（isolated margin）`);
  console.log(`    3. 費率轉負（< 0）立即平倉`);
  console.log(`    4. 每8小時（00:00 / 08:00 / 16:00 UTC）自動收取費率`);
  console.log(`    5. 最多同時持有 ${best3.length} 個幣種`);

  console.log(`\n  與 Donchian 策略對比：`);
  console.log(`    Donchian Bot  → 方向性，年化 14.2%，最大回撤 20.4%，高波動`);
  console.log(`    資金費率套利  → 市場中性，年化 ~${blendedAnnual}%，回撤極低，穩定`);
  console.log(`    ✅ 兩者互補，合計年化可能達 20-30%，且風險分散`);

  console.log(`\n${"═".repeat(72)}\n`);
}

main().catch(console.error);
