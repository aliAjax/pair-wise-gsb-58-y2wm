# 银行反欺诈告警关系分析与案件调查平台

基于 React、Mantine、Redux Toolkit、RTK Query、React Router、React Flow、Vite 和 TypeScript 实现的中文前端项目。项目使用浏览器 `localStorage` 模拟服务端数据库，不依赖外部后端即可运行。

## 功能

- 告警中心：关键词、风险等级、状态和渠道组合筛选，批量关联案件或排除。
- 案件工作台：案件列表、风险状态和调查工作量概览。
- 关系图谱：账户、设备、IP、商户关系布局，节点拖动持久化，关系解释与弱关联区分。
- 联动时间轴：交易、告警和证据按时间排序，点击后高亮对应关系。
- 证据台账：来源、发生时间、提交人、附件标识、证据强度和版本记录。
- 结论版本：保存草稿或提交复核，支持通过、退回补证和案件状态流转。
- 统一可恢复快照：告警、案件、关系图谱、证据台账、结论版本接入同一份按案件版本化的快照，每次保存携带版本摘要（新增/移除节点关系、证据增删与强度调整、结论新增、失效数、自动合并、冲突覆盖），可一键恢复到任意历史版本，重启后历史（含失效版本）仍可见。
- 双窗口并发保存：以保存时的快照版本为基线做三方合并——集合类内容（节点、关系、证据、告警）按 id 并集自动并入，仅一方修改的字段自动合并；双方修改同一字段且取值不同时列为冲突，调查员在弹窗中逐项选择"保留对方"或"以我的覆盖"后才提交。另一窗口保存后，本窗口通过 `storage` 事件自动刷新。
- 证据变化与结论失效：每份结论锁定创建时的证据指纹（证据 id + 强度）；证据新增、移除或强度变化后，非已通过的旧结论自动标记"已失效·待重算"，并列明新增、移除与强度差异，待复核案件回到调查中；失效版本保留在快照历史中，可据其重算新版本或恢复旧快照。
- 保存失败草稿与重试：保存失败（页面右上角可开启"模拟保存失败"演示）时变更以草稿形式持久保留在本地，不丢失；下次打开案件自动重试，冲突草稿自动弹出确认框，也可在顶部导航的草稿徽标或案件页横幅中手动重试/放弃。重试按确定性 id 去重，不会重复新增节点或证据。
- 审计报告：操作人和时间不可变留痕，支持 JSON、CSV 导出及演示数据重置。

## 技术栈

- React 19 + TypeScript
- Mantine 9
- Redux Toolkit + RTK Query
- React Router
- React Flow
- Vite

## 运行

```bash
npm install
npm run dev
```

访问 `http://localhost:18458`。

## 构建

```bash
npm run build
npm run preview
```

`npm run build` 会先执行严格 TypeScript 检查，再生成 Vite 生产构建。

## 数据说明

首次打开时会将演示案件写入 `localStorage`（键 `bank-fraud-investigation-db-v2`，旧版 v1 平铺结构首次访问时自动迁移为按案件的版本化快照）。后续新增证据、结论、关系节点和状态流转都会以新快照版本持久化，并在历史中保留每个版本的完整内容；保存失败的草稿单独存于 `bank-fraud-investigation-pending-drafts-v1`。"审计与报告"页面可以重置全部演示数据（同时清空草稿与失败模拟开关）。

## 核心逻辑验证

```bash
npx esbuild scripts/verifySnapshot.mts --bundle --platform=node --format=cjs --outfile=node_modules/.cache/verifySnapshot.cjs
node node_modules/.cache/verifySnapshot.cjs

npx esbuild scripts/verifyStorage.mts --bundle --platform=node --format=esm --outfile=node_modules/.cache/verifyStorage.mjs
node node_modules/.cache/verifyStorage.mjs
```

两个脚本分别覆盖快照引擎（证据指纹差异、结论失效重算、三方合并与冲突确认、失败重试去重、快照恢复、approved 保护、全局告警同步）和存储层（v1→v2 迁移、草稿持久化、失败开关、重置清理），共 29 项断言。
