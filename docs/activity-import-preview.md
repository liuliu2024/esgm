# 活动数据表格预检首片

需求来源为附件 02 的 DAT03 至 DAT06 和研发交接 RQ02。本片先验证表格边界及数据质量提示，后续把同一预检结果接入批次、原子确认、数据修订和问题闭环。

## 接口及数据

`POST /v1/customer/cases/:id/imports/preview` 接收 `{orgId,csv}`。企业成员只能在本人有权编辑的草稿或退回任务预检。UTF-8 CSV 首版固定列 `period,source,quantity,unit`。`period` 为有效的 `YYYY-MM`，来源暂支持 `electricity` 和 `natural_gas`，分别允许 `kWh` 或 `MWh`、`m3`。数量保留十进制字符串，空值为缺失，真实零保留，`MWh` 精确换算为 `kWh`。同期间和来源重复会阻断。

响应含 `status`（`ready` 或 `blocked`）、`summary`、`issues` 及合法行 `preview`。问题返回行、列、稳定错误代码、严重性和修正提示。预检无业务写入，后续的入账端点需要批次、预检修订、对象授权及可追溯证据。该切片用小型合成 CSV，演示 JSON 请求保持 8192 字节限制。批量正式接入按持久隔离存储与作业方式另行验收。

## 技术依据和验收

比较了 `csv-parse` 与 Papa Parse，两者均采用 MIT 许可证。Papa Parse 提供浏览器和 Node 流式能力、分隔符探测与结构化错误。官方 FAQ 记录了 Excel 文件的编码差异。`csv-parse` 提供 Node ESM 同步入口、列数检查和行号信息，历史版本修复过重复列与自动转换缺陷。首片固定分隔符及表头，选用 `csv-parse@7.0.3` 解析受限的小请求并识别 UTF-8 BOM，数量保留文本，业务单位及期间规则由本服务持有。较大文件采用异步或流式处理，并单独验证解析异常和恢复。 [csv-parse 配置](https://csv.js.org/parse/options/) · [csv-parse 版本历史](https://csv.js.org/parse/changelog/) · [csv-parse 许可证](https://github.com/adaltas/node-csv/blob/master/LICENSE) · [Papa Parse FAQ](https://www.papaparse.com/faq) · [Papa Parse 许可证](https://github.com/mholt/PapaParse/blob/master/LICENSE)

验收以 `0`、空值、`1 MWh`、`1000 kWh`、燃气错单位、月份无效、重复行和引号不闭合为输入，区分缺失和真实值，校验等量换算并定位错误。验证同租户其他客户、异组织、跨租户和已提交任务的拒绝。预检前后任务修订与审计记录一致。
