import { chromium } from 'playwright-core';

const printStyle = `
  body { max-width: none; margin: 0; padding: 0; font-family: "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif; }
  h1, h2, dt { break-after: avoid; }
  tr, dd { break-inside: avoid; }
  thead { display: table-header-group; }
`;

export function createDeliveryPdfRenderer({executablePath}) {
  return async documentHtml => {
    const browser = await chromium.launch({executablePath, headless: true, chromiumSandbox: true, timeout: 10000});
    try {
      const page = await browser.newPage({javaScriptEnabled: false, serviceWorkers: 'block'});
      await page.route('**/*', route => route.abort());
      const printHtml = documentHtml.replace('</style>', () => `${printStyle}</style>`);
      await page.setContent(printHtml, {waitUntil: 'domcontentloaded', timeout: 5000});
      return await page.pdf({
        format: 'A4', printBackground: true, tagged: true,
        margin: {top: '16mm', right: '17mm', bottom: '18mm', left: '17mm'},
        displayHeaderFooter: true, headerTemplate: '<span></span>',
        footerTemplate: '<div style="width:100%;text-align:center;font-size:9px;color:#49615e"><span class="pageNumber"></span> / <span class="totalPages"></span></div>'
      });
    } finally {
      await browser.close();
    }
  };
}
