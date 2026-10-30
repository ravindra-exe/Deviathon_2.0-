import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { guardBrokenOutputPipe } from '../src/shared/safeProcessOutput'

describe('guardBrokenOutputPipe', () => {
  it('handles EPIPE when a parent process closes an output stream', () => {
    const stream = new EventEmitter()
    guardBrokenOutputPipe(stream)

    expect(() => {
      stream.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }))
    }).not.toThrow()
  })

  it('continues to surface other output stream errors', () => {
    const stream = new EventEmitter()
    guardBrokenOutputPipe(stream)
    const error = Object.assign(new Error('disk error'), { code: 'EIO' })

    expect(() => stream.emit('error', error)).toThrow(error)
  })
})
