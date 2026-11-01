import { login } from "../sync-worker/src/index.mjs";
import {
  parseCatalog,
  parseProductDocuments,
} from "../sync-worker/src/parser.mjs";

if (!process.env.UROVO_MEMBER || !process.env.UROVO_PASSWORD) {
  throw new Error("UROVO_MEMBER and UROVO_PASSWORD are required.");
}

const cookie = await login(process.env);
const response = await fetch(
  `https://file.en.urovo.com/Index/index.html?_probe=${crypto.randomUUID()}`,
  {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      Cookie: cookie,
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      "User-Agent": "Urovo-Library-Sync/1.0",
    },
    cache: "no-store",
    redirect: "manual",
  },
);
const html = await response.text();
const catalog = parseCatalog(html);
const parsedProducts = [];

for (let index = 0; index < catalog.products.length; index += 4) {
  const group = catalog.products.slice(index, index + 4);
  const results = await Promise.all(
    group.map(async (product) => {
      const productUrl = new URL(product.sourcePageUrl);
      productUrl.searchParams.set("_probe", crypto.randomUUID());
      const productResponse = await fetch(productUrl, {
        headers: {
          Accept: "text/html,application/xhtml+xml",
          Cookie: cookie,
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
          "User-Agent": "Urovo-Library-Sync/1.0",
        },
        cache: "no-store",
        redirect: "manual",
      });
      const productHtml = await productResponse.text();
      const parsed = parseProductDocuments(productHtml, product);

      return {
        product: product.product,
        status: productResponse.status,
        recognized: parsed.recognized,
        records: parsed.records.length,
      };
    }),
  );

  parsedProducts.push(...results);
}

const failures = parsedProducts.filter(
  (product) => product.status !== 200 || !product.recognized,
);
const recordCount = parsedProducts.reduce(
  (total, product) => total + product.records,
  0,
);

console.log(
  JSON.stringify(
    {
      cookieNames: cookie
        .split(/;\s*/)
        .map((item) => item.slice(0, item.indexOf("="))),
      responseStatus: response.status,
      redirectLocation: response.headers.get("location"),
      responseLength: html.length,
      containsLoginText: /\/Login\/index\.html|UROVO Internal database/i.test(
        html,
      ),
      catalogRecognized: catalog.recognized,
      productCount: catalog.products.length,
      sampleProducts: catalog.products.slice(0, 5).map((item) => item.product),
      parsedProductCount: parsedProducts.length,
      recordCount,
      failureCount: failures.length,
      failures,
    },
    null,
    2,
  ),
);
