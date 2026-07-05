import { NextResponse } from 'next/server';
import { z } from 'zod';
import { listAvailableSlots } from '@/data/catalog';
import { errorResponse } from '@/lib/api';

// z.guid() validates the 8-4-4-4-12 shape without enforcing RFC version bits —
// matching Postgres's own uuid acceptance (our seed ids use readable sentinels).
const paramsSchema = z.object({ id: z.guid() });

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const parsed = paramsSchema.safeParse(await ctx.params);
  if (!parsed.success) return errorResponse('VALIDATION_ERROR', 'Doctor id must be a UUID.');
  return NextResponse.json({ slots: await listAvailableSlots(parsed.data.id) });
}
