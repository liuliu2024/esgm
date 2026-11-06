# 官方因子参考目录

首批支持专业人员核对全国电力因子的发布口径和数据年份。目录中的条目由迁移写入，服务只读。计算预览、冻结快照和演示稿沿用各自原有的合成模型。

| 核算用途 | 数据年份 | 地域 | 数值和单位 | 发布原文 |
| --- | --- | --- | --- | --- |
| `product_footprint` 产品电力碳足迹 | 2024 | `CN` | 0.5777 kgCO2e/kWh | [2025 年第 19 号公告附件表 1](https://www.mee.gov.cn/xxgk2018/xxgk/xxgk01/202510/W020251024569470952545.pdf) |
| `organization_electricity_co2` 电力消费二氧化碳排放 | 2023 | `CN` | 0.5306 kgCO2/kWh | [2025 年第 47 号公告附件表 1](https://www.mee.gov.cn/xxgk2018/xxgk/xxgk01/202512/W020251231726284332528.pdf) |

## API

`GET /v1/professional/factor-references?orgId=<UUID>&accountingBasis=product_footprint&regionCode=CN&dataYear=2024`

四个参数必填。调用方须在当前租户对该组织持有有效复核授权。按核算用途、地域和数据年份精确匹配，缺项返回 `{ "items": [] }`，调用方据此继续核对来源。每个条目返回 `factorId`、`version`、`accountingBasis`、`regionCode`、`dataYear`、`value`、`inputUnit`、`outputUnit`、`sourceTitle`、`sourceUrl`、`sourceLocator` 和 `usageNote`。`value` 使用十进制字符串。

## 版本与验收

- 因子版本与数据年份分别记录。后续修订使用新版本，保留原版本的数值、单位和原文定位。
- 应用数据库角色只读。组织授权在服务边界判断，公共参考条目本身不含客户数据。
- 检查用途、年份、地域精确匹配及授权撤销。产品足迹的 `kgCO2e` 与购电二氧化碳的 `kgCO2` 分别展示。
- 正式计算接入须先确认方法、适用地域和期间、使用条款及审批责任，再在计算明细中固定版本。采购方报告还须经过独立审批和明确的收件授权。

参照 Brightway 数据包对版本和数据许可的拆分，以及 Electricity Maps 对地域和因子来源的区分。前者面向生命周期评价矩阵，后者面向电网数据与流追踪。目录采用现有 PostgreSQL 和迁移机制，仅借鉴元数据设计。[Brightway bw_processing](https://github.com/brightway-lca/bw_processing) · [Electricity Maps](https://github.com/electricitymaps/electricitymaps-contrib)
