import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AssessmentActivityEvent,
  AssessmentActivityEventType
} from '../../../shared/assessment'
import {
  cameraErrorState,
  classifyFaceCount,
  isCameraPreviewLive,
  isCameraSelectionConfirmed,
  stopCameraTracks
} from './webcam'
import {
  AttentionTracker,
  type AttentionDirection,
  type AttentionEvent,
  type HeadPoseEstimate
} from './attention'

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
  headPose?: HeadPoseEstimate
  message?: string
}

interface AttentionTimelineEvent extends AttentionEvent {
  occurredAt: string
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

const attentionLabels: Record<AttentionDirection, string> = {
  calibrating: 'Calibrating — face the screen',
  facing_screen: 'Facing screen',
  head_left: 'Head turned left',
  head_right: 'Head turned right',
  head_down: 'Head tilted or looking down',
  face_not_detected: 'Face not detected',
  insufficient_confidence: 'Insufficient visual confidence'
}

const attentionEventLabels: Record<AttentionEvent['type'], string> = {
  attention_monitoring_started: 'Attention monitoring started',
  sustained_head_turn_left: 'Sustained head turn left',
  sustained_head_turn_right: 'Sustained head turn right',
  sustained_head_down: 'Sustained head tilt or downward direction',
  face_not_detected: 'Face not detected',
  attention_returned: 'Returned to calibrated viewing direction'
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
  const cameraSelectionConfirmedRef = useRef(true)
  const previewStopListenerRef = useRef<
    { video: HTMLVideoElement; listener: () => void } | undefined
  >(undefined)
  const attentionTrackerRef = useRef(new AttentionTracker())
  const attentionStartedEventLoggedRef = useRef(false)
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
  const [cameraInputs, setCameraInputs] = useState<MediaDeviceInfo[]>([])
  const [selectedCameraId, setSelectedCameraId] = useState('')
  const [activeCameraId, setActiveCameraId] = useState('')
  const [cameraSelectionConfirmed, setCameraSelectionConfirmed] = useState(true)
  const [cameraStatus, setCameraStatus] = useState<CameraStatus>('not_started')
  const [detectorStatus, setDetectorStatus] = useState<DetectorStatus>('not_started')
  const [detectorInitialized, setDetectorInitialized] = useState(false)
  const [faceStatus, setFaceStatus] = useState<FaceStatus>('waiting')
  const [latestDetectionAt, setLatestDetectionAt] = useState<string | undefined>()
  const [latestConfidence, setLatestConfidence] = useState<number | undefined>()
  const [attentionDirection, setAttentionDirection] = useState<AttentionDirection>('calibrating')
  const [attentionCalibrated, setAttentionCalibrated] = useState(false)
  const [calibrationSamples, setCalibrationSamples] = useState(0)
  const [lookingAway, setLookingAway] = useState(false)
  const [lookingAwayDurationMs, setLookingAwayDurationMs] = useState(0)
  const [attentionEvents, setAttentionEvents] = useState<AttentionTimelineEvent[]>([])
  const [setupReady, setSetupReady] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    cameraStatusRef.current = cameraStatus
    examStartedRef.current = examStarted
  }, [cameraStatus, examStarted])
  const cameraActive = enabled && cameraStatus === 'active'
  const currentSetupStatus = setupReady ? 'Ready for exam' : 'Setup incomplete'
  const attentionBanner =
    lookingAway &&
    (attentionDirection === 'face_not_detected' || attentionDirection === 'insufficient_confidence')
      ? 'Looking-away signal unresolved'
      : lookingAway
        ? 'Looking away detected'
        : !cameraActive
          ? 'Camera setup required'
          : !attentionCalibrated
            ? 'Calibrating'
            : attentionDirection === 'face_not_detected'
              ? 'Face not detected'
              : attentionDirection === 'insufficient_confidence'
                ? 'Insufficient visual confidence'
                : 'No sustained looking-away signal'

  const record = useCallback(
    (type: AssessmentActivityEventType, evidence?: Omit<AssessmentActivityEvent, 'type'>): void => {
      if (!examStartedRef.current) return
      void window.browser.assessment
        .recordActivityEvent({ type, ...evidence })
        .catch(() => undefined)
    },
    []
  )

  const appendAttentionEvent = useCallback(
    (event: AttentionEvent): void => {
      if (!examStartedRef.current) return
      const occurredAt = new Date().toISOString()
      setAttentionEvents((current) => [...current, { ...event, occurredAt }])
      record(event.type, {
        ...(event.observationCount > 0 ? { observationCount: event.observationCount } : {}),
        observationDurationMs: Math.min(event.observationDurationMs, 600_000),
        ...(event.confidence !== undefined ? { confidence: event.confidence } : {})
      })
    },
    [record]
  )

  const updateAttention = useCallback(
    (message: WorkerMessage, observedAt: number): void => {
      const result = attentionTrackerRef.current.update(
        {
          faceCount: message.faceCount ?? 0,
          confidence: message.confidence,
          headPose: message.headPose
        },
        observedAt
      )
      setAttentionDirection(result.direction)
      setAttentionCalibrated(result.calibrated)
      setCalibrationSamples(result.calibrationSamples)
      setLookingAway(result.lookingAway)
      setLookingAwayDurationMs(result.lookingAwayDurationMs)
      if (examStartedRef.current && !attentionStartedEventLoggedRef.current) {
        attentionStartedEventLoggedRef.current = true
        appendAttentionEvent({
          type: 'attention_monitoring_started',
          observationCount: 1,
          observationDurationMs: 0
        })
      }
      result.events.forEach(appendAttentionEvent)
    },
    [appendAttentionEvent]
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
            detectorReadyRef.current = false
            setDetectorInitialized(false)
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
      if (previewStopListenerRef.current) {
        const { video, listener } = previewStopListenerRef.current
        video.removeEventListener('pause', listener)
        video.removeEventListener('emptied', listener)
        previewStopListenerRef.current = undefined
      }
      workerRef.current?.postMessage({ type: 'dispose' })
      workerRef.current?.terminate()
      workerRef.current = undefined
      detectorReadyRef.current = false
      inferenceReceivedRef.current = false
      cameraSelectionConfirmedRef.current = false
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
        setActiveCameraId('')
        setCameraSelectionConfirmed(false)
        setCameraStatus('not_started')
        setDetectorStatus('not_started')
        setDetectorInitialized(false)
        setFaceStatus('waiting')
        setLatestDetectionAt(undefined)
        setLatestConfidence(undefined)
        attentionTrackerRef.current.reset()
        setAttentionDirection('calibrating')
        setAttentionCalibrated(false)
        setCalibrationSamples(0)
        setLookingAway(false)
        setLookingAwayDurationMs(0)
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
      detectorReadyRef.current = false
      setDetectorInitialized(false)
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
        !video ||
        !isCameraPreviewLive(video, stream, track) ||
        !cameraSelectionConfirmedRef.current
      ) {
        readinessConfirmationInFlightRef.current = false
        detectorReadyRef.current = false
        setDetectorInitialized(false)
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

  const sampleFace = useCallback(
    async (requestedCameraId?: string): Promise<void> => {
      if (!enabled || !consented) return
      stop(false, false, true)
      const generation = generationRef.current
      setError('')
      setSetupReady(false)
      setDetectorInitialized(false)
      onReadinessChange(false)
      setCameraStatus('requesting')
      setDetectorStatus('loading')
      setFaceStatus('waiting')
      setLatestDetectionAt(undefined)
      setLatestConfidence(undefined)
      attentionTrackerRef.current.reset()
      if (!examStartedRef.current) {
        attentionStartedEventLoggedRef.current = false
        setAttentionEvents([])
      }
      setAttentionDirection('calibrating')
      setAttentionCalibrated(false)
      setCalibrationSamples(0)
      setLookingAway(false)
      setLookingAwayDurationMs(0)
      faceObservationRef.current = undefined
      try {
        await window.browser.assessment.setCameraConsent(true)
        const stream = await acquireCameraStream(requestedCameraId)
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
        const cameraInputs = await enumerateCameraInputs()
        if (generation !== generationRef.current) {
          stopCameraTracks(stream)
          return
        }
        const currentCameraId = track.getSettings().deviceId ?? ''
        if (requestedCameraId && currentCameraId !== requestedCameraId) {
          throw new Error(
            'Windows did not open the selected camera input. Choose another camera and retry.'
          )
        }
        setCameraInputs(cameraInputs)
        setActiveCameraId(currentCameraId)
        setSelectedCameraId(cameraInputs.length > 1 && !requestedCameraId ? '' : currentCameraId)
        const selectionConfirmed = isCameraSelectionConfirmed(
          cameraInputs.length,
          requestedCameraId,
          currentCameraId
        )
        cameraSelectionConfirmedRef.current = selectionConfirmed
        setCameraSelectionConfirmed(selectionConfirmed)
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
        if (generation !== generationRef.current || !isCameraPreviewLive(video, stream, track)) {
          throw new Error('The camera stream did not produce a live preview.')
        }
        setCameraStatus('active')
        if (!cameraSelectionConfirmedRef.current) {
          setDetectorStatus('not_started')
          setFaceStatus('waiting')
          setError(
            'Choose the camera you want to use, then apply that selection before continuing.'
          )
          return
        }
        const onPreviewStopped = (): void => {
          if (
            generation !== generationRef.current ||
            video.srcObject !== stream ||
            isCameraPreviewLive(video, stream, track)
          ) {
            return
          }
          detectorReadyRef.current = false
          setDetectorInitialized(false)
          setDetectorStatus('error')
          setFaceStatus('unavailable')
          setError('The live camera preview stopped. Retry webcam setup.')
          updateReadiness(false)
        }
        previewStopListenerRef.current = { video, listener: onPreviewStopped }
        video.addEventListener('pause', onPreviewStopped)
        video.addEventListener('emptied', onPreviewStopped)

        const worker = new Worker(new URL('./facePresence.worker.ts', import.meta.url), {
          name: 'pearl-local-face-presence',
          type: 'module'
        })
        workerRef.current = worker
        worker.onmessage = (event: MessageEvent<WorkerMessage>): void => {
          if (generation !== generationRef.current) return
          const message = event.data
          if (message.type === 'ready') {
            detectorReadyRef.current = true
            setDetectorInitialized(true)
            setFaceStatus('detecting')
            return
          }
          if (message.type === 'detection') {
            framePendingRef.current = false
            if (
              typeof message.faceCount !== 'number' ||
              !Number.isInteger(message.faceCount) ||
              message.faceCount < 0 ||
              (message.confidence !== undefined &&
                (typeof message.confidence !== 'number' ||
                  !Number.isFinite(message.confidence) ||
                  message.confidence < 0 ||
                  message.confidence > 1))
            ) {
              detectorReadyRef.current = false
              setDetectorInitialized(false)
              setDetectorStatus('error')
              setFaceStatus('unavailable')
              setError('The local face detector returned an invalid result. Retry webcam setup.')
              updateReadiness(false)
              return
            }
            const now = Date.now()
            const next = classifyFaceCount(message.faceCount ?? 0)
            updateAttention(message, now)
            setDetectorStatus('ready')
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
          setDetectorInitialized(false)
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
          setDetectorInitialized(false)
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
    },
    [
      consented,
      confirmDetectorReady,
      enabled,
      onReadinessChange,
      processFaceObservation,
      record,
      stop,
      updateAttention,
      updateReadiness
    ]
  )

  useEffect(() => {
    if (examStarted && setupReady && !startedEventLoggedRef.current) {
      startedEventLoggedRef.current = true
      record('camera_started')
    }
  }, [examStarted, record, setupReady])

  useEffect(() => {
    if (examStarted) {
      faceObservationRef.current = undefined
      attentionTrackerRef.current.beginAttempt()
      setAttentionDirection(
        attentionTrackerRef.current.isCalibrated() ? 'facing_screen' : 'calibrating'
      )
      setLookingAway(false)
      setLookingAwayDurationMs(0)
    }
  }, [examStarted])

  useEffect(() => {
    if (!cameraActive || !detectorInitialized || !detectorReadyRef.current) return
    void sampleFrame()
    sampleTimerRef.current = window.setInterval(() => void sampleFrame(), 1000)
    return () => {
      if (sampleTimerRef.current !== undefined) window.clearInterval(sampleTimerRef.current)
      sampleTimerRef.current = undefined
    }
  }, [cameraActive, detectorInitialized, sampleFrame])

  useEffect(() => {
    if (enabled) return
    const timer = window.setTimeout(() => stop(false, true, true), 0)
    return () => window.clearTimeout(timer)
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
          {cameraInputs.length > 1 && (
            <label className="webcam-camera-selection">
              <span>Camera input</span>
              <select
                value={selectedCameraId}
                disabled={cameraStatus === 'requesting'}
                onChange={(event) => {
                  setSelectedCameraId(event.currentTarget.value)
                  cameraSelectionConfirmedRef.current = false
                  setCameraSelectionConfirmed(false)
                  updateReadiness(false)
                }}
              >
                <option value="">Choose a camera</option>
                {cameraInputs.map((camera, index) => (
                  <option key={camera.deviceId} value={camera.deviceId}>
                    {camera.label || `Camera ${index + 1}`}
                  </option>
                ))}
              </select>
              <small>
                Select the intended physical camera. Readiness stays blocked until that exact input
                is active.
              </small>
            </label>
          )}
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
              <>
                {(!cameraSelectionConfirmed || selectedCameraId !== activeCameraId) && (
                  <button
                    className="go-button"
                    type="button"
                    onClick={() => void sampleFace(selectedCameraId || undefined)}
                    disabled={!enabled || !consented || !selectedCameraId}
                  >
                    Use selected camera
                  </button>
                )}
                <button
                  className="toolbar-button"
                  type="button"
                  onClick={() => stop(true, true, true)}
                >
                  Turn camera off
                </button>
              </>
            ) : (
              <button
                className="go-button"
                type="button"
                onClick={() => void sampleFace(selectedCameraId || undefined)}
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
      <section className="attention-monitor" aria-labelledby="attention-monitor-title">
        <div className="attention-monitor-heading">
          <div>
            <span className="proctoring-eyebrow">Local head-orientation estimate</span>
            <h2 id="attention-monitor-title">Attention Monitoring</h2>
          </div>
          <span
            className={`attention-monitor-status ${lookingAway ? 'is-warning' : ''}`}
            role="status"
          >
            <span />
            {attentionBanner}
          </span>
        </div>
        <div className="attention-monitor-summary">
          <div>
            <span>Current head direction</span>
            <strong>{attentionLabels[attentionDirection]}</strong>
          </div>
          <div>
            <span>Monitoring status</span>
            <strong>
              {!cameraActive
                ? 'Waiting for camera'
                : !examStarted
                  ? attentionCalibrated
                    ? 'Calibrated for attempt'
                    : `Calibrating (${calibrationSamples}/5)`
                  : attentionCalibrated
                    ? 'Active'
                    : `Calibrating (${calibrationSamples}/5)`}
            </strong>
          </div>
          <div>
            <span>Sustained looking-away duration</span>
            <strong>
              {lookingAway ? `${Math.ceil(lookingAwayDurationMs / 1000)} seconds` : '—'}
            </strong>
          </div>
        </div>
        <p className="attention-monitor-explanation">
          This uses sparse face-detector landmarks to estimate head orientation; it does not track
          eye gaze. Calibration asks you to face the screen. A warning requires at least 3 seconds
          and 3 consecutive confident observations. Short glances are ignored. Lighting, occlusion,
          camera movement, and natural movement can make these approximate signals incorrect; they
          are review cues, not proof of misconduct and never affect submission or grading.
        </p>
        <div className="attention-event-heading">
          <strong>Attention events</strong>
          <span>Chronological · local inference</span>
        </div>
        {attentionEvents.length === 0 ? (
          <p className="attention-events-empty">No attention events recorded for this attempt.</p>
        ) : (
          <ol className="attention-event-list" aria-label="Chronological attention events">
            {attentionEvents.map((event, index) => (
              <li key={`${event.type}-${event.occurredAt}-${index}`}>
                <time dateTime={event.occurredAt}>
                  {new Date(event.occurredAt).toLocaleTimeString()}
                </time>
                <span>{attentionEventLabels[event.type]}</span>
                {event.observationDurationMs > 0 && (
                  <small>{(event.observationDurationMs / 1000).toFixed(1)}s sustained</small>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
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

async function acquireCameraStream(requestedCameraId?: string): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error(
      'Electron does not expose camera capture in this window. Restart Pearl Browser and retry.'
    )
  }
  if (requestedCameraId) {
    return navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: requestedCameraId } },
      audio: false
    })
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

async function enumerateCameraInputs(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) {
    throw new Error(
      'Electron could not list available camera inputs. Restart Pearl Browser and retry.'
    )
  }
  return (await navigator.mediaDevices.enumerateDevices())
    .filter((device) => device.kind === 'videoinput' && device.deviceId)
    .slice(0, 8)
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
