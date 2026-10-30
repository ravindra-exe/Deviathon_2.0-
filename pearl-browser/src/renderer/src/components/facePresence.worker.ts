import { FaceDetector, FilesetResolver } from '@mediapipe/tasks-vision'
import { estimateHeadPose } from './attention'

type WorkerRequest =
  | { type: 'initialize'; wasmBaseUrl: string; modelUrl: string }
  | { type: 'frame'; bitmap: ImageBitmap; timestamp: number }
  | { type: 'dispose' }

type WorkerResponse =
  | { type: 'ready' }
  | {
      type: 'detection'
      faceCount: number
      confidence?: number
      headPose?: { yaw: number; pitch: number; rollDegrees: number }
    }
  | { type: 'error'; message: string }

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
  postMessage: (message: WorkerResponse) => void
  close: () => void
}

let detector: FaceDetector | undefined

workerScope.onmessage = (event): void => {
  const request = event.data
  if (request.type === 'initialize') {
    void initialize(request.wasmBaseUrl, request.modelUrl)
    return
  }
  if (request.type === 'dispose') {
    detector?.close()
    detector = undefined
    workerScope.close()
    return
  }
  if (!detector) {
    request.bitmap.close()
    workerScope.postMessage({ type: 'error', message: 'Face detector is not initialized.' })
    return
  }
  try {
    const result = detector.detectForVideo(request.bitmap, request.timestamp)
    const confidence = result.detections.reduce(
      (maximum, detection) => Math.max(maximum, detection.categories[0]?.score ?? 0),
      0
    )
    const detection = result.detections.length === 1 ? result.detections[0] : undefined
    const faceConfidence = detection?.categories[0]?.score
    const headPose =
      detection && typeof faceConfidence === 'number'
        ? estimateHeadPose(detection.keypoints, faceConfidence)
        : undefined
    workerScope.postMessage({
      type: 'detection',
      faceCount: result.detections.length,
      ...(result.detections.length > 0 ? { confidence } : {}),
      ...(headPose ? { headPose } : {})
    })
  } catch (error) {
    workerScope.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : 'Local face detection failed.'
    })
  } finally {
    request.bitmap.close()
  }
}

async function initialize(wasmBaseUrl: string, modelUrl: string): Promise<void> {
  try {
    // Electron can fall back from importScripts(file:) to dynamic import. The UMD
    // loader keeps ModuleFactory module-scoped on that path, so use MediaPipe's
    // local module loader, which explicitly installs it on globalThis.
    const wasmFiles = await FilesetResolver.forVisionTasks(wasmBaseUrl, true)
    detector = await FaceDetector.createFromOptions(wasmFiles, {
      baseOptions: { modelAssetPath: modelUrl, delegate: 'CPU' },
      runningMode: 'VIDEO',
      minDetectionConfidence: 0.5
    })
    workerScope.postMessage({ type: 'ready' })
  } catch (error) {
    workerScope.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : 'Could not load the local face detector.'
    })
  }
}
