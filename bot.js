import "dotenv/config";
import { ethers } from "ethers";
import fs from "node:fs/promises";

const {
  RPC_URL,
  TG_BOT_TOKEN,
  TG_CHAT_ID,
  TARGET_CONTRACT = "0xb0bb171D333569CfD28a37F5c5DdDAAa90aD46af",
  FILTER_FROM = "0xb55eDCBEc988931a1f25f541B1C09F7AB817CD9E",
  START_BLOCK,
  POLL_MS = "3000",
  MAX_BLOCKS_PER_TICK = "20",
  TIMEZONE = "Asia/Taipei",
  // Railway 文件系统是临时的，重启后会丢失。想持久化游标，
  // 可挂载 Railway Volume 并把 CURSOR_FILE 指向挂载路径，例如 /data/lastBlock.txt
  CURSOR_FILE = "./lastBlock.txt"
} = process.env;

if (!RPC_URL) throw new Error("缺少 RPC_URL");
if (!TG_BOT_TOKEN) throw new Error("缺少 TG_BOT_TOKEN");
if (!TG_CHAT_ID) throw new Error("缺少 TG_CHAT_ID");

const provider = new ethers.JsonRpcProvider(RPC_URL);
// ethers 的 Provider 是只读链上连接，可查询 block / transaction / receipt 等信息。
// 这里不用发交易，只扫描新区块。

const INIT_POOL_ABI = [
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
  }
];

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)"
];

const iface = new ethers.Interface(INIT_POOL_ABI);
const methodSelector = iface.getFunction("initializePool").selector.toLowerCase();
const targetContract = ethers.getAddress(TARGET_CONTRACT);
const filterFrom = FILTER_FROM?.trim() ? ethers.getAddress(FILTER_FROM.trim()) : "";

const tokenCache = new Map();

function shortAddr(addr) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatUnixTimestamp(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return String(ts);
  try {
    return (
      new Intl.DateTimeFormat("zh-CN", {
        timeZone: TIMEZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
      }).format(new Date(n * 1000)) + ` (${TIMEZONE})`
    );
  } catch {
    return new Date(n * 1000).toISOString();
  }
}

function formatScaledInteger(value, precision) {
  let v = BigInt(value);
  const negative = v < 0n;
  if (negative) v = -v;
  const s = v.toString().padStart(precision + 1, "0");
  const head = s.slice(0, -precision);
  const tail = s.slice(-precision).replace(/0+$/, "");
  return `${negative ? "-" : ""}${head}${tail ? "." + tail : ""}`;
}

function priceFromSqrtX96(sqrtPriceX96, decimals0, decimals1, precision = 30) {
  const sqrt = BigInt(sqrtPriceX96.toString());
  const scale = 10n ** BigInt(precision);
  // Uniswap/Pancake v3 类公式：
  // rawPrice token1/token0 = sqrtPriceX96^2 / 2^192
  // humanPrice = rawPrice * 10^decimals0 / 10^decimals1
  const numerator = sqrt * sqrt * 10n ** BigInt(decimals0) * scale;
  const denominator = 2n ** 192n * 10n ** BigInt(decimals1);
  return formatScaledInteger(numerator / denominator, precision);
}

function feeToPercent(fee) {
  // v3 常见 fee 单位：100 = 0.01%, 500 = 0.05%, 3000 = 0.3%
  const n = Number(fee);
  if (!Number.isFinite(n)) return String(fee);
  return `${n / 10000}%`;
}

async function readCursor() {
  try {
    const txt = await fs.readFile(CURSOR_FILE, "utf8");
    const n = Number(txt.trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function writeCursor(blockNumber) {
  await fs.writeFile(CURSOR_FILE, String(blockNumber));
}

async function getTokenMeta(address) {
  const addr = ethers.getAddress(address);
  if (tokenCache.has(addr)) return tokenCache.get(addr);
  const c = new ethers.Contract(addr, ERC20_ABI, provider);
  const meta = {
    address: addr,
    symbol: shortAddr(addr),
    decimals: 18
  };
  try {
    meta.symbol = await c.symbol();
  } catch {}
  try {
    meta.decimals = Number(await c.decimals());
  } catch {}
  tokenCache.set(addr, meta);
  return meta;
}

async function sendTelegram(text) {
  const res = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: TG_CHAT_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true
    })
  });
  if (!res.ok) {
    const body = await res.text();
    console.error("Telegram 推送失败:", body);
  }
}

function isTargetTx(tx) {
  const txTo = tx.to ? tx.to.toLowerCase() : "";
  const txFrom = tx.from ? tx.from.toLowerCase() : "";
  const data = (tx.input || tx.data || "").toLowerCase();
  if (txTo !== targetContract.toLowerCase()) return false;
  if (!data.startsWith(methodSelector)) return false;
  if (filterFrom && txFrom !== filterFrom.toLowerCase()) return false;
  return true;
}

async function buildAlertMessage(tx, blockNumber, parsed) {
  const key = parsed.args.key ?? parsed.args[0];
  const currency0 = ethers.getAddress(key.currency0 ?? key[0]);
  const currency1 = ethers.getAddress(key.currency1 ?? key[1]);
  const hooks = ethers.getAddress(key.hooks ?? key[2]);
  const poolManager = ethers.getAddress(key.poolManager ?? key[3]);
  const fee = key.fee ?? key[4];
  const parameters = key.parameters ?? key[5];
  const startTimestamp = parsed.args.startTimestamp ?? parsed.args[1];
  const sqrtPriceX96 = parsed.args.sqrtPriceX96 ?? parsed.args[2];

  const [t0, t1] = await Promise.all([getTokenMeta(currency0), getTokenMeta(currency1)]);

  let priceLine = "";
  try {
    const price = priceFromSqrtX96(sqrtPriceX96, t0.decimals, t1.decimals);
    priceLine = `\n<b>初始价格:</b> 1 ${escapeHtml(t0.symbol)} ≈ <code>${price}</code> ${escapeHtml(
      t1.symbol
    )}`;
  } catch {}

  return [
    `🚨 <b>BSC Initialize Pool 监听到新池</b>`,
    ``,
    `<b>区块:</b> <code>${blockNumber}</code>`,
    `<b>Tx:</b> <a href="https://bscscan.com/tx/${tx.hash}">${shortAddr(tx.hash)}</a>`,
    `<b>From:</b> <code>${ethers.getAddress(tx.from)}</code>`,
    `<b>To:</b> <code>${ethers.getAddress(tx.to)}</code>`,
    ``,
    `<b>Token0:</b> ${escapeHtml(t0.symbol)} <code>${currency0}</code>`,
    `<b>Token1:</b> ${escapeHtml(t1.symbol)} <code>${currency1}</code>`,
    `<b>Hooks:</b> <code>${hooks}</code>`,
    `<b>PoolManager:</b> <code>${poolManager}</code>`,
    `<b>Fee:</b> <code>${fee.toString()}</code>，约 ${feeToPercent(fee)}`,
    `<b>Parameters:</b> <code>${parameters}</code>`,
    ``,
    `<b>StartTimestamp:</b> <code>${startTimestamp.toString()}</code>`,
    `<b>开始时间:</b> ${escapeHtml(formatUnixTimestamp(startTimestamp))}`,
    `<b>sqrtPriceX96:</b> <code>${sqrtPriceX96.toString()}</code>${priceLine}`
  ].join("\n");
}

async function scanBlock(blockNumber) {
  // 直接取完整区块交易，避免每个 tx hash 再单独 getTransaction。
  const block = await provider.send("eth_getBlockByNumber", [
    ethers.toQuantity(blockNumber),
    true
  ]);
  if (!block || !Array.isArray(block.transactions)) return;
  for (const tx of block.transactions) {
    if (!isTargetTx(tx)) continue;
    const receipt = await provider.getTransactionReceipt(tx.hash);
    if (!receipt || receipt.status !== 1) {
      console.log("命中但交易失败或 receipt 未就绪:", tx.hash);
      continue;
    }
    try {
      const parsed = iface.parseTransaction({
        data: tx.input || tx.data,
        value: tx.value ?? 0
      });
      const msg = await buildAlertMessage(tx, blockNumber, parsed);
      await sendTelegram(msg);
      console.log(`[ALERT] block=${blockNumber} tx=${tx.hash}`);
    } catch (err) {
      console.error("解析 initializePool 失败:", tx.hash, err);
    }
  }
}

let busy = false;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    const latest = await provider.getBlockNumber();
    let cursor = await readCursor();
    if (cursor === null) {
      if (START_BLOCK && Number.isFinite(Number(START_BLOCK))) {
        cursor = Number(START_BLOCK) - 1;
      } else {
        cursor = latest;
      }
      await writeCursor(cursor);
      console.log(`初始化游标: ${cursor}`);
      return;
    }
    if (latest <= cursor) return;
    const maxBlocks = Number(MAX_BLOCKS_PER_TICK);
    const toBlock = Math.min(latest, cursor + maxBlocks);
    for (let n = cursor + 1; n <= toBlock; n++) {
      await scanBlock(n);
      await writeCursor(n);
    }
    if (toBlock < latest) {
      console.log(`还有区块积压: cursor=${toBlock}, latest=${latest}`);
    }
  } catch (err) {
    console.error("tick 错误:", err);
  } finally {
    busy = false;
  }
}

async function main() {
  const network = await provider.getNetwork();
  console.log("BSC Initialize Pool TG Bot started");
  console.log("chainId:", network.chainId.toString());
  console.log("targetContract:", targetContract);
  console.log("filterFrom:", filterFrom || "未限制 From，监听所有调用者");
  console.log("methodSelector:", methodSelector);
  console.log("cursorFile:", CURSOR_FILE);
  if (network.chainId !== 56n) {
    console.warn("警告：当前 RPC chainId 不是 56，可能不是 BSC 主网。");
  }
  await tick();
  setInterval(tick, Number(POLL_MS));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
