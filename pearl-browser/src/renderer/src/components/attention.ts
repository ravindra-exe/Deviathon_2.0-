export type AttentionDirection =
  | 'calibrating'
  | 'facing_screen'
  | 'head_left'
  | 'head_right'
  | 'head_down'
  | 'face_not_detected'
  | 'insufficient_confidence'

export type AttentionEventType =
  | 'attention_monitoring_started'
  | 'sustained_head_turn_left'
  | 'sustained_head_turn_right'
  | 'sustained_head_down'
  | 'face_not_detected'
  | 'attention_returned'

export interface NormalizedFacePoint {
  x: number
  y: number
}

export interface HeadPoseEstimate {
  yaw: number
  pitch: number
  rollDegrees: number
}

export interface AttentionObservation {
  faceCount: number
  confidence?: number
  headPose?: HeadPoseEstimate
}

export interface AttentionEvent {
  type: AttentionEventType
  observationCount: number
  observationDurationMs: number
  confidence?: number
}

export interface AttentionUpdate {
  direction: AttentionDirection
  calibrated: boolean
  calibrationSamples: number
  lookingAway: boolean
  lookingAwayDurationMs: number
  events: AttentionEvent[]
}

export const ATTENTION_WARNING_THRESHOLD_MS = 3_000
export const ATTENTION_FACE_MISSING_THRESHOLD_MS = 5_000

const REQUIRED_CALIBRATION_SAMPLES = 5
const REQUIRED_SUSTAINED_OBSERVATIONS = 3
const MIN_FACE_CONFIDENCE = 0.65
const YAW_THRESHOLD = 0.3
const PITCH_THRESHOLD = 0.28
const ROLL_THRESHOLD_DEGREES = 20
const SMOOTHING_WINDOW = 3

export function estimateHeadPose(
  keypoints: readonly NormalizedFacePoint[],
  confidence: number
): HeadPoseEstimate | undefined {
  if (
    confidence < MIN_FACE_CONFIDENCE ||
    keypoints.length < 6 ||
    keypoints.some(
      (point) =>
        !Number.isFinite(point.x) ||
        !Number.isFinite(point.y) ||
        point.x < 0 ||
        point.x > 1 ||
        point.y < 0 ||
        point.y > 1
    )
  ) {
    return undefined
  }

  const [leftEye, rightEye, nose, mouth] = keypoints
  const eyeDistance = Math.hypot(rightEye.x - leftEye.x, rightEye.y - leftEye.y)
  const eyeMidpoint = { x: (leftEye.x + rightEye.x) / 2, y: (leftEye.y + rightEye.y) / 2 }
  const eyeToMouth = mouth.y - eyeMidpoint.y
  if (eyeDistance < 0.025 || eyeToMouth < 0.025) return undefined

  return {
    yaw: (nose.x - eyeMidpoint.x) / eyeDistance,
    pitch: (nose.y - eyeMidpoint.y) / eyeToMouth,
    rollDegrees: (Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x) * 180) / Math.PI
  }
}

export class AttentionTracker {
  constructor(
    private readonly warningThresholdMs = ATTENTION_WARNING_THRESHOLD_MS,
    private readonly faceMissingThresholdMs = ATTENTION_FACE_MISSING_THRESHOLD_MS
  ) {}

  private calibration: HeadPoseEstimate[] = []
  private baseline: HeadPoseEstimate | undefined
  private smoothed: HeadPoseEstimate[] = []
  private direction: AttentionDirection = 'calibrating'
  private candidateDirection: AttentionDirection | undefined
  private candidateSince: number | undefined
  private candidateCount = 0
  private awayObservationCount = 0
  private missingFaceSince: number | undefined
  private missingFaceCount = 0
  private missingFaceRecorded = false
  private lookingAwaySince: number | undefined
  private lookingAway = false
  private reportedDirections = new Set<AttentionDirection>()

  reset(): void {
    this.calibration = []
    this.baseline = undefined
    this.smoothed = []
    this.direction = 'calibrating'
    this.candidateDirection = undefined
    this.candidateSince = undefined
    this.candidateCount = 0
    this.awayObservationCount = 0
    this.missingFaceSince = undefined
    this.missingFaceCount = 0
    this.missingFaceRecorded = false
    this.lookingAwaySince = undefined
    this.lookingAway = false
    this.reportedDirections.clear()
  }

  beginAttempt(): void {
    this.direction = this.baseline ? 'facing_screen' : 'calibrating'
    this.smoothed = []
    this.candidateDirection = undefined
    this.candidateSince = undefined
    this.candidateCount = 0
    this.awayObservationCount = 0
    this.missingFaceSince = undefined
    this.missingFaceCount = 0
    this.missingFaceRecorded = false
    this.lookingAwaySince = undefined
    this.lookingAway = false
    this.reportedDirections.clear()
  }

  isCalibrated(): boolean {
    return this.baseline !== undefined
  }

  update(observation: AttentionObservation, observedAt: number): AttentionUpdate {
    const events: AttentionEvent[] = []
    if (observation.faceCount !== 1) {
      if (observation.faceCount !== 0) {
        this.missingFaceSince = undefined
        this.missingFaceCount = 0
        this.missingFaceRecorded = false
      }
      this.direction = observation.faceCount === 0 ? 'face_not_detected' : 'insufficient_confidence'
      this.candidateDirection = undefined
      this.candidateSince = undefined
      this.candidateCount = 0
      if (observation.faceCount === 0) {
        this.missingFaceSince ??= observedAt
        this.missingFaceCount += 1
        if (
          !this.missingFaceRecorded &&
          observedAt - this.missingFaceSince >= this.faceMissingThresholdMs
        ) {
          this.missingFaceRecorded = true
          events.push({
            type: 'face_not_detected',
            observationCount: this.missingFaceCount,
            observationDurationMs: observedAt - this.missingFaceSince
          })
        }
      }
      return this.result(events, observedAt)
    }

    this.missingFaceSince = undefined
    this.missingFaceCount = 0
    this.missingFaceRecorded = false
    if (
      typeof observation.confidence !== 'number' ||
      observation.confidence < MIN_FACE_CONFIDENCE ||
      !observation.headPose ||
      !isValidPose(observation.headPose)
    ) {
      this.direction = 'insufficient_confidence'
      this.candidateDirection = undefined
      this.candidateSince = undefined
      this.candidateCount = 0
      return this.result(events, observedAt)
    }

    if (!this.baseline) {
      const pose = observation.headPose
      if (
        Math.abs(pose.yaw) <= 0.3 &&
        pose.pitch >= 0.2 &&
        pose.pitch <= 0.8 &&
        Math.abs(pose.rollDegrees) <= 15
      ) {
        this.calibration.push(pose)
        if (this.calibration.length >= REQUIRED_CALIBRATION_SAMPLES) {
          this.baseline = {
            yaw: median(this.calibration.map((sample) => sample.yaw)),
            pitch: median(this.calibration.map((sample) => sample.pitch)),
            rollDegrees: median(this.calibration.map((sample) => sample.rollDegrees))
          }
          this.direction = 'facing_screen'
        }
      }
      return this.result(events, observedAt)
    }

    this.smoothed.push(observation.headPose)
    if (this.smoothed.length > SMOOTHING_WINDOW) this.smoothed.shift()
    const pose = {
      yaw: median(this.smoothed.map((sample) => sample.yaw)),
      pitch: median(this.smoothed.map((sample) => sample.pitch)),
      rollDegrees: median(this.smoothed.map((sample) => sample.rollDegrees))
    }
    this.direction = classifyDirection(pose, this.baseline)
    if (this.direction === 'facing_screen') {
      this.candidateDirection = undefined
      this.candidateSince = undefined
      this.candidateCount = 0
      if (this.lookingAway) {
        events.push({
          type: 'attention_returned',
          observationCount: Math.max(1, this.awayObservationCount),
          observationDurationMs:
            this.lookingAwaySince !== undefined ? observedAt - this.lookingAwaySince : 0,
          ...(observation.confidence !== undefined ? { confidence: observation.confidence } : {})
        })
        this.lookingAway = false
        this.lookingAwaySince = undefined
        this.awayObservationCount = 0
        this.reportedDirections.clear()
      } else {
        this.lookingAwaySince = undefined
        this.awayObservationCount = 0
      }
    } else {
      if (this.candidateDirection !== this.direction) {
        this.candidateDirection = this.direction
        this.candidateSince = observedAt
        this.candidateCount = 0
      }
      this.candidateCount += 1
      this.awayObservationCount += 1
      this.lookingAwaySince ??= this.candidateSince
      if (
        this.candidateSince !== undefined &&
        observedAt - this.candidateSince >= this.warningThresholdMs &&
        this.candidateCount >= REQUIRED_SUSTAINED_OBSERVATIONS &&
        !this.reportedDirections.has(this.direction)
      ) {
        this.lookingAway = true
        this.reportedDirections.add(this.direction)
        events.push({
          type: eventTypeForDirection(this.direction),
          observationCount: this.candidateCount,
          observationDurationMs: observedAt - this.candidateSince,
          ...(observation.confidence !== undefined ? { confidence: observation.confidence } : {})
        })
      }
    }

    return this.result(events, observedAt)
  }

  private result(events: AttentionEvent[], observedAt: number): AttentionUpdate {
    return {
      direction: this.direction,
      calibrated: this.baseline !== undefined,
      calibrationSamples: this.calibration.length,
      lookingAway: this.lookingAway,
      lookingAwayDurationMs:
        this.lookingAway && this.lookingAwaySince !== undefined
          ? Math.max(0, observedAt - this.lookingAwaySince)
          : 0,
      events
    }
  }
}

function classifyDirection(pose: HeadPoseEstimate, baseline: HeadPoseEstimate): AttentionDirection {
  if (
    pose.pitch - baseline.pitch > PITCH_THRESHOLD ||
    Math.abs(angleDifference(pose.rollDegrees, baseline.rollDegrees)) > ROLL_THRESHOLD_DEGREES
  ) {
    return 'head_down'
  }
  const yaw = pose.yaw - baseline.yaw
  if (yaw > YAW_THRESHOLD) return 'head_left'
  if (yaw < -YAW_THRESHOLD) return 'head_right'
  return 'facing_screen'
}

function angleDifference(angle: number, baseline: number): number {
  return ((angle - baseline + 540) % 360) - 180
}

function eventTypeForDirection(direction: AttentionDirection): AttentionEventType {
  if (direction === 'head_left') return 'sustained_head_turn_left'
  if (direction === 'head_right') return 'sustained_head_turn_right'
  return 'sustained_head_down'
}

function isValidPose(pose: HeadPoseEstimate): boolean {
  return (
    Number.isFinite(pose.yaw) &&
    Number.isFinite(pose.pitch) &&
    Number.isFinite(pose.rollDegrees) &&
    Math.abs(pose.yaw) <= 3 &&
    pose.pitch >= 0 &&
    pose.pitch <= 2 &&
    Math.abs(pose.rollDegrees) <= 90
  )
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}
