import { useCallback, useEffect, useRef, useState } from 'react'
import type { AssessmentActivityEventType } from '../../../shared/assessment'
import {
  cameraErrorState,
  classifyFaceCount,
  shouldPublishCameraState,
  stopCameraTracks
} from './webcam'

type CameraState =
  | 'idle'
  | 'requesting'
  | 'active'
  | 'face_not_detected'
  | 'face_detected'
  | 'multiple_faces_detected'
  | 'permission_denied'
  | 'unavailable'
  | 'disconnected'

interface NativeFaceDetector {
  detect(source: HTMLVideoElement): Promise<ReadonlyArray<unknown>>
}

interface WebcamMonitorProps {
  monitoring: boolean
  onReady: (ready: boolean) => void
}

const stateLabels: Record<CameraState, string> = {
  idle: 'Camera not enabled',
  requesting: 'Requesting camera permission…',
  active: 'Camera active',
  face_not_detected: 'Face not detected',
  face_detected: 'Face detected',
  multiple_faces_detected: 'Multiple faces detected',
  permission_denied: 'Camera permission denied',
  unavailable: 'Camera unavailable',
  disconnected: 'Camera disconnected'
}

export function WebcamMonitor({ monitoring, onReady }: WebcamMonitorProps): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | undefined>(undefined)
  const detectorRef = useRef<NativeFaceDetector | undefined>(undefined)
  const timerRef = useRef<number | undefined>(undefined)
  const lastStateRef = useRef<CameraState>('idle')
  const [state, setState] = useState<CameraState>('idle')
  const [error, setError] = useState<string>()

  const publish = (next: CameraState, eventType?: AssessmentActivityEventType): void => {
    if (!shouldPublishCameraState(lastStateRef.current, next)) return
    lastStateRef.current = next
    setState(next)
    onReady(next === 'active' || next === 'face_detected' || next === 'face_not_detected')
    if (monitoring && eventType)
      void window.browser.assessment.recordActivityEvent({ type: eventType })
  }

  const stop = useCallback((): void => {
    if (timerRef.current !== undefined) window.clearInterval(timerRef.current)
    timerRef.current = undefined
    stopCameraTracks(streamRef.current)
    streamRef.current = undefined
    if (videoRef.current) videoRef.current.srcObject = null
    onReady(false)
  }, [onReady])

  const start = async (): Promise<void> => {
    stop()
    setError(undefined)
    setState('requesting')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      streamRef.current = stream
      const track = stream.getVideoTracks()[0]
      if (!track) throw new Error('No camera track was returned.')
      track.addEventListener('ended', () => publish('disconnected', 'camera_disconnected'))
      if (!videoRef.current) throw new Error('Camera preview is unavailable.')
      videoRef.current.srcObject = stream
      await videoRef.current.play()
      publish('active', 'camera_started')
      const Detector = (
        window as Window & {
          FaceDetector?: new () => NativeFaceDetector
        }
      ).FaceDetector
      detectorRef.current = Detector ? new Detector() : undefined
      if (!detectorRef.current) {
        setError('This Chromium build does not provide local face-presence detection.')
      }
      timerRef.current = window.setInterval(() => {
        void sample()
      }, 1000)
    } catch (cause) {
      const next = cameraErrorState(cause)
      const denied = next === 'permission_denied'
      publish(next, denied ? 'camera_permission_denied' : 'camera_unavailable')
      setError(
        denied
          ? 'Allow camera access in the browser permission prompt to continue.'
          : 'No usable camera was found.'
      )
    }
  }

  const sample = async (): Promise<void> => {
    const detector = detectorRef.current
    const video = videoRef.current
    if (!detector || !video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return
    try {
      const faces = await detector.detect(video)
      const next = classifyFaceCount(faces.length)
      publish(next, next)
    } catch {
      setError('Local face-presence detection is temporarily unavailable.')
    }
  }

  useEffect(() => stop, [stop])
  useEffect(() => {
    if (!monitoring) return
    return () => stop()
  }, [monitoring, stop])
  useEffect(() => {
    if (monitoring && state === 'active') {
      void window.browser.assessment.recordActivityEvent({ type: 'camera_started' })
    }
  }, [monitoring, state])

  return (
    <div className="webcam-card">
      <video ref={videoRef} muted playsInline aria-label="Live camera preview" />
      <div>
        <strong>{stateLabels[state]}</strong>
        <p>Only camera status is recorded. No video or images leave this device.</p>
        {error && <p role="alert">{error}</p>}
        {!monitoring && state !== 'active' && (
          <button className="go-button" type="button" onClick={() => void start()}>
            Enable camera
          </button>
        )}
      </div>
    </div>
  )
}
