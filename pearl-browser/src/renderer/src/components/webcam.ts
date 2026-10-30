export type FacePresenceState = 'face_not_detected' | 'face_detected' | 'multiple_faces_detected'

const HAVE_CURRENT_DATA = 2

export function shouldPublishCameraState(previous: string, next: string): boolean {
  return previous !== next
}

export function cameraErrorState(error: unknown): 'permission_denied' | 'unavailable' {
  const name =
    error && typeof error === 'object' && 'name' in error && typeof error.name === 'string'
      ? error.name
      : ''
  return name === 'NotAllowedError' || name === 'SecurityError'
    ? 'permission_denied'
    : 'unavailable'
}

export function classifyFaceCount(count: number): FacePresenceState {
  if (count === 0) return 'face_not_detected'
  if (count === 1) return 'face_detected'
  return 'multiple_faces_detected'
}

export function isCameraPreviewLive(
  video: HTMLVideoElement,
  stream: MediaStream,
  track: MediaStreamTrack
): boolean {
  return (
    video.srcObject === stream &&
    track.readyState === 'live' &&
    !video.paused &&
    video.readyState >= HAVE_CURRENT_DATA &&
    video.videoWidth > 0 &&
    video.videoHeight > 0
  )
}

export function isCameraSelectionConfirmed(
  inputCount: number,
  requestedDeviceId: string | undefined,
  activeDeviceId: string
): boolean {
  return inputCount <= 1 || Boolean(requestedDeviceId && requestedDeviceId === activeDeviceId)
}

export function stopCameraTracks(stream: MediaStream | undefined): void {
  stream?.getTracks().forEach((track) => track.stop())
}
