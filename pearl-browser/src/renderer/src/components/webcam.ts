export type FacePresenceState = 'face_not_detected' | 'face_detected' | 'multiple_faces_detected'

export function shouldPublishCameraState(previous: string, next: string): boolean {
  return previous !== next
}

export function cameraErrorState(error: unknown): 'permission_denied' | 'unavailable' {
  const name = error instanceof DOMException ? error.name : ''
  return name === 'NotAllowedError' || name === 'SecurityError'
    ? 'permission_denied'
    : 'unavailable'
}

export function classifyFaceCount(count: number): FacePresenceState {
  if (count === 0) return 'face_not_detected'
  if (count === 1) return 'face_detected'
  return 'multiple_faces_detected'
}

export function stopCameraTracks(stream: MediaStream | undefined): void {
  stream?.getTracks().forEach((track) => track.stop())
}
