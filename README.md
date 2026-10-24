# GitHub Copilot 桌面端中文汉化 (copilot-desktop-zh)

> 非官方汉化补丁 · 运行时注入 · 不动应用本体 · 升级不失效

## 这是什么

给 **GitHub Copilot 桌面版** (Tauri + WebView2 架构) 提供中文界面的运行时汉化。

> ⚠️ **背景**:该应用没有内置中文,也没有语言文件/插件机制(二进制中无 zh-CN 字符串、
> 无 i18next、无 locales 加载逻辑,界面文案硬编码在 exe 里)。因此唯一的汉化方式是
> 通过 WebView2 调试端口做**运行时注入** —— 本项目即为此实现。

## 致谢与 AI 辅助说明

本项目基于 [zhao818/copilot-desktop-zh](https://github.com/zhao818/copilot-desktop-zh) 原版项目继续完善，并保留原项目 MIT License。使用 AI 辅助检查客户端界面与内嵌选项文案、补充尚未汉化的条目及兼容客户端文案变更；新增译文通过词典匹配检查，具体表达可能需要结合客户端界面继续校对。DeepL 自动翻译为可选功能，仅在本机配置 `DEEPL_AUTH_KEY` 后启用。

## 特性

- **不动应用本体**:不修改 github.exe,应用升级不受影响;
- **持续扩展界面覆盖**:侧边栏 / 主页 / 聊天 / 设置 / 自动化 / 命令面板 / 快捷键 / 弹窗 / 属性提示等(本地字典 1600+ 条 + 动态模式);
- **实时生效**:页面内 MutationObserver + 3 秒轮询兜底,React 重渲染 / 刷新后自动重新应用;
- **不误翻内容**:AI 回复、代码块、技能名、会话标题、用户名等用户内容不会被翻译;
- **字典可扩展**:编辑 `dictionary.json` 保存即生效,无需重启。
- **上游词典同步**:启动时从 `zhao818/copilot-desktop-zh` 获取最新公开词典,运行期间每 6 小时检查一次;本地自定义译文优先保留。

## 环境要求

- Windows + GitHub Copilot 桌面版 (v1.1.x);
- **Node.js** (>= 18,用于运行注入器): https://nodejs.org
- **GitHub CLI** (`gh`,可选;用于同步上游词典): https://cli.github.com

## 使用方法

1. 将本文件夹放在 `github.exe` 所在目录的子目录中（例如 `<安装目录>\copilot-zh`），确保启动器中的 `..\github.exe` 路径有效;
2. 双击 **`启动 GitHub Copilot 中文版.vbs`** 可隐藏终端启动；也可双击 **`启动 GitHub Copilot 中文版.cmd`** 查看注入器日志;
3. 注入器运行期间会持续应用汉化；关闭启动器窗口将停止实时汉化。

> ⚠️ **注意**:必须用这个启动器打开应用才是中文;直接点官方图标启动的仍是英文。

## 工作原理

1. 启动器设置环境变量 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` 后启动应用(WebView2 官方调试开关);
2. 注入器 (`inject.js`) 通过 CDP 连接页面 (`http://tauri.localhost`),把字典注入页面:
   - 精确匹配文本节点 → 替换为中文;
   - 同步翻译 placeholder / aria-label / title / alt;
   - 正则模式处理动态文案(如 `9% used` → `$1% 已使用`);
   - 整句机制处理被拆分的文本节点;
   - 跳过代码块 / 输入框 / 用户内容。

## 自定义翻译

编辑 `dictionary.json`:

| 区块 | 作用 | 示例 |
|---|---|---|
| `texts` | 精确文本替换 | `"Home": "主页"` |
| `textPatterns` | 文本正则替换 | `["^(\\d+)% used$", "$1% 已使用", ""]` |
| `attrs` | 属性精确替换 | `"Command palette": "命令面板"` |
| `attrPatterns` | 属性正则替换 | `["^Open user menu for (.+)$", "打开 $1 的用户菜单", ""]` |
| `wholeElements` | 整句(多文本节点)替换 | `"Chat: New chat": "聊天: 新建聊天"` |

保存后注入器会在 3 秒内自动重新读取并应用。

### 上游词典自动同步

注入器会通过 GitHub CLI 读取 `zhao818/copilot-desktop-zh` 的公开 `dictionary.json`,将上游新增条目与本地词典合并。本地已有条目优先,不会被上游覆盖。若 `gh` 不可用、网络失败或上游词典无法解析,注入器会记录警告并继续使用本地词典。

此功能同步的是**上游已经提供的译文**,不是通用机器翻译。客户端新增或改写的文案,需先由上游词典收录或在本地词典中补充后才能完整汉化;未配置下文的 DeepL 自动翻译时,未收录文案不会被自动翻译,也不会上传界面内容。

### 未收录设置选项的 DeepL 自动翻译

若要自动补充客户端更新后新出现的设置选项,可在本机配置环境变量 `DEEPL_AUTH_KEY`。注入器只扫描带开关控件的设置行，并只把其中未匹配的英文文本提交给 DeepL API 翻译为简体中文；不会主动扫描聊天消息或代码。传输内容由设置行实际包含的文本决定。译文以追加方式缓存在 `COPILOT_ZH_CACHE_DIR` 指定目录下的 `auto-translations.jsonl`；未设置该变量时，默认使用注入器目录下的 `cache` 子目录。

未配置 `DEEPL_AUTH_KEY` 时不会向 DeepL 发送任何文本,仅在注入器日志中提示配置要求。DeepL API 的用量、费用及隐私条款由用户账户和套餐决定。

## 文件结构

```
copilot-zh/
├── 启动 GitHub Copilot 中文版.vbs   # 隐藏终端启动
├── 启动 GitHub Copilot 中文版.cmd   # 一键启动器(设置调试参数 → 启动应用 → 运行注入器)
├── inject.js                        # CDP 注入器(Node.js,每次轮询重读字典)
├── dictionary.json                  # 翻译字典(文本/属性/正则/整句)
├── README.md
└── LICENSE                          # MIT
```

## 已知限制

- 图标 / 图片内嵌的英文无法翻译;
- 未收录的普通动态文案会保留英文;上游词典收录后可在下次同步时自动获得对应译文。设置选项可按上文配置 DeepL 自动翻译;
- 调试端口 9222 仅供本机访问;如与其他调试器冲突,可自行改端口(需同步改启动器与 `inject.js`);
- 汉化是运行时注入,关闭注入器或刷新页面后恢复英文(重新打开启动器即恢复中文)。

## 免责声明

本项目是**非官方**社区汉化,与 GitHub 公司无关。仅供学习交流使用,请遵守 GitHub Copilot 服务条款。

## License

MIT