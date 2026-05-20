import { describe, it, expect } from "vitest";
import { ethers } from "ethers";
import {
  SEL_INIT_POOL,
  SEL_ADD_OWNERS,
  matchedMethod,
  computePoolId,
  parseCLInitializeEvent,
  parseHookPoolStartedEvent,
  CL_POOL_MANAGER_ABI,
  HOOK_EVENT_ABI,
  isValidPoolId,
  isTxHash,
  pancakePoolUrl,
  bscscanTxUrl,
  bscscanTokenUrl,
  feeToPercent,
  priceFromSqrtX96,
  inversePriceFromSqrtX96,
  formatPrices,
  formatUiNumber,
  shortPoolId,
  formatUiTime,
  humanizeNumberString,
  buildPoolKeyboard,
  iface
} from "../src/core.js";

describe("selectors", () => {
  it("initializePool selector matches the known method id", () => {
    expect(SEL_INIT_POOL).toBe("0x57c036db");
  });
  it("addPoolOwners selector is derived from addPoolOwners(bytes32,address[])", () => {
    expect(iface.getFunction("addPoolOwners").format("sighash")).toBe(
      "addPoolOwners(bytes32,address[])"
    );
    expect(SEL_ADD_OWNERS).toBe("0xfe7815ed");
  });
});

describe("matchedMethod", () => {
  it("detects both methods and rejects others", () => {
    expect(matchedMethod(SEL_INIT_POOL + "00")).toBe("initializePool");
    expect(matchedMethod(SEL_ADD_OWNERS + "00")).toBe("addPoolOwners");
    expect(matchedMethod("0xdeadbeef")).toBe(null);
    expect(matchedMethod("")).toBe(null);
  });
});

describe("computePoolId", () => {
  it("returns a 32-byte keccak hash for valid PoolKey fields", () => {
    const pid = computePoolId(
      "0x365DE036A1F7dcCb621530d517133521debB2013",
      "0x55d398326f99059fF775485246999027B3197955",
      "0xb0bb171D333569CfD28a37F5c5DdDAAa90aD46af",
      "0xa0ffb9c1ce1fe56963b0321b32e7a0302114058b",
      67,
      "0x" + "00".repeat(32)
    );
    expect(pid).toMatch(/^0x[0-9a-f]{64}$/);
  });
  it("is deterministic", () => {
    const args = [
      "0x365DE036A1F7dcCb621530d517133521debB2013",
      "0x55d398326f99059fF775485246999027B3197955",
      "0xb0bb171D333569CfD28a37F5c5DdDAAa90aD46af",
      "0xa0ffb9c1ce1fe56963b0321b32e7a0302114058b",
      67,
      "0x" + "00".repeat(32)
    ];
    expect(computePoolId(...args)).toBe(computePoolId(...args));
  });
  it("returns null on bad input", () => {
    expect(computePoolId("not-an-address", "x", "y", "z", 0, "0x")).toBe(null);
  });
});

describe("decode addPoolOwners", () => {
  it("round-trips poolId and owners", () => {
    const poolId = "0xae74941d0ff92e1e6c26a11fa0762ef29b87786e60daf62be00477288ec41abd";
    const owners = ["0xB62Abc6D40DDF8127a319c8B987a0017aAe18756"];
    const data = iface.encodeFunctionData("addPoolOwners", [poolId, owners]);
    expect(data.toLowerCase().startsWith(SEL_ADD_OWNERS)).toBe(true);
    const parsed = iface.parseTransaction({ data, value: 0 });
    expect(String(parsed.args.poolId).toLowerCase()).toBe(poolId);
    expect(parsed.args.owners[0].toLowerCase()).toBe(owners[0].toLowerCase());
  });
});

describe("parseCLInitializeEvent", () => {
  const mgrIface = new ethers.Interface(CL_POOL_MANAGER_ABI);
  const poolManager = "0xa0ffb9c1ce1fe56963b0321b32e7a0302114058b";
  const poolId = "0xae74941d0ff92e1e6c26a11fa0762ef29b87786e60daf62be00477288ec41abd";
  const currency0 = "0x365DE036A1F7dcCb621530d517133521debB2013";
  const currency1 = "0x55d398326f99059fF775485246999027B3197955";
  const hooks = "0xb0bb171D333569CfD28a37F5c5DdDAAa90aD46af";
  const encoded = mgrIface.encodeEventLog("Initialize", [
    poolId,
    currency0,
    currency1,
    hooks,
    67,
    "0x" + "00".repeat(32),
    "97034285709124592626698884",
    -134108
  ]);
  const log = { address: poolManager, topics: encoded.topics, data: encoded.data };

  it("extracts the real poolId / fee from the event (not the Hook input)", () => {
    const r = parseCLInitializeEvent([log], poolManager);
    expect(r.poolId).toBe(poolId.toLowerCase());
    expect(r.fee).toBe(67n);
    expect(r.currency0.toLowerCase()).toBe(currency0.toLowerCase());
    expect(r.currency1.toLowerCase()).toBe(currency1.toLowerCase());
    expect(r.sqrtPriceX96).toBe(97034285709124592626698884n);
  });
  it("falls back to scanning all logs when poolManager address differs", () => {
    const r = parseCLInitializeEvent([log], "0x0000000000000000000000000000000000000001");
    expect(r.poolId).toBe(poolId.toLowerCase());
  });
  it("returns null when there is no Initialize log", () => {
    expect(parseCLInitializeEvent([], poolManager)).toBe(null);
    expect(parseCLInitializeEvent(null, poolManager)).toBe(null);
  });
});

describe("parseHookPoolStartedEvent", () => {
  const hookIface = new ethers.Interface(HOOK_EVENT_ABI);
  const hook = "0xb0bb171D333569CfD28a37F5c5DdDAAa90aD46af";
  const poolId = "0xae74941d0ff92e1e6c26a11fa0762ef29b87786e60daf62be00477288ec41abd";
  const operator = "0xb55eDCBEc988931a1f25f541B1C09F7AB817CD9E";

  it("topic0 matches the on-chain PoolStartedAtUpdated event", () => {
    expect(hookIface.getEvent("PoolStartedAtUpdated").topicHash.toLowerCase()).toBe(
      "0xcaccc4bc886d75b13de806bf4292e4cc78a042eae40849e6a96242f7d03cb5fb"
    );
  });
  it("extracts poolId and accurate startedTimestamp", () => {
    const enc = hookIface.encodeEventLog("PoolStartedAtUpdated", [poolId, 1779285600, operator]);
    const log = { address: hook, topics: enc.topics, data: enc.data };
    const r = parseHookPoolStartedEvent([log], hook);
    expect(r.poolId).toBe(poolId.toLowerCase());
    expect(r.startedTimestamp).toBe(1779285600n);
    expect(r.operator.toLowerCase()).toBe(operator.toLowerCase());
  });
});

describe("url helpers", () => {
  const pid = "0xae74941d0ff92e1e6c26a11fa0762ef29b87786e60daf62be00477288ec41abd";
  it("validates poolId", () => {
    expect(isValidPoolId(pid)).toBe(true);
    expect(isValidPoolId("0x123")).toBe(false);
  });
  it("builds pancake url only for valid poolId", () => {
    expect(pancakePoolUrl(pid)).toBe(`https://pancakeswap.finance/liquidity/pool/bsc/${pid}`);
    expect(pancakePoolUrl("0x123")).toBe(null);
  });
  it("rejects zero / malformed tx hashes", () => {
    expect(isTxHash("0x" + "0".repeat(64))).toBe(false);
    expect(isTxHash("0x" + "a".repeat(64))).toBe(true);
    expect(bscscanTxUrl("0x" + "0".repeat(64))).toBe(null);
  });
  it("checksums token urls", () => {
    expect(bscscanTokenUrl("0x55d398326f99059ff775485246999027b3197955")).toBe(
      "https://bscscan.com/token/0x55d398326f99059fF775485246999027B3197955"
    );
    expect(bscscanTokenUrl("garbage")).toBe(null);
  });
});

describe("feeToPercent", () => {
  it("converts v3 fee units", () => {
    expect(feeToPercent(2500)).toBe("0.25%");
    expect(feeToPercent(100)).toBe("0.01%");
    expect(feeToPercent(67)).toBe("0.0067%");
  });
});

describe("price math (real NEX/BSC-USD pool)", () => {
  // Initialize 事件里的 sqrtPriceX96，token0=NEX(18) token1=BSC-USD(18)
  const sqrt = "97034285709124592626698884";
  it("forward ~ 0.0000015 BSC-USD per NEX", () => {
    const fwd = Number(priceFromSqrtX96(sqrt, 18, 18));
    expect(fwd).toBeGreaterThan(1e-6);
    expect(fwd).toBeLessThan(2e-6);
  });
  it("inverse ~ 666,666 NEX per BSC-USD", () => {
    const inv = Number(inversePriceFromSqrtX96(sqrt, 18, 18));
    expect(inv).toBeGreaterThan(600000);
    expect(inv).toBeLessThan(700000);
  });
  it("formatPrices humanizes both directions", () => {
    const p = formatPrices(sqrt, 18, 18);
    expect(Number(p.forward)).toBeCloseTo(0.0000015, 8);
    expect(p.inverse).toContain(",");
  });
});

describe("formatUiNumber", () => {
  it("uses 2 significant figures for tiny values", () => {
    expect(formatUiNumber(0.0000015, 8)).toBe("0.0000015");
  });
  it("uses thousands separators for large values", () => {
    expect(formatUiNumber(666666.666, 2)).toBe("666,666.67");
    expect(formatUiNumber(1000, 2)).toBe("1,000");
  });
  it("handles zero and non-finite", () => {
    expect(formatUiNumber(0)).toBe("0");
    expect(formatUiNumber("x")).toBe("x");
  });
});

describe("shortPoolId", () => {
  it("keeps head and tail of a poolId", () => {
    const pid = "0xae74941d0ff92e1e6c26a11fa0762ef29b87786e60daf62be00477288ec41abd";
    expect(shortPoolId(pid)).toBe("0xae74941d...8ec41abd");
  });
});

describe("formatUiTime", () => {
  it("formats Beijing time without seconds and labels it with UTC offset", () => {
    // 1779285600 = 2026-05-20 22:00 (UTC+8)
    expect(formatUiTime(1779285600, "Asia/Shanghai")).toBe("2026/05/20 22:00 北京 (UTC+8)");
  });
});

describe("humanizeNumberString", () => {
  it("adds thousands separators and trims decimals", () => {
    expect(humanizeNumberString("1234567.8900", 2)).toBe("1,234,567.89");
    expect(humanizeNumberString("1000", 2)).toBe("1,000");
    expect(humanizeNumberString("0.0000015", 12)).toBe("0.0000015");
  });
});

describe("buildPoolKeyboard", () => {
  const pid = "0xae74941d0ff92e1e6c26a11fa0762ef29b87786e60daf62be00477288ec41abd";
  const realTx = "0x5db301b4c278b6eb54d6c361f8c5a6bd459fbc3c3caedccca8c1912285195456";
  it("includes pool + tx buttons", () => {
    const kb = buildPoolKeyboard({ poolId: pid, txHash: realTx });
    expect(kb.inline_keyboard[0]).toHaveLength(2);
  });
  it("drops the BscScan button for the zero-hash sample", () => {
    const kb = buildPoolKeyboard({ poolId: pid, txHash: "0x" + "0".repeat(64) });
    expect(kb.inline_keyboard[0]).toHaveLength(1);
  });
  it("adds a filtered second row", () => {
    const kb = buildPoolKeyboard({
      poolId: pid,
      txHash: realTx,
      secondRow: [
        {
          text: "Token0",
          url: "https://bscscan.com/token/0x0000000000000000000000000000000000000001"
        },
        { text: "bad", url: null }
      ]
    });
    expect(kb.inline_keyboard).toHaveLength(2);
    expect(kb.inline_keyboard[1]).toHaveLength(1);
  });
  it("returns undefined when nothing to show", () => {
    expect(buildPoolKeyboard({ poolId: null, txHash: "0x" + "0".repeat(64) })).toBeUndefined();
  });
});
