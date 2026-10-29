import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

// Read-only verification of the actual operator workspace, after a physical scan.
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge' });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, timezoneId: 'Asia/Kolkata' });
  await page.goto('http://127.0.0.1:5173');
  await page.getByText('System operational').waitFor();
  const response = await page.request.get('http://127.0.0.1:5173/api/state');
  assert.equal(response.status(), 200);
  const state = await response.json();
  const hardwarePatients = state.patients.filter(patient => patient.source === 'hardware');
  assert.equal(state.datasetSize, 15, 'The configured pool must contain 15 patient profiles.');
  assert.equal(state.mode, 'hardware');
  assert.equal(state.serial.phase, 'connected', 'The physical reader must be connected.');
  assert.ok(hardwarePatients.length, 'Present the physical tag before running this check.');
  assert.equal(await page.locator('tbody tr').count(), state.patients.length);
  for (const patient of hardwarePatients) {
    assert.match(patient.id, /^PAT-\d{3}$/);
    const row = page.getByRole('row', { name: `View ${patient.name}` });
    assert.equal(await row.count(), 1);
    assert.doesNotMatch(await row.innerText(), /demo|synthetic/i);
  }
  assert.equal(await page.getByText('Demo complete', { exact: false }).count(), 0);
  await page.getByRole('button', { name: 'Reader settings', exact: true }).click();
  await page.getByRole('heading', { name: 'Latest serial message' }).waitFor();
  assert.ok((await page.locator('.terminal-content').innerText()).includes(state.lastLine.text.trim()));
  mkdirSync('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/live-hardware.png', fullPage: true });
  console.log(JSON.stringify({ verified: true, datasetSize: state.datasetSize, serial: state.serial,
    latestMessage: state.lastLine, hardwarePatients: hardwarePatients.map(({ id, name, uid, rawScans }) => ({ id, name, uid, rawScans })) }, null, 2));
} finally { await browser.close(); }
