import test from 'node:test';
import assert from 'node:assert/strict';
import { budgetError, defaultExecutionSettings, executionSettingsSchema, runLimitsSchema } from '../packages/protocol/src/index.ts';

test('budget settings default to unlimited and reject negative values', () => {
  assert.equal(defaultExecutionSettings.tokenBudget, 0);
  assert.equal(defaultExecutionSettings.costBudgetUsd, 0);
  assert.equal(executionSettingsSchema.parse({}).tokenBudget, 0);
  assert.equal(executionSettingsSchema.parse({ tokenBudget: 1200, costBudgetUsd: 0.5 }).tokenBudget, 1200);
  assert.equal(executionSettingsSchema.safeParse({ tokenBudget: -1 }).success, false);
  assert.equal(executionSettingsSchema.safeParse({ costBudgetUsd: -0.01 }).success, false);
  const historical=runLimitsSchema.parse({ memoryMb: 512, maxProcesses: 4, timeoutMs: 5000 });
  assert.equal(Object.hasOwn(historical,'tokenBudget'),false);
  assert.equal(Object.hasOwn(historical,'costBudgetUsd'),false);
  assert.equal(budgetError(historical,{'1':{inputTokens:5000,costUsd:1}}),undefined);
});

test('budgetError stops a run only when known usage exceeds a configured hard limit', () => {
  const limits = runLimitsSchema.parse({ memoryMb: 512, maxProcesses: 4, timeoutMs: 5000, tokenBudget: 1000, costBudgetUsd: 0.5 });
  assert.equal(budgetError(limits, { '1': { inputTokens: 400, outputTokens: 500 } }), undefined);
  assert.match(String(budgetError(limits, { '1': { inputTokens: 600, outputTokens: 500 } })), /Token 预算/);
  assert.match(String(budgetError(limits, { '1': { costUsd: 0.6 } })), /费用预算/);
  assert.equal(budgetError(limits, { '1': { inputTokens: 200 }, '2': { inputTokens: 300, outputTokens: 400 } }), undefined);
  assert.match(String(budgetError(limits, { '1': { inputTokens: 600 }, '2': { outputTokens: 500 } })), /Token 预算/);
});

test('unknown provider usage neither triggers nor satisfies a budget', () => {
  const limits = runLimitsSchema.parse({ memoryMb: 512, maxProcesses: 4, timeoutMs: 5000, tokenBudget: 1, costBudgetUsd: 0.001 });
  assert.equal(budgetError(limits, { '1': {} }), undefined);
  assert.equal(budgetError(limits, undefined), undefined);
  assert.equal(budgetError(undefined, { '1': { inputTokens: 999999 } }), undefined);
});
