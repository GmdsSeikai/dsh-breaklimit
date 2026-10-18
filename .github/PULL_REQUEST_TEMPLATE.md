<!-- 一个 PR 解决一个问题或功能。贡献规则见 CONTRIBUTING.md。English is welcome. -->

## 改了什么 / What changed

描述触发条件、原行为和修改后的结果。

## 为什么改 / Why

说明解决的问题及采用这种做法的原因。

## 关联 Issue / Linked issue

例如 Fixes #12；大的改动请先开 Issue 讨论。

## 截图（界面改动时）/ Screenshots

附实际界面截图，注明是否使用夹具数据；无界面变化可删掉本节。

## 验证 / Testing

列出实际执行的命令或场景及结果，注明本地、CI、夹具、真实安装或浏览器层。

- [ ] `npm run check`
- [ ] `git diff --check`
- [ ] 涉及补丁或宿主适配：`npm run reconcile -- <宿主根>` 和 `npm run check:host -- <宿主根>`
- [ ] 涉及界面或安装：按文档完成对应实际验收，并注明未验证项

## 兼容与未验证项 / Compatibility

说明接口、持久数据、宿主版本及回退影响；无影响时写“无”。列出仍未验证的边界。

## AI 使用说明 / AI disclosure

<!-- 必填。没有使用写“没有使用”；使用时说明具体工具、模型版本及用途。 -->

- 是否使用 AI：
- 工具和模型版本：
- 用途（分析 / 代码 / 测试 / 文档）：
- [ ] 我已读过全部改动，并按上面的方式验证
