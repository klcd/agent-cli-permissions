import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import activate, { syncCanonicalPermissions } from './worker.ts'
import {
  buildPolicyReport,
  evaluateCommandPolicy,
  parsePermissionYaml,
} from './policy-inspector.ts'

test('parses canonical .agents/permissions/*.yml and evaluates DENY > ASK > ALLOW rules', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-agent-permissions-test-'))
  try {
    const homeDir = path.join(dir, 'home')
    const wsDir = path.join(dir, 'workspace')
    const permDir = path.join(homeDir, '.agents', 'permissions')
    fs.mkdirSync(permDir, { recursive: true })
    fs.mkdirSync(wsDir, { recursive: true })

    fs.writeFileSync(
      path.join(permDir, 'security-baseline.yml'),
      [
        'name: security-baseline',
        'description: Baseline security rules',
        'allow:',
        '  - "Bash(git status:*)"',
        'deny:',
        '  - "Bash(chmod -R 777:*)"',
      ].join('\n')
    )

    const group = parsePermissionYaml(
      fs.readFileSync(path.join(permDir, 'security-baseline.yml'), 'utf8'),
      'security-baseline.yml',
      'global'
    )
    assert.equal(group.allowCount, 1)
    assert.equal(group.denyCount, 1)

    const report = buildPolicyReport({ workspacePath: wsDir, agent: 'claude', homeDir })
    assert.equal(report.permissionGroups.length, 1)
    assert.equal(evaluateCommandPolicy('git status -s', report).verdict, 'allow')
    assert.equal(evaluateCommandPolicy('chmod -R 777 /tmp/foo', report).verdict, 'deny')

    const syncRes = syncCanonicalPermissions(wsDir, homeDir)
    assert.equal(syncRes.ok, true)

    const handlers = new Map<string, (input: any) => any>()
    activate({
      panels: {
        handle: (name: string, fn: (input: any) => any) => {
          handlers.set(name, fn)
        },
      },
      commands: {
        register() {},
      },
    } as any)
    assert.ok(handlers.has('getPolicyReport'))
    assert.ok(handlers.has('evaluateCommand'))
    assert.ok(handlers.has('syncPermissions'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
