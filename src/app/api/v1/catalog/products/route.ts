import { formatNaira } from '@/lib/money';
import { listPublishedProducts } from '@/server/catalogue/products';
import { handle, jsonResponse } from '@/server/http/problem';
import { storeAndDb } from '@/server/http/api';

export const dynamic = 'force-dynamic';

// GET /api/v1/catalog/products?limit=  Published products with active variants and prices.
// Stock levels are not included (the public catalogue does not reveal inventory).
export function GET(request: Request) {
  return handle(async () => {
    const { db, store } = await storeAndDb();
    const limitParam = new URL(request.url).searchParams.get('limit');
    const limit = limitParam === null ? undefined : Number(limitParam);
    const products = await listPublishedProducts(db, store.scope, { limit });
    return jsonResponse({
      products: products.map((p) => ({
        ...p,
        variants: p.variants.map((v) => ({ ...v, priceDisplay: formatNaira(v.priceMinor) })),
      })),
    });
  });
}
