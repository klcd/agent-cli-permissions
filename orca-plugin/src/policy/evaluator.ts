import type { CommandEvaluationResult, PolicyInspectionReport } from '../types.ts'

/** Does `command` match a rule `pattern` like `git status:*`, `rm *`, or an exact string? */
function matchesBashRule(command: string, pattern: string): boolean {
  const normCmd = command.trim()
  const normPat = pattern.trim()
  if (normPat.endsWith(':*')) {
    const prefix = normPat.slice(0, -2).trim()
    return normCmd === prefix || normCmd.startsWith(`${prefix} `)
  }
  if (normPat.endsWith('*')) {
    return normCmd.startsWith(normPat.slice(0, -1))
  }
  return normCmd === normPat
}

/**
 * Evaluate a CLI command against the loaded permission rules.
 *
 * Precedence is DENY > ASK > ALLOW: a single matching deny wins over any allow,
 * and an unlisted command defaults to ASK (interactive confirmation). This is a
 * pure function — it reads nothing and runs nothing.
 */
export function evaluateCommandPolicy(
  command: string,
  report: PolicyInspectionReport
): CommandEvaluationResult {
  const trimmed = command.trim()
  const matchedRules = report.allCliRules.filter(
    rule => rule.tool === 'Bash' && matchesBashRule(trimmed, rule.pattern)
  )

  const deny = matchedRules.find(r => r.action === 'deny')
  const ask = matchedRules.find(r => r.action === 'ask')
  const allow = matchedRules.find(r => r.action === 'allow')

  if (deny) {
    return {
      command: trimmed,
      verdict: 'deny',
      summary: `Hard-blocked by ${deny.scope} policy '${deny.groupName}' (${deny.raw}).`,
      matchedRules,
    }
  }
  if (ask) {
    return {
      command: trimmed,
      verdict: 'ask',
      summary: `Prompts for confirmation per ${ask.scope} policy '${ask.groupName}' (${ask.raw}).`,
      matchedRules,
    }
  }
  if (allow) {
    return {
      command: trimmed,
      verdict: 'allow',
      summary: `Explicitly allowed by ${allow.scope} policy '${allow.groupName}' (${allow.raw}).`,
      matchedRules,
    }
  }
  return {
    command: trimmed,
    verdict: 'ask',
    summary: 'Unlisted command — requires interactive confirmation.',
    matchedRules,
  }
}
