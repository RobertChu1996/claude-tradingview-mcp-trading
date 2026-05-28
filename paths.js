/**
 * Centralized file paths — all state files go to DATA_DIR (Railway Volume).
 * Set DATA_DIR=/data in Railway env vars. Defaults to "." locally.
 */
import { join } from "path";

const D = process.env.DATA_DIR || ".";

export const POSITIONS_DN_FILE  = join(D, "positions_dn.json");
export const WATCHLIST_DN_FILE  = join(D, "watchlist_dn.json");
export const LAST_RUN_DN_FILE   = join(D, "last_optimized_dn.txt");
export const LOG_DN_FILE        = join(D, "safety-check-log-dn.json");
export const CSV_DN_FILE        = join(D, "trades_dn.csv");

export const POSITIONS_DMC_FILE = join(D, "positions_dmc.json");
export const LOG_DMC_FILE       = join(D, "safety-check-log-dmc.json");
export const CSV_DMC_FILE       = join(D, "trades_dmc.csv");
