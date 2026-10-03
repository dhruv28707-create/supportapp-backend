import { Request, Response } from 'express';
import { getPlanOptions } from '../constants';

/**
 * GET /api/plans
 *
 * Public pricing catalog for the choice cards shown after the free trial:
 * free, Ultimate Monthly and Ultimate Yearly. No auth — prices are public.
 *
 * The client renders each option as a card and, for the paid ones, passes
 * `tier` to POST /api/payment-order. The free card needs no request: the
 * account stays on free once the trial ends.
 *
 * Prices come from TIER_PRICES so the displayed amount always matches the
 * server-side amount payment-order will actually charge.
 */
export async function plansHandler(_req: Request, res: Response): Promise<void> {
  res.json({
    currency: 'INR',
    options: getPlanOptions(),
  });
}
