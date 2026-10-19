# 发布流程

发布使用 main 的最终落地提交。0.9 系列标记为 Pre-release，不设置为稳定最新版。工作流只准备和核验草稿，最终发布由维护者操作。

## 1. 合入发布候选

- PR 按模板填写行为、原因、实际验证、兼容与回退、AI 使用说明；维护者核对后手动合入。
- 同步 `package.json`、`CHANGELOG.md`、README 安装版本及 `docs/releases/<版本>.md`。实质提交正文说明原因、改动和实际验证。
- 检查代码、提示词、注释和素材来源与许可；检查本次文件及历史范围中没有凭据、个人路径、用户数据和任务日志。
- main 不强制分支保护，维护者可以直推；这不免除检查。测试通过不代表已合入或已发布。

在候选提交运行：

```powershell
npm run check
npm run reconcile -- '<固定宿主源码根>'
npm run check:host -- '<固定宿主源码根>'
npm pack --dry-run --ignore-scripts
git diff --check
```

GitHub Check 须在该提交通过 Windows、Ubuntu × Node 22.19、24，以及 Fixed host fixture。`check:host` 使用宿主 HEAD 夹具，不替代真实安装。

确认 main 已包含所有候选改动，再创建并推送 `v<package.json版本>` 标签。记录完整 40 位 SHA。已推送标签不移动；发现必须修改源码的阻断问题时使用新版本。

## 2. 准备草稿

在 Actions 的 **Prepare draft release** 中选择 main，填写已有标签和完整源 SHA。工作流对源提交运行全部 Check，再生成：

| 附件 | 内容 |
| --- | --- |
| `dsh-breaklimit-<版本>.zip` | 标签中 Git 跟踪的源码、测试、工具和文档，顶层目录同名 |
| `release-metadata.json` | 版本、标签、完整源 SHA、宿主版本与提交 |
| `SHA256SUMS.txt` | ZIP 与来源元数据的 SHA-256 |

ZIP 不含未提交文件、依赖目录、日常配置或恢复数据。打包要求源提交已落入 `origin/main`，上传与核验另查 GitHub 标签的实际 SHA。打包不执行候选代码；写权限仅授予上传草稿的任务，检查使用只读权限。

草稿已存在时，仅补传缺失附件；已有附件必须与本地产物逐字节一致。不覆盖不同内容、不替换标签、不修改已发布版本。上传中断后先查看草稿，再重新运行；如果已有附件不符，停止并人工核对。

本地等价命令（Git、Node，解压另需 Windows 自带 tar 或 Ubuntu unzip）：

```powershell
$ReleaseTag = 'v0.9.3'
$SourceSha = git rev-parse "$ReleaseTag^{}"
$AssetsDir = Join-Path $env:TEMP "dsh-release-$ReleaseTag"
node tools/release.mjs pack . $ReleaseTag $SourceSha $AssetsDir
node tools/release.mjs verify . $ReleaseTag $SourceSha $AssetsDir
node tools/github-release.mjs prepare . $ReleaseTag $SourceSha $AssetsDir docs/releases/0.9.3.md
```

本地草稿命令需要 GitHub CLI 登录和仓库写权限。打包输出目录已有不同产物时拒绝覆盖；改用新目录排查，不要清空未知内容。

## 3. 下载草稿并核验

在 Actions 的 **Verify draft release** 中选择 main，填写相同标签和完整源 SHA。该流程：

1. 从 GitHub 下载实际附件，核对完整资产集合、来源元数据和哈希；从指定提交独立重建 ZIP，比对全部字节。
2. 在新目录解压，在 Windows、Ubuntu × Node 22.19、24 执行接口、语言、测试、文档数字、固定宿主对账与夹具预检。
3. 核对验证期间草稿附件没有变化，保存每个组合的 `verification.json` Actions 产物。报告包含源 SHA、草稿 ID 和附件哈希。

本地可执行：

```powershell
node tools/github-release.mjs verify . $ReleaseTag $SourceSha '<固定宿主源码根>' '<验收记录路径>/verification.json'
```

工作流工具来自启动时的 main 提交，候选源码来自标签；两者不混用。工具或工作流升级后，应在 main 合入，再用同一套工具重新核验草稿。任何附件变化都会使原报告失效。

## 4. 实际安装与发布

从实际附件出发，在独立的固定版本宿主副本、新 `DSH_HOME` 和独立端口，按 README 完成：安装、doctor、预检、应用、重复应用、启动、HTTP 与界面、补丁选择、规则保存与恢复、回退、移除和数据保留。补丁回退后比较原始文件，确认日常宿主未变。

真实浏览器复验中英文、确认与取消、错误反馈、规则恢复及保存结果。单元测试、DOM 文案检查、旧截图或历史安装不替代当前附件的验收。沙箱、模型及其他系统的通过、未验证和缺少触发源分别记录。

发布前确认：

- 源码 Check、四组下载附件核验、当前版本的实际安装与浏览器记录齐全，且没有未处理的发布阻断项。
- 发布说明包含行为变化、安装与升级、固定宿主版本、回退、已知限制和实际验证层次。
- 源 SHA、标签、版本与附件一致；核验报告仍对应当前附件。HTTP 管理接口未接入宿主登录认证，使用范围为受信任的本机环境。

维护者最后发布草稿，0.9 系列保留 Pre-release，关闭 Set as latest。发布后检查公开页面和附件下载。npm 发布、自动部署、自动合并 PR 和自动发布 Release 均不属于此流程。
