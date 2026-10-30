interface ErrorEventSource {
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown
}

export function guardBrokenOutputPipe(stream: ErrorEventSource): void {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') throw error
  })
}
