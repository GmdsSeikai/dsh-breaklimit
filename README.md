# dsh-breaklimit

为 DeepSeek Harness 管理宿主补丁、提示词和规则集的插件，提供中英文 Web 设置页。

- **补丁可控**：逐条选择，应用前检查文件哈希与命中数，失败时尝试事务回滚。
- **提示词可编辑**：提供 `recommended`（推荐）与 `unrestricted`（完全解放）两档，支持自定义正文。
- **规则可切换**：管理多份规则，激活到 `AGENTS.md` 或 `CLAUDE.md`，撤销时检查外部改动。
- **状态可检查**：Web、宿主命令、模型工具和独立 CLI 共用补丁选择与预检服务。

## 适用环境

| 项目 | 要求 |
| --- | --- |
| 宿主 | 已能运行的 DeepSeek Harness **源码版** `0.2.1-rc.2` |
| 宿主提交 | `687f282e8625c6b8d11ff58211a90524be2e4317` |
| Node.js | 与宿主一致：`^22.19.0 || >=24.0.0`，推荐 Node 24 |
| 工具 | Git、pnpm；pnpm 必须能从 PATH 调用 |
| 使用入口 | 本机 Web；桌面发行版和其他宿主版本尚未验收 |

**应用补丁会修改宿主源码树，需要重启宿主。** 独立 profile 隔离配置；使用同一源码树的其他 profile 也会读到源码补丁。版本或哈希不符时应先排查，不要直接重采哈希绕过阻断。

## 快速安装（Windows PowerShell）

面向已经能启动源码版 DSH 的用户。其他安装细节见 [安装说明](docs/install.md)。以下命令在**同一个 PowerShell 窗口**执行。

### 1. 获取插件并填写宿主路径

在你存放项目的目录执行：

```powershell
git clone https://github.com/rumoii/dsh-breaklimit.git
$PluginRoot = (Resolve-Path .\dsh-breaklimit).Path
$DshRoot = 'D:\host\deepseek-harness' # 改成你的宿主源码目录
$env:DSH_BREAKLIMIT_HOST_ROOT = $DshRoot

node --version
pnpm --version
git -C "$DshRoot" rev-parse HEAD
```

最后一条应输出上表中的宿主提交。宿主目录中应有 `apps/cli/src/bin.ts`；不同则先停止，确认安装形态与版本。

### 2. 准备独立的 Web profile

沿用启动 DSH 时使用的 `DSH_HOME`；未设置时，以下命令使用用户目录下的 `.dsh`。只在 profile 不存在时创建 Web 模板，已有 profile 不会被覆盖：

```powershell
if (-not $env:DSH_HOME) { $env:DSH_HOME = Join-Path $env:USERPROFILE '.dsh' }
$ProfileManifest = Join-Path $env:DSH_HOME 'profiles\web-breaklimit\package.json'
Set-Location "$DshRoot"
if (-not (Test-Path -LiteralPath $ProfileManifest)) {
    node --import tsx/esm apps/cli/src/bin.ts --profile web-breaklimit --from-default-profile web --dump-default-config
    if ($LASTEXITCODE -ne 0) { throw '创建 Web profile 失败，请停止安装并检查输出。' }
}
```

已有 profile 的 `dsh.profile.bundles` 必须包含 `@deepseek-ai/dsh-web-app`。设置页缺失时先看 [对应排查步骤](docs/install.md#常见问题)。

### 3. 安装、预检与应用

仍在宿主目录安装，再进入插件目录操作补丁：

```powershell
node --import tsx/esm apps/cli/src/bin.ts plugin --profile web-breaklimit add "$PluginRoot"
if ($LASTEXITCODE -ne 0) { throw '插件安装失败，请停止并检查输出。' }

Set-Location "$PluginRoot"
node src/cli.js --host-root "$DshRoot" --status
```

预检显示“通过”且没有阻断项后，执行：

```powershell
node src/cli.js --host-root "$DshRoot" --apply
```

预检失败时整批不写入。应用失败时保留报错及 `$DSH_HOME/breaklimit/`，按 [故障恢复](docs/install.md#回退与卸载) 处理。

### 4. 启动并确认

如果这个 profile 正在运行，先按原来的方式将它停止。随后在同一个窗口启动：

```powershell
Set-Location "$DshRoot"
node --import tsx/esm apps/cli/src/bin.ts --profile web-breaklimit --port 3082
```

打开终端打印的登录链接，在会话中输入 `/breaklimit status`。确认：

- 设置页有“破限”入口，英文界面显示对应英文名称。
- 宿主根是你填写的目录，补丁预检为 `ok`。
- `HTTP 接口` 显示“已挂载”。

“待写入 0 个文件”只说明当前补丁目标已满足；它本身不能证明宿主已经重启。

## 第一次使用

1. 在“补丁”中查看每条改动。开关只影响后续预检与应用，不撤销已应用的文件改动。
2. 在“提示词与规则”中选择模式或编辑正文。`recommended` 为默认，保存后写入 `$DSH_HOME/breaklimit-inject.md`。
3. 在同一页下方填写规则 ID、写入文件和正文，保存后再激活。撤销时恢复原文件或删除插件创建的文件；外部修改会被保留并报告。
4. 用 `/breaklimit off` 暂停本次实例的运行时接管；恢复用 `/breaklimit on`。这两个命令不撤销源码补丁。

提示词模式控制文本装配，宿主的沙箱模式控制实际执行边界，两者不是同一个开关。

## 界面预览

| 概览与安装检查 | 补丁选择与技术细节 |
| --- | --- |
| ![概览](docs/images/overview.png) | ![补丁](docs/images/patches.png) |

[查看英文补丁页](docs/images/patches-en.png)。截图取自 Windows 上真实运行的宿主（DSH 0.2.1-rc.2 · 687f282e，补丁已全部应用），读数由插件后端实时读取；它们只说明界面与状态显示的样子，不代表模型推理或全部沙箱场景已通过验收。

## 回退与卸载

在插件目录撤销宿主源码补丁：

```powershell
node src/cli.js --host-root "$DshRoot" --revert
```

成功后重启宿主。需要移除插件时，再从宿主目录执行：

```powershell
node --import tsx/esm apps/cli/src/bin.ts plugin --profile web-breaklimit remove rumo-dsh-breaklimit
```

不要提前删除插件目录或恢复快照。移除依赖不会自动撤销源码补丁，也不会清除用户规则和注入文件。规则写入文件的恢复方式见 [回退与卸载](docs/install.md#回退与卸载)。

## 文档与开发

- [安装、升级、回退与常见问题](docs/install.md)
- [命令与 HTTP 接口](docs/reference.md)
- [模块结构与设计约束](DESIGN.md)
- [自检与验收](docs/verify.md)
- [贡献指南](CONTRIBUTING.md) · [变更记录](CHANGELOG.md) · [发布检查清单](docs/releasing.md)

```powershell
npm run check
npm run reconcile -- '<宿主源码树绝对路径>'
npm run check:host -- '<宿主源码树绝对路径>'
```

最后两条读取宿主 HEAD；夹具预检不修改宿主工作树，也不能替代实际安装和浏览器验收。

仓库名是 `dsh-breaklimit`，包名和插件标识是 `rumo-dsh-breaklimit`。安装使用目录路径，卸载使用包名。

## 许可证

[MIT](LICENSE)
