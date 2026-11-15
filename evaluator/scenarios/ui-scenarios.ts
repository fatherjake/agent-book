/**
 * Hidden deterministic Playwright UI scenarios.
 *
 * Every scenario starts from a fresh database (app.resetDb), seeds fixtures via the API, drives the
 * UI exclusively through the accessible-name contract (getByRole / names), and after each UI action
 * verifies the result independently through the API (host fetch) AND the SQLite DB — not just the DOM.
 *
 * Dev and holdout suites use different fixture sets, titles and operation orders (see fixtures.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Browser, Page } from 'playwright';
import type { CheckResult } from '../../runner/types.js';
import type { LaunchedApp } from '../app-launcher.js';
import { assert, assertEq, AssertionFailure, isInfraError, runCheck, sleep, waitFor } from '../checks.js';
import { seedTodos, type ApiTodo, type FixtureTodo, type ScenarioVariant } from '../fixtures.js';
import {
  addButton,
  deleteButton,
  editButton,
  editInput,
  expectAlert,
  expectBackend,
  expectCounter,
  expectUi,
  filterButton,
  hasLineThrough,
  newTodoInput,
  openPage,
  pressedFilter,
  toggle,
  uiTodos,
  visibleAlertText,
  waitForLoaded,
  type ViewportName,
} from '../ui-helpers.js';

export interface UiScenarioContext {
  app: LaunchedApp;
  browser: Browser;
  variant: ScenarioVariant;
  /** Directory for screenshots (created if missing). */
  screenshotDir: string;
  /** Only run scenarios whose id is in this list (for debugging). */
  only?: string[];
}

interface Session {
  page: Page;
  app: LaunchedApp;
  v: ScenarioVariant;
  seeded: ApiTodo[];
  /** Current expected state (mirrors what API/DB/UI must show). */
  state: FixtureTodo[];
}

interface Scenario {
  id: string;
  mandatory: boolean;
  viewport?: ViewportName;
  seed: (v: ScenarioVariant) => FixtureTodo[];
  /** Install routes etc. before the first navigation. */
  beforeGoto?: (page: Page) => Promise<void>;
  /** Skip the default "wait until loaded" step. */
  noWait?: boolean;
  run: (s: Session) => Promise<string | void>;
}

const ERROR_BODY = JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Simulated server failure' } });

/** Fail mutations matching `method` with HTTP 500 (or a network abort). Returns an unroute fn. */
async function faultInject(page: Page, method: string, mode: '500' | 'abort'): Promise<() => Promise<void>> {
  const handler = async (route: import('playwright').Route) => {
    if (route.request().method() !== method) return route.fallback();
    if (mode === 'abort') return route.abort('failed');
    return route.fulfill({ status: 500, contentType: 'application/json', body: ERROR_BODY });
  };
  await page.route('**/api/todos**', handler);
  return () => page.unroute('**/api/todos**', handler);
}

const active = (s: FixtureTodo[]) => s.filter((t) => !t.completed);
const done = (s: FixtureTodo[]) => s.filter((t) => t.completed);
const clone = (s: FixtureTodo[]) => s.map((t) => ({ ...t }));

/** After a UI mutation, check UI, API and DB all agree with the expected state. */
async function verifyAll(s: Session, what: string): Promise<void> {
  await expectBackend(s.app, s.state, what);
  // UI (filter All assumed)
  await expectUi(s.page, s.state, what);
  await expectCounter(s.page, active(s.state).length, what);
}

async function createViaUi(page: Page, title: string, how: 'enter' | 'click' = 'enter'): Promise<void> {
  const input = newTodoInput(page);
  await input.fill(title);
  if (how === 'enter') await input.press('Enter');
  else await addButton(page).click();
}

/** Keyboard helper: press Tab until `target` has focus. */
async function tabTo(page: Page, target: import('playwright').Locator, what: string, max = 40): Promise<void> {
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return;
    await page.keyboard.press('Tab');
  }
  if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return;
  throw new AssertionFailure(`${what} is not reachable with the Tab key (${max} presses)`);
}

async function isFocused(loc: import('playwright').Locator): Promise<boolean> {
  return loc.evaluate((el) => el === document.activeElement).catch(() => false);
}

/** Assert that during `ms` nothing with `title` appears in the UI (no phantom success). */
async function expectNoPhantom(page: Page, title: string, what: string, ms = 1200): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const ui = await uiTodos(page);
    if (ui.some((t) => t.title === title)) throw new AssertionFailure(`${what}: UI shows "${title}" although the server rejected it`);
    await sleep(150);
  }
}

// ---------------------------------------------------------------------------
// Scenario definitions
// ---------------------------------------------------------------------------

export function buildScenarios(): Scenario[] {
  return [
    {
      id: 'ui.initial_render',
      mandatory: true,
      seed: (v) => v.mixedSet,
      async run(s) {
        assert(await s.page.getByRole('heading', { level: 1, name: 'Todos', exact: true }).isVisible(), 'h1 "Todos" not visible');
        assert(await newTodoInput(s.page).isVisible(), 'textbox "New todo" not visible');
        assert(await addButton(s.page).isVisible(), 'button "Add" not visible');
        for (const f of ['All', 'Active', 'Completed'] as const) {
          assert(await filterButton(s.page, f).isVisible(), `filter button "${f}" not visible`);
        }
        assertEq(await pressedFilter(s.page), ['All'], 'filters with aria-pressed="true" on first load');
        await expectUi(s.page, s.state, 'initial list (order = createdAt asc)');
        await expectCounter(s.page, active(s.state).length, 'initial counter');
        for (const t of s.state) {
          assert(await editButton(s.page, t.title).isVisible(), `button "Edit ${t.title}" not visible`);
          assert(await deleteButton(s.page, t.title).isVisible(), `button "Delete ${t.title}" not visible`);
          const lt = await hasLineThrough(s.page, t.title);
          assert(lt === t.completed, `"${t.title}" ${t.completed ? 'is completed but not' : 'is active but'} shown with line-through`);
        }
      },
    },
    {
      id: 'ui.create.enter',
      mandatory: true,
      seed: (v) => v.baseSet,
      async run(s) {
        const title = s.v.titles.create;
        await createViaUi(s.page, title, 'enter');
        s.state.push({ title, completed: false });
        await verifyAll(s, 'after creating with Enter');
        await waitFor(async () => (await newTodoInput(s.page).inputValue()) === '', 'New todo input should be cleared after a successful create');
        const api = await expectBackend(s.app, s.state, 'created todo');
        const created = api.find((t) => t.title === title)!;
        assert(Math.abs(Date.parse(created.createdAt) - Date.now()) < 10 * 60_000, 'createdAt of the UI-created todo is not current');
      },
    },
    {
      id: 'ui.create.button',
      mandatory: true,
      seed: () => [],
      async run(s) {
        await createViaUi(s.page, `  ${s.v.titles.create2}  `, 'click');
        s.state.push({ title: s.v.titles.create2, completed: false });
        await verifyAll(s, 'after creating with the Add button (title trimmed)');
        await waitFor(async () => (await newTodoInput(s.page).inputValue()) === '', 'New todo input should be cleared');
      },
    },
    {
      id: 'ui.edit.save',
      mandatory: true,
      seed: (v) => [...v.baseSet, { title: v.titles.editFrom, completed: false }],
      async run(s) {
        const { editFrom, editTo } = s.v.titles;
        await editButton(s.page, editFrom).click();
        const input = editInput(s.page);
        await input.waitFor({ state: 'visible' });
        assertEq(await input.inputValue(), editFrom, '"Edit title" input prefilled value');
        await input.fill(editTo);
        await input.press('Enter');
        s.state = s.state.map((t) => (t.title === editFrom ? { ...t, title: editTo } : t));
        await verifyAll(s, 'after editing with Enter');
        await waitFor(async () => (await editInput(s.page).count()) === 0, 'edit mode should close after saving');
        // Second edit, this time with the Save button, back to the original title.
        await editButton(s.page, editTo).click();
        await editInput(s.page).fill(`${editFrom} `);
        await s.page.getByRole('button', { name: 'Save', exact: true }).click();
        s.state = s.state.map((t) => (t.title === editTo ? { ...t, title: editFrom } : t));
        await verifyAll(s, 'after editing with the Save button');
      },
    },
    {
      id: 'ui.edit.cancel',
      mandatory: true,
      seed: (v) => [{ title: v.titles.editFrom, completed: false }, ...v.baseSet],
      async run(s) {
        const { editFrom, editTo } = s.v.titles;
        await editButton(s.page, editFrom).click();
        await editInput(s.page).fill(editTo);
        await editInput(s.page).press('Escape');
        await waitFor(async () => (await editInput(s.page).count()) === 0, 'Escape should leave edit mode');
        await verifyAll(s, 'after cancelling an edit with Escape');
        // Cancel button
        await editButton(s.page, editFrom).click();
        await editInput(s.page).fill(editTo);
        await s.page.getByRole('button', { name: 'Cancel', exact: true }).click();
        await waitFor(async () => (await editInput(s.page).count()) === 0, 'Cancel should leave edit mode');
        await verifyAll(s, 'after cancelling an edit with the Cancel button');
      },
    },
    {
      id: 'ui.complete',
      mandatory: true,
      seed: (v) => [...v.baseSet.map((t) => ({ ...t })), { title: v.titles.complete, completed: false }],
      async run(s) {
        const t = s.v.titles.complete;
        await toggle(s.page, t).click();
        s.state = s.state.map((x) => (x.title === t ? { ...x, completed: true } : x));
        await verifyAll(s, 'after completing');
        assert(await toggle(s.page, t).isChecked(), 'checkbox should be checked');
        await waitFor(() => hasLineThrough(s.page, t), `completed "${t}" should be shown with line-through`);
      },
    },
    {
      id: 'ui.reopen',
      mandatory: true,
      seed: (v) => [{ title: v.titles.reopen, completed: true }, ...v.baseSet],
      async run(s) {
        const t = s.v.titles.reopen;
        assert(await toggle(s.page, t).isChecked(), 'seeded completed todo should be checked');
        await toggle(s.page, t).click();
        s.state = s.state.map((x) => (x.title === t ? { ...x, completed: false } : x));
        await verifyAll(s, 'after reopening');
        await waitFor(async () => !(await hasLineThrough(s.page, t)), `reopened "${t}" should not be line-through`);
      },
    },
    {
      id: 'ui.delete',
      mandatory: true,
      seed: (v) => [{ title: v.titles.keep, completed: false }, { title: v.titles.remove, completed: true }, ...v.baseSet],
      async run(s) {
        await deleteButton(s.page, s.v.titles.remove).click();
        s.state = s.state.filter((x) => x.title !== s.v.titles.remove);
        await verifyAll(s, 'after deleting');
      },
    },
    {
      id: 'ui.filters',
      mandatory: true,
      seed: (v) => v.mixedSet,
      async run(s) {
        const n = active(s.state).length;
        for (const [f, expect] of [
          ['Active', active(s.state)],
          ['Completed', done(s.state)],
          ['All', s.state],
          ['Completed', done(s.state)],
          ['Active', active(s.state)],
        ] as const) {
          await filterButton(s.page, f).click();
          await waitFor(async () => (await pressedFilter(s.page)).join() === f, `only "${f}" should have aria-pressed="true"`);
          await expectUi(s.page, expect, `filter ${f}`);
          await expectCounter(s.page, n, `counter under filter ${f}`);
        }
        // Completing an item while "Active" is selected removes it from the visible list.
        const first = active(s.state)[0];
        await toggle(s.page, first.title).click();
        s.state = s.state.map((x) => (x.title === first.title ? { ...x, completed: true } : x));
        await expectUi(s.page, active(s.state), 'Active filter after completing an item');
        await expectCounter(s.page, n - 1, 'counter after completing under Active');
        await expectBackend(s.app, s.state, 'after completing under Active');
      },
    },
    {
      id: 'ui.counter_and_empty_state',
      mandatory: true,
      seed: (v) => [{ title: v.titles.complete, completed: false }],
      async run(s) {
        await expectCounter(s.page, 1, 'one active todo');
        await filterButton(s.page, 'Completed').click();
        await waitFor(async () => (await uiTodos(s.page)).length === 0, 'Completed filter should show no items');
        await waitFor(async () => s.page.getByText('No todos', { exact: true }).isVisible(), '"No todos" empty state under Completed');
        await filterButton(s.page, 'All').click();
        await toggle(s.page, s.v.titles.complete).click();
        s.state = [{ title: s.v.titles.complete, completed: true }];
        await verifyAll(s, 'all completed');
        await expectCounter(s.page, 0, 'all completed');
        for (const t of [s.v.titles.create, s.v.titles.create2]) {
          await createViaUi(s.page, t);
          s.state.push({ title: t, completed: false });
          await verifyAll(s, `after creating "${t}"`);
        }
        await expectCounter(s.page, 2, 'two active');
        for (const t of [s.v.titles.complete, s.v.titles.create, s.v.titles.create2]) {
          await deleteButton(s.page, t).click();
          s.state = s.state.filter((x) => x.title !== t);
          await verifyAll(s, `after deleting "${t}"`);
        }
        await waitFor(async () => s.page.getByText('No todos', { exact: true }).isVisible(), '"No todos" when the list is empty');
        await expectCounter(s.page, 0, 'empty list');
      },
    },
    {
      id: 'ui.persistence.reload',
      mandatory: true,
      seed: (v) => v.baseSet,
      async run(s) {
        const t = s.v.titles.persist;
        await createViaUi(s.page, t);
        await toggle(s.page, t).click();
        s.state.push({ title: t, completed: true });
        await verifyAll(s, 'before reload');
        await s.page.reload({ waitUntil: 'networkidle' });
        await waitForLoaded(s.page, s.state.length);
        await verifyAll(s, 'after reload');
        assert(await toggle(s.page, t).isChecked(), `"${t}" should still be checked after reload`);
        // A brand-new browser context (no storage) must show the same data: state lives on the server.
        const ctx2 = await s.page.context().browser()!.newContext({ viewport: { width: 1280, height: 800 } });
        try {
          const p2 = await ctx2.newPage();
          await p2.goto(s.app.url, { waitUntil: 'networkidle' });
          await waitForLoaded(p2, s.state.length);
          await expectUi(p2, s.state, 'fresh browser context');
        } finally {
          await ctx2.close();
        }
      },
    },
    ...(['empty', 'whitespace', 'too_long'] as const).map(
      (kind): Scenario => ({
        id: `ui.validation.${kind}`,
        mandatory: true,
        seed: (v) => v.baseSet,
        async run(s) {
          const value = kind === 'empty' ? '' : kind === 'whitespace' ? '     ' : s.v.tooLongTitle;
          const input = newTodoInput(s.page);
          await input.fill(value);
          const actual = await input.inputValue();
          assert(
            actual === value,
            kind === 'too_long'
              ? `the input truncated an over-long title to ${[...actual].length} chars (maxlength/silent truncation is forbidden; show an error instead)`
              : `input value changed while typing (${JSON.stringify(actual)})`,
          );
          await input.press('Enter');
          await expectAlert(s.page, `submitting ${kind} title`);
          await sleep(500);
          await expectBackend(s.app, s.state, `no todo created for ${kind} title`);
          await expectUi(s.page, s.state, `no todo shown for ${kind} title`);
          assertEq(await input.inputValue(), value, "the user's text must stay in the input after a validation error");
          // Still usable: a valid create works afterwards.
          await createViaUi(s.page, s.v.titles.create);
          s.state.push({ title: s.v.titles.create, completed: false });
          await verifyAll(s, 'valid create after a validation error');
        },
      }),
    ),
    {
      id: 'ui.api_error.create',
      mandatory: true,
      seed: (v) => v.baseSet,
      async run(s) {
        const t = s.v.titles.error;
        const unroute = await faultInject(s.page, 'POST', '500');
        await createViaUi(s.page, t);
        await expectAlert(s.page, 'POST returned 500');
        await expectNoPhantom(s.page, t, 'failed create');
        await expectBackend(s.app, s.state, 'DB unchanged after failed create');
        await unroute();
        // Recovery: retry the same action.
        const input = newTodoInput(s.page);
        if ((await input.inputValue()).trim() !== t) await input.fill(t);
        await input.press('Enter');
        s.state.push({ title: t, completed: false });
        await verifyAll(s, 'create after the server recovered');
        await waitFor(async () => (await visibleAlertText(s.page)) === null, 'the next successful action should clear the error message');
      },
    },
    {
      id: 'ui.api_error.toggle',
      mandatory: true,
      seed: (v) => [{ title: v.titles.complete, completed: false }, ...v.baseSet],
      async run(s) {
        const t = s.v.titles.complete;
        const unroute = await faultInject(s.page, 'PATCH', '500');
        await toggle(s.page, t).click();
        await expectAlert(s.page, 'PATCH returned 500');
        await sleep(800);
        assert(!(await toggle(s.page, t).isChecked()), 'checkbox still shows completed after the server rejected the change');
        await expectBackend(s.app, s.state, 'DB unchanged after failed toggle');
        await unroute();
        await toggle(s.page, t).click();
        s.state = s.state.map((x) => (x.title === t ? { ...x, completed: true } : x));
        await verifyAll(s, 'toggle after the server recovered');
      },
    },
    {
      id: 'ui.api_error.edit',
      mandatory: true,
      seed: (v) => [...v.baseSet, { title: v.titles.editFrom, completed: false }],
      async run(s) {
        const { editFrom, editTo } = s.v.titles;
        const unroute = await faultInject(s.page, 'PATCH', '500');
        await editButton(s.page, editFrom).click();
        await editInput(s.page).fill(editTo);
        await editInput(s.page).press('Enter');
        await expectAlert(s.page, 'PATCH (edit) returned 500');
        await expectNoPhantom(s.page, editTo, 'failed edit');
        await expectBackend(s.app, s.state, 'DB unchanged after failed edit');
        await unroute();
        if ((await editInput(s.page).count()) > 0) {
          await editInput(s.page).fill(editTo);
          await editInput(s.page).press('Enter');
        } else {
          await editButton(s.page, editFrom).click();
          await editInput(s.page).fill(editTo);
          await editInput(s.page).press('Enter');
        }
        s.state = s.state.map((x) => (x.title === editFrom ? { ...x, title: editTo } : x));
        await verifyAll(s, 'edit after the server recovered');
      },
    },
    {
      id: 'ui.api_error.delete',
      mandatory: true,
      seed: (v) => [{ title: v.titles.remove, completed: false }, ...v.baseSet],
      async run(s) {
        const t = s.v.titles.remove;
        const unroute = await faultInject(s.page, 'DELETE', 'abort');
        await deleteButton(s.page, t).click();
        await expectAlert(s.page, 'DELETE failed with a network error');
        await sleep(800);
        await expectUi(s.page, s.state, 'item must still be shown after a failed delete');
        await expectBackend(s.app, s.state, 'DB unchanged after failed delete');
        await unroute();
        await deleteButton(s.page, t).click();
        s.state = s.state.filter((x) => x.title !== t);
        await verifyAll(s, 'delete after the server recovered');
      },
    },
    {
      id: 'ui.api_error.initial_load',
      mandatory: true,
      seed: (v) => v.baseSet,
      noWait: true,
      beforeGoto: async (page) => {
        await page.route('**/api/todos', (r) =>
          r.request().method() === 'GET'
            ? r.fulfill({ status: 500, contentType: 'application/json', body: ERROR_BODY })
            : r.fallback(),
        );
      },
      async run(s) {
        await expectAlert(s.page, 'initial GET returned 500', 10_000);
        const retry = s.page.getByRole('button', { name: 'Retry', exact: true });
        await waitFor(() => retry.isVisible(), 'a "Retry" button should be shown after the initial load failed');
        await s.page.unroute('**/api/todos');
        await retry.click();
        await waitForLoaded(s.page, s.state.length);
        await expectUi(s.page, s.state, 'after clicking Retry once the server recovered');
        await waitFor(async () => (await visibleAlertText(s.page)) === null, 'the error message should clear after a successful retry');
      },
    },
    {
      id: 'ui.loading_state',
      mandatory: true,
      seed: (v) => v.baseSet,
      noWait: true,
      beforeGoto: async (page) => {
        await page.route('**/api/todos', async (r) => {
          if (r.request().method() !== 'GET') return r.fallback();
          await sleep(2500);
          return r.fallback();
        });
      },
      async run(s) {
        await waitFor(
          async () => {
            const st = s.page.getByRole('status');
            const n = await st.count();
            for (let i = 0; i < n; i++) if (await st.nth(i).isVisible()) return true;
            return false;
          },
          'a visible role="status" loading indicator should be shown while GET /api/todos is pending',
          { timeoutMs: 2000, intervalMs: 50 },
        );
        await waitForLoaded(s.page, s.state.length, 15_000);
        await expectUi(s.page, s.state, 'after the delayed load completed');
      },
    },
    {
      id: 'ui.keyboard',
      mandatory: true,
      seed: (v) => v.baseSet,
      async run(s) {
        const p = s.page;
        const t = s.v.titles.keyboard;
        const t2 = `${t} edited`;
        await p.locator('body').click({ position: { x: 1, y: 1 } }).catch(() => undefined);
        await tabTo(p, newTodoInput(p), 'New todo input');
        await p.keyboard.type(t);
        await p.keyboard.press('Enter');
        s.state.push({ title: t, completed: false });
        await verifyAll(s, 'keyboard create');
        await tabTo(p, toggle(p, t), `checkbox "Toggle ${t}"`);
        await p.keyboard.press('Space');
        s.state = s.state.map((x) => (x.title === t ? { ...x, completed: true } : x));
        await verifyAll(s, 'keyboard toggle (Space)');
        await tabTo(p, editButton(p, t), `button "Edit ${t}"`);
        await p.keyboard.press('Enter');
        await editInput(p).waitFor({ state: 'visible' });
        if (!(await isFocused(editInput(p)))) await tabTo(p, editInput(p), '"Edit title" input', 10);
        await p.keyboard.press('ControlOrMeta+a');
        await p.keyboard.type(t2);
        await p.keyboard.press('Enter');
        s.state = s.state.map((x) => (x.title === t ? { ...x, title: t2 } : x));
        await verifyAll(s, 'keyboard edit');
        await tabTo(p, filterButton(p, 'Completed'), 'filter "Completed"');
        await p.keyboard.press('Enter');
        await waitFor(async () => (await pressedFilter(p)).join() === 'Completed', 'Completed filter activated by keyboard');
        await expectUi(p, done(s.state), 'Completed filter via keyboard');
        await p.keyboard.press('Shift+Tab');
        await p.keyboard.press('Shift+Tab');
        await tabTo(p, filterButton(p, 'All'), 'filter "All"');
        await p.keyboard.press('Space');
        await waitFor(async () => (await pressedFilter(p)).join() === 'All', 'All filter activated by keyboard (Space)');
        await tabTo(p, deleteButton(p, t2), `button "Delete ${t2}"`, 60);
        await p.keyboard.press('Enter');
        s.state = s.state.filter((x) => x.title !== t2);
        await verifyAll(s, 'keyboard delete');
      },
    },
    {
      id: 'ui.state_consistency',
      mandatory: true,
      seed: (v) => [
        { title: v.titles.complete, completed: false },
        { title: v.titles.reopen, completed: true },
        { title: v.titles.editFrom, completed: false },
        { title: v.titles.remove, completed: false },
      ],
      async run(s) {
        const T = s.v.titles;
        for (const op of s.v.sequenceOrder) {
          if (op === 'complete') {
            await toggle(s.page, T.complete).click();
            s.state = s.state.map((x) => (x.title === T.complete ? { ...x, completed: true } : x));
          } else if (op === 'reopen') {
            await toggle(s.page, T.reopen).click();
            s.state = s.state.map((x) => (x.title === T.reopen ? { ...x, completed: false } : x));
          } else if (op === 'edit') {
            await editButton(s.page, T.editFrom).click();
            await editInput(s.page).fill(T.editTo);
            await editInput(s.page).press('Enter');
            s.state = s.state.map((x) => (x.title === T.editFrom ? { ...x, title: T.editTo } : x));
          } else {
            await deleteButton(s.page, T.remove).click();
            s.state = s.state.filter((x) => x.title !== T.remove);
          }
          await verifyAll(s, `after "${op}" (order ${s.v.sequenceOrder.join('→')})`);
        }
        await s.page.reload({ waitUntil: 'networkidle' });
        await waitForLoaded(s.page, s.state.length);
        await verifyAll(s, 'after reload at the end of the sequence');
        return `order ${s.v.sequenceOrder.join('→')}`;
      },
    },
    {
      id: 'ui.mobile',
      mandatory: true,
      viewport: 'mobile',
      seed: (v) => v.mixedSet,
      async run(s) {
        const p = s.page;
        await expectUi(p, s.state, 'mobile initial list');
        const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert(overflow <= 1, `page scrolls horizontally on a 390px viewport (overflow ${overflow}px)`);
        for (const loc of [newTodoInput(p), addButton(p), filterButton(p, 'All'), filterButton(p, 'Completed')]) {
          const box = await loc.boundingBox();
          assert(box && box.x >= -1 && box.x + box.width <= 391, `control outside the 390px viewport: ${String(loc)}`);
        }
        const t = s.v.titles.mobile;
        await createViaUi(p, t, 'click');
        s.state.push({ title: t, completed: false });
        await verifyAll(s, 'mobile create');
        await toggle(p, t).click();
        s.state = s.state.map((x) => (x.title === t ? { ...x, completed: true } : x));
        await verifyAll(s, 'mobile complete');
        await filterButton(p, 'Completed').click();
        await expectUi(p, done(s.state), 'mobile Completed filter');
      },
    },
  ];
}

export async function runUiScenarios(ctx: UiScenarioContext): Promise<CheckResult[]> {
  fs.mkdirSync(ctx.screenshotDir, { recursive: true });
  const results: CheckResult[] = [];
  const scenarios = buildScenarios().filter((sc) => !ctx.only || ctx.only.includes(sc.id));
  for (const sc of scenarios) {
    const shot = path.join(ctx.screenshotDir, `${sc.id}.png`);
    const pageErrors: string[] = [];
    const res = await runCheck({ id: sc.id, category: 'functional', mandatory: sc.mandatory }, async () => {
      await ctx.app.resetDb();
      const seedSet = clone(sc.seed(ctx.variant));
      const seeded = await seedTodos(ctx.app.url, seedSet);
      const { context, page } = await openPage(ctx.browser, ctx.app.url, sc.viewport ?? 'desktop', { beforeGoto: sc.beforeGoto });
      page.on('pageerror', (e) => pageErrors.push(e.message));
      try {
        await page.goto(ctx.app.url, { waitUntil: sc.noWait ? 'commit' : 'networkidle' });
        if (!sc.noWait) await waitForLoaded(page, seedSet.length);
        const msg = await sc.run({ page, app: ctx.app, v: ctx.variant, seeded, state: seedSet });
        await page.screenshot({ path: shot, animations: 'disabled', caret: 'hide' }).catch(() => undefined);
        return msg;
      } catch (e) {
        if (!isInfraError(e)) {
          await page.screenshot({ path: shot, animations: 'disabled', caret: 'hide' }).catch(() => undefined);
        }
        throw e;
      } finally {
        await context.close().catch(() => undefined);
      }
    });
    if (pageErrors.length && res.outcome !== 'pass') {
      res.message = `${res.message ?? ''} [page errors: ${pageErrors.slice(0, 3).join(' | ').slice(0, 400)}]`;
    }
    if (fs.existsSync(shot)) res.evidence = [shot];
    results.push(res);
    // Stop early on evaluator infrastructure failures; the caller's retry re-runs every 'error' id.
    if (res.outcome === 'error') {
      for (const rest of scenarios.slice(scenarios.indexOf(sc) + 1)) {
        results.push({
          id: rest.id,
          category: 'functional',
          mandatory: rest.mandatory,
          outcome: 'error',
          message: `evaluator error: not run after an evaluator failure in ${sc.id}`,
          attempts: 0,
        });
      }
      break;
    }
  }
  return results;
}
