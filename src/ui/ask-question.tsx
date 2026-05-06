import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'

interface AskQuestionProps {
  question: string
  options: string[]
  onAnswer: (answer: string) => void
}

export function AskQuestion({ question, options, onAnswer }: AskQuestionProps) {
  const [freeText, setFreeText] = useState('')

  useInput((char, key) => {
    if (options.length > 0) {
      // Number key selection
      const num = parseInt(char, 10)
      if (!isNaN(num) && num >= 1 && num <= options.length) {
        onAnswer(options[num - 1])
        return
      }
    } else {
      // Free-text input mode
      if (key.return) {
        if (freeText.trim()) {
          onAnswer(freeText)
          setFreeText('')
        }
        return
      }

      if (key.backspace || key.delete) {
        setFreeText(prev => prev.slice(0, -1))
        return
      }

      if (char && !key.ctrl && !key.meta) {
        setFreeText(prev => prev + char)
      }
    }
  })

  return (
    <Box flexDirection="column">
      <Text bold>{question}</Text>
      {options.length > 0 ? (
        <Box flexDirection="column">
          {options.map((opt, i) => (
            <Text key={i} color="cyan">{i + 1}. {opt}</Text>
          ))}
          <Text dimColor>Press a number to select...</Text>
        </Box>
      ) : (
        <Text>{'> '}{freeText}{'_'}</Text>
      )}
    </Box>
  )
}
