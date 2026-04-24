/**
 * 四策略對照執行
 * A: VWAP + RSI(3) + EMA(8)
 * B: DMC-Inspired (結構 + 量能 + K線)
 * C: BB Breakout + ATR Dynamic Stop  ← LIVE
 * D: Opening Range Breakout
 *
 * 每週自動優化策略C名單（讀 watchlist_master.json，重算PF，更新 rules_bb.json）
 */
import { execSync, spawn } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { LAST_RUN_FILE } from "./paths.js";

const run = (label, cmd) => {
  console.log("\n" + "━".repeat(57));
  console.log(`  ${label}`);
  console.log("━".repeat(57));
  try { execSync(cmd, { stdio: "inherit" }); }
  catch (e) { console.error(`執行失敗: ${e.message}`); }
};

// 週優化：背景執行，不阻擋交易 bot
const needsOptimize = !existsSync(LAST_RUN_FILE) ||
  (Date.now() - new Date(readFileSync(LAST_RUN_FILE, "utf8").trim()).getTime()) / (1000 * 60 * 60 * 24) >= 7;

if (needsOptimize) {
  writeFileSync(LAST_RUN_FILE, new Date().toISOString()); // 先鎖定，防止重複觸發
  console.log("\n[Auto-Optimize] 週優化背景啟動...\n");
  const child = spawn("node", ["optimize_all.js"], { detached: true, stdio: "ignore" });
  child.unref();
}

run("策略 A：VWAP + RSI(3) + EMA(8)  [4H]", "node bot.js");
run("策略 B：DMC-Inspired             [15m]", "node bot_dmc.js");
run("策略 C：BB Breakout + ATR Stop   [1H]", "node bot_bb.js");
run("策略 D：Opening Range Breakout   [15m]", "node bot_orb.js");

console.log("\n✅ 四策略掃描完成\n");
