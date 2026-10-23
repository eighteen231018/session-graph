# session-graph

**session-graph** 是一个 Claude Code 插件，用卡片树展示当前项目中的会话分支关系。Desktop 卡片显示会话标题和消息预览；CLI 卡片显示会话 ID、分支类型和分支后的首条提示词，点击可跳转会话。

## 功能

- 以树形卡片展示根会话和由 fork 创建的分支；当前会话用主题橙色边框和文字，其他分支使用主题前景色和灰色边框。
- 连接线为按分支层级着色的细线，同层同色，并以沿线移动的亮色短线显示流向。
- 在 Claude Code Desktop 中新建、恢复或切换到某个会话时自动打开面板，无需输入命令。
- 支持 CLI 终端面板，同时展示根、fork 和 branch 分支；支持键盘操作和在当前终端内执行 `/resume <id>` 跳转。
- 将同一 App 会话对应的多份 CLI 转录合并为一张卡片，避免 rewind、编辑重发或清空后出现重复分支。
- 刷新图谱、复制当前会话 ID，并导出可离线查看的静态 HTML。
- 在 Desktop 面板中删除会话前要求确认，并通过宿主的会话管理器执行删除；有子分支的会话会提示先删除子分支，不会执行删除。
- 支持面板主题切换；会话记录不可用时提供降级视图。

## 安装

### Claude Code Desktop

在 Code 会话中打开 `+` → **Plugins / Add plugins**，添加 marketplace：

```text
eighteen231018/session-graph-marketplace
```

然后在列表中选择 `session-graph` 安装。安装后可在 **Manage plugins** 中启用、禁用或卸载；更改后按界面提示重新加载插件，或重启会话。

### CLI

```bash
claude plugin marketplace add eighteen231018/session-graph-marketplace
claude plugin install session-graph@session-graph-marketplace
```

Claude Code 会自动克隆 marketplace 和插件仓库到本机插件缓存，之后可用 `claude plugin update session-graph` 更新。

### 本地开发

克隆仓库后，用 `--plugin-dir` 启动：

```bash
git clone https://github.com/eighteen231018/session-graph.git
claude --plugin-dir ./session-graph
```

`--plugin-dir` 是 Claude Code CLI 的单次启动参数，只会在这条命令启动的终端会话中加载插件，适合本地试用和开发。要停止使用，先按 `Ctrl+C` 退出当前会话，再不带插件参数启动：

```bash
claude
```

不带 `--plugin-dir` 启动时不会加载这个本地插件，插件文件会保留。加载或更新插件后，在 Claude Code 中运行 `/reload-plugins`。不要把 `CLAUDE_CODE_PLUGIN_DIRS` 当作 Desktop 安装方式。

## 使用

```text
/session-graph          打开分支图谱
/session-graph focus    打开面板并请求键盘焦点
/session-graph refresh  刷新图谱并打开面板
/session-graph export   导出静态 HTML
/session-graph close    关闭面板
```

在面板中可以刷新图谱、导出 HTML、复制当前会话 ID。Claude Code Desktop 中每次打开、恢复或切换到一个会话时都会自动打开面板，无需运行命令；关闭面板后，下一次切换到该会话时会再次打开。Desktop 卡片支持打开和删除会话。

### CLI 终端

- 用 `/session-graph` 手动打开面板；终端不会自动打开。CLI 独立运行时会请求更高的面板和键盘焦点；如果焦点仍在输入框，用 `/session-graph focus` 或 `Ctrl+X Tab` 交给面板。
- `Tab` / `Shift+Tab` 选择按钮，`Enter` 激活，方向键滚动。面板持有焦点时，`r` 刷新、`e` 导出 HTML、`c` 复制当前会话 ID、`g` 定位当前卡片。
- 卡片标题和面板顶部显示完整会话 ID；卡片标注“根分支”“fork 分支”或“branch 分支”。描述显示该分支创建后的第一条用户提示词；继承历史、系统通知、工具结果和命令输出不作为描述。尚无提示词时显示空状态。原始会话标题不会被改写。
- 激活非当前卡片的标题、正文或“跳转”按钮，会在当前终端运行 `/resume <id>`，相当于恢复该 ID 对应的会话。宿主正在执行一轮任务时，命令会等待空闲后执行。
- 跳转前通过 `claude agents --json` 核对目标的完整会话 ID；仍在后台运行时，使用该记录返回的后台任务 ID 执行 `claude stop <任务ID>`，再运行 `/resume <会话ID>` 进入主会话。停止保留会话转录。宿主的后台视图与主会话是不同状态，插件会等待主会话 ID 更新后才报告成功。
- 跳转失败会给出原因，并尝试复制 `claude --resume <id>` 供手动恢复；不支持 OSC 52 的终端可能无法写入剪贴板。
- CLI 不显示删除按钮；请在 Claude Code Desktop 中删除会话。
- 终端连接线按层级静态着色；树超过终端宽度时改用带缩进的纵向排列，所有分支均可通过上下滚动查看。Desktop 的卡片布局和流动高亮保留。
- CLI 导出的 HTML 会显示各卡片的恢复命令。
- 终端卡片为紧凑视图，面板高度仍受终端尺寸和宿主保存的手动尺寸限制；图谱较高时用 ↑/↓ 滚动。更新本地代码后运行 `/reload-plugins`，再关闭并重新打开 `/session-graph`。

## 数据与隐私

- 图谱从本机 `~/.claude/projects` 中的转录文件读取消息，并尝试读取 Claude Code App 的本机会话记录以识别会话标题、分支关系及多个转录文件之间的对应关系。
- 插件不会自动上传会话数据。运行 `export` 会在当前项目目录生成 `session-graph-<会话ID>.html`；导出文件包含消息预览和会话 ID，请在分享前检查内容。
- 删除操作通过宿主提供的会话管理器执行。管理器不可用或拒绝删除时，插件不会绕过它直接删除转录文件。

## 限制

- Desktop 跳转到会话依赖宿主的会话管理能力，属于尽力而为；不可用时插件会提供会话 ID 作为替代。CLI 通过宿主的 `/resume` 切换，不依赖 Desktop 会话管理器。
- 本地转录和 App 会话记录是宿主的存储格式，不是插件专用的稳定 API。记录缺失或格式变化时，图谱会尝试降级显示当前会话。
- 插件扫描当前项目最近的 32 份转录，并额外包含当前会话的转录。更早且不再包含在扫描范围内的分支可能不会显示。
- App 记录的父链优先。没有 App 父链时，优先根据复制消息保留的来源 `sessionId` 识别分支（包括 `--fork-session` 产生的分支和完整副本），外来消息必须位于本会话消息之前。
- 终端内置 `/fork` 可能重写复制消息的 `sessionId`。独立 CLI 会结合宿主写入的 fork 来源通知、共享历史截止时间和消息 UUID 匹配唯一父会话；多代 fork 使用最新通知，不按标题、文件时间或消息数量猜测。没有唯一来源时保留独立根。
- 独立 CLI 的 `/branch` 使用复制记录上的 `forkedFrom.sessionId` 识别直接来源；宿主 branch 创建记录用于排除比 fork 更晚创建的父候选。缺少明确来源且历史有歧义时不会按标题猜测连接。
- Desktop 继续按本机 App 记录识别父链；没有来源通知或 App 记录时，沿用创建时间和历史包含关系推断。多代 fork 缺少元数据时仍可能无法确认直接父会话。
- 独立 CLI 会沿转录自身的 `continued-in` 记录合并同一会话，恢复命令指向续接后的转录，避免重复父候选使子分支失联。缺少明确续接记录的 rewind、编辑重发或 clear 仍可能各显示一张卡片；相同历史或复制来源不作为合并依据。Desktop 与混合连接继续使用 App 会话记录。

## 项目结构

```text
session-graph/
├── .claude-plugin/plugin.json  # 插件元数据
├── hooks/hooks.json           # 插件入口配置
├── hooks/register.tsx         # 命令、面板和事件处理
├── lib/                       # 转录读取、图谱构建、布局和导出
├── tests/                     # 分支推断、扫描与 CLI/Desktop 回归测试
└── types/                     # 图谱数据类型
```
