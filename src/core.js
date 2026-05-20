import { ethers } from "ethers";

export const PANCAKE_POOL_BASE = "https://pancakeswap.finance/liquidity/pool/bsc";
export const BSCSCAN_BASE = "https://bscscan.com";

// ---------------- ABI / selectors ----------------

export const HOOK_ABI = [
  {
    type: "function",
    name: "initializePool",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "key",
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "hooks", type: "address" },
          { name: "poolManager", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "parameters", type: "bytes32" }
        ]
      },
      { name: "startTimestamp", type: "uint256" },
      { name: "sqrtPriceX96", type: "uint160" }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "addPoolOwners",
    stateMutability: "nonpayable",
    inputs: [
      { name: "poolId", type: "bytes32" },
      { name: "owners", type: "address[]" }
    ],
    outputs: []
  }
];

export const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)"
];

// PancakeSwap Infinity CL Pool Manager：读取当前价格 / tick / fee
export const CL_POOL_MANAGER_ABI = [
  "function getSlot0(bytes32 id) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)"
];

export const iface = new ethers.Interface(HOOK_ABI);
const abiCoder = ethers.AbiCoder.defaultAbiCoder();
export const SEL_INIT_POOL = iface.getFunction("initializePool").selector.toLowerCase();
export const SEL_ADD_OWNERS = iface.getFunction("addPoolOwners").selector.toLowerCase();

// 返回命中的方法名（initializePool / addPoolOwners）或 null
export function matchedMethod(data) {
  const d = (data || "").toLowerCase();
  if (d.startsWith(SEL_INIT_POOL)) return "initializePool";
  if (d.startsWith(SEL_ADD_OWNERS)) return "addPoolOwners";
  return null;
}

// PancakeSwap Infinity poolId = keccak256(abi.encode(PoolKey))
export function computePoolId(currency0, currency1, hooks, poolManager, fee, parameters) {
  try {
    return ethers
      .keccak256(
        abiCoder.encode(
          ["address", "address", "address", "address", "uint24", "bytes32"],
          [currency0, currency1, hooks, poolManager, fee, parameters]
        )
      )
      .toLowerCase();
  } catch {
    return null;
  }
}

// ---------------- URL helpers ----------------

export function isValidPoolId(poolId) {
  return /^0x[a-fA-F0-9]{64}$/.test(String(poolId));
}

export function isTxHash(hash) {
  return typeof hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(hash) && !/^0x0+$/.test(hash);
}

export function pancakePoolUrl(poolId) {
  return isValidPoolId(poolId) ? `${PANCAKE_POOL_BASE}/${String(poolId).toLowerCase()}` : null;
}

export function bscscanTxUrl(txHash) {
  return isTxHash(txHash) ? `${BSCSCAN_BASE}/tx/${txHash}` : null;
}

export function bscscanAddressUrl(address) {
  try {
    return `${BSCSCAN_BASE}/address/${ethers.getAddress(address)}`;
  } catch {
    return null;
  }
}

export function bscscanTokenUrl(address) {
  try {
    return `${BSCSCAN_BASE}/token/${ethers.getAddress(address)}`;
  } catch {
    return null;
  }
}

// ---------------- formatting ----------------

export function shortAddr(addr) {
  const s = String(addr);
  return `${s.slice(0, 6)}...${s.slice(-4)}`;
}

export function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function formatUnixTimestamp(ts, timezone = "Asia/Taipei") {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return String(ts);
  try {
    return (
      new Intl.DateTimeFormat("zh-CN", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
      }).format(new Date(n * 1000)) + ` (${timezone})`
    );
  } catch {
    return new Date(n * 1000).toISOString();
  }
}

export function formatScaledInteger(value, precision) {
  let v = BigInt(value);
  const negative = v < 0n;
  if (negative) v = -v;
  const s = v.toString().padStart(precision + 1, "0");
  const head = s.slice(0, -precision);
  const tail = s.slice(-precision).replace(/0+$/, "");
  return `${negative ? "-" : ""}${head}${tail ? "." + tail : ""}`;
}

// 给十进制字符串加千分位、并限制小数位（用于价格展示）
export function humanizeNumberString(s, maxDecimals = 10) {
  if (s == null) return s;
  let str = String(s);
  const negative = str.startsWith("-");
  if (negative) str = str.slice(1);
  let [intPart, fracPart = ""] = str.split(".");
  intPart = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  fracPart = fracPart.slice(0, maxDecimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${fracPart ? `${intPart}.${fracPart}` : intPart}`;
}

// rawPrice token1/token0 = sqrtPriceX96^2 / 2^192，再按 decimals 换算
export function priceFromSqrtX96(sqrtPriceX96, decimals0, decimals1, precision = 30) {
  const sqrt = BigInt(sqrtPriceX96.toString());
  const scale = 10n ** BigInt(precision);
  const numerator = sqrt * sqrt * 10n ** BigInt(decimals0) * scale;
  const denominator = 2n ** 192n * 10n ** BigInt(decimals1);
  return formatScaledInteger(numerator / denominator, precision);
}

export function inversePriceFromSqrtX96(sqrtPriceX96, decimals0, decimals1, precision = 30) {
  const sqrt = BigInt(sqrtPriceX96.toString());
  if (sqrt === 0n) return null;
  const scale = 10n ** BigInt(precision);
  const numerator = 2n ** 192n * 10n ** BigInt(decimals1) * scale;
  const denominator = sqrt * sqrt * 10n ** BigInt(decimals0);
  return formatScaledInteger(numerator / denominator, precision);
}

// 返回 { forward, inverse } 两个方向的人类可读价格
export function formatPrices(sqrtPriceX96, decimals0, decimals1) {
  try {
    return {
      forward: humanizeNumberString(priceFromSqrtX96(sqrtPriceX96, decimals0, decimals1), 12),
      inverse: humanizeNumberString(inversePriceFromSqrtX96(sqrtPriceX96, decimals0, decimals1), 6)
    };
  } catch {
    return null;
  }
}

export function feeToPercent(fee) {
  const n = Number(fee);
  if (!Number.isFinite(n)) return String(fee);
  return `${n / 10000}%`;
}

export function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [d ? `${d}天` : "", h ? `${h}时` : "", m ? `${m}分` : "", `${sec}秒`]
    .filter(Boolean)
    .join("");
}

// ---------------- Telegram inline keyboard ----------------

// secondRow: [{ text, url }]，url 为空的按钮会被过滤
export function buildPoolKeyboard({ poolId, txHash, secondRow = [] } = {}) {
  const rows = [];
  const r1 = [];
  const purl = pancakePoolUrl(poolId);
  if (purl) r1.push({ text: "🥞 Pancake Pool", url: purl });
  const turl = bscscanTxUrl(txHash);
  if (turl) r1.push({ text: "🔎 BscScan Tx", url: turl });
  if (r1.length) rows.push(r1);
  const r2 = (secondRow || []).filter((b) => b && b.url);
  if (r2.length) rows.push(r2);
  return rows.length ? { inline_keyboard: rows } : undefined;
}
