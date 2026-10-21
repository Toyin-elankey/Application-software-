import { z } from 'zod';
import { findOrderForCustomer } from '@/server/customers/auth';
import { accessesFromCookies } from '@/server/customers/sessions';
import { OrderNumberSchema } from '@/server/customers/schema';
import { buildOrderView, buildPaymentView } from '@/server/orders/view';
import { AppError, handle, jsonResponse } from '@/server/http/problem';
import { storeAndDb } from '@/server/http/api';

export const dynamic = 'force-dynamic';

const Params = z.object({ orderNumber: OrderNumberSchema });

// GET /api/v1/orders/{orderNumber}. Needs a sign-in session (the customer's own orders) or a lookup session
// for this order. Without either: 401. Someone else's order, or one that does not exist: 404.
export function GET(request: Request, context: { params: Promise<{ orderNumber: string }> }) {
  return handle(async () => {
    const { orderNumber } = Params.parse(await context.params);
    const { db, store } = await storeAndDb();
    const accesses = await accessesFromCookies(db, store.scope.businessId, request.headers.get('cookie'));
    if (accesses.length === 0) {
      throw new AppError(401, 'unauthenticated', 'Sign in, or enter the code sent to the phone on the order, to see it.');
    }

    const order = await findOrderForCustomer(db, store.scope, accesses, orderNumber);
    const view = await buildOrderView(db, store.scope, order.id);
    const payment = await buildPaymentView(db, store.scope, order.id);
    const timeline = await db.orderStatusEvent.findMany({
      where: { orderId: order.id },
      orderBy: { createdAt: 'asc' },
      select: { toStatus: true, createdAt: true },
    });

    return jsonResponse(
      {
        order: view,
        // Customer view: no provider checkout link here (that belongs to the payment retry endpoint).
        payment: payment && { status: payment.status, amountMinor: payment.amountMinor, amountDisplay: payment.amountDisplay },
        // Status and time only. Staff reasons and actors are never shown to customers.
        timeline: timeline.map((event) => ({ status: event.toStatus, at: event.createdAt.toISOString() })),
      },
      200,
    );
  });
}
