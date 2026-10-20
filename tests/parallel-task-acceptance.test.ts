import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runAcceptance } from '../scripts/acceptance-parallel-tasks.ts';

const parent = resolve('.state/test-data');
test('parallel acceptance fixture runs two agents in independent workspaces and integrates both artifacts', async t => {
  mkdirSync(parent, {recursive: true});
  const root = mkdtempSync(join(parent, 'parallel-acceptance-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const {report} = await runAcceptance({root});
  assert.equal(report.pass, true, JSON.stringify(report.checks));
  assert.equal(report.modelRequests, 0);
  assert.equal(report.tasks.length, 2);
  assert.notEqual(report.tasks[0].agentId, report.tasks[1].agentId);
  assert.notEqual(report.tasks[0].workspace, report.tasks[1].workspace);
  assert.ok(report.tasks.every(task => task.acceptanceStatus === 'accepted'));
  assert.ok(report.integrations.every(integration => integration.status === 'applied'));
  assert.ok(report.checks.every(check => check.pass));
  assert.match(report.finalFiles['planner.txt'], /completed planner\.txt/);
  assert.match(report.finalFiles['reviewer.txt'], /completed reviewer\.txt/);
});
