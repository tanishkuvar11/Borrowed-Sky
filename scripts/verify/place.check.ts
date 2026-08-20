/**
 * The timezone comparison behind the plate's "clocks shown in..." note.
 *
 * This exists because the obvious version of the check was wrong, shipped, and
 * was caught only by looking at a screenshot. Every clock in the app is drawn
 * in the device's zone, so the plate says so when the observer is somewhere
 * else; the first version decided "somewhere else" by comparing the two zone
 * names. Browsers still report plenty of legacy aliases, so a phone in India
 * reports Asia/Calcutta where the lookup returns Asia/Kolkata, and a person
 * sitting at home was told their own clock disagreed with their own location.
 *
 * A wrong warning is worse than no warning: it is the app confidently
 * contradicting something the user can see is fine. So the comparison is on
 * what the zones are actually set to at that moment, and the cases below are
 * the ones that make that distinction visible.
 *
 * No network and no third party here. The lookup those names come from is
 * checked by using it; this checks the arithmetic done to the answer.
 *
 * Run: npx tsx scripts/verify/place.check.ts
 */

const failures: string[] = [];

function check(label: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

/**
 * Node applies a change to process.env.TZ to Dates made afterwards, which is
 * what lets one process stand in for devices in several places. Asserted
 * rather than assumed, because every case below is meaningless if it stops
 * being true and they would all quietly pass.
 */
function setDeviceZone(zone: string) {
  process.env.TZ = zone;
}

async function main() {
  const { clockDiffersFrom, offsetMinutes } = await import('../../src/lib/place.ts');

  // A moment in northern summer, so the zones that observe summer time are
  // observing it. Fixed rather than "now" so this reads the same in January.
  const summer = new Date('2026-08-20T12:00:00Z');
  // ...and one in northern winter, for the same zones off it.
  const winter = new Date('2026-01-20T12:00:00Z');

  console.log('\noffsets read out of the zone database');
  check('India is five and a half hours east', offsetMinutes('Asia/Kolkata', summer) === 330);
  check('its legacy alias agrees', offsetMinutes('Asia/Calcutta', summer) === 330);
  check('UTC is zero', offsetMinutes('UTC', summer) === 0);
  check(
    'Newfoundland is two and a half hours west in winter',
    offsetMinutes('America/St_Johns', winter) === -210,
    String(offsetMinutes('America/St_Johns', winter)),
  );
  check(
    'and three and a half in summer',
    offsetMinutes('America/St_Johns', summer) === -150,
    String(offsetMinutes('America/St_Johns', summer)),
  );
  check(
    'London is on the meridian in winter and an hour off it in summer',
    offsetMinutes('Europe/London', winter) === 0 && offsetMinutes('Europe/London', summer) === 60,
  );
  check('an unknown zone is not guessed at', offsetMinutes('Mars/Olympus_Mons', summer) === null);

  console.log('\na device in India');
  setDeviceZone('Asia/Calcutta');
  check(
    'TZ is honoured, so these cases mean something',
    new Date().getTimezoneOffset() === -330,
    String(new Date().getTimezoneOffset()),
  );
  check(
    'is not told its own clock is wrong (the bug this file exists for)',
    clockDiffersFrom('Asia/Kolkata', summer) === false,
  );
  check('is told about Johannesburg', clockDiffersFrom('Africa/Johannesburg', summer) === true);
  check('is told nothing when the zone is unknown', clockDiffersFrom(null, summer) === false);
  check(
    'is told nothing when the zone did not resolve',
    clockDiffersFrom('Mars/Olympus_Mons', summer) === false,
  );

  console.log('\na device in London');
  setDeviceZone('Europe/London');
  check(
    'says nothing about London in summer, when it is on BST',
    clockDiffersFrom('Europe/London', summer) === false,
  );
  check(
    'nor about Dublin, which keeps the same clock under another name',
    clockDiffersFrom('Europe/Dublin', summer) === false,
  );
  check(
    'but does about UTC in summer, because BST is genuinely an hour off it',
    clockDiffersFrom('UTC', summer) === true,
  );
  check(
    'and says nothing about UTC in winter, when they agree',
    clockDiffersFrom('UTC', winter) === false,
  );

  console.log('');
  if (failures.length) {
    console.error(`FAIL  ${failures.length} case(s): ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('PASS  the clock note fires on real differences and not on aliases');
}

main().catch((err) => {
  console.error('place check failed to run:', err);
  process.exit(1);
});
