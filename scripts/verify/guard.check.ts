/**
 * The two crude defences on the public endpoints, checked against what they
 * actually claim rather than against what would be nice.
 *
 * This file exists partly to keep the claims honest. It is easy to add a
 * throttle and a header check and then describe the result as "secured", and
 * the cases below are written so that anybody reading them can see the exact
 * shape of what is and is not prevented: the origin check is inert until it is
 * configured, it passes anything with no Origin header at all, and the throttle
 * counts per address in the memory of one instance.
 *
 * Run: npx tsx scripts/verify/guard.check.ts
 */

import type { ApiRequest } from '../../api/_lib/http.ts';
import {
  clientIp,
  createBucket,
  originAllowed,
  tooManyFrom,
} from '../../api/_lib/guard.ts';

const failures: string[] = [];

function check(label: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

/** Just enough of a request for the guard to read headers off. */
function request(headers: Record<string, string>): ApiRequest {
  return { headers, on: () => {} } as unknown as ApiRequest;
}

console.log('\nthe origin check, unconfigured');
delete process.env.ALLOWED_ORIGINS;
check(
  'lets everything through when nothing is configured',
  originAllowed(request({ origin: 'https://anywhere.example' })) === true,
);
check(
  'which is the permissive default, on purpose',
  originAllowed(request({})) === true,
);

console.log('\nand configured');
process.env.ALLOWED_ORIGINS = 'https://borrowed-sky.example, https://tunnel.example';
check(
  'allows a listed origin',
  originAllowed(request({ origin: 'https://borrowed-sky.example' })) === true,
);
check(
  'allows another listed origin, so the list is really a list',
  originAllowed(request({ origin: 'https://tunnel.example' })) === true,
);
check(
  'ignores a trailing slash rather than failing on one',
  originAllowed(request({ origin: 'https://borrowed-sky.example/' })) === true,
);
check(
  'refuses a site that is not on it',
  originAllowed(request({ origin: 'https://someone-elses-page.example' })) === false,
);
check(
  'refuses a lookalike rather than matching on a prefix',
  originAllowed(request({ origin: 'https://borrowed-sky.example.attacker.test' })) === false,
);

/*
 * The documented hole, asserted rather than left implied.
 *
 * A browser sets Origin on the cross-site requests this is meant to stop and
 * will not let script forge it. Anything that is not a browser simply leaves it
 * off, and this lets that through. That is a deliberate choice, because the
 * alternative breaks every server-side and command-line caller for no gain
 * against an attacker who can set headers freely. It is checked here so nobody
 * can later describe this as authentication.
 */
check(
  'still lets a caller with no Origin header through, which is the known limit',
  originAllowed(request({})) === true,
);

console.log('\nthe throttle');
{
  const bucket = createBucket();
  const ip = '203.0.113.7';
  let refusedAt = 0;
  for (let i = 1; i <= 12; i++) {
    if (tooManyFrom(bucket, ip, 10, 60_000)) {
      refusedAt = i;
      break;
    }
  }
  check('lets the allowance through and refuses after it', refusedAt === 11, `refused at ${refusedAt}`);

  const other = '198.51.100.2';
  check(
    'counts each address separately, so one caller cannot lock out the rest',
    tooManyFrom(bucket, other, 10, 60_000) === false,
  );

  const expiring = createBucket();
  tooManyFrom(expiring, ip, 1, 1);
  // The window is a millisecond wide, so by now it has passed.
  const past = Date.now();
  while (Date.now() === past) {
    /* wait out the millisecond */
  }
  check(
    'forgets hits once their window has passed',
    tooManyFrom(expiring, ip, 1, 1) === false,
  );
}

console.log('\nreading the caller address');
check(
  'takes the first entry of x-forwarded-for, which is the client at the edge',
  clientIp(request({ 'x-forwarded-for': '203.0.113.7, 70.41.3.18' })) === '203.0.113.7',
);
check(
  'falls back to x-real-ip',
  clientIp(request({ 'x-real-ip': '203.0.113.9' })) === '203.0.113.9',
);
check('and to a constant when there is nothing', clientIp(request({})) === 'local');

console.log('');
if (failures.length) {
  console.error(`FAIL  ${failures.length} case(s): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('PASS  the guards do what they claim, including the parts they do not claim');
