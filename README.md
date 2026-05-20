# BSC InitializePool / AddPoolOwners Telegram 监听机器人

监听 BSC 链上某个合约的 `initializePool` 与 `addPoolOwners` 调用，命中后把新池 / 加管理员信息推送到 Telegram。
默认监听 PancakeSwap Infinity 的 `CLAlphaHook` 合约 `0xb0bb171D333569CfD28a37F5c5DdDAAa90aD46af`，
并默认只推送由 `0xb55eDCBEc988931a1f25f541B1C09F7AB817CD9E` 发起的交易（可关闭）。

- 监听的是**已确认区块**（轮询扫块 + 可配置确认数），稳定性比 pending/mempool 高。
- 自带 Telegram 命令菜单、白名单权限控制，可拉进群使用。
- 每个 poolId 都附 PancakeSwap 池子链接和内联按钮；`/pool` 还能读链上**当前价格**。
- 池子信息持久化到 `pools.json`，重启后历史池子仍能显示币对。
- Telegram 推送失败会重试，并且不前进游标，避免漏告警。
- 无需公网 webhook（用 `getUpdates` 长轮询），适合直接部署到 Railway。

## 监听的方法

| 方法 | 选择器 | 推送内容 |
|---|---|---|
| `initializePool(PoolKey key, uint256 startTimestamp, uint160 sqrtPriceX96)` | `0x57c036db` | 🟢 新池：币对、双向价格、Fee、PoolId、PancakeSwap 链接、Token0/1、Hooks、PoolManager、开始时间 |
| `addPoolOwners(bytes32 poolId, address[] owners)` | `0xfe7815ed` | 🟠 加管理员：PoolId、PancakeSwap 链接、新增 Owners、调用者（缓存命中时补充币对/Fee） |

### poolId 与币对关联

看到 `initializePool` 时，机器人按 PancakeSwap Infinity 规则 `keccak256(abi.encode(PoolKey))` 计算 poolId，
并缓存该池的 Token0 / Token1 / Fee。之后命中**同一 poolId** 的 `addPoolOwners` 时，告警会自动补上币对信息。

poolId → 币对的映射会写入 `pools.json` 持久化，因此：

- 监听到 `initializePool` 时缓存并落盘；启动时从 `pools.json` 载入。
- 重启后命中的 `addPoolOwners` 仍能显示币对（只要这个池子之前被监听到或用 `/import` 导入过）。
- 完全没记录过的历史池子，`addPoolOwners` 只显示 poolId，可用 `/import <initializePool 交易哈希>` 补齐。
- poolId 计算用的是标准 v4 / Infinity 编码方案。可用 `/preview <initializePool 交易哈希>` 比对算出的 PoolId 是否与链上 Initialize 事件里的 id 一致来验证。

### PancakeSwap 池子链接与按钮

只要有 poolId，就能直接拼出池子链接，无需额外查询：

```
https://pancakeswap.finance/liquidity/pool/bsc/<poolId>
```

所有涉及 poolId 的告警 / 命令（`initializePool`、`addPoolOwners`、`/preview`、`/pool`、`/import`、`/last`）都会附：

- 正文里一行 `PancakeSwap: 🥞 Open Pool` 链接；
- 底部内联按钮：第一行 **🥞 Pancake Pool** / **🔎 BscScan Tx**，第二行 token / owner 相关按钮：
  - `initializePool`、`/pool`：`[Token0] [Token1]`（链到 BscScan 代币页）
  - `addPoolOwners`：`[Owner] [Hook 合约]`
  - 示例预览的零哈希交易不显示 BscScan Tx 按钮。

## Telegram 命令

启动时会自动注册命令菜单（输入框旁的菜单按钮）。

| 命令 | 权限 | 说明 |
|---|---|---|
| `/help`（`/start`） | 所有人 | 显示帮助与命令列表 |
| `/id` | 所有人 | 查看你的 TG 用户 ID 和当前会话 ID（用来配白名单） |
| `/status` | 白名单 | 运行状态：链 ID、监听合约、From 过滤、最新块、已扫到哪、落后多少、检查间隔、运行时长 |
| `/test`（`/check`） | 白名单 | 检查 RPC（报最新块和延迟）并向所有告警会话发测试消息确认推送可用 |
| `/preview [txHash]` | 白名单 | 不带参数渲染示例告警；带 txHash 则拉真实交易解码后预览（支持两种方法） |
| `/pool <poolId>` | 白名单 | 查询池子：币对、PancakeSwap 链接、初始价格、链上**当前价格**（读 `getSlot0`）、Init Tx |
| `/import <txHash>` | 白名单 | 把历史 `initializePool` 交易解码并导入 `pools.json`，之后 `/pool` 和 `addPoolOwners` 都能用 |
| `/last [n]` | 白名单 | 查看最近 n 条告警（默认 5，最多 20） |

只有白名单内的用户能用控制命令，其它人无法控制本机器人。

### 在群里使用

把机器人拉进群即可。群里使用命令需满足以下任一条件：

- 在 [@BotFather](https://t.me/BotFather) → 你的 bot → `Bot Settings` → `Group Privacy` → **Turn off**（关闭隐私模式），或
- 用 `/命令@你的机器人用户名` 的形式发送（机器人会自动识别 `@` 后缀）。

## 环境变量

复制 `.env.example` 为 `.env` 后填写。

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `RPC_URL` | ✅ | — | BSC RPC，建议用自己的稳定节点；公共 RPC 容易限速 |
| `TG_BOT_TOKEN` | ✅ | — | BotFather 给的 token |
| `TG_CHAT_ID` | ✅ | — | 告警推送目标，支持逗号分隔多个（私聊 / 群 / 频道） |
| `WHITELIST_IDS` | | 空 | 控制命令白名单（TG 用户 ID，逗号分隔）。留空 = 没人能控制 |
| `TARGET_CONTRACT` | | `0xb0bb171D…46af` | 监听的合约，也就是交易里的 To |
| `FILTER_FROM` | | `0xb55eDCBE…CD9E` | 只推这个地址发起的调用；留空 = 监听所有调用者 |
| `START_BLOCK` | | 空 | 首次启动从哪个区块开始扫；留空则从最新块开始，不推历史 |
| `POLL_MS` | | `30000` | 每隔多少毫秒检查一次新区块（默认 30 秒） |
| `MAX_BLOCKS_PER_TICK` | | `40` | 单次最多扫多少块，防积压 |
| `CONFIRMATIONS` | | `3` | 扫块确认数，避免链重组；只扫 `latest - N` 之前的块 |
| `RPC_TIMEOUT_MS` | | `15000` | 单次 RPC 调用超时（毫秒） |
| `TIMEZONE` | | `Asia/Taipei` | 时间显示用的时区 |
| `CURSOR_FILE` | | `./lastBlock.txt` | 游标文件路径（见下方持久化说明） |
| `POOLS_FILE` | | `./pools.json` | 池子缓存文件路径（见下方持久化说明） |

## 本地运行

```bash
npm install
cp .env.example .env   # 然后填写 RPC_URL / TG_BOT_TOKEN / TG_CHAT_ID 等
npm start

npm test     # 运行单元测试（vitest）
npm run lint # eslint
npm run format # prettier
```

配置白名单的流程：先启动 → 私聊机器人发 `/id` 拿到你的用户 ID → 填进 `WHITELIST_IDS` → 重启。

测试历史交易：把 `START_BLOCK` 设为目标区块（例如 `99031467`），删掉游标文件 `lastBlock.txt` 再启动。

## 部署到 Railway

1. 打开 [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo** → 选择本仓库，分支选 `claude/bsc-initpool-tg-bot-vCd1s`（或合并后的主分支）。
2. 进入 service 的 **Variables**，按上表把变量填进去，至少需要 `RPC_URL`、`TG_BOT_TOKEN`、`TG_CHAT_ID`（建议同时设好 `WHITELIST_IDS`）。
3. Railway 会用 Nixpacks 自动构建并执行 `npm start`（见 `railway.json`）。这是常驻 worker，不需要配端口或域名。
4. **持久化游标和池子缓存（推荐）**：Railway 文件系统是临时的，重启会丢失。如需持久化：
   - 在 service 的 **Data / Volumes** 挂载一个 Volume（例如挂到 `/data`）；
   - 增加变量 `CURSOR_FILE=/data/lastBlock.txt` 和 `POOLS_FILE=/data/pools.json`。

## 工作原理

每隔 `POLL_MS` 毫秒，机器人读取最新区块号，减去 `CONFIRMATIONS` 得到确认后区块，从上次游标位置逐块向前扫描
（单次最多 `MAX_BLOCKS_PER_TICK` 块）。对每个区块，取出全部交易，筛出 `To == TARGET_CONTRACT` 且方法选择器命中、
且通过 `FILTER_FROM` 过滤的交易，确认 receipt 状态成功后解析参数并推送到 Telegram。

- **不漏告警**：某块的告警若所有会话都推送失败（含重试），会抛错使该块游标不前进，下一轮重试。
- **不重复 / 不漏块**：成功后才把游标写入 `CURSOR_FILE`。
- **RPC 健壮**：所有链上调用都包了超时（`RPC_TIMEOUT_MS`），避免单个请求卡死。

> 想抢跑监听“未确认 pending 交易”需要换成支持 BSC pending tx 的 WebSocket RPC，很多公共 BSC RPC 不开放完整 pending 流。

## 项目结构

```
bot.js            入口：扫块、游标、Telegram 推送、命令、持久化
src/core.js       纯函数：ABI/选择器、poolId 计算、价格换算、URL/按钮、格式化（有单元测试）
test/core.test.js core.js 的单元测试（vitest）
railway.json      Railway 部署配置
```

## 告警样式

`initializePool`：

```
🟢 新池初始化 | NEX / BSC-USD
价格: 1 NEX ≈ 0.0000015 BSC-USD
      1 BSC-USD ≈ 666,666 NEX
手续费: 67，约 0.0067%
PoolId: 0xae749...41abd
PancakeSwap: 🥞 Open Pool
[🥞 Pancake Pool] [🔎 BscScan Tx]
[NEX] [BSC-USD]
```

`addPoolOwners`：

```
🟠 添加池子管理员 | NEX / BSC-USD
PoolId: 0xae749...41abd
新增 Owners (1): 0xB62Abc...18756
调用者: 0xb55eDC...CD9E
⚠️ 这是权限/配置变更，不是转账。
[🥞 Pancake Pool] [🔎 BscScan Tx]
[Owner] [Hook 合约]
```
