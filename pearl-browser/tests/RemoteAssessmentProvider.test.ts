import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteAssessmentProvider } from '../src/main/browser/RemoteAssessmentProvider'

describe('RemoteAssessmentProvider OTP requests', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('allows the backend more time for assessment validation and email delivery', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('Aborted', 'AbortError'))
            })
          })
      )
    )
    const provider = new RemoteAssessmentProvider({
      baseUrl: 'http://127.0.0.1:8787',
      assessmentId: 'pearl-demo-001'
    })
    const request = provider.requestOtp('participant@example.com')
    const result = expect(request).rejects.toThrow(
      'Failed to send OTP email: Remote assessment backend timed out.'
    )

    await vi.advanceTimersByTimeAsync(10_000)
    expect(vi.mocked(fetch)).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(34_999)
    await expect(Promise.race([request, Promise.resolve('pending')])).resolves.toBe('pending')

    await vi.advanceTimersByTimeAsync(1)
    await result
  })

  it('reports the configured backend when metadata cannot connect', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    const provider = new RemoteAssessmentProvider({
      baseUrl: 'http://127.0.0.1:9123',
      assessmentId: 'pearl-demo-001'
    })

    await expect(provider.getConfiguration()).rejects.toThrow(
      'Failed to load published assessment metadata: Could not connect to http://127.0.0.1:9123. Check that the backend is running and that PEARL_ASSESSMENT_BACKEND_URL matches its address.'
    )
  })

  it('preserves useful HTTP errors from the backend', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'Assessment not found.' }), {
          status: 404,
          headers: { 'content-type': 'application/json' }
        })
      )
    )
    const provider = new RemoteAssessmentProvider({
      baseUrl: 'http://127.0.0.1:8787',
      assessmentId: 'missing-assessment'
    })

    await expect(provider.getConfiguration()).rejects.toThrow(
      'Failed to load published assessment metadata: Assessment not found.'
    )
  })
})
