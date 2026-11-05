# RQ03 A 任务活动计算预览

依据研发交接 RQ03、CAL01–03 与 AT02。首片从 RQ02 任务活动台账读取已确认数量，用两项虚构因子验证换算、精度、缺值和数据来源。每次请求计算当前预览。冻结计算、规则适用判断和报告发布另行验收。

## 接口和权限

`GET /v1/customer/cases/:id/calculation-preview?orgId=…&from=YYYY-MM&to=YYYY-MM`

校验任务和组织 UUID。起止月份必填，使用有效公历年月，两端包含在内，范围为 1 至 12 个月。参数错误返回 400。沿用企业本人任务的组织客户权限，任务状态沿用普通查看接口。缺角色返回 403，查不到可访问的任务返回 404。响应仅涉及指定任务。其他组织或任务的同期间记录不参与。后续若开放专业复核读取，先与任务台账和字段权限一起验收。

响应主要字段如下。

| 字段 | 规则 |
|---|---|
| `from, to` | 请求的包含式月份边界 |
| `mode, formalReportEligible` | 固定为 `"synthetic"` 和 `false` |
| `model` | `{id:"task-carbon-preview",version:1,factorSetId:"synthetic-energy",factorSetVersion:1,synthetic:true}` |
| `coverage` | `{status, expectedSlots, availableSlots, missingSlots}`。每月两个活动槽位，按年月和固定来源顺序返回。覆盖状态为 `complete`、`partial` 或 `empty` |
| `items[]` | `{period,source,status,quantity,unit,emissionsKgCO2e,factor,lineage}`。活动状态为 `calculated` 或 `missing_activity` |
| `knownSubtotalKgCO2e` | 可计算项之和。没有可计算项时为 `null` |
| `totalKgCO2e, totalTCO2e` | 仅在全部槽位有已确认数据时返回精确值，否则均为 `null` |

缺活动量的槽位保留期望单位及对应因子，`quantity`、`emissionsKgCO2e` 和 `lineage` 返回 `null`。已确认真实零返回 `"0"`，计入覆盖。因子用于演示，响应统一带 `synthetic:true`。UI 采用“合成因子预览”，部分覆盖明确标识“已知小计”。每月两个槽位是该演示模板的覆盖约定，正式适用性由已审核的业务范围决定。

## 因子与精度

| 因子 ID | 版本 | 活动及单位 | 虚构系数 |
|---|---|---|---|
| `demo-electricity` | 1 | `electricity`，`kWh` | `"0.5"` kgCO2e/kWh |
| `demo-natural-gas` | 1 | `natural_gas`，`m3` | `"2"` kgCO2e/m3 |

`factor` 固定含 `id,version,value,inputUnit,outputUnit,synthetic`。两个数值为测试夹具，用于验证算术，来源标记为内部合成样本。改变系数或覆盖约定时发布新版本标识。实际单位、地域、时段、气体类别、GWP、核算范围与监管规则依正式因子库和规则确认。

在一个已有租户事务中按 `tenant_id,org_id,case_id` 和月份取台账最新修订。建议使用 `DISTINCT ON (period,source)` 按修订倒序选择记录，然后关联固定月份/活动槽位和因子，确保一次读取内输入一致。只读 `activity_record_revision` 的已入账行，复用现有 RLS。两种因子的输入单位必须匹配已标准化单位。需要增加活动或不同量纲时，增加可验收映射后再接入。

所有数量、因子、计算结果均使用十进制字符串输出。计算在 PostgreSQL 用 `numeric` 乘法与求和，吨数换算乘精确 `0.001`，全程保持原精度。可用 `trim_scale(value)::text` 规范化字符串，避免科学记数法及多余尾零。界面仅在展示层按明确策略格式化，API 和复算保留原始精度。首片不新增计算表或持久结果。

## 来源与复算

每项已计算记录的 `lineage` 公开 `{activityRevision,batchId,previewRevision,sourceRow,sourceType,conversionVersion,originalQuantity,originalUnit}`，配合 `caseId,period,source` 可定位台账原修订和源行。返回不含 CSV 全文、存储地址或其他任务标识。修正后实时预览引用最新修订，旧修订仍保留。后续冻结结果需锁定活动修订、因子版本及许可、换算版本、计算代码、模型及规则版本，并持久化中间明细及审批状态。

## 验收夹具

| 条件 | 验收 |
|---|---|
| 同月 1000 kWh 和 200 m3 | 两项分别为 `"500"` 和 `"400"`，完整总量 `"900"` kgCO2e 和 `"0.9"` tCO2e |
| 仅 0 kWh，无燃气记录 | 电力为已计算，排放 `"0"`；燃气缺失；`partial`，小计 `"0"`，总量 `null` |
| 无已入账记录，另有未确认预览 | `empty`，两项缺失，小计与总量均为 `null` |
| 台账电量从 `"1000"` 更正为 `"1000.0000000000001"` | 预览引用新修订，电力排放为 `"500.00000000000005"`，旧修订保留 |
| 跨年两个月、非法年月、反向和超过十二个月的范围 | 跨年输出四槽位；无效范围返回 400 |
| 同租户他人任务、异组织、跨租户、撤权 | 沿用现有访问判定，响应中无台账、因子结果或来源泄露 |
| 重复读取同一已入账状态 | 结果、次序、因子及来源一致，任务、活动、批次和审计均无新增写入 |

生产因子须验证发布来源、版本有效期和许可，覆盖相应场景、地域及期间。正式交付还需冻结结果、复算、审核、锁期和受控发布。
