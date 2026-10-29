export const auditEventTypes = [
  'assessment_started',
  'assessment_submitted',
  'navigation_started',
  'navigation_completed',
  'search_performed',
  'ai_assistance_domain_visited',
  'tab_created',
  'tab_creation_blocked',
  'tab_closed',
  'tab_switched',
  'popup_blocked',
  'navigation_blocked',
  'redirect_observed',
  'camera_started',
  'camera_stopped',
  'camera_permission_denied',
  'camera_unavailable',
  'face_not_detected',
  'face_detected',
  'multiple_faces_detected',
  'camera_disconnected'
] as const

export type AuditEventType = (typeof auditEventTypes)[number]

export interface AssessmentAuditEvent {
  id: string
  assessmentId: string
  attemptId: string
  type: AuditEventType
  occurredAt: string
  hostname?: string
  fromHostname?: string
  url?: string
  query?: string
  observationCount?: number
  observationDurationMs?: number
  confidence?: number
}

export interface AuditEventInput {
  type: AuditEventType
  hostname?: string
  fromHostname?: string
  url?: string
  query?: string
  observationCount?: number
  observationDurationMs?: number
  confidence?: number
}

export class AssessmentAuditStore {
  private readonly events: AssessmentAuditEvent[] = []

  append(assessmentId: string, attemptId: string, input: AuditEventInput): AssessmentAuditEvent {
    const event: AssessmentAuditEvent = {
      id: crypto.randomUUID(),
      assessmentId,
      attemptId,
      type: input.type,
      occurredAt: new Date().toISOString(),
      ...(input.hostname ? { hostname: input.hostname } : {}),
      ...(input.fromHostname ? { fromHostname: input.fromHostname } : {}),
      ...(input.url ? { url: input.url } : {}),
      ...(input.query ? { query: input.query } : {}),
      ...(input.observationCount !== undefined ? { observationCount: input.observationCount } : {}),
      ...(input.observationDurationMs !== undefined
        ? { observationDurationMs: input.observationDurationMs }
        : {}),
      ...(input.confidence !== undefined ? { confidence: input.confidence } : {})
    }
    this.events.push(event)
    return { ...event }
  }

  list(attemptId: string): AssessmentAuditEvent[] {
    return this.events
      .filter((event) => event.attemptId === attemptId)
      .map((event) => ({ ...event }))
  }
}
