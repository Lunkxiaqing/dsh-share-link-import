# dsh-share-link-import

把 **DeepSeek 公开对话分享链接**（`https://chat.deepseek.com/share/<share_id>`）导入成
DeepSeek Harness (DSH) 里的一个**真实会话**，落在你指定的工作区里。

导入出来的会话就是一段已经结束的历史：

- 打开即可看到完整的问答，不需要任何生成；
- 不会向模型发请求，也不会产生额外网络请求；
- **不需要 DeepSeek 登录凭据**（读的是和未登录浏览器同一个公开接口）；
- 同一个分享链接再次导入会被拦下，除非你明确选择「仍然导入为新会话」。

## 安装

插件是一个零依赖、零构建的 bundle。两种安装方式任选其一：

**从本地目录安装（推荐）**

1. 把整个 `dsh-share-link-import` 目录放到一个长期保留的位置；
2. 打开 DSH → **插件 (Plugins)** → **添加插件 / Add plugin**，选择该目录；
3. 刷新页面（Host 侧新插件通过 HMR 生效；若没有生效，重启承载 `dsh web` 的进程）。

**命令行安装**

```bash
dsh plugin --profile <profile> add link:/absolute/path/to/dsh-share-link-import
```

> 本机 DSH Desktop 的活动 profile 是 `desktop`（不是 `web`），因此这里是
> `dsh plugin --profile desktop add link:…`。插件本身与 profile 名称无关，
> `cordis.patch.yml` 会把自己的 Host 行插入任何加载它的 profile。

## 使用

1. 侧边栏底部的操作区里多出一个下载图标（在账号栏上方那一行，可能和其他插件的图标并排，
   鼠标悬停会显示 **分享导入**）；
2. 粘贴分享链接（也可以只粘贴 share id）；
3. 选择**目标工作区**；
4. **预览** 看标题与轮次，然后 **导入**；
5. 导入完成后回到侧边栏打开新会话，历史已就绪，可以直接继续聊天。

导入面板自带浅色/深色两套配色：打开时读取当前页面实际使用的主题（而不是系统主题），
所以即使 DSH 里手动切换了明暗，面板和其他界面也保持一致。

## 工作方式

```
分享链接 → 解析 share_id → GET /api/v0/share/content?share_id=…
        → 读取 messages[].fragments（REQUEST / RESPONSE）
        → 配对问答轮次（丢弃没有回答的提问）
        → 生成 v4 事件 → sessionPersistence 写入 → 读回校验
        → workspace.attachSession → 刷新投影缓存
```

写入的事件序列：

```
session/title → turn/start → step/start → user/message → assistant/message
              → step/end → turn/end → … → session/end-seed
```

- 每一轮都是 `turn/end { kind: 'completed' }`，没有悬空的 turn；
- 第一条 turn 里有一个空的 `system/message` 作为 surface 节点 0：这是 DSH 给系统提示预留的位置；
- 末尾的 `session/end-seed` 把导入内容标记为种子历史，而不是“正在进行的对话”；
- 标题写自分享标题（没有就用第一个问题，按 UTF-8 截断到 80 字节），来源标为
  `user`，因此以后不会被自动标题生成覆盖。

## 请求形状与缓存

导入的历史是“静态”的，真实对话却是“动态”的，两者拼在一起时最容易出问题的是**系统提示落在哪**。

DSH 只为 surface 节点 0 预留系统提示位。如果什么都不做，恢复导入会话时 DSH 会把真实系统提示
**追加在导入历史之后**——模型先读一百多轮分享内容，最后才看到自己的系统提示；而且一旦之后
某个请求开启新的序列（例如工具声明变了），DSH 会把这个提示“归并”回节点 0，请求的第一条
消息随之改变，整段前缀缓存一次性失效。

插件的做法是：对**导入后还没发过消息**的会话，在第一次请求时让 Agent 循环开启一个新的请求序列
（`agent/pre-step` 返回 `startsRequestSeries: true`）。于是系统提示被归并到节点 0，
请求形状和普通会话完全一致：

```
[系统提示][导入的历史……][你刚发的问题]
```

这条逻辑只在“节点 0 还是空的、且会话还没有任何请求记录”时生效一次，之后不再干预任何会话。

关于缓存，实测（本机日志）需要注意两点：

- 导入后**第一次**请求必然是全价：这段历史从未发给过模型，没有可命中的前缀；
- 从第二次请求起前缀稳定，命中率 99%~100%；
- 会影响命中率、但不由插件控制的：**工具声明列表变化**（增删插件后重启，请求开头的
  工具块变了，前缀从那里断开）以及**缓存过期**（隔几天再聊）。

已经导入、并且在导入后聊过天的旧会话不会追溯修改；如需新的请求形状，重新导入一次即可。

## 去重

去重记录写在 `$DSH_HOME/share-link-import/index.json`，键是 share id：
`{ sessionId, title, importedAt }`。重复导入会返回 `ALREADY_IMPORTED`，
面板上给出「仍然导入为新会话」的选择。

## 错误码

| 代码 | 含义 |
| --- | --- |
| `SHARE_LINK_INVALID` | 链接格式错误、缺少 share id、域名不对，或不是 https |
| `SHARE_NOT_FOUND` | 分享已删除、已过期或不存在（含 `biz_code` 非 0） |
| `SHARE_FORBIDDEN` | 分享未公开，DeepSeek 拒绝匿名访问（HTTP 401/403） |
| `SHARE_SERVER_ERROR` | 分享服务 5xx |
| `SHARE_FETCH_FAILED` | 网络错误、超时（20s）或内容超过 8 MiB |
| `SHARE_MALFORMED` | 接口返回的不是可读的分享文档 |
| `SHARE_EMPTY` | 分享里没有任何完整问答轮次 |
| `ALREADY_IMPORTED` | 该 share id 已导入过 |
| `WORKSPACE_REQUIRED` / `WORKSPACE_UNKNOWN` | 没有选择 / 找不到目标工作区 |
| `WORKSPACE_NOT_WRITABLE` | 工作区目录不存在或不可写 |
| `PERSISTENCE_UNAVAILABLE` | 当前 DSH 没有挂载会话存储 |
| `WRITE_FAILED` | 写入失败（会尽力清理残留会话） |
| `VERIFY_FAILED` | 写入后读回校验失败（会尽力清理残留会话） |
| `INTERNAL` | 其他未预期错误 |

所有错误都有中文说明，面板会同时显示错误代码。

## 已知限制

- 只支持 DeepSeek 分享（`chat.deepseek.com`），不支持豆包等其他来源；
- 只导入文字：图片、视频、网页搜索卡片、引用标记都不会进入历史；
- 分享必须是**公开**的；需要登录才能看的分享无法导入；
- 未验证「有效分享」的端到端网络路径（本机没有可用的公开分享样本）：
  链接解析、文档解析、事件生成、写入与去重都有离线测试覆盖；
- 侧边栏列表由 DSH 自己的 workspace follow 流更新；若导入后没有立即出现，
  刷新页面即可。

## 自测

```bash
node test/smoke.mjs        # 42 项离线断言，不联网
```

手动验证「分享链接 → 导入 → 查看会话」：

1. 在 DeepSeek 网页端打开任意对话 → **分享** → 复制公开链接；
2. DSH 侧边栏 → **分享导入** → 粘贴链接 → 选择工作区 → **预览**；
3. **导入**，记下会话 ID；
4. 侧边栏打开该会话：应看到与网页端一致的问答；
5. 再导入同一链接：应得到 `ALREADY_IMPORTED`；
6. 粘贴一个乱写的链接：应得到 `SHARE_LINK_INVALID` 且不崩溃；
7. 把链接里的 share id 改一个字符：应得到 `SHARE_NOT_FOUND`。

验证请求形状（导入后第一次发消息）：

```bash
# 在该会话的日志里，system/message 应出现在 turn 1 的 step 1，位置在
# 导入的第一条 user/message 之前（节点 0 被 replace），而不是追加在末尾
```

## 隐私

- 只访问 `chat.deepseek.com` 的公开分享接口，不带 cookie、token 或账号信息；
- 只写两样东西：目标工作区下的会话日志，以及上面那份去重记录；
- 没有遥测、没有后台请求。

## 许可

MIT。
