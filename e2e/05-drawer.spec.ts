import { expect, test } from '@playwright/test';
import { boot, clickObject, enter, events, expectNoErrors, hook, settle, shot, world } from './helpers';

test('5. opening and closing the drawer', async ({ page }) => {
  await boot(page);
  await enter(page);
  await hook(page, 'look', 0.62, -0.42);
  await settle(page, 600);
  expect((await world(page, 'drawer_top')).open).toBe(0);

  await clickObject(page, 'drawer_top', { look: false });
  await settle(page, 1200); // spring settles
  expect((await world(page, 'drawer_top')).open).toBe(1);
  // The rendered drawer has actually travelled out of the desk.
  await page.waitForFunction(() => (window as any).__wiwy.app.room.parts.drawers.drawer_top.position.z > 0.25, null, { timeout: 15_000 });
  await shot(page, '05-drawer-open');

  await clickObject(page, 'drawer_top', { look: false });
  await settle(page, 1200);
  expect((await world(page, 'drawer_top')).open).toBe(0);
  await page.waitForFunction(() => (window as any).__wiwy.app.room.parts.drawers.drawer_top.position.z < 0.03, null, { timeout: 15_000 });

  const opened = await events(page, 'drawer_opened');
  const closed = await events(page, 'drawer_closed');
  expect(opened).toHaveLength(1);
  expect(closed).toHaveLength(1);
  expect(opened[0].target).toBe('drawer_top');
  // Every event carries camera and room context.
  expect((opened[0] as unknown as { camera: { position: number[] } }).camera.position).toHaveLength(3);
  // Room context is recorded as it stands once the action has taken effect.
  expect((opened[0] as unknown as { context: { drawerOpen: boolean } }).context.drawerOpen).toBe(true);
  expect((closed[0] as unknown as { context: { drawerOpen: boolean } }).context.drawerOpen).toBe(false);
  await shot(page, '05-drawer-closed');
  await expectNoErrors(page);
});
