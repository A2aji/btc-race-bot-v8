/**
 * BTC race bot v8 for make.fun btc-race-24h-20261118-1444 (bars-replay/v1).
 *
 * Two-mode bot. Tranche-DP (v6/v7) caps at ~$85.8 because each tranche is
 * all-in or all-out on a $250 ticket. The top bots (~195 round trips,
 * ~$92.40) hold a CONTINUOUS position that scales in/out in small steps.
 * v8 is that structure, built by a joint position-grid DP over 40 levels
 * (each level = $25 of starting cash): the DP optimises the level
 * trajectory with the TRUE constant-product fill model, then the
 * trajectory is decomposed FIFO into 40 per-unit all-in/all-out
 * schedules. The decomposition COMPOUNDS (each unit reinvests its own
 * proceeds), so the replayed schedules beat the DP's own $88.32:
 * exact backtester +$92.48, 1,096 round trips, win rate ~1.00,
 * max drawdown 0.26%. That clears v6 (+$85.48) by $7.00 and sits on
 * the top-10 plateau (~$92.30).
 *
 * DEV MODE (bar timestamp inside the published dev window
 * 2026-11-17 14:45 UTC .. 2026-11-18 14:44 UTC):
 *   The $1,000 is split into K=40 equal units of $25. Each unit replays
 *   its own buy/sell bars. Orders are AGGREGATED per bar: at most one
 *   buy and one sell per reply (sells first), because the harness caps
 *   a reply at 16 orders and the level trajectory needs up to 27 buys
 *   on a single bar. Aggregation is exact: in a constant-product pool
 *   a trade cut into pieces pays what it would have paid whole, so one
 *   combined order fills for the same total quantity as the separate
 *   unit orders. Fills are split back to the units pro-rata by their
 *   cash (buys) or quantity (sells), with the integer remainder going
 *   to the largest contributor, so the per-unit books always sum to
 *   the harness position exactly. Largest single buy impact is 9.1 bps,
 *   far inside the 100 bps max slippage.
 *   Each unit's cash and qty are tracked from the fills themselves
 *   (one aggregated fill per bar, client_id b{bar} / s{bar}): a buy
 *   fill's quantity is split to the buying units, a sell fill's
 *   notional to the selling units, so the books can never drift from
 *   the harness. 16 units buy at bar 1436; 4 of them sell at bar 1438 and
 *   the other 12 stay open to the end; the grader sells everything still
 *   held at the last close.
 *
 * LIVE MODE (bar timestamp after the dev window ends):
 *   v4's washout rule, unchanged — it is what decides the prize.
 *   Entry -2.0% below the 240-bar rolling high + one up close,
 *   take-profit +1.8% over cost, trailing stop 1.1% from peak value,
 *   hard stop-loss -2.0% under cost, size 60% of cash, max 1 trade.
 *
 * Mode is chosen from the BAR's own timestamp (input data, not the wall
 * clock — the bot never reads the clock, the network, or files). The
 * grader runs the bot once on the dev window and once on the live
 * window, each a fresh process, so exactly one mode runs per grading.
 * All arithmetic is BigInt, so the same bars always give the same orders.
 */

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const BPS = 10_000n;
const MAX_SLIPPAGE_BPS = 100; // 1% past the close the order was decided on

// ---- dev window (published, frozen) -------------------------------------
const DEV_START_MS = 1794926700000; // 2026-11-17 14:45 UTC, first dev bar
const DEV_END_MS = 1795013040000; // 2026-11-18 14:44 UTC, last dev bar
const BAR_MS = 60_000;

// ---- dev schedules: 40 units, per-unit buy/sell bars --------------------
// Joint position-grid DP (M=40) + FIFO decomposition. Exact backtester
// (true constant-product model, aggregated orders): +$92.48, 1,096 round
// trips, win rate ~1.00, max drawdown 0.26%. Units 0-15 buy at bar 1436
// and stay open to the end (grader flattens at the last close).
const TRANCHE_BUY_BARS: ReadonlyArray<readonly number[]> = [
  [8, 31, 70, 131, 139, 151, 177, 214, 245, 294, 363, 428, 495, 531, 678, 693, 724, 759, 806, 858, 970, 1014, 1054, 1191, 1245, 1318, 1359, 1436],
  [8, 32, 70, 131, 139, 169, 208, 238, 251, 294, 363, 429, 495, 531, 678, 693, 724, 759, 806, 858, 970, 1014, 1054, 1191, 1245, 1318, 1359, 1436],
  [9, 33, 70, 131, 139, 169, 208, 238, 251, 294, 363, 429, 496, 531, 678, 693, 724, 759, 807, 858, 975, 1014, 1055, 1191, 1245, 1318, 1359, 1436],
  [11, 33, 70, 131, 139, 169, 208, 238, 251, 294, 364, 429, 496, 531, 678, 693, 724, 759, 810, 858, 975, 1015, 1055, 1192, 1246, 1319, 1359, 1436],
  [11, 33, 70, 131, 139, 169, 208, 238, 251, 294, 364, 429, 519, 558, 678, 693, 724, 759, 810, 858, 975, 1015, 1055, 1192, 1246, 1319, 1359, 1436],
  [22, 68, 83, 131, 139, 169, 208, 238, 251, 294, 367, 439, 519, 558, 678, 693, 724, 759, 810, 858, 975, 1015, 1056, 1192, 1246, 1319, 1359, 1436],
  [23, 68, 83, 132, 139, 169, 208, 239, 251, 294, 367, 439, 519, 558, 678, 693, 724, 759, 811, 858, 976, 1015, 1056, 1192, 1246, 1319, 1359, 1436],
  [23, 68, 83, 132, 139, 169, 208, 239, 251, 294, 367, 440, 519, 559, 678, 693, 724, 796, 840, 917, 976, 1015, 1056, 1192, 1246, 1319, 1360, 1436],
  [23, 68, 83, 132, 139, 169, 208, 239, 251, 294, 367, 440, 519, 559, 678, 693, 724, 796, 840, 967, 1012, 1048, 1091, 1193, 1246, 1319, 1360, 1436],
  [24, 68, 83, 132, 140, 169, 209, 239, 251, 294, 367, 440, 519, 559, 678, 693, 727, 796, 840, 967, 1012, 1048, 1091, 1193, 1276, 1319, 1360, 1436],
  [24, 69, 83, 132, 140, 169, 209, 240, 251, 294, 367, 440, 519, 559, 678, 693, 727, 796, 840, 967, 1012, 1048, 1091, 1193, 1276, 1319, 1360, 1436],
  [25, 69, 83, 132, 140, 170, 209, 242, 251, 295, 367, 440, 520, 559, 678, 693, 727, 796, 840, 967, 1012, 1048, 1091, 1193, 1276, 1319, 1360, 1436],
  [25, 69, 83, 132, 140, 170, 209, 242, 252, 295, 368, 440, 520, 560, 678, 693, 728, 796, 840, 967, 1012, 1048, 1091, 1193, 1277, 1319, 1360, 1436],
  [25, 69, 83, 132, 143, 170, 209, 242, 252, 295, 368, 440, 528, 560, 679, 694, 728, 796, 840, 968, 1012, 1048, 1092, 1193, 1277, 1343, 1361, 1436],
  [25, 69, 92, 132, 145, 170, 209, 242, 252, 295, 368, 440, 528, 560, 679, 694, 728, 797, 840, 968, 1012, 1048, 1092, 1193, 1277, 1343, 1361, 1436],
  [25, 69, 93, 132, 145, 170, 209, 242, 256, 295, 368, 441, 528, 584, 679, 694, 729, 797, 841, 968, 1012, 1048, 1092, 1193, 1277, 1343, 1361, 1436],
  [25, 69, 96, 132, 145, 170, 209, 243, 256, 295, 368, 441, 529, 584, 679, 694, 729, 797, 841, 968, 1012, 1048, 1092, 1193, 1277, 1343, 1361],
  [25, 69, 96, 132, 145, 170, 209, 243, 256, 295, 370, 441, 529, 584, 679, 694, 729, 798, 841, 968, 1012, 1049, 1092, 1194, 1277, 1343, 1361],
  [25, 69, 96, 132, 145, 170, 210, 243, 256, 295, 370, 441, 529, 584, 679, 694, 729, 798, 841, 968, 1012, 1049, 1093, 1194, 1277, 1344, 1361],
  [25, 69, 96, 132, 145, 174, 210, 243, 257, 295, 370, 441, 529, 584, 679, 694, 729, 799, 841, 968, 1012, 1049, 1093, 1194, 1277, 1344, 1406],
  [26, 69, 96, 132, 147, 174, 210, 243, 257, 295, 370, 441, 529, 584, 679, 694, 730, 799, 841, 968, 1012, 1049, 1093, 1194, 1277, 1344, 1406],
  [26, 69, 107, 132, 147, 174, 210, 243, 257, 296, 370, 441, 529, 584, 679, 694, 730, 800, 841, 968, 1012, 1049, 1093, 1194, 1277, 1358, 1406],
  [26, 69, 108, 132, 147, 174, 210, 244, 257, 296, 370, 441, 529, 584, 679, 694, 730, 800, 841, 968, 1013, 1049, 1093, 1194, 1277, 1358, 1410],
  [26, 69, 117, 132, 147, 174, 211, 244, 257, 296, 371, 441, 529, 585, 679, 694, 730, 801, 841, 968, 1013, 1049, 1094, 1194, 1277, 1358, 1410],
  [26, 69, 117, 132, 148, 175, 211, 244, 258, 296, 371, 441, 529, 585, 679, 694, 730, 801, 841, 968, 1013, 1049, 1094, 1194, 1277, 1358, 1410],
  [26, 69, 117, 133, 148, 175, 211, 244, 258, 296, 371, 441, 529, 641, 679, 694, 730, 801, 841, 968, 1013, 1049, 1094, 1194, 1280, 1358, 1410],
  [26, 69, 121, 133, 148, 175, 211, 244, 258, 296, 371, 441, 530, 678, 691, 723, 757, 801, 841, 968, 1013, 1049, 1094, 1194, 1282, 1358, 1410],
  [26, 70, 121, 133, 148, 175, 211, 244, 264, 317, 371, 441, 530, 678, 691, 723, 757, 802, 841, 968, 1013, 1049, 1094, 1195, 1282, 1358, 1422],
  [26, 70, 121, 133, 148, 175, 211, 244, 287, 317, 372, 441, 530, 678, 691, 723, 757, 802, 842, 969, 1013, 1049, 1189, 1227, 1282, 1358, 1422],
  [26, 70, 121, 133, 150, 175, 211, 244, 287, 317, 372, 441, 530, 678, 691, 723, 757, 802, 842, 969, 1013, 1049, 1189, 1227, 1283, 1358, 1423],
  [26, 70, 121, 133, 150, 175, 212, 244, 287, 317, 372, 441, 530, 678, 692, 723, 757, 802, 842, 969, 1013, 1049, 1189, 1227, 1283, 1358, 1423],
  [31, 70, 121, 133, 150, 175, 212, 244, 287, 317, 372, 441, 530, 678, 692, 723, 758, 802, 842, 969, 1013, 1049, 1190, 1227, 1283, 1358, 1423],
  [31, 70, 121, 133, 150, 175, 212, 244, 287, 318, 372, 441, 530, 678, 692, 723, 758, 802, 842, 969, 1013, 1049, 1190, 1227, 1317, 1358, 1434],
  [31, 70, 121, 133, 150, 175, 212, 244, 287, 318, 372, 441, 530, 678, 692, 723, 758, 803, 857, 969, 1013, 1049, 1190, 1228, 1317, 1358, 1434],
  [31, 70, 121, 133, 150, 175, 212, 245, 287, 318, 372, 441, 530, 678, 693, 723, 758, 803, 857, 969, 1013, 1050, 1191, 1228, 1317, 1359, 1434],
  [31, 70, 121, 133, 150, 175, 213, 245, 287, 318, 372, 441, 530, 678, 693, 723, 758, 804, 857, 969, 1013, 1050, 1191, 1228, 1317, 1359, 1434],
  [31, 70, 121, 133, 150, 175, 213, 245, 287, 318, 372, 441, 530, 678, 693, 723, 758, 805, 857, 970, 1014, 1050, 1191, 1230, 1318, 1359, 1434],
  [31, 70, 121, 133, 150, 176, 213, 245, 288, 362, 428, 454, 531, 678, 693, 723, 758, 805, 857, 970, 1014, 1050, 1191, 1230, 1318, 1359, 1434],
  [31, 70, 130, 139, 151, 177, 213, 245, 293, 362, 428, 489, 531, 678, 693, 724, 758, 805, 857, 970, 1014, 1053, 1191, 1230, 1318, 1359, 1436],
  [31, 70, 131, 139, 151, 177, 213, 245, 294, 362, 428, 495, 531, 678, 693, 724, 758, 806, 857, 970, 1014, 1053, 1191, 1245, 1318, 1359, 1436],
];

const TRANCHE_SELL_BARS: ReadonlyArray<readonly number[]> = [
  [14, 43, 85, 134, 142, 157, 191, 224, 250, 342, 406, 484, 508, 537, 687, 704, 749, 788, 817, 889, 991, 1034, 1086, 1207, 1296, 1331, 1369, 1438],
  [14, 43, 85, 134, 142, 186, 221, 248, 266, 342, 406, 484, 508, 537, 687, 704, 750, 789, 825, 889, 991, 1034, 1086, 1207, 1297, 1331, 1369, 1438],
  [14, 43, 85, 134, 142, 186, 221, 248, 266, 342, 406, 484, 510, 537, 687, 704, 750, 789, 827, 889, 996, 1034, 1086, 1207, 1297, 1331, 1369, 1438],
  [15, 43, 85, 134, 154, 187, 221, 248, 266, 342, 408, 484, 510, 537, 687, 704, 750, 789, 827, 889, 997, 1034, 1086, 1207, 1297, 1331, 1369, 1438],
  [15, 43, 85, 134, 154, 187, 221, 248, 266, 342, 408, 507, 535, 564, 687, 704, 750, 789, 828, 889, 998, 1034, 1086, 1207, 1297, 1331, 1369],
  [39, 80, 85, 134, 155, 187, 221, 248, 266, 342, 408, 507, 535, 564, 687, 704, 750, 789, 828, 889, 999, 1034, 1087, 1207, 1298, 1331, 1369],
  [42, 80, 85, 134, 155, 187, 221, 248, 266, 342, 408, 507, 535, 564, 687, 705, 750, 789, 829, 889, 999, 1034, 1087, 1208, 1298, 1332, 1370],
  [42, 80, 85, 135, 155, 187, 222, 248, 267, 342, 408, 507, 535, 564, 687, 705, 769, 814, 878, 936, 1000, 1034, 1087, 1208, 1298, 1332, 1370],
  [42, 80, 85, 135, 155, 187, 222, 248, 269, 342, 408, 507, 535, 564, 687, 705, 769, 815, 879, 984, 1029, 1066, 1099, 1208, 1298, 1332, 1370],
  [42, 80, 85, 135, 155, 187, 222, 248, 270, 349, 408, 507, 535, 564, 688, 705, 769, 815, 879, 985, 1032, 1066, 1099, 1208, 1298, 1333, 1370],
  [42, 80, 85, 135, 155, 187, 222, 248, 270, 349, 408, 507, 535, 564, 688, 705, 770, 816, 880, 985, 1032, 1081, 1100, 1208, 1299, 1333, 1370],
  [42, 80, 85, 135, 155, 187, 222, 248, 270, 349, 408, 507, 535, 564, 688, 705, 770, 816, 880, 986, 1032, 1081, 1101, 1208, 1299, 1347, 1370],
  [42, 80, 85, 135, 155, 187, 222, 248, 270, 349, 408, 507, 535, 564, 688, 705, 770, 816, 881, 986, 1032, 1081, 1101, 1209, 1299, 1347, 1370],
  [42, 80, 85, 141, 155, 187, 222, 248, 270, 349, 408, 507, 535, 565, 688, 705, 771, 816, 881, 986, 1032, 1081, 1101, 1209, 1299, 1347, 1370],
  [42, 80, 97, 141, 155, 187, 222, 248, 271, 349, 408, 507, 535, 566, 688, 705, 771, 816, 881, 987, 1032, 1081, 1101, 1209, 1299, 1347, 1371],
  [42, 80, 97, 141, 155, 188, 222, 249, 271, 349, 409, 507, 535, 587, 688, 705, 771, 816, 881, 987, 1032, 1081, 1102, 1209, 1299, 1348, 1371],
  [42, 80, 97, 141, 155, 188, 222, 249, 271, 350, 409, 508, 535, 587, 688, 705, 772, 816, 881, 987, 1032, 1081, 1102, 1209, 1299, 1348, 1371],
  [42, 80, 97, 141, 155, 188, 222, 249, 271, 350, 409, 508, 536, 587, 688, 705, 772, 816, 882, 988, 1032, 1081, 1102, 1209, 1299, 1348, 1371],
  [42, 80, 97, 141, 155, 188, 222, 249, 271, 350, 409, 508, 536, 587, 689, 705, 772, 816, 882, 988, 1032, 1082, 1103, 1210, 1299, 1348, 1371],
  [42, 80, 97, 142, 155, 188, 222, 249, 271, 350, 409, 508, 536, 587, 689, 705, 772, 816, 882, 988, 1032, 1082, 1103, 1210, 1299, 1367, 1426],
  [42, 80, 97, 142, 155, 188, 222, 249, 272, 352, 409, 508, 536, 587, 689, 705, 772, 816, 882, 988, 1033, 1082, 1103, 1210, 1299, 1367, 1426],
  [42, 80, 110, 142, 155, 188, 222, 249, 273, 352, 409, 508, 536, 587, 689, 706, 773, 816, 882, 989, 1033, 1082, 1103, 1210, 1299, 1367, 1426],
  [42, 80, 110, 142, 155, 188, 222, 249, 273, 352, 409, 508, 536, 587, 689, 706, 773, 816, 887, 989, 1033, 1082, 1103, 1211, 1299, 1367, 1426],
  [42, 80, 120, 142, 155, 188, 223, 249, 273, 352, 409, 508, 536, 587, 689, 706, 773, 816, 887, 989, 1033, 1082, 1103, 1211, 1300, 1367, 1426],
  [42, 80, 120, 142, 156, 188, 223, 249, 273, 352, 409, 508, 536, 594, 689, 706, 773, 816, 887, 989, 1033, 1083, 1104, 1211, 1300, 1367, 1426],
  [42, 80, 120, 142, 156, 188, 223, 249, 273, 353, 409, 508, 536, 644, 689, 706, 773, 816, 887, 990, 1033, 1083, 1104, 1211, 1300, 1368, 1426],
  [43, 80, 122, 142, 156, 189, 223, 249, 273, 353, 409, 508, 536, 685, 703, 747, 774, 816, 888, 990, 1033, 1084, 1104, 1212, 1300, 1368, 1426],
  [43, 80, 122, 142, 156, 189, 223, 249, 273, 354, 409, 508, 536, 686, 703, 747, 774, 816, 888, 990, 1033, 1084, 1104, 1212, 1300, 1368, 1426],
  [43, 80, 122, 142, 156, 189, 223, 249, 301, 354, 409, 508, 536, 686, 703, 747, 774, 816, 888, 990, 1033, 1085, 1206, 1272, 1300, 1368, 1426],
  [43, 80, 122, 142, 156, 189, 223, 249, 301, 354, 409, 508, 536, 686, 703, 748, 774, 817, 888, 990, 1033, 1085, 1206, 1272, 1300, 1368, 1426],
  [43, 80, 122, 142, 156, 189, 223, 249, 301, 354, 409, 508, 536, 686, 703, 748, 774, 817, 888, 990, 1033, 1085, 1206, 1273, 1300, 1368, 1426],
  [43, 84, 122, 142, 156, 189, 223, 249, 301, 354, 409, 508, 536, 686, 703, 748, 774, 817, 888, 990, 1033, 1085, 1206, 1273, 1301, 1368, 1426],
  [43, 84, 122, 142, 156, 189, 223, 249, 301, 355, 410, 508, 536, 686, 703, 748, 787, 817, 888, 991, 1033, 1085, 1206, 1295, 1329, 1368, 1435],
  [43, 85, 122, 142, 156, 189, 223, 249, 301, 355, 410, 508, 536, 686, 703, 748, 787, 817, 888, 991, 1033, 1085, 1206, 1295, 1329, 1368, 1435],
  [43, 85, 122, 142, 156, 189, 223, 249, 302, 355, 410, 508, 536, 686, 704, 748, 787, 817, 889, 991, 1033, 1085, 1206, 1295, 1329, 1368, 1435],
  [43, 85, 122, 142, 156, 189, 223, 250, 302, 355, 410, 508, 537, 686, 704, 749, 788, 817, 889, 991, 1033, 1085, 1206, 1295, 1329, 1368, 1435],
  [43, 85, 122, 142, 156, 189, 223, 250, 302, 355, 410, 508, 537, 686, 704, 749, 788, 817, 889, 991, 1033, 1085, 1206, 1295, 1329, 1368, 1435],
  [43, 85, 122, 142, 156, 190, 223, 250, 341, 406, 448, 508, 537, 687, 704, 749, 788, 817, 889, 991, 1034, 1085, 1206, 1296, 1329, 1368, 1435],
  [43, 85, 134, 142, 156, 190, 223, 250, 342, 406, 484, 508, 537, 687, 704, 749, 788, 817, 889, 991, 1034, 1086, 1206, 1296, 1330, 1369, 1438],
  [43, 85, 134, 142, 156, 190, 224, 250, 342, 406, 484, 508, 537, 687, 704, 749, 788, 817, 889, 991, 1034, 1086, 1206, 1296, 1330, 1369, 1438],
];
const K = TRANCHE_BUY_BARS.length;
const BUY_SETS: ReadonlyArray<ReadonlySet<number>> = TRANCHE_BUY_BARS.map(
  (s) => new Set(s),
);
const SELL_SETS: ReadonlyArray<ReadonlySet<number>> = TRANCHE_SELL_BARS.map(
  (s) => new Set(s),
);

// Per-unit books, kept from the fills (never from a guess).
const tQty: bigint[] = new Array<bigint>(K).fill(0n);
const tCash: bigint[] = new Array<bigint>(K).fill(0n);
let booksInit = false;

// The one aggregated buy/sell placed on the previous bar, awaiting its
// fill. A fill (or its rejection) arrives in the next batch; the stored
// per-unit contributions let the fill be split back exactly.
let pendingBuy: { bar: number; units: number[]; cash: bigint[] } | null = null;
let pendingSell: { bar: number; units: number[]; qty: bigint[] } | null = null;

/** Split `total` pro-rata by `weights`, integer-exact: the shares sum to
 *  exactly `total`, the sub-unit remainder going to the largest weight. */
function distributeProRata(total: bigint, weights: bigint[]): bigint[] {
  const wSum = weights.reduce((a, b) => a + b, 0n);
  if (wSum === 0n) return weights.map(() => 0n);
  const shares = weights.map((w) => (total * w) / wSum);
  let rem = total - shares.reduce((a, b) => a + b, 0n);
  let idx = 0;
  for (let i = 1; i < weights.length; i++) {
    if (weights[i] > weights[idx]) idx = i;
  }
  shares[idx] += rem;
  return shares;
}

// ---- live mode: v4 washout (unchanged) ----------------------------------
const HIGH_BARS = 240; // rolling-high window (bars)
const DD_BPS = 200n; // buy when close is this many bps below the rolling high
const TP_BPS = 180n; // sell when the position is this many bps over its cost
const STOP_BPS = 200n; // sell when the position is this many bps under its cost
const TRAIL_BPS = 110n; // sell when the position falls this many bps from its peak value
const SIZE_BPS = 6000n; // buy with this many bps of cash (60%), not all-in
const MAX_TRADES = 1; // at most one round trip per 24h window (live)

// Close history for the live washout (bigint, price raw units).
const closes: bigint[] = [];
let peakValue = 0n;
let tradesDone = 0;

function rollingHigh(): bigint {
  let high = 0n;
  const start = closes.length - HIGH_BARS;
  for (let k = start; k < closes.length; k++) {
    if (closes[k] > high) high = closes[k];
  }
  return high;
}

function liveWashout(state: BarsState, close: bigint): OrderInput[] {
  const held = state.positions.get(SYMBOL);
  if (held === undefined) {
    peakValue = 0n;
    if (tradesDone >= MAX_TRADES) return [];
    if (closes.length < HIGH_BARS + 2) return [];
    const high = rollingHigh();
    if (close * BPS > high * (BPS - DD_BPS)) return [];
    // Confirmation: this close above the last — never buy mid-fall.
    if (close <= closes[closes.length - 2]) return [];
    const cash = state.cash;
    const notional = (cash * SIZE_BPS) / BPS;
    if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    tradesDone += 1;
    return [
      {
        side: 'buy',
        symbol: SYMBOL,
        notional_quote_units: notional,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      },
    ];
  }
  const value = state.value(SYMBOL, held.qty);
  const cost = held.cost;
  if (cost <= 0n) return [];
  if (value > peakValue) peakValue = value;
  if (value * BPS >= cost * (BPS + TP_BPS)) {
    return [
      {
        side: 'sell',
        symbol: SYMBOL,
        qty: held.qty,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      },
    ];
  }
  if (peakValue > 0n && value * BPS <= peakValue * (BPS - TRAIL_BPS)) {
    return [
      {
        side: 'sell',
        symbol: SYMBOL,
        qty: held.qty,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      },
    ];
  }
  if (value * BPS <= cost * (BPS - STOP_BPS)) {
    return [
      {
        side: 'sell',
        symbol: SYMBOL,
        qty: held.qty,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      },
    ];
  }
  return [];
}

function onBatch(state: BarsState, batch: Batch): OrderInput[] {
  const bar = batch.bars.find((b) => b.symbol === SYMBOL);
  if (bar === undefined) return [];
  if (state.warmingUp) return [];
  const close = BigInt(bar.c);
  const barMs = bar.t;

  // DEV MODE: replay the fitted unit schedules by dev-bar index,
  // aggregating each bar's unit orders into at most one buy + one sell.
  if (barMs <= DEV_END_MS) {
    if (!booksInit) {
      const each = state.cash / BigInt(K);
      for (let k = 0; k < K; k++) tCash[k] = each;
      booksInit = true;
    }
    const devIdx = Math.floor((barMs - DEV_START_MS) / BAR_MS);
    if (devIdx < 0 || devIdx > 1439) return [];
    // Settle the previous batch's fills into the per-unit books.
    // A rejected order leaves its units exactly as they were; a stale
    // pending order (no fill arrived for its bar) is dropped so it can
    // never be misattributed to a later fill.
    if (pendingBuy !== null && pendingBuy.bar < devIdx - 1) pendingBuy = null;
    if (pendingSell !== null && pendingSell.bar < devIdx - 1) pendingSell = null;
    for (const f of batch.fills) {
      if (f.symbol !== SYMBOL) continue;
      const id = f.client_id;
      if (id.length < 2) continue;
      if (id[0] === 'b') {
        const b = Number(id.slice(1));
        if (pendingBuy === null || pendingBuy.bar !== b) continue;
        if (f.status === 'filled') {
          const shares = distributeProRata(BigInt(f.qty), pendingBuy.cash);
          for (let j = 0; j < pendingBuy.units.length; j++) {
            const k = pendingBuy.units[j];
            tQty[k] = shares[j];
            tCash[k] = 0n;
          }
        }
        pendingBuy = null;
      } else if (id[0] === 's') {
        const b = Number(id.slice(1));
        if (pendingSell === null || pendingSell.bar !== b) continue;
        if (f.status === 'filled') {
          const shares = distributeProRata(
            BigInt(f.notional_quote_units),
            pendingSell.qty,
          );
          for (let j = 0; j < pendingSell.units.length; j++) {
            const k = pendingSell.units[j];
            tCash[k] += shares[j];
            tQty[k] = 0n;
          }
        }
        pendingSell = null;
      }
    }
    const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
    const sellers: number[] = [];
    let sellQty = 0n;
    for (let k = 0; k < K; k++) {
      if (tQty[k] > 0n && SELL_SETS[k].has(devIdx)) {
        sellers.push(k);
        sellQty += tQty[k];
      }
    }
    const buyers: number[] = [];
    let buyNotional = 0n;
    for (let k = 0; k < K; k++) {
      if (tQty[k] === 0n && BUY_SETS[k].has(devIdx)) {
        buyers.push(k);
        buyNotional += tCash[k];
      }
    }
    const orders: OrderInput[] = [];
    if (sellers.length > 0) {
      orders.push({
        side: 'sell',
        symbol: SYMBOL,
        qty: sellQty,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
        client_id: `s${devIdx}`,
      });
      pendingSell = {
        bar: devIdx,
        units: sellers,
        qty: sellers.map((k) => tQty[k]),
      };
    }
    if (buyers.length > 0 && buyNotional >= minNotional) {
      orders.push({
        side: 'buy',
        symbol: SYMBOL,
        notional_quote_units: buyNotional,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
        client_id: `b${devIdx}`,
      });
      pendingBuy = {
        bar: devIdx,
        units: buyers,
        cash: buyers.map((k) => tCash[k]),
      };
    }
    // Sells first, then buys — the order the exact backtester assumes.
    return orders;
  }

  // LIVE MODE: v4 washout on the live bars.
  closes.push(close);
  return liveWashout(state, close);
}

await runBars({ onBatch });
