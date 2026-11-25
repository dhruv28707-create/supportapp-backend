import { Request, Response } from 'express';

/** Reads a positive integer build number from the environment (0 = unset). */
function readBuildNumber(name: string): number {
  const raw = Number(process.env[name]);
  return Number.isInteger(raw) && raw > 0 ? raw : 0;
}

/**
 * GET /api/app-config — public. Lets the app decide whether to show an
 * "Update the app" popup.
 *
 *  - APP_MIN_VERSION_CODE:    builds BELOW this are blocked until updated.
 *  - APP_LATEST_VERSION_CODE: builds below this get a dismissible nudge.
 *  - APP_STORE_URL_ANDROID / APP_STORE_URL_IOS: where the Update button goes.
 *
 * Both build numbers default to 0, so nothing is ever shown until you set
 * them on Vercel. Only raise APP_MIN_VERSION_CODE once the new build is live
 * on the store, or users would be sent to an update that does not exist yet.
 */
export async function appConfigHandler(_req: Request, res: Response): Promise<void> {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    minVersionCode: readBuildNumber('APP_MIN_VERSION_CODE'),
    latestVersionCode: readBuildNumber('APP_LATEST_VERSION_CODE'),
    storeUrls: {
      android:
        process.env.APP_STORE_URL_ANDROID ||
        'https://play.google.com/store/apps/details?id=com.supportapp',
      ios: process.env.APP_STORE_URL_IOS || null,
    },
  });
}