# 内部演示稿独立复核

依据 RQ04 的独立复核和版本化交付要求。首片从已冻结的合成演示稿验证审批职责、同版本追踪和交付资格。合成稿的复核结论仅限内部演示，报告的正式和外发资格始终为 `false`。

| 操作 | 接口与结果 |
|---|---|
| 企业提交稿件 | `POST /v1/customer/cases/:caseId/internal-report-drafts/:draftId/submit-review`，`{orgId}`。企业本人、任务状态 `submitted` 或 `approved`。初次 201，已提交重试 200，返回既有复核记录 |
| 企业查看复核 | `GET /v1/customer/cases/:caseId/internal-report-drafts/:draftId/review?orgId=…`。返回同一稿件复核记录，尚未提交时 404 |
| 专业查找已提交稿件 | `GET /v1/professional/cases/:caseId/internal-report-drafts?orgId=…&limit=…&cursor=…`。沿用稿件目录分页，返回已提交稿件摘要及 `reviewStatus`。本人发起的任务不可作为复核队列来源 |
| 专业查看复核 | `GET /v1/professional/cases/:caseId/internal-report-drafts/:draftId/review?orgId=…`。本组织专业人员只读取已提交演示稿及该次复核，不扩大普通材料或历史目录权限 |
| 专业作出结论 | `POST /v1/professional/cases/:caseId/internal-report-drafts/:draftId/review`，`{orgId,decision,reason?}`。结论 `reviewed` 或 `returned`，退回原因必填；本人发起的任务不可自审。仅可从 `submitted` 完成一次结论，后续写入返回 409 |

复核记录包含 `draftId,caseId,status,submittedBy,submittedAt,reviewedBy,reviewedAt,reason`，并固定 `formalReportEligible:false,externalDeliveryEligible:false`。专业 GET 同时返回冻结稿 `{review,draft}`。企业 GET、POST 及专业 POST 返回 `{review}`。同任务不同稿件分别复核。退回后可另生成新稿并提交，不覆盖旧结论。若受理退回，暂不接收新的稿件提交和结论，恢复提交后可继续。当前无采购方访问或发送入口。

数据库以 `(tenant_id,org_id,case_id,draft_id)` 固定稿件和复核关系。限制应用列权限，状态转换和操作者由数据库守卫，独立保存提交与决策的请求标识。公司与专业身份沿用现有组织授权，租户与任务隔离。受理审计不充当报告审计。验收覆盖重复提交、同版本结论、退回理由、自审、跨组织、未提交稿件的专业访问、撤权以及复核后仍无交付资格。
