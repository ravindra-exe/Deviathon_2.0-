import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AssessmentActivityEvent,
  AssessmentActivityEventType
} from '../../../shared/assessment'
import { cameraErrorState, classifyFaceCount, stopCameraTracks } from './webcam'

type CameraStatus =
  'not_started' | 'requesting' | 'active' | 'permission_denied' | 'unavailable' | 'disconnected'

type DetectorStatus = 'not_started' | 'loading' | 'ready' | 'error'
type FaceStatus =
  | 'waiting'
  | 'detecting'
  | 'face_not_detected'
  | 'face_detected'
  | 'multiple_faces_detected'
  | 'unavailable'

interface WebcamMonitorProps {
  enabled: boolean
  examStarted: boolean
  onReadinessChange: (ready: boolean) => void
}

interface WorkerMessage {
  type: 'ready' | 'detection' | 'error'
  faceCount?: number
  confidence?: number
  message?: string
}

const cameraLabels: Record<CameraStatus, string> = {
  not_started: 'Not started',
  requesting: 'Requesting permission',
  active: 'Live preview active',
  permission_denied: 'Permission denied',
  unavailable: 'Camera unavailable',
  disconnected: 'Camera disconnected'
}

const detectorLabels: Record<DetectorStatus, string> = {
  not_started: 'Not initialized',
  loading: 'Loading local model',
  ready: 'Ready',
  error: 'Unavailable'
}

const faceLabels: Record<FaceStatus, string> = {
  waiting: 'Waiting for camera setup',
  detecting: 'Detecting…',
  face_not_detected: 'No face detected',
  face_detected: 'One face detected',
  multiple_faces_detected: 'Multiple faces detected',
  unavailable: 'Detection unavailable'
}

export function WebcamMonitor({
  enabled,
  examStarted,
  onReadinessChange
}: WebcamMonitorProps): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | undefined>(undefined)
  const workerRef = useRef<Worker | undefined>(undefined)
  const sampleTimerRef = useRef<number | undefined>(undefined)
  const generationRef = useRef(0)
  const framePendingRef = useRef(false)
  const detectorReadyRef = useRef(false)
  const inferenceReceivedRef = useRef(false)
  const readinessConfirmationInFlightRef = useRef(false)
  const cameraStatusRef = useRef<CameraStatus>('not_started')
  const examStartedRef = useRef(examStarted)
  const faceObservationRef = useRef<
    | {
        status: FaceStatus
        count: number
        startedAt: number
        warningRecorded: boolean
      }
    | undefined
  >(undefined)
  const startedEventLoggedRef = useRef(false)
  const [consented, setConsented] = useState(false)
  const [cameraPermissionGranted, setCameraPermissionGranted] = useState(false)
  const [cameraStatus, setCameraStatus] = useState<CameraStatus>('not_started')
  const [detectorStatus, setDetectorStatus] = useState<DetectorStatus>('not_started')
  const [faceStatus, setFaceStatus] = useState<FaceStatus>('waiting')
  const [latestDetectionAt, setLatestDetectionAt] = useState<string | undefined>()
  const [latestConfidence, setLatestConfidence] = useState<number | undefined>()
  const [setupReady, setSetupReady] = useState(false)
  const [error, setError] = useState('')
  cameraStatusRef.current = cameraStatus
  examStartedRef.current = examStarted
  const cameraActive = cameraStatus === 'active'
  const currentSetupStatus = setupReady ? 'Ready for exam' : 'Setup incomplete'

  const record = useCallback(
    (type: AssessmentActivityEventType, evidence?: Omit<AssessmentActivityEvent, 'type'>): void => {
      if (!examStartedRef.current) return
      void window.browser.assessment
        .recordActivityEvent({ type, ...evidence })
        .catch(() => undefined)
    },
    []
  )

  const updateReadiness = useCallback(
    (ready: boolean): void => {
      if (!ready) {
        setSetupReady(false)
        onReadinessChange(false)
      }
      void window.browser.assessment
        .setCameraReadiness(ready)
        .then(() => {
          if (ready) {
            setSetupReady(true)
            onReadinessChange(true)
          }
        })
        .catch((cause: unknown) => {
          setSetupReady(false)
          onReadinessChange(false)
          if (ready) {
            setDetectorStatus('error')
            setError(
              cause instanceof Error
                ? cause.message
                : 'Pearl Browser could not confirm camera and detector readiness.'
            )
          }
        })
    },
    [onReadinessChange]
  )

  const stop = useCallback(
    (recordStopped: boolean, revokeConsent: boolean, updateUi: boolean): void => {
      generationRef.current += 1
      if (sampleTimerRef.current !== undefined) window.clearInterval(sampleTimerRef.current)
      sampleTimerRef.current = undefined
      workerRef.current?.postMessage({ type: 'dispose' })
      workerRef.current?.terminate()
      workerRef.current = undefined
      detectorReadyRef.current = false
      inferenceReceivedRef.current = false
      readinessConfirmationInFlightRef.current = false
      framePendingRef.current = false
      faceObservationRef.current = undefined
      stopCameraTracks(streamRef.current)
      streamRef.current = undefined
      if (videoRef.current) videoRef.current.srcObject = null
      if (recordStopped && cameraStatusRef.current === 'active') record('camera_stopped')
      if (updateUi) updateReadiness(false)
      else void window.browser.assessment.setCameraReadiness(false).catch(() => undefined)
      if (recordStopped) startedEventLoggedRef.current = false
      if (revokeConsent) {
        void window.browser.assessment.setCameraConsent(false).catch(() => undefined)
        if (updateUi) setConsented(false)
      }
      if (updateUi) {
        setCameraPermissionGranted(false)
        setCameraStatus('not_started')
        setDetectorStatus('not_started')
        setFaceStatus('waiting')
        setLatestDetectionAt(undefined)
        setLatestConfidence(undefined)
      }
    },
    [record, updateReadiness]
  )

  const sampleFrame = useCallback(async (): Promise<void> => {
    const video = videoRef.current
    const worker = workerRef.current
    if (
      !detectorReadyRef.current ||
      framePendingRef.current ||
      !video ||
      video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
    ) {
      return
    }
    framePendingRef.current = true
    try {
      const bitmap = await createImageBitmap(video)
      if (!workerRef.current || workerRef.current !== worker) {
        bitmap.close()
        framePendingRef.current = false
        return
      }
      worker.postMessage({ type: 'frame', bitmap, timestamp: performance.now() }, [bitmap])
    } catch {
      framePendingRef.current = false
      setError('A camera frame could not be prepared for local face detection. Retry webcam setup.')
      updateReadiness(false)
      setDetectorStatus('error')
    }
  }, [updateReadiness])

  const confirmDetectorReady = useCallback(
    async (generation: number): Promise<void> => {
      if (readinessConfirmationInFlightRef.current || setupReady) return
      readinessConfirmationInFlightRef.current = true
      const stream = streamRef.current
      const video = videoRef.current
      const track = stream?.getVideoTracks()[0]
      if (
        generation !== generationRef.current ||
        !stream ||
        !track ||
        track.readyState !== 'live' ||
        !video ||
        video.srcObject !== stream ||
        video.paused ||
        video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
        video.videoWidth === 0 ||
        video.videoHeight === 0
      ) {
        readinessConfirmationInFlightRef.current = false
        setDetectorStatus('error')
        setFaceStatus('unavailable')
        setError('The camera preview stopped before detector setup finished. Retry webcam setup.')
        updateReadiness(false)
        return
      }
      try {
        await window.browser.assessment.setCameraReadiness(true)
        if (generation !== generationRef.current) return
        detectorReadyRef.current = true
        setDetectorStatus('ready')
        setFaceStatus('detecting')
        setError('')
        setSetupReady(true)
        onReadinessChange(true)
      } catch (cause) {
        if (generation !== generationRef.current) return
        setDetectorStatus('error')
        setError(
          cause instanceof Error
            ? cause.message
            : 'Pearl Browser could not confirm camera and detector readiness.'
        )
        updateReadiness(false)
      } finally {
        readinessConfirmationInFlightRef.current = false
      }
    },
    [onReadinessChange, setupReady, updateReadiness]
  )

  const processFaceObservation = useCallback(
    (status: FaceStatus, observedAt: number, confidence?: number): void => {
      if (!['face_not_detected', 'face_detected', 'multiple_faces_detected'].includes(status)) {
        faceObservationRef.current = undefined
        return
      }
      const previous = faceObservationRef.current
      const observation =
        previous?.status === status
          ? { ...previous, count: previous.count + 1 }
          : { status, count: 1, startedAt: observedAt, warningRecorded: false }
      faceObservationRef.current = observation
      if (!examStartedRef.current || observation.warningRecorded) return

      const durationMs = Math.max(0, observedAt - observation.startedAt)
      const details = {
        observationCount: observation.count,
        observationDurationMs: Math.min(durationMs, 600_000),
        ...(typeof confidence === 'number' && Number.isFinite(confidence) ? { confidence } : {})
      }
      if (status === 'face_detected' && observation.count >= 2 && durationMs >= 1_000) {
        observation.warningRecorded = true
        record('face_detected', details)
      } else if (status === 'face_not_detected' && observation.count >= 6 && durationMs >= 5_000) {
        observation.warningRecorded = true
        record('face_not_detected', details)
      } else if (
        status === 'multiple_faces_detected' &&
        observation.count >= 3 &&
        durationMs >= 2_000
      ) {
        observation.warningRecorded = true
        record('multiple_faces_detected', details)
      }
    },
    [record]
  )

  const sampleFace = useCallback(async (): Promise<void> => {
    if (!enabled || !consented) return
    stop(false, false, true)
    const generation = generationRef.current
    setError('')
    setSetupReady(false)
    onReadinessChange(false)
    setCameraStatus('requesting')
    setDetectorStatus('loading')
    setFaceStatus('waiting')
    setLatestDetectionAt(undefined)
    setLatestConfidence(undefined)
    faceObservationRef.current = undefined
    try {
      await window.browser.assessment.setCameraConsent(true)
      const stream = await acquireCameraStream()
      if (generation !== generationRef.current) {
        stopCameraTracks(stream)
        return
      }
      const track = stream.getVideoTracks()[0]
      if (!track || track.readyState !== 'live') {
        stopCameraTracks(stream)
        throw new Error('The camera did not provide a live video track.')
      }
        setCameraPermissionGranted(true)
      streamRef.current = stream
      track.addEventListener(
        'ended',
        () => {
          if (generation !== generationRef.current) return
          record('camera_disconnected')
          stop(false, false, true)
            setCameraPermissionGranted(false)
          setCameraStatus('disconnected')
          setDetectorStatus('error')
          setError('The camera disconnected. Reconnect it and retry setup.')
        },
        { once: true }
      )
      const video = videoRef.current
      if (!video) throw new Error('The camera preview is not available in this window.')
      video.srcObject = stream
      await video.play()
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        await waitForVideoData(video, track)
      }
      await waitForDecodedVideoFrame(video, track)
      if (
        generation !== generationRef.current ||
        track.readyState !== 'live' ||
        video.paused ||
        video.videoWidth === 0 ||
        video.videoHeight === 0
      ) {
        throw new Error('The camera stream did not produce a live preview.')
      }
      setCameraStatus('active')

      const worker = new Worker(new URL('./facePresence.worker.ts', import.meta.url), {
        name: 'pearl-local-face-presence'
      })
      workerRef.current = worker
      worker.onmessage = (event: MessageEvent<WorkerMessage>): void => {
        if (generation !== generationRef.current) return
        const message = event.data
        if (message.type === 'ready') {
          detectorReadyRef.current = true
          setDetectorStatus('ready')
          setFaceStatus('detecting')
          return
        }
        if (message.type === 'detection') {
          framePendingRef.current = false
          const now = Date.now()
          const next = classifyFaceCount(message.faceCount ?? 0)
          setFaceStatus(next)
          setLatestDetectionAt(new Date(now).toISOString())
          setLatestConfidence(
            typeof message.confidence === 'number' && Number.isFinite(message.confidence)
              ? message.confidence
              : undefined
          )
          if (!inferenceReceivedRef.current) {
            inferenceReceivedRef.current = true
            void confirmDetectorReady(generation)
          }
          processFaceObservation(next, now, message.confidence)
          return
        }
        framePendingRef.current = false
        detectorReadyRef.current = false
        setDetectorStatus('error')
        setFaceStatus('unavailable')
        setError(
          `Local face detection could not start: ${message.message ?? 'Unknown detector error'}`
        )
        updateReadiness(false)
      }
      worker.onerror = (event: ErrorEvent): void => {
        if (generation !== generationRef.current) return
        framePendingRef.current = false
        detectorReadyRef.current = false
        setDetectorStatus('error')
        setFaceStatus('unavailable')
        setError(
          event.message
            ? `The local face detector failed: ${event.message}. Retry webcam setup.`
            : 'The local face detector stopped unexpectedly. Retry webcam setup.'
        )
        updateReadiness(false)
      }
      const assetBase = new URL('./mediapipe/', window.location.href).toString()
      worker.postMessage({
        type: 'initialize',
        wasmBaseUrl: assetBase,
        modelUrl: new URL('face_detector.tflite', assetBase).toString()
      })
    } catch (cause) {
      if (generation !== generationRef.current) return
      const permissionDenied = cameraErrorState(cause) === 'permission_denied'
      stop(false, false, true)
      if (permissionDenied) {
          setCameraPermissionGranted(false)
        setCameraStatus('permission_denied')
        setError(
          'Camera permission was denied. In Windows, allow camera access for desktop apps in Settings → Privacy & security → Camera, then retry.'
        )
        if (examStartedRef.current) record('camera_permission_denied')
      } else {
          setCameraPermissionGranted(false)
        setCameraStatus('unavailable')
        setError(describeCameraError(cause))
        if (examStartedRef.current) record('camera_unavailable')
      }
      void window.browser.assessment.setCameraReadiness(false).catch(() => undefined)
    }
  }, [
    consented,
    confirmDetectorReady,
    enabled,
    onReadinessChange,
    processFaceObservation,
    record,
    sampleFrame,
    stop,
    updateReadiness
  ])

  useEffect(() => {
    if (examStarted && setupReady && !startedEventLoggedRef.current) {
      startedEventLoggedRef.current = true
      record('camera_started')
    }
  }, [examStarted, record, setupReady])

  useEffect(() => {
    if (examStarted) faceObservationRef.current = undefined
  }, [examStarted])

  useEffect(() => {
    if (!cameraActive || detectorStatus !== 'ready' || !detectorReadyRef.current) return
    void sampleFrame()
    sampleTimerRef.current = window.setInterval(() => void sampleFrame(), 1000)
    return () => {
      if (sampleTimerRef.current !== undefined) window.clearInterval(sampleTimerRef.current)
      sampleTimerRef.current = undefined
    }
  }, [cameraActive, detectorStatus, sampleFrame])

  useEffect(() => {
    if (!enabled) stop(false, true, true)
  }, [enabled, stop])

  useEffect(() => () => stop(false, true, false), [stop])

  return (
    <section className="webcam-proctoring" aria-labelledby="webcam-proctoring-title">
      <div className="webcam-proctoring-heading">
        <div>
          <span className="proctoring-eyebrow">Pre-exam camera check</span>
          <h2 id="webcam-proctoring-title">Webcam Proctoring</h2>
        </div>
        <span className={`webcam-readiness-pill ${setupReady ? 'is-ready' : ''}`} role="status">
          <span /> {currentSetupStatus}
        </span>
      </div>
      <div className={`webcam-card ${cameraActive ? 'webcam-card-active' : ''}`}>
        <div className="webcam-preview-wrap">
          <video
            ref={videoRef}
            muted
            playsInline
            autoPlay
            aria-label="Live webcam preview"
            className={cameraActive ? 'webcam-video-active' : ''}
          />
          {!cameraActive && (
            <div className="webcam-preview-placeholder">
              <span aria-hidden="true">◉</span>
              <strong>Camera preview</strong>
              <small>Live video appears after permission is granted</small>
            </div>
          )}
        </div>
        <div className="webcam-details">
          <div className="webcam-preflight-statuses">
            <div className={`webcam-state-row ${cameraPermissionGranted ? 'state-good' : ''}`}>
              <span className="face-state-dot" />
              <span>Camera permission</span>
              <strong>
                {cameraPermissionGranted
                  ? 'Granted'
                  : cameraStatus === 'permission_denied'
                    ? 'Denied'
                    : 'Waiting'}
              </strong>
            </div>
            <div className={`webcam-state-row ${cameraActive ? 'state-good' : ''}`}>
              <span className="face-state-dot" />
              <span>Live preview</span>
              <strong>{cameraLabels[cameraStatus]}</strong>
            </div>
            <div className={`webcam-state-row ${detectorStatus === 'ready' ? 'state-good' : ''}`}>
              <span className="face-state-dot" />
              <span>Face detector</span>
              <strong>{detectorLabels[detectorStatus]}</strong>
            </div>
            <div
              className={`webcam-state-row ${faceStatus === 'face_detected' ? 'state-good' : ''}`}
              aria-live="polite"
            >
              <span className="face-state-dot" />
              <span>Face presence</span>
              <strong>{faceLabels[faceStatus]}</strong>
            </div>
          </div>
          <div className="webcam-observation-meta" aria-live="polite">
            <span>
              Latest detection{' '}
              {latestDetectionAt ? (
                <time dateTime={latestDetectionAt}>
                  {new Date(latestDetectionAt).toLocaleTimeString()}
                </time>
              ) : (
                'not received yet'
              )}
            </span>
            {latestConfidence !== undefined && (
              <span>Top confidence {Math.round(latestConfidence * 100)}%</span>
            )}
          </div>
          <p>
            Face presence is processed locally on this device. Video and audio are not uploaded or
            saved. Face counts are observable signals only; they do not identify anyone or decide
            assessment results.
          </p>
          <label className="webcam-consent">
            <input
              type="checkbox"
              checked={consented}
              disabled={cameraActive || cameraStatus === 'requesting' || !enabled}
              onChange={(event) => {
                const checked = event.currentTarget.checked
                setConsented(checked)
                if (!checked) {
                  stop(false, true, true)
                }
              }}
            />
            <span>I consent to local face-presence monitoring for this live attempt.</span>
          </label>
          {error && (
            <div className="webcam-error" role="alert">
              <strong>Webcam setup is not ready</strong>
              <span>{error}</span>
            </div>
          )}
          <div className="webcam-actions">
            {cameraActive ? (
              <button
                className="toolbar-button"
                type="button"
                onClick={() => stop(true, true, true)}
              >
                Turn camera off
              </button>
            ) : (
              <button
                className="go-button"
                type="button"
                onClick={() => void sampleFace()}
                disabled={!enabled || !consented || cameraStatus === 'requesting'}
              >
                {cameraStatus === 'requesting'
                  ? 'Checking camera and detector…'
                  : setupReady
                    ? 'Camera and detector ready'
                    : error
                      ? 'Retry setup'
                      : 'Set up webcam'}
              </button>
            )}
            {cameraActive && detectorStatus === 'error' && (
              <button
                className="text-button webcam-retry"
                type="button"
                onClick={() => void sampleFace()}
                disabled={!enabled || !consented}
              >
                Retry detector setup
              </button>
            )}
          </div>
          {!setupReady && (
            <p className="webcam-preflight-note">
              Face detection runs during this setup check. The exam timer stays stopped until a live
              video frame has been analyzed locally.
            </p>
          )}
        </div>
      </div>
    </section>
  )
}

async function waitForVideoData(video: HTMLVideoElement, track: MediaStreamTrack): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(
      () => finish(new Error('Timed out waiting for camera video.')),
      5000
    )
    const onData = (): void => finish()
    const onEnded = (): void => finish(new Error('Camera stopped before the preview started.'))
    const finish = (error?: Error): void => {
      window.clearTimeout(timeout)
      video.removeEventListener('loadeddata', onData)
      track.removeEventListener('ended', onEnded)
      if (error) reject(error)
      else resolve()
    }
    video.addEventListener('loadeddata', onData, { once: true })
    track.addEventListener('ended', onEnded, { once: true })
  })
}

async function acquireCameraStream(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error(
      'Electron does not expose camera capture in this window. Restart Pearl Browser and retry.'
    )
  }
  try {
    return await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
  } catch (firstError) {
    if (cameraErrorState(firstError) === 'permission_denied') throw firstError
    let lastError: unknown = firstError
    const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [])
    const cameras = devices
      .filter((device) => device.kind === 'videoinput' && device.deviceId)
      .slice(0, 8)
    for (const camera of cameras) {
      try {
        return await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: camera.deviceId } },
          audio: false
        })
      } catch (error) {
        lastError = error
        if (cameraErrorState(error) === 'permission_denied') throw error
      }
    }
    throw lastError
  }
}

function describeCameraError(error: unknown): string {
  const name =
    error && typeof error === 'object' && 'name' in error && typeof error.name === 'string'
      ? error.name
      : ''
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'Windows did not provide a usable camera. Connect or enable a camera in Device Manager, close other capture apps, then retry.'
  }
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
    return 'A camera is present but could not be opened. Close Teams, Zoom, Camera, or other apps using it, then retry.'
  }
  if (name === 'OverconstrainedError') {
    return 'The available camera could not satisfy the video request. Reconnect the camera and retry.'
  }
  const detail = error instanceof Error ? error.message : ''
  return detail
    ? `Camera setup failed${name ? ` (${name})` : ''}: ${detail}`
    : 'No usable camera stream was returned. Connect or enable a camera, then retry.'
}

async function waitForDecodedVideoFrame(
  video: HTMLVideoElement,
  track: MediaStreamTrack
): Promise<void> {
  if (
    video.paused ||
    track.readyState !== 'live' ||
    video.videoWidth === 0 ||
    video.videoHeight === 0
  ) {
    throw new Error('The camera preview is not playing a decoded video frame.')
  }
  const requestVideoFrame = (
    video as unknown as { requestVideoFrameCallback?: (callback: () => void) => number }
  ).requestVideoFrameCallback
  if (typeof requestVideoFrame === 'function') {
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(
        () => finish(new Error('Timed out waiting for a decoded camera frame.')),
        3_000
      )
      const onEnded = (): void =>
        finish(new Error('The camera stopped before a frame was decoded.'))
      const finish = (error?: Error): void => {
        window.clearTimeout(timeout)
        track.removeEventListener('ended', onEnded)
        if (error) reject(error)
        else resolve()
      }
      track.addEventListener('ended', onEnded, { once: true })
      requestVideoFrame.call(video, () => finish())
    })
    return
  }
  const before = video.currentTime
  await new Promise<void>((resolve) => window.setTimeout(resolve, 400))
  if (
    video.paused ||
    track.readyState !== 'live' ||
    video.videoWidth === 0 ||
    video.videoHeight === 0 ||
    video.currentTime <= before
  ) {
    throw new Error('The camera preview did not advance to a decoded video frame.')
  }
}
