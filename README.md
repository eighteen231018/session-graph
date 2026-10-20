# session-graph

在 Claude Code Desktop 的侧边 `Pane` 中以 **一分支一卡片** 展示当前会话的 fork / branch 关系：卡片标题是用户给分支起的名字，正文是该分支的第一条用户消息；点击卡片会尝试直接打开对应会话。卡片按二维树排列：根在顶部，父卡片居中于子卡片上方，兄弟并排；连接线是竖—横—竖折线（Desktop 用 1 格背景色条，不是 ASCII 字符），其他 surface 用缩进 + `└─` 兜底。

「一个分支」是 App 里的一个会话。Desktop 在一次 rewind、编辑重发或 clear 后会把同一个会话换到新的 CLI 转录文件（新的 `cliSessionId`），旧文件仍留在 `~/.claude/projects`；插件读取 App 的会话记录，把同一个会话的所有转录文件合并成一张卡片，所以继续问答不会再多出卡片。真正的 fork 才会分出新的卡片。

## 安装（开发版）

把插件目录加入会话的插件目录，任选其一：

```bash
claude --plugin-dir /path/to/session-graph
```

或在 `~/.claude/settings.json` 的 `env` 中设置（Desktop / SDK 启动的本地会话同样生效）：

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/session-graph"
  }
}
```

已安装的插件在终端里用 `/reload-plugins` 重新读取。

要让**同一个项目里的所有会话**都加载插件，把路径放进用户级 `~/.claude/settings.json` 的 `env.CLAUDE_CODE_PLUGIN_DIRS`（Desktop 启动的每个会话都会读取）。已经运行的旧会话需要重启/重开一次；新启动的会话会直接加载。

## 使用

```
/session-graph           打开面板（默认卡片视图）
/session-graph focus     打开并让面板获取键盘
/session-graph refresh   重新扫描转录
/session-graph export    导出静态 HTML（可离线打开）
/session-graph close     关闭面板
```

面板内按钮：刷新、删除会话、导出 HTML、复制会话 ID。

卡片视图默认开启。点击卡片会通过 App 自己的会话管理 MCP（`ccd_session_mgmt`）解析 `claude://` 深链并调用宿主 `open`；`$.mcp.call` 不可达时再尝试 `$.tool.call('mcp__ccd_session_mgmt__list_sessions')`。都失败或宿主拒绝时，会自动复制会话 ID 并提示。

每张卡片都有「删除会话」按钮。删除前先弹确认；确认后调用 App 的 `mcp__ccd_session_mgmt__delete_session`，由 App 决定是否允许（当前会话、运行中/打开/固定会话会被拒绝，worktree 有未提交改动时会另行提示）。管理器不可达时**不会**退化为 `rm`，不会删除任何文件。

## 项目共享与当前分支

- 每个会话有自己的 Pane 实例；插件按**当前会话所属的根会话族**建树，切到另一个根会话时会显示那个根的树。
- 当前会话的卡片用双线边框、`★`、`当前分支` 元信息和 `当前` 操作标记；Pane 标题显示 `分支树 · <当前分支名>`。
- 切到某个分支会话后，该分支高亮；点击其他卡片会尝试打开对应会话。
- 插件路径写在用户级 `CLAUDE_CODE_PLUGIN_DIRS` 后，项目里的新会话都会加载它；已运行且未加载插件的旧分支会话需要重开一次。

## 能力与边界

| 能力 | 本包行为 |
|---|---|
| 侧边面板 | `$.ui.open` + `ui.render` 的 `Pane`，Desktop 上 dock 在对话旁；用户可关闭，命令可重开 |
| 卡片视图 | 所有 surface 都用 Pane 原生 `Box` / `Text` / `Button`；标题和正文本身是点击按钮，标题为自定义分支名，正文为该分支第一条用户消息 |
| 删除会话 | 每张卡片一个「删除会话」按钮：先确认，再调用 App 的 `ccd_session_mgmt.delete_session`；当前会话与运行中/打开/固定会话由 App 拒绝。删除成功后会立刻把该分支的卡片移除；App 只删除会话记录、留下转录文件的，按 `deleted_*` 墓碑过滤，不再显示。App 里已不存在的卡片再次删除时只从树中移除并提示，不会误删其他同名会话 |
| 树形连接线 | 二维树布局：父卡片居中于子卡片上方；每个子节点一条竖—横—竖折线，用 Pane 原生 1 格 `Box` 背景色条绘制 |
| 数据源 | 优先读取 `~/.claude/projects/<project>/<sessionId>.jsonl` 的 `uuid` / `parentUuid` / `timestamp`；同时读取 App 的会话记录（`claude-code-sessions/<profile>/<org>/local_*.json`）里的 `cliSessionId` / `priorCliSessionIds` / `preClearCliSessionId` / `forkedFromSessionId`，用它们把同一会话的多个转录文件合并成一张卡片，并确定真正的 fork 父子关系；同一目录下的 `deleted_*` 墓碑用于过滤 App 已删除但留在磁盘上的转录。App 记录读不到时降级为按转录推断；转录也读不到时再降级为 `$.session.messages()` 的线性视图，并在面板中显示提示 |
| 一分支一卡片 | 卡片的单位是 App 会话，不是转录文件。rewind / 编辑重发 / clear 产生的多个 `cliSessionId` 都属于同一个会话，只显示一张卡片；fork 出来的新会话才是新卡片 |
| 跨会话 fork | App 会话记录里的 `forkedFromSessionId` 优先作为父节点（分叉会话正好是它的子节点）；没有记录时，同一项目的转录文件共享 uuid 前缀，第一个不在父会话中的 uuid 即分叉点。父节点必须是**创建更早**的会话（App 的 `createdAt` 优先，缺失时用转录首条时间）；在更早候选中按共享历史包含度选父，所以新增分支不会把老根翻成子节点。跨会话 fork 生成 `type: "fork"` 节点 |
| 会话内分叉 | 同一 `parentUuid` 下出现多个消息（rewind / 编辑重发）时生成 fork 节点 |
| 跳转到会话位置 | **⚠️ 有限支持（best-effort）**。插件 API 没有深链/路由方法；实现通过 App 已连接的 `ccd_session_mgmt` MCP 取 `claude://claude.ai/epitaxy/local_<id>`，再用宿主 `open` 打开。该 MCP 或宿主不可用时复制会话 ID，不伪造成功 |
| terminal / mobile / VS Code | 与 Desktop 同一套原生卡片树，保留打开、删除、导出操作 |
| 主题 | 读取 `$.config.list()` 的 `theme` 行，在 light/dark 两套调色板间切换 |
| 实时刷新 | `turn.complete` / `prompt.submit`（捕获 `/fork`、`/branch`、`/clear`）/ `command.run` + 5s 全量扫描，外加每 1s 一次轻量文件集监听（只列目录、不解析）；删除或新建会话文件后约 1s 内更新，删除按钮成功后还会立即刷新 |

## 数据模型

严格使用约定的字段名：

```ts
type GraphNode = {
  nodeId: string;
  type: "message" | "fork";
  parentNodeId: string | null;
  sessionId: string;
  branchName?: string;
  messagePreview: string;
  timestamp: number;
};
```

- `nodeId`：消息用转录里的 `uuid`；fork 节点用 `fork:session:<sessionId>:<anchorUuid>` 或 `fork:branch:<sessionId>:<parentUuid>`。
- `parentNodeId`：消息用 `parentUuid`（会向上跳过 attachment/system 行，落到最近的消息）；fork 节点的父节点是分叉锚点。
- `sessionId`：转录文件名（与 `$.session.id()` 的定义一致），不是文件内可能残留的源会话 id。
- `branchName`：只在 fork 节点上出现；跨会话 fork 用会话标题（唯一时）或 `会话 <id8>`。
- `messagePreview`：`You:` / `Claude:` 前缀 + 去空白后的前 150 字符；纯工具消息显示工具名。
- `timestamp`：转录的 ISO 时间戳；缺失时单调递增补值。

`GraphSnapshot` 另外携带 `cards: BranchCard[]`（`sessionId` / `title` / `matchTitle` / `firstUserMessage` / `parentSessionId` / `forkAtPreview` / `ownMessageCount` / `messageCount` / `lastTimestamp` / `isCurrent` / `depth`），只用于卡片视图；`GraphNode` 的字段没有改动。卡片的 `sessionId` 是 App 会话 id（`local_<uuid>`，能直接用于打开/删除）；读不到 App 记录时退回转录文件名。

边不单独列出，由 `parentNodeId` 隐式表达。若后续数据模型还有 `GraphEdge` / `GraphData` 等字段，补上即可，不需要改动已有字段名。

## 渲染

- **卡片视图**：二维树。根在顶部；父卡片居中于子卡片上方；兄弟节点并排；每层间隔 5 行。每个子节点用竖—横—竖折线连接，折线在层间总线处分叉。
- 卡片宽 14–30 格，按树的叶子数自动选择能放进面板的最大宽度；卡片固定 9 行。当前分支用双线边框；点击标题、正文或「打开」按钮进入会话。
- 树比面板宽时按树宽绘制，可加宽面板；静态导出使用同一套树布局。
- 根会话取创建时间最早的转录；分支再多也不会因为“消息更少/更多”改变根。若 App 没有返回某个会话的 `createdAt`，用转录首条时间，并以更大的历史作为更早的同时间候选。
- 节点悬停显示 `<title>` 预览；分支按钮用于高亮某个会话。
- 不使用 D3、React 或任何第三方运行时；源码约 78KB，gzip 约 25KB，远低于 200KB 上限。

## 隐私

- 默认只读本地转录文件和 App 的 `claude-code-sessions` 会话记录，不联网、不上传。只有你点击「删除会话」并确认后，插件才通过 App 的会话管理器删除该会话；管理器不可达时不会直接删文件。
- 导出的 HTML 包含消息预览；请自行决定是否分享。

## 已知限制

- 转录 JSONL 是 Claude Code 的本地存储格式，不是公开 API；字段变化时本插件会走线性降级而不是崩溃。
- App 会话记录（`claude-code-sessions` 下的 `local_*.json`）同样是 App 的本地存储，不是公开 API。读不到它时插件退回「一个转录文件一张卡片」的旧行为，但不会崩溃；此时 rewind/clear 产生的旧转录仍可能各占一张卡片。
- `$.fs.read` 单文件上限 4 MiB；更大的文件尝试用 `tail -c` 读取尾部完整行。
- 只扫描当前项目最近 32 个 `.jsonl`，并额外强制包含当前会话的转录（即使它更久没有写入）；更早的会话可能不在图中。若某个分支的旧 CLI 转录已超出这 32 个文件，它不会并入该分支的卡片，但这不影响当前转录和历史统计。当前转录仍找不到时，面板降级为当前会话的线性视图，而不是显示别的会话的树。
- Desktop 的 "Fork from here" 是 UI 动作，不经过 `prompt.submit`；分支依靠文件扫描捕获，hook 只用于提前触发刷新。
- 点击跳转依赖 App 的会话管理 MCP 和 `claude://` 深链；这是 App 级能力，不在插件规范内，可能随版本变化。失败时只会复制会话 ID，不会声称已跳转。
- 删除同样依赖 App 的 `ccd_session_mgmt` MCP：不可用时按钮只提示，不会硬删文件。App 删除会话后若把转录 `.jsonl` 留在磁盘上，插件读取 App 写的 `deleted_<cliSessionId>` 墓碑（以及 `<id>.desktop-released.json` 标记）并隐藏这些转录；墓碑被清理后，插件重启时旧转录可能重新出现（同一进程内会一直记住）。没有 App 会话记录的孤儿卡片再次删除时只会从树中隐藏，不会删除任何文件。
- 已用 Claude Code 2.1.299 自带的 CLI 运行 `claude plugin validate`（通过）和 `claude plugin test`（10 个用例全部通过）；最终加载结果以引擎为准。

## 文件结构

```
session-graph/
├── .claude-plugin/plugin.json
├── hooks/hooks.json
├── hooks/register.tsx        # 事件、命令、面板与状态
├── types/index.d.ts          # GraphNode/BranchCard/GraphSnapshot + PluginState 契约
├── tests/grouping.test.ts    # 一分支一卡片、合并 transcript、父节点与降级
└── lib/
    ├── collect.ts            # 定位转录、读取、缓存、降级
    ├── app-store.ts          # 读取 App 会话记录：一个会话的全部 CLI 转录 id 与 fork 父节点
    ├── mcp-text.ts           # MCP / tool 返回文本的统一解析（content / text / 嵌套 result）
    ├── parse.ts              # JSONL → 消息（uuid/parentUuid/timestamp）
    ├── graph.ts              # 按 App 会话分组、跨文件去重、fork 识别、节点与卡片构建
    ├── tree.ts               # 二维卡片树布局与折线连接段
    ├── session-link.ts       # 会话深链解析与宿主打开（best-effort）
    └── export.ts             # 静态 HTML 导出
```

> `.claude-plugin/types/` 与根 `tsconfig.json` 由 Claude Code 在识别/加载插件时生成；前者已被 `.gitignore` 排除，不属于前端运行时代码。
