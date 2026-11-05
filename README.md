# 碳有据底座

企业碳业务受理的可运行切片。客户创建、提交及补正重提，独立专业人员批准或退回，管理人员在授权组织内查审计。批准表示受理信息通过复核。

## 本地运行

需要 Node.js 22 或更新版本。演示和自动化测试使用隔离的临时 PostgreSQL 引擎。

```sh
npm ci --ignore-scripts
npm run demo
npm test
```

`npm run preview` 启动同一数据库上的三个独立入口：

- 企业工作台 `http://127.0.0.1:4173/customer`
- 专业作业台 `http://127.0.0.1:4173/professional`
- 组织审计 `http://127.0.0.1:4173/admin`

用企业页新建受理、登记材料并提交，专业页退回，企业页补正重提，再从专业页批准。管理页可查看每次操作、退回理由和补正。预览服务只监听本机，使用临时库、演示身份和临时文件隔离区。用合成 PDF 或 PNG 演示文件接收，接收结果为待检查。

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
| 客户 | `POST /v1/customer/cases` | `orgId, scenarioReleaseId, purpose` |
| 客户 | `GET /v1/customer/cases/:id` | 查询参数 `orgId`，本人发起的受理单 |
| 客户 | `POST /v1/customer/cases/:id/submit` | `orgId, revision` |
| 客户 | `POST /v1/customer/cases/:id/resubmit` | `orgId, revision, correctionNote` |
| 客户或专业复核人 | `GET /v1/{customer|professional}/cases` | `orgId`，可选 `limit, cursor` |
| 客户或专业复核人 | `GET /v1/{customer|professional}/cases/:id/history` | `orgId`，返回有权查看的状态历史 |
| 客户 | `POST /v1/customer/cases/:id/evidence` | `orgId, title, sourceDescription`，本人草稿或退回任务的待补文件登记 |
| 客户 | `POST /v1/customer/cases/:id/evidence/:evidenceId/file` | 查询参数 `orgId`，原始 PDF 或 PNG 字节，最多 5 MiB。配置隔离区后返回待检查接收记录 |
| 客户或专业复核人 | `GET /v1/{customer|professional}/cases/:id/evidence` | `orgId`，返回有权查看的材料清单 |
| 专业复核人 | `GET /v1/professional/cases/:id` | 查询参数 `orgId` |
| 专业复核人 | `POST /v1/professional/cases/:id/review` | `orgId, revision, decision`。退回时必填 `reason` |
| 组织管理员 | `GET /v1/admin/organizations/:orgId/audit` | 可选 `limit, offset` |
| 组织管理员 | `GET /v1/admin/organizations/:orgId/grants` | 本人角色，可选 `limit, offset` |

## 接入独立 PostgreSQL

用专用空数据库和受信迁移账号运行 `npm run migrate`，连接由 `MIGRATION_DATABASE_URL` 提供。迁移会创建 `carbon` 业务架构及 `carbon_app` 权限角色。应用连接使用独立 LOGIN 角色，由部署方授予 `carbon_app` 成员资格。迁移账号持有建库对象、建角色所需权限，应用账号只持有业务权限。数据库 URL 由部署密钥管理提供。

初始迁移用于独立空库。已登记迁移通过校验和保持不可变。补正、材料清单和文件接收迁移可在前序迁移已应用的数据库增量执行。初次接入需建立工作空间、组织授权和已发布场景版本。

GitHub Actions 在临时 PostgreSQL 17 验证连接池上下文和并行复核。正式接入前须完成身份集成、目标环境隔离及恢复演练。文件扫描、正式引用和提交结果未确认时的对象对账仍是后续切片。详见 [需求详细设计](docs/detailed-design.md)、[三端界面交接](docs/ui-handoff.md) 和 [证据设计](docs/evidence-design.md)。
