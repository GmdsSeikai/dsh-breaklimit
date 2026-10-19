// rumo-dsh-breaklimit 浏览器半：宿主设置页里的一个分区。
//
// 宿主用 window.__ModuleLoader__.load 直接加载这个文件，不经过打包，所以它只依赖
// react，元素全部用 createElement 手写。
//
// 设计约束：
//   1. 颜色、圆角、字体只取宿主令牌（--dsw-*），浅色深色跟着宿主切换。
//   2. 每屏一个主操作；会改磁盘的动作先写清后果与规模，再就地确认。
//   3. 结论只来自后端（预检、应用记录、规则索引）；前端只把它翻译成一句话和下一步。
//   4. 后端的 message 是写给终端的中文，这里一律不展示，按 code 与 data 自己出文案。
//
// 文案守卫 tools/check-client.mjs 从英文包起点一直扫到文件末尾，所以 TEXT 之后的
// 代码里不能出现中文字面量；中文只放在注释和 zh 包里。
//
// 测试桩只提供 useState / useEffect / useCallback / useRef，并把 Section 当普通函数
// 调用、不展开子组件，所以 tablist 必须直接写在 Section 的返回树里。
window.__ModuleLoader__.load({ id: "rumo-dsh-breaklimit", factory: (require) => {
  var module = { exports: {} }
  var exports = module.exports
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })

  const react = require("react")
  const h = react.createElement
  const { useState, useEffect, useCallback, useRef } = react

  const name = "rumo-dsh-breaklimit"
  const inject = ["slots"]
  const SECTION_ID = "breaklimit"
  const SECTION_ORDER = 45
  const API = "/breaklimit"
  const REQUEST_TIMEOUT_MS = 20000
  const NOTICE_OK_MS = 5000
  const CLOCK_MS = 30000
  const STYLE_ID = "bkl-scoped-style"
  const TAB_KEYS = ["overview", "patches", "context"]
  const MODES = ["recommended", "unrestricted"]
  const RULE_TARGETS = ["AGENTS.md", "CLAUDE.md"]
  const RULE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
  const LIST_LIMIT = 5
  // 浮窗与设置页是两个挂载点、两份 state。浮窗改了档位，设置页那份就旧了；
  // 用一个自定义事件把「后端状态变了」传过去，不把 load 从设置页里导出来。
  const STATE_CHANGED_EVENT = "bkl:state-changed"

  // ---- 宿主令牌 ------------------------------------------------------------
  //
  // 只引用宿主已有的令牌。--dsw-font-* 是 font 简写（如 13px/20px family），必须
  // 写在 font 上而不是 fontSize。主按钮那对填充色/前景色与宿主 ui-primitives 的
  // Button 一致；错误色没有 tertiary，柔和底色用 color-mix 从主色混出来。
  const tk = {
    label: "var(--dsw-alias-label-primary)",
    label2: "var(--dsw-alias-label-secondary)",
    label3: "var(--dsw-alias-label-tertiary)",
    caption: "var(--dsw-alias-label-caption)",
    line1: "var(--dsw-alias-border-l1)",
    line2: "var(--dsw-alias-border-l2)",
    line3: "var(--dsw-alias-border-l3)",
    line4: "var(--dsw-alias-border-l4)",
    bg: "var(--dsw-alias-bg-base)",
    layer1: "var(--dsw-alias-bg-layer-1)",
    layer2: "var(--dsw-alias-bg-layer-2)",
    layer3: "var(--dsw-alias-bg-layer-3)",
    // 浅色主题下 layer-1/2/3 都是纯白，嵌在卡片里的凹槽用主文字色混一层薄底，深浅色都能分出层次。
    well: "color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent)",
    accent: "var(--dsw-alias-state-business-primary)",
    accentSoft: "var(--dsw-alias-state-business-tertiary)",
    ok: "var(--dsw-alias-state-success-primary)",
    okSoft: "var(--dsw-alias-state-success-tertiary)",
    warn: "var(--dsw-alias-state-warn-primary)",
    warnSoft: "var(--dsw-alias-state-warn-tertiary)",
    error: "var(--dsw-alias-state-error-primary)",
    errorSoft: "color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent)",
    fill: "var(--dsw-alias-button-primary-fill, var(--dsw-alias-state-business-primary))",
    onFill: "var(--dsw-alias-label-primary-foreground)",
    rXs: "var(--dsw-radius-xs)",
    rSm: "var(--dsw-radius-sm)",
    rMd: "var(--dsw-radius-md)",
    rLg: "var(--dsw-radius-lg)",
    rXl: "var(--dsw-radius-xl)",
    fontTitle: "var(--dsw-font-base-16)",
    font: "var(--dsw-font-xs-13)",
    fontStrong: "var(--dsw-font-xs-strong-13)",
    fontSmall: "var(--dsw-font-xxs-12)",
    fontSmallStrong: "var(--dsw-font-xxs-strong-12)",
    mono: "var(--dsw-font-mono, var(--ds-font-family-code, ui-monospace, Consolas, monospace))",
  }

  const TONE_COLOR = { ok: tk.ok, warn: tk.warn, error: tk.error, info: tk.accent, accent: tk.accent, idle: tk.line4 }
  const TONE_SOFT = { ok: tk.okSoft, warn: tk.warnSoft, error: tk.errorSoft, info: tk.accentSoft, accent: tk.accentSoft, idle: tk.well }
  const DISK_TONE = { pending: "accent", ready: "ok", blocked: "error", skipped: "idle", unknown: "idle" }
  const STEP_TONE = { done: "ok", todo: "accent", warn: "warn", error: "error" }

  const S = {
    root: { display: "flex", flexDirection: "column", gap: "16px", font: tk.font, color: tk.label, minWidth: 0 },
    header: { display: "flex", alignItems: "flex-start", gap: "12px" },
    headText: { display: "flex", flexDirection: "column", gap: "4px", flex: "1 1 auto", minWidth: 0 },
    title: { margin: 0, font: tk.fontTitle, fontWeight: 600, color: tk.label },
    lead: { margin: 0, font: tk.fontSmall, color: tk.label3 },
    headAside: { display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 },
    stamp: { font: tk.fontSmall, color: tk.caption, whiteSpace: "nowrap" },

    tablist: { display: "flex", flexWrap: "wrap", columnGap: "24px", borderBottom: `0.5px solid ${tk.line2}` },
    tab: {
      appearance: "none", background: "transparent", border: "none", borderBottom: "2px solid transparent",
      margin: 0, padding: "8px 0 7px", cursor: "pointer", font: tk.font, color: tk.label3,
      display: "inline-flex", alignItems: "center", gap: "6px", whiteSpace: "nowrap",
    },
    tabOn: { font: tk.fontStrong, color: tk.label, borderBottom: `2px solid ${tk.accent}` },
    panel: { display: "flex", flexDirection: "column", gap: "16px", minWidth: 0 },

    card: {
      display: "flex", flexDirection: "column", gap: "12px", padding: "16px",
      background: tk.layer1, border: `0.5px solid ${tk.line2}`, borderRadius: tk.rMd, minWidth: 0,
    },
    cardHead: { display: "flex", alignItems: "flex-start", gap: "12px" },
    cardHeadText: { display: "flex", flexDirection: "column", gap: "2px", flex: "1 1 auto", minWidth: 0 },
    cardTitle: { margin: 0, font: tk.fontStrong, color: tk.label },
    eyebrow: { display: "inline-flex", alignItems: "center", gap: "6px", font: tk.fontSmallStrong, color: tk.label3 },
    bigTitle: { margin: 0, font: tk.fontStrong, fontWeight: 600, color: tk.label },

    text: { margin: 0, color: tk.label2 },
    small: { margin: 0, font: tk.fontSmall, color: tk.label3 },
    caption: { font: tk.fontSmall, color: tk.caption },
    strong: { font: tk.fontStrong, color: tk.label },
    row: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
    spacer: { flex: "1 1 auto" },

    btn: {
      appearance: "none", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "6px",
      minHeight: "30px", padding: "5px 12px", margin: 0, borderRadius: tk.rSm,
      border: `0.5px solid ${tk.line3}`, background: tk.layer1, color: tk.label,
      font: tk.fontStrong, cursor: "pointer", whiteSpace: "nowrap", textDecoration: "none",
    },
    btnPrimary: { background: tk.fill, border: "0.5px solid transparent", color: tk.onFill },
    btnDanger: { background: tk.error, border: "0.5px solid transparent", color: tk.onFill },
    btnQuiet: { background: "transparent", border: "0.5px solid transparent", color: tk.label2, padding: "5px 8px" },
    btnQuietDanger: { background: "transparent", border: "0.5px solid transparent", color: tk.error, padding: "5px 8px" },
    btnSmall: { minHeight: "26px", padding: "3px 10px", font: tk.fontSmallStrong },
    btnOff: { opacity: 0.45, cursor: "not-allowed" },

    tag: {
      display: "inline-flex", alignItems: "center", gap: "4px", minHeight: "18px", padding: "0 6px",
      borderRadius: tk.rXs, border: `0.5px solid ${tk.line2}`, font: tk.fontSmall, color: tk.label3, whiteSpace: "nowrap",
    },
    dot: { display: "inline-block", width: "6px", height: "6px", borderRadius: tk.rXs, flexShrink: 0 },

    switchTrack: {
      appearance: "none", position: "relative", display: "inline-block", width: "32px", height: "18px",
      padding: 0, margin: 0, border: "none", borderRadius: tk.rXl, background: tk.line4, cursor: "pointer", flexShrink: 0,
    },
    switchOn: { background: tk.fill },
    switchKnob: {
      position: "absolute", top: "2px", left: "2px", width: "14px", height: "14px",
      borderRadius: tk.rXl, background: "#fff", transform: "translateX(0)",
    },
    // 打开态的轨道是主按钮填充色（深色主题下接近白色），滑块跟主按钮文字取同一个前景色。
    switchKnobOn: { transform: "translateX(14px)", background: tk.onFill },

    banner: { display: "flex", flexDirection: "column", gap: "8px", padding: "12px 14px", borderRadius: tk.rMd, border: `0.5px solid ${tk.line2}` },
    bannerHead: { display: "flex", alignItems: "center", gap: "8px" },
    bannerTitle: { margin: 0, font: tk.fontStrong, color: tk.label, flex: "1 1 auto", minWidth: 0 },

    confirm: {
      display: "flex", flexDirection: "column", gap: "8px", padding: "12px 14px",
      borderRadius: tk.rSm, background: tk.well, border: `0.5px solid ${tk.line3}`,
    },
    confirmTitle: { margin: 0, font: tk.fontStrong, color: tk.label },

    list: { margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: "8px" },
    pathList: { margin: 0, padding: "6px 10px", listStyle: "none", display: "flex", flexDirection: "column", gap: "2px", borderRadius: tk.rSm, background: tk.well },
    pathItem: { font: tk.fontSmall, fontFamily: tk.mono, color: tk.label2, wordBreak: "break-all" },
    pathMore: { font: tk.fontSmall, color: tk.label3 },
    codeBlock: {
      margin: 0, padding: "8px 10px", borderRadius: tk.rSm, background: tk.well, border: `0.5px solid ${tk.line1}`,
      font: tk.fontSmall, fontFamily: tk.mono, color: tk.label2, whiteSpace: "pre-wrap", wordBreak: "break-all",
      maxHeight: "180px", overflow: "auto",
    },
    mono: { fontFamily: tk.mono, wordBreak: "break-all" },
    code: { font: tk.fontSmall, fontFamily: tk.mono, color: tk.caption },

    rows: { margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column" },
    rowItem: { display: "grid", gridTemplateColumns: "minmax(84px, 120px) minmax(0, 1fr) auto", alignItems: "start", columnGap: "12px", padding: "10px 0", borderTop: `0.5px solid ${tk.line1}` },
    rowFirst: { borderTop: "none", padding: "0 0 10px" },
    rowKey: { color: tk.label3, paddingTop: "1px" },
    rowVal: { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 },
    rowValue: { display: "inline-flex", alignItems: "center", gap: "6px", color: tk.label, wordBreak: "break-word" },

    steps: { margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: "2px" },
    step: {
      appearance: "none", display: "flex", alignItems: "flex-start", gap: "12px", width: "100%", margin: 0,
      padding: "8px 10px", border: "none", borderRadius: tk.rSm, background: "transparent", color: tk.label,
      font: tk.font, textAlign: "left", cursor: "pointer",
    },
    stepMark: {
      display: "inline-flex", alignItems: "center", justifyContent: "center", width: "20px", height: "20px",
      borderRadius: tk.rXl, border: "1px solid", font: tk.fontSmallStrong, flexShrink: 0,
    },
    stepBody: { display: "flex", flexDirection: "column", gap: "2px", flex: "1 1 auto", minWidth: 0 },
    stepTitleRow: { display: "flex", alignItems: "baseline", gap: "8px", flexWrap: "wrap" },
    stepChevron: { color: tk.caption, paddingTop: "1px" },

    legend: { margin: 0, padding: "10px 12px", listStyle: "none", display: "flex", flexDirection: "column", gap: "4px", borderRadius: tk.rSm, background: tk.well },
    legendItem: { margin: 0, font: tk.fontSmall, color: tk.label2 },
    legendKey: { font: tk.fontSmallStrong, color: tk.label, marginRight: "4px" },

    patch: { display: "flex", flexDirection: "column", gap: "8px", padding: "14px 16px", background: tk.layer1, border: `0.5px solid ${tk.line2}`, borderRadius: tk.rMd },
    patchHead: { display: "flex", alignItems: "flex-start", gap: "16px" },
    patchMain: { display: "flex", flexDirection: "column", gap: "4px", flex: "1 1 auto", minWidth: 0 },
    patchTitle: { font: tk.fontStrong, color: tk.label },
    patchSwitch: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "4px", flexShrink: 0, paddingTop: "1px" },
    switchHint: { font: tk.fontSmall, color: tk.label3, whiteSpace: "nowrap" },
    patchMeta: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", font: tk.fontSmall, color: tk.label3 },
    metaItem: { display: "inline-flex", alignItems: "center", gap: "6px" },
    inlineNote: { margin: 0, padding: "6px 10px", borderRadius: tk.rSm, background: tk.warnSoft, font: tk.fontSmall, color: tk.label2 },
    detail: { display: "flex", flexDirection: "column", gap: "10px", paddingTop: "10px", borderTop: `0.5px solid ${tk.line1}` },
    detailBlock: { display: "flex", flexDirection: "column", gap: "4px" },
    targetPath: { font: tk.fontSmallStrong, fontFamily: tk.mono, color: tk.label, wordBreak: "break-all" },

    actionBar: {
      position: "sticky", bottom: 0, zIndex: 1, display: "flex", flexDirection: "column", gap: "8px",
      padding: "12px 0 4px", background: tk.bg, borderTop: `0.5px solid ${tk.line2}`,
    },

    radioGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "8px" },
    radioCard: {
      appearance: "none", display: "flex", flexDirection: "column", gap: "6px", margin: 0, padding: "12px 14px",
      borderRadius: tk.rSm, border: `0.5px solid ${tk.line3}`, background: tk.layer1, color: tk.label,
      font: tk.font, textAlign: "left", cursor: "pointer", minWidth: 0,
    },
    radioCardOn: { border: `1px solid ${tk.accent}`, padding: "11.5px 13.5px", background: tk.accentSoft },
    radioHead: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
    radioMark: { display: "inline-flex", alignItems: "center", justifyContent: "center", width: "14px", height: "14px", borderRadius: tk.rXl, border: `1px solid ${tk.line4}`, flexShrink: 0 },
    radioMarkOn: { border: `1px solid ${tk.accent}` },
    radioMarkDot: { width: "6px", height: "6px", borderRadius: tk.rXl, background: tk.accent },
    segment: { display: "flex", flexDirection: "column", gap: "6px" },

    field: { display: "flex", flexDirection: "column", gap: "4px", minWidth: 0 },
    fieldLabel: { font: tk.fontSmallStrong, color: tk.label2 },
    input: {
      width: "100%", boxSizing: "border-box", margin: 0, padding: "6px 10px", borderRadius: tk.rSm,
      border: `0.5px solid ${tk.line3}`, background: tk.bg, color: tk.label, font: tk.font, outlineOffset: "1px",
    },
    inputLocked: { background: tk.well, color: tk.label3 },
    textarea: { minHeight: "180px", resize: "vertical" },
    fieldError: { margin: 0, font: tk.fontSmall, color: tk.error },
    fieldWarn: { margin: 0, font: tk.fontSmall, color: tk.label2 },
    editor: { display: "flex", flexDirection: "column", gap: "12px", padding: "14px", borderRadius: tk.rSm, background: tk.well, border: `0.5px solid ${tk.line2}` },
    fieldGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "12px" },

    ruleRow: { display: "flex", alignItems: "center", gap: "12px", padding: "10px 0", borderTop: `0.5px solid ${tk.line1}`, flexWrap: "wrap" },
    ruleRowFirst: { borderTop: "none", padding: "0 0 10px" },
    ruleMain: { display: "flex", flexDirection: "column", gap: "2px", flex: "1 1 200px", minWidth: 0 },
    ruleActions: { display: "flex", alignItems: "center", gap: "4px", flexShrink: 0 },

    empty: { display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "8px", padding: "16px", borderRadius: tk.rSm, border: `0.5px dashed ${tk.line3}` },
    ol: { margin: 0, paddingLeft: "18px", display: "flex", flexDirection: "column", gap: "4px", color: tk.label2 },
  }

  // 只放伪类与动效：内联样式做不到 :hover / :focus-visible / 减弱动态。背景类
  // 规则带 !important，是因为内联样式的优先级高于样式表。焦点环沿用宿主
  // ui-theme/focus.css 的写法，指针操作时宿主会把 --dsw-focus-ring-color 置成透明。
  const SCOPED_CSS = [
    ".bkl-root :focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }",
    ".bkl-root .bkl-btn, .bkl-root .bkl-tab, .bkl-root .bkl-hover, .bkl-root .bkl-radio, .bkl-root .bkl-switch { transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease, opacity 120ms ease; }",
    ".bkl-root .bkl-btn-plain:not([aria-disabled=\"true\"]):hover, .bkl-root .bkl-hover:hover { background-color: var(--dsw-alias-interactive-bg-hover) !important; }",
    ".bkl-root .bkl-btn-fill:not([aria-disabled=\"true\"]):hover { opacity: 0.88; }",
    ".bkl-root .bkl-tab:hover { color: var(--dsw-alias-label-primary) !important; }",
    ".bkl-root .bkl-radio:not([aria-checked=\"true\"]):hover { border-color: var(--dsw-alias-border-l4) !important; }",
    ".bkl-root .bkl-knob { transition: transform 120ms ease; }",
    ".bkl-root .bkl-input:focus { border-color: var(--dsw-alias-border-l4) !important; }",
    ".bkl-root .bkl-input::placeholder { color: var(--dsw-alias-label-caption); }",
    ".bkl-root .bkl-fade { animation: bkl-fade 160ms ease-out; }",
    "@keyframes bkl-fade { from { opacity: 0; transform: translateY(-2px); } to { opacity: 1; transform: none; } }",
    "@media (prefers-reduced-motion: reduce) { .bkl-root *, .bkl-root *::before, .bkl-root *::after { animation: none !important; transition: none !important; } }",
  ].join("\n")

  const TEXT = {
    zh: {
      nav: "破限",
      title: "破限",
      lead: "调宽宿主过紧的限制、切换提示词档位、管理写给模型的长期规则。",
      tabsLabel: "破限设置",
      tabOverview: "概览",
      tabPatches: "补丁",
      tabContext: "提示词与规则",
      refresh: "刷新",
      refreshedAt: (s) => `更新于${String(s)}`,
      agoJust: "刚刚",
      agoMin: (n) => `${String(n)} 分钟前`,
      agoHour: (n) => `${String(n)} 小时前`,
      loading: "正在读取插件状态…",
      loadingHint: "通常一两秒。如果一直停在这里，点右上角的「刷新」。",
      retry: "重试",
      recheck: "重新检查",
      dismiss: "关闭这条提示",
      dismissShort: "关闭",
      cancel: "取消",
      working: "处理中…",
      saving: "正在保存…",
      copied: "已复制到剪贴板",
      copyFailed: "没能复制",
      copyFailedNext: "浏览器不允许访问剪贴板，请手动选中上面的文字复制。",
      copyCommand: "复制这行命令",
      errorCode: (c) => `错误代码 ${String(c)}`,
      andMore: (n) => `以及另外 ${String(n)} 个`,
      unknown: "未知",
      sep: "：",
      bytes: (n) => `${String(n)} 字节`,
      timeUnknown: "时间未知",

      goOverview: "回到概览",
      goPatches: "打开补丁页",
      goPatchesSee: "去补丁页看是哪几处",
      goPatchesPick: "去挑选补丁",
      goPatchesApply: "去补丁页应用",
      goContext: "调整提示词与规则",

      nextStep: "下一步",
      nsRulesCorruptTitle: "规则清单读不出来",
      nsRulesCorruptBody: (path) => `规则清单文件（$DSH_HOME/${String(path)}）无法读取或版本不符，插件已停止写入以保护原数据。已有的正文文件完好保留在 $DSH_HOME/breaklimit/bodies/ 目录中。你可以备份原清单并重置为空清单重新开始。`,
      recoverRules: "备份并重置清单",
      confirmRecoverRulesTitle: "确认备份并重置规则清单？",
      confirmRecoverRulesBody: "会将当前的损坏清单复制备份到 dsh-breaklimit-backup 目录下，并初始化一份空的规则清单。之前的正文文件仍在 bodies/ 中，重新创建同名规则会覆盖它们。",
      confirmRecoverRulesYes: "备份并重置",
      doneRecoverRules: "规则清单已重置",
      doneRecoverRulesNext: (path) => `原损坏清单已备份至 $DSH_HOME/${String(path)}。正文文件仍在 $DSH_HOME/breaklimit/bodies/ 目录下。`,
      nsBrokenTitle: "上次的应用记录读不出来",
      nsBrokenBody: "为了不把宿主改乱，插件暂停了应用和回退。不要反复点按钮；按安装说明里「回退与卸载」一节处理 DSH 数据目录下的 breaklimit 文件夹，再回来点「重新检查」。",
      nsRootTitle: "先告诉插件宿主源码在哪",
      nsRootBody: "插件要改的是 DeepSeek Harness 源码里的几个文件，但现在不知道它放在哪。在启动宿主的 PowerShell 窗口里先运行下面这行（换成你自己的目录），再重启宿主。",
      nsRootSnippet: "$env:DSH_BREAKLIMIT_HOST_ROOT = 'D:\\你的目录\\deepseek-harness'",
      nsLockTitle: "另一个操作正在进行",
      nsLockBody: "可能是别的窗口或命令行正在应用、回退补丁。等它结束后点「重新检查」。",
      nsBlockedTitle: (n) => `宿主里有 ${String(n)} 处和补丁预期对不上`,
      nsBlockedBody: "这种情况下插件一个文件都不会写，宿主是安全的。最常见的原因是宿主版本不对，或源码被手动改过。",
      nsNoneTitle: "所有补丁都关着",
      nsNoneBody: "现在应用不会写任何东西。去补丁页打开你需要的几条；以前写入过的内容不会因此撤掉，要撤掉请用「回退」。",
      nsPendingTitle: (n) => `还有 ${String(n)} 个文件等着写入`,
      nsPendingBody: "你选好的补丁还没写进宿主。去补丁页确认一遍，再点「应用」。",
      nsDoneTitle: "补丁已就位",
      nsDoneBody: "宿主文件已经是补丁后的样子。如果是刚刚才应用的，记得确认宿主已经重启过。",

      stepsTitle: "三步走完",
      stepsDesc: "按顺序来，点任意一步可以直接跳过去。",
      step1Title: "选提示词模式",
      step1Desc: "决定模型拿到哪一档附加指令，随时可换。",
      step2Title: "挑补丁",
      step2Desc: "打开想要的改动。拨开关不会改任何文件。",
      step3Title: "应用并重启宿主",
      step3Desc: "写进宿主源码之后，要重启宿主才生效。",
      stepState: (s) => (s === "done" ? "已完成" : s === "error" ? "有问题" : s === "warn" ? "差一步" : "未完成"),
      pickedOf: (a, b) => `已开 ${String(a)} / 共 ${String(b)} 条`,
      blockedN: (n) => `${String(n)} 处对不上`,
      pendingN: (n) => `待写入 ${String(n)} 个文件`,
      stepBroken: "应用记录损坏",
      stepNoRoot: "未配置宿主目录",
      stepWaitRestart: "已写入，等你重启",
      stepInPlace: "已就位",

      statusTitle: "现在的状态",
      statusDesc: "都是后端此刻读到的真实值。",
      rowHost: "目标宿主",
      rootSource: (s) => (s === "config" ? "来自插件配置" : s === "env" ? "来自环境变量" : s === "derived" ? "由宿主进程推导" : "未配置"),
      rootMissingShort: "还不知道宿主源码在哪",
      rowMode: "提示词模式",
      rowModeHint: "只影响模型拿到的指令与自我约束，不改变宿主执行权限。",
      rowSandbox: "沙箱档位",
      sandboxTakeover: "完全权限（默认）：宿主已自动放行日常命令审批，工具与编辑受插件规则管控。",
      sandboxHost: "这一档下插件不放宽沙箱，审批交还宿主。",
      rowPreflight: "补丁预检",
      preOk: (n) => (Number(n) === 0 ? "通过，没有待写入的文件" : `通过，待写入 ${String(n)} 个文件`),
      preBlocked: (n) => `未通过：${String(n)} 处对不上`,
      preNoRoot: "无法检查：不知道宿主在哪",
      preBroken: "无法检查：应用记录损坏",
      preHint: "预检只读不写，每次刷新都会重做。",
      rowApplied: "应用记录",
      appliedValue: (n, t) => `${String(n)} 个文件 · ${String(t)}`,
      appliedNone: "还没有应用过",
      opId: (id) => `操作编号 ${String(id)}`,
      rowRules: "规则",
      rulesNone: "还没有规则",
      rulesActive: (n, label) => `${String(n)} 条，激活中：${String(label)}`,
      rulesInactive: (n) => `${String(n)} 条，都没有激活`,
      rowPrompt: "共用正文",
      promptMine: (s) => `你的版本 · ${String(s)}`,
      promptBuiltin: "内置正文",
      rowTakeover: "运行时接管",
      takeoverHint: "立即生效，只管这一次运行；重启宿主后回到配置里的值。它不会撤掉已写入的补丁。",
      takeoverLabel: "运行时接管开关",
      takeoverState: (on) => (on ? "开" : "关"),
      doneTakeover: (on) => (on ? "运行时接管已打开" : "运行时接管已关闭"),
      warnTitle: "宿主的审批设置会绕过插件",
      warnPresetNever: (p) => `「${String(p)}」档的审批策略是 never：宿主直接拒绝，插件收不到询问。`,
      warnPolicyNever: "审批默认策略是 never：新会话的审批不会到达插件。",
      warnOther: (c) => `宿主报告了一条权限提示（${String(c)}）。`,
      warnNext: "如果希望插件来处理审批，请在宿主的权限设置里改成 ask。",

      patchesTitle: "补丁",
      patchesLead: "每条补丁只改宿主源码里一处确定的地方。先挑，再一次性应用。",
      legendSwitch: "开关",
      legendSwitchDesc: "下次点「应用」时带不带这一条。拨动它不会改任何文件。",
      legendDisk: "磁盘状态",
      legendDiskDesc: "宿主源码此刻的样子：待写入、已就位，或对不上。",
      patchesSummary: (a, b, n) => `已选 ${String(a)} / ${String(b)} 条 · 全部补丁共涉及 ${String(n)} 个文件`,
      patchesEmptyTitle: "读不到补丁清单",
      kindReplace: "改写",
      kindVerify: "只检查",
      switchOnHint: "下次应用会带上",
      switchOffHint: "下次应用会跳过",
      diskState: (s) => (s === "pending" ? "待写入" : s === "ready" ? "已就位" : s === "blocked" ? "对不上" : s === "skipped" ? "本次不参与" : "暂时无法判断"),
      touchesFiles: (n) => `改 ${String(n)} 个文件`,
      detailsShow: "技术细节",
      detailsHide: "收起细节",
      whyLabel: "为什么要改",
      before: "改前",
      after: "改后",
      offButWritten: "关掉只影响下次应用。以前写进宿主的内容还在，要撤掉请用下面的「回退」。",
      blockedTitle: (n) => `预检没通过：${String(n)} 处对不上`,
      blockedBody: "插件不会写任何文件，宿主保持原样。先确认宿主是 README 写明的版本、源码没被手动改过；仍然不行，就把下面的清单复制给作者。",
      copyList: "复制清单",
      findingState: (s) => (s === "conflict" ? "原文和预期不一致" : s === "applied_other" ? "应用的是上一次声明的版本，需先回退" : s === "unsatisfied" ? "缺少预期的内容" : s === "missing" ? "文件不存在或缺少校验记录" : "判定未通过"),
      apply: "应用",
      applyN: (n) => `应用改动（${String(n)} 个文件）`,
      applyHint: "写之前会先给每个文件做快照；写完要重启宿主才生效。",
      revert: "回退",
      revertHint: (n) => `回退会把上次写入的 ${String(n)} 个文件恢复成原样。`,
      whyBusy: "正在处理上一个操作，稍等。",
      whyToggling: "开关还在保存，等它完成。",
      whyNoRoot: "插件还不知道宿主源码在哪，见概览。",
      whyBroken: "应用记录损坏，插件暂停了写入，见概览。",
      whyLock: "另一个应用或回退正在进行。",
      whyBlocked: (n) => `预检有 ${String(n)} 处对不上，应用会被整体拒绝。`,
      whyNoneSelected: "一条补丁都没开，没有可写的内容。",
      whyNothing: "没有需要写入的文件：选中的补丁都已就位。",
      whyNotApplied: "还没有应用记录，没有可回退的内容。",
      whyRulesCorrupt: "规则清单损坏，已暂停写入，请先备份并重置。",
      rulesCorruptNotice: (path) => `规则清单读不出来（$DSH_HOME/${String(path)}），插件已停止写入以保护原数据。已有的正文文件完好保留在 $DSH_HOME/breaklimit/bodies/ 目录中。`,
      confirmDiscardRuleTitle: "当前有未保存的规则草稿",
      confirmDiscardRuleBody: "离开或切换后，未保存的规则改动将会丢失。确认放弃这些改动吗？",
      confirmDiscardYes: "放弃修改",
      confirmOverwriteRuleTitle: (id) => `确认覆盖规则「${String(id)}」？`,
      confirmOverwriteRuleBody: "规则 ID 已存在。保存将替换原有的规则名称与正文，覆盖后原内容无法恢复。",
      confirmOverwriteRuleYes: "确认覆盖",
      openExistingRule: "打开已有的这条规则",
      confirmApplyTitle: (n) => `确认写入 ${String(n)} 个宿主源码文件？`,
      confirmApplyBody: "会改动下面这些文件。写之前先做快照；只要有一处对不上就整批不写；写完需要重启宿主。之后随时可以用「回退」恢复。",
      confirmApplyYes: (n) => `写入 ${String(n)} 个文件`,
      confirmRevertTitle: (n) => `确认把 ${String(n)} 个文件恢复原样？`,
      confirmRevertBody: "会把上次写入的文件恢复成应用前的内容。只要其中有一个被别的程序改过，就整体取消、磁盘不动。完成后需要重启宿主。",
      confirmRevertYes: (n) => `恢复 ${String(n)} 个文件`,
      doneApplied: (n) => `已写入 ${String(n)} 个文件`,
      doneAppliedNext: "还差一步：重启宿主。",
      doneAlready: "无需写入：全部已就位",
      doneReverted: (n) => `已恢复 ${String(n)} 个文件`,
      doneRevertNothing: "没有需要恢复的文件，应用记录已清除",

      restartTitle: "还差一步：重启宿主",
      restartBodyApply: (n) => `刚才写入了 ${String(n)} 个文件，但正在运行的宿主还在用旧代码。重启之后改动才生效。`,
      restartBodyRevert: (n) => `刚才恢复了 ${String(n)} 个文件，但正在运行的宿主还在用补丁后的代码。重启之后才回到原样。`,
      copyRestart: "复制重启命令",
      restartHow: "怎么重启",
      restartDismiss: "我知道了",
      restartStep1: "回到启动宿主的那个终端窗口，按 Ctrl+C 停止它。",
      restartStep2: "在同一个窗口里重新运行启动命令（就是上面这条）。",
      restartStep3: "重新打开这个设置页，概览里显示「补丁已就位」就成功了。",
      restartCaveat: "插件没法自己重启宿主，也没法判断你是否已经重启过，所以这条提示会一直留着，直到你点「我知道了」。",
      restartCommandLabel: "本次启动宿主用的命令",
      restartNoCommand: "没拿到启动命令，请按你平时的方式启动宿主。",

      modeTitle: "提示词模式",
      modeDesc: "两档共用同一份破限正文；差别只有附加的自我约束和执行层上限。注意：提示词模式仅调整模型的自我约束，不降低宿主执行权限。切换不用重启，从下一轮对话开始生效。",
      modeRecommended: "推荐（常用破限）",
      modeUnrestricted: "完全解放（彻底破限）",
      tagDefault: "默认（提示词）",
      tagCurrent: "正在使用",
      tagPending: "待确认",
      modeRecFit: "破限正文照常生效，额外保留三条自我约束：不擅自扩大改动范围、不可逆操作先说后果、交付前给出验证证据。",
      modeRecChange: "执行层按保守值：命令 20 分钟、工具输出 0.5 MB、子命令深度 2。",
      modeUnrFit: "破限正文同样生效，但解除上面三条约束：不自我设限、不给替代方案、不加免责。",
      modeUnrChange: "执行层放开：9999 秒、1 MB、深度 5。",
      confirmModeTitle: (label) => `切换到「${String(label)}」？`,
      confirmModeBody: "从下一轮对话开始生效，不用重启；正在进行的那一轮不受影响。会写 DSH 数据目录里的 breaklimit/tier.json，随时可以切回来。",
      confirmModeYes: "切换",
      doneMode: (label) => `已切换到「${String(label)}」`,
      doneModeNext: "从下一轮对话开始生效。",

      promptTitle: "共用正文",
      promptDesc: "两档模式共用的这段正文放在模型指令的最前面。保存后用你的版本替换内置正文；模式的附加段不受影响。",
      promptUsingMine: (s) => `正在用你的版本 · ${String(s)}`,
      promptUsingBuiltin: "正在用内置正文",
      promptPlaceholder: "在这里写给模型的长期指令…",
      promptCount: (chars, size) => `${String(chars)} 字 · ${String(size)}`,
      promptDirty: "有未保存的改动",
      save: "保存",
      copyAll: "复制全文",
      resetBuiltin: "恢复内置",
      discard: "放弃改动",
      whyNoChange: "没有改动，不用保存。",
      whyEmptyPrompt: "正文是空的。想回到内置正文，请用「恢复内置」。",
      whyAlreadyBuiltin: "现在用的就是内置正文。",
      saveHint: "保存后从下一轮对话开始生效。",
      confirmResetTitle: "删除你的版本，回到内置正文？",
      confirmResetBody: (s) => `你保存的 ${String(s)} 内容会被删除，之后无法找回。建议先点「复制全文」留个备份。`,
      confirmResetYes: "删除并恢复内置",
      donePromptSaved: (s) => `已保存（${String(s)}）`,
      donePromptReset: "已恢复内置正文",
      injectBad: (c) => (c === "inject_too_large" ? "正文文件超过大小上限，宿主现在拿到的是空正文。" : c === "inject_not_file" ? "正文路径不是一个文件，宿主现在拿到的是空正文。" : "正文文件读不出来，宿主现在拿到的是空正文。"),
      injectBadNext: "删减内容后保存，或用「恢复内置」。",

      rulesTitle: "规则",
      rulesDesc: "规则是一份写给模型的长期指令（比如编码规范）。激活后写进 DSH 数据目录的 AGENTS.md 或 CLAUDE.md，宿主每次对话都会读。同一时间只激活一条。",
      rulesCount: (n) => `${String(n)} 条`,
      newRule: "新建规则",
      rulesEmptyTitle: "还没有规则",
      rulesEmptyBody: "新建一条，写下你希望模型一直遵守的事。保存后点「激活」才会生效。",
      newFirstRule: "新建第一条规则",
      ruleActiveTag: "激活中",
      ruleMeta: (target, size) => `写入 ${String(target)} · ${String(size)}`,
      edit: "编辑",
      activate: "激活",
      deactivate: "取消激活",
      del: "删除",
      editRule: (label) => `编辑规则 ${String(label)}`,
      activateRule: (label) => `激活规则 ${String(label)}`,
      deactivateRule: (label) => `取消激活规则 ${String(label)}`,
      deleteRule: (label) => `删除规则 ${String(label)}`,
      editorNewTitle: "新建规则",
      editorEditTitle: (label) => `编辑「${String(label)}」`,
      fieldId: "规则 ID",
      fieldIdHint: "字母或数字开头，可用字母、数字、点、下划线、连字符，最多 64 个字符。",
      fieldIdLocked: "ID 创建后不能改；想换 ID 请新建一条。",
      fieldName: "显示名称（可选）",
      fieldNameHint: "留空就用 ID。",
      fieldTarget: "写入哪个文件",
      targetAgents: "大多数情况选它，宿主默认读这个文件。",
      targetClaude: "只在你的环境读 CLAUDE.md 时选。",
      fieldText: "规则正文",
      fieldTextHint: "写给模型看的指令，可以用 Markdown。",
      ruleIdBad: "ID 格式不对：要以字母或数字开头，只能用字母、数字、点、下划线、连字符。",
      ruleIdTaken: "已有同 ID 的规则，保存会覆盖它。",
      ruleActiveEditing: (t) => `这条正在激活，保存会立刻同步写入 ${String(t)}。`,
      saveRule: "保存规则",
      whyNeedId: "先填规则 ID。",
      whyBadId: "规则 ID 格式不对。",
      whyNeedText: "规则正文是空的。",
      ruleSaved: "规则已保存",
      ruleSavedInactive: "规则已保存，还没激活",
      ruleSavedInactiveNext: "点这条规则的「激活」，它才会写进文件。",
      ruleSavedSynced: (t) => `规则已保存，并同步写入 ${String(t)}`,
      ruleSavedMoved: (t) => `规则已保存，并改为写入 ${String(t)}`,
      ruleSavedStale: (t) => `规则已保存，但 ${String(t)} 被别的程序改过，插件没有覆盖它`,
      confirmActivateTitle: (label) => `激活「${String(label)}」？`,
      confirmActivateBody: (t, s) => `会把这条规则的正文（${String(s)}）写进 ${String(t)}。${String(t)} 原来的内容会先备份，取消激活时还原。`,
      confirmActivateSwap: (label) => `正在激活的「${String(label)}」会先被撤下，它写进的文件会还原。`,
      confirmActivateYes: "激活",
      confirmDeactivateTitle: (label) => `取消激活「${String(label)}」？`,
      confirmDeactivateBody: (t) => `${String(t)} 会还原成激活前的样子；如果它被别的程序改过，插件会原样保留。规则本身不会删除。`,
      confirmDeactivateYes: "取消激活",
      confirmDeleteTitle: (label) => `删除规则「${String(label)}」？`,
      confirmDeleteBody: "规则正文会被删除，无法找回。",
      confirmDeleteActiveBody: (t) => `规则正文会被删除，无法找回。它正在激活：${String(t)} 会先还原成激活前的样子（被别的程序改过则保留）。`,
      confirmDeleteYes: "删除",
      doneActivated: (label, t) => `已激活「${String(label)}」，写入 ${String(t)}`,
      doneActivatedNext: "从下一轮对话开始生效。",
      doneDeactivated: "已取消激活",
      landingRestored: (t) => `${String(t)} 已还原成原来的内容。`,
      landingRemoved: (t) => `插件创建的 ${String(t)} 已删除。`,
      landingSkipped: (n) => `${String(n)} 个文件被别的程序改过，插件原样保留了。`,
      doneDeleted: (label) => `已删除「${String(label)}」`,

      errNetwork: "连不上插件后端",
      errNetworkNext: "确认宿主还在运行，然后重试。",
      errTimeout: "后端太久没有回应",
      errTimeoutNext: "宿主可能正忙，等几秒再重试。",
      errMissing: "宿主里找不到这个插件的接口",
      errMissingNext: "确认插件已经装进当前 profile，并且重启过宿主。",
      errOrigin: "请求被宿主拦下了",
      errOriginNext: "写操作只接受这个页面本身发出的请求。刷新浏览器页面后再试。",
      errNoRoot: "插件不知道宿主源码在哪",
      errNoRootNext: "按概览里的提示设置宿主目录，然后重启宿主。",
      errBlocked: (n) => `预检没通过，一个文件都没写（${String(n)} 处对不上）`,
      errBlockedNext: "宿主保持原样。对不上的位置见下面，或补丁页顶部。",
      errBusy: "另一个应用或回退正在进行",
      errBusyNext: "等它结束后点「重新检查」。",
      errDrift: (n) => `${String(n)} 个文件被别的程序改过，回退已整体取消`,
      errDriftNext: "磁盘没有被改动。先把这些文件恢复原样（或重新安装宿主），再回退。",
      errNotApplied: "没有应用记录，不需要回退",
      errNotAppliedNext: "宿主文件没有被插件改过。",
      errWriteHalf: "写到一半失败了，插件已尝试撤回",
      errWriteHalfNext: "不要反复重试。保留 DSH 数据目录里的 breaklimit 文件夹，按安装说明的「回退与卸载」处理。",
      errState: "应用记录损坏或版本不符，插件拒绝继续",
      errStateNext: "按安装说明的「回退与卸载」一节处理 breaklimit 文件夹。",
      errTooLarge: "内容太长，超过了上限",
      errTooLargeNext: "删减一些再保存。",
      errWrite: "写不进磁盘",
      errWriteNext: "检查 DSH 数据目录的权限和剩余空间，再试一次。",
      errRequest: "请求格式不对（插件内部问题）",
      errRequestNext: "点「重新检查」后再试；仍然出现，请把错误代码报给作者。",
      errUnknownPatch: "后端不认识这条补丁",
      errUnknownPatchNext: "补丁清单可能已经变了，点「重新检查」刷新。",
      errRule: "规则操作被拒绝",
      errRuleNext: "这条规则可能已被删除，或文件读不出来。点「重新检查」刷新列表。",
      errRuleBodyWrite: "写入规则正文文件失败",
      errRuleBodyWriteNext: "请检查磁盘空间或数据目录权限，原规则清单未被改动。",
      errRuleIndex: "更新规则清单失败",
      errRuleIndexNext: "请检查数据目录中的 rules.json 权限。",
      errRuleIndexWithBody: "正文已保存，但未能更新规则清单",
      errRuleIndexWithBodyNext: "新正文已写入 bodies/ 目录，但 rules.json 未能同步更新，建议重新保存一次。",
      errRuleLanding: "正文与清单已保存，但未能同步写入目标文件",
      errRuleLandingNext: "规则已落盘并生效于清单，但写入 AGENTS.md 或 CLAUDE.md 时失败，请检查该文件是否被外部占用或写保护。",
      errRuleConflict: "规则清单在保存过程中被别的窗口改过",
      errRuleConflictNext: "这次保存没有覆盖它。点「重新检查」看最新内容，再保存一次。",
      errRuleTarget: "写入目标只能是 AGENTS.md 或 CLAUDE.md",
      errRuleTargetNext: "重新打开这条规则，在「写入哪个文件」里选一个。",
      errRuleBodyRemove: "规则已从列表移除，但正文文件没删掉",
      errRuleBodyRemoveNext: "列表里不会再出现它；正文仍留在 bodies/ 目录，需要时可以手动删。",
      errServer: "插件后端出错了",
      errServerNext: "点「重新检查」；反复出现，请把错误代码报给作者。",
      errUnknown: "操作没有成功",
      errUnknownNext: "点「重新检查」看看当前状态；反复出现，请把错误代码报给作者。",
      breaklimitButton: "破限",
      dockPopoverTitle: "破限快捷设置",
      dockModeTitle: "提示词模式",
      dockTierFailed: "切换失败，当前仍是原来那档。",
      confirmOverwriteAlias: (from) => `词条「${String(from)}」已存在，确定覆盖吗？`,
      confirmDeleteAlias: (from) => `确定删除词条「${String(from)}」吗？`,
      aliasTitle: "目标词表",
      aliasDesc: "这里配的词会在请求发出前替换回原文里的真实目标名换成占位名。",
      aliasStateEmpty: "词表未配置",
      aliasStateFailed: "词表读取失败",
      aliasStateMiss: "本轮未替换",
      aliasStateHit: (n) => `词表 ${String(n)} 条`,
      aliasLoading: "词表读取中…",
      aliasEmptyList: "暂无条目",
      aliasFrom: "原词",
      aliasTo: "替换成",
      aliasAdd: "添加",
      aliasRemove: "删除",
      aliasConfirmDelete: "确认删除？",
      aliasFoot: "改动只对之后的新会话生效",
      aliasSaveFailed: "保存失败，改动没有生效",
      aliasClose: "关闭",
    },
    en: {
      nav: "Breaklimit",
      title: "Breaklimit",
      lead: "Loosens limits the host sets too tight, switches prompt modes, and keeps standing rules for the model.",
      tabsLabel: "Breaklimit settings",
      tabOverview: "Overview",
      tabPatches: "Patches",
      tabContext: "Prompt & rules",
      refresh: "Refresh",
      refreshedAt: (s) => `Updated ${String(s)}`,
      agoJust: "just now",
      agoMin: (n) => `${String(n)} min ago`,
      agoHour: (n) => `${String(n)} h ago`,
      loading: "Reading plugin state…",
      loadingHint: "Usually a second or two. If it stays here, press Refresh at the top right.",
      retry: "Retry",
      recheck: "Check again",
      dismiss: "Dismiss this message",
      dismissShort: "Dismiss",
      cancel: "Cancel",
      working: "Working…",
      saving: "Saving…",
      copied: "Copied to clipboard",
      copyFailed: "Could not copy",
      copyFailedNext: "The browser blocked clipboard access. Select the text above and copy it by hand.",
      copyCommand: "Copy this line",
      errorCode: (c) => `Error code ${String(c)}`,
      andMore: (n) => `and ${String(n)} more`,
      unknown: "unknown",
      sep: ": ",
      bytes: (n) => `${String(n)} B`,
      timeUnknown: "time unknown",

      goOverview: "Back to Overview",
      goPatches: "Open Patches",
      goPatchesSee: "See them on Patches",
      goPatchesPick: "Choose patches",
      goPatchesApply: "Apply on Patches",
      goContext: "Adjust prompt & rules",

      nextStep: "Next step",
      nsRulesCorruptTitle: "Rules index cannot be read",
      nsRulesCorruptBody: (path) => `The rules index ($DSH_HOME/${String(path)}) is unreadable or has an incompatible version. The plugin paused writes to protect existing data. Rule bodies remain safe in $DSH_HOME/breaklimit/bodies/. You can back up the corrupt index and start fresh with an empty one.`,
      recoverRules: "Back up and reset index",
      confirmRecoverRulesTitle: "Back up and reset rules index?",
      confirmRecoverRulesBody: "The corrupt index file will be copied to dsh-breaklimit-backup and an empty index will be initialized. Existing rule bodies stay in bodies/; creating rules with the same ID will overwrite them.",
      confirmRecoverRulesYes: "Back up and reset",
      doneRecoverRules: "Rules index reset",
      doneRecoverRulesNext: (path) => `Corrupt index backed up to $DSH_HOME/${String(path)}. Rule bodies remain in $DSH_HOME/breaklimit/bodies/.`,
      nsBrokenTitle: "The last apply record cannot be read",
      nsBrokenBody: "To avoid damaging the host, apply and revert are paused. Do not keep retrying. Follow the Revert and uninstall section of the install guide for the breaklimit folder in your DSH data directory, then press Check again.",
      nsRootTitle: "Tell the plugin where the host source is",
      nsRootBody: "The plugin edits a few files in the DeepSeek Harness source tree, but it does not know where that is. Run the line below in the PowerShell window that starts the host (use your own folder), then restart the host.",
      nsRootSnippet: "$env:DSH_BREAKLIMIT_HOST_ROOT = 'D:\\path\\to\\deepseek-harness'",
      nsLockTitle: "Another operation is running",
      nsLockBody: "Another window or the command line may be applying or reverting patches. Wait for it to finish, then press Check again.",
      nsBlockedTitle: (n) => `${String(n)} ${Number(n) === 1 ? "place" : "places"} in the host do not match what the patches expect`,
      nsBlockedBody: "In this state the plugin writes nothing, so the host is safe. The usual cause is a different host version or source edited by hand.",
      nsNoneTitle: "Every patch is switched off",
      nsNoneBody: "Applying now would write nothing. Turn on the ones you want on the Patches tab. Anything written earlier stays until you use Revert.",
      nsPendingTitle: (n) => `${String(n)} ${Number(n) === 1 ? "file is" : "files are"} waiting to be written`,
      nsPendingBody: "The patches you picked are not in the host yet. Review them on the Patches tab, then press Apply.",
      nsDoneTitle: "Patches are in place",
      nsDoneBody: "The host files already match the patches. If you applied them just now, make sure the host has been restarted.",

      stepsTitle: "Three steps",
      stepsDesc: "Go in order. Click any step to jump to it.",
      step1Title: "Pick a prompt mode",
      step1Desc: "Decides which extra instructions the model gets. Change it any time.",
      step2Title: "Choose patches",
      step2Desc: "Turn on the changes you want. Flipping a switch changes no files.",
      step3Title: "Apply, then restart the host",
      step3Desc: "Once written into the host source, restart the host for it to take effect.",
      stepState: (s) => (s === "done" ? "done" : s === "error" ? "needs attention" : s === "warn" ? "one step left" : "not done"),
      pickedOf: (a, b) => `${String(a)} of ${String(b)} on`,
      blockedN: (n) => `${String(n)} ${Number(n) === 1 ? "mismatch" : "mismatches"}`,
      pendingN: (n) => `${String(n)} ${Number(n) === 1 ? "file" : "files"} to write`,
      stepBroken: "apply record damaged",
      stepNoRoot: "host folder not set",
      stepWaitRestart: "written, waiting for a restart",
      stepInPlace: "in place",

      statusTitle: "Current state",
      statusDesc: "Live values the backend read just now.",
      rowHost: "Target host",
      rootSource: (s) => (s === "config" ? "from plugin config" : s === "env" ? "from environment variable" : s === "derived" ? "derived from the host process" : "not set"),
      rootMissingShort: "host source folder not set",
      rowMode: "Prompt mode",
      rowModeHint: "Affects only the model prompt and self-constraints, not the host execution permissions.",
      rowSandbox: "Sandbox level",
      sandboxTakeover: "Full access (default): Host automatically approves routine command approval; tools and edits are guided by plugin rules.",
      sandboxHost: "At this level the plugin does not widen the sandbox; approvals stay with the host.",
      rowPreflight: "Patch preflight",
      preOk: (n) => (Number(n) === 0 ? "passed, nothing to write" : `passed, ${String(n)} ${Number(n) === 1 ? "file" : "files"} to write`),
      preBlocked: (n) => `failed: ${String(n)} ${Number(n) === 1 ? "mismatch" : "mismatches"}`,
      preNoRoot: "cannot check: host folder unknown",
      preBroken: "cannot check: apply record damaged",
      preHint: "Preflight only reads, and runs again on every refresh.",
      rowApplied: "Last apply",
      appliedValue: (n, t) => `${String(n)} ${Number(n) === 1 ? "file" : "files"} · ${String(t)}`,
      appliedNone: "never applied",
      opId: (id) => `operation ${String(id)}`,
      rowRules: "Rules",
      rulesNone: "no rules yet",
      rulesActive: (n, label) => `${String(n)} total, active: ${String(label)}`,
      rulesInactive: (n) => `${String(n)} total, none active`,
      rowPrompt: "Shared body",
      promptMine: (s) => `your version · ${String(s)}`,
      promptBuiltin: "built-in",
      rowTakeover: "Runtime takeover",
      takeoverHint: "Takes effect at once and lasts only for this run; a host restart returns it to the configured value. It does not undo written patches.",
      takeoverLabel: "Runtime takeover switch",
      takeoverState: (on) => (on ? "on" : "off"),
      doneTakeover: (on) => (on ? "Runtime takeover is on" : "Runtime takeover is off"),
      warnTitle: "Host approval settings bypass the plugin",
      warnPresetNever: (p) => `The ${String(p)} preset uses approval never: the host refuses directly and the plugin is never asked.`,
      warnPolicyNever: "The default approval policy is never: approvals in new sessions never reach the plugin.",
      warnOther: (c) => `The host reported a permission notice (${String(c)}).`,
      warnNext: "If you want the plugin to handle approvals, change it to ask in the host permission settings.",

      patchesTitle: "Patches",
      patchesLead: "Each patch changes one known spot in the host source. Choose first, then apply them together.",
      legendSwitch: "Switch",
      legendSwitchDesc: "whether the next Apply includes this patch. Flipping it changes no files.",
      legendDisk: "On disk",
      legendDiskDesc: "what the host source looks like right now: to write, in place, or mismatched.",
      patchesSummary: (a, b, n) => `${String(a)} of ${String(b)} chosen · all patches touch ${String(n)} ${Number(n) === 1 ? "file" : "files"}`,
      patchesEmptyTitle: "Cannot read the patch list",
      kindReplace: "rewrite",
      kindVerify: "check only",
      switchOnHint: "included next time",
      switchOffHint: "skipped next time",
      diskState: (s) => (s === "pending" ? "to write" : s === "ready" ? "in place" : s === "blocked" ? "mismatch" : s === "skipped" ? "not in this run" : "cannot tell yet"),
      touchesFiles: (n) => `touches ${String(n)} ${Number(n) === 1 ? "file" : "files"}`,
      detailsShow: "Details",
      detailsHide: "Hide details",
      whyLabel: "Why",
      before: "Before",
      after: "After",
      offButWritten: "Switching off only affects the next apply. Anything already written stays; use Revert below to undo it.",
      blockedTitle: (n) => `Preflight failed: ${String(n)} ${Number(n) === 1 ? "mismatch" : "mismatches"}`,
      blockedBody: "The plugin writes nothing and the host stays as it is. Check that the host is the version named in the README and that its source was not edited by hand. If it still fails, copy the list below to the author.",
      copyList: "Copy list",
      findingState: (s) => (s === "conflict" ? "original text differs from what was expected" : s === "applied_other" ? "applied from an earlier declaration; revert first" : s === "unsatisfied" ? "expected content is missing" : s === "missing" ? "file or its checksum record is missing" : "check did not pass"),
      apply: "Apply",
      applyN: (n) => `Apply changes (${String(n)} ${Number(n) === 1 ? "file" : "files"})`,
      applyHint: "Each file is snapshotted before writing; restart the host afterwards for it to take effect.",
      revert: "Revert",
      revertHint: (n) => `Revert restores the ${String(n)} ${Number(n) === 1 ? "file" : "files"} written last time.`,
      whyBusy: "Still working on the previous action.",
      whyToggling: "A switch is still saving.",
      whyNoRoot: "The plugin does not know where the host source is yet; see Overview.",
      whyBroken: "The apply record is damaged and writing is paused; see Overview.",
      whyLock: "Another apply or revert is running.",
      whyBlocked: (n) => `Preflight has ${String(n)} ${Number(n) === 1 ? "mismatch" : "mismatches"}, so apply would be refused as a whole.`,
      whyNoneSelected: "No patch is on, so there is nothing to write.",
      whyNothing: "Nothing to write: the chosen patches are already in place.",
      whyNotApplied: "There is no apply record, so there is nothing to revert.",
      whyRulesCorrupt: "Rules index is corrupt and writes are paused; back up and reset first.",
      rulesCorruptNotice: (path) => `Rules index cannot be read ($DSH_HOME/${String(path)}); writes are paused to protect existing data. Rule bodies remain safe in $DSH_HOME/breaklimit/bodies/.`,
      confirmDiscardRuleTitle: "Unsaved rule draft",
      confirmDiscardRuleBody: "Unsaved changes to this rule will be lost if you switch or cancel. Discard these changes?",
      confirmDiscardYes: "Discard changes",
      confirmOverwriteRuleTitle: (id) => `Overwrite existing rule "${String(id)}"?`,
      confirmOverwriteRuleBody: "A rule with this ID already exists. Saving will replace its name and body, and the previous content cannot be recovered.",
      confirmOverwriteRuleYes: "Overwrite",
      openExistingRule: "Open existing rule",
      confirmApplyTitle: (n) => `Write ${String(n)} host source ${Number(n) === 1 ? "file" : "files"}?`,
      confirmApplyBody: "The files below will change. Each is snapshotted first; if anything mismatches, nothing is written; restart the host afterwards. You can undo it with Revert at any time.",
      confirmApplyYes: (n) => `Write ${String(n)} ${Number(n) === 1 ? "file" : "files"}`,
      confirmRevertTitle: (n) => `Restore ${String(n)} ${Number(n) === 1 ? "file" : "files"} to the original?`,
      confirmRevertBody: "The files written last time go back to their pre-apply content. If any of them was changed by another program, the whole revert is cancelled and the disk is left alone. Restart the host afterwards.",
      confirmRevertYes: (n) => `Restore ${String(n)} ${Number(n) === 1 ? "file" : "files"}`,
      doneApplied: (n) => `Wrote ${String(n)} ${Number(n) === 1 ? "file" : "files"}`,
      doneAppliedNext: "One step left: restart the host.",
      doneAlready: "Nothing to write: everything is in place",
      doneReverted: (n) => `Restored ${String(n)} ${Number(n) === 1 ? "file" : "files"}`,
      doneRevertNothing: "Nothing needed restoring; the apply record is cleared",

      restartTitle: "One step left: restart the host",
      restartBodyApply: (n) => `${String(n)} ${Number(n) === 1 ? "file was" : "files were"} just written, but the running host still uses the old code. The change takes effect after a restart.`,
      restartBodyRevert: (n) => `${String(n)} ${Number(n) === 1 ? "file was" : "files were"} just restored, but the running host still uses the patched code. It goes back to the original after a restart.`,
      copyRestart: "Copy restart command",
      restartHow: "How to restart",
      restartDismiss: "Got it",
      restartStep1: "Go to the terminal window that started the host and press Ctrl+C to stop it.",
      restartStep2: "Run the start command again in the same window (the one shown above).",
      restartStep3: "Reopen this settings page. Overview showing Patches are in place means it worked.",
      restartCaveat: "The plugin cannot restart the host or tell whether you have, so this message stays until you press Got it.",
      restartCommandLabel: "Command that started the host",
      restartNoCommand: "Could not read the start command; start the host the way you usually do.",

      modeTitle: "Prompt mode",
      modeDesc: "Both modes share the same jailbreak body; the difference is only extra self-constraints and execution limits. Note: Prompt modes only adjust self-constraints, not host execution permissions. Takes effect on the next turn without restart.",
      modeRecommended: "Recommended (everyday jailbreak)",
      modeUnrestricted: "Unrestricted (full jailbreak)",
      tagDefault: "default (prompt)",
      tagCurrent: "in use",
      tagPending: "to confirm",
      modeRecFit: "The jailbreak body applies as usual, plus three self-imposed constraints: no unrequested scope creep, say what an irreversible step costs before taking it, show the evidence before claiming done.",
      modeRecChange: "Execution stays conservative: 20 min commands, 0.5 MB tool output, subagent depth 2.",
      modeUnrFit: "Same jailbreak body, with those three constraints dropped: no self-limiting, no gentler alternative, no disclaimers.",
      modeUnrChange: "Execution opened up: 9999 s, 1 MB, depth 5.",
      confirmModeTitle: (label) => `Switch to ${String(label)}?`,
      confirmModeBody: "Takes effect from the next turn without a restart; the turn in progress is not affected. Writes breaklimit/tier.json in your DSH data directory. You can switch back any time.",
      confirmModeYes: "Switch",
      doneMode: (label) => `Switched to ${String(label)}`,
      doneModeNext: "Takes effect from the next turn.",

      promptTitle: "Shared prompt body",
      promptDesc: "Both modes share this body, placed at the very start of the model instructions. Saving replaces the built-in body with your version; the mode-specific part is not affected.",
      promptUsingMine: (s) => `Using your version · ${String(s)}`,
      promptUsingBuiltin: "Using the built-in body",
      promptPlaceholder: "Write standing instructions for the model here…",
      promptCount: (chars, size) => `${String(chars)} characters · ${String(size)}`,
      promptDirty: "Unsaved changes",
      save: "Save",
      copyAll: "Copy all",
      resetBuiltin: "Restore built-in",
      discard: "Discard changes",
      whyNoChange: "No changes to save.",
      whyEmptyPrompt: "The body is empty. To go back to the built-in body, use Restore built-in.",
      whyAlreadyBuiltin: "The built-in body is already in use.",
      saveHint: "Takes effect from the next turn after saving.",
      confirmResetTitle: "Delete your version and go back to the built-in body?",
      confirmResetBody: (s) => `Your saved text (${String(s)}) is deleted and cannot be recovered. Press Copy all first if you want a backup.`,
      confirmResetYes: "Delete and restore",
      donePromptSaved: (s) => `Saved (${String(s)})`,
      donePromptReset: "Built-in body restored",
      injectBad: (c) => (c === "inject_too_large" ? "The body file is over the size limit, so the host currently gets an empty body." : c === "inject_not_file" ? "The body path is not a file, so the host currently gets an empty body." : "The body file cannot be read, so the host currently gets an empty body."),
      injectBadNext: "Shorten it and save, or use Restore built-in.",

      rulesTitle: "Rules",
      rulesDesc: "A rule is a standing instruction for the model, such as coding conventions. Activating it writes it into AGENTS.md or CLAUDE.md in your DSH data directory, which the host reads in every conversation. One rule is active at a time.",
      rulesCount: (n) => `${String(n)}`,
      newRule: "New rule",
      rulesEmptyTitle: "No rules yet",
      rulesEmptyBody: "Create one and write down what the model should always follow. It takes effect after you press Activate.",
      newFirstRule: "Create your first rule",
      ruleActiveTag: "active",
      ruleMeta: (target, size) => `writes ${String(target)} · ${String(size)}`,
      edit: "Edit",
      activate: "Activate",
      deactivate: "Deactivate",
      del: "Delete",
      editRule: (label) => `Edit rule ${String(label)}`,
      activateRule: (label) => `Activate rule ${String(label)}`,
      deactivateRule: (label) => `Deactivate rule ${String(label)}`,
      deleteRule: (label) => `Delete rule ${String(label)}`,
      editorNewTitle: "New rule",
      editorEditTitle: (label) => `Edit ${String(label)}`,
      fieldId: "Rule ID",
      fieldIdHint: "Starts with a letter or digit; letters, digits, dot, underscore and dash; up to 64 characters.",
      fieldIdLocked: "The ID cannot change after creation. Create a new rule for a new ID.",
      fieldName: "Display name (optional)",
      fieldNameHint: "Leave empty to use the ID.",
      fieldTarget: "Which file to write",
      targetAgents: "Pick this in most cases; the host reads it by default.",
      targetClaude: "Pick only if your setup reads CLAUDE.md.",
      fieldText: "Rule text",
      fieldTextHint: "Instructions for the model. Markdown is fine.",
      ruleIdBad: "Invalid ID: start with a letter or digit and use only letters, digits, dot, underscore and dash.",
      ruleIdTaken: "A rule with this ID exists; saving overwrites it.",
      ruleActiveEditing: (t) => `This rule is active; saving writes it into ${String(t)} right away.`,
      saveRule: "Save rule",
      whyNeedId: "Fill in a rule ID first.",
      whyBadId: "The rule ID is not valid.",
      whyNeedText: "The rule text is empty.",
      ruleSaved: "Rule saved",
      ruleSavedInactive: "Rule saved, not active yet",
      ruleSavedInactiveNext: "Press Activate on this rule to write it into its file.",
      ruleSavedSynced: (t) => `Rule saved and written into ${String(t)}`,
      ruleSavedMoved: (t) => `Rule saved and now writes into ${String(t)}`,
      ruleSavedStale: (t) => `Rule saved, but ${String(t)} was changed by another program, so the plugin left it alone`,
      confirmActivateTitle: (label) => `Activate ${String(label)}?`,
      confirmActivateBody: (t, s) => `Writes this rule (${String(s)}) into ${String(t)}. The current content of ${String(t)} is backed up first and restored on deactivate.`,
      confirmActivateSwap: (label) => `The active rule ${String(label)} is taken down first and its file restored.`,
      confirmActivateYes: "Activate",
      confirmDeactivateTitle: (label) => `Deactivate ${String(label)}?`,
      confirmDeactivateBody: (t) => `${String(t)} goes back to how it was before activation; if another program changed it, the plugin leaves it as is. The rule itself is kept.`,
      confirmDeactivateYes: "Deactivate",
      confirmDeleteTitle: (label) => `Delete rule ${String(label)}?`,
      confirmDeleteBody: "The rule text is deleted and cannot be recovered.",
      confirmDeleteActiveBody: (t) => `The rule text is deleted and cannot be recovered. It is active, so ${String(t)} is first restored to how it was before activation (kept as is if another program changed it).`,
      confirmDeleteYes: "Delete",
      doneActivated: (label, t) => `Activated ${String(label)}, written into ${String(t)}`,
      doneActivatedNext: "Takes effect from the next turn.",
      doneDeactivated: "Deactivated",
      landingRestored: (t) => `${String(t)} is back to its original content.`,
      landingRemoved: (t) => `The ${String(t)} the plugin created was removed.`,
      landingSkipped: (n) => `${String(n)} ${Number(n) === 1 ? "file was" : "files were"} changed by another program and left as is.`,
      doneDeleted: (label) => `Deleted ${String(label)}`,

      errNetwork: "Cannot reach the plugin backend",
      errNetworkNext: "Make sure the host is still running, then retry.",
      errTimeout: "The backend took too long to answer",
      errTimeoutNext: "The host may be busy. Wait a few seconds and retry.",
      errMissing: "The host has no endpoint for this plugin",
      errMissingNext: "Make sure the plugin is installed in the current profile and the host was restarted.",
      errOrigin: "The host blocked this request",
      errOriginNext: "Write actions are only accepted from this page itself. Reload the browser page and try again.",
      errNoRoot: "The plugin does not know where the host source is",
      errNoRootNext: "Set the host folder as shown on Overview, then restart the host.",
      errBlocked: (n) => `Preflight failed and nothing was written (${String(n)} ${Number(n) === 1 ? "mismatch" : "mismatches"})`,
      errBlockedNext: "The host is unchanged. The mismatches are listed below and at the top of Patches.",
      errBusy: "Another apply or revert is running",
      errBusyNext: "Wait for it to finish, then press Check again.",
      errDrift: (n) => `${String(n)} ${Number(n) === 1 ? "file was" : "files were"} changed by another program, so the revert was cancelled`,
      errDriftNext: "Nothing on disk changed. Restore these files (or reinstall the host) first, then revert.",
      errNotApplied: "There is no apply record, so nothing to revert",
      errNotAppliedNext: "The plugin has not changed any host files.",
      errWriteHalf: "Writing failed halfway; the plugin tried to roll back",
      errWriteHalfNext: "Do not keep retrying. Keep the breaklimit folder in your DSH data directory and follow the Revert and uninstall section of the install guide.",
      errState: "The apply record is damaged or from another version, so the plugin stopped",
      errStateNext: "Follow the Revert and uninstall section of the install guide for the breaklimit folder.",
      errTooLarge: "The content is over the size limit",
      errTooLargeNext: "Shorten it and save again.",
      errWrite: "Could not write to disk",
      errWriteNext: "Check the permissions and free space of your DSH data directory, then try again.",
      errRequest: "The request was malformed (a plugin bug)",
      errRequestNext: "Press Check again and retry. If it keeps happening, report the error code to the author.",
      errUnknownPatch: "The backend does not know this patch",
      errUnknownPatchNext: "The patch list may have changed. Press Check again to refresh.",
      errRule: "The rule action was refused",
      errRuleNext: "The rule may have been deleted or its file is unreadable. Press Check again to refresh the list.",
      errRuleBodyWrite: "Failed to write rule body file",
      errRuleBodyWriteNext: "Check disk space or directory permissions. The rules index was untouched.",
      errRuleIndex: "Failed to update rules index",
      errRuleIndexNext: "Check permissions of rules.json in the data directory.",
      errRuleIndexWithBody: "Body saved, but failed to update rules index",
      errRuleIndexWithBodyNext: "The new body is in bodies/, but rules.json was not updated. Try saving again.",
      errRuleLanding: "Body and index saved, but failed to sync landing file",
      errRuleLandingNext: "The rule is saved in bodies/ and the index, but writing to the target file failed. Check if it is locked or write-protected.",
      errRuleConflict: "The rules index changed in another window during the save",
      errRuleConflictNext: "This save did not overwrite it. Press Check again to load the latest list, then save once more.",
      errRuleTarget: "The target must be AGENTS.md or CLAUDE.md",
      errRuleTargetNext: "Reopen this rule and pick a file under Where to write.",
      errRuleBodyRemove: "The rule was removed from the list, but its body file was not deleted",
      errRuleBodyRemoveNext: "It no longer appears in the list; the body stays in bodies/ if you want to delete it by hand.",
      errServer: "The plugin backend failed",
      errServerNext: "Press Check again. If it keeps happening, report the error code to the author.",
      errUnknown: "The action did not succeed",
      errUnknownNext: "Press Check again to see the current state. If it keeps happening, report the error code to the author.",
      breaklimitButton: "Breaklimit",
      dockPopoverTitle: "Quick Breaklimit Settings",
      dockModeTitle: "Prompt Mode",
      dockTierFailed: "Switch failed; the mode is unchanged.",
      confirmOverwriteAlias: (from) => `Entry "${String(from)}" already exists. Overwrite?`,
      confirmDeleteAlias: (from) => `Delete entry "${String(from)}"?`,
      aliasTitle: "Target words",
      aliasDesc: "Words listed here replace the real target name in your message before it reaches the model.",
      aliasStateEmpty: "Word list empty",
      aliasStateFailed: "Word list unavailable",
      aliasStateMiss: "No swaps this turn",
      aliasStateHit: (n) => `Word list: ${String(n)}`,
      aliasLoading: "Reading word list…",
      aliasEmptyList: "No entries yet",
      aliasFrom: "Word",
      aliasTo: "Replace with",
      aliasAdd: "Add",
      aliasRemove: "Remove",
      aliasConfirmDelete: "Confirm delete?",
      aliasFoot: "Changes apply to new sessions only",
      aliasSaveFailed: "Save failed; nothing changed",
      aliasClose: "Close",
    },
  }

  // ---- 语言 -----------------------------------------------------------------
  //
  // 宿主的 locale 插件激活后才改写 html lang；这里先读一次，再由 Section 里的
  // MutationObserver 跟随变化。桩环境没有 document 时按英文走。
  function readLanguage() {
    try {
      const htmlLang = document?.documentElement?.lang
      if (typeof htmlLang === "string" && htmlLang !== "") return htmlLang.toLowerCase().startsWith("zh") ? "zh" : "en"
      const nav = navigator?.language
      if (typeof nav === "string" && nav.toLowerCase().startsWith("zh")) return "zh"
    } catch {
      // 读不到就按英文。
    }
    return "en"
  }

  let lang = readLanguage()
  let T = TEXT[lang]

  function refreshText() {
    const next = readLanguage()
    if (next === lang) return false
    lang = next
    T = TEXT[lang]
    return true
  }

  // ---- 请求与错误 -----------------------------------------------------------

  function failure(code, status, data) {
    const error = new Error(code)
    error.code = code
    error.status = status
    error.data = data
    return error
  }

  async function request(path, init) {
    const controller = typeof AbortController === "function" ? new AbortController() : null
    const timer = controller === null ? null : setTimeout(() => { controller.abort() }, REQUEST_TIMEOUT_MS)
    let response
    try {
      response = await fetch(`${API}${path}`, {
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        signal: controller?.signal,
        ...init,
      })
    } catch (cause) {
      throw failure(cause?.name === "AbortError" ? "timeout" : "network", 0, null)
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
    const payload = await response.json().catch(() => null)
    if (!response.ok || payload?.ok === false) {
      const code = typeof payload?.code === "string" && payload.code !== "" ? payload.code : `http_${String(response.status)}`
      throw failure(code, response.status, payload?.data ?? null)
    }
    return payload ?? {}
  }

  const get = (path) => request(path, { method: "GET" })
  const post = (path, body) => request(path, { method: "POST", body: JSON.stringify(body ?? {}) })
  const put = (path, body) => request(path, { method: "PUT", body: JSON.stringify(body ?? {}) })

  /** 错误码翻译成一句话 + 一个下一步。永远不展示后端 message 或原始 JSON。 */
  function explain(error) {
    const code = String(error?.code ?? "unknown")
    const data = error?.data ?? null
    const make = (title, next, action, extra) => ({ tone: "error", title, next, action: action ?? null, code, ...extra })
    const count = (list) => (Array.isArray(list) ? list.length : 0)
    switch (code) {
      case "network": return make(T.errNetwork, T.errNetworkNext, "retry")
      case "timeout": return make(T.errTimeout, T.errTimeoutNext, "retry")
      case "http_404":
      case "not_found": return make(T.errMissing, T.errMissingNext, null)
      case "http_403":
      case "cross_origin": return make(T.errOrigin, T.errOriginNext, null)
      case "host_root_unconfigured": return make(T.errNoRoot, T.errNoRootNext, "goOverview")
      case "preflight_blocked":
        return make(T.errBlocked(count(data?.blocked)), T.errBlockedNext, "refresh", { items: blockedLines(data?.blocked) })
      case "operation_in_progress": return make(T.errBusy, T.errBusyNext, "refresh", { tone: "warn" })
      case "drift_detected":
        return make(T.errDrift(count(data?.drifted)), T.errDriftNext, null, {
          items: Array.isArray(data?.drifted) ? data.drifted.map(item => String(item?.path ?? "")) : [],
        })
      case "not_applied": return make(T.errNotApplied, T.errNotAppliedNext, null, { tone: "info" })
      case "apply_failed":
      case "revert_failed": return make(T.errWriteHalf, T.errWriteHalfNext, "refresh")
      case "state_corrupt":
      case "state_version_mismatch": return make(T.errState, T.errStateNext, "refresh")
      case "too_large": return make(T.errTooLarge, T.errTooLargeNext, null)
      case "write_failed": return make(T.errWrite, T.errWriteNext, null)
      case "unknown_patch": return make(T.errUnknownPatch, T.errUnknownPatchNext, "refresh")
      case "body_write_failed": return make(T.errRuleBodyWrite, T.errRuleBodyWriteNext, null)
      case "index_write_failed":
        return make(
          data?.bodyWritten ? T.errRuleIndexWithBody : T.errRuleIndex,
          data?.bodyWritten ? T.errRuleIndexWithBodyNext : T.errRuleIndexNext,
          "refresh"
        )
      case "landing_write_failed":
        return make(T.errRuleLanding, T.errRuleLandingNext, "refresh")
      case "conflict": return make(T.errRuleConflict, T.errRuleConflictNext, "refresh")
      // 显式列出：default 里 `invalid_` 一律翻成「请求格式不对（插件内部问题）」，
      // 而 target 非法是用户能自己改的，说成内部问题等于把人挡在门外。
      case "invalid_target": return make(T.errRuleTarget, T.errRuleTargetNext, null)
      case "body_remove_failed": return make(T.errRuleBodyRemove, T.errRuleBodyRemoveNext, "refresh")
      case "rule_invalid":
      case "rule_unreadable": return make(T.errRule, T.errRuleNext, "refresh")
      default:
        if (code.startsWith("invalid_")) return make(T.errRequest, T.errRequestNext, "refresh")
        if (code === "internal_error" || code.startsWith("http_5")) return make(T.errServer, T.errServerNext, "refresh")
        return make(T.errUnknown, T.errUnknownNext, "refresh")
    }
  }

  function blockedLines(list) {
    return Array.isArray(list) ? list.map(item => `${String(item?.patchId ?? "")} · ${String(item?.path ?? "")}`) : []
  }

  // ---- 小工具 ---------------------------------------------------------------

  function merge(...parts) {
    return Object.assign({}, ...parts.filter(Boolean))
  }

  function unique(list) {
    return [...new Set(list)]
  }

  function safeId(value) {
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "-")
  }

  function pickLang(map) {
    return map !== null && typeof map === "object" && typeof map[lang] === "string" ? map[lang] : ""
  }

  function formatBytes(value) {
    const n = Number(value)
    if (!Number.isFinite(n) || n <= 0) return T.bytes(0)
    if (n < 1024) return T.bytes(n)
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    return `${(n / 1024 / 1024).toFixed(2)} MB`
  }

  function utf8Length(text) {
    try {
      return new TextEncoder().encode(text).length
    } catch {
      return text.length
    }
  }

  function formatTime(value) {
    const date = new Date(value ?? "")
    if (Number.isNaN(date.getTime())) return T.timeUnknown
    try {
      return date.toLocaleString(lang === "zh" ? "zh-CN" : "en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    } catch {
      return date.toISOString()
    }
  }

  function formatAgo(at) {
    const minutes = Math.floor((Date.now() - at) / 60000)
    if (minutes < 1) return T.agoJust
    if (minutes < 60) return T.agoMin(minutes)
    return T.agoHour(Math.floor(minutes / 60))
  }

  function modeLabel(mode) {
    return mode === "unrestricted" ? T.modeUnrestricted : T.modeRecommended
  }

  async function writeClipboard(text) {
    try {
      if (typeof navigator === "undefined" || typeof navigator.clipboard?.writeText !== "function") return false
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      return false
    }
  }

  // ---- 从后端状态推导结论 ---------------------------------------------------
  //
  // 这里只做归纳，不做判断：是否待写入、是否阻断，全部来自后端预检的 findings。

  function derive(status, patchInfo, tierInfo, override, restart) {
    const pre = status?.preflight ?? null
    const preCode = typeof pre?.code === "string" ? pre.code : null
    const patches = Array.isArray(patchInfo?.patches) ? patchInfo.patches : []
    const findings = Array.isArray(pre?.findings) ? pre.findings : []
    const blocked = Array.isArray(pre?.blocked) ? pre.blocked : []
    const pendingPaths = unique(findings.filter(item => item?.state === "pending").map(item => String(item.path ?? "")))
    const pendingFiles = Number.isFinite(pre?.pendingFiles) ? pre.pendingFiles : pendingPaths.length
    const tier = MODES.includes(tierInfo?.tier) ? tierInfo.tier : MODES.includes(status?.tier?.active) ? status.tier.active : MODES[0]
    return {
      pre,
      preCode,
      preKnown: preCode === "ok" || preCode === "blocked",
      patches,
      findings,
      blocked,
      pendingPaths,
      pendingFiles,
      rootMissing: status !== null && (preCode === "host_root_unconfigured" || !status.hostRoot),
      broken: status !== null && ((status.stateProblem !== null && status.stateProblem !== undefined)
        || preCode === "state_corrupt" || preCode === "state_version_mismatch"),
      lockBusy: status?.lock?.busy === true,
      applied: status?.applied ?? null,
      enabledCount: patches.filter(patch => patch.enabled === true).length,
      total: patches.length,
      mode: tier,
      rules: Array.isArray(status?.rules) ? status.rules : [],
      activeRule: typeof status?.activeRule === "string" ? status.activeRule : null,
      rulesIndex: status?.rulesIndex ?? "ok",
      // 后端给的是相对 `$DSH_HOME` 的路径；拿不到时退回包里写死的默认位置，
      // 免得提示里出现一个空路径。
      rulesIndexPath: typeof status?.rulesIndexPath === "string" && status.rulesIndexPath !== ""
        ? status.rulesIndexPath
        : "breaklimit/rules.json",
      customPrompt: override?.userFileExists === true,
      restartPending: restart !== null,
    }
  }

  function nextStep(f, loadError) {
    if (loadError) return { tone: "error", title: loadError.title, body: loadError.next, primary: { label: T.retry, action: "retry" } }
    if (f.rulesIndex === "corrupt") {
      return {
        tone: "error",
        title: T.nsRulesCorruptTitle,
        body: T.nsRulesCorruptBody(f.rulesIndexPath),
        primary: { label: T.recoverRules, action: "recoverRules" },
        secondary: { label: T.recheck, action: "refresh" },
      }
    }
    if (f.broken) return { tone: "error", title: T.nsBrokenTitle, body: T.nsBrokenBody, primary: { label: T.recheck, action: "refresh" } }
    if (f.rootMissing) {
      return {
        tone: "warn", title: T.nsRootTitle, body: T.nsRootBody, snippet: T.nsRootSnippet,
        primary: { label: T.copyCommand, action: "copyRoot" }, secondary: { label: T.recheck, action: "refresh" },
      }
    }
    if (f.lockBusy) return { tone: "info", title: T.nsLockTitle, body: T.nsLockBody, primary: { label: T.recheck, action: "refresh" } }
    if (f.blocked.length > 0) {
      return { tone: "error", title: T.nsBlockedTitle(f.blocked.length), body: T.nsBlockedBody, primary: { label: T.goPatchesSee, action: "goPatches" } }
    }
    if (f.total > 0 && f.enabledCount === 0) {
      return { tone: "info", title: T.nsNoneTitle, body: T.nsNoneBody, primary: { label: T.goPatchesPick, action: "goPatches" } }
    }
    if (f.pendingFiles > 0) {
      return { tone: "accent", title: T.nsPendingTitle(f.pendingFiles), body: T.nsPendingBody, primary: { label: T.goPatchesApply, action: "goPatches" } }
    }
    return { tone: "ok", title: T.nsDoneTitle, body: T.nsDoneBody, secondary: { label: T.goContext, action: "goContext" } }
  }

  function stepItems(f) {
    let applyState = "todo"
    let applyValue = T.unknown
    if (f.broken || f.blocked.length > 0) {
      applyState = "error"
      applyValue = f.broken ? T.stepBroken : T.blockedN(f.blocked.length)
    } else if (f.rootMissing) {
      applyValue = T.stepNoRoot
    } else if (f.restartPending) {
      applyState = "warn"
      applyValue = T.stepWaitRestart
    } else if (f.pendingFiles > 0) {
      applyValue = T.pendingN(f.pendingFiles)
    } else if (f.preKnown) {
      applyState = "done"
      applyValue = T.stepInPlace
    }
    return [
      { key: "mode", tab: "context", state: "done", title: T.step1Title, value: modeLabel(f.mode), desc: T.step1Desc },
      {
        key: "pick", tab: "patches", state: f.enabledCount > 0 ? "done" : "todo", title: T.step2Title,
        value: f.total === 0 ? T.unknown : T.pickedOf(f.enabledCount, f.total), desc: T.step2Desc,
      },
      { key: "apply", tab: "patches", state: applyState, title: T.step3Title, value: applyValue, desc: T.step3Desc },
    ]
  }

  /** 一条补丁的磁盘状态：只看后端预检对它的判定；关掉的补丁不在预检范围里。 */
  function diskState(patch, f) {
    if (f.rootMissing || f.broken || !f.preKnown) return "unknown"
    const own = f.findings.filter(item => item?.patchId === patch.id)
    if (own.length === 0) return patch.enabled === true ? "unknown" : "skipped"
    if (own.some(item => item.state === "conflict" || item.state === "unsatisfied" || item.state === "missing" || item.state === "applied_other")) return "blocked"
    if (own.some(item => item.state === "pending")) return "pending"
    return "ready"
  }

  function applyReason(f, busy, toggles) {
    if (busy) return T.whyBusy
    if (Object.keys(toggles).length > 0) return T.whyToggling
    if (f.rootMissing) return T.whyNoRoot
    if (f.broken) return T.whyBroken
    if (f.lockBusy) return T.whyLock
    if (f.blocked.length > 0) return T.whyBlocked(f.blocked.length)
    if (f.total > 0 && f.enabledCount === 0) return T.whyNoneSelected
    if (f.pendingFiles === 0) return T.whyNothing
    return null
  }

  function revertReason(f, busy) {
    if (busy) return T.whyBusy
    if (f.rootMissing) return T.whyNoRoot
    if (f.broken) return T.whyBroken
    if (f.lockBusy) return T.whyLock
    if (f.applied === null) return T.whyNotApplied
    return null
  }

  function actionLabel(action) {
    if (action === "retry") return T.retry
    if (action === "goOverview") return T.goOverview
    if (action === "goPatches") return T.goPatches
    if (action === "recoverRules") return T.recoverRules
    return T.recheck
  }

  // ---- 共用小件 -------------------------------------------------------------

  /**
   * 不可点的按钮用 aria-disabled 而不是 disabled：保留键盘焦点，读屏能通过
   * aria-describedby 读到「为什么不能点」。
   */
  function Button({ kind = "plain", size, off, reason, describedBy, label, expanded, controls, buttonRef, onClick, children }) {
    const filled = kind === "primary" || kind === "danger"
    return h("button", {
      type: "button",
      ref: buttonRef,
      className: `bkl-btn ${filled ? "bkl-btn-fill" : "bkl-btn-plain"}`,
      style: merge(
        S.btn,
        kind === "primary" && S.btnPrimary,
        kind === "danger" && S.btnDanger,
        kind === "quiet" && S.btnQuiet,
        kind === "quietDanger" && S.btnQuietDanger,
        size === "small" && S.btnSmall,
        off && S.btnOff,
      ),
      "aria-disabled": off ? "true" : undefined,
      "aria-describedby": describedBy,
      "aria-label": label,
      "aria-expanded": expanded,
      "aria-controls": controls,
      title: off && reason ? reason : undefined,
      onClick: (event) => {
        if (off) {
          event.preventDefault()
          return
        }
        onClick?.(event)
      },
    }, children)
  }

  /** role="switch" 的原生按钮：空格与回车由浏览器转成 click。 */
  function Switch({ on, off, labelledBy, describedBy, label, onToggle }) {
    return h("button", {
      type: "button",
      role: "switch",
      className: "bkl-switch",
      "aria-checked": on ? "true" : "false",
      "aria-disabled": off ? "true" : undefined,
      "aria-labelledby": labelledBy,
      "aria-describedby": describedBy,
      "aria-label": label,
      style: merge(S.switchTrack, on && S.switchOn, off && S.btnOff),
      onClick: () => { if (!off) onToggle(!on) },
    }, h("span", { className: "bkl-knob", "aria-hidden": "true", style: merge(S.switchKnob, on && S.switchKnobOn) }))
  }

  function Dot({ tone }) {
    return h("span", { "aria-hidden": "true", style: merge(S.dot, { background: TONE_COLOR[tone] ?? tk.line4 }) })
  }

  function Tag({ tone, children }) {
    const color = tone === undefined ? null : TONE_COLOR[tone]
    return h("span", { style: merge(S.tag, color && { color, border: "0.5px solid currentColor" }) }, children)
  }

  function Card({ title, titleId, desc, descId, aside, children }) {
    return h("section", { style: S.card, "aria-labelledby": title === undefined ? undefined : titleId },
      title === undefined
        ? null
        : h("div", { style: S.cardHead },
          h("div", { style: S.cardHeadText },
            h("h3", { id: titleId, style: S.cardTitle }, title),
            desc === undefined ? null : h("p", { id: descId, style: S.small }, desc)),
          aside ?? null),
      children)
  }

  function PathList({ items }) {
    const shown = items.slice(0, LIST_LIMIT)
    const rest = items.length - shown.length
    return h("ul", { style: S.pathList },
      shown.map((item, index) => h("li", { key: `p${String(index)}`, style: S.pathItem }, item)),
      rest > 0 ? h("li", { key: "more", style: S.pathMore }, T.andMore(rest)) : null)
  }

  function Notice({ notice, onAction, onDismiss }) {
    const tone = notice.tone ?? "info"
    const items = Array.isArray(notice.items) ? notice.items.filter(item => item !== "") : []
    return h("div", {
      className: "bkl-fade",
      role: tone === "error" ? "alert" : "status",
      style: merge(S.banner, { background: TONE_SOFT[tone] ?? tk.well }),
    },
      h("div", { style: S.bannerHead },
        h(Dot, { tone }),
        h("p", { style: S.bannerTitle }, notice.title),
        onDismiss ? h(Button, { kind: "quiet", size: "small", label: T.dismiss, onClick: onDismiss }, T.dismissShort) : null),
      notice.next ? h("p", { style: S.text }, notice.next) : null,
      items.length > 0 ? h(PathList, { items }) : null,
      notice.action || notice.code
        ? h("div", { style: S.row },
          notice.action && onAction
            ? h(Button, { size: "small", onClick: () => { onAction(notice.action) } }, actionLabel(notice.action))
            : null,
          h("span", { style: S.spacer }),
          notice.code ? h("span", { style: S.code }, T.errorCode(notice.code)) : null)
        : null)
  }

  /** 就地确认条：打开时焦点落在确认按钮上，Esc 取消。 */
  function ConfirmStrip({ confirm, busy, onAccept, onCancel }) {
    const yesRef = useRef(null)
    useEffect(() => { yesRef.current?.focus?.() }, [])
    const danger = confirm.tone === "danger"
    return h("div", {
      className: "bkl-fade",
      role: "group",
      "aria-labelledby": "bkl-confirm-title",
      style: merge(S.confirm, danger && { border: `0.5px solid ${tk.error}` }),
      onKeyDown: (event) => {
        if (event.key !== "Escape") return
        event.preventDefault()
        onCancel()
      },
    },
      h("p", { id: "bkl-confirm-title", style: merge(S.confirmTitle, danger && { color: tk.error }) }, confirm.title),
      h("p", { id: "bkl-confirm-body", style: S.text }, confirm.body),
      Array.isArray(confirm.items) && confirm.items.length > 0 ? h(PathList, { items: confirm.items }) : null,
      confirm.foot ? h("p", { style: S.small }, confirm.foot) : null,
      h("div", { style: S.row },
        h(Button, { kind: danger ? "danger" : "primary", off: busy, reason: T.whyBusy, describedBy: "bkl-confirm-body", buttonRef: yesRef, onClick: onAccept },
          busy ? T.working : confirm.yes),
        h(Button, { kind: "quiet", onClick: onCancel }, T.cancel)))
  }

  function Rows({ items }) {
    const shown = items.filter(Boolean)
    return h("ul", { style: S.rows },
      shown.map((item, index) => h("li", { key: item.id, style: merge(S.rowItem, index === 0 && S.rowFirst) },
        h("span", { id: `bkl-row-${item.id}`, style: S.rowKey }, item.label),
        h("div", { style: S.rowVal },
          h("span", { style: S.rowValue }, item.tone ? h(Dot, { tone: item.tone }) : null, item.value),
          item.hint ? h("span", { id: `bkl-row-${item.id}-hint`, style: merge(S.small, item.mono && S.mono) }, item.hint) : null),
        item.control ?? h("span", null))))
  }

  /** 单选卡片：方向键移动并选中（WAI-ARIA radio 的约定），只有被选中的那张可 Tab 到达。 */
  function RadioCards({ group, labelledBy, options, value, onSelect, compact }) {
    const hasChecked = options.some(option => option.id === value)
    const move = (index) => {
      const option = options[(index + options.length) % options.length]
      document.getElementById(`bkl-${group}-${option.id}`)?.focus?.()
      onSelect(option.id)
    }
    return h("div", { role: "radiogroup", "aria-labelledby": labelledBy, style: compact ? S.segment : S.radioGrid },
      options.map((option, index) => {
        const checked = option.id === value
        return h("button", {
          key: option.id,
          id: `bkl-${group}-${option.id}`,
          type: "button",
          role: "radio",
          className: "bkl-radio",
          "aria-checked": checked ? "true" : "false",
          "aria-describedby": option.descId,
          tabIndex: checked || (!hasChecked && index === 0) ? 0 : -1,
          style: merge(S.radioCard, checked && S.radioCardOn),
          onClick: () => { onSelect(option.id) },
          onKeyDown: (event) => {
            const forward = event.key === "ArrowRight" || event.key === "ArrowDown"
            const backward = event.key === "ArrowLeft" || event.key === "ArrowUp"
            if (!forward && !backward) return
            event.preventDefault()
            move(index + (forward ? 1 : -1))
          },
        },
          h("span", { style: S.radioHead },
            h("span", { "aria-hidden": "true", style: merge(S.radioMark, checked && S.radioMarkOn) }, checked ? h("span", { style: S.radioMarkDot }) : null),
            h("span", { style: S.strong }, option.title),
            option.tags ?? null),
          option.body ?? null)
      }))
  }

  function Empty({ title, body, action }) {
    return h("div", { style: S.empty },
      h("p", { style: S.strong }, title),
      body ? h("p", { style: S.small }, body) : null,
      action ?? null)
  }

  // ---- 重启横幅 -------------------------------------------------------------

  function RestartBanner({ restart, onCopy, onToggleHow, onDismiss, notice }) {
    return h("section", {
      className: "bkl-fade",
      "aria-labelledby": "bkl-restart-title",
      style: merge(S.banner, { background: tk.warnSoft }),
    },
      h("div", { style: S.bannerHead },
        h(Dot, { tone: "warn" }),
        h("h3", { id: "bkl-restart-title", style: S.bannerTitle }, T.restartTitle)),
      h("p", { style: S.text }, restart.kind === "revert" ? T.restartBodyRevert(restart.count) : T.restartBodyApply(restart.count)),
      restart.command === undefined
        ? null
        : restart.command === null
          ? h("p", { style: S.small }, T.restartNoCommand)
          : h("pre", { style: S.codeBlock, "aria-label": T.restartCommandLabel }, restart.command),
      h("div", { style: S.row },
        h(Button, { kind: "primary", onClick: onCopy }, T.copyRestart),
        h(Button, { kind: "quiet", expanded: restart.open === true, controls: "bkl-restart-how", onClick: onToggleHow }, T.restartHow),
        h("span", { style: S.spacer }),
        h(Button, { kind: "quiet", onClick: onDismiss }, T.restartDismiss)),
      h("div", { id: "bkl-restart-how", hidden: restart.open !== true, style: { display: restart.open === true ? "flex" : "none", flexDirection: "column", gap: "6px" } },
        h("ol", { style: S.ol },
          h("li", null, T.restartStep1),
          h("li", null, T.restartStep2),
          h("li", null, T.restartStep3)),
        h("p", { style: S.small }, T.restartCaveat)),
      notice ?? null)
  }

  // ---- 概览 -----------------------------------------------------------------

  function NextStepCard({ step, busy, onRun, notice }) {
    return h("section", { style: S.card, "aria-labelledby": "bkl-next-title" },
      h("span", { style: S.eyebrow }, h(Dot, { tone: step.tone }), T.nextStep),
      h("h3", { id: "bkl-next-title", style: S.bigTitle }, step.title),
      step.body ? h("p", { id: "bkl-next-body", style: S.text }, step.body) : null,
      step.snippet ? h("pre", { style: S.codeBlock }, step.snippet) : null,
      step.primary || step.secondary
        ? h("div", { style: S.row },
          step.primary
            ? h(Button, { kind: "primary", off: busy, reason: T.whyBusy, describedBy: "bkl-next-body", onClick: () => { onRun(step.primary.action) } }, step.primary.label)
            : null,
          step.secondary
            ? h(Button, { kind: step.primary ? "quiet" : "plain", onClick: () => { onRun(step.secondary.action) } }, step.secondary.label)
            : null)
        : null,
      notice ?? null)
  }

  function StepList({ items, onGo }) {
    return h("ol", { style: S.steps },
      items.map((item, index) => {
        const color = TONE_COLOR[STEP_TONE[item.state]] ?? tk.line4
        return h("li", { key: item.key },
          h("button", {
            type: "button",
            className: "bkl-hover",
            style: S.step,
            "aria-label": `${item.title}${T.sep}${item.value} (${T.stepState(item.state)})`,
            "aria-describedby": `bkl-step-${item.key}-desc`,
            onClick: () => { onGo(item.tab) },
          },
            h("span", { style: merge(S.stepMark, { border: `1px solid ${color}`, color }), "aria-hidden": "true" },
              item.state === "done" ? "\u2713" : item.state === "error" ? "!" : String(index + 1)),
            h("span", { style: S.stepBody },
              h("span", { style: S.stepTitleRow },
                h("span", { style: S.strong }, item.title),
                h("span", { style: merge(S.small, { color: item.state === "error" ? tk.error : tk.label3 }) }, item.value)),
              h("span", { id: `bkl-step-${item.key}-desc`, style: S.small }, item.desc)),
            h("span", { style: S.stepChevron, "aria-hidden": "true" }, "\u203a")))
      }))
  }

  function OverviewPage({ f, status, override, step, busy, enabledPending, restart, onRun, onGo, onToggleEnabled, nextNotice, overviewNotice, restartView }) {
    const target = status?.target ?? {}
    const rootHint = status?.hostRoot ? `${T.rootSource(status.hostRootSource)}${T.sep}${String(status.hostRoot)}` : T.rootMissingShort
    let preValue = T.unknown
    let preTone = "idle"
    if (f.rootMissing) { preValue = T.preNoRoot; preTone = "warn" } else if (f.broken) { preValue = T.preBroken; preTone = "error" } else if (f.blocked.length > 0) { preValue = T.preBlocked(f.blocked.length); preTone = "error" } else if (f.preCode === "ok") { preValue = T.preOk(f.pendingFiles); preTone = f.pendingFiles > 0 ? "accent" : "ok" }
    const activeRule = f.activeRule === null ? null : f.rules.find(rule => rule.id === f.activeRule)
    const rulesValue = f.rules.length === 0
      ? T.rulesNone
      : f.activeRule === null ? T.rulesInactive(f.rules.length) : T.rulesActive(f.rules.length, activeRule?.name ?? f.activeRule)
    const takeoverOn = status?.enabled === true
    const warnings = Array.isArray(status?.permission?.warnings) ? status.permission.warnings : []
    const injectBad = status?.inject && status.inject.ok === false

    return h("div", { style: S.panel },
      restart === null ? h(NextStepCard, { step, busy, onRun, notice: nextNotice }) : restartView,
      h(Card, { title: T.stepsTitle, titleId: "bkl-steps-title", desc: T.stepsDesc },
        h(StepList, { items: stepItems(f), onGo })),
      h(Card, { title: T.statusTitle, titleId: "bkl-status-title", desc: T.statusDesc },
        h(Rows, {
          items: [
            {
              id: "host", label: T.rowHost, mono: Boolean(status?.hostRoot),
              value: `${String(target.version ?? T.unknown)}${target.commit ? ` · ${String(target.commit).slice(0, 10)}` : ""}`,
              hint: rootHint, tone: f.rootMissing ? "warn" : undefined,
            },
            { id: "mode", label: T.rowMode, value: modeLabel(f.mode), hint: T.rowModeHint },
            {
              id: "sandbox", label: T.rowSandbox, value: String(status?.mode ?? T.unknown),
              hint: status?.mode === "danger-full-access" ? T.sandboxTakeover : T.sandboxHost,
            },
            { id: "preflight", label: T.rowPreflight, value: preValue, tone: preTone, hint: T.preHint },
            f.applied === null
              ? { id: "applied", label: T.rowApplied, value: T.appliedNone }
              : {
                id: "applied", label: T.rowApplied, mono: true,
                value: T.appliedValue(f.applied.files ?? 0, formatTime(f.applied.updatedAt)),
                hint: T.opId(String(f.applied.operationId ?? T.unknown)),
              },
            { id: "rules", label: T.rowRules, value: rulesValue, tone: f.activeRule === null ? undefined : "ok" },
            {
              id: "prompt", label: T.rowPrompt,
              value: f.customPrompt ? T.promptMine(formatBytes(override?.bytes)) : T.promptBuiltin,
              tone: injectBad ? "warn" : undefined,
              hint: injectBad ? T.injectBad(status.inject.code) : undefined,
            },
            {
              id: "takeover", label: T.rowTakeover, value: T.takeoverState(takeoverOn), hint: T.takeoverHint,
              control: h(Switch, {
                on: takeoverOn,
                off: busy || enabledPending,
                label: T.takeoverLabel,
                describedBy: "bkl-row-takeover-hint",
                onToggle: onToggleEnabled,
              }),
            },
          ],
        }),
        overviewNotice ?? null),
      warnings.length === 0
        ? null
        : h("section", { role: "note", style: merge(S.banner, { background: tk.warnSoft }) },
          h("div", { style: S.bannerHead }, h(Dot, { tone: "warn" }), h("h3", { style: S.bannerTitle }, T.warnTitle)),
          h("ul", { style: S.ol },
            warnings.map((warning, index) => h("li", { key: `w${String(index)}` },
              warning?.code === "preset_approval_never"
                ? T.warnPresetNever(warning.preset ?? "")
                : warning?.code === "default_policy_never" ? T.warnPolicyNever : T.warnOther(warning?.code ?? "")))),
          h("p", { style: S.small }, T.warnNext)))
  }

  // ---- 补丁 -----------------------------------------------------------------

  function PatchCard({ patch, f, pendingValue, busy, onToggle }) {
    const [open, setOpen] = useState(false)
    const key = safeId(patch.id)
    const on = pendingValue === undefined ? patch.enabled === true : pendingValue
    const toggling = pendingValue !== undefined
    const disk = diskState(patch, f)
    const title = pickLang(patch.titles) || String(patch.title ?? patch.id)
    const human = pickLang(patch.human)
    const note = pickLang(patch.notes)
    const targets = Array.isArray(patch.targets) ? patch.targets : []
    const files = unique(targets.map(target => String(target?.path ?? ""))).length
    return h("li", { style: S.patch },
      h("div", { style: S.patchHead },
        h("div", { style: S.patchMain },
          h("div", { style: S.row },
            h("span", { id: `bkl-p-${key}-title`, style: S.patchTitle }, title),
            h(Tag, null, patch.kind === "replace" ? T.kindReplace : T.kindVerify)),
          human ? h("p", { style: S.text }, human) : null),
        h("div", { style: S.patchSwitch },
          h(Switch, {
            on,
            off: busy || toggling,
            labelledBy: `bkl-p-${key}-title`,
            describedBy: `bkl-p-${key}-hint`,
            onToggle: (next) => { onToggle(patch.id, next) },
          }),
          h("span", { id: `bkl-p-${key}-hint`, style: S.switchHint }, toggling ? T.saving : on ? T.switchOnHint : T.switchOffHint))),
      h("div", { style: S.patchMeta },
        h("span", { style: S.metaItem }, h(Dot, { tone: DISK_TONE[disk] }), h("span", { style: { color: disk === "blocked" ? tk.error : tk.label2 } }, T.diskState(disk))),
        h("span", { "aria-hidden": "true" }, "\u00b7"),
        h("span", null, T.touchesFiles(files)),
        h("span", { style: S.spacer }),
        h(Button, {
          kind: "quiet", size: "small", expanded: open, controls: `bkl-p-${key}-detail`,
          onClick: () => { setOpen(!open) },
        }, open ? T.detailsHide : T.detailsShow)),
      !on && f.applied !== null ? h("p", { style: S.inlineNote }, T.offButWritten) : null,
      h("div", { id: `bkl-p-${key}-detail`, hidden: !open, className: open ? "bkl-fade" : undefined, style: merge(S.detail, !open && { display: "none" }) },
        note ? h("div", { style: S.detailBlock }, h("span", { style: S.fieldLabel }, T.whyLabel), h("p", { style: S.text }, note)) : null,
        targets.map((target, index) => h("div", { key: `t${String(index)}`, style: S.detailBlock },
          h("span", { style: S.targetPath }, String(target?.path ?? "")),
          typeof target?.before === "string" ? h("span", { style: S.caption }, T.before) : null,
          typeof target?.before === "string" ? h("pre", { style: S.codeBlock }, target.before) : null,
          typeof target?.after === "string" ? h("span", { style: S.caption }, T.after) : null,
          typeof target?.after === "string" ? h("pre", { style: S.codeBlock }, target.after) : null))))
  }

  function PatchesPage({ f, patchInfo, patchError, busy, toggles, confirmOpen, onToggle, onApply, onRevert, onRun, onCopy, confirmView, noticeView, restartView }) {
    const applyWhy = applyReason(f, busy, toggles)
    const revertWhy = revertReason(f, busy)
    const findingFor = (item) => f.findings.find(finding => finding?.patchId === item?.patchId && finding?.path === item?.path)
    const blockedText = f.blocked.map(item => `${String(item?.patchId ?? "")} · ${String(item?.path ?? "")} · ${String(item?.reason ?? "")}`).join("\n")

    return h("div", { style: S.panel },
      restartView ?? null,
      h(Card, { title: T.patchesTitle, titleId: "bkl-patches-title", desc: T.patchesLead },
        h("ul", { style: S.legend },
          h("li", { style: S.legendItem }, h("span", { style: S.legendKey }, T.legendSwitch), T.legendSwitchDesc),
          h("li", { style: S.legendItem }, h("span", { style: S.legendKey }, T.legendDisk), T.legendDiskDesc)),
        f.total > 0 ? h("p", { style: S.small }, T.patchesSummary(f.enabledCount, f.total, patchInfo?.files ?? 0)) : null),
      f.blocked.length === 0
        ? null
        : h("section", { role: "alert", style: merge(S.banner, { background: tk.errorSoft }) },
          h("div", { style: S.bannerHead }, h(Dot, { tone: "error" }), h("h3", { style: S.bannerTitle }, T.blockedTitle(f.blocked.length))),
          h("p", { style: S.text }, T.blockedBody),
          h(PathList, { items: f.blocked.map(item => `${String(item?.patchId ?? "")} · ${String(item?.path ?? "")} \u2014 ${T.findingState(findingFor(item)?.state)}`) }),
          h("div", { style: S.row }, h(Button, { size: "small", onClick: () => { onCopy(blockedText) } }, T.copyList))),
      f.rootMissing || f.broken
        ? h(Notice, {
          notice: { tone: f.broken ? "error" : "warn", title: f.broken ? T.nsBrokenTitle : T.nsRootTitle, next: f.broken ? T.whyBroken : T.whyNoRoot, action: "goOverview" },
          onAction: onRun,
        })
        : null,
      f.total === 0
        ? h(Empty, {
          title: T.patchesEmptyTitle,
          body: patchError ? `${patchError.title}${T.sep}${patchError.next}` : undefined,
          action: h(Button, { kind: "primary", onClick: () => { onRun("retry") } }, T.retry),
        })
        : h("ul", { style: S.list, "aria-labelledby": "bkl-patches-title" },
          f.patches.map(patch => h(PatchCard, { key: patch.id, patch, f, pendingValue: toggles[patch.id], busy, onToggle }))),
      h("div", { style: S.actionBar },
        confirmView ?? null,
        noticeView ?? null,
        confirmOpen
          ? null
          : h("div", { style: S.row },
            h(Button, { kind: "primary", off: applyWhy !== null, reason: applyWhy, describedBy: "bkl-apply-why", onClick: onApply },
              f.pendingFiles > 0 ? T.applyN(f.pendingFiles) : T.apply),
            h(Button, { kind: "quietDanger", off: revertWhy !== null, reason: revertWhy, describedBy: "bkl-revert-why", onClick: onRevert }, T.revert)),
        confirmOpen ? null : h("p", { id: "bkl-apply-why", style: S.small }, applyWhy ?? T.applyHint),
        confirmOpen ? null : h("p", { id: "bkl-revert-why", style: S.small }, revertWhy ?? T.revertHint(f.applied?.files ?? 0))))
  }

  // ---- 提示词与规则 ---------------------------------------------------------

  function ModeBlock({ mode, pendingMode, onPick, confirmView, noticeView }) {
    const options = MODES.map(id => {
      const recommended = id === "recommended"
      return {
        id,
        descId: `bkl-mode-${id}-desc`,
        title: modeLabel(id),
        tags: [
          recommended ? h(Tag, { key: "d" }, T.tagDefault) : null,
          id === mode ? h(Tag, { key: "c", tone: "ok" }, T.tagCurrent) : null,
          id === pendingMode ? h(Tag, { key: "p", tone: "accent" }, T.tagPending) : null,
        ],
        body: h("span", { id: `bkl-mode-${id}-desc`, style: { display: "flex", flexDirection: "column", gap: "2px" } },
          h("span", { style: S.text }, recommended ? T.modeRecFit : T.modeUnrFit),
          h("span", { style: S.small }, recommended ? T.modeRecChange : T.modeUnrChange)),
      }
    })
    return h(Card, { title: T.modeTitle, titleId: "bkl-mode-title", desc: T.modeDesc },
      h(RadioCards, { group: "mode", labelledBy: "bkl-mode-title", options, value: mode, onSelect: onPick }),
      confirmView ?? null,
      noticeView ?? null)
  }

  function PromptBlock({ override, draft, setDraft, busy, onSave, onReset, onCopy, confirmView, noticeView }) {
    const saved = typeof override?.text === "string" ? override.text : ""
    const value = draft ?? saved
    const dirty = draft !== null && draft !== saved
    const mine = override?.userFileExists === true
    const effectiveBad = override?.effective && override.effective.ok === false
    const saveWhy = busy ? T.whyBusy : !dirty ? T.whyNoChange : value.trim() === "" ? T.whyEmptyPrompt : null
    const resetWhy = busy ? T.whyBusy : !mine ? T.whyAlreadyBuiltin : null
    return h(Card, {
      title: T.promptTitle,
      titleId: "bkl-prompt-title",
      desc: T.promptDesc,
      descId: "bkl-prompt-desc",
      aside: h(Tag, { tone: mine ? "accent" : undefined }, mine ? T.promptUsingMine(formatBytes(override?.bytes)) : T.promptUsingBuiltin),
    },
      effectiveBad
        ? h(Notice, { notice: { tone: "warn", title: T.injectBad(override.effective.code), next: T.injectBadNext } })
        : null,
      h("textarea", {
        className: "bkl-input",
        style: merge(S.input, S.textarea),
        value,
        placeholder: T.promptPlaceholder,
        spellCheck: false,
        "aria-labelledby": "bkl-prompt-title",
        "aria-describedby": "bkl-prompt-desc bkl-prompt-why",
        onChange: (event) => { setDraft(event.target.value) },
      }),
      h("div", { style: S.row },
        h("span", { style: S.caption }, T.promptCount(value.length, formatBytes(utf8Length(value)))),
        dirty ? h(Tag, { tone: "warn" }, T.promptDirty) : null,
        h("span", { style: S.spacer }),
        dirty ? h(Button, { kind: "quiet", size: "small", onClick: () => { setDraft(null) } }, T.discard) : null,
        h(Button, { kind: "quiet", size: "small", onClick: () => { onCopy(value) } }, T.copyAll),
        h(Button, { kind: "quietDanger", size: "small", off: resetWhy !== null, reason: resetWhy, onClick: onReset }, T.resetBuiltin),
        h(Button, { kind: dirty ? "primary" : "plain", off: saveWhy !== null, reason: saveWhy, describedBy: "bkl-prompt-why", onClick: onSave }, T.save)),
      h("p", { id: "bkl-prompt-why", style: S.small }, saveWhy ?? T.saveHint),
      confirmView ?? null,
      noticeView ?? null)
  }

  function isRuleEditDirty(edit) {
    if (edit === null || typeof edit !== "object") return false
    const b = edit.baseline
    if (!b) return edit.text.trim() !== "" || edit.name.trim() !== "" || (edit.isNew && edit.id.trim() !== "")
    return edit.text !== b.text || edit.name !== b.name || edit.target !== b.target || (edit.isNew && edit.id !== b.id)
  }

  function RuleEditor({ edit, rules, activeRule, busy, onChange, onSave, onCancel, onOpenExisting }) {
    const idValid = RULE_ID_RE.test(edit.id)
    const idError = edit.isNew && edit.id !== "" && !idValid ? T.ruleIdBad : null
    const idTaken = edit.isNew && idValid && rules.some(rule => rule.id === edit.id)
    const editingActive = !edit.isNew && activeRule === edit.id
    const saveWhy = busy ? T.whyBusy : edit.id === "" ? T.whyNeedId : !idValid ? T.whyBadId : edit.text.trim() === "" ? T.whyNeedText : null
    const set = (patch) => { onChange({ ...edit, ...patch }) }
    const targetOptions = RULE_TARGETS.map(target => ({
      id: target,
      descId: `bkl-rule-target-${safeId(target)}-desc`,
      title: target,
      body: h("span", { id: `bkl-rule-target-${safeId(target)}-desc`, style: S.small }, target === "AGENTS.md" ? T.targetAgents : T.targetClaude),
    }))
    return h("div", { className: "bkl-fade", style: S.editor, role: "group", "aria-labelledby": "bkl-rule-editor-title" },
      h("h4", { id: "bkl-rule-editor-title", style: S.cardTitle }, edit.isNew ? T.editorNewTitle : T.editorEditTitle(edit.name || edit.id)),
      h("div", { style: S.fieldGrid },
        h("div", { style: S.field },
          h("label", { htmlFor: "bkl-rule-id", style: S.fieldLabel }, T.fieldId),
          h("input", {
            id: "bkl-rule-id",
            className: "bkl-input",
            style: merge(S.input, S.mono, !edit.isNew && S.inputLocked),
            value: edit.id,
            readOnly: !edit.isNew,
            spellCheck: false,
            autoComplete: "off",
            "aria-invalid": idError ? "true" : undefined,
            "aria-describedby": "bkl-rule-id-hint",
            onChange: (event) => { set({ id: event.target.value.trim() }) },
          }),
          h("p", { id: "bkl-rule-id-hint", role: idError ? "alert" : undefined, style: idError ? S.fieldError : S.small },
            idError ?? (edit.isNew ? T.fieldIdHint : T.fieldIdLocked)),
          idTaken
            ? h("div", { style: merge(S.row, { marginTop: "4px" }) },
                h("p", { style: merge(S.fieldWarn, { margin: 0 }) }, T.ruleIdTaken),
                onOpenExisting
                  ? h(Button, { kind: "quiet", size: "small", onClick: () => { onOpenExisting(edit.id) } }, T.openExistingRule)
                  : null)
            : null),
        h("div", { style: S.field },
          h("label", { htmlFor: "bkl-rule-name", style: S.fieldLabel }, T.fieldName),
          h("input", {
            id: "bkl-rule-name",
            className: "bkl-input",
            style: S.input,
            value: edit.name,
            autoComplete: "off",
            "aria-describedby": "bkl-rule-name-hint",
            onChange: (event) => { set({ name: event.target.value }) },
          }),
          h("p", { id: "bkl-rule-name-hint", style: S.small }, T.fieldNameHint))),
      h("div", { style: S.field },
        h("span", { id: "bkl-rule-target-label", style: S.fieldLabel }, T.fieldTarget),
        h(RadioCards, { group: "rule-target", labelledBy: "bkl-rule-target-label", options: targetOptions, value: edit.target, compact: true, onSelect: (target) => { set({ target }) } })),
      h("div", { style: S.field },
        h("label", { htmlFor: "bkl-rule-text", style: S.fieldLabel }, T.fieldText),
        h("textarea", {
          id: "bkl-rule-text",
          className: "bkl-input",
          style: merge(S.input, S.textarea, { minHeight: "140px" }),
          value: edit.text,
          spellCheck: false,
          "aria-describedby": "bkl-rule-text-hint",
          onChange: (event) => { set({ text: event.target.value }) },
        }),
        h("p", { id: "bkl-rule-text-hint", style: S.small }, T.fieldTextHint)),
      editingActive ? h("p", { style: S.inlineNote }, T.ruleActiveEditing(edit.target)) : null,
      h("div", { style: S.row },
        h(Button, { kind: "primary", off: saveWhy !== null, reason: saveWhy, describedBy: "bkl-rule-save-why", onClick: onSave }, T.saveRule),
        h(Button, { kind: "quiet", onClick: onCancel }, T.cancel)),
      saveWhy ? h("p", { id: "bkl-rule-save-why", style: S.small }, saveWhy) : null)
  }

  function RulesBlock({ rules, activeRule, rulesIndex, rulesIndexPath, edit, busy, onNew, onEdit, onEditChange, onSave, onCancelEdit, onActivate, onDeactivate, onDelete, onRecover, confirmView, noticeView }) {
    const isCorrupt = rulesIndex === "corrupt"
    const newWhy = busy ? T.whyBusy : isCorrupt ? T.whyRulesCorrupt : null
    return h(Card, {
      title: T.rulesTitle,
      titleId: "bkl-rules-title",
      desc: T.rulesDesc,
      aside: rules.length === 0
        ? null
        : h("div", { style: S.row },
          h(Tag, null, T.rulesCount(rules.length)),
          edit === null ? h(Button, { size: "small", off: newWhy !== null, reason: newWhy, onClick: onNew }, T.newRule) : null),
    },
      isCorrupt
        ? h(Notice, {
          notice: {
            tone: "error",
            title: T.nsRulesCorruptTitle,
            next: T.rulesCorruptNotice(rulesIndexPath),
            action: "recoverRules",
          },
          onAction: onRecover,
        })
        : null,
      // 清单读不出来时列表必然是空的，但「还没有规则」不成立：那是真的没有，
      // 这里是读不到。两条提示同时出现，用户会以为新建一条就能修好。
      rules.length === 0 && edit === null && !isCorrupt
        ? h(Empty, {
          title: T.rulesEmptyTitle,
          body: T.rulesEmptyBody,
          action: h(Button, { kind: "primary", off: newWhy !== null, reason: newWhy, onClick: onNew }, T.newFirstRule),
        })
        : null,
      rules.length === 0
        ? null
        : h("ul", { style: S.rows, "aria-labelledby": "bkl-rules-title" },
          rules.map((rule, index) => {
            const label = rule.name || rule.id
            const active = rule.id === activeRule
            return h("li", { key: rule.id, style: merge(S.ruleRow, index === 0 && S.ruleRowFirst) },
              h("div", { style: S.ruleMain },
                h("div", { style: S.row },
                  h(Dot, { tone: active ? "ok" : "idle" }),
                  h("span", { style: S.strong }, label),
                  label !== rule.id ? h("span", { style: S.code }, rule.id) : null,
                  active ? h(Tag, { tone: "ok" }, T.ruleActiveTag) : null),
                h("p", { style: S.small }, T.ruleMeta(rule.target, formatBytes(rule.bytes)))),
              h("div", { style: S.ruleActions },
                h(Button, { kind: "quiet", size: "small", off: busy, reason: T.whyBusy, label: T.editRule(label), onClick: () => { onEdit(rule.id) } }, T.edit),
                active
                  ? h(Button, { size: "small", off: busy, reason: T.whyBusy, label: T.deactivateRule(label), onClick: () => { onDeactivate(rule) } }, T.deactivate)
                  : h(Button, { size: "small", off: busy, reason: T.whyBusy, label: T.activateRule(label), onClick: () => { onActivate(rule) } }, T.activate),
                h(Button, { kind: "quietDanger", size: "small", off: busy, reason: T.whyBusy, label: T.deleteRule(label), onClick: () => { onDelete(rule) } }, T.del)))
          })),
      confirmView ?? null,
      noticeView ?? null,
      edit === null ? null : h(RuleEditor, { edit, rules, activeRule, busy, onChange: onEditChange, onSave, onCancel: onCancelEdit, onOpenExisting: onEdit }))
  }

  function ContextPage(props) {
    return h("div", { style: S.panel },
      props.restartView ?? null,
      h(ModeBlock, props.mode),
      h(PromptBlock, props.prompt),
      h(RulesBlock, props.rules))
  }

  // ---- 分区根 ---------------------------------------------------------------

  function Section() {
    const [tab, setTab] = useState(TAB_KEYS[0])
    const [status, setStatus] = useState(null)
    const [loadError, setLoadError] = useState(null)
    const [patchInfo, setPatchInfo] = useState(null)
    const [patchError, setPatchError] = useState(null)
    const [override, setOverride] = useState(null)
    const [tierInfo, setTierInfo] = useState(null)
    const [loadedAt, setLoadedAt] = useState(0)
    const [busy, setBusy] = useState(false)
    const [toggles, setToggles] = useState({})
    const [enabledPending, setEnabledPending] = useState(false)
    const [confirm, setConfirm] = useState(null)
    const [notices, setNotices] = useState({})
    const [restart, setRestart] = useState(null)
    const [draft, setDraft] = useState(null)
    const [ruleEdit, setRuleEdit] = useState(null)
    const [, bump] = useState(0)
    const mounted = useRef(true)
    const noticeTimers = useRef({})

    useEffect(() => {
      mounted.current = true
      return () => {
        mounted.current = false
        for (const timer of Object.values(noticeTimers.current)) clearTimeout(timer)
      }
    }, [])

    // 作用域样式只注入一次；多个实例共用同一个 id。
    useEffect(() => {
      if (typeof document === "undefined" || !document.head || document.getElementById(STYLE_ID)) return
      const element = document.createElement("style")
      element.id = STYLE_ID
      element.textContent = SCOPED_CSS
      document.head.appendChild(element)
    }, [])

    useEffect(() => {
      if (refreshText()) bump(value => value + 1)
      if (typeof MutationObserver !== "function" || typeof document === "undefined" || !document.documentElement) return undefined
      const observer = new MutationObserver(() => { if (refreshText()) bump(value => value + 1) })
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] })
      return () => { observer.disconnect() }
    }, [])

    // 让「更新于 N 分钟前」走动。
    useEffect(() => {
      const timer = setInterval(() => { bump(value => value + 1) }, CLOCK_MS)
      return () => { clearInterval(timer) }
    }, [])

    // 页面卸载或刷新时拦截未保存草稿。
    useEffect(() => {
      if (typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined
      const onBeforeUnload = (event) => {
        const ruleDirty = isRuleEditDirty(ruleEdit)
        const promptDirty = draft !== null && draft !== (typeof override?.text === "string" ? override.text : "")
        if (ruleDirty || promptDirty) {
          event.preventDefault()
          event.returnValue = ""
        }
      }
      window.addEventListener("beforeunload", onBeforeUnload)
      return () => { window.removeEventListener("beforeunload", onBeforeUnload) }
    }, [ruleEdit, draft, override])

    const clearNotice = useCallback((scope) => {
      const timer = noticeTimers.current[scope]
      if (timer !== undefined) {
        clearTimeout(timer)
        delete noticeTimers.current[scope]
      }
      setNotices(prev => {
        if (prev[scope] === undefined) return prev
        const next = { ...prev }
        delete next[scope]
        return next
      })
    }, [])

    const notify = useCallback((scope, notice) => {
      const timer = noticeTimers.current[scope]
      if (timer !== undefined) clearTimeout(timer)
      delete noticeTimers.current[scope]
      setNotices(prev => ({ ...prev, [scope]: notice }))
      if (notice.tone === "ok" || notice.tone === "info") {
        noticeTimers.current[scope] = setTimeout(() => {
          delete noticeTimers.current[scope]
          if (mounted.current) setNotices(prev => (prev[scope] === notice ? { ...prev, [scope]: undefined } : prev))
        }, NOTICE_OK_MS)
      }
    }, [])

    const load = useCallback(async () => {
      const [statusResult, patchResult, overrideResult, tierResult] = await Promise.allSettled([
        get("/status"), get("/patches"), get("/override"), get("/tier"),
      ])
      if (!mounted.current) return
      if (statusResult.status === "fulfilled") {
        setStatus(statusResult.value.data ?? null)
        setLoadError(null)
      } else {
        setLoadError(explain(statusResult.reason))
      }
      if (patchResult.status === "fulfilled") {
        setPatchInfo(patchResult.value.data ?? null)
        setPatchError(null)
      } else {
        setPatchError(explain(patchResult.reason))
      }
      if (overrideResult.status === "fulfilled") setOverride(overrideResult.value.data ?? null)
      if (tierResult.status === "fulfilled") setTierInfo(tierResult.value.data ?? null)
      setLoadedAt(Date.now())
    }, [])

    useEffect(() => { void load() }, [load])

    // 浮窗改了档位或词表，这里那份状态就旧了。两个挂载点各持一份 state，
    // 用事件而不是共享 store：只需要「重新拉一次」，不需要新的全局状态层。
    useEffect(() => {
      if (typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined
      const onStateChanged = () => { void load() }
      window.addEventListener(STATE_CHANGED_EVENT, onStateChanged)
      return () => { window.removeEventListener(STATE_CHANGED_EVENT, onStateChanged) }
    }, [load])

    /** 写操作的统一外壳：同一时刻只跑一个；失败就近报错；reload 为真时无论成败都重新拉状态。 */
    const run = useCallback(async (scope, work, reload) => {
      setBusy(true)
      clearNotice(scope)
      try {
        await work()
      } catch (error) {
        if (mounted.current) notify(scope, explain(error))
      } finally {
        if (reload) await load().catch(() => {})
        if (mounted.current) setBusy(false)
      }
    }, [clearNotice, notify, load])

    const copy = useCallback(async (text, scope) => {
      const ok = await writeClipboard(text)
      if (!mounted.current) return
      notify(scope, ok ? { tone: "ok", title: T.copied } : { tone: "warn", title: T.copyFailed, next: T.copyFailedNext })
    }, [notify])

    const goTab = useCallback((key) => {
      setTab(key)
      setConfirm(null)
    }, [])

    const accept = useCallback(() => {
      const current = confirm
      setConfirm(null)
      if (current !== null) void current.run()
    }, [confirm])

    // ---- 重启 ----

    const fetchRestartCommand = useCallback(async () => {
      try {
        const payload = await post("/restart", {})
        const command = typeof payload.data?.command === "string" && payload.data.command !== "" ? payload.data.command : null
        if (mounted.current) setRestart(prev => (prev === null ? prev : { ...prev, command }))
        return command
      } catch {
        if (mounted.current) setRestart(prev => (prev === null ? prev : { ...prev, command: null }))
        return null
      }
    }, [])

    const startRestart = useCallback((kind, count) => {
      setRestart({ kind, count, command: undefined, open: false })
      void fetchRestartCommand()
    }, [fetchRestartCommand])

    const copyRestart = useCallback(async () => {
      const command = typeof restart?.command === "string" ? restart.command : await fetchRestartCommand()
      if (command === null) {
        notify("restart", { tone: "warn", title: T.restartNoCommand })
        return
      }
      await copy(command, "restart")
    }, [restart, fetchRestartCommand, notify, copy])

    // ---- 动作 ----

    const runAction = useCallback((action) => {
      if (action === "retry" || action === "refresh") void load()
      else if (action === "goPatches") goTab("patches")
      else if (action === "goContext") goTab("context")
      else if (action === "goOverview") goTab("overview")
      else if (action === "copyRoot") void copy(T.nsRootSnippet, "next")
      else if (action === "copyRestart") void copyRestart()
      else if (action === "recoverRules") askRecoverRules("next")
    }, [load, goTab, copy, copyRestart])

    const togglePatch = useCallback(async (id, next) => {
      setToggles(prev => ({ ...prev, [id]: next }))
      clearNotice("patches")
      try {
        await post("/patches/enabled", { id, enabled: next })
        await load()
      } catch (error) {
        if (mounted.current) notify("patches", explain(error))
      } finally {
        if (mounted.current) {
          setToggles(prev => {
            const copyOf = { ...prev }
            delete copyOf[id]
            return copyOf
          })
        }
      }
    }, [clearNotice, notify, load])

    const toggleEnabled = useCallback(async (next) => {
      setEnabledPending(true)
      clearNotice("overview")
      try {
        await post("/enabled", { enabled: next })
        await load()
        if (mounted.current) notify("overview", { tone: "ok", title: T.doneTakeover(next) })
      } catch (error) {
        if (mounted.current) notify("overview", explain(error))
      } finally {
        if (mounted.current) setEnabledPending(false)
      }
    }, [clearNotice, notify, load])

    const f = derive(status, patchInfo, tierInfo, override, restart)

    const askApply = () => {
      setConfirm({
        scope: "patches",
        title: T.confirmApplyTitle(f.pendingFiles),
        body: T.confirmApplyBody,
        items: f.pendingPaths,
        yes: T.confirmApplyYes(f.pendingFiles),
        run: () => run("patches", async () => {
          const payload = await post("/apply", {})
          const written = Array.isArray(payload.data?.written) ? payload.data.written.length : 0
          if (written === 0) {
            notify("patches", { tone: "info", title: T.doneAlready })
            return
          }
          notify("patches", { tone: "ok", title: T.doneApplied(written), next: T.doneAppliedNext })
          startRestart("apply", written)
        }, true),
      })
    }

    const askRevert = () => {
      const count = Number(f.applied?.files) || 0
      setConfirm({
        scope: "patches",
        tone: "danger",
        title: T.confirmRevertTitle(count),
        body: T.confirmRevertBody,
        yes: T.confirmRevertYes(count),
        run: () => run("patches", async () => {
          const payload = await post("/revert", {})
          const restored = Array.isArray(payload.data?.restored) ? payload.data.restored.length : 0
          if (restored === 0) {
            notify("patches", { tone: "info", title: T.doneRevertNothing })
            return
          }
          notify("patches", { tone: "ok", title: T.doneReverted(restored), next: T.doneAppliedNext })
          startRestart("revert", restored)
        }, true),
      })
    }

    const pickMode = (id) => {
      if (id === f.mode) {
        if (confirm?.scope === "mode") setConfirm(null)
        return
      }
      const label = modeLabel(id)
      setConfirm({
        scope: "mode",
        pick: id,
        title: T.confirmModeTitle(label),
        body: T.confirmModeBody,
        yes: T.confirmModeYes,
        run: () => run("mode", async () => {
          await post("/tier", { tier: id })
          notify("mode", { tone: "ok", title: T.doneMode(label), next: T.doneModeNext })
        }, true),
      })
    }

    const savePrompt = () => {
      if (draft === null) return
      const text = draft
      void run("prompt", async () => {
        const payload = await post("/override", { text })
        await load()
        if (!mounted.current) return
        setDraft(null)
        notify("prompt", { tone: "ok", title: T.donePromptSaved(formatBytes(payload.data?.bytes)), next: T.saveHint })
      })
    }

    const askResetPrompt = () => {
      setConfirm({
        scope: "prompt",
        tone: "danger",
        title: T.confirmResetTitle,
        body: T.confirmResetBody(formatBytes(override?.bytes)),
        yes: T.confirmResetYes,
        run: () => run("prompt", async () => {
          await post("/override", { text: "" })
          await load()
          if (!mounted.current) return
          setDraft(null)
          notify("prompt", { tone: "ok", title: T.donePromptReset })
        }),
      })
    }

    const ruleLabel = (id) => {
      const found = f.rules.find(rule => rule.id === id)
      return found?.name || id
    }

    const guardDirtyRule = (onProceed) => {
      if (isRuleEditDirty(ruleEdit)) {
        setConfirm({
          scope: "rules",
          tone: "danger",
          title: T.confirmDiscardRuleTitle,
          body: T.confirmDiscardRuleBody,
          yes: T.confirmDiscardYes,
          run: () => {
            setConfirm(null)
            onProceed()
          },
        })
        return
      }
      onProceed()
    }

    const doNewRule = () => {
      clearNotice("rules")
      setConfirm(null)
      const empty = { isNew: true, id: "", name: "", target: RULE_TARGETS[0], text: "" }
      setRuleEdit({ ...empty, baseline: empty })
    }

    const newRule = () => {
      guardDirtyRule(doNewRule)
    }

    const doEditRule = (id) => {
      setConfirm(null)
      void run("rules", async () => {
        const payload = await get(`/rules/read?id=${encodeURIComponent(id)}`)
        if (!mounted.current) return
        const initial = {
          isNew: false,
          id,
          name: typeof payload.data?.name === "string" && payload.data.name !== id ? payload.data.name : "",
          target: RULE_TARGETS.includes(payload.data?.target) ? payload.data.target : RULE_TARGETS[0],
          text: typeof payload.data?.text === "string" ? payload.data.text : "",
        }
        setRuleEdit({ ...initial, baseline: initial })
      })
    }

    const editRule = (id) => {
      if (ruleEdit !== null && !ruleEdit.isNew && ruleEdit.id === id) return
      guardDirtyRule(() => { doEditRule(id) })
    }

    const cancelEdit = () => {
      guardDirtyRule(() => { setRuleEdit(null) })
    }

    const doSaveRule = (edit) => {
      void run("rules", async () => {
        const payload = await post("/rules/save", { id: edit.id, name: edit.name.trim() || edit.id, target: edit.target, text: edit.text })
        const data = payload.data ?? {}
        const target = String(data.target ?? edit.target)
        let notice = { tone: "ok", title: T.ruleSaved }
        if (data.landingMoved) notice = { tone: "ok", title: T.ruleSavedMoved(target) }
        else if (data.landingSynced) notice = { tone: "ok", title: T.ruleSavedSynced(target) }
        else if (data.landingStale) notice = { tone: "warn", title: T.ruleSavedStale(target) }
        else if (f.activeRule !== edit.id) notice = { tone: "ok", title: T.ruleSavedInactive, next: T.ruleSavedInactiveNext }
        if (mounted.current) {
          setRuleEdit(null)
          notify("rules", notice)
        }
      }, true)
    }

    const saveRule = () => {
      if (ruleEdit === null) return
      const edit = ruleEdit
      const idTaken = edit.isNew && f.rules.some(rule => rule.id === edit.id)
      if (idTaken) {
        setConfirm({
          scope: "rules",
          tone: "danger",
          title: T.confirmOverwriteRuleTitle(edit.id),
          body: T.confirmOverwriteRuleBody,
          yes: T.confirmOverwriteRuleYes,
          run: () => {
            setConfirm(null)
            doSaveRule(edit)
          },
        })
        return
      }
      doSaveRule(edit)
    }

    const askActivate = (rule) => {
      const label = rule.name || rule.id
      const other = f.activeRule !== null && f.activeRule !== rule.id ? ruleLabel(f.activeRule) : null
      setConfirm({
        scope: "rules",
        title: T.confirmActivateTitle(label),
        body: T.confirmActivateBody(rule.target, formatBytes(rule.bytes)),
        foot: other === null ? null : T.confirmActivateSwap(other),
        yes: T.confirmActivateYes,
        run: () => run("rules", async () => {
          const payload = await post("/rules/activate", { id: rule.id })
          const skipped = payload.data?.previousLanding?.skipped
          notify("rules", {
            tone: "ok",
            title: T.doneActivated(label, String(payload.data?.target ?? rule.target)),
            next: Array.isArray(skipped) && skipped.length > 0 ? T.landingSkipped(skipped.length) : T.doneActivatedNext,
          })
        }, true),
      })
    }

    const askDeactivate = (rule) => {
      const label = rule.name || rule.id
      setConfirm({
        scope: "rules",
        title: T.confirmDeactivateTitle(label),
        body: T.confirmDeactivateBody(rule.target),
        yes: T.confirmDeactivateYes,
        run: () => run("rules", async () => {
          const payload = await post("/rules/activate", { id: "" })
          const data = payload.data ?? {}
          const skipped = Array.isArray(data.skipped) ? data.skipped.length : 0
          notify("rules", {
            tone: skipped > 0 ? "warn" : "ok",
            title: T.doneDeactivated,
            next: skipped > 0 ? T.landingSkipped(skipped) : data.restored ? T.landingRestored(rule.target) : data.removed ? T.landingRemoved(rule.target) : undefined,
          })
        }, true),
      })
    }

    const askDelete = (rule) => {
      const label = rule.name || rule.id
      const active = rule.id === f.activeRule
      setConfirm({
        scope: "rules",
        tone: "danger",
        title: T.confirmDeleteTitle(label),
        body: active ? T.confirmDeleteActiveBody(rule.target) : T.confirmDeleteBody,
        yes: T.confirmDeleteYes,
        run: () => run("rules", async () => {
          await post("/rules/delete", { id: rule.id })
          if (!mounted.current) return
          setRuleEdit(prev => (prev !== null && prev.id === rule.id ? null : prev))
          notify("rules", { tone: "ok", title: T.doneDeleted(label) })
        }, true),
      })
    }

    const askRecoverRules = (scope = "next") => {
      setConfirm({
        scope,
        tone: "danger",
        title: T.confirmRecoverRulesTitle,
        body: T.confirmRecoverRulesBody,
        yes: T.confirmRecoverRulesYes,
        run: () => run(scope, async () => {
          const payload = await post("/rules/recover-corrupt", {})
          const backupPath = payload.data?.backupPath ?? "dsh-breaklimit-backup"
          notify(scope, {
            tone: "ok",
            title: T.doneRecoverRules,
            next: T.doneRecoverRulesNext(backupPath),
          })
          await load()
        }, true),
      })
    }

    // ---- 渲染 ----

    const confirmFor = (scope) => (confirm !== null && confirm.scope === scope
      ? h(ConfirmStrip, { key: confirm.title, confirm, busy, onAccept: accept, onCancel: () => { setConfirm(null) } })
      : null)
    const noticeFor = (scope) => (notices[scope]
      ? h(Notice, { notice: notices[scope], onAction: runAction, onDismiss: () => { clearNotice(scope) } })
      : null)

    const restartView = restart === null
      ? null
      : h(RestartBanner, {
        restart,
        notice: noticeFor("restart"),
        onCopy: () => { void copyRestart() },
        onToggleHow: () => { setRestart(prev => (prev === null ? prev : { ...prev, open: !prev.open })) },
        onDismiss: () => { setRestart(null); clearNotice("restart") },
      })

    const onTabKey = (event, index) => {
      let next = -1
      if (event.key === "ArrowRight") next = (index + 1) % TAB_KEYS.length
      else if (event.key === "ArrowLeft") next = (index - 1 + TAB_KEYS.length) % TAB_KEYS.length
      else if (event.key === "Home") next = 0
      else if (event.key === "End") next = TAB_KEYS.length - 1
      if (next < 0) return
      event.preventDefault()
      goTab(TAB_KEYS[next])
      const node = typeof document === "undefined" ? null : document.getElementById(`bkl-tab-${TAB_KEYS[next]}`)
      node?.focus?.()
    }

    const tabLabel = (key) => (key === "overview" ? T.tabOverview : key === "patches" ? T.tabPatches : T.tabContext)
    const tabTone = (key) => {
      if (key !== "patches" || status === null) return null
      if (f.blocked.length > 0 || f.broken) return "error"
      if (f.pendingFiles > 0) return "accent"
      return null
    }

    let body
    if (status === null) {
      body = loadError === null
        ? h(Empty, { title: T.loading, body: T.loadingHint })
        : h(Notice, { notice: { ...loadError, action: "retry" }, onAction: runAction })
    } else if (tab === "overview") {
      body = h(OverviewPage, {
        f, status, override, busy, enabledPending, restart, restartView,
        step: nextStep(f, loadError),
        nextNotice: noticeFor("next"),
        overviewNotice: noticeFor("overview"),
        onRun: runAction,
        onGo: goTab,
        onToggleEnabled: (next) => { void toggleEnabled(next) },
      })
    } else if (tab === "patches") {
      body = h(PatchesPage, {
        f, patchInfo, patchError, busy, toggles, restartView,
        confirmOpen: confirm !== null && confirm.scope === "patches",
        confirmView: confirmFor("patches"),
        noticeView: noticeFor("patches"),
        onToggle: (id, next) => { void togglePatch(id, next) },
        onApply: askApply,
        onRevert: askRevert,
        onRun: runAction,
        onCopy: (text) => { void copy(text, "patches") },
      })
    } else {
      body = h(ContextPage, {
        restartView,
        mode: {
          mode: f.mode,
          pendingMode: confirm !== null && confirm.scope === "mode" ? confirm.pick : null,
          onPick: pickMode,
          confirmView: confirmFor("mode"),
          noticeView: noticeFor("mode"),
        },
        prompt: {
          override, draft, setDraft, busy,
          onSave: savePrompt,
          onReset: askResetPrompt,
          onCopy: (text) => { void copy(text, "prompt") },
          confirmView: confirmFor("prompt"),
          noticeView: noticeFor("prompt"),
        },
        rules: {
          rules: f.rules,
          activeRule: f.activeRule,
          rulesIndex: f.rulesIndex,
          rulesIndexPath: f.rulesIndexPath,
          edit: ruleEdit,
          busy,
          onNew: newRule,
          onEdit: editRule,
          onEditChange: setRuleEdit,
          onSave: saveRule,
          onCancelEdit: cancelEdit,
          onActivate: askActivate,
          onDeactivate: askDeactivate,
          onDelete: askDelete,
          onRecover: () => { askRecoverRules("rules") },
          confirmView: confirmFor("rules"),
          noticeView: noticeFor("rules"),
        },
      })
    }

    return h("div", { className: "bkl-root", style: S.root },
      h("header", { style: S.header },
        h("div", { style: S.headText },
          h("h2", { style: S.title }, T.title),
          h("p", { style: S.lead }, T.lead)),
        h("div", { style: S.headAside },
          loadedAt > 0 ? h("span", { style: S.stamp, "aria-live": "off" }, T.refreshedAt(formatAgo(loadedAt))) : null,
          h(Button, { size: "small", off: busy, reason: T.whyBusy, onClick: () => { void load() } }, T.refresh))),
      h("div", { role: "tablist", "aria-label": T.tabsLabel, style: S.tablist },
        TAB_KEYS.map((key, index) => {
          const selected = tab === key
          const tone = tabTone(key)
          return h("button", {
            key,
            id: `bkl-tab-${key}`,
            type: "button",
            role: "tab",
            className: "bkl-tab",
            "aria-selected": selected ? "true" : "false",
            "aria-controls": `bkl-panel-${key}`,
            tabIndex: selected ? 0 : -1,
            style: merge(S.tab, selected && S.tabOn),
            onClick: () => { goTab(key) },
            onKeyDown: (event) => { onTabKey(event, index) },
          }, tabLabel(key), tone === null ? null : h(Dot, { tone }))
        })),
      h("div", { id: `bkl-panel-${tab}`, role: "tabpanel", "aria-labelledby": `bkl-tab-${tab}`, style: S.panel }, body))
  }

  // ---- 目标词表：输入框上方的常驻行 -----------------------------------------
  //
  // 位置由宿主的 `conversation.composer.dock` 提供：输入框卡片下方、全局唯一，
  // 一轮对话只出现一次，不会随消息条数堆积。
  //
  // 这一行只负责「让人找到入口」和「编辑词表」。替换发生在宿主侧的 step 之前，
  // 与这里无关，所以改完必须新开会话才生效——这条写进了面板底部。

  const ALIAS = {
    // 跟输入框卡片同宽同位置：宿主给卡片的是
    // min(卡片宽 + 2×side-clearance, 100%) 居中，这一行照抄，否则会贴到聊天区最左边。
    root: {
      position: "relative",
      display: "flex",
      alignItems: "center",
      justifyContent: "flex-start",
      width: "min(calc(var(--dsh-composer-card-max-width) + 2 * var(--dsh-composer-side-clearance)), 100%)",
      margin: "0 auto",
      padding: "0 var(--dsh-composer-side-clearance)",
      boxSizing: "border-box",
      minHeight: 26,
    },
    // 实底 + 实边：颜色全部走 tk（宿主的真实令牌名），不手写变量名。
    // 之前写成 --dsw-alias-fill / --dsw-alias-label-2 这两个名字不存在，
    // 背景和边框一起失效，看起来就是透明的。
    row: {
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      margin: 0,
      padding: "0 10px",
      height: 24,
      border: `1px solid ${tk.line2}`,
      background: tk.layer1,
      textAlign: "left",
      font: "inherit",
      fontSize: 12,
      lineHeight: "22px",
      color: tk.label2,
      borderRadius: 6,
      cursor: "pointer",
      maxWidth: 200,
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    },
    panel: {
      position: "absolute",
      left: 0,
      bottom: "calc(100% + 8px)",
      zIndex: 40,
      boxSizing: "border-box",
      width: 340,
      maxWidth: "calc(100vw - 32px)",
      padding: 16,
      display: "flex",
      flexDirection: "column",
      gap: 10,
      border: `1px solid ${tk.line2}`,
      borderRadius: 6,
      background: tk.layer1,
      color: tk.label,
      fontSize: 13,
      boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
    },
    head: { display: "flex", alignItems: "center", justifyContent: "space-between" },
    title: { margin: 0, fontSize: 13, fontWeight: 600, color: tk.label },
    subhead: { margin: 0, fontSize: 12, fontWeight: 600, color: tk.label },
    divider: { height: 1, background: tk.line1, margin: "2px 0" },
    modeRow: { display: "flex", gap: 6 },
    modeBtn: {
      flex: 1,
      padding: "4px 8px",
      border: `1px solid ${tk.line2}`,
      borderRadius: 6,
      background: tk.well,
      font: "inherit",
      fontSize: 12,
      color: tk.label2,
      cursor: "pointer",
      textAlign: "center",
    },
    modeBtnActive: {
      background: tk.layer1,
      color: tk.label,
      borderColor: tk.line3 ?? tk.line2,
      fontWeight: 600,
    },
    warnBox: {
      padding: "6px 8px",
      background: tk.well,
      border: `1px solid ${tk.line2}`,
      borderRadius: 4,
      fontSize: 12,
      color: tk.label,
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
    },
    confirmBtn: {
      marginLeft: 8,
      padding: "2px 8px",
      borderRadius: 4,
      border: `1px solid ${tk.line2}`,
      background: tk.layer1,
      color: tk.label,
      cursor: "pointer",
    },
    close: {
      width: 24,
      height: 24,
      padding: 0,
      border: "none",
      borderRadius: 6,
      background: "transparent",
      font: "inherit",
      fontSize: 14,
      lineHeight: "24px",
      color: tk.label2,
      cursor: "pointer",
    },
    desc: { margin: 0, fontSize: 12, lineHeight: "16px", color: tk.label2 },
    list: {
      margin: 0,
      padding: 0,
      listStyle: "none",
      maxHeight: 220,
      overflowY: "auto",
      border: `1px solid ${tk.line1}`,
      borderRadius: 6,
    },
    item: { display: "flex", alignItems: "center", gap: 8, padding: "0 8px", minHeight: 32 },
    itemDivider: { borderTop: `1px solid ${tk.line1}` },
    pair: {
      flex: 1,
      minWidth: 0,
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      fontSize: 13,
      color: tk.label,
    },
    arrow: { margin: "0 6px", color: tk.label2 },
    emptyItem: { padding: 10, fontSize: 12, color: tk.label2 },
    remove: {
      flexShrink: 0,
      padding: "0 6px",
      border: "none",
      borderRadius: 6,
      background: "transparent",
      font: "inherit",
      fontSize: 12,
      lineHeight: "24px",
      color: tk.label2,
      cursor: "pointer",
    },
    form: { display: "flex", gap: 8 },
    input: {
      flex: 1,
      minWidth: 0,
      boxSizing: "border-box",
      height: 30,
      padding: "0 8px",
      border: `1px solid ${tk.line2}`,
      borderRadius: 6,
      background: tk.well,
      font: "inherit",
      fontSize: 13,
      color: tk.label,
    },
    add: {
      flexShrink: 0,
      height: 30,
      padding: "0 14px",
      border: `1px solid ${tk.line2}`,
      borderRadius: 6,
      background: tk.layer1,
      font: "inherit",
      fontSize: 13,
      color: tk.label,
      cursor: "pointer",
    },
    addOff: { opacity: 0.5, cursor: "not-allowed" },
    foot: { margin: 0, fontSize: 12, color: tk.label2 },
    fail: { margin: 0, fontSize: 12, color: tk.error },
  }

  function AliasRow() {
    const [entries, setEntries] = useState([])
    const [lastHits, setLastHits] = useState(0)
    const [phase, setPhase] = useState("loading")
    const [tier, setTier] = useState("recommended")
    const [tierBusy, setTierBusy] = useState(false)
    const [tierFailed, setTierFailed] = useState(false)
    const [open, setOpen] = useState(false)
    const [fromInput, setFromInput] = useState("")
    const [toInput, setToInput] = useState("")
    const [confirmFrom, setConfirmFrom] = useState(null)
    const [deletingIndex, setDeletingIndex] = useState(null)
    const [saving, setSaving] = useState(false)
    const [saveFailed, setSaveFailed] = useState(false)
    const rootRef = useRef(null)
    const aliveRef = useRef(true)

    const load = useCallback(async () => {
      try {
        const [aliasRes, tierRes] = await Promise.all([
          get("/alias"),
          get("/tier").catch(() => null),
        ])
        if (!aliveRef.current) return
        const data = aliasRes?.data ?? {}
        setEntries(Array.isArray(data.entries) ? data.entries : [])
        setLastHits(Number(data.lastHits) || 0)
        setPhase("ready")
        if (typeof tierRes?.data?.tier === "string") {
          setTier(tierRes.data.tier)
        }
      } catch {
        if (!aliveRef.current) return
        setPhase("failed")
      }
    }, [])

    const switchTier = async (next) => {
      if (next === tier || tierBusy) return
      setTierBusy(true)
      setTierFailed(false)
      try {
        const payload = await post("/tier", { tier: next })
        if (!aliveRef.current) return
        const applied = payload?.data?.tier
        if (typeof applied === "string") setTier(applied)
        // 让设置页重新拉一次状态：它那份 tierInfo 不跟着这里变。
        if (typeof window !== "undefined" && typeof window.dispatchEvent === "function" && typeof CustomEvent === "function") {
          window.dispatchEvent(new CustomEvent(STATE_CHANGED_EVENT))
        }
      } catch {
        // 不做静默：档位没变，按钮还停在原来那档，用户得知道为什么点了没反应。
        if (aliveRef.current) setTierFailed(true)
      } finally {
        if (aliveRef.current) setTierBusy(false)
      }
    }

    useEffect(() => {
      aliveRef.current = true
      void load()
      return () => { aliveRef.current = false }
    }, [load])

    useEffect(() => {
      if (open) void load()
    }, [open, load])

    useEffect(() => {
      if (!open) return
      const onPointerDown = (event) => {
        if (rootRef.current && !rootRef.current.contains(event.target)) {
          setOpen(false)
          setConfirmFrom(null)
          setDeletingIndex(null)
        }
      }
      const onKeyDown = (event) => {
        if (event.key === "Escape") {
          setOpen(false)
          setConfirmFrom(null)
          setDeletingIndex(null)
        }
      }
      document.addEventListener("mousedown", onPointerDown)
      document.addEventListener("keydown", onKeyDown)
      return () => {
        document.removeEventListener("mousedown", onPointerDown)
        document.removeEventListener("keydown", onKeyDown)
      }
    }, [open])

    const commit = async (next, onSuccess) => {
      setSaving(true)
      setSaveFailed(false)
      try {
        const payload = await put("/alias", { entries: next })
        const data = payload?.data ?? {}
        setEntries(Array.isArray(data.entries) ? data.entries : next)
        if (typeof onSuccess === "function") onSuccess()
      } catch {
        setSaveFailed(true)
      } finally {
        setSaving(false)
      }
    }

    const from = fromInput.trim()
    const to = toInput.trim()
    const canAdd = from !== "" && to !== "" && !saving

    const add = () => {
      if (!canAdd) return
      const exists = entries.some((entry) => entry.from === from)
      if (exists && confirmFrom !== from) {
        setConfirmFrom(from)
        return
      }
      setConfirmFrom(null)
      const next = exists
        ? entries.map((entry) => (entry.from === from ? { from, to } : entry))
        : entries.concat([{ from, to }])
      void commit(next, () => {
        setFromInput("")
        setToInput("")
      })
    }

    const removeAt = (index) => {
      if (deletingIndex !== index) {
        setDeletingIndex(index)
        return
      }
      setDeletingIndex(null)
      void commit(entries.filter((_, i) => i !== index))
    }

    const onKeyDown = (event) => {
      if (event.key === "Enter") {
        event.preventDefault()
        add()
      }
    }

    const statusText = () => {
      if (phase === "loading") return T.aliasLoading
      // 读不到和「没有条目」是两件事：前者是请求没通，后者是真的没配。
      // 混成一个文案会让人以为词表空了，实际是接口没响应。
      if (phase === "failed") return T.aliasStateFailed
      if (entries.length === 0) return T.aliasStateEmpty
      if (lastHits === 0) return T.aliasStateMiss
      return T.aliasStateHit(entries.length)
    }

    return h("div", { ref: rootRef, style: ALIAS.root },
      h("button", {
        type: "button",
        style: ALIAS.row,
        "aria-haspopup": "dialog",
        "aria-expanded": open ? "true" : "false",
        title: T.dockPopoverTitle,
        onClick: () => { setOpen((value) => !value) },
      },
        h("span", { style: { fontWeight: 600, color: tk.label } }, T.breaklimitButton),
        h("span", { style: { color: tk.label2 } }, "·"),
        h("span", null, statusText())),
      open
        ? h("div", { role: "dialog", "aria-label": T.dockPopoverTitle, style: ALIAS.panel },
            h("div", { style: ALIAS.head },
              h("h3", { style: ALIAS.title }, T.dockPopoverTitle),
              h("button", {
                type: "button",
                style: ALIAS.close,
                "aria-label": T.aliasClose,
                onClick: () => { setOpen(false) },
              }, "\u00D7")),

            // 提示词模式快速切换
            h("div", { style: ALIAS.subhead }, T.dockModeTitle),
            h("div", { style: ALIAS.modeRow },
              h("button", {
                type: "button",
                style: tier === "recommended" ? merge(ALIAS.modeBtn, ALIAS.modeBtnActive) : ALIAS.modeBtn,
                // 用 aria-disabled 而不是 disabled：项目里所有按钮都保留键盘焦点，
                // 真正挡住重复点击的是 switchTier 里的 tierBusy 判断。
                "aria-disabled": tierBusy ? "true" : undefined,
                "aria-pressed": tier === "recommended" ? "true" : "false",
                onClick: () => { void switchTier("recommended") },
              }, T.modeRecommended),
              h("button", {
                type: "button",
                style: tier === "unrestricted" ? merge(ALIAS.modeBtn, ALIAS.modeBtnActive) : ALIAS.modeBtn,
                "aria-disabled": tierBusy ? "true" : undefined,
                "aria-pressed": tier === "unrestricted" ? "true" : "false",
                onClick: () => { void switchTier("unrestricted") },
              }, T.modeUnrestricted)),
            tierFailed ? h("p", { style: ALIAS.fail }, T.dockTierFailed) : null,

            h("div", { style: ALIAS.divider }),

            // 目标词表轻量管理
            h("div", { style: ALIAS.subhead }, T.aliasTitle),
            h("p", { style: ALIAS.desc }, T.aliasDesc),
            h("ul", { style: ALIAS.list },
              entries.length === 0
                ? h("li", { style: ALIAS.emptyItem }, T.aliasEmptyList)
                : entries.map((entry, index) => h("li", {
                    key: `${String(index)}:${entry.from}`,
                    style: index === 0 ? ALIAS.item : merge(ALIAS.item, ALIAS.itemDivider),
                  },
                  h("span", { style: ALIAS.pair, title: `${entry.from} \u2192 ${entry.to}` },
                    entry.from,
                    h("span", { style: ALIAS.arrow }, "\u2192"),
                    entry.to),
                  h("button", {
                    type: "button",
                    style: deletingIndex === index ? merge(ALIAS.remove, { color: tk.error, fontWeight: 600 }) : ALIAS.remove,
                    title: deletingIndex === index ? T.confirmDeleteAlias(entry.from) : undefined,
                    onClick: () => { removeAt(index) },
                  }, deletingIndex === index ? T.aliasConfirmDelete : T.aliasRemove)))),
            confirmFrom !== null
              ? h("div", { style: ALIAS.warnBox },
                  h("span", null, T.confirmOverwriteAlias(confirmFrom)),
                  h("button", { type: "button", style: ALIAS.confirmBtn, onClick: add }, T.save))
              : null,
            h("div", { style: ALIAS.form },
              h("input", {
                style: ALIAS.input,
                placeholder: T.aliasFrom,
                "aria-label": T.aliasFrom,
                value: fromInput,
                onChange: (event) => { setFromInput(event.target.value); setConfirmFrom(null) },
                onKeyDown,
              }),
              h("input", {
                style: ALIAS.input,
                placeholder: T.aliasTo,
                "aria-label": T.aliasTo,
                value: toInput,
                onChange: (event) => { setToInput(event.target.value) },
                onKeyDown,
              }),
              h("button", {
                type: "button",
                style: canAdd ? ALIAS.add : merge(ALIAS.add, ALIAS.addOff),
                disabled: canAdd ? undefined : true,
                onClick: add,
              }, T.aliasAdd)),
            saveFailed ? h("p", { style: ALIAS.fail }, T.aliasSaveFailed) : null,
            h("p", { style: ALIAS.foot }, T.aliasFoot))
        : null)
  }

  function apply(ctx) {
    refreshText()
    ctx.slots.inject("settings.section", () => ctx.slots.register({
      name: "settings.section",
      id: SECTION_ID,
      order: SECTION_ORDER,
      // 侧栏名称的取值早于 Section 挂载，这里同样先同步一次语言。
      label: () => { refreshText(); return T.nav },
    }, Section))

    // 挂在输入框卡片上方、聊天区下方的整行区，与底部统计行同属底部区域。
    // composer.dock 是单行 flex 且不换行，进去只能和统计字并排，做不出「独立一行」。
    // 容器给足高度：只挂一个 inline chip 时父级 flex 可能把它压成 0 高。
    ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
      name: "conversation.input.dock",
      id: "breaklimit-alias",
      order: 10,
      label: () => { refreshText(); return T.breaklimitButton },
    }, AliasRow))
  }

  exports.name = name
  exports.inject = inject
  exports.apply = apply
  // 草稿脏判定抽出来导出，测试直接测这个纯函数。挂在组件内部时只能靠桩 React
  // 状态去逼出脏草稿，桩一改就把断言也改歪了。
  exports.isRuleEditDirty = isRuleEditDirty
  return module.exports
}})
