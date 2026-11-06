# RQ03 B 任务计算快照

依据 RQ03、CAL04–06。RQ03 A 读取任务活动台账即时计算。此切片冻结一份完整的合成因子结果，给后续内部演示稿提供稳定的引用。覆盖条件沿用 A 的演示模板，实际核算范围和适用规则另行确认。

## 接口与权限

| 动作 | 契约 |
|---|---|
| 保存 | `POST /v1/customer/cases/:id/calculation-snapshots` 接收 `{orgId,from,to}`。沿用 A 的 UUID、年月和 1 至 12 个月范围校验。请求不携带活动量、因子或计算结果 |
| 读取 | `GET /v1/customer/cases/:id/calculation-snapshots/:snapshotId?orgId=…` 按租户、组织、任务及快照标识读取冻结结果 |

保存和读取都要求当前有效的组织客户权限且操作者为任务创建者。按既有企业任务查看规则判断任务可见性。该写入生成独立快照，不改变任务状态、受理修订或复核结论。缺少组织角色返回 403。找不到本人可访问的任务或快照返回 404。撤权后重新读取和重放均须重新通过授权。

首片供企业任务创建者使用。专业人员的读取应随选定快照与提交修订的显式绑定开放。绑定后按现有组织复核权限和任务可见性读取对应版本，发起人不能审核自己的任务。绑定、专业读取与审核动作分别验收。

## 冻结和重放

服务在已授权的任务事务中执行一次 RQ03 A 的 scoped 查询，共用计算实现、覆盖判定、精度和稳定行序。冻结输入以该 SQL 语句所见的已确认台账为准。只保存覆盖完整的结果，缺数据返回 409 `CALCULATION_INCOMPLETE`，仍可通过 A 查缺失槽位。真实零仍计入覆盖。

首次保存返回 201。相同任务、范围、结果架构版本、计算模型与因子版本、以及有序活动修订完全相同时，返回原记录及原时间，状态为 200。任一活动修订或模型、因子版本变化后保存形成新记录，旧快照继续可读。请求 ID 用于记录首次写入的追踪信息，重试去重依据冻结输入。活动或因子在两次保存之间有变更时，第二次请求以新输入形成独立快照。

建议用固定顺序序列化去重键的版本化元组，再计算 SHA-256。元组包含月份边界、快照架构版本、模型与因子版本，以及按月份和来源排序的 `[period,source,activityRevision]` 数组。通过数据库唯一约束和 `INSERT … ON CONFLICT DO NOTHING` 防止并行重复写入。冲突后在同一事务下一条语句读取既有记录。持久化失败回滚整条记录。

## 记录与来源

候选表 `carbon.calculation_snapshot` 保存 `tenant_id,org_id,case_id,id,created_by,request_id,created_at,schema_version,from_period,to_period,input_fingerprint,payload`。任务以三字段复合外键绑定。去重键为 `(tenant_id,org_id,case_id,input_fingerprint)`。启用租户范围 RLS，应用角色只能读写本人且有组织客户角色的任务。快照行只追加，禁止更新删除。

响应为 `{snapshotId,caseId,createdAt,schemaVersion,result}`，`result` 为 A 的冻结响应，保持原十进制字符串、活动标准量与原值、来源行号、活动及预检修订、批次 ID、换算版本、模型及因子明细。保留 `mode:"synthetic"` 和 `formalReportEligible:false`。旧版本直接读取持久值，不调用当前计算器。通过任务、月份、来源、活动修订定位不可变台账记录。正式结果若要求数据库逐项外键和因子许可快照，作为单独发布门槛验收。

后续内部演示稿可在同一已授权任务内以 `snapshotId` 读取，展示“合成因子演示”和覆盖边界。报告草稿、任务复核和快照冻结是独立动作。正式报告、官方提交以及跨任务汇总需要另行实现和验证。

## 受理提交的活动输入

每次新提交或补正重提，在生成提交版本的同一事务中固定该任务每月、每活动来源的最新已入账修订。固定行引用原台账修订，并保存规范化数量、单位及来源。未确认导入不进入提交版本；已确认的零仍是有效数据。修改后的活动只随下一次提交固定，旧提交可按原数据复查。

`GET /v1/{customer|professional}/cases/:caseId/revisions/:revision/activities?orgId=…` 返回 `{submissionRevision,status,items}`。新提交的状态为 `captured`，即使没有活动行也返回空数组。功能上线前的提交为 `legacy_unavailable`，不会以当前活动回填。非提交版本返回 404。客户仅访问本人的授权任务，专业人员仅访问有权复核的已提交任务的固定内容。

专业作业台在「提交版本证据」下显示该版本的活动数据。受控试算同时引用同一提交的活动输入及因子决定。现有合成核算和报告接口继续保留其原有用途和资格标识。

### 外购电力受控试算

`GET /v1/professional/cases/:caseId/revisions/:revision/calculation-preview?orgId=…&from=YYYY-MM&to=YYYY-MM`。沿用包含首尾的 1 至 12 个月范围。组织复核者可读取授权任务的提交版本，任务发起人不能在专业端执行该动作。无权返回 403，找不到任务或提交版本返回 404，旧版本缺固定活动输入返回 409 `CALCULATION_INPUT_UNAVAILABLE`。

每月一个外购电力槽位。仅使用该提交固定的活动修订与目录因子决定。首片限定为同一数据年和输入单位匹配的试算。地域和方法的选择依据取自因子决定。无活动为 `missing_activity`，有活动但缺匹配因子为 `missing_factor`，已计算为 `calculated`。同期间的其他已提交来源列在 `excludedSources`。

返回 `scope: "purchased_electricity"`、`mode: "controlled"`、覆盖计数、因子决定、来源明细和十进制字符串。按因子的 `outputUnit` 区分 `kgCO2` 与 `kgCO2e`。部分覆盖仅提供 `knownSubtotalKg`。完整覆盖提供 `totalKg` 和 `totalT`。保留已确认的零。结果仅供工作台复核，`formalReportEligible` 与 `externalDeliveryEligible` 均为 `false`。

验证入口为专业作业台的「提交版本证据 → 外购电力受控试算」。本地 `npm run preview -- --sample` 附带一项合成用电任务。选择 2024 年 1 至 2 月，可核对 1000 kWh 与 0 kWh、合计 577.7 kgCO₂e，天然气列在范围外。使用 [2024 年电力碳足迹因子公告](https://www.mee.gov.cn/xxgk2018/xxgk/xxgk01/202510/t20251024_1130734.html) 和 [2023 年电力二氧化碳排放因子公告](https://www.mee.gov.cn/xxgk2018/xxgk/xxgk01/202512/t20251231_1139517.html) 对照两种口径。

## 验收

- 保存包含 `1000 kWh` 和 `200 m3` 的完整样例，核对结果 `"900"` kgCO2e、`"0.9"` tCO2e、两项因子及具体活动修订。重复保存返回同一 ID 和创建时间。
- 完整数据含真实零可保存。空数据、未确认导入和部分覆盖的样例返回 409，快照行数不变。
- 更正同月活动后再次保存，得到不同 ID。旧记录仍返回原总量、因子及活动修订。
- 同租户他人任务、异组织、跨租户、复核者直接请求和撤权访问被拒绝。猜测其他任务快照 ID 不返回业务内容。
- 并行保存相同冻结输入只产生一条记录，所有成功响应指向同一 ID。保存和读取前后，任务状态、修订和受理审计保持一致。
