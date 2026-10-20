import { formatNaira } from '@/lib/money';
import { getPublishedProductBySlug } from '@/server/catalogue/products';
import { AppError, handle, jsonResponse } from '@/server/http/problem';
import { storeAndDb } from '@/server/http/api';

export const dynamic = 'force-dynamic';

// GET /api/v1/catalog/products/{slug}
export function GET(_request: Request, context: { params: Promise<{ slug: string }> }) {
  return handle(async () => {
    const { slug } = await context.params;
    const { db, store } = await storeAndDb();
    const product = await getPublishedProductBySlug(db, store.scope, slug);
    if (!product) throw new AppError(404, 'product_not_found', 'That product was not found.');
    return jsonResponse({
      product: {
        ...product,
        variants: product.variants.map((v) => ({ ...v, priceDisplay: formatNaira(v.priceMinor) })),
      },
    });
  });
}
