import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

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
  'camera_disconnected',
  'attention_monitoring_started',
  'sustained_head_turn_left',
  'sustained_head_turn_right',
  'sustained_head_down',
  'attention_returned',
  'automatic_submission_focus_loss',
  'automatic_submission_minimized',
  'automatic_submission_close_attempt',
  'automatic_submission_deadline'
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

export interface AdminActionAuditEvent {
  id: string
  actorEmail: string
  action: 'report_export'
  targetId: string
  occurredAt: string
}

export class AdminAuditStorageError extends Error {
  constructor(cause: unknown) {
    super('Could not persist the administrator audit event.', { cause })
    this.name = 'AdminAuditStorageError'
  }
}

export class AdminActionAuditStore {
  constructor(private readonly filePath: string) {}

  record(actorEmail: string, action: AdminActionAuditEvent['action'], targetId: string): void {
    const event: AdminActionAuditEvent = {
      id: crypto.randomUUID(),
      actorEmail,
      action,
      targetId,
      occurredAt: new Date().toISOString()
    }
    try {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 })
      appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, {
        encoding: 'utf8',
        flag: 'a',
        mode: 0o600
      })
      chmodSync(this.filePath, 0o600)
    } catch (error) {
      throw new AdminAuditStorageError(error)
    }
  }
}

export class AssessmentAuditStore {
  private readonly events: AssessmentAuditEvent[]

  constructor(private readonly filePath?: string) {
    this.events = filePath ? this.load(filePath) : []
  }

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
    if (this.filePath) {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 })
      appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, {
        encoding: 'utf8',
        flag: 'a',
        mode: 0o600
      })
    }
    this.events.push(event)
    return { ...event }
  }

  list(attemptId: string): AssessmentAuditEvent[] {
    return this.listAll().filter((event) => event.attemptId === attemptId)
  }

  listAll(): AssessmentAuditEvent[] {
    return this.events.map((event) => ({ ...event }))
  }

  private load(filePath: string): AssessmentAuditEvent[] {
    if (!existsSync(filePath)) return []
    const contents = readFileSync(filePath, 'utf8')
    return contents
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .map((line, index) => {
        let value: unknown
        try {
          value = JSON.parse(line)
        } catch {
          throw new Error(`Audit log is invalid at line ${index + 1}.`)
        }
        if (!isAuditEvent(value)) {
          throw new Error(`Audit log entry is invalid at line ${index + 1}.`)
        }
        return value
      })
  }
}

function isAuditEvent(value: unknown): value is AssessmentAuditEvent {
  if (!value || typeof value !== 'object') return false
  const event = value as Partial<AssessmentAuditEvent>
  return (
    typeof event.id === 'string' &&
    typeof event.assessmentId === 'string' &&
    typeof event.attemptId === 'string' &&
    typeof event.type === 'string' &&
    auditEventTypes.includes(event.type as AuditEventType) &&
    typeof event.occurredAt === 'string' &&
    Number.isFinite(Date.parse(event.occurredAt))
  )
}
