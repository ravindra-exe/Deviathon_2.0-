import { describe, expect, it, vi } from 'vitest'
import {
  cameraErrorState,
  classifyFaceCount,
  shouldPublishCameraState,
  stopCameraTracks
} from '../src/renderer/src/components/webcam'

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

  it('deduplicates unchanged detection states and classifies permission errors', () => {
    expect(shouldPublishCameraState('face_detected', 'face_detected')).toBe(false)
    expect(shouldPublishCameraState('face_detected', 'face_not_detected')).toBe(true)
    expect(cameraErrorState(new DOMException('denied', 'NotAllowedError'))).toBe(
      'permission_denied'
    )
    expect(cameraErrorState(new Error('device missing'))).toBe('unavailable')
  })
})
