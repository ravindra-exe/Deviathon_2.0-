export interface AirtableRecord {
  id: string
  fields: Record<string, unknown>
}

export interface AirtableClient {
  list(table: string, filterByFormula?: string): Promise<AirtableRecord[]>
  create(table: string, fields: Record<string, unknown>): Promise<AirtableRecord>
  update(table: string, recordId: string, fields: Record<string, unknown>): Promise<AirtableRecord>
}

interface AirtableResponse {
  records?: AirtableRecord[]
  offset?: string
  id?: string
  fields?: Record<string, unknown>
  error?: { type?: string; message?: string }
}

export class AirtableRequestError extends Error {
  constructor(
    readonly status: number,
    readonly errorType: string | undefined,
    readonly safeMessage: string
  ) {
    super(`Airtable request failed (${status}): ${safeMessage}`)
    this.name = 'AirtableRequestError'
  }
}

export class AirtableResponseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AirtableResponseError'
  }
}

export class HttpAirtableClient implements AirtableClient {
  constructor(
    private readonly pat: string,
    private readonly baseId: string,
    private readonly timeoutMs = 10_000
  ) {}

  list(table: string, filterByFormula?: string): Promise<AirtableRecord[]> {
    const records: AirtableRecord[] = []
    const readPage = async (offset?: string): Promise<AirtableRecord[]> => {
      const params = new URLSearchParams()
      if (filterByFormula) params.set('filterByFormula', filterByFormula)
      if (offset) params.set('offset', offset)
      const query = params.toString() ? `?${params.toString()}` : ''
      const payload = await this.request(
        `/v0/${encodeURIComponent(this.baseId)}/${encodeURIComponent(table)}${query}`
      )
      records.push(...(payload.records ?? []))
      return payload.offset ? readPage(payload.offset) : records
    }
    return readPage()
  }

  create(table: string, fields: Record<string, unknown>): Promise<AirtableRecord> {
    return this.request(`/v0/${encodeURIComponent(this.baseId)}/${encodeURIComponent(table)}`, {
      method: 'POST',
      body: JSON.stringify({ fields })
    })
  }

  update(
    table: string,
    recordId: string,
    fields: Record<string, unknown>
  ): Promise<AirtableRecord> {
    return this.request(
      `/v0/${encodeURIComponent(this.baseId)}/${encodeURIComponent(table)}/${encodeURIComponent(recordId)}`,
      { method: 'PATCH', body: JSON.stringify({ fields }) }
    )
  }

  private async request(
    path: string,
    init?: RequestInit
  ): Promise<AirtableRecord & AirtableResponse> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await fetch(`https://api.airtable.com${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.pat}`,
          'content-type': 'application/json',
          ...(init?.headers ?? {})
        },
        signal: controller.signal
      })
      const payload = (await response.json().catch(() => ({}))) as AirtableResponse
      if (!response.ok) {
        throw new AirtableRequestError(
          response.status,
          payload.error?.type,
          sanitizeMessage(payload.error?.message ?? 'upstream error')
        )
      }
      if (!Array.isArray(payload.records) && !payload.id) {
        throw new AirtableResponseError('Airtable returned an invalid response shape.')
      }
      return payload as AirtableRecord & AirtableResponse
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Airtable request timed out.', { cause: error })
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }
}

function sanitizeMessage(message: string): string {
  return message.replace(/[\r\n\t]+/g, ' ').slice(0, 240)
}
