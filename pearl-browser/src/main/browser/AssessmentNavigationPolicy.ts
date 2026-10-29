import type { AssessmentPolicy } from '../../shared/assessment'

export type NavigationPolicyReason =
  | 'assessment-inactive'
  | 'invalid-url'
  | 'unsupported-protocol'
  | 'missing-host'
  | 'host-not-allowed'
  | 'host-blocked'
  | 'popup-not-allowed'
  | 'new-tab-not-allowed'

export interface NavigationPolicyDecision {
  allowed: boolean
  reason: NavigationPolicyReason
}

export function evaluateAssessmentNavigation(
  value: string,
  policy: AssessmentPolicy | undefined,
  options: { popup?: boolean; newTab?: boolean } = {}
): NavigationPolicyDecision {
  if (!policy) return { allowed: true, reason: 'assessment-inactive' }
  if (options.newTab && !policy.allowNewTabs) {
    return { allowed: false, reason: 'new-tab-not-allowed' }
  }
  if (options.popup && !policy.allowPopupDestinations) {
    return { allowed: false, reason: 'popup-not-allowed' }
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return { allowed: false, reason: 'invalid-url' }
  }

  const isLocalException = policy.localDevelopmentHosts.includes(url.hostname.toLowerCase())
  if (url.protocol !== 'https:' && !(policy.allowHttpLocalDevelopment && isLocalException)) {
    return { allowed: false, reason: 'unsupported-protocol' }
  }
  const hostname = url.hostname.toLowerCase()
  if (!hostname) return { allowed: false, reason: 'missing-host' }

  const blocked = policy.blockedHosts?.some((host) =>
    matchesHost(hostname, host, policy.allowSubdomains)
  )
  if (blocked) return { allowed: false, reason: 'host-blocked' }
  const allowed =
    policy.allowedHosts.some((host) => matchesHost(hostname, host, policy.allowSubdomains)) ||
    (isLocalException && policy.allowHttpLocalDevelopment)
  return allowed
    ? { allowed: true, reason: 'assessment-inactive' }
    : { allowed: false, reason: 'host-not-allowed' }
}

function matchesHost(hostname: string, configuredHost: string, allowSubdomains: boolean): boolean {
  const normalizedHost = configuredHost.toLowerCase()
  return hostname === normalizedHost || (allowSubdomains && hostname.endsWith(`.${normalizedHost}`))
}

export function validateAssessmentPolicy(policy: AssessmentPolicy): void {
  if (!Array.isArray(policy.allowedHosts) || !Array.isArray(policy.localDevelopmentHosts)) {
    throw new Error('Assessment navigation policy host lists are invalid.')
  }
  for (const host of [
    ...policy.allowedHosts,
    ...(policy.blockedHosts ?? []),
    ...policy.localDevelopmentHosts
  ]) {
    if (
      !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(
        host
      )
    ) {
      throw new Error(`Assessment navigation policy hostname is invalid: ${host}`)
    }
  }
  if (policy.allowHttpLocalDevelopment && policy.localDevelopmentHosts.length === 0) {
    throw new Error('HTTP local development requires an explicit local hostname list.')
  }
}
