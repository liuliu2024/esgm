# 模型计算开发包 CAL01–08

任务规则模块验收后接续。本包按同一集成版本完成开发，再交数据库与接口测试，测试通过后交独立 QC。

| 需求 | 复用基线 | 本包验收范围 |
| --- | --- | --- |
| CAL01 因子与授权 | 电力因子目录、专业选择、版本与出处 | 固定燃烧新增因子或参数注明用途、口径、出处及可交付范围。试算、报告与外发字段使用同一版本 |
| CAL02 模型与分配 | 外购电力单源及演示模型 | 固定燃烧按活动源、方法和输入单位计算。产品模型显式保存边界、功能单位和分配条件，缺必要输入显示缺项 |
| CAL03 确定性计算 | PostgreSQL 十进制计算、固定活动输入和电力快照 | 固定模型、因子、换算及适用的 GWP 版本。保留可定位的逐项结果，失败不产生可用总量 |
| CAL04 计算任务状态 | 现有同步预览、冻结重放 | 在站内查排队、运行、成功、失败、取消和过时。重试及同输入提交回到可复验的任务记录 |
| CAL05 结果穿透 | 外购电力月度明细和原活动修订 | 按来源、设施或阶段展示组成，复核人按现有权限追到公式、因子及证据 |
| CAL06 版本与重述 | 冻结报告和旧提交留痕 | 新旧版本差额和原因可查，列关联报告，旧版继续可读 |
| CAL07 模板复用 | 场景模板与不可变规则版本 | 模型引用锁版本，显示依赖并校验循环；替换前列影响 |
| CAL08 方案比较 | 已冻结的版本结果 | 同边界、功能单位及期间才比较。明确输入或因子变化及结果限制 |

先以一组标识为合成的固定燃烧活动走通证据、计算、冻结和报告。专业方法按场景核对官方原文，真实数据仍由企业录入或上传。固定燃烧切片通过自检后继续开发包内其余要求，模块全量接齐时安排集中测试。

## 发电设施天然气输入及内部试算

首个模型覆盖 `power-generation-combustion` 场景、申报为 2026 年的单一发电设施及天然气固定燃烧。每个提交版本每月可由独立专业人员确认一组输入。先确认该提交的规则候选 `cets-power-2026`，再选该提交固定的用量和参数凭证，填写 20℃、101.325 kPa 参比下的标准体积和参数取值依据。常规活动台账的 `m3` 保持原义。服务按原授权读取历史版本。

按 `power-gas-combustion-2026` v1，元素碳含量来自符合要求的实测数据，或按 `NCV × CC` 推算。试算以 `Nm³ × 0.0001 × 元素碳含量 × OF × 44 ÷ 12 × 1000` 得出月度 kgCO₂。月度结果内部保留六位小数，再汇总。缺月显示缺项和已知小计；真实零计入覆盖。专业人员提供参数证据及理由，生产氧化率取值按适用国家因子库条目核对。[发电设施指南第 6.1 和 6.2 节](https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202606/W020260629673485282202.pdf)

接口为 `/v1/{customer|professional}/cases/:caseId/revisions/:revision/gas-combustion`。两端可 GET `{orgId,from,to}`，月份限 2026 年；专业端可 POST `{orgId,period,standardVolumeNm3,ncvGjPer10kNm3,carbonTcPerGj,oxidationFraction,activityEvidenceId,parameterEvidenceId,parameterBasis}`。四个数字使用十进制字符串，氧化率使用比例。返回月度输入、公式中间项、凭证版本及覆盖，正式报告和外发资格均为假。

客户在当前有效提交使用同一前缀的 `POST /snapshots` 提交 `{orgId,from,to}`，只冻结覆盖完整的区间。同一提交、区间和模型重放返回同一快照。客户和专业人员通过 `GET /snapshots?orgId=…` 查指定提交的目录，再用 `GET /snapshots/:snapshotId?orgId=…` 读取不可变结果。快照保留月份、参数、凭证回执及摘要。

`GET /v1/{customer|professional}/cases/:caseId/gas-combustion/comparison?orgId=…&baseline=…&target=…` 比较同任务、设施、期间和模型的两个冻结快照，返回总差额和逐月变动的输入。跨任务快照返回 404，范围或模型不同返回 409。

### 计算分支和内部报告

模型统一标识为 `power-gas-combustion-2026` v1。月度输入可选 `methodBranch: "ncv_carbon"` 或 `"measured_carbon"`。前者须填低位发热量和单位热值含碳量，后者须填 `elementalCarbonTcPer10kNm3`。两种分支分别绑定取值依据与凭证，输出同一 CO₂ 单位。选择实测分支时，系统使用实测元素碳含量计算，热量中间项留空。

企业在当前有效提交使用 `POST /v1/customer/cases/:caseId/revisions/:revision/gas-combustion/snapshots/:snapshotId/internal-report-draft`，请求 `{orgId}`。内部试算稿从冻结结果生成，和旧稿共用历史、完整报告、送审及专业复核。天然气报告保留试算水印和证据，仅供内部使用。

### 后台试算

- 企业在当前提交通过 `POST /v1/customer/cases/:caseId/revisions/:revision/gas-combustion/jobs` 提交 `{orgId,from,to}`。同一提交、范围重放返回已有作业。
- `GET /v1/customer/cases/:caseId/gas-combustion/jobs[/:jobId]?orgId=…` 读取状态与可访问的快照标识。补正导致的过时状态独立显示，已生成的旧快照保留。
- 企业以 `POST …/jobs/:jobId/cancel` 取消待执行作业，或用 `POST …/jobs/:jobId/retry` 重排当前版本中失败或取消的作业。请求为 `{orgId}`。执行中的作业由服务完成或在租约到期后重新领取。
- Worker 使用 `node infra/gas-calculation-worker.mjs <tenantId> [--once]`。部署操作方配置限领取/完成的 `CALCULATION_WORKER_DATABASE_URL` 和应用 `DATABASE_URL`。每次处理前以可信作业申请人重新检查权限和提交版本，成功输出同一冻结快照，失败仅保存稳定错误码。
- Worker 数据库登录需同时具有 `carbon_calculation_worker` 成员资格，以及部署方登记的对应租户。使用数据库登录身份核对授权，租户参数只用于选择工作范围。测试和生产分别配置登录，避免共享凭据。

部署方用数据库管理账号在 `carbon.calculation_worker_tenant_grant` 登记实际登录角色的 `regrole` 和工作空间 ID。新增 Worker 默认没有租户授权。迁移包保留空授权表，由部署环境按需配置。

核对了 pg-boss 和 Graphile Worker 的 PostgreSQL 领取、重试及恢复设计。当前作业只有一个确定性快照动作，采用现有 PostgreSQL 事务、限权角色和原生行锁。后续扩展更多作业时再评估引入通用队列库。 [pg-boss](https://github.com/timgit/pg-boss) · [Graphile Worker](https://github.com/graphile/worker)

专业工作台可在同一任务下选择两份冻结快照，读取总差额和有变化的月份及输入。后续补带审批的重述与模板引用。整包开发完成后验证真实 PostgreSQL Worker 的权限、租约恢复与重复执行。

### 产品生产用电贡献

- 适用于产品碳足迹场景中已明确产品对象和申报年度的提交。专业人员保存起止月份、电表或工序范围、功能单位、同期间目标产品产出和归属依据。归属支持独占用电和共用电力按质量分配两种方式。按质量分配时，目标产品质量与同期间全部产出质量用 kg 填写。变更口径通过补正生成新提交，历史提交仍可读。
- `GET /v1/{customer|professional}/cases/:caseId/revisions/:revision/product-electricity?orgId=…` 返回口径、模型版本和状态。专业端可在同路径 `POST {orgId,from,to,boundaryNote,functionalUnit,outputQuantity,allocationMethod,allocationBasis,productMassKg?,batchMassKg?}`。小数使用字符串。独占方式为 `exclusive`，质量方式为 `mass`。两个质量字段仅在质量方式提交。
- 复用冻结的月度用电和产品电力碳足迹因子版本。按质量分配时，用电排放乘以目标产品质量占比，再除以产出功能单位数。试算返回分配比例、归属排放、每功能单位贡献和可定位的月度活动数据。缺口径、缺适用因子或缺月均有明确状态，未满足条件时 `result` 为空。模型仅计算生产用电贡献，正式报告与外发资格为假。
- 样例使用 1,000 kWh、0.5777 kgCO₂e/kWh、25% 质量份额与 100 个功能单位，预期分配 144.425 kgCO₂e，每功能单位 1.44425 kgCO₂e。具体产品方法、生命周期边界和归属选择由专业人员按适用要求确认。[生态环境部 GB/T 24067-2024 答记者问](https://www.mee.gov.cn/ywdt/zbft/202409/t20240910_1085481.shtml)

### CAL06 重述审批接力

- 企业选定同一任务的旧版和当前版天然气冻结快照并填写原因。服务核对提交版本先后、计算设施、模型版本和月份范围，复用快照比较。待审批记录固定新旧快照、提交人、原因和提交时间。
- 独立专业人员批准或退回，退回须记录理由。操作时再次确认目标提交仍有效，保留审批人与时间。审批只确认新旧结果的重述关系。新报告继续走现有独立复核。
- 企业和专业端可查两侧结果、总量及逐月差额、关联稿件和审批结论。已冻结结果和旧稿保留。指定旧稿范围内的重述生成须核对已批准的精确目标快照，防止绕过审批入口。
- `GET /v1/{customer|professional}/cases/:caseId/gas-combustion/restatements?orgId=…` 返回申请、本人有权访问的关联报告和总差额。企业返回可申请的快照组合。逐月差额沿用冻结快照比较接口。
- 企业向同路径提交 `{orgId,baselineSnapshotId,targetSnapshotId,reason}`。专业端向同路径的 `/:id/review` 提交 `{orgId,decision,reason?}`。决定为 `approved` 或 `returned`，退回原因必填。申请状态为 `pending`、`approved` 或 `returned`。已退回的申请保留，企业可重新申请。
- 新旧期间完全一致且模型相同才进入本轮审批。新稿记录基准提交、差额、原因和批准时间。已有旧稿和已生成稿继续按原访问权限读取，其他计算模型暂用各自的版本流程。

### CAL07 模型模板与引用影响

- 产品用电口径随提交固定到 `product-electricity-contribution@1`，明确引用提交版外购电力核算 v1 和产品电力分配 v1。模板目录由研发随可执行模型版本安装，专业端可查。旧版本保留精确引用，升级须单独新增版本。
- 依赖只能指向先安装的版本，防止自引用和循环。引用关系随版本封存，产品口径用外键固定版本，应用只读目录。
- 专业端用 `GET /v1/professional/model-templates?orgId=…` 读取模板和依赖。用 `GET /v1/professional/model-templates/:templateId/versions/:version/impact?orgId=…` 预览本组织直接和间接引用该版本的任务提交。返回精确总数与前 50 条明细，不修改任务。
- 参考 Brightway 在数据包元数据显式记录依赖的做法。其变更记录包含数据库重处理和复制边的修复。本项目沿用 PostgreSQL 的定版外键和只读影响查询，未引入其 Python、SQLite 和数组处理依赖。[Brightway 源码及 BSD-3-Clause 许可](https://github.com/brightway-lca/brightway2-data) · [Brightway 更新记录](https://docs.brightway.dev/en/latest/content/changelog/link_to_changelog_data.html)

### CAL08 产品生产用电版本对比

- `GET /v1/{customer|professional}/cases/:caseId/product-electricity/comparison?orgId=…&baseline=…&target=…` 按同一任务的两个提交读取已固定的月度活动、因子及口径。功能单位和用电边界须使用同一表述，期间及模型版本须一致，两个版本均须计算完整。不可比时说明原因。
- 显示目标减基准的每功能单位、产品归属和总用电排放差额，另列分配参数、因子版本和月度用电变化。对比限于生产用电分项，不据此评定完整产品足迹。

### CAL01 因子披露

| 因子版本披露范围 | 采购方交付件 |
| --- | --- |
| `source_and_value` | 可按勾选附该单项因子的数值和来源，也可附月度用量与排放 |
| `summary_only` | 仅可显示排放合计。月度用量、月度排放和因子字段均不出件 |
| `internal_only` | 内部核算和复核可查，不可生成采购方交付件。无已登记披露范围的版本按此处理 |

披露登记按因子 ID 和版本固定。交付以报告冻结的提交版本及该版本因子决定核对权限，HTML 与 PDF 使用同一交付件。当前有效版本、完整期间、独立复核等交付条件仍须满足。旧稿读取同一份版本授权，历史交付记录可查。

现有白名单限已核对的三个官方电力因子公告中已入库的因子版本。交付件可带该项计算实际引用的单项数值和原文出处。新的授权来源须按版本登记。[2024 电力碳足迹公告](https://www.mee.gov.cn/xxgk2018/xxgk/xxgk01/202510/t20251024_1130734.html) · [2023 电力碳足迹公告](https://www.mee.gov.cn/xxgk2018/xxgk/xxgk01/202501/t20250123_1101226.html) · [2023 电力二氧化碳排放因子公告](https://www.mee.gov.cn/xxgk2018/xxgk/xxgk01/202512/t20251231_1139517.html)
