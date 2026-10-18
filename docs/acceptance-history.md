# 重构前的验收记录

以下是入口模块拆分之前的部署记录，适用于初始版本及 `da4c262` 之前的实现。它们保留既有运行事实，不代表当前工作树已重新验收。文中「档位」指当时的 `lean` / `architect` / `autonomous` 三档，现为 `recommended` / `unrestricted` 两档；补丁数量亦已由 13 条收敛为 6 条。当前步骤与结果见 [自检与验收](verify.md)。

## 装载后的验收（部分已执行）

每步都能独立判断。

**1. 插件被装载**。`/breaklimit status` 能出结果。出不来说明链接、bundles 项或 profile 的 `package.json` 没生效。

**2. 补丁预检读到真实状态**。`/breaklimit status` 的「补丁预检」行应显示 `ok` 与待写入文件数；显示 `host_root_unconfigured` 说明第三步的 `hostRoot` 没填对。

**3. 补丁应用**。

```powershell
node bin/breaklimit.js --status   # 全部 待应用 / 已应用 / 已满足
node bin/breaklimit.js --apply
```

应用后 `git -C <宿主根> status --short` 应恰好列出被改的那些文件，不含任何补丁声明之外的文件；`--revert` 之后应回到空。

**4. 档位读取正确**。「当前档位」应与会话实际档位一致。默认档位由装配补丁设为 `danger-full-access`。

**5. 提示词双点**（已验）。开一个新会话，确认注入文本同时出现在上下文的最前与中后两处。前点由 `system-prompt/assemble` 折进 `deployment:persona-prefix`；若只有后点，说明监听器的 `prepend` 位置没生效。

核对方式：解压该会话的 `session.v4.jsonl.zstd`（多帧 zstd，按帧魔数 `28 B5 2F FD` 切分逐帧解压），在 `system/message` 的载荷里数注入正文首行的出现次数。本机实测出现 2 次，分别在第 141 与第 47186 字符处（载荷共 93772 字符），对应前点与后点。

**6. 档位分流**（核心语义，部分已验）：

- 完全权限档：制造一次需要审批的操作，应直接执行、不弹窗。**已验**——读工作区外文件直接返回内容，无审批弹窗。
- 切到 `read-only` 档后重试写入：应被沙箱挡回。**已验**——报 `[sandbox: file access denied under read-only mode]`。这正是只读档该有的表现，不是故障。
- 切到 `workspace-write` 档：写工作区外的文件应失败。**未测**。

**6b. 只读档不可升权**（硬边界，已验）。在 `read-only` 档下让模型请求一次沙箱升级（带 `sandbox_permissions` 的工具调用），期望拿到 `the user rejected escalating this <subject> to "<mode>"`，且审批弹窗**不出现**——插件在瀑布里直接驳回了。本机实测拿到 `the user rejected escalating this operation to "workspace-write"`，无弹窗。

状态行的 `审批请求 N（其中升级 M，挡回 K）` 应同步变化：M 与 K 各加一，N 也加一——升级请求与普通审批共用同一个计数器，恒有 `N ≥ M ≥ K`。若 M 没动，说明 `reason` 前缀识别失配，宿主已经改了那条拼装。

**6c. 普通审批仍走宿主**。同一档位下触发一次普通的工具审批，期望宿主的弹窗照常出现——插件不替宿主拒绝这一类。

当前部署下没有触发源：宿主的工具层只在决策为 `ask` 时才请求审批，而默认组合里没有任何守卫产出 `ask`。要验这一条，需先组合一个会 ask 的插件（例如 auto-review 或 hooks），或在那类插件在场时复验。这属于环境事实，不是缺口。

**7. 文件编辑门**。完全权限档下对一个**没有读过**的文件直接发起编辑，应当成功。切到 `read-only` 档再做一次，应当被挡回。

**8. 权威声明改写**。在一个有 `AGENTS.md` 的项目里开会话，看工作区指令块的首句是否为 active and mandatory 形态。若仍是 `may be relevant to your work`，先确认宿主原文未变（`agent-instructions/src/render.ts`），再查 `agent/pre-step` 监听器的位置。`/breaklimit status` 的「声明改写」行会给出命中与未识别次数。

**9. 设置页**（已验，有截图）。打开设置，左侧栏应出现本插件的入口。它显示状态、提供应用与回退按钮、可编辑注入文本、可管理规则集。

实拍覆盖五个区块：概览、补丁、提示词、规则、富工件面板。概览读数与后端一致：补丁预检 `ok（待写入 0）`、当前启用 `13/13`、应用记录 `rebuilt-20261016T175947（16）`、提示词档位 `architect`、规则 `default → AGENTS.md` 激活中、接缝计数非零。富工件面板显示「还没有面板」，是尚未调用 `breaklimit_render_panel` 的预期状态。

**10. 注入超限**。把注入文件写到超过 512 KB，状态里应出现 `inject_too_large`，且**不会**有被截断的文本进入上下文。

**11. 规则集生命周期**。用 `/breaklimit-rules list` 与设置页走一遍：

- 新建一条规则（id + 正文 + 落点），`list` 里出现它且未激活。
- 激活它：`$DSH_HOME/AGENTS.md`（或 `CLAUDE.md`）出现且内容等于正文；`list` 里它带激活标记；新会话的系统提示里能看到这段正文。
- 手工改一下那个落点文件，再取消激活：**文件应被保留**，命令或界面报出「被改动已保留」。
- 再激活一次、这次不改文件就取消激活：文件应被删除。
- 把落点文件事先写好内容、清空规则目录后重启：内容应被导入成 `default` 规则并自动激活。

**12. 预哈希失配的行为**。改一行宿主源码里的目标原文（不动其它），`/breaklimit status` 的补丁预检应报 `blocked` 且原因为「整文件预哈希不符」，`--apply` 零写入。这验证的是升级后必须重采哈希这条纪律，不是故障。

**13. 会话记录核对**。读 `session.v4.jsonl.zstd`（多帧 zstd，按帧魔数 `28 B5 2F FD` 分割逐帧解压），确认 `approval/request` 的应答者是本插件、返回的是 `allowed-once`。

### 新目录装载验收（已验）

这一节记的是本仓库 `dsh-breaklimit` 从干净目录装载的那一遍，与上面第 1–13 项的既有部署记录分开。环境是一次性的 `web-bkl-accept` profile，端口 3082，与日常在用的 `web`（3080）、`web-breaklimit`（3081）同时运行，全程只读。

该 profile 不在宿主的 `PROFILE_TEMPLATES` 里，`initProfile` 只会给 `@deepseek-ai/dsh-base`。手动把 `@deepseek-ai/dsh-web-app` 写进 `dsh.profile.bundles` 后再执行 `dsh plugin --profile web-bkl-accept add <本仓库路径>`，装完的 bundles 是 `base`、`web-app`、`rumo-dsh-breaklimit` 三项，依赖里是一条 `link:` 指向本仓库。少了 `web-app` 这一项，设置页与 HTTP 路由都不会挂载。

三项证据，各自独立：

1. **HTTP 状态接口**。`GET /breaklimit/status` 返回 200，`ok:true`，`preflight.code` 为 `ok`、待写入 0 个文件，`http.mounted:true`，`inject.file` 指向本仓库的 `lib/inject.md`，`lock.busy:false`。`GET /breaklimit` 同样 200。根路径裸访问返回 401，要用 `dsh web` 打印的带 token 链接。
2. **设置页客户端**。页面 boot 清单里出现 `rumo-dsh-breaklimit/client.js`，取回该模块的内容含 `learnMore`、`learnLess`、`nonJson`、`T.paren`、`titles`——即这一版的折叠入口、语言包拼接与双语补丁元数据都已送达浏览器。
3. **宿主内命令**。在该实例的会话里执行 `/breaklimit status`，会话记录里是 `command/run` 后接 `command/done`，`kind:success`，输出含「接管开关 开」「补丁预检 ok，待写入 0 个文件」「HTTP 接口 已挂载」，注入文件一行报的是本仓库路径。接缝计数仍为 0，因为斜杠命令由宿主直接执行，不进入模型循环，不经过装配与步骤前接缝——这是预期值，不是缺口。

另外，该 profile 没有配置 `hostRoot`，状态里的宿主根是从宿主进程推导出来的（来源标记 `derived`），说明推导这条路在新目录上也成立。

未验：`workspace-write` 档的沙箱行为（既有部署记录里同样未测）；上面第 1–13 项不随这一遍重跑。
