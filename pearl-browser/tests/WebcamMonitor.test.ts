import { describe, expect, it, vi } from 'vitest'
import {
  cameraErrorState,
  classifyFaceCount,
  isCameraPreviewLive,
  isCameraSelectionConfirmed,
  shouldPublishCameraState,
  stopCameraTracks
} from '../src/renderer/src/components/webcam'
import {
  AttentionTracker,
  ATTENTION_WARNING_THRESHOLD_MS,
  estimateHeadPose
} from '../src/renderer/src/components/attention'

function calibratedAttentionTracker(): AttentionTracker {
  const tracker = new AttentionTracker()
  for (let index = 0; index < 5; index += 1) {
    tracker.update(
      { faceCount: 1, confidence: 0.9, headPose: { yaw: 0, pitch: 0.5, rollDegrees: 0 } },
      index * 1000
    )
  }
  return tracker
}

describe('webcam monitoring helpers', () => {
  it('classifies zero, one, and multiple faces', () => {
    expect(classifyFaceCount(0)).toBe('face_not_detected')
    expect(classifyFaceCount(1)).toBe('face_detected')
    expect(classifyFaceCount(2)).toBe('multiple_faces_detected')
  })

  it('stops every camera track during cleanup', () => {
    const first = { stop: vi.fn() }
    const second = { stop: vi.fn() }
    stopCameraTracks({ getTracks: () => [first, second] } as unknown as MediaStream)
    expect(first.stop).toHaveBeenCalledOnce()
    expect(second.stop).toHaveBeenCalledOnce()
    stopCameraTracks(undefined)
  })

  it('only treats an attached, playing stream with decoded dimensions as a live preview', () => {
    const stream = {} as MediaStream
    const track = { readyState: 'live' } as MediaStreamTrack
    const video = {
      srcObject: stream,
      paused: false,
      readyState: 2,
      videoWidth: 640,
      videoHeight: 480
    } as HTMLVideoElement

    expect(isCameraPreviewLive(video, stream, track)).toBe(true)
    expect(
      isCameraPreviewLive({ ...video, srcObject: null } as HTMLVideoElement, stream, track)
    ).toBe(false)
    expect(isCameraPreviewLive({ ...video, paused: true } as HTMLVideoElement, stream, track)).toBe(
      false
    )
    expect(isCameraPreviewLive(video, stream, { readyState: 'ended' } as MediaStreamTrack)).toBe(
      false
    )
  })

  it('requires an explicit matching camera when multiple inputs are available', () => {
    expect(isCameraSelectionConfirmed(1, undefined, '')).toBe(true)
    expect(isCameraSelectionConfirmed(3, undefined, 'default')).toBe(false)
    expect(isCameraSelectionConfirmed(3, 'selected', 'selected')).toBe(true)
    expect(isCameraSelectionConfirmed(3, 'selected', 'other')).toBe(false)
  })

  it('deduplicates unchanged detection states and classifies permission errors', () => {
    expect(shouldPublishCameraState('face_detected', 'face_detected')).toBe(false)
    expect(shouldPublishCameraState('face_detected', 'face_not_detected')).toBe(true)
    expect(cameraErrorState(new DOMException('denied', 'NotAllowedError'))).toBe(
      'permission_denied'
    )
    expect(cameraErrorState(new Error('device missing'))).toBe('unavailable')
  })

  it('estimates head orientation from the installed detector keypoints with confidence checks', () => {
    const keypoints = [
      { x: 0.4, y: 0.3 },
      { x: 0.6, y: 0.3 },
      { x: 0.5, y: 0.4 },
      { x: 0.5, y: 0.5 },
      { x: 0.3, y: 0.4 },
      { x: 0.7, y: 0.4 }
    ]
    expect(estimateHeadPose(keypoints, 0.9)).toMatchObject({
      yaw: 0,
      rollDegrees: 0
    })
    expect(estimateHeadPose(keypoints, 0.9)?.pitch).toBeCloseTo(0.5)
    expect(estimateHeadPose(keypoints, 0.5)).toBeUndefined()
    expect(estimateHeadPose(keypoints.slice(0, 3), 0.9)).toBeUndefined()
  })

  it('calibrates facing direction and ignores a brief head turn', () => {
    const tracker = calibratedAttentionTracker()
    expect(
      tracker.update(
        { faceCount: 1, confidence: 0.9, headPose: { yaw: 0.6, pitch: 0.5, rollDegrees: 0 } },
        5000
      ).lookingAway
    ).toBe(false)
    tracker.update(
      { faceCount: 1, confidence: 0.9, headPose: { yaw: 0.6, pitch: 0.5, rollDegrees: 0 } },
      6000
    )
    const returned = tracker.update(
      { faceCount: 1, confidence: 0.9, headPose: { yaw: 0, pitch: 0.5, rollDegrees: 0 } },
      7000
    )
    expect(returned.events).toHaveLength(0)
    expect(returned.lookingAway).toBe(false)
  })

  it('records one sustained turn only after the duration and sample thresholds, then resolves it', () => {
    const tracker = calibratedAttentionTracker()
    const turned = {
      faceCount: 1,
      confidence: 0.9,
      headPose: { yaw: 0.65, pitch: 0.5, rollDegrees: 0 }
    }
    const startedAt = 5000
    for (let index = 0; index < 3; index += 1) {
      expect(tracker.update(turned, startedAt + index * 1000).events).toHaveLength(0)
    }
    const sustainedAt = startedAt + ATTENTION_WARNING_THRESHOLD_MS + 1000
    const sustained = tracker.update(turned, sustainedAt)
    expect(sustained.lookingAway).toBe(true)
    expect(sustained.events.map((event) => event.type)).toEqual(['sustained_head_turn_left'])
    expect(sustained.events[0].observationDurationMs).toBeGreaterThanOrEqual(
      ATTENTION_WARNING_THRESHOLD_MS
    )
    expect(tracker.update(turned, sustainedAt + 1000).events).toHaveLength(0)

    tracker.update(
      { faceCount: 1, confidence: 0.9, headPose: { yaw: 0, pitch: 0.5, rollDegrees: 0 } },
      sustainedAt + 2000
    )
    const returned = tracker.update(
      { faceCount: 1, confidence: 0.9, headPose: { yaw: 0, pitch: 0.5, rollDegrees: 0 } },
      sustainedAt + 3000
    )
    expect(returned.lookingAway).toBe(false)
    expect(returned.events.map((event) => event.type)).toEqual(['attention_returned'])
  })

  it('requires a confident pose and records face loss once per sustained episode', () => {
    const tracker = calibratedAttentionTracker()
    expect(tracker.update({ faceCount: 1, confidence: 0.4 }, 5000).direction).toBe(
      'insufficient_confidence'
    )
    for (let index = 0; index < 5; index += 1) {
      expect(tracker.update({ faceCount: 0 }, 6000 + index * 1000).events).toHaveLength(0)
    }
    const faceLost = tracker.update({ faceCount: 0 }, 11_000)
    expect(faceLost.events.map((event) => event.type)).toEqual(['face_not_detected'])
    expect(tracker.update({ faceCount: 0 }, 12_000).events).toHaveLength(0)
  })
})
