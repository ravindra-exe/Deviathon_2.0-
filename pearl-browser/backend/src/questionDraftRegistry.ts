import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

export class AssessmentDraftRegistry {
  private readonly assessmentIds = new Set<string>()

  constructor(private readonly filePath?: string) {
    if (!filePath || !existsSync(filePath)) return
    const contents = readFileSync(filePath, 'utf8')
    for (const [index, line] of contents.split(/\r?\n/).entries()) {
      if (!line.trim()) continue
      let value: unknown
      try {
        value = JSON.parse(line) as unknown
      } catch {
        throw new Error(`Assessment draft registry is malformed at line ${index + 1}.`)
      }
      if (
        typeof value !== 'object' ||
        value === null ||
        !('assessmentId' in value) ||
        typeof value.assessmentId !== 'string' ||
        !value.assessmentId.trim()
      ) {
        throw new Error(`Assessment draft registry is malformed at line ${index + 1}.`)
      }
      this.assessmentIds.add(value.assessmentId)
    }
  }

  has(assessmentId: string): boolean {
    return this.assessmentIds.has(assessmentId)
  }

  async register(assessmentId: string): Promise<void> {
    if (!this.assessmentIds.has(assessmentId) && this.filePath) {
      mkdirSync(dirname(this.filePath), { recursive: true })
      appendFileSync(
        this.filePath,
        `${JSON.stringify({ assessmentId, createdAt: new Date().toISOString() })}\n`,
        { encoding: 'utf8', mode: 0o600 }
      )
    }
    this.assessmentIds.add(assessmentId)
  }
}
