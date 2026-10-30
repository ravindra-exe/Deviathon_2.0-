import { afterEach, describe, expect, it, vi } from 'vitest'
import { AdminConsoleClient } from '../src/main/browser/AdminConsoleClient'

describe('AdminConsoleClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps verified administrator credentials in the main-process client', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'sent' }), { status: 202 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sessionId: 'session-id',
            token: 'secret-token',
            expiresAt: new Date(Date.now() + 60_000).toISOString()
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ metrics: {} }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new AdminConsoleClient('http://127.0.0.1:8787/')

    await client.requestOtp('admin@example.com')
    await expect(client.verifyOtp('admin@example.com', '123456')).resolves.toBeUndefined()
    await client.getData()
    expect(fetchMock.mock.calls[2][1]?.headers).toMatchObject({
      Authorization: 'Bearer session-id.secret-token'
    })
    await client.logout()
    expect(fetchMock.mock.calls[3][1]?.headers).toMatchObject({
      Authorization: 'Bearer session-id.secret-token'
    })
  })

  it('does not request dashboard data before a backend-confirmed admin session', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const client = new AdminConsoleClient('http://127.0.0.1:8787')

    await expect(client.resume()).resolves.toBe(false)
    await expect(client.getData()).rejects.toThrow('Administrator authentication is required.')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('resumes only a server-confirmed administrator session', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sessionId: 'session-id',
            token: 'secret-token',
            expiresAt: new Date(Date.now() + 60_000).toISOString()
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ authenticated: true, expiresAt: new Date(Date.now() + 60_000) }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ metrics: {} }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new AdminConsoleClient('http://127.0.0.1:8787')

    await client.verifyOtp('admin@example.com', '123456')
    await expect(client.resume()).resolves.toBe(true)
    await client.getData()
    expect(fetchMock.mock.calls[1][0]).toContain('/api/admin/auth/session')
    expect(fetchMock.mock.calls[2][0]).toContain('/api/admin/console')
  })

  it('rejects insecure non-local backend URLs before sending credentials', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const client = new AdminConsoleClient('http://backend.example.com')

    await expect(client.requestOtp('admin@example.com')).rejects.toThrow(
      'The administrator backend URL must use HTTPS or a local development host.'
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
