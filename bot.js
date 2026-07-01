import "dotenv/config";
import { ethers } from "ethers";
import fs from "node:fs/promises";
import {
  ERC20_ABI,
  CL_POOL_MANAGER_ABI,
  iface,
  SEL_INIT_POOL,
  SEL_ADD_OWNERS,
  SEL_SET_STARTED,
  matchedMethod,
  computePoolId,
  parseCLInitializeEvent,
  parseHookPoolStartedEvent,
  isValidPoolId,
  pancakePoolUrl,
  bscscanAddressUrl,
  bscscanTokenUrl,
  shortAddr,
  shortPoolId,
  escapeHtml,
  formatUiTime,
  feeToPercent,
  formatUptime,
  formatPrices,
  buildPoolKeyboard
} from "./src/core.js";

const {
  RPC_URL,
  TG_BOT_TOKEN,
  TG_CHAT_ID = "",
  // 监听的合约（CLAlphaHook）的 To。留空 = 不限合约（只靠 FILTER_FROM 盯操作钱包，
  // 钱包换合约也不会漏）。也可逗号分隔多个地址来限定范围。
  TARGET_CONTRACT = "",
  // 操作钱包：盯这个地址发起的建池/加管理员/设开盘调用。这是主过滤条件。
  FILTER_FROM = "0xb55eDCBEc988931a1f25f541B1C09F7AB817CD9E",
  START_BLOCK,
  // 每隔 POLL_MS 毫秒轮询一次数据源，查目标地址的交易（不再逐块拉 RPC）
  POLL_MS = "10000",
  // 数据源：怎么发现目标地址的交易，取代逐块 eth_getBlockByNumber。
  //   DATA_SOURCE=nodereal  → NodeReal 免费索引 API 列出钱包交易，再用 RPC 补全（推荐，BSC 免费额度内）
  //   DATA_SOURCE=rpc       → 逐块拉 eth_getBlockByNumber（免费/自建 RPC 零成本，无需 Key）
  //   DATA_SOURCE=ankr      → Ankr Advanced API（需该 Key 开通 Advanced API 权限）
  //   DATA_SOURCE=etherscan → Etherscan V2 txlist（需付费计划才含 BSC）
  DATA_SOURCE = "nodereal",
  // 仅 DATA_SOURCE=rpc：逐块模式单轮最多扫多少块
  RPC_MAX_BLOCKS_PER_TICK = "200",
  // 仅 DATA_SOURCE=nodereal：MegaNode 端点 + 免费 API Key（https://nodereal.io 注册获取）
  NODEREAL_API = "https://bsc-mainnet.nodereal.io/v1",
  NODEREAL_API_KEY = "",
  // —— Ankr Advanced API（DATA_SOURCE=ankr 时用）——
  // ANKR_API_KEY 留空则自动从 RPC_URL（形如 https://rpc.ankr.com/bsc/<KEY>）里提取。
  ANKR_ADVANCED_API = "https://rpc.ankr.com/multichain",
  ANKR_API_KEY = "",
  ANKR_BLOCKCHAIN = "bsc",
  // —— Etherscan V2 / BscScan（DATA_SOURCE=etherscan 时用）——
  EXPLORER_API = "https://api.etherscan.io/v2/api",
  EXPLORER_API_KEY = "",
  EXPLORER_CHAIN_ID = "56",
  // 确认数，避免链重组：只处理已过 N 个确认的块
  CONFIRMATIONS = "3",
  TIMEZONE = "Asia/Shanghai",
  // Railway 文件系统是临时的，重启会丢失。想持久化，挂 Volume 后把这几个指向挂载点。
  CURSOR_FILE = "./lastBlock.txt",
  POOLS_FILE = "./pools.json",
  SUBSCRIBERS_FILE = "./subscribers.json",
  RPC_TIMEOUT_MS = "15000",
  // 消息结尾的社群引流（留空 COMMUNITY_URL 则不显示）
  COMMUNITY_NAME = "小C聊天群",
  COMMUNITY_URL = "https://t.me/xiaoc236",
  // 控制命令白名单（TG 用户 ID，逗号分隔）。留空 = 没人能控制。
  WHITELIST_IDS = ""
} = process.env;

// 消息结尾的社群引流页脚（告警 / 预览都会带上）
function communityFooter() {
  if (!COMMUNITY_URL) return "";
  return `\n\n👥 加入<a href="${COMMUNITY_URL}">${escapeHtml(COMMUNITY_NAME)}</a> 获取最新币安Alpha消息`;
}

if (!RPC_URL) throw new Error("缺少 RPC_URL");
if (!TG_BOT_TOKEN) throw new Error("缺少 TG_BOT_TOKEN");

// 环境变量里固定配置的告警会话（始终接收）
const envChatIds = String(TG_CHAT_ID)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// 动态订阅的会话：chatId(string) -> { id, name, type, addedAt }
const subscribers = new Map();

const whitelist = new Set(
  String(WHITELIST_IDS)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

const rpcTimeoutMs = Number(RPC_TIMEOUT_MS) || 15000;
const confirmations = Math.max(0, Number(CONFIRMATIONS) || 0);

const provider = new ethers.JsonRpcProvider(RPC_URL);
// 限定的合约集合（小写）。空 = 不限合约。
const targetContracts = new Set(
  String(TARGET_CONTRACT)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((a) => ethers.getAddress(a).toLowerCase())
);
const filterFrom = FILTER_FROM?.trim() ? ethers.getAddress(FILTER_FROM.trim()) : "";
// 示例 / 展示用的代表合约（仅用于 /preview 示例和链接兜底）
const SAMPLE_HOOK = [...targetContracts][0] || "0xb0BAa371b899950B4Ef6A27c21bAf5ef7c434d0f";

// 数据源：nodereal（免费索引 API，推荐）| rpc（逐块扫描）| ankr（Advanced API）| etherscan（V2 txlist）
const _ds = String(DATA_SOURCE).trim().toLowerCase();
const dataSource = ["rpc", "ankr", "etherscan", "nodereal"].includes(_ds) ? _ds : "nodereal";
// 逐块模式单轮最多扫多少块（须高于出块速度以清积压；BSC 约 13 块/10 秒）
const rpcMaxBlocksPerTick = Math.max(1, Number(RPC_MAX_BLOCKS_PER_TICK) || 200);

// NodeReal MegaNode Enhanced API（nr_getTransactionByAddress）
const noderealApi = String(NODEREAL_API).trim().replace(/\/+$/, "");
const noderealKey = String(NODEREAL_API_KEY).trim();

// Etherscan V2 / BscScan
const explorerApi = String(EXPLORER_API).trim();
const explorerKey = String(EXPLORER_API_KEY).trim();
const explorerChainId = String(EXPLORER_CHAIN_ID).trim() || "56";
let explorerHost = explorerApi;
try {
  explorerHost = new URL(explorerApi).host;
} catch {}

// Ankr Advanced API（key 缺省时从 RPC_URL 里兜底提取）
const ankrAdvApi = String(ANKR_ADVANCED_API).trim().replace(/\/+$/, "");
const ankrBlockchain = String(ANKR_BLOCKCHAIN).trim() || "bsc";
const ankrKey =
  String(ANKR_API_KEY).trim() ||
  (String(RPC_URL).match(/rpc\.ankr\.com\/[^/]+\/([A-Za-z0-9]+)/)?.[1] ?? "");

// 数据源显示名 & 是否缺 Key（供 /status 与启动日志）
const DATA_SOURCE_LABELS = {
  nodereal: "NodeReal Enhanced API",
  ankr: "Ankr Advanced API",
  etherscan: explorerHost,
  rpc: "RPC 逐块扫描"
};
const dataSourceLabel = DATA_SOURCE_LABELS[dataSource];
const dataSourceKeyMissing =
  dataSource === "nodereal"
    ? !noderealKey
    : dataSource === "ankr"
      ? !ankrKey
      : dataSource === "etherscan"
        ? !explorerKey
        : false;

// 轮询交易的地址：优先盯操作钱包(From)；未设钱包则退回盯目标合约。
const watchAddresses = filterFrom ? [filterFrom] : [...targetContracts];

// To 是否在监听范围内：未限定合约时恒为 true
function isWatchedContract(to) {
  if (targetContracts.size === 0) return true;
  return targetContracts.has((to || "").toLowerCase());
}

if (!filterFrom && targetContracts.size === 0) {
  console.warn(
    "⚠️ FILTER_FROM 和 TARGET_CONTRACT 都为空：没有可轮询的地址，将收不到任何告警。请至少设置其一。"
  );
}
if (dataSource === "nodereal" && !noderealKey) {
  console.warn(
    "⚠️ DATA_SOURCE=nodereal 但没有 NODEREAL_API_KEY：请去 https://nodereal.io 免费注册获取并填入。"
  );
}
if (dataSource === "ankr" && !ankrKey) {
  console.warn(
    "⚠️ DATA_SOURCE=ankr 但没有 Ankr Key：请设置 ANKR_API_KEY，或把 RPC_URL 换成带 key 的 Ankr 端点。"
  );
}
if (dataSource === "etherscan" && !explorerKey) {
  console.warn(
    "⚠️ DATA_SOURCE=etherscan 但未设 EXPLORER_API_KEY：限速很低；且 Etherscan 免费版已不支持 BSC，需付费计划。"
  );
}

const tokenCache = new Map();
// poolId(lowercase) -> poolInfo
const poolCache = new Map();

// 运行期状态（供 /status /last 使用）
const startedAt = Date.now();
let botUsername = "";
let botId = 0;
let lastRpcLatencyMs = null;
let lastExplorerLatencyMs = null;
let lastExplorerError = null;
let lastAlert = null;
let lastPush = { ok: 0, total: 0 };
const recentAlerts = [];
// /resync 请求的新游标；tick 在下一轮开始时消费，并中断当前正在进行的扫描
let pendingResync = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms, label = "operation") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

// ---------------- Telegram ----------------

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

// 发送成功返回 Telegram 的 Message 对象（含 message_id），失败返回 null
async function sendMessage(chatId, text, extra = {}) {
  const data = await tgApi("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra
  });
  return data?.ok ? data.result : null;
}

async function sendMessageWithRetry(chatId, text, extra = {}, retries = 3) {
  for (let i = 0; i < retries; i++) {
    const sent = await sendMessage(chatId, text, extra);
    if (sent) return sent;
    await sleep(1000 * (i + 1));
  }
  return null;
}

// key: `${chatId}:${poolId}` -> 初始化消息的 message_id，用于让 addPoolOwners 回复初始化消息
const poolMessageIds = new Map();
function poolMessageKey(chatId, poolId) {
  return `${String(chatId)}:${String(poolId).toLowerCase()}`;
}

// 实际收件会话 = 环境变量配置的 + 动态订阅的（去重）
function recipientChatIds() {
  return [...new Set([...envChatIds, ...subscribers.keys()])];
}

// 告警推送：发给所有收件会话，返回成功数。
// options: { poolId, rememberPoolMessage, replyToPoolMessage }
async function sendTelegram(text, extra = {}, options = {}) {
  const { poolId, rememberPoolMessage = false, replyToPoolMessage = false } = options;
  const recipients = recipientChatIds();
  let ok = 0;
  for (const chatId of recipients) {
    const finalExtra = { ...extra };
    if (replyToPoolMessage && poolId) {
      const mid = poolMessageIds.get(poolMessageKey(chatId, poolId));
      if (mid) finalExtra.reply_parameters = { message_id: mid, allow_sending_without_reply: true };
    }
    const sent = await sendMessageWithRetry(chatId, text, finalExtra);
    if (sent) {
      ok++;
      if (rememberPoolMessage && poolId) {
        poolMessageIds.set(poolMessageKey(chatId, poolId), sent.message_id);
      }
    }
  }
  lastPush = { ok, total: recipients.length };
  return ok;
}

// ---------------- token / pool 数据 ----------------

async function getTokenMeta(address) {
  const addr = ethers.getAddress(address);
  if (tokenCache.has(addr)) return tokenCache.get(addr);
  const c = new ethers.Contract(addr, ERC20_ABI, provider);
  const meta = { address: addr, symbol: shortAddr(addr), decimals: 18 };
  try {
    meta.symbol = await withTimeout(c.symbol(), rpcTimeoutMs, "symbol");
  } catch {}
  try {
    meta.decimals = Number(await withTimeout(c.decimals(), rpcTimeoutMs, "decimals"));
  } catch {}
  tokenCache.set(addr, meta);
  return meta;
}

async function getCurrentPoolPrice(poolInfo) {
  if (!poolInfo?.poolManager || !poolInfo?.poolId) return null;
  try {
    const mgr = new ethers.Contract(poolInfo.poolManager, CL_POOL_MANAGER_ABI, provider);
    const slot0 = await withTimeout(mgr.getSlot0(poolInfo.poolId), rpcTimeoutMs, "getSlot0");
    const sqrtPriceX96 = slot0[0] ?? slot0.sqrtPriceX96;
    const tick = slot0[1] ?? slot0.tick;
    const price = formatPrices(sqrtPriceX96, poolInfo.token0.decimals, poolInfo.token1.decimals);
    return { sqrtPriceX96: sqrtPriceX96.toString(), tick: tick.toString(), price };
  } catch (err) {
    console.error("getSlot0 失败:", err?.message || err);
    return null;
  }
}

// ---------------- 游标 / 池子持久化 ----------------

async function readCursor() {
  try {
    const n = Number((await fs.readFile(CURSOR_FILE, "utf8")).trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function writeCursor(blockNumber) {
  await fs.writeFile(CURSOR_FILE, String(blockNumber));
}

async function loadPools() {
  try {
    const list = JSON.parse(await fs.readFile(POOLS_FILE, "utf8"));
    if (Array.isArray(list)) {
      for (const pool of list) {
        if (pool?.poolId) poolCache.set(String(pool.poolId).toLowerCase(), pool);
      }
    }
    console.log(`已从 ${POOLS_FILE} 载入 ${poolCache.size} 个池子`);
  } catch {}
}

async function savePoolInfo(poolInfo) {
  if (!poolInfo?.poolId) return;
  poolCache.set(String(poolInfo.poolId).toLowerCase(), poolInfo);
  try {
    await fs.writeFile(POOLS_FILE, JSON.stringify([...poolCache.values()], null, 2));
  } catch (err) {
    console.error("写入 pools.json 失败:", err?.message || err);
  }
}

async function loadSubscribers() {
  try {
    const list = JSON.parse(await fs.readFile(SUBSCRIBERS_FILE, "utf8"));
    if (Array.isArray(list)) {
      for (const s of list) {
        if (s?.id != null) subscribers.set(String(s.id), s);
      }
    }
    console.log(`已从 ${SUBSCRIBERS_FILE} 载入 ${subscribers.size} 个订阅会话`);
  } catch {}
}

async function saveSubscribers() {
  try {
    await fs.writeFile(SUBSCRIBERS_FILE, JSON.stringify([...subscribers.values()], null, 2));
  } catch (err) {
    console.error("写入 subscribers.json 失败:", err?.message || err);
  }
}

function chatDisplayName(chat) {
  if (!chat) return "";
  if (chat.title) return chat.title;
  if (chat.username) return "@" + chat.username;
  return [chat.first_name, chat.last_name].filter(Boolean).join(" ") || String(chat.id);
}

// ---------------- 命中判断 ----------------

function isTargetTx(tx) {
  const txTo = tx.to ? tx.to.toLowerCase() : "";
  const txFrom = tx.from ? tx.from.toLowerCase() : "";
  const data = (tx.input || tx.data || "").toLowerCase();
  if (!matchedMethod(data)) return false;
  if (filterFrom && txFrom !== filterFrom.toLowerCase()) return false;
  if (!isWatchedContract(txTo)) return false;
  return true;
}

// ---------------- 消息构造 ----------------

async function buildAlertMessage(tx, blockNumber, parsed, receipt) {
  const key = parsed.args.key ?? parsed.args[0];
  const inputCurrency0 = ethers.getAddress(key.currency0 ?? key[0]);
  const inputCurrency1 = ethers.getAddress(key.currency1 ?? key[1]);
  const inputHooks = ethers.getAddress(key.hooks ?? key[2]);
  const poolManager = ethers.getAddress(key.poolManager ?? key[3]);
  const inputFee = key.fee ?? key[4];
  const inputParameters = key.parameters ?? key[5];
  const inputStartTimestamp = parsed.args.startTimestamp ?? parsed.args[1];
  const inputSqrtPriceX96 = parsed.args.sqrtPriceX96 ?? parsed.args[2];

  // Hook 会改写 PoolKey 再调 PoolManager，真实 poolId / fee / sqrtPriceX96
  // 以 CLPoolManager 的 Initialize 事件为准；事件取不到再回退到 Hook 入参。
  // Hook 自己的 PoolStartedAtUpdated 事件提供真实 poolId（备用）和准确开始时间。
  const realInit = parseCLInitializeEvent(receipt?.logs, poolManager);
  const hookStarted = parseHookPoolStartedEvent(receipt?.logs, tx.to || SAMPLE_HOOK);
  const currency0 = realInit?.currency0 ?? inputCurrency0;
  const currency1 = realInit?.currency1 ?? inputCurrency1;
  const hooks = realInit?.hooks ?? inputHooks;
  const fee = realInit?.fee ?? inputFee;
  const parameters = realInit?.parameters ?? inputParameters;
  const sqrtPriceX96 = realInit?.sqrtPriceX96 ?? inputSqrtPriceX96;
  const startTimestamp = hookStarted?.startedTimestamp ?? inputStartTimestamp;
  const poolId =
    realInit?.poolId ??
    hookStarted?.poolId ??
    computePoolId(currency0, currency1, hooks, poolManager, fee, parameters);

  const [t0, t1] = await Promise.all([getTokenMeta(currency0), getTokenMeta(currency1)]);
  const pair = `${t0.symbol} / ${t1.symbol}`;
  const prices = formatPrices(sqrtPriceX96, t0.decimals, t1.decimals);
  const poolUrl = pancakePoolUrl(poolId);

  const poolInfo = poolId
    ? {
        poolId,
        token0: t0,
        token1: t1,
        hooks,
        poolManager,
        fee: fee.toString(),
        parameters: String(parameters),
        startTimestamp: startTimestamp.toString(),
        sqrtPriceX96: sqrtPriceX96.toString(),
        price: prices,
        initTx: tx.hash,
        initBlock: blockNumber
      }
    : null;
  if (poolInfo) poolCache.set(poolId, poolInfo);

  const lines = [
    `🚨 <b>Binance Alpha代币 上线前信号｜${escapeHtml(pair)}</b>`,
    ``,
    `🟢 <b>状态：</b>Alpha 流动性池已初始化`,
    ``
  ];
  if (prices) {
    lines.push(
      `💰 <b>初始价格</b>`,
      `1 ${escapeHtml(t0.symbol)} ≈ <code>${prices.forward}</code> ${escapeHtml(t1.symbol)}`,
      `1 ${escapeHtml(t1.symbol)} ≈ <code>${prices.inverse}</code> ${escapeHtml(t0.symbol)}`,
      ``
    );
  }
  lines.push(
    `🪙 <b>${escapeHtml(t0.symbol)} 合约：</b><code>${currency0}</code>`,
    `💵 <b>${escapeHtml(t1.symbol)} 合约：</b><code>${currency1}</code>`,
    ``,
    `⏰ <b>开始时间：</b>${escapeHtml(formatUiTime(startTimestamp, TIMEZONE))}`,
    `🧩 <b>PoolId：</b><code>${shortPoolId(poolId)}</code>`,
    `📦 <b>区块：</b><code>${blockNumber}</code>`,
    `🔎 <b>Tx：</b><a href="https://bscscan.com/tx/${tx.hash}">${shortAddr(tx.hash)}</a>`
  );

  const reply_markup = buildPoolKeyboard({ poolId, txHash: tx.hash });

  return {
    text: lines.join("\n") + communityFooter(),
    reply_markup,
    poolInfo,
    pair,
    poolId,
    poolUrl
  };
}

async function buildAddOwnersMessage(tx, blockNumber, parsed) {
  const poolId = String(parsed.args.poolId ?? parsed.args[0]).toLowerCase();
  const owners = (parsed.args.owners ?? parsed.args[1] ?? []).map((a) => ethers.getAddress(a));
  const cached = poolCache.get(poolId);
  const pair = cached ? `${cached.token0.symbol} / ${cached.token1.symbol}` : null;
  const tokenSymbol = cached ? escapeHtml(cached.token0.symbol) : "该代币";

  const lines = [
    `🧩 <b>Binance Alpha 上线前信号更新｜${pair ? escapeHtml(pair) : "未知池子"}</b>`,
    ``,
    `🟢 <b>状态：</b>管理员配置完成`,
    `↳ <b>关联池子：</b><code>${shortPoolId(poolId)}</code>`,
    ``,
    `<b>进度：</b>`,
    `✅ 1/2 池子初始化完成`,
    `✅ 2/2 管理员配置完成`,
    ``,
    `📌 <b>结论：</b>`,
    `${tokenSymbol} 的 Alpha 池子已经初始化，并完成池子管理员配置。`,
    `这通常属于 Binance Alpha / Alpha Earn 池子开放前的链上准备动作。`,
    ``,
    `👤 <b>新增管理员：</b>`,
    ...owners.map((o) => `<code>${o}</code>`),
    ``,
    `📦 <b>区块：</b><code>${blockNumber}</code>`,
    `🔎 <b>Tx：</b><a href="https://bscscan.com/tx/${tx.hash}">${shortAddr(tx.hash)}</a>`
  ];
  if (!cached) {
    lines.push(
      `<i>（本地无该池初始化记录，可用 /import &lt;initializePool 交易哈希&gt; 补全币对）</i>`
    );
  }

  const reply_markup = buildPoolKeyboard({
    poolId,
    txHash: tx.hash,
    secondRow: [
      owners[0] ? { text: "👤 Owner", url: bscscanAddressUrl(owners[0]) } : null,
      { text: "🧩 Hook 合约", url: bscscanAddressUrl(tx.to || SAMPLE_HOOK) }
    ].filter(Boolean)
  });

  return { text: lines.join("\n") + communityFooter(), reply_markup, pair, poolId };
}

async function buildPoolStartedMessage(tx, blockNumber, parsed) {
  const poolId = String(parsed.args.poolId ?? parsed.args[0]).toLowerCase();
  const ts = Number(parsed.args.timestamp ?? parsed.args[1]);
  const cached = poolCache.get(poolId);
  const pair = cached ? `${cached.token0.symbol} / ${cached.token1.symbol}` : null;
  const tokenSymbol = cached ? escapeHtml(cached.token0.symbol) : "该代币";
  const when = escapeHtml(formatUiTime(ts, TIMEZONE));
  const diffSec = ts - Math.floor(Date.now() / 1000);
  const countdown = Number.isFinite(diffSec)
    ? diffSec > 0
      ? `距开盘约 ${formatUptime(diffSec * 1000)}`
      : `开盘时间已到/已过`
    : null;

  const lines = [
    `⏰ <b>Binance Alpha 开盘时间确定｜${pair ? escapeHtml(pair) : "未知池子"}</b>`,
    ``,
    `🟢 <b>状态：</b>已设置开盘时间`,
    `↳ <b>关联池子：</b><code>${shortPoolId(poolId)}</code>`,
    ``,
    `🚀 <b>开盘时间：</b>${when}`,
    countdown ? `⏳ ${countdown}` : null,
    ``,
    `📌 <b>结论：</b>`,
    `${tokenSymbol} 的 Alpha 池子已设定开盘时间，通常意味着即将开放交易。`,
    ``,
    `📦 <b>区块：</b><code>${blockNumber}</code>`,
    `🔎 <b>Tx：</b><a href="https://bscscan.com/tx/${tx.hash}">${shortAddr(tx.hash)}</a>`
  ].filter((l) => l !== null);
  if (!cached) {
    lines.push(
      `<i>（本地无该池初始化记录，可用 /import &lt;initializePool 交易哈希&gt; 补全币对）</i>`
    );
  }

  const reply_markup = buildPoolKeyboard({
    poolId,
    txHash: tx.hash,
    secondRow: [{ text: "🧩 Hook 合约", url: bscscanAddressUrl(tx.to || SAMPLE_HOOK) }]
  });

  return { text: lines.join("\n") + communityFooter(), reply_markup, pair, poolId };
}

async function buildMessageForMethod(method, tx, blockNumber, parsed, receipt) {
  if (method === "addPoolOwners") return buildAddOwnersMessage(tx, blockNumber, parsed);
  if (method === "setPoolStartedTimestamp") return buildPoolStartedMessage(tx, blockNumber, parsed);
  return buildAlertMessage(tx, blockNumber, parsed, receipt);
}

// /pool 信息卡片
async function buildPoolInfoCard(poolId) {
  const pid = String(poolId || "").toLowerCase();
  if (!isValidPoolId(pid)) {
    return { text: `⚠️ poolId 格式不对，应为 0x + 64 位十六进制。用法：/pool &lt;poolId&gt;` };
  }
  const url = pancakePoolUrl(pid);
  const pool = poolCache.get(pid);

  if (!pool) {
    const text = [
      `❓ <b>Pool Info</b>`,
      ``,
      `本地没有这个 poolId 的缓存。`,
      `<b>PoolId:</b> <code>${pid}</code>`,
      `<b>PancakeSwap:</b> <a href="${url}">🥞 Open Pool</a>`,
      ``,
      `提示：用 /import &lt;initializePool 交易哈希&gt; 导入池子信息。`
    ].join("\n");
    return { text, reply_markup: buildPoolKeyboard({ poolId: pid }) };
  }

  const current = await getCurrentPoolPrice(pool);
  const lines = [
    `🔎 <b>Pool Info</b> | ${escapeHtml(`${pool.token0.symbol} / ${pool.token1.symbol}`)}`,
    ``,
    `<b>PoolId:</b> <code>${pid}</code>`,
    `<b>PancakeSwap:</b> <a href="${url}">🥞 Open Pool</a>`,
    `<b>手续费:</b> <code>${pool.fee}</code>，约 ${feeToPercent(pool.fee)}`
  ];
  if (pool.price) {
    lines.push(
      `<b>初始价格:</b> 1 ${escapeHtml(pool.token0.symbol)} ≈ <code>${pool.price.forward}</code> ${escapeHtml(pool.token1.symbol)}`
    );
  }
  if (current?.price) {
    lines.push(
      `<b>当前价格:</b> 1 ${escapeHtml(pool.token0.symbol)} ≈ <code>${current.price.forward}</code> ${escapeHtml(pool.token1.symbol)}`,
      `<b>当前 tick:</b> <code>${current.tick}</code>`
    );
  } else {
    lines.push(`<i>（当前价格读取失败或不可用，已展示初始价格）</i>`);
  }
  if (pool.initTx) {
    lines.push(
      `<b>Init Tx:</b> <a href="https://bscscan.com/tx/${pool.initTx}">${shortAddr(pool.initTx)}</a>`
    );
  }

  const reply_markup = buildPoolKeyboard({
    poolId: pid,
    txHash: pool.initTx,
    secondRow: [
      { text: pool.token0.symbol || "Token0", url: bscscanTokenUrl(pool.token0.address) },
      { text: pool.token1.symbol || "Token1", url: bscscanTokenUrl(pool.token1.address) }
    ]
  });
  return { text: lines.join("\n"), reply_markup };
}

// /import：把历史 initializePool 交易导入缓存
async function buildImportResult(txHash) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(txHash || ""))) {
    return { text: `⚠️ 用法：/import &lt;initializePool 交易哈希&gt;` };
  }
  let tx;
  try {
    tx = await withTimeout(provider.getTransaction(txHash), rpcTimeoutMs, "getTransaction");
  } catch (err) {
    return { text: `❌ 查询交易失败：<code>${escapeHtml(err?.message || err)}</code>` };
  }
  if (!tx) return { text: `❌ 找不到该交易：<code>${escapeHtml(txHash)}</code>` };
  if (!isWatchedContract(tx.to)) {
    return { text: `⚠️ 该交易的 To 不在监听的合约范围内，无法导入。` };
  }
  if (matchedMethod(tx.data) !== "initializePool") {
    return { text: `⚠️ 只能导入 initializePool 交易（该交易方法不匹配）。` };
  }
  try {
    const parsed = iface.parseTransaction({ data: tx.data, value: tx.value ?? 0 });
    const receipt = await withTimeout(
      provider.getTransactionReceipt(txHash),
      rpcTimeoutMs,
      "getTransactionReceipt"
    ).catch(() => null);
    const built = await buildAlertMessage(tx, tx.blockNumber ?? null, parsed, receipt);
    if (!built.poolInfo) return { text: `❌ 无法计算 poolId，导入失败。` };
    await savePoolInfo(built.poolInfo);
    const text = [
      `✅ <b>Pool imported</b> | ${escapeHtml(built.pair)}`,
      ``,
      `<b>PoolId:</b> <code>${built.poolInfo.poolId}</code>`,
      `<b>PancakeSwap:</b> <a href="${pancakePoolUrl(built.poolInfo.poolId)}">🥞 Open Pool</a>`,
      ``,
      `现在 /pool ${built.poolInfo.poolId} 可直接查询，addPoolOwners 也能显示币对。`
    ].join("\n");
    return { text, reply_markup: built.reply_markup };
  } catch (err) {
    return { text: `❌ 解析失败：<code>${escapeHtml(err?.message || err)}</code>` };
  }
}

async function buildPreviewSample() {
  const sampleKey = {
    currency0: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", // WBNB
    currency1: "0x55d398326f99059fF775485246999027B3197955", // USDT (BSC)
    hooks: SAMPLE_HOOK,
    poolManager: SAMPLE_HOOK,
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
    from: filterFrom || SAMPLE_HOOK,
    to: SAMPLE_HOOK,
    data
  };
  const m = await buildAlertMessage(sampleTx, "（示例）", parsed, null);
  return { text: `🔎 <b>预览示例（非真实告警）</b>\n\n${m.text}`, reply_markup: m.reply_markup };
}

async function buildPreviewForTx(txHash) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return { text: `⚠️ txHash 格式不对，应为 0x 开头的 66 位哈希。` };
  }
  let tx;
  try {
    tx = await withTimeout(provider.getTransaction(txHash), rpcTimeoutMs, "getTransaction");
  } catch (err) {
    return { text: `❌ 查询交易失败：<code>${escapeHtml(err?.message || err)}</code>` };
  }
  if (!tx) return { text: `❌ 找不到该交易：<code>${escapeHtml(txHash)}</code>` };
  if (!isWatchedContract(tx.to)) {
    return { text: `⚠️ 该交易的 To 不在监听的合约范围内，无法预览。` };
  }
  const method = matchedMethod(tx.data);
  if (!method) {
    return {
      text: `⚠️ 该交易不是 initializePool / addPoolOwners / setPoolStartedTimestamp 调用（方法选择器不匹配）。`
    };
  }
  try {
    const parsed = iface.parseTransaction({ data: tx.data, value: tx.value ?? 0 });
    const receipt =
      method === "initializePool"
        ? await withTimeout(
            provider.getTransactionReceipt(txHash),
            rpcTimeoutMs,
            "getTransactionReceipt"
          ).catch(() => null)
        : null;
    const m = await buildMessageForMethod(method, tx, tx.blockNumber ?? "pending", parsed, receipt);
    return { text: `🔎 <b>预览（真实交易）</b>\n\n${m.text}`, reply_markup: m.reply_markup };
  } catch (err) {
    return { text: `❌ 解析失败：<code>${escapeHtml(err?.message || err)}</code>` };
  }
}

// /check <txHash>：逐项检查这笔交易会不会被本机器人推送
async function buildHitCheck(txHash) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(txHash || ""))) {
    return { text: `⚠️ 用法：/check &lt;txHash&gt;（检查这笔交易是否命中推送规则）` };
  }
  let tx;
  try {
    tx = await withTimeout(provider.getTransaction(txHash), rpcTimeoutMs, "getTransaction");
  } catch (err) {
    return { text: `❌ 查询交易失败：<code>${escapeHtml(err?.message || err)}</code>` };
  }
  if (!tx) return { text: `❌ 找不到该交易：<code>${escapeHtml(txHash)}</code>` };

  const txFrom = (tx.from || "").toLowerCase();
  const method = matchedMethod(tx.data);
  const toMatch = isWatchedContract(tx.to);
  const fromMatch = !filterFrom || txFrom === filterFrom.toLowerCase();

  let statusOk = null;
  let receipt = null;
  try {
    receipt = await withTimeout(
      provider.getTransactionReceipt(txHash),
      rpcTimeoutMs,
      "getTransactionReceipt"
    );
    statusOk = receipt ? receipt.status === 1 : null;
  } catch {}

  const yn = (ok) => (ok ? "✅" : "❌");
  const lines = [
    `🔎 <b>命中检查</b>`,
    `<b>Tx:</b> <a href="https://bscscan.com/tx/${tx.hash}">${shortAddr(tx.hash)}</a>`,
    ``,
    `${yn(toMatch)} <b>To 合约:</b> ${
      targetContracts.size === 0
        ? `不限合约（实际 ${shortAddr(tx.to || "无")}）`
        : toMatch
          ? "在范围内"
          : `不在范围内（实际 ${shortAddr(tx.to || "无")}）`
    }`,
    `${yn(!!method)} <b>方法:</b> ${method ? `${method}` : "不是已监听的方法"}`,
    filterFrom
      ? `${yn(fromMatch)} <b>From 过滤:</b> ${fromMatch ? "通过" : `被过滤（实际 ${shortAddr(tx.from)}，需要 ${shortAddr(filterFrom)}）`}`
      : `⏭️ <b>From 过滤:</b> 未启用（监听所有调用者）`,
    `${yn(statusOk === true)} <b>交易状态:</b> ${
      statusOk === true ? "success" : statusOk === false ? "failed（不会推）" : "未知/未确认"
    }`
  ];

  const hit = toMatch && !!method && fromMatch && statusOk === true;
  lines.push(``, hit ? `<b>结论:</b> ✅ 会被推送` : `<b>结论:</b> ❌ 不会被推送`);

  // 命中的话，把会推送的告警一起渲染出来
  if (hit) {
    try {
      const parsed = iface.parseTransaction({ data: tx.data, value: tx.value ?? 0 });
      const m = await buildMessageForMethod(
        method,
        tx,
        tx.blockNumber ?? "pending",
        parsed,
        receipt
      );
      return {
        text: `${lines.join("\n")}\n\n— — — 推送内容 — — —\n${m.text}`,
        reply_markup: m.reply_markup
      };
    } catch {}
  }
  return { text: lines.join("\n") };
}

function recordAlert(entry) {
  lastAlert = { ...entry, time: Date.now() };
  recentAlerts.unshift(lastAlert);
  if (recentAlerts.length > 20) recentAlerts.length = 20;
}

// ---------------- 交互命令 ----------------

function isWhitelisted(userId) {
  return whitelist.size > 0 && whitelist.has(String(userId));
}

function buildHelpMessage() {
  return [
    `🤖 <b>BSC Initialize Pool / Add Pool Owners 监听机器人</b>`,
    ``,
    `盯操作钱包 <code>${filterFrom ? shortAddr(filterFrom) : "未设置"}</code> 的 <code>initializePool</code>、<code>addPoolOwners</code> 与 <code>setPoolStartedTimestamp</code> 调用${
      targetContracts.size ? `（限 ${targetContracts.size} 个合约）` : "（不限合约）"
    }，`,
    `命中后推送新池 / 加管理员 / 开盘时间信息，并附 PancakeSwap 链接与按钮。`,
    ``,
    `<b>命令</b>`,
    `/help - 显示本帮助`,
    `/id - 查看你的 TG 用户 ID 和当前会话 ID`,
    `/status - 查看运行状态（白名单）`,
    `/test - 检查 RPC 与 Telegram 连接（白名单）`,
    `/check &lt;txHash&gt; - 检查这笔交易是否命中推送规则（白名单）`,
    `/preview [txHash] - 预览告警；带 txHash 则预览真实交易（白名单）`,
    `/pool &lt;poolId&gt; - 查询池子信息 / 当前价格 / PancakeSwap 链接（白名单）`,
    `/import &lt;txHash&gt; - 导入历史 initializePool 交易到本地缓存（白名单）`,
    `/last [n] - 查看最近 n 条告警（白名单）`,
    `/subscribe - 让当前会话/群接收告警（白名单）`,
    `/unsubscribe - 取消当前会话/群的订阅（白名单）`,
    `/subscribers - 查看所有收件会话和白名单（白名单）`,
    `/resync [区块号] - 重置扫描游标；不带参数=跳到链头恢复实时（白名单）`,
    ``,
    `💡 /import /pool /check 可不带参数发送，机器人会让你直接回复粘贴哈希 / poolId。`,
    `🔒 控制命令仅限白名单用户。其它人无法控制本机器人。`,
    `👥 群里用命令请用 <code>/命令@${escapeHtml(botUsername || "机器人用户名")}</code>，或在 BotFather 关闭 Privacy 模式。`
  ].join("\n");
}

async function buildStatusMessage() {
  let latestRaw = null;
  let chainId = "?";
  const t0 = Date.now();
  try {
    latestRaw = await withTimeout(provider.getBlockNumber(), rpcTimeoutMs, "getBlockNumber");
    lastRpcLatencyMs = Date.now() - t0;
    chainId = (
      await withTimeout(provider.getNetwork(), rpcTimeoutMs, "getNetwork")
    ).chainId.toString();
  } catch (err) {
    return `⚠️ 读取链上状态失败: <code>${escapeHtml(err?.message || err)}</code>`;
  }
  const confirmed = Math.max(0, latestRaw - confirmations);
  const cursor = await readCursor();
  const lag = cursor !== null ? confirmed - cursor : "?";
  const la = lastAlert
    ? `${methodTag(lastAlert.method)}${
        lastAlert.pair ? ` ${lastAlert.pair}` : ""
      } ${shortAddr(lastAlert.txHash)}（${formatUptime(Date.now() - lastAlert.time)}前）`
    : "暂无";
  return [
    `🟢 <b>运行状态</b>`,
    ``,
    `<b>运行时长:</b> ${formatUptime(Date.now() - startedAt)}`,
    `<b>链:</b> chainId <code>${chainId}</code>${chainId === "56" ? " (BSC)" : ""}`,
    `<b>监听钱包(From):</b> ${filterFrom ? `<code>${filterFrom}</code>` : "未设置 ⚠️"}`,
    `<b>监听合约:</b> ${
      targetContracts.size === 0
        ? "不限（任意合约）"
        : [...targetContracts].map((a) => `<code>${a}</code>`).join("、")
    }`,
    `<b>监听方法:</b> initializePool <code>${SEL_INIT_POOL}</code> / addPoolOwners <code>${SEL_ADD_OWNERS}</code> / setPoolStartedTimestamp <code>${SEL_SET_STARTED}</code>`,
    ``,
    `<b>最新区块:</b> <code>${latestRaw}</code>`,
    `<b>确认数:</b> <code>${confirmations}</code> → 扫到 <code>${confirmed}</code>`,
    `<b>已扫描到:</b> <code>${cursor ?? "未初始化"}</code>`,
    `<b>落后:</b> <code>${lag}</code> 块`,
    `<b>检查间隔:</b> <code>${Number(POLL_MS) / 1000}</code> 秒`,
    `<b>数据源:</b> <code>${escapeHtml(dataSourceLabel)}</code>${dataSourceKeyMissing ? " ⚠️无Key" : ""}`,
    `<b>数据源延迟:</b> <code>${lastExplorerLatencyMs ?? "?"}</code> ms${
      lastExplorerError ? `｜⚠️ ${escapeHtml(lastExplorerError)}` : ""
    }`,
    `<b>RPC 延迟:</b> <code>${lastRpcLatencyMs ?? "?"}</code> ms`,
    ``,
    `<b>缓存:</b> Pools <code>${poolCache.size}</code> / Tokens <code>${tokenCache.size}</code>`,
    `<b>最近告警:</b> ${escapeHtml(la)}`,
    `<b>推送:</b> <code>${lastPush.ok}/${lastPush.total}</code> chats OK`,
    `<b>收件会话:</b> 固定 <code>${envChatIds.length}</code> + 订阅 <code>${subscribers.size}</code>（共 <code>${recipientChatIds().length}</code>）`,
    `<b>白名单:</b> ${whitelist.size ? [...whitelist].map((id) => `<code>${escapeHtml(id)}</code>`).join("、") : "（空）"}`,
    ``,
    `查看收件 / 订阅明细：/subscribers`
  ].join("\n");
}

async function runConnectivityTest() {
  const lines = [`🔎 <b>连接检查</b>`, ``];
  const t0 = Date.now();
  try {
    const latest = await withTimeout(provider.getBlockNumber(), rpcTimeoutMs, "getBlockNumber");
    const net = await withTimeout(provider.getNetwork(), rpcTimeoutMs, "getNetwork");
    lines.push(
      `✅ RPC 正常：最新区块 <code>${latest}</code>，chainId <code>${net.chainId}</code>（${Date.now() - t0}ms）`
    );
    if (net.chainId !== 56n) lines.push(`⚠️ chainId 不是 56，可能不是 BSC 主网。`);
  } catch (err) {
    lines.push(`❌ RPC 失败：<code>${escapeHtml(err?.message || err)}</code>`);
  }
  const recipients = recipientChatIds();
  let okCount = 0;
  for (const chatId of recipients) {
    if (
      await sendMessage(
        chatId,
        `✅ 测试消息：告警会话 <code>${escapeHtml(chatId)}</code> 推送正常。`
      )
    )
      okCount++;
  }
  lines.push(`📨 告警推送：${okCount}/${recipients.length} 个会话发送成功。`);
  return lines.join("\n");
}

function buildSubscribersList() {
  const lines = [`📡 <b>收件会话</b>`, ``];
  if (envChatIds.length) {
    lines.push(`<b>环境变量固定（TG_CHAT_ID）：</b>`);
    for (const id of envChatIds) lines.push(`• <code>${escapeHtml(id)}</code>`);
    lines.push(``);
  }
  lines.push(`<b>动态订阅（/subscribe）：</b>`);
  if (subscribers.size === 0) {
    lines.push(`（暂无，在群里发 /subscribe 即可订阅）`);
  } else {
    for (const s of subscribers.values()) {
      lines.push(
        `• <code>${escapeHtml(String(s.id))}</code> ${escapeHtml(s.name || "")} (${escapeHtml(s.type || "")})`
      );
    }
  }
  lines.push(``, `<b>白名单用户：</b>`);
  lines.push(
    whitelist.size
      ? [...whitelist].map((id) => `<code>${escapeHtml(id)}</code>`).join("、")
      : "（空）"
  );
  return lines.join("\n");
}

async function subscribeChat(chat) {
  const id = String(chat.id);
  subscribers.set(id, {
    id: chat.id,
    name: chatDisplayName(chat),
    type: chat.type,
    addedAt: Date.now()
  });
  await saveSubscribers();
}

async function unsubscribeChat(chatId) {
  if (!subscribers.has(String(chatId))) return false;
  subscribers.delete(String(chatId));
  await saveSubscribers();
  return true;
}

// 重置扫描游标：不带参数=跳到链头（放弃积压，恢复实时）；带区块号=从该块开始扫。
async function buildResync(arg) {
  let head;
  try {
    const latestRaw = await withTimeout(provider.getBlockNumber(), rpcTimeoutMs, "getBlockNumber");
    head = Math.max(0, latestRaw - confirmations);
  } catch (err) {
    return `❌ 读取最新区块失败，无法重置：<code>${escapeHtml(err?.message || err)}</code>`;
  }
  let target;
  if (arg != null && String(arg).trim() !== "") {
    const from = Number(arg);
    if (!Number.isFinite(from) || from < 0)
      return `用法：/resync（跳到链头）或 /resync &lt;区块号&gt;`;
    target = Math.max(0, Math.floor(from) - 1); // 下一轮从 from 开始扫
  } else {
    target = head; // 跳到链头，只扫之后的新块
  }
  pendingResync = target;
  await writeCursor(target);
  const lag = head - target;
  return [
    `✅ 已重置扫描游标到 <code>${target}</code>（下一轮从 <code>${target + 1}</code> 开始扫）。`,
    `当前链头(已确认): <code>${head}</code>，落后 <code>${lag}</code> 块。`,
    lag <= 0 ? `已对齐链头，恢复实时告警。` : `将从该位置继续扫描。`,
    `（最多约 ${Number(POLL_MS) / 1000} 秒后生效。）`
  ].join("\n");
}

// 告警方法对应的标签（用于 /status、/last 等摘要展示）
function methodTag(method) {
  if (method === "addPoolOwners") return "🟠 加管理员";
  if (method === "setPoolStartedTimestamp") return "⏰ 开盘时间";
  return "🟢 新池";
}

function buildLastAlerts(n) {
  const count = Math.min(20, Math.max(1, Number(n) || 5));
  if (recentAlerts.length === 0) return `暂无告警记录。`;
  const lines = [`🕘 <b>最近 ${Math.min(count, recentAlerts.length)} 条告警</b>`, ``];
  for (const a of recentAlerts.slice(0, count)) {
    const tag =
      a.method === "addPoolOwners" ? "🟠" : a.method === "setPoolStartedTimestamp" ? "⏰" : "🟢";
    const pair = a.pair ? ` ${escapeHtml(a.pair)}` : "";
    lines.push(
      `${tag}${pair} <a href="https://bscscan.com/tx/${a.txHash}">${shortAddr(a.txHash)}</a> · ${formatUptime(
        Date.now() - a.time
      )}前`
    );
  }
  return lines.join("\n");
}

async function reply(chatId, out) {
  await sendMessage(chatId, out.text, out.reply_markup ? { reply_markup: out.reply_markup } : {});
}

// 不带参数时发一条 ForceReply 提示，用户直接回复粘贴哈希/poolId 即可（类似快捷输入）
const PROMPTS = {
  "/import": [
    "📝 导入池子",
    "回复本条消息，发送 initializePool 的交易哈希（0x… 64 位）即可导入，不用再输入 /import。"
  ],
  "/pool": ["📝 查询池子", "回复本条消息，发送 poolId（0x… 64 位）即可查询，不用再输入 /pool。"],
  "/check": ["📝 命中检查", "回复本条消息，发送交易哈希（0x… 64 位）即可检查，不用再输入 /check。"]
};

async function sendPrompt(chatId, command) {
  const [title, body] = PROMPTS[command];
  await sendMessage(chatId, `${title}\n${body}`, {
    reply_markup: { force_reply: true, selective: true, input_field_placeholder: "粘贴 0x… 后发送" }
  });
}

function pendingCommandFromReply(replyText) {
  if (typeof replyText !== "string") return null;
  for (const [command, [title]] of Object.entries(PROMPTS)) {
    if (replyText.startsWith(title)) return command;
  }
  return null;
}

async function handleUpdate(update) {
  if (update.my_chat_member) {
    const m = update.my_chat_member;
    const status = m.new_chat_member?.status;
    const who = m.new_chat_member?.user;
    if (who && botId && who.id === botId) {
      if (status === "member" || status === "administrator") {
        await sendMessage(
          m.chat.id,
          `👋 我是币安 Alpha 上线前信号机器人。\n白名单用户在本群发送 <b>/subscribe</b> 即可让本群接收告警；/help 查看全部命令。`
        );
      } else if (status === "left" || status === "kicked") {
        // 被移出群：自动取消该群订阅
        if (await unsubscribeChat(m.chat.id)) console.log("已移除订阅(被踢):", m.chat.id);
      }
    }
    return;
  }

  const msg = update.message;
  const text = typeof msg?.text === "string" ? msg.text : null;
  if (!msg || !text) return;

  const chatId = msg.chat.id;
  const userId = msg.from?.id;

  // 解析出命令和参数：支持 “/cmd 参数”，也支持 “回复机器人的提示后直接发参数”
  let cmd = null;
  let args = [];
  if (text.startsWith("/")) {
    let [cmdRaw, ...rest] = text.trim().split(/\s+/);
    cmd = cmdRaw.toLowerCase();
    if (cmd.includes("@")) {
      const [name, mention] = cmd.split("@");
      if (botUsername && mention !== botUsername.toLowerCase()) return;
      cmd = name;
    }
    args = rest;
  } else if (msg.reply_to_message && msg.reply_to_message.from?.id === botId) {
    const pending = pendingCommandFromReply(msg.reply_to_message.text);
    if (!pending) return;
    cmd = pending;
    args = text.trim().split(/\s+/);
  } else {
    return;
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
      if (await requireWhitelist()) await sendMessage(chatId, await runConnectivityTest());
      break;
    case "/check":
      if (await requireWhitelist())
        args[0]
          ? await reply(chatId, await buildHitCheck(args[0]))
          : await sendPrompt(chatId, "/check");
      break;
    case "/preview":
      if (await requireWhitelist())
        await reply(
          chatId,
          args[0] ? await buildPreviewForTx(args[0]) : await buildPreviewSample()
        );
      break;
    case "/pool":
      if (await requireWhitelist())
        args[0]
          ? await reply(chatId, await buildPoolInfoCard(args[0]))
          : await sendPrompt(chatId, "/pool");
      break;
    case "/import":
      if (await requireWhitelist())
        args[0]
          ? await reply(chatId, await buildImportResult(args[0]))
          : await sendPrompt(chatId, "/import");
      break;
    case "/last":
      if (await requireWhitelist()) await sendMessage(chatId, buildLastAlerts(args[0]));
      break;
    case "/subscribe":
      if (await requireWhitelist()) {
        await subscribeChat(msg.chat);
        await sendMessage(
          chatId,
          `✅ 已订阅：本会话（<code>${chatId}</code>）将接收 Alpha 上线前信号。\n取消请发 /unsubscribe。`
        );
      }
      break;
    case "/unsubscribe":
      if (await requireWhitelist()) {
        const ok = await unsubscribeChat(chatId);
        await sendMessage(chatId, ok ? `✅ 已退订本会话。` : `本会话本来就没有订阅。`);
      }
      break;
    case "/subscribers":
      if (await requireWhitelist()) await sendMessage(chatId, buildSubscribersList());
      break;
    case "/resync":
      if (await requireWhitelist()) await sendMessage(chatId, await buildResync(args[0]));
      break;
    default:
      break;
  }
}

let tgOffset = 0;
async function pollTelegram() {
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
      { command: "check", description: "检查某笔交易是否命中推送规则" },
      { command: "preview", description: "预览告警消息（可加 txHash）" },
      { command: "pool", description: "查询池子信息 / PancakeSwap 链接" },
      { command: "import", description: "导入历史 initializePool 交易" },
      { command: "last", description: "查看最近的告警" },
      { command: "subscribe", description: "让当前会话/群接收告警" },
      { command: "unsubscribe", description: "取消当前会话/群的订阅" },
      { command: "subscribers", description: "查看收件会话和白名单" },
      { command: "resync", description: "重置扫描游标(默认跳到链头,可加区块号)" }
    ]
  });
  console.log("whitelist:", whitelist.size ? [...whitelist].join(", ") : "（空，暂无人可控制）");
}

// ---------------- 拉取 & 处理 ----------------

// 从区块浏览器查某地址在 [startBlock, endBlock] 的交易（Etherscan V2 / BscScan 兼容）
async function explorerTxList(address, startBlock, endBlock) {
  const qs = new URLSearchParams({
    chainid: explorerChainId,
    module: "account",
    action: "txlist",
    address,
    startblock: String(startBlock),
    endblock: String(endBlock),
    page: "1",
    offset: "10000",
    sort: "asc"
  });
  if (explorerKey) qs.set("apikey", explorerKey);
  const res = await fetch(`${explorerApi}?${qs.toString()}`, {
    signal: AbortSignal.timeout(rpcTimeoutMs)
  });
  const data = await res.json().catch(() => ({}));
  // status "1"=有结果；"0"+“No transactions found”=空区间；其它=报错（含限速）
  if (data.status === "1" && Array.isArray(data.result)) return data.result;
  if (data.status === "0" && /no transactions found/i.test(data.message || "")) return [];
  const detail = typeof data.result === "string" ? data.result : data.message || "未知错误";
  throw new Error(`浏览器 API 异常：${detail}`);
}

// 用 Ankr Advanced API 查某地址在 [startBlock, endBlock] 的交易（BSC 免费额度内）。
// 返回的交易字段（hash/from/to/input/value/blockNumber 等）与浏览器版兼容：value/blockNumber
// 为十六进制字符串，JS 的 Number()/ethers 都能直接吃。
async function ankrTxList(address, startBlock, endBlock) {
  const txs = [];
  let pageToken = "";
  // 分页安全上限，防止异常时死循环（目标钱包交易很少，通常 1 页就够）
  for (let i = 0; i < 50; i++) {
    const params = {
      blockchain: ankrBlockchain,
      address,
      fromBlock: startBlock,
      toBlock: endBlock,
      descOrder: false,
      pageSize: 100
    };
    if (pageToken) params.pageToken = pageToken;
    const res = await fetch(`${ankrAdvApi}/${ankrKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "ankr_getTransactionsByAddress", params }),
      signal: AbortSignal.timeout(rpcTimeoutMs)
    });
    const data = await res.json().catch(() => ({}));
    if (data.error) {
      throw new Error(`Ankr Advanced API 异常：${data.error.message || JSON.stringify(data.error)}`);
    }
    const result = data.result || {};
    const rows = Array.isArray(result.transactions) ? result.transactions : [];
    for (const r of rows) txs.push(r);
    pageToken = result.nextPageToken || "";
    if (!pageToken) break;
  }
  return txs;
}

// 用 NodeReal Enhanced API 列出某地址在 [startBlock, endBlock] 的“对外发起”交易（含 0 值合约调用），
// 再用 RPC 逐笔补全 input（NodeReal 列表不含 calldata），返回带 input 的完整交易对象。
async function noderealTxList(address, startBlock, endBlock) {
  const hashes = [];
  const seen = new Set();
  let pageKey = "";
  for (let i = 0; i < 50; i++) {
    const p = {
      category: ["external"],
      addressType: "from",
      address,
      order: "asc",
      excludeZeroValue: false,
      maxCount: "0x3e8", // 1000
      fromBlock: ethers.toQuantity(startBlock),
      toBlock: ethers.toQuantity(endBlock)
    };
    if (pageKey) p.pageKey = pageKey;
    const res = await fetch(`${noderealApi}/${noderealKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "nr_getTransactionByAddress", params: [p] }),
      signal: AbortSignal.timeout(rpcTimeoutMs)
    });
    const data = await res.json().catch(() => ({}));
    if (data.error) {
      throw new Error(`NodeReal 异常：${data.error.message || JSON.stringify(data.error)}`);
    }
    const result = data.result || {};
    const transfers = Array.isArray(result.transfers) ? result.transfers : [];
    for (const t of transfers) {
      if (t.receiptsStatus !== 1) continue; // 跳过失败交易
      if (targetContracts.size && !targetContracts.has((t.to || "").toLowerCase())) continue;
      if (t.hash && !seen.has(t.hash)) {
        seen.add(t.hash);
        hashes.push(t.hash);
      }
    }
    pageKey = result.pageKey || "";
    // maxCount=1000，返回不足 1000 即为最后一页；pageKey 为空也结束
    if (transfers.length < 1000 || !pageKey) break;
  }
  // 用 RPC 补全 input（命中判定需要 calldata）
  const txs = [];
  for (const hash of hashes) {
    const tx = await withTimeout(provider.getTransaction(hash), rpcTimeoutMs, "getTransaction");
    if (tx) txs.push(tx);
  }
  return txs;
}

// 按当前 DATA_SOURCE 查某地址的交易
async function sourceTxList(address, startBlock, endBlock) {
  if (dataSource === "nodereal") return noderealTxList(address, startBlock, endBlock);
  if (dataSource === "etherscan") return explorerTxList(address, startBlock, endBlock);
  return ankrTxList(address, startBlock, endBlock);
}

// 拉取所有监听地址在 (fromBlock, toBlock] 的候选交易，按 hash 去重
async function fetchCandidateTxs(fromBlock, toBlock) {
  const t0 = Date.now();
  const seen = new Set();
  const all = [];
  for (const addr of watchAddresses) {
    const rows = await sourceTxList(addr, fromBlock, toBlock);
    for (const r of rows) {
      if (r?.hash && !seen.has(r.hash)) {
        seen.add(r.hash);
        all.push(r);
      }
    }
  }
  lastExplorerLatencyMs = Date.now() - t0;
  return all;
}

// 处理一笔已命中的交易：查回执确认成功后构造并推送告警
async function processMatchedTx(tx) {
  const blockNumber = Number(tx.blockNumber);
  // initializePool 的准确 poolId 依赖回执里的 Initialize 事件，故命中后仍需一次回执查询；
  // 命中很少（仅目标钱包动作），RPC 消耗可忽略。
  const receipt = await withTimeout(
    provider.getTransactionReceipt(tx.hash),
    rpcTimeoutMs,
    "getTransactionReceipt"
  );
  if (!receipt || receipt.status !== 1) {
    console.log("命中但交易失败或 receipt 未就绪:", tx.hash);
    return;
  }
  const method = matchedMethod(tx.input || tx.data);
  let built;
  try {
    const parsed = iface.parseTransaction({ data: tx.input || tx.data, value: tx.value ?? 0 });
    built = await buildMessageForMethod(method, tx, blockNumber, parsed, receipt);
  } catch (err) {
    console.error(`解析 ${method} 失败:`, tx.hash, err);
    return;
  }
  // initializePool 记住消息 id；addPoolOwners 回复对应的初始化消息
  const sendOptions =
    method === "initializePool"
      ? { poolId: built.poolId, rememberPoolMessage: true }
      : { poolId: built.poolId, replyToPoolMessage: true };
  const okCount = await sendTelegram(
    built.text,
    built.reply_markup ? { reply_markup: built.reply_markup } : {},
    sendOptions
  );
  // 全部会话推送失败：抛错，让游标不前进，下一轮重试，避免漏告警
  if (okCount === 0) throw new Error(`Telegram 推送失败，tx=${tx.hash}`);
  recordAlert({ method, txHash: tx.hash, pair: built.pair, blockNumber });
  if (built.poolInfo) await savePoolInfo(built.poolInfo);
  console.log(`[ALERT] method=${method} block=${blockNumber} tx=${tx.hash}`);
}

// DATA_SOURCE=rpc：逐块拉 eth_getBlockByNumber（在免费/自建 RPC 上零成本）。
// 命中判定与推送复用 processMatchedTx（block 里的 tx 已含 input，回执按需再查）。
async function scanBlockRpc(blockNumber) {
  const block = await withTimeout(
    provider.send("eth_getBlockByNumber", [ethers.toQuantity(blockNumber), true]),
    rpcTimeoutMs,
    "eth_getBlockByNumber"
  );
  if (!block || !Array.isArray(block.transactions)) return;
  for (const tx of block.transactions) {
    if (!isTargetTx(tx)) continue;
    await processMatchedTx(tx); // 推送失败会抛错，交由 tick 处理游标
  }
}

// DATA_SOURCE=rpc 的 tick 分支：从 cursor 逐块扫到 toBlock（单轮最多 rpcMaxBlocksPerTick 块）
async function tickRpc(cursor, latest) {
  const toBlock = Math.min(latest, cursor + rpcMaxBlocksPerTick);
  let processedThrough = cursor;
  for (let n = cursor + 1; n <= toBlock; n++) {
    if (pendingResync !== null) break; // 下一轮从重置值开始
    try {
      await scanBlockRpc(n);
      processedThrough = n;
    } catch (err) {
      // 该块推送失败：游标停在上一块，下一轮重扫本块，避免漏告警
      console.error(`扫块 ${n} 处理失败，游标不前进:`, err?.message || err);
      break;
    }
  }
  await writeCursor(processedThrough);
  if (processedThrough < latest) {
    console.log(`还有区块积压: cursor=${processedThrough}, latest=${latest}`);
  }
}

// DATA_SOURCE=ankr|etherscan 的 tick 分支：一次 API 调用覆盖整个区间 (cursor, latest]
async function tickApi(cursor, latest) {
  let candidates;
  try {
    candidates = await fetchCandidateTxs(cursor + 1, latest);
    lastExplorerError = null;
  } catch (err) {
    lastExplorerError = err?.message || String(err);
    console.error("数据源拉取失败，本轮游标不前进:", lastExplorerError);
    return;
  }

  // 命中过滤 + 按区块升序（保证 initializePool 先于同池 addPoolOwners，回复关系不乱）
  const matches = candidates
    .filter(isTargetTx)
    .sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber));

  let processedThrough = latest; // 默认推进到已确认链头
  for (const tx of matches) {
    if (pendingResync !== null) {
      processedThrough = Number(tx.blockNumber) - 1;
      break;
    }
    try {
      await processMatchedTx(tx);
    } catch (err) {
      console.error("处理命中交易失败，游标不前进:", err?.message || err);
      processedThrough = Number(tx.blockNumber) - 1;
      break;
    }
  }
  await writeCursor(processedThrough);
}

let busy = false;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    // /resync 请求优先：先落盘新游标，本轮直接从新位置开始
    if (pendingResync !== null) {
      const c = pendingResync;
      pendingResync = null;
      await writeCursor(c);
      console.log(`游标已重置为 ${c}`);
    }
    const t0 = Date.now();
    const latestRaw = await withTimeout(provider.getBlockNumber(), rpcTimeoutMs, "getBlockNumber");
    lastRpcLatencyMs = Date.now() - t0;
    const latest = Math.max(0, latestRaw - confirmations);

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

    if (dataSource === "rpc") await tickRpc(cursor, latest);
    else await tickApi(cursor, latest);
  } catch (err) {
    console.error("tick 错误:", err?.message || err);
  } finally {
    busy = false;
  }
}

async function main() {
  await loadPools();
  await loadSubscribers();
  const network = await provider.getNetwork();
  console.log("BSC Initialize Pool / Add Pool Owners TG Bot started");
  console.log("chainId:", network.chainId.toString());
  console.log(
    "targetContracts:",
    targetContracts.size === 0 ? "(any)" : [...targetContracts].join(", ")
  );
  console.log("filterFrom:", filterFrom || "未限制 From，监听所有调用者");
  console.log("selectors:", {
    initializePool: SEL_INIT_POOL,
    addPoolOwners: SEL_ADD_OWNERS,
    setPoolStartedTimestamp: SEL_SET_STARTED
  });
  console.log("cursorFile:", CURSOR_FILE, "| poolsFile:", POOLS_FILE);
  console.log("pollMs:", POLL_MS, "| confirmations:", confirmations);
  console.log("dataSource:", dataSourceLabel, dataSourceKeyMissing ? "(NO KEY ⚠️)" : "(with key)");
  console.log("watchAddresses:", watchAddresses.length ? watchAddresses.join(", ") : "(none)");
  console.log(
    "recipients:",
    recipientChatIds().length,
    "(env",
    envChatIds.length,
    "+ subs",
    subscribers.size,
    ")"
  );
  if (recipientChatIds().length === 0) {
    console.warn("提示：当前没有任何收件会话。设置 TG_CHAT_ID 或在群里发 /subscribe。");
  }
  if (network.chainId !== 56n) console.warn("警告：当前 RPC chainId 不是 56，可能不是 BSC 主网。");

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
