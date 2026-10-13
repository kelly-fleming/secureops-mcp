import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// Pass a command after the script to test a Docker stdio process from the host.
const [command = process.execPath, ...args] = process.argv.slice(2);
const child = spawn(command, args.length ? args : ['dist/mcp/stdio.js'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});
const pending = new Map();
const invalidLines = [];
let nextId = 0;
let stderrBytes = 0;
child.stderr.on('data', (chunk) => {
  stderrBytes += chunk.length;
});
const closed = new Promise((resolve) =>
  child.once('close', (code) => {
    for (const entry of pending.values()) entry.reject(new Error('Server closed before replying.'));
    resolve(code);
  }),
);
child.on('error', (error) => {
  for (const entry of pending.values()) entry.reject(error);
});
child.stdin.on('error', () => {});
createInterface({ input: child.stdout }).on('line', (line) => {
  try {
    const frame = JSON.parse(line);
    assert.equal(frame.jsonrpc, '2.0');
    const entry = pending.get(frame.id);
    if (entry) {
      pending.delete(frame.id);
      if (frame.error) entry.reject(new Error('JSON-RPC request failed.'));
      else entry.resolve(frame.result);
    }
  } catch {
    invalidLines.push(line);
  }
});

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Stdio smoke test timed out.')), 20_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function request(method, params) {
  const id = ++nextId;
  const reply = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return bounded(reply);
}

try {
  const initialized = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'secureops-compiled-smoke', version: '0.1.0' },
  });
  assert.equal(initialized.serverInfo.name, 'secureops-mcp');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const listed = await request('tools/list', {});
  const expected = [
    'list_resources',
    'get_resource',
    'analyze_resource',
    'evaluate_policy',
    'propose_change',
    'request_approval',
    'execute_change',
    'get_audit_log',
  ];
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), expected.sort());
  const call = (name, arguments_) => request('tools/call', { name, arguments: arguments_ });
  const resources = await call('list_resources', { limit: 100 });
  assert.notEqual(resources.isError, true);
  assert.equal(resources.structuredContent.resources.length, 12);
  const detail = await call('get_resource', { resourceId: 'res-aws-ec2-01' });
  assert.notEqual(detail.isError, true);
  assert.equal(detail.structuredContent.resource.id, 'res-aws-ec2-01');
  const denied = await call('execute_change', {
    proposalId: 'proposal-smoke-unapproved',
    idempotencyKey: 'smoke-unapproved-0001',
  });
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent.error.code, 'NOT_FOUND');
  child.stdin.end();
  assert.equal(await bounded(closed), 0);
  assert.equal(invalidLines.length, 0, 'stdout must contain only JSON-RPC frames');
  console.log(
    JSON.stringify({
      handshake: 'passed',
      tools: expected.length,
      resources: 12,
      fictionalRead: 'passed',
      missingProposalExecution: 'denied',
      protocolOnlyStdout: true,
      shutdown: 'passed',
      stderrBytes,
    }),
  );
} finally {
  if (child.exitCode === null) child.kill();
  await bounded(closed);
}
