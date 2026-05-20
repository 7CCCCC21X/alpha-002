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
  POLL_MS = "30000",
  MAX_BLOCKS_PER_TICK = "40",
  TIMEZONE = "Asia/Taipei",
  // Railway 文件系统是临时的，重启后会丢失。想持久化游标，
  // 可挂载 Railway Volume 并把 CURSOR_FILE 指向挂载路径，例如 /data/lastBlock.txt
  CURSOR_FILE = "./lastBlock.txt",
  // 白名单 TG 用户 ID，逗号分隔。只有这些用户能用控制命令（/status /test /preview）。
  // 留空 = 没有人能控制（任何人都可用 /id 查到自己的 ID 再加进来）。
  WHITELIST_IDS = ""
} = process.env;

if (!RPC_URL) throw new Error("缺少 RPC_URL");
if (!TG_BOT_TOKEN) throw new Error("缺少 TG_BOT_TOKEN");
if (!TG_CHAT_ID) throw new Error("缺少 TG_CHAT_ID");

// TG_CHAT_ID 支持逗号分隔多个会话（私聊 / 群 / 频道），告警会推给每一个。
const alertChatIds = String(TG_CHAT_ID)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// 控制命令白名单
const whitelist = new Set(
  String(WHITELIST_IDS)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

const startedAt = Date.now();
let botUsername = "";
let botId = 0;

const provider = new ethers.JsonRpcProvider(RPC_URL);
// ethers 的 Provider 是只读链上连接，可查询 block / transaction / receipt 等信息。
// 这里不用发交易，只扫描新区块。

const HOOK_ABI = [
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

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)"
];

const iface = new ethers.Interface(HOOK_ABI);
const abiCoder = ethers.AbiCoder.defaultAbiCoder();
const SEL_INIT_POOL = iface.getFunction("initializePool").selector.toLowerCase();
const SEL_ADD_OWNERS = iface.getFunction("addPoolOwners").selector.toLowerCase();
const targetContract = ethers.getAddress(TARGET_CONTRACT);
const filterFrom = FILTER_FROM?.trim() ? ethers.getAddress(FILTER_FROM.trim()) : "";

// PancakeSwap Infinity poolId = keccak256(abi.encode(PoolKey))，用于把
// initializePool 看到的币对缓存起来，addPoolOwners 命中同一 poolId 时补充显示。
function computePoolId(currency0, currency1, hooks, poolManager, fee, parameters) {
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

// 返回命中的方法名（initializePool / addPoolOwners）或 null
function matchedMethod(data) {
  const d = (data || "").toLowerCase();
  if (d.startsWith(SEL_INIT_POOL)) return "initializePool";
  if (d.startsWith(SEL_ADD_OWNERS)) return "addPoolOwners";
  return null;
}

function isValidPoolId(poolId) {
  return typeof poolId === "string" && /^0x[a-fA-F0-9]{64}$/.test(poolId);
}

function pancakePoolUrl(poolId) {
  return isValidPoolId(poolId)
    ? `https://pancakeswap.finance/liquidity/pool/bsc/${poolId}`
    : null;
}

function isTxHash(hash) {
  return typeof hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(hash) && !/^0x0+$/.test(hash);
}

// 组装告警消息底部的内联按钮：🥞 Pancake Pool / 🔎 BscScan Tx
function alertButtons(poolId, txHash) {
  const row = [];
  const url = pancakePoolUrl(poolId);
  if (url) row.push({ text: "🥞 Pancake Pool", url });
  if (isTxHash(txHash)) row.push({ text: "🔎 BscScan Tx", url: `https://bscscan.com/tx/${txHash}` });
  return row.length ? { inline_keyboard: [row] } : undefined;
}

const tokenCache = new Map();
// poolId(lowercase) -> { token0, token1, fee, price }
const poolCache = new Map();

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tgApi(method, payload = {}, timeoutMs = 15000) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const data = await res.json().catch(() => ({}));
    if (!data?.ok) console.error(`Telegram ${method} 失败:`, JSON.stringify(data));
    return data;
  } catch (err) {
    console.error(`Telegram ${method} 异常:`, err?.message || err);
    return { ok: false, error: String(err?.message || err) };
  }
}

async function sendMessage(chatId, text, extra = {}) {
  const data = await tgApi("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra
  });
  return Boolean(data?.ok);
}

// 告警推送：发给所有配置的会话
async function sendTelegram(text, extra = {}) {
  for (const chatId of alertChatIds) {
    await sendMessage(chatId, text, extra);
  }
}

function isTargetTx(tx) {
  const txTo = tx.to ? tx.to.toLowerCase() : "";
  const txFrom = tx.from ? tx.from.toLowerCase() : "";
  const data = (tx.input || tx.data || "").toLowerCase();
  if (txTo !== targetContract.toLowerCase()) return false;
  if (!matchedMethod(data)) return false;
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

  let price = null;
  try {
    price = priceFromSqrtX96(sqrtPriceX96, t0.decimals, t1.decimals);
  } catch {}

  const poolId = computePoolId(currency0, currency1, hooks, poolManager, fee, parameters);
  if (poolId) poolCache.set(poolId, { token0: t0, token1: t1, fee, price });

  const poolUrl = pancakePoolUrl(poolId);
  const priceLine =
    price !== null
      ? `\n<b>初始价格:</b> 1 ${escapeHtml(t0.symbol)} ≈ <code>${price}</code> ${escapeHtml(t1.symbol)}`
      : "";

  const text = [
    `🚨 <b>BSC Initialize Pool 监听到新池</b>`,
    ``,
    `<b>区块:</b> <code>${blockNumber}</code>`,
    `<b>Tx:</b> <a href="https://bscscan.com/tx/${tx.hash}">${shortAddr(tx.hash)}</a>`,
    `<b>From:</b> <code>${ethers.getAddress(tx.from)}</code>`,
    `<b>To:</b> <code>${ethers.getAddress(tx.to)}</code>`,
    ``,
    poolId ? `<b>PoolId:</b> <code>${poolId}</code>` : null,
    poolUrl ? `<b>PancakeSwap:</b> <a href="${poolUrl}">Open Pool</a>` : null,
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
  ]
    .filter((line) => line !== null)
    .join("\n");

  return { text, reply_markup: alertButtons(poolId, tx.hash) };
}

async function buildAddOwnersMessage(tx, blockNumber, parsed) {
  const poolId = String(parsed.args.poolId ?? parsed.args[0]).toLowerCase();
  const owners = (parsed.args.owners ?? parsed.args[1] ?? []).map((a) => ethers.getAddress(a));
  const poolUrl = pancakePoolUrl(poolId);

  const lines = [
    `👤 <b>BSC Add Pool Owners 监听到加管理员</b>`,
    ``,
    `<b>区块:</b> <code>${blockNumber}</code>`,
    `<b>Tx:</b> <a href="https://bscscan.com/tx/${tx.hash}">${shortAddr(tx.hash)}</a>`,
    `<b>From:</b> <code>${ethers.getAddress(tx.from)}</code>`,
    `<b>To:</b> <code>${ethers.getAddress(tx.to)}</code>`,
    ``,
    `<b>PoolId:</b> <code>${poolId}</code>`
  ];
  if (poolUrl) lines.push(`<b>PancakeSwap:</b> <a href="${poolUrl}">Open Pool</a>`);

  // 若该 poolId 在本次运行里见过 initializePool，补充币对信息
  const cached = poolCache.get(poolId);
  if (cached) {
    lines.push(
      `<b>Token0:</b> ${escapeHtml(cached.token0.symbol)} <code>${cached.token0.address}</code>`,
      `<b>Token1:</b> ${escapeHtml(cached.token1.symbol)} <code>${cached.token1.address}</code>`,
      `<b>Fee:</b> <code>${cached.fee.toString()}</code>，约 ${feeToPercent(cached.fee)}`
    );
  }

  lines.push(``, `<b>新增 Owners (${owners.length}):</b>`);
  for (const o of owners) lines.push(`• <code>${o}</code>`);

  return { text: lines.join("\n"), reply_markup: alertButtons(poolId, tx.hash) };
}

async function buildMessageForMethod(method, tx, blockNumber, parsed) {
  return method === "addPoolOwners"
    ? buildAddOwnersMessage(tx, blockNumber, parsed)
    : buildAlertMessage(tx, blockNumber, parsed);
}

// poolId 信息卡片：只要有合法 poolId 就能生成 PancakeSwap 链接，币对/价格若缓存过则补充
function buildPoolInfo(poolId) {
  const pid = String(poolId || "").toLowerCase();
  if (!isValidPoolId(pid)) {
    return { text: `⚠️ poolId 格式不对，应为 0x 开头的 64 位十六进制。用法：/pool &lt;poolId&gt;` };
  }
  const url = pancakePoolUrl(pid);
  const lines = [`🔎 <b>Pool Info</b>`, ``];
  const cached = poolCache.get(pid);
  if (cached) {
    lines.push(`<b>Pair:</b> ${escapeHtml(cached.token0.symbol)} / ${escapeHtml(cached.token1.symbol)}`);
  }
  lines.push(`<b>PoolId:</b> <code>${pid}</code>`, `<b>PancakeSwap:</b> <a href="${url}">Open Pool</a>`);
  if (cached?.price != null) {
    lines.push(
      `<b>初始价格:</b> 1 ${escapeHtml(cached.token0.symbol)} ≈ <code>${cached.price}</code> ${escapeHtml(
        cached.token1.symbol
      )}`
    );
  }
  return { text: lines.join("\n"), reply_markup: { inline_keyboard: [[{ text: "🥞 Pancake Pool", url }]] } };
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
    const method = matchedMethod(tx.input || tx.data);
    try {
      const parsed = iface.parseTransaction({
        data: tx.input || tx.data,
        value: tx.value ?? 0
      });
      const { text, reply_markup } = await buildMessageForMethod(method, tx, blockNumber, parsed);
      await sendTelegram(text, reply_markup ? { reply_markup } : {});
      console.log(`[ALERT] method=${method} block=${blockNumber} tx=${tx.hash}`);
    } catch (err) {
      console.error(`解析 ${method} 失败:`, tx.hash, err);
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

// ---------------- 交互命令层（菜单 / 白名单 / 群组） ----------------

function isWhitelisted(userId) {
  return whitelist.size > 0 && whitelist.has(String(userId));
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [d ? `${d}天` : "", h ? `${h}时` : "", m ? `${m}分` : "", `${sec}秒`]
    .filter(Boolean)
    .join("");
}

function buildHelpMessage() {
  return [
    `🤖 <b>BSC Initialize Pool 监听机器人</b>`,
    ``,
    `监听合约 <code>${shortAddr(targetContract)}</code> 上的 <code>initializePool</code> 与 <code>addPoolOwners</code> 调用，`,
    `命中后把新池 / 加管理员信息推送到 Telegram。`,
    ``,
    `<b>命令</b>`,
    `/help - 显示本帮助`,
    `/id - 查看你的 TG 用户 ID 和当前会话 ID`,
    `/status - 查看运行状态（白名单）`,
    `/test - 检查 RPC 与 Telegram 连接（白名单）`,
    `/preview [txHash] - 预览告警消息格式；带 txHash 则预览真实交易（白名单）`,
    `/pool &lt;poolId&gt; - 由 poolId 生成 PancakeSwap 池子链接（白名单）`,
    ``,
    `🔒 控制命令仅限白名单用户。其它人无法控制本机器人。`,
    `👥 群里使用命令请用 <code>/命令@${escapeHtml(botUsername || "机器人用户名")}</code>，或在 BotFather 关闭 Privacy 模式。`
  ].join("\n");
}

async function buildStatusMessage() {
  let latest = null;
  let chainId = "?";
  try {
    latest = await provider.getBlockNumber();
    const net = await provider.getNetwork();
    chainId = net.chainId.toString();
  } catch (err) {
    return `⚠️ 读取链上状态失败: <code>${escapeHtml(err?.message || err)}</code>`;
  }
  const cursor = await readCursor();
  const lag = cursor !== null && latest !== null ? latest - cursor : "?";
  return [
    `📊 <b>运行状态</b>`,
    ``,
    `<b>运行时长:</b> ${formatUptime(Date.now() - startedAt)}`,
    `<b>chainId:</b> <code>${chainId}</code>${chainId === "56" ? " (BSC)" : ""}`,
    `<b>监听合约:</b> <code>${targetContract}</code>`,
    `<b>From 过滤:</b> ${filterFrom ? `<code>${filterFrom}</code>` : "未限制（所有调用者）"}`,
    `<b>监听方法:</b> initializePool <code>${SEL_INIT_POOL}</code> / addPoolOwners <code>${SEL_ADD_OWNERS}</code>`,
    ``,
    `<b>最新区块:</b> <code>${latest}</code>`,
    `<b>已扫描到:</b> <code>${cursor ?? "未初始化"}</code>`,
    `<b>落后:</b> <code>${lag}</code> 个区块`,
    `<b>检查间隔:</b> <code>${Number(POLL_MS) / 1000}</code> 秒`,
    `<b>告警会话:</b> <code>${escapeHtml(alertChatIds.join(", "))}</code>`,
    `<b>白名单人数:</b> <code>${whitelist.size}</code>`
  ].join("\n");
}

async function runConnectivityTest() {
  const lines = [`🔎 <b>连接检查</b>`, ``];

  // RPC
  const t0 = Date.now();
  try {
    const latest = await provider.getBlockNumber();
    const net = await provider.getNetwork();
    lines.push(
      `✅ RPC 正常：最新区块 <code>${latest}</code>，chainId <code>${net.chainId}</code>（${Date.now() - t0}ms）`
    );
    if (net.chainId !== 56n) lines.push(`⚠️ chainId 不是 56，可能不是 BSC 主网。`);
  } catch (err) {
    lines.push(`❌ RPC 失败：<code>${escapeHtml(err?.message || err)}</code>`);
  }

  // Telegram 推送（向所有告警会话发一条测试消息）
  let okCount = 0;
  for (const chatId of alertChatIds) {
    const ok = await sendMessage(chatId, `✅ 测试消息：告警会话 <code>${escapeHtml(chatId)}</code> 推送正常。`);
    if (ok) okCount++;
  }
  lines.push(`📨 告警推送：${okCount}/${alertChatIds.length} 个会话发送成功。`);

  return lines.join("\n");
}

async function buildPreviewSample() {
  // 用真实的 BSC 代币地址构造示例，预览渲染效果（非真实告警）
  const sampleKey = {
    currency0: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", // WBNB
    currency1: "0x55d398326f99059fF775485246999027B3197955", // USDT (BSC)
    hooks: targetContract,
    poolManager: targetContract,
    fee: 2500,
    parameters: "0x" + "00".repeat(32)
  };
  const data = iface.encodeFunctionData("initializePool", [
    sampleKey,
    BigInt(Math.floor(Date.now() / 1000) + 3600),
    1940000000000000000000000000000n
  ]);
  const parsed = iface.parseTransaction({ data, value: 0 });
  const sampleTx = {
    hash: "0x0000000000000000000000000000000000000000000000000000000000000000",
    from: filterFrom || targetContract,
    to: targetContract,
    data
  };
  const m = await buildAlertMessage(sampleTx, "（示例）", parsed);
  return { text: `🔎 <b>预览示例（非真实告警）</b>\n\n${m.text}`, reply_markup: m.reply_markup };
}

async function buildPreviewForTx(txHash) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return { text: `⚠️ txHash 格式不对，应为 0x 开头的 66 位哈希。` };
  }
  let tx;
  try {
    tx = await provider.getTransaction(txHash);
  } catch (err) {
    return { text: `❌ 查询交易失败：<code>${escapeHtml(err?.message || err)}</code>` };
  }
  if (!tx) return { text: `❌ 找不到该交易：<code>${escapeHtml(txHash)}</code>` };

  const txTo = tx.to ? tx.to.toLowerCase() : "";
  const data = (tx.data || "").toLowerCase();
  if (txTo !== targetContract.toLowerCase()) {
    return { text: `⚠️ 该交易的 To 不是目标合约，无法预览。` };
  }
  const method = matchedMethod(data);
  if (!method) {
    return { text: `⚠️ 该交易不是 initializePool / addPoolOwners 调用（方法选择器不匹配）。` };
  }
  try {
    const parsed = iface.parseTransaction({ data: tx.data, value: tx.value ?? 0 });
    const m = await buildMessageForMethod(method, tx, tx.blockNumber ?? "pending", parsed);
    return { text: `🔎 <b>预览（真实交易）</b>\n\n${m.text}`, reply_markup: m.reply_markup };
  } catch (err) {
    return { text: `❌ 解析失败：<code>${escapeHtml(err?.message || err)}</code>` };
  }
}

async function handleUpdate(update) {
  // 被拉进群时打个招呼
  if (update.my_chat_member) {
    const m = update.my_chat_member;
    const status = m.new_chat_member?.status;
    const who = m.new_chat_member?.user;
    if (who && botId && who.id === botId && (status === "member" || status === "administrator")) {
      await sendMessage(
        m.chat.id,
        `👋 我是 BSC InitializePool 监听机器人。发送 /help 查看命令；控制命令仅限白名单用户。`
      );
    }
    return;
  }

  const msg = update.message;
  const text = msg?.text;
  if (!msg || typeof text !== "string" || !text.startsWith("/")) return;

  const chatId = msg.chat.id;
  const userId = msg.from?.id;

  let [cmdRaw, ...args] = text.trim().split(/\s+/);
  let cmd = cmdRaw.toLowerCase();
  // 处理群里的 /命令@机器人用户名
  if (cmd.includes("@")) {
    const [name, mention] = cmd.split("@");
    if (botUsername && mention !== botUsername.toLowerCase()) return; // 指向别的 bot
    cmd = name;
  }

  const requireWhitelist = async () => {
    if (isWhitelisted(userId)) return true;
    await sendMessage(
      chatId,
      `⛔ 你没有权限控制本机器人。\n你的 ID: <code>${userId}</code>，请联系管理员把它加入 WHITELIST_IDS。`
    );
    return false;
  };

  switch (cmd) {
    case "/start":
    case "/help":
      await sendMessage(chatId, buildHelpMessage());
      break;
    case "/id":
      await sendMessage(
        chatId,
        `你的用户 ID: <code>${userId}</code>\n当前会话 ID: <code>${chatId}</code>\n白名单状态: ${
          isWhitelisted(userId) ? "✅ 已授权" : "❌ 未授权"
        }`
      );
      break;
    case "/status":
      if (await requireWhitelist()) await sendMessage(chatId, await buildStatusMessage());
      break;
    case "/test":
    case "/check":
      if (await requireWhitelist()) await sendMessage(chatId, await runConnectivityTest());
      break;
    case "/preview":
      if (await requireWhitelist()) {
        const out = args[0] ? await buildPreviewForTx(args[0]) : await buildPreviewSample();
        await sendMessage(chatId, out.text, out.reply_markup ? { reply_markup: out.reply_markup } : {});
      }
      break;
    case "/pool":
      if (await requireWhitelist()) {
        const out = buildPoolInfo(args[0]);
        await sendMessage(chatId, out.text, out.reply_markup ? { reply_markup: out.reply_markup } : {});
      }
      break;
    default:
      // 未知命令静默忽略，避免群里刷屏
      break;
  }
}

let tgOffset = 0;
async function pollTelegram() {
  // 长轮询 getUpdates，与区块扫描并行运行，无需公网 webhook，适合 Railway。
  while (true) {
    try {
      const data = await tgApi(
        "getUpdates",
        { offset: tgOffset, timeout: 30, allowed_updates: ["message", "my_chat_member"] },
        40000
      );
      if (data?.ok && Array.isArray(data.result)) {
        for (const upd of data.result) {
          tgOffset = upd.update_id + 1;
          try {
            await handleUpdate(upd);
          } catch (err) {
            console.error("处理更新出错:", err?.message || err);
          }
        }
      } else {
        await sleep(2000);
      }
    } catch (err) {
      console.error("getUpdates 循环异常:", err?.message || err);
      await sleep(3000);
    }
  }
}

async function setupTelegram() {
  const me = await tgApi("getMe");
  if (me?.ok) {
    botUsername = me.result.username || "";
    botId = me.result.id || 0;
    console.log("bot:", `@${botUsername}`, `(id=${botId})`);
  } else {
    console.warn("getMe 失败，交互命令可能不可用（检查 TG_BOT_TOKEN）。");
  }
  await tgApi("setMyCommands", {
    commands: [
      { command: "help", description: "显示帮助与命令列表" },
      { command: "id", description: "查看你的 TG ID 和会话 ID" },
      { command: "status", description: "查看机器人运行状态" },
      { command: "test", description: "检查 RPC / Telegram 连接" },
      { command: "preview", description: "预览告警消息（可加 txHash）" },
      { command: "pool", description: "由 poolId 生成 PancakeSwap 池子链接" }
    ]
  });
  console.log("whitelist:", whitelist.size ? [...whitelist].join(", ") : "（空，暂无人可控制）");
}

async function main() {
  const network = await provider.getNetwork();
  console.log("BSC Initialize Pool TG Bot started");
  console.log("chainId:", network.chainId.toString());
  console.log("targetContract:", targetContract);
  console.log("filterFrom:", filterFrom || "未限制 From，监听所有调用者");
  console.log("selectors:", { initializePool: SEL_INIT_POOL, addPoolOwners: SEL_ADD_OWNERS });
  console.log("cursorFile:", CURSOR_FILE);
  console.log("pollMs:", POLL_MS);
  if (network.chainId !== 56n) {
    console.warn("警告：当前 RPC chainId 不是 56，可能不是 BSC 主网。");
  }

  // 交互命令层（菜单 / 白名单 / 群组），best-effort：失败不影响区块扫描
  try {
    await setupTelegram();
    pollTelegram();
  } catch (err) {
    console.error("初始化 Telegram 交互层失败:", err?.message || err);
  }

  await tick();
  setInterval(tick, Number(POLL_MS));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
