import { randomUUID } from 'node:crypto';
import { createEmbeddedDatabase } from './embedded.mjs';
import { migrate } from './migrations.mjs';
import { createCarbonApi } from '../src/index.mjs';

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
