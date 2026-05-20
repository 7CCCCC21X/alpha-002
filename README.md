# BSC InitializePool / AddPoolOwners Telegram 监听机器人

监听 BSC 链上某个合约的 `initializePool` 与 `addPoolOwners` 调用，命中后把新池 / 加管理员信息推送到 Telegram。
默认监听 PancakeSwap Infinity 的 `CLAlphaHook` 合约 `0xb0bb171D333569CfD28a37F5c5DdDAAa90aD46af`，
并默认只推送由 `0xb55eDCBEc988931a1f25f541B1C09F7AB817CD9E` 发起的交易（可关闭）。

- 监听的是**已确认区块**（轮询扫块），稳定性比 pending/mempool 高。
- 自带 Telegram 命令菜单、白名单权限控制，可拉进群使用。
- 无需公网 webhook（用 `getUpdates` 长轮询），适合直接部署到 Railway。

## 监听的方法

| 方法 | 选择器 | 推送内容 |
|---|---|---|
| `initializePool(PoolKey key, uint256 startTimestamp, uint160 sqrtPriceX96)` | `0x57c036db` | 🚨 新池：PoolId、Token0/1、Hooks、PoolManager、Fee、StartTimestamp、初始价格 |
| `addPoolOwners(bytes32 poolId, address[] owners)` | `0xfe7815ed` | 👤 加管理员：PoolId、新增 Owners 列表（若该池在本次运行内被监听过，则补充币对信息） |

### poolId 与币对关联

看到 `initializePool` 时，机器人按 PancakeSwap Infinity 规则 `keccak256(abi.encode(PoolKey))` 计算 poolId，
并缓存该池的 Token0 / Token1 / Fee。之后命中**同一 poolId** 的 `addPoolOwners` 时，告警会自动补上币对信息。

注意：

- 缓存只在**本次运行内**有效；重启后会清空。对历史池子或重启前初始化的池子，`addPoolOwners` 告警只显示 poolId。
- poolId 计算用的是标准 v4 / Infinity 编码方案。部署后可用 `/preview <initializePool 交易哈希>` 比对算出的 PoolId 是否与链上 Initialize 事件里的 id 一致来验证。

### PancakeSwap 池子链接

只要有 poolId，就能直接拼出池子链接，无需额外查询：

```
https://pancakeswap.finance/liquidity/pool/bsc/<poolId>
```

所有涉及 poolId 的告警 / 命令（`initializePool`、`addPoolOwners`、`/preview`、`/pool`）都会：

- 在消息正文里加一行 `PancakeSwap: Open Pool` 链接；
- 在消息底部附带内联按钮 **🥞 Pancake Pool** 和 **🔎 BscScan Tx**（示例预览的零哈希交易不显示 BscScan 按钮）。

## Telegram 命令

启动时会自动注册命令菜单（输入框旁的菜单按钮）。

| 命令 | 权限 | 说明 |
|---|---|---|
| `/help`（`/start`） | 所有人 | 显示帮助与命令列表 |
| `/id` | 所有人 | 查看你的 TG 用户 ID 和当前会话 ID（用来配白名单） |
| `/status` | 白名单 | 运行状态：链 ID、监听合约、From 过滤、最新块、已扫到哪、落后多少、检查间隔、运行时长 |
| `/test`（`/check`） | 白名单 | 检查 RPC（报最新块和延迟）并向所有告警会话发测试消息确认推送可用 |
| `/preview [txHash]` | 白名单 | 不带参数渲染示例告警；带 txHash 则拉真实交易解码后预览（支持两种方法） |
| `/pool <poolId>` | 白名单 | 由 poolId 生成 PancakeSwap 池子链接；若该池在本次运行内见过则补充币对 / 初始价格 |

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
| `TIMEZONE` | | `Asia/Taipei` | 时间显示用的时区 |
| `CURSOR_FILE` | | `./lastBlock.txt` | 游标文件路径（见下方持久化说明） |

## 本地运行

```bash
npm install
cp .env.example .env   # 然后填写 RPC_URL / TG_BOT_TOKEN / TG_CHAT_ID 等
npm start
```

配置白名单的流程：先启动 → 私聊机器人发 `/id` 拿到你的用户 ID → 填进 `WHITELIST_IDS` → 重启。

测试历史交易：把 `START_BLOCK` 设为目标区块（例如 `99031467`），删掉游标文件 `lastBlock.txt` 再启动。

## 部署到 Railway

1. 打开 [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo** → 选择本仓库，分支选 `claude/bsc-initpool-tg-bot-vCd1s`（或合并后的主分支）。
2. 进入 service 的 **Variables**，按上表把变量填进去，至少需要 `RPC_URL`、`TG_BOT_TOKEN`、`TG_CHAT_ID`（建议同时设好 `WHITELIST_IDS`）。
3. Railway 会用 Nixpacks 自动构建并执行 `npm start`（见 `railway.json`）。这是常驻 worker，不需要配端口或域名。
4. **持久化游标（推荐）**：Railway 文件系统是临时的，重启会丢失游标，导致从最新块重新开始。如需持久化：
   - 在 service 的 **Data / Volumes** 挂载一个 Volume（例如挂到 `/data`）；
   - 增加变量 `CURSOR_FILE=/data/lastBlock.txt`。

## 工作原理

每隔 `POLL_MS` 毫秒，机器人读取最新区块号，从上次游标位置逐块向前扫描（单次最多 `MAX_BLOCKS_PER_TICK` 块）。
对每个区块，取出全部交易，筛出 `To == TARGET_CONTRACT` 且方法选择器命中、且通过 `FILTER_FROM` 过滤的交易，
确认 receipt 状态成功后解析参数并推送到 Telegram。游标写入 `CURSOR_FILE`，保证不重复、不漏块。

> 想抢跑监听“未确认 pending 交易”需要换成支持 BSC pending tx 的 WebSocket RPC，很多公共 BSC RPC 不开放完整 pending 流。
