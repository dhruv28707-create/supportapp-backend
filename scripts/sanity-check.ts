import { TIER_PRICES, tierToPlan } from '../src/constants';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) failures += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}`);
}

check('pro_monthly = ₹179 (17900)', TIER_PRICES.pro_monthly === 17900);
check('pro_yearly = ₹699 (69900)', TIER_PRICES.pro_yearly === 69900);
check('ultimate_monthly = ₹199 (19900)', TIER_PRICES.ultimate_monthly === 19900);
check('ultimate_yearly = ₹799 (79900)', TIER_PRICES.ultimate_yearly === 79900);
check('tierToPlan pro_monthly -> pro', tierToPlan('pro_monthly') === 'pro');
check('tierToPlan ultimate_yearly -> ultimate', tierToPlan('ultimate_yearly') === 'ultimate');
check('tierToPlan rejects unknown tier', tierToPlan('hacker_tier') === null);
check('tierToPlan rejects uppercase/weird input', tierToPlan('ULTIMATE_MONTHLY') === null);
check('no tier costs 100 paise (₹1)', !(Object.values(TIER_PRICES) as number[]).includes(100));

if (failures > 0) {
  console.error(`${failures} sanity check(s) FAILED`);
  process.exit(1);
}
console.log('All sanity checks passed');
