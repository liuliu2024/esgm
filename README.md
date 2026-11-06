# 碳有据底座

企业碳业务受理的可运行切片。客户创建、提交及补正重提，独立专业人员批准或退回，管理人员在授权组织内查审计。批准表示受理信息通过复核。

## 本地运行

需要 Node.js 22 或更新版本。演示和自动化测试使用隔离的临时 PostgreSQL 引擎。

```sh
npm ci --ignore-scripts
npm run demo
npm test
```

`npm run demo` 用合成样本复验材料接收、入账、冻结演示稿、历史来源和受理复核。演示材料仅接收，状态为待检查。预期结果包含 `frozenTotalKgCO2e: "900"`。台账更正到 `1400` kWh 后，旧报告的来源仍是 `1000` kWh。报告的正式资格和外发资格均为 `false`。演示失败时命令返回非零状态。

`npm run preview -- --sample` 启动本机演示，并预装一份已送审的合成报告。`npm run preview` 可从空任务列表开始。可用 `CARBON_PREVIEW_PORT` 选择端口。

- 客户首页 `http://127.0.0.1:4173/`
- 七项业务 `http://127.0.0.1:4173/modules`
- 企业工作台 `http://127.0.0.1:4173/customer`
- 专业作业台 `http://127.0.0.1:4173/professional`
- 组织审计 `http://127.0.0.1:4173/admin`

### 三分钟演示

1. 从客户首页选择工业制造及采购方资料准备，查看原文依据，点击办理进入预选场景的表单。切回任务工作台，打开「合成样本｜采购方碳报告」，在「历史演示稿」查看已送审版本。
2. 在专业作业台刷新队列，打开同一任务，展开「演示稿复核」。核对 `900 kgCO₂e` 和两条来源，记录演示复核结论。受理单有独立的批准和退回操作。
3. 在组织审计刷新，查看该组织的受理提交与处理历史。报告结论在企业和专业端的对应稿件中查看。
4. 从客户首页进入「业务模块」，展开七项业务，查看准备材料、预期成果和已启用入口。

重启演示服务即可重新走一遍。合成样例保留禁止外发标识。

用企业页新建受理、登记材料并提交，专业页退回，企业页补正重提，再从专业页批准。管理页可查看每次操作、退回理由和补正。预览服务只监听本机，使用临时库、演示身份和临时文件隔离区。用合成 PDF 或 PNG 演示文件接收，接收结果为待检查。

企业页还可按行业选择场景，在受理详情中用合成 CSV 走完数据预检、确认入账、核算预览及生成内部演示稿。演示稿引用冻结结果，站内仅供核对，保留合成因子及禁止外发标识。

重新打开同一受理单后，展开“历史演示稿”可找回已生成稿件。在本机预览进程存续期间可重复读取，演示数据库随进程结束清理。

## 模块

| 目录 | 职责 |
|---|---|
| `src/` | 请求边界、客户受理、专业复核、组织审计 |
| `migrations/` | PostgreSQL 租户和组织隔离、最小运行角色、场景版本、受理状态和审计 |
| `infra/` | 同连接事务、迁移历史和本地演示 |
| `web/` | 独立的企业、专业与管理入口 |
| `test/` | 数据库和服务接口的独立验收 |
| `docs/` | 范围、技术选型和项目交接 |

## 接口契约

入口为 `createCarbonApi(database).dispatch({ method, path, body }, context)`。返回 `{ status, body }`。认证接入层提供可信的 `context = { tenantId, actorId, requestId }`。租户与身份须由真实会话解析，组织和角色由服务查询。出错返回稳定的 `error.code` 和可读的 `error.message`。

| 角色 | 方法与路径 | 参数 |
|---|---|---|
| 客户 | `GET /v1/customer/scenarios` | `orgId`，返回当前租户发布的行业、任务用途、交付对象和场景版本。适用性统一待确认 |
| 客户 | `GET /v1/customer/scenarios/:id/references` | `orgId`，返回指定场景版本的资料链接和参考范围。适用性须另行确认 |
| 客户 | `POST /v1/customer/cases` | `orgId, scenarioReleaseId, purpose`，可选申报对象、地区、年度和交付对象 `scope` |
| 客户 | `GET /v1/customer/cases/:id` | 查询参数 `orgId`，本人发起的受理单 |
| 客户 | `POST /v1/customer/cases/:id/submit` | `orgId, revision`，可选 `evidenceIds` |
| 客户 | `POST /v1/customer/cases/:id/resubmit` | `orgId, revision, correctionNote`，可选 `evidenceIds` |
| 客户或专业复核人 | `GET /v1/{customer|professional}/cases` | `orgId`，可选 `limit, cursor` |
| 客户或专业复核人 | `GET /v1/{customer|professional}/cases/:id/history` | `orgId`，返回有权查看的状态历史 |
| 客户 | `POST /v1/customer/cases/:id/evidence` | `orgId, title, sourceDescription`，本人草稿或退回任务的待补文件登记 |
| 客户 | `POST /v1/customer/cases/:id/evidence/:evidenceId/file` | 查询参数 `orgId`，原始 PDF 或 PNG 字节，最多 5 MiB。配置隔离区后返回待检查接收记录 |
| 客户 | `POST /v1/customer/cases/:id/imports/preview` | `orgId, csv`，预检用电和天然气 CSV，返回行列问题和标准数量，无活动记录写入 |
| 客户 | `POST /v1/customer/cases/:id/imports` | `orgId, csv`，保存任务内的导入批次和预览修订 |
| 客户 | `GET /v1/customer/cases/:id/imports/:batchId` | `orgId`，查最新预览和已生成的入账回执 |
| 客户 | `POST /v1/customer/cases/:id/imports/:batchId/repreview` | `orgId, previewRevision`，用冻结的源文件重新生成预览 |
| 客户 | `POST /v1/customer/cases/:id/imports/:batchId/commit` | `orgId, previewRevision`，整批确认入账，重复确认返回原回执 |
| 客户 | `GET /v1/customer/cases/:id/activities` | `orgId, period, source`，可选 `revision`，读取本人任务最新或指定的已确认活动修订 |
| 客户 | `GET /v1/customer/cases/:id/calculation-preview` | `orgId, from, to`，按月份读取本人任务的合成因子核算预览，显示缺值和来源修订 |
| 客户 | `POST /v1/customer/cases/:id/calculation-snapshots` | `orgId, from, to`，冻结完整的合成预览。同一组输入返回原快照 |
| 客户 | `GET /v1/customer/cases/:id/calculation-snapshots/:snapshotId` | `orgId`，读取本人任务已冻结的合成结果与来源版本 |
| 客户 | `POST /v1/customer/cases/:id/internal-report-drafts` | `orgId, snapshotId`，从同任务的冻结合成快照生成站内结构化演示稿 |
| 客户 | `GET /v1/customer/cases/:id/internal-report-drafts` | `orgId`，可选 `limit, cursor`，读取本人任务的历史稿件索引 |
| 客户 | `GET /v1/customer/cases/:id/internal-report-drafts/:draftId` | `orgId`，读取原稿版本及来源，合成演示稿禁止外发 |
| 客户 | `POST /v1/customer/cases/:id/internal-report-drafts/:draftId/submit-review` | `orgId`，提交指定冻结演示稿，重复提交返回原记录 |
| 客户或专业复核人 | `GET /v1/{customer|professional}/cases/:id/internal-report-drafts/:draftId/review` | `orgId`，读取复核状态。专业端另返回该版冻结稿 |
| 专业复核人 | `GET /v1/professional/cases/:id/internal-report-drafts` | `orgId`，可选 `limit, cursor`，查找已提交复核的版本 |
| 专业复核人 | `POST /v1/professional/cases/:id/internal-report-drafts/:draftId/review` | `orgId, decision, reason?`，独立记录一次内部演示结论。退回需填写理由 |
| 客户或专业复核人 | `GET /v1/{customer|professional}/cases/:id/evidence` | `orgId`，返回有权查看的材料清单 |
| 客户或专业复核人 | `GET /v1/{customer|professional}/cases/:id/revisions/:revision/evidence` | `orgId`，返回已提交修订所引用的材料和文件摘要 |
| 专业复核人 | `GET /v1/professional/cases/:id` | 查询参数 `orgId` |
| 专业复核人 | `POST /v1/professional/cases/:id/review` | `orgId, revision, decision`。退回时必填 `reason` |
| 专业复核人 | `GET /v1/professional/factor-references` | `orgId, accountingBasis, regionCode, dataYear`，只读查询匹配的[官方参考因子](docs/factor-references.md) |
| 组织管理员 | `GET /v1/admin/organizations/:orgId/audit` | 可选 `limit, offset` |
| 组织管理员 | `GET /v1/admin/organizations/:orgId/grants` | 本人角色，可选 `limit, offset` |

## 接入独立 PostgreSQL

用专用空数据库和受信迁移账号运行 `npm run migrate`，连接由 `MIGRATION_DATABASE_URL` 提供。迁移会创建 `carbon` 业务架构及 `carbon_app` 权限角色。应用连接使用独立 LOGIN 角色，由部署方授予 `carbon_app` 成员资格。迁移账号持有建库对象、建角色所需权限，应用账号只持有业务权限。数据库 URL 由部署密钥管理提供。

初始迁移用于独立空库。已登记迁移通过校验和保持不可变。补正、材料清单、文件接收和扫描结果迁移可在前序迁移已应用的数据库增量执行。初次接入需建立工作空间、组织授权和已发布场景版本。

扫描进程使用独立登录角色继承 `carbon_scanner`，通过 `connectPostgres(url, { scanner: true })` 连接，由 `createEvidenceScanner` 接收受信收件 ID 并调用扫描适配器。本地预览仅演示隔离接收。

GitHub Actions 在临时 PostgreSQL 17 验证连接池上下文、并行复核和扫描角色隔离。正式接入前须完成身份集成、目标环境的 ClamD 和持久隔离存储验收、对象对账及恢复演练。详见 [需求详细设计](docs/detailed-design.md)、[三端界面交接](docs/ui-handoff.md) 和 [证据设计](docs/evidence-design.md)。
