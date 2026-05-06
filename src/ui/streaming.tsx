import React, { useState, useEffect, useRef } from 'react'
import { Text } from 'ink'

interface StreamingTextProps {
  bufferRef: React.MutableRefObject<string>
  isStreaming: boolean
}

export function StreamingText({ bufferRef, isStreaming }: StreamingTextProps) {
  const [displayText, setDisplayText] = useState('')
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    intervalRef.current = setInterval(() => {
      if (bufferRef.current) {
        const chunk = bufferRef.current
        bufferRef.current = ''
        setDisplayText(prev => prev + chunk)
      }
    }, 16)

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [bufferRef])

  // When streaming ends, flush any remaining buffer
  useEffect(() => {
    if (!isStreaming) {
      if (bufferRef.current) {
        const remaining = bufferRef.current
        bufferRef.current = ''
        setDisplayText(prev => prev + remaining)
      }
      // Clear display text when streaming session ends (reset for next turn)
      setDisplayText('')
    }
  }, [isStreaming, bufferRef])

  if (!displayText) return null

  return <Text>{displayText}</Text>
}
