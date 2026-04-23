/**
 * 四策略對照執行
 * A: VWAP + RSI(3) + EMA(8)
 * B: DMC-Inspired (結構 + 量能 + K線)
 * C: BB Breakout + ATR Dynamic Stop  ← LIVE
 * D: Opening Range Breakout
 *
 * 每週自動優化策略C名單（讀 watchlist_master.json，重算PF，更新 rules_bb.json）
 */
import { execSync } from "child_process";
import { runAutoOptimize } from "./auto_optimize.js";

const run = (label, cmd) => {
  console.log("\n" + "━".repeat(57));
  console.log(`  ${label}`);
  console.log("━".repeat(57));
  try { execSync(cmd, { stdio: "inherit" }); }
  catch (e) { console.error(`執行失敗: ${e.message}`); }
};

// 週優化：每7天自動重算名單
await runAutoOptimize(false);

run("策略 A：VWAP + RSI(3) + EMA(8)  [4H]", "node bot.js");
run("策略 B：DMC-Inspired             [15m]", "node bot_dmc.js");
run("策略 C：BB Breakout + ATR Stop   [1H]", "node bot_bb.js");
run("策略 D：Opening Range Breakout   [15m]", "node bot_orb.js");

console.log("\n✅ 四策略掃描完成\n");
