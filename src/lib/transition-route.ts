import { NextResponse } from 'next/server';
import { z } from 'zod';
import { transitionBooking } from '@/data/bookings';
import { errorResponse } from '@/lib/api';

const paramsSchema = z.object({ id: z.guid() });

export function transitionRoute(event: 'confirm' | 'cancel' | 'complete') {
  return async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
    const parsed = paramsSchema.safeParse(await ctx.params);
    if (!parsed.success) return errorResponse('BOOKING_NOT_FOUND');

    const result = await transitionBooking({ bookingId: parsed.data.id, event });
    if (!result.ok) return errorResponse(result.code);
    return NextResponse.json({ booking: result.booking });
  };
}
