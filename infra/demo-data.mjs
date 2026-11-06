import { randomUUID } from 'node:crypto';
import { createEmbeddedDatabase } from './embedded.mjs';
import { migrate } from './migrations.mjs';
import { createCarbonApi } from '../src/index.mjs';

const specialistIntake = [
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
      scopeNote: '用于整理可持续披露的一般内容。具体适用框架和披露义务按主体、年度及适用规则另行核对。' }]
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
