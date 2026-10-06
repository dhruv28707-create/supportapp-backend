import { Request, Response } from 'express';
import { getPlanOptions } from '../constants';

/**
 * GET /api/plans — public pricing catalog (free, Ultimate Monthly, Yearly).
 * Paid options pass `tier` to POST /api/payment-order. Prices come from
 * TIER_PRICES so display always matches the charge.
 */
export async function plansHandler(_req: Request, res: Response): Promise<void> {
  res.json({
    currency: 'INR',
    options: getPlanOptions(),
  });
}
