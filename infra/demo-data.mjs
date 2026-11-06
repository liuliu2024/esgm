import { randomUUID } from 'node:crypto';
import { createEmbeddedDatabase } from './embedded.mjs';
import { migrate } from './migrations.mjs';
import { createCarbonApi } from '../src/index.mjs';

const specialistIntake = [
  {
    code: 'product-footprint-prep',
    catalog: { industryCode: 'manufacturing', industryName: '工业制造', title: '产品碳足迹资料准备',
      purpose: '确认产品型号、功能单位与生命周期边界，整理物料和工序数据', recipient: '产品负责人或指定采购方',
      preparation: {
        materials: ['产品型号、功能单位、产量与统计期间', '物料清单、工序、能源及运输数据', '供应商数据、来源凭证及缺失项'],
        reportRequirements: ['确认产品适用方法及生命周期边界', '说明数据来源、分配方法、假设和限制', '核对报告用途及是否需要独立验证']
      } },
    references: [{ code: 'gbt-24067-2024', title: '产品碳足迹量化要求和指南发布信息', publisher: '生态环境部',
      sourceUrl: 'https://www.mee.gov.cn/xxgk/hjyw/202409/t20240910_1085619.shtml',
      publicationStatus: 'effective',
      scopeNote: '用于了解产品碳足迹通则，具体产品规则和买方要求仍需核对。' }]
  },
  {
    code: 'overseas-report-prep',
    catalog: { industryCode: 'manufacturing', industryName: '工业制造', title: '境外客户报告资料准备',
      purpose: '核对境外买方的模板、报告对象、语言和交付期限', recipient: '境外采购方或其指定接收人',
      preparation: {
        materials: ['买方邮件、原始模板、报告语言和截止日期', '报告对象、数据期间及对应的产品或设施', '拟提供的核算数据、证据和验证要求'],
        reportRequirements: ['确认买方要求的是设施排放、产品足迹、CBAM 数据还是 ESG 问卷', '逐项核对模板、报告范围、数据期间及验证要求', '确认收件授权、披露范围和交付方式']
      } },
    references: [{ code: 'eu-cbam-definitive', title: '欧盟 CBAM 正式阶段指引', publisher: '欧盟委员会税务与海关总司',
      sourceUrl: 'https://taxation-customs.ec.europa.eu/carbon-border-adjustment-mechanism/cbam-definitive-regime_en',
      scopeNote: '买方明确索取 CBAM 数据时查阅。需单独确认商品范围、进口安排和适用义务。' }]
  },
  {
    code: 'verification-prep',
    catalog: { industryCode: 'manufacturing', industryName: '工业制造', title: '碳核查资料准备',
      purpose: '整理待核查报告、原始凭证和数据修订记录', recipient: '企业核查准备团队' },
    references: [{ code: 'cets-steel-verification', title: '企业温室气体排放核查技术指南 钢铁行业',
      publisher: '生态环境部', sourceUrl: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk06/202501/W020250124388843909905.pdf',
      scopeNote: '用于了解全国碳市场钢铁重点排放单位的核查要求。其他行业、产品或项目需分别核对适用依据。' }]
  },
  {
    code: 'compliance-prep',
    catalog: { industryCode: 'manufacturing', industryName: '工业制造', title: '碳履约资料准备',
      purpose: '核对履约期间、市场机制、配额和官方记录', recipient: '企业履约团队' },
    references: [{ code: 'ets-regulation-775', title: '碳排放权交易管理暂行条例',
      publisher: '国务院', sourceUrl: 'https://www.mee.gov.cn/zcwj/gwywj/202610/t20261010_1175967.shtml',
      scopeNote: '用于查阅全国碳市场配额及清缴的制度框架。单位是否纳入和具体期限以适用文件及官方记录为准。' }]
  },
  {
    code: 'zero-carbon-prep',
    catalog: { industryCode: 'buildings', industryName: '建筑物业', title: '零碳管理资料准备',
      purpose: '整理园区或设施边界、用能基线、目标和改造项目', recipient: '设施或园区运营团队' },
    references: [{ code: 'zero-carbon-park-910', title: '关于开展零碳园区建设的通知',
      publisher: '国家发展改革委、工业和信息化部、国家能源局', sourceUrl: 'https://www.ndrc.gov.cn/xxgk/zcfb/tz/202507/t20250708_1399055.html',
      scopeNote: '用于查阅零碳园区建设及申报参考要求。建筑、企业和其他对象应单独核对适用依据。' }]
  },
  {
    code: 'esg-disclosure-prep',
    catalog: { industryCode: 'manufacturing', industryName: '工业制造', title: 'ESG 披露资料准备',
      purpose: '梳理披露期间、适用框架、重要议题及指标证据', recipient: '企业可持续披露团队' },
    references: [{ code: 'sustainability-disclosure-basic', title: '企业可持续披露准则——基本准则（试行）',
      publisher: '财政部等十部门', sourceUrl: 'https://kjs.mof.gov.cn/zhengcefabu/202412/t20241216_3949745.htm',
      publicationStatus: 'pilot',
      scopeNote: '用于整理可持续披露的一般内容。具体适用框架和披露义务按主体、年度及适用规则另行核对。' }]
  },
  {
    code: 'public-institution-inventory-prep',
    catalog: {industryCode: 'public-institutions', industryName: '公共机构', title: '公共机构盘查资料准备',
      purpose: '梳理办公设施边界、统计期间与用能资料', recipient: '公共机构内部管理团队',
      preparation: {
        materials: ['机构及纳入范围的办公设施清单', '电力、燃料与其他用能凭证', '统计期间、边界说明及缺失记录'],
        reportRequirements: ['逐项说明设施与能源的统计范围', '区分账单来源、估算和缺失项', '由专业人员核对适用的盘查方法']
      }},
    references: []
  }
];

export async function startDemo(options) {
  const db = await createEmbeddedDatabase();
  const tenantId = randomUUID();
  const orgId = randomUUID();
  const scenarioReleaseId = randomUUID();
  const actors = { customer: randomUUID(), reviewer: randomUUID(), admin: randomUUID() };
  try {
    await migrate(db.admin);
    await db.admin.transaction(async tx => {
      await tx.query('INSERT INTO carbon.workspace (id, name) VALUES ($1, $2)', [tenantId, '演示工作空间']);
      await tx.query('INSERT INTO carbon.organization (tenant_id, id, name) VALUES ($1, $2, $3)',
        [tenantId, orgId, '演示组织']);
      await tx.query(`INSERT INTO carbon.scenario_release (tenant_id, id, code, version, manifest)
        VALUES ($1, $2, 'carbon-intake', 1, $3), ($1, $4, 'building-inventory', 1, $5)`, [
        tenantId, scenarioReleaseId, { title: '碳业务受理', catalog: {
          industryCode: 'manufacturing', industryName: '工业制造', title: '采购方资料准备',
          purpose: '整理采购方要求的碳资料', recipient: '采购方'
        }, references: [{
          code: 'gbt-24067-2024', title: '产品碳足迹量化要求和指南发布信息', publisher: '生态环境部',
          sourceUrl: 'https://www.mee.gov.cn/xxgk/hjyw/202409/t20240910_1085619.shtml',
          scopeNote: '用于确认产品碳足迹的方法。具体产品及买方要求仍需核对。'
        }, {
          code: 'electricity-pcf-2024', title: '2024 年电力碳足迹因子数据公告',
          publisher: '生态环境部、国家统计局、国家能源局',
          sourceUrl: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk01/202510/t20251024_1130734.html',
          scopeNote: '用于核对产品碳足迹的电力因子口径。'
        }] }, randomUUID(), { catalog: {
          industryCode: 'buildings', industryName: '建筑物业', title: '组织盘查准备',
          purpose: '准备组织盘查的边界和材料', recipient: '内部管理团队'
        }, references: [{
          code: 'electricity-co2-2023', title: '2023 年电力二氧化碳排放因子公告', publisher: '生态环境部、国家统计局',
          sourceUrl: 'https://www.mee.gov.cn/xxgk2018/xxgk/xxgk01/202512/t20251231_1139517.html',
          scopeNote: '用于了解电力消费排放的参考口径。按报告年度、地域和方法确认是否适用。'
        }] }
      ]);
      for (const {code, catalog, references} of specialistIntake) {
        await tx.query(`INSERT INTO carbon.scenario_release (tenant_id, id, code, version, manifest)
          VALUES ($1, $2, $3, 1, $4)`, [tenantId, randomUUID(), code, {catalog, references}]);
      }
      for (const [role, actorId] of Object.entries(actors)) {
        await tx.query('INSERT INTO carbon.org_grant (tenant_id, org_id, actor_id, role) VALUES ($1, $2, $3, $4)',
          [tenantId, orgId, actorId, role]);
      }
    });
    const api = createCarbonApi(db.runtime, options);
    return {
      orgId, scenarioReleaseId,
      dispatch: (role, method, path, body, contentType) => api.dispatch({ method, path, body, contentType }, {
        tenantId, actorId: actors[role], requestId: randomUUID()
      }),
      close: db.close
    };
  } catch (error) {
    await db.close();
    throw error;
  }
}
