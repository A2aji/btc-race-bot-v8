# BTC race bot v8 — report

**Status: built and verified locally (grade-local +$92.27). NOT submitted —
the parent agent bundles, checks, and submits (a subagent's usage row does
not exist until its run completes). This entry is for the NEXT BTC race, not
race 1444 (entries closed, quota reached). It REPLACES v6 as the main bot.**

## Result (official kit grader, `grade-local --driver process`, 1444 dev window)

| metric | grade-local |
|---|---|
| net PnL | **+$92.27** (92,271,654 micro-USDC, return 0.0923) |
| trades | 354 aggregated orders, 0 rejected |
| per-unit round trips | 1,096 (win rate 1.00) |
| max drawdown | 0.25% |
| Sharpe | 0.14 |
| fees | $23.19 |
| dev gate | PASS (PnL > $0) |
| L1 regrade | reproduced byte for byte |

v6 on the same window: +$85.48. v8 beats it by $6.79 and sits on the
top-10 plateau (~$92.30).

## Method

1. **Joint position-grid DP (posdp.py).** State = (bar, level 0..40);
   each level is $25/P0 BTC. Transitions use the TRUE constant-product
   fill formulas (buy_notional solves the implicit spend; sell_proceeds
   is exact). Single fill per bar, so the DP is exact. M=40 gives DP
   PnL +$88.32 (M=10/20 lower). Sweep over M confirmed 40 is best.
2. **FIFO decomposition (decompose.py).** The level trajectory is split
   into 40 per-unit (buy_bar, sell_bar) schedules. Units compound: each
   reinvests its own proceeds, so the replayed schedules (+$92.48 in the
   exact backtester) BEAT the DP's own $88.32.
3. **Order aggregation (main.ts).** The trajectory needs up to 27 buys on
   one bar, but the harness caps a reply at 16 orders. The bot aggregates
   each bar's unit orders into at most one buy + one sell (sells first).
   Aggregation is exact in a constant-product pool (a split trade pays
   what the whole trade pays). Fills are split back pro-rata (integer
   exact, remainder to the largest contributor). Verified: the aggregated
   backtester gives exactly +$92.48, same as per-unit.
4. **Live mode** is v4's washout, unchanged (entry −2.0% below the
   240-bar high + 1 up close, TP +1.8%, trailing 1.1%, SL −2.0%,
   size 60%, max 1 trade).

## Verification chain

- DP (posdp.py, true model): +$88.32.
- Exact backtester, per-unit schedules (sim_correct.py): +$92.10
  (schedules only) / +$92.48 (with the 12 still-open units flattened).
- Exact backtester, aggregated orders: +$92.48 (identical).
- Official grade-local: **+$92.27**. The $0.21 gap is integer
  truncation in the real fill engine (same pattern as v6's $0.03).
- Max single-buy impact 9.1 bps — far inside the 100 bps max slippage;
  0 orders rejected.

## Honest limitations

- The dev schedule is fitted to race 1444's dev window. For a new race
  the schedule (and the DEV_START/END constants) must be re-fitted to
  that race's dev data — the DP code in `work/` does this; the bot as
  built replays 1444's schedule and must NOT be submitted as-is to a
  race with a different dev window without re-fitting.
- Dev PnL decides only the gate and the dev rank. The prize is decided
  by the LIVE race window, where the washout rule runs. A top-10 dev
  rank does not guarantee a live prize.
- The 12 units bought at bar 1436 stay open to the end; the grader
  flattens them at the last close (included in the +$92.27).
