import { expect, test } from '@playwright/test';
import { boot, clickObject, enter, events, expectNoErrors, hook, look, settle, shot, state, waitRig } from './helpers';

test('6. receiving a delayed, accurate behavioral reference', async ({ page }) => {
  await boot(page);
  await enter(page);

  // Ordinary actions, several of which the room may choose to remember.
  await hook(page, 'look', 0.62, -0.42);
  await clickObject(page, 'drawer_top', { look: false });
  await settle(page, 500);
  await clickObject(page, 'drawer_top', { look: false });
  await clickObject(page, 'lamp');
  await clickObject(page, 'curtains');
  await settle(page, 500);
  await clickObject(page, 'clock');
  await waitRig(page, 'inspect');
  await hook(page, 'simulate', 6000); // a long look at the clock
  await page.keyboard.press('Escape');
  await waitRig(page, 'look');
  const actions = await events(page);
  const firstActionAt = Math.min(...actions.filter((e) => e.type !== 'session_started').map((e) => e.timestampMs));

  // Minutes pass in session time while the player looks elsewhere.
  await hook(page, 'forcePhase', 'recognition');
  await look(page, 'mirror');
  let delivered = false;
  for (let i = 0; i < 12 && !delivered; i++) {
    await hook(page, 'simulate', 30_000);
    const r = await hook<{ ok: boolean; reason: string }>(page, 'forceGated', 'callback_message');
    if (r.ok) await hook(page, 'simulate', 6000);
    delivered = (await state(page)).messages.some((m) => m.templateId === 'callback');
  }
  expect(delivered).toBe(true);
  const s = await state(page);
  const msg = s.messages.find((m) => m.templateId === 'callback')!;

  // The reference is delayed and points at an event that really happened.
  expect(msg.createdAt - firstActionAt).toBeGreaterThanOrEqual(140_000);
  expect(msg.refs.length).toBeGreaterThan(0);
  const all = await events(page);
  for (const ref of msg.refs) {
    const e = all.find((x) => x.id === ref);
    expect(e, `event ${ref} referenced by "${msg.text}"`).toBeTruthy();
    expect(e!.timestampMs).toBeLessThanOrEqual(msg.createdAt - 140_000);
  }

  // It is shown on the in-room computer.
  await clickObject(page, 'computer');
  await waitRig(page, 'inspect');
  await settle(page, 800);
  await shot(page, '06-callback-on-computer');
  const notes = await page.evaluate(() => (window as any).__wiwy.app.session.screen.notes.map((n: { body: string[] }) => n.body.join(' ')) as string[]);
  expect(notes.some((b) => b.includes(msg.text))).toBe(true);
  await expectNoErrors(page);
});
